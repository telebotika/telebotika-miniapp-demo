// routes/admin.js — кабинет мастера (админка). Только для ADMIN_CHAT_ID.
// Свой пул на уровне модуля (один на файл, НЕ на запрос — см. пояснение в чате).
import { Router } from "express";
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
// Часовая зона мастера для форматирования дат в экспорте.
// Долг M7: унести в env/seed вместе с MASTER_TIME_ZONE из system.js в общий конфиг.
const MASTER_TIME_ZONE = "Europe/Moscow";

// === СЛУЖЕБНЫЙ ПРОПУСК (авторизация) ===
// Middleware = "пропускник на входе": проверяет каждого входящего ДО того,
// как пустит к данным. Делает два шага:
//  1) аутентификация: подпись initData валидна? (иначе 403 Invalid signature)
//  2) авторизация: этот человек = мастер? (иначе 403 Not an admin)
// Fail-closed: если ADMIN_CHAT_ID не задан в Secrets, Number(undefined)=NaN,
// и NaN никогда не равен userId -> НЕ пускает НИКОГО. Это безопасно:
// лучше закрыть дверь наглухо, чем открыть её "на всякий случай".
function requireAdmin(request, response, next) {
  const initDataRaw = request.query?.initDataRaw ?? request.body?.initDataRaw;
  const validation = validateInitData(initDataRaw);
  // Демо-режим: журнал мастера открывается по ?master=1 (только при DEMO_MODE=1).
  // Нужен для показа кабинета и выгрузки на тестовых данных.
  const demoMaster =
    process.env.DEMO_MODE === "1" &&
    (request.query?.demoMaster === "1" || request.body?.demoMaster === "1");
  if (!validation.valid && !demoMaster) {
    return response.status(403).json({ error: "Invalid signature" });
  }
  const adminId = Number(process.env.ADMIN_CHAT_ID);
  if (!demoMaster && adminId !== validation.userId) {
    return response.status(403).json({ error: "Not an admin" });
  }
  request.adminUser = validation.valid
    ? validation
    : { userId: 1000000001, firstName: "Гость (демо)", demo: true };
  next(); // пропускаем дальше, к маршруту
}

