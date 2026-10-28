// scripts/reminders.js — фоновый «будильник» напоминаний.
// Запускается точечно (вручную из Shell или по таймеру Routines/cron),
// поэтому здесь допустим СВОЙ пул соединений, который мы закрываем в конце.
// (В HTTP-сервере так делать нельзя — там пул один на всё время, см. Шаг 1.)
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// === НАСТРОЙКИ ОКОН ===
// В ПРОДЕ здесь должны быть узкие окна: 24h -> {min:23,max:25}, 2h -> {min:1,max:3}.
// Для СЕГОДНЕШНЕЙ демо-проверки окно 24h расширено (18..30 часов),
// чтобы записи на завтра (~20 часов от вечера) попали в выборку и мы увидели
// живые напоминания прямо сейчас, не дожидаясь полуночи.
const REMINDER_WINDOWS = [
  { type: "24h", minHours: 18, maxHours: 30 }, // проде: 23..25
  { type: "2h",  minHours: 1,  maxHours: 3  }, // проде: 1..3
];
const MAX_ATTEMPTS = 3; // после 3 неудачных попыток перестаём звонить этому напоминанию

async function main() {
  // 1. Создаём журнал доставок, если его ещё нет (идемпотентно).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reminder_log (
      id SERIAL PRIMARY KEY,
      booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      reminder_type TEXT NOT NULL,            -- '24h' или '2h'
      status TEXT NOT NULL DEFAULT 'failed',  -- 'sent' | 'failed'
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // Уникальность пары (запись, тип) = защита от дублей, как uniq_active_slot.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_reminder
    ON reminder_log (booking_id, reminder_type);
  `);

  // 2. Берём активные ЗАВТРАШНИЕ/БУДУЩИЕ записи вместе с Telegram-ID и именем клиента
  //    и названием/ценой услуги. starts_at > NOW() отсекает прошедшие визиты
  //    (чтобы не напоминать о том, что уже было).
  const { rows: bookings } = await pool.query(`
    SELECT b.id AS booking_id, u.telegram_user_id, u.first_name,
           s.name AS service_name, s.price AS service_price,
           b.starts_at,
           EXTRACT(EPOCH FROM (b.starts_at - NOW())) / 3600.0 AS hours_until
    FROM bookings b
    JOIN users u    ON u.id = b.user_id
    JOIN services s ON s.id = b.service_id
    WHERE b.status IN ('pending','confirmed')
      AND b.starts_at > NOW()
    ORDER BY b.starts_at;
  `);

  const botToken = process.env.BOT_TOKEN;
  if (!botToken) {
    console.error("BOT_TOKEN нет в окружении — напоминания не отправить.");
    return;
  }

  let sent = 0, skippedDup = 0, retried = 0, gaveUp = 0, failedNow = 0;

  // 3. По каждой будущей записи проходим по окнам (24h, 2h).
  for (const bk of bookings) {
    for (const win of REMINDER_WINDOWS) {
      if (!(bk.hours_until >= win.minHours && bk.hours_until <= win.maxHours)) {
        continue; // это напоминание ещё не пора (или уже пора было вчера)
      }

      // Смотрим тетрадку: отправляли ли уже этот тип этому визиту?
      const { rows: existing } = await pool.query(
        `SELECT id, status, attempts FROM reminder_log
         WHERE booking_id = $1 AND reminder_type = $2`,
        [bk.booking_id, win.type]
      );
      const row = existing[0];

      if (row && row.status === "sent") { skippedDup++; continue; }      // уже напомнили — не дублируем
      if (row && row.attempts >= MAX_ATTEMPTS) { gaveUp++; continue; }   // 3 раза не дозвонились — сдались

      // Пора отправить (впервые или повторная попытка).
      const ok = await sendReminder(botToken, bk, win.type);

      if (!row) {
        // первой строки в журнале нет — заводим её с attempts = 1
        await pool.query(
          `INSERT INTO reminder_log (booking_id, reminder_type, status, attempts, last_error, sent_at)
           VALUES ($1,$2,$3,1,$4, $5)`,
          [bk.booking_id, win.type, ok ? "sent" : "failed",
           ok ? null : "telegram send failed", ok ? new Date() : null]
        );
        ok ? sent++ : failedNow++;
      } else {
        // строка есть и status='failed', attempts<MAX — это retry, увеличиваем счётчик
        await pool.query(
          `UPDATE reminder_log
           SET status=$3, attempts=attempts+1, last_error=$4,
               sent_at=CASE WHEN $3='sent' THEN NOW() ELSE sent_at END,
               updated_at=NOW()
           WHERE id=$1`,
          [row.id, bk.booking_id, ok ? "sent" : "failed",
           ok ? null : "telegram send failed"]
        );
        ok ? retried++ : failedNow++;
      }
    }
  }

  console.log(
    `Готово. отправлено впервые=${sent}, повторно дозвонились=${retried}, ` +
    `дублей пропущено=${skippedDup}, сдались после ${MAX_ATTEMPTS}=${gaveUp}, ` +
    `неудач в этот раз=${failedNow}, всего будущих записей=${bookings.length}`
  );
}

// Отправка одного напоминания в Telegram. Возвращает true только если Telegram
// подтвердил доставку (ok:true). Любая ошибка = false -> запишется 'failed' и retry.
async function sendReminder(botToken, bk, type) {
  const when = new Intl.DateTimeFormat("ru-RU", {
    timeZone: MASTER_TIME_ZONE, day: "numeric", month: "long",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(bk.starts_at));
  const lead = type === "24h" ? "завтра" : "сегодня";
  const price = new Intl.NumberFormat("ru-RU", { useGrouping: false }).format(Number(bk.service_price));
  const text =
    `⏰ Напоминание\n` +
    `${lead}, ${when} — у вас «${bk.service_name}» (${price} ₽).\n` +
    `Отменить или перенести — в приложении, кнопка «Мои записи».`;
  try {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: Number(bk.telegram_user_id), text }),
      signal: AbortSignal.timeout(5000),
    });
    const j = await r.json();
    return r.ok && j.ok === true; // двойная проверка: HTTP-успех И Telegram-успех
  } catch {
    return false; // таймаут/сеть лёг -> failed -> на следующем прогоне retry
  }
}

main()
  .then(async () => { await pool.end(); })
  .catch(async (e) => { console.error("reminder run failed:", e.message); await pool.end(); });