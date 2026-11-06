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


// === АНАЛИТИКА ДЛЯ СОБСТВЕННИКА ===
// Периоды: 7 и 30 дней (по сегодня включительно), текущий месяц, всё время.
// Все даты считаются в часовом поясе мастера, а не в UTC.
function masterToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: MASTER_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function shiftDate(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function timeToMinutes(value) {
  if (!value) return null;
  const [h, m] = String(value).split(":").map(Number);
  return h * 60 + m;
}

async function buildAnalytics(period) {
  const today = masterToday();
  const tomorrow = shiftDate(today, 1);
  let fromDate;
  if (period === "7") fromDate = shiftDate(today, -6);
  else if (period === "month") fromDate = `${today.slice(0, 8)}01`;
  else if (period === "30") fromDate = shiftDate(today, -29);
  else {
    const first = await pool.query(
      `SELECT to_char(MIN((starts_at AT TIME ZONE $1)::date), 'YYYY-MM-DD') AS d FROM bookings`,
      [MASTER_TIME_ZONE],
    );
    fromDate = first.rows[0]?.d || today;
  }
  // Москва — фиксированный UTC+3, переходов на летнее время нет.
  const from = `${fromDate}T00:00:00+03:00`;
  const to = `${tomorrow}T00:00:00+03:00`;

  const summaryResult = await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE b.status = 'completed')::int AS completed,
       COUNT(*) FILTER (WHERE b.status = 'confirmed')::int AS confirmed,
       COUNT(*) FILTER (WHERE b.status = 'pending')::int AS pending,
       COUNT(*) FILTER (WHERE b.status = 'cancelled')::int AS cancelled,
       COUNT(*) FILTER (WHERE b.status = 'no_show')::int AS no_show,
       COALESCE(SUM(s.price) FILTER (WHERE b.status = 'completed'), 0)::float8 AS revenue_done,
       COALESCE(SUM(s.price) FILTER (WHERE b.status = 'confirmed'), 0)::float8 AS revenue_confirmed,
       COALESCE(SUM(s.price) FILTER (WHERE b.status = 'pending'), 0)::float8 AS revenue_pending,
       COALESCE(SUM(s.duration_minutes) FILTER (WHERE b.status IN ('completed','confirmed')), 0)::int AS busy_minutes,
       COUNT(DISTINCT b.user_id)::int AS clients
     FROM bookings b
     JOIN services s ON s.id = b.service_id
     WHERE b.starts_at >= $1 AND b.starts_at < $2`,
    [from, to],
  );

  const byDayResult = await pool.query(
    `SELECT (b.starts_at AT TIME ZONE $3)::date AS day,
            COUNT(*)::int AS bookings,
            COUNT(*) FILTER (WHERE b.status = 'completed')::int AS done,
            COALESCE(SUM(s.price) FILTER (WHERE b.status = 'completed'), 0)::float8 AS revenue
     FROM bookings b
     JOIN services s ON s.id = b.service_id
     WHERE b.starts_at >= $1 AND b.starts_at < $2
     GROUP BY day ORDER BY day`,
    [from, to, MASTER_TIME_ZONE],
  );

  const topServicesResult = await pool.query(
    `SELECT s.name,
            COUNT(*) FILTER (WHERE b.status IN ('completed','confirmed'))::int AS times,
            COALESCE(SUM(s.price) FILTER (WHERE b.status = 'completed'), 0)::float8 AS revenue
     FROM bookings b
     JOIN services s ON s.id = b.service_id
     WHERE b.starts_at >= $1 AND b.starts_at < $2
     GROUP BY s.name
     HAVING COUNT(*) FILTER (WHERE b.status IN ('completed','confirmed')) > 0
     ORDER BY times DESC, revenue DESC`,
    [from, to],
  );

  const byHourResult = await pool.query(
    `SELECT EXTRACT(HOUR FROM (b.starts_at AT TIME ZONE $3))::int AS hour,
            COUNT(*)::int AS bookings
     FROM bookings b
     WHERE b.starts_at >= $1 AND b.starts_at < $2
       AND b.status IN ('completed','confirmed')
     GROUP BY hour ORDER BY hour`,
    [from, to, MASTER_TIME_ZONE],
  );

  const repeatResult = await pool.query(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT b.user_id FROM bookings b
       WHERE b.starts_at >= $1 AND b.starts_at < $2
         AND b.status IN ('completed','confirmed')
       GROUP BY b.user_id HAVING COUNT(*) >= 2) t`,
    [from, to],
  );

  // Загрузка: занятые часы к доступным по графику за тот же период.
  const hoursResult = await pool.query(
    `SELECT weekday, start_time, end_time, break_start, break_end, is_working_day FROM working_hours`,
  );
  const schedule = new Map(hoursResult.rows.map((row) => [Number(row.weekday), row]));
  let availableMinutes = 0;
  let workingDays = 0;
  for (let day = fromDate; day < tomorrow; day = shiftDate(day, 1)) {
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
    const row = schedule.get(weekday);
    if (!row || !row.is_working_day) continue;
    let minutes = timeToMinutes(row.end_time) - timeToMinutes(row.start_time);
    if (row.break_start && row.break_end) minutes -= timeToMinutes(row.break_end) - timeToMinutes(row.break_start);
    if (minutes > 0) { availableMinutes += minutes; workingDays += 1; }
  }

  const s = summaryResult.rows[0];
  const doneVisits = s.completed + s.confirmed;
  return {
    period: { code: period, from: fromDate, to: shiftDate(tomorrow, -1), workingDays },
    summary: {
      total: s.total,
      completed: s.completed,
      confirmed: s.confirmed,
      pending: s.pending,
      cancelled: s.cancelled,
      no_show: s.no_show,
      clients: s.clients,
      revenue_done: Number(s.revenue_done),
      revenue_confirmed: Number(s.revenue_confirmed),
      revenue_pending: Number(s.revenue_pending),
      avg_check: s.completed > 0 ? Math.round(Number(s.revenue_done) / s.completed) : 0,
      losses: s.cancelled + s.no_show,
      loss_share: s.total > 0 ? Math.round(((s.cancelled + s.no_show) / s.total) * 1000) / 10 : 0,
      repeat_clients: repeatResult.rows[0]?.n ?? 0,
      load_pct: availableMinutes > 0 ? Math.round((s.busy_minutes / availableMinutes) * 1000) / 10 : null,
      available_hours: Math.round((availableMinutes / 60) * 10) / 10,
      busy_hours: Math.round((s.busy_minutes / 60) * 10) / 10,
      done_visits: doneVisits,
    },
    byDay: byDayResult.rows,
    topServices: topServicesResult.rows,
    byHour: byHourResult.rows,
  };
}

// GET /api/admin/reports?period=7|30|month|all — сводка для собственника.
router.get("/reports", requireAdmin, async (request, response) => {
  const allowed = new Set(["7", "30", "month", "all"]);
  const requested = String(request.query?.period ?? "30");
  const period = allowed.has(requested) ? requested : "30";
  try {
    return response.json(await buildAnalytics(period));
  } catch (error) {
    console.error("reports failed:", error);
    return response.status(500).json({ error: "Unable to build reports" });
  }
});
export default router;