// === ЛЕНТА МАСТЕРА: все ПРЕДСТОЯЩИЕ АКТИВНЫЕ записи салона ===
// В отличие от клиентской истории (там и отменённые, и прошедшие),
// мастеру нужна очередь вперёд: только pending/confirmed и только будущие.
// GET /api/admin/bookings  (параметр initDataRaw в query)
router.get("/bookings", requireAdmin, async (_request, response) => {
  try {
    const { rows } = await pool.query(
      `SELECT b.id, b.starts_at, b.ends_at, b.status, b.comment,
              u.telegram_user_id, u.first_name,
              s.name AS service_name, s.price AS service_price
       FROM bookings b
       JOIN users u    ON u.id = b.user_id
       JOIN services s ON s.id = b.service_id
       WHERE b.status IN ('pending', 'confirmed')
         AND b.starts_at > NOW()
       ORDER BY b.starts_at ASC
       LIMIT 50`
    );
    return response.json(rows);
  } catch {
    // обезличенно: не отдаём наружу SQL и строку подключения
    return response.status(500).json({ error: "Unable to load schedule" });
  }
});
// Компактная проверка "id — положительное целое". Нужна, чтобы вернуть
// аккуратный 400 вместо непонятной ошибки базы на мусор в URL.
function parseId(value) {
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

// POST /api/admin/bookings/:id/confirm — мастер ставит галочку.
// :id в URL = номер строчки в книге; подпись мастера = в теле (requireAdmin её проверит).
router.post("/bookings/:id/confirm", requireAdmin, async (request, response) => {
  const id = parseId(request.params.id);
  if (id === null) {
    return response.status(400).json({ error: "Invalid booking id" });
  }
  try {
    // UPDATE = "перекрасить строчку". RETURNING * = "и покажи мне, что получилось".
    // Долг прода (комментирую честно, не скрываю): у нас 1 мастер = 1 салон,
    // поэтому любая id-запись наша. В проде с несколькими салонами сюда
    // добавится "AND salon_id = $2", чтобы мастер А не отменил запись салона Б.
    const { rows } = await pool.query(
      `UPDATE bookings SET status = 'confirmed' WHERE id = $1 RETURNING *`,
      [id]
    );
    if (rows.length === 0) {
      return response.status(404).json({ error: "Booking not found" }); // такой строчки в книге нет
    }
    return response.json(rows[0]);
  } catch {
    return response.status(500).json({ error: "Unable to update booking" }); // обезличенно
  }
});

// POST /api/admin/bookings/:id/cancel — мастер вычёркивает запись.
router.post("/bookings/:id/cancel", requireAdmin, async (request, response) => {
  const id = parseId(request.params.id);
  if (id === null) {
    return response.status(400).json({ error: "Invalid booking id" });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE bookings SET status = 'cancelled' WHERE id = $1 RETURNING *`,
      [id]
    );
    if (rows.length === 0) {
      return response.status(404).json({ error: "Booking not found" });
    }
    return response.json(rows[0]);
  } catch {
    return response.status(500).json({ error: "Unable to update booking" });
  }
});
// === ЭКСПОРТ БАЗЫ КЛИЕНТОВ В CSV (прода-безопасный) ===

// 1. Защитный префикс против formula injection: если значение-строка начинается
//    с =, +, -, @ или управляющего символа — Excel иначе исполнит её как формулу.
//    Ставим апостроф спереди: Excel покажет текст, но не вычислит.
function formulaGuard(value) {
  if (typeof value !== "string") return value;
  if (/^[=+\-@\t\r]/.test(value)) return "'" + value;
  return value;
}

// 2. Экранирование поля для CSV: оборачиваем в кавычки, если внутри запятая,
//    кавычка или перенос строки; внутренние кавычки удваиваем (" -> "").
//    Плюс пропускаем поле через formulaGuard.
function csvField(value) {
  const s = value === null || value === undefined ? "" : String(formulaGuard(value));
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// 3. Разметка строки CSV (CRLF — стандарт для Excel/Windows).
function csvRow(cells) {
  return cells.map(csvField).join(",") + "\r\n";
}

// GET /api/admin/export.csv — полная история обращений салона, защищённая requireAdmin.
// Без LIMIT: это бэкап/аналитика, мастеру нужны ВСЕ записи, не первые 50.
router.get("/export.csv", requireAdmin, async (_request, response) => {
  try {
    const { rows } = await pool.query(
      `SELECT b.id, b.starts_at, b.status, b.comment,
              u.first_name, u.telegram_user_id,
              s.name AS service_name, s.price AS service_price
       FROM bookings b
       JOIN users u    ON u.id = b.user_id
       JOIN services s ON s.id = b.service_id
       ORDER BY b.starts_at DESC`
    );

    const header = csvRow([
      "id", "дата_время_МСК", "клиент", "telegram_id",
      "услуга", "цена", "статус", "комментарий",
    ]);

    const fmt = new Intl.DateTimeFormat("ru-RU", {
      timeZone: MASTER_TIME_ZONE,
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });

    const lines = rows.map((r) =>
      csvRow([
        r.id,
        fmt.format(new Date(r.starts_at)),
        r.first_name,
        r.telegram_user_id,
        r.service_name,
        r.service_price,
        r.status,
        r.comment,
      ])
    );

    // BOM (\uFEFF) в начале — чтобы Excel открыл UTF-8, а не ANSI (иначе кириллица = мусор).
    const csv = "\uFEFF" + header + lines.join("");

    response.setHeader("Content-Type", "text/csv; charset=utf-8");
    response.setHeader(
      "Content-Disposition",
      'attachment; filename="clients.csv"'
    );
    return response.send(csv);
  } catch {
    return response.status(500).json({ error: "Unable to export" }); // обезличенно
  }
});
// --- CRM-отчёты (Модуль 6, 16.10) ---
// Зона передаётся в SQL ПАРАМЕТРОМ ($1), никогда литералом внутри строки:
// урок Модуля 5 — литерал 'MASTER_TIME_ZONE' спал до первой брони и будился 500-ми.
const REPORT_TZ = "Europe/Moscow"; // долг M7: унести в env/seed вместе с MASTER_TIME_ZONE

router.get("/reports", requireAdmin, async (request, response) => {
  try {
    // 1) Сводка по всей истории (те же строки, что читает CSV-экспорт).
    const summaryResult = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE b.status IN ('confirmed', 'completed'))::int AS done_count,
         COALESCE(SUM(s.price) FILTER (WHERE b.status IN ('confirmed', 'completed')), 0)::float8 AS revenue,
         COUNT(*) FILTER (WHERE b.status = 'pending')::int AS pending_count,
         COUNT(*) FILTER (WHERE b.status = 'cancelled')::int AS cancelled_count,
         COUNT(*) FILTER (WHERE b.status = 'no_show')::int AS no_show_count
       FROM bookings b
       JOIN services s ON s.id = b.service_id`,
    );

    // 2) Выручка по дням (дата в локальном времени мастера — зона параметром).
    const byDayResult = await pool.query(
      `SELECT (b.starts_at AT TIME ZONE $1)::date AS day,
              COUNT(*)::int AS bookings,
              COALESCE(SUM(s.price), 0)::float8 AS revenue
       FROM bookings b
       JOIN services s ON s.id = b.service_id
       WHERE b.status IN ('confirmed', 'completed')
       GROUP BY day
       ORDER BY day`,
      [REPORT_TZ],
    );

    // 3) Топ услуг (что приносит деньги — основа прайс-решений).
    const topResult = await pool.query(
      `SELECT s.name,
              COUNT(*)::int AS times,
              COALESCE(SUM(s.price), 0)::float8 AS revenue
       FROM bookings b
       JOIN services s ON s.id = b.service_id
       WHERE b.status IN ('confirmed', 'completed')
       GROUP BY s.name
       ORDER BY times DESC, revenue DESC`,
    );

    // 4) Возвращающиеся клиенты (retention: визитов >= 2).
    const repeatResult = await pool.query(
      `SELECT u.first_name, u.telegram_user_id, COUNT(*)::int AS visits
       FROM bookings b
       JOIN users u ON u.id = b.user_id
       WHERE b.status IN ('confirmed', 'completed')
       GROUP BY u.id, u.first_name, u.telegram_user_id
       HAVING COUNT(*) >= 2
       ORDER BY visits DESC`,
    );

    return response.json({
      summary: summaryResult.rows[0],
      byDay: byDayResult.rows,
      topServices: topResult.rows,
      repeatClients: repeatResult.rows,
    });
  } catch (error) {
    console.error("reports failed:", error);
    return response.status(500).json({ error: "Unable to build reports" });
  }
});
export default router;