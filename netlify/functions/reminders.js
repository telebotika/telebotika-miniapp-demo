// netlify/functions/reminders.js - scheduled reminder sender.
// Runs hourly via Netlify Scheduled Functions (cron is UTC, no timezone math needed).
import { schedule } from "@netlify/functions";
import pg from "pg";

const MASTER_TIME_ZONE = "Europe/Moscow";
// Narrow production windows: the scheduler fires every hour.
const REMINDER_WINDOWS = [
  { type: "24h", minHours: 23, maxHours: 25 },
  { type: "2h", minHours: 1, maxHours: 3 },
];
const MAX_ATTEMPTS = 3;

async function sendReminder(botToken, bk, type) {
  const when = new Intl.DateTimeFormat("ru-RU", {
    timeZone: MASTER_TIME_ZONE, day: "numeric", month: "long",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(bk.starts_at));
  const lead = type === "24h" ? "??????" : "???????";
  const price = new Intl.NumberFormat("ru-RU", { useGrouping: false }).format(Number(bk.service_price));
  const text =
    "???????????\n" +
    `${lead}, ${when} - ? ??? "${bk.service_name}" (${price} ???.).\n` +
    "???????? ??? ????????? - ? ??????????, ?????? \"??? ??????\".";
  try {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: Number(bk.telegram_user_id), text }),
      signal: AbortSignal.timeout(5000),
    });
    const j = await r.json();
    return r.ok && j.ok === true;
  } catch {
    return false;
  }
}

const runReminders = async () => {
  if (!process.env.DATABASE_URL || !process.env.BOT_TOKEN) {
    console.error("reminders: DATABASE_URL or BOT_TOKEN is missing");
    return { statusCode: 200, body: "skipped: missing env" };
  }

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS reminder_log (
        id SERIAL PRIMARY KEY,
        booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
        reminder_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'failed',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        sent_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_reminder
      ON reminder_log (booking_id, reminder_type);
    `);

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
    let sent = 0, skippedDup = 0, retried = 0, gaveUp = 0, failedNow = 0;

    for (const bk of bookings) {
      for (const win of REMINDER_WINDOWS) {
        if (!(bk.hours_until >= win.minHours && bk.hours_until <= win.maxHours)) continue;

        const { rows: existing } = await pool.query(
          `SELECT id, status, attempts FROM reminder_log
           WHERE booking_id = $1 AND reminder_type = $2`,
          [bk.booking_id, win.type]
        );
        const row = existing[0];
        if (row && row.status === "sent") { skippedDup++; continue; }
        if (row && row.attempts >= MAX_ATTEMPTS) { gaveUp++; continue; }

        const ok = await sendReminder(botToken, bk, win.type);

        if (!row) {
          await pool.query(
            `INSERT INTO reminder_log (booking_id, reminder_type, status, attempts, last_error, sent_at)
             VALUES ($1,$2,$3,1,$4,$5)`,
            [bk.booking_id, win.type, ok ? "sent" : "failed",
             ok ? null : "telegram send failed", ok ? new Date() : null]
          );
          ok ? sent++ : failedNow++;
        } else {
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

    const summary =
      `sent=${sent} retried=${retried} skippedDup=${skippedDup} ` +
      `gaveUp=${gaveUp} failed=${failedNow} futureBookings=${bookings.length}`;
    console.log("reminders:", summary);
    return { statusCode: 200, body: summary };
  } catch (error) {
    console.error("reminders run failed:", error.message);
    return { statusCode: 500, body: "reminders run failed" };
  } finally {
    await pool.end().catch(() => {});
  }
};

export const handler = schedule("0 * * * *", runReminders);
