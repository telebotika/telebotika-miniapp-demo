// routes/payments.js — каркас оплаты (Модуль 6, 17.10).
// Провайдер сегодня mock; форма обмена продакшен-образная:
// init -> confirmation_url -> вебхук провайдера с подписью -> is_paid на брони.
import { Router } from "express";
import crypto from "node:crypto";
import pg from "pg";
import { validateInitData } from "../utils/telegram-auth.js";

const router = Router();
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 15000,
  allowExitOnIdle: true,
});
// Supabase закрывает простаивающие соединения: без обработчика такой обрыв роняет процесс.
pool.on("error", () => {});

// Подпись провайдера: HMAC(secret, payment_id) — та же техника, что в initData,
// но секрет наш (PAYMENT_WEBHOOK_SECRET). Fail-closed: нет секрета -> null -> 500.
function providerToken(paymentId) {
  const secret = process.env.PAYMENT_WEBHOOK_SECRET;
  if (!secret) return null;
  return crypto.createHmac("sha256", secret).update(String(paymentId)).digest("hex");
}

// POST /api/payments/init — клиент просит счёт на СВОЮ бронь.
// booking_id принимается из query ИЛИ body; подпись initDataRaw — откуда пришёл клиент.
router.post("/init", async (request, response) => {
  const validation = validateInitData(
    request.body?.initDataRaw ?? request.query?.initDataRaw,
  );
  if (!validation.valid) return response.status(403).json({ error: "Invalid signature" });
  const bookingId = Number(request.body?.booking_id ?? request.query?.booking_id);
  if (!Number.isSafeInteger(bookingId) || bookingId <= 0) {
    return response.status(400).json({ error: "Invalid booking_id" });
  }
  try {
    // Владение: оплатить можно только СВОЮ бронь — id владельца берём из подписи,
    // а не из тела (то же правило, что в POST /api/bookings Модуля 3).
    const owner = await pool.query(
      `SELECT b.id, b.status, b.is_paid, s.price
       FROM bookings b
       JOIN services s ON s.id = b.service_id
       JOIN users u ON u.id = b.user_id
       WHERE b.id = $1 AND u.telegram_user_id = $2`,
      [bookingId, validation.userId],
    );
    const booking = owner.rows[0];
    if (!booking) return response.status(404).json({ error: "Booking not found" });
    if (booking.is_paid) return response.status(409).json({ error: "Already paid" });
    if (booking.status === "cancelled") return response.status(409).json({ error: "Booking cancelled" });

    const created = await pool.query(
      `INSERT INTO payments (booking_id, amount) VALUES ($1, $2) RETURNING id`,
      [bookingId, booking.price],
    );
    const paymentId = created.rows[0].id;
    const token = providerToken(paymentId);
    if (!token) return response.status(500).json({ error: "Payment secret is not configured" });
    const origin = `https://${process.env.REPLIT_DEV_DOMAIN}`;
    return response.json({
      payment_id: paymentId,
      confirmation_url: `${origin}/api/payments/mock-pay/${paymentId}?token=${token}`,
    });
  } catch (error) {
    console.error("payment init failed:", error);
    return response.status(500).json({ error: "Unable to init payment" });
  }
});

// GET /api/payments/mock-pay/:id — страничка mock-кассы: одна кнопка «Оплатить».
// token в URL — тот же HMAC, который callback проверит после «оплаты».
router.get("/mock-pay/:id", (request, response) => {
  const id = request.params.id;
  const token = request.query.token ?? "";
  response.type("html").send(`<!doctype html><html lang="ru"><head><meta charset="utf-8">
<title>Mock-касса</title></head>
<body style="font-family:sans-serif;padding:24px">
  <h2>Mock-касса: счёт #${id}</h2>
  <button id="pay" style="padding:12px 20px;font-size:16px">Оплатить (mock)</button>
  <p id="result"></p>
  <script>
    document.getElementById("pay").onclick = async () => {
      const r = await fetch("/api/payments/callback", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Pay-Signature": ${JSON.stringify(token)} },
        body: JSON.stringify({ payment_id: Number(${JSON.stringify(id)}) }),
      });
      document.getElementById("result").textContent = r.ok
        ? "✅ Оплата прошла (mock): бронь помечена оплаченной."
        : "❌ Отклонено: " + r.status;
    };
  </script>
</body></html>`);
});

// POST /api/payments/callback — вебхук провайдера (сегодня mock, завтра ЮKassa).
// Подпись: заголовок X-Pay-Signature = HMAC(PAYMENT_WEBHOOK_SECRET, payment_id).
// Fail-closed: нет секрета -> 500; подпись не сошлась -> 403.
router.post("/callback", async (request, response) => {
  const paymentId = Number(request.body?.payment_id);
  const signature = request.get("X-Pay-Signature");
  const expected = Number.isSafeInteger(paymentId) ? providerToken(paymentId) : null;
  if (!expected) return response.status(500).json({ error: "Payment secret is not configured" });
  if (!signature || signature !== expected) {
    return response.status(403).json({ error: "Invalid provider signature" });
  }
  try {
    // Идемпотентность: платёж проводится один раз (status='created' в условии).
    const paid = await pool.query(
      `UPDATE payments SET status = 'succeeded', succeeded_at = NOW()
       WHERE id = $1 AND status = 'created' RETURNING booking_id`,
      [paymentId],
    );
    if (paid.rows.length === 0) {
      return response.status(404).json({ error: "Payment not found or already processed" });
    }
    await pool.query(`UPDATE bookings SET is_paid = TRUE WHERE id = $1`, [paid.rows[0].booking_id]);
    return response.json({ ok: true, booking_id: paid.rows[0].booking_id });
  } catch (error) {
    console.error("payment callback failed:", error);
    return response.status(500).json({ error: "Unable to process callback" });
  }
});

export default router;