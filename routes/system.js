import { Router } from "express";
import pg from "pg";
import { validateInitData } from "../utils/telegram-auth.js";
import { askAssistant } from "../utils/ai-provider.js";

const router = Router();
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 15000,
  allowExitOnIdle: true,
});
// Supabase закрывает простаивающие соединения: без обработчика такой обрыв роняет процесс.
pool.on("error", () => {});
const MASTER_TIME_ZONE = "Europe/Moscow";
const SLOT_STEP_SECONDS = 30 * 60;
const BOOKING_RATE_WINDOW_MS = 60_000;
const BOOKING_RATE_LIMIT = 5;
const bookingRequestTimestamps = new Map();
const moscowDateTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: MASTER_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function isBookingRateLimited(key, now = Date.now()) {
  const cutoff = now - BOOKING_RATE_WINDOW_MS;

  for (const [storedKey, timestamps] of bookingRequestTimestamps) {
    const activeTimestamps = timestamps.filter((timestamp) => timestamp > cutoff);
    if (activeTimestamps.length === 0) {
      bookingRequestTimestamps.delete(storedKey);
    } else if (activeTimestamps.length !== timestamps.length) {
      bookingRequestTimestamps.set(storedKey, activeTimestamps);
    }
  }

  const timestamps = bookingRequestTimestamps.get(key) ?? [];
  if (timestamps.length >= BOOKING_RATE_LIMIT) {
    return true;
  }

  timestamps.push(now);
  bookingRequestTimestamps.set(key, timestamps);
  return false;
}

class SlotAlreadyTakenError extends Error {}

async function queryDatabase(query, values = []) {
  return pool.query(query, values);
}

async function withDatabaseTransaction(operation) {
  let client;
  let transactionStarted = false;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    transactionStarted = true;
    const result = await operation(client);
    await client.query("COMMIT");
    transactionStarted = false;
    return result;
  } catch (error) {
    if (client && transactionStarted) {
      await client.query("ROLLBACK").catch(() => {});
    }
    throw error;
  } finally {
    client?.release();
  }
}

function parsePositiveInteger(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }

  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }

  return null;
}

function parseLocalDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const [year, month, day] = value.split("-").map(Number);
  if (year < 1000) {
    return null;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return { value, year, month, day, weekday: date.getUTCDay() };
}

function parseIsoInstant(value) {
  if (typeof value !== "string") {
    return null;
  }

  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|([+-])(\d{2}):(\d{2}))$/i.exec(
      value,
    );
  if (!match || !parseLocalDate(match[1])) {
    return null;
  }

  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4] ?? 0);
  const offsetHour = Number(match[7] ?? 0);
  const offsetMinute = Number(match[8] ?? 0);
  if (
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return null;
  }

  const instant = new Date(value);
  return Number.isFinite(instant.getTime()) ? instant : null;
}

function getMoscowDateTimeParts(instant) {
  const parts = Object.fromEntries(
    moscowDateTimeFormatter
      .formatToParts(instant)
      .map(({ type, value }) => [type, value]),
  );

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function formatDateKey(parts) {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(
    2,
    "0",
  )}-${String(parts.day).padStart(2, "0")}`;
}

function localDateTimeToUtc(dateValue, secondsOfDay) {
  const date = parseLocalDate(dateValue);
  if (!date || !Number.isFinite(secondsOfDay)) {
    return null;
  }

  const hour = Math.floor(secondsOfDay / 3600);
  const minute = Math.floor((secondsOfDay % 3600) / 60);
  const second = Math.floor(secondsOfDay % 60);
  const targetWallTime = Date.UTC(
    date.year,
    date.month - 1,
    date.day,
    hour,
    minute,
    second,
  );
  let candidate = targetWallTime;

  // Resolve a master-local wall time to a UTC instant using the IANA time zone.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observed = getMoscowDateTimeParts(new Date(candidate));
    const observedWallTime = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
    );
    const adjustment = targetWallTime - observedWallTime;
    candidate += adjustment;
    if (adjustment === 0) {
      break;
    }
  }

  const result = new Date(candidate);
  const verified = getMoscowDateTimeParts(result);
  if (
    verified.year !== date.year ||
    verified.month !== date.month ||
    verified.day !== date.day ||
    verified.hour !== hour ||
    verified.minute !== minute ||
    verified.second !== second
  ) {
    return null;
  }

  return result;
}

function parseTimeToSeconds(value) {
  if (typeof value !== "string") {
    return null;
  }

  const match = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(value);
  if (!match) {
    return null;
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? 0);
  if (hour > 23 || minute > 59 || second > 59) {
    return null;
  }

  return hour * 3600 + minute * 60 + second;
}

function formatLocalTime(secondsOfDay) {
  const hour = Math.floor(secondsOfDay / 3600);
  const minute = Math.floor((secondsOfDay % 3600) / 60);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function validateOptionalInitDataHeader(request, response) {
  const initDataRaw = request.get("X-Telegram-Init-Data");
  if (initDataRaw === undefined) {
    return true;
  }

  if (!validateInitData(initDataRaw).valid) {
    response.status(403).json({ error: "Invalid signature" });
    return false;
  }

  return true;
}

router.get("/", (_request, response) => {
  response.type("text/plain").send("Telegram Mini App boilerplate ready");
});

router.get("/health", (_request, response) => {
  response.json({
    status: "ok",
    service: "tg-miniapp-boilerplate",
    time: new Date().toISOString(),
  });
});

router.get("/env-check", (_request, response) => {
  response.json({
    hasBotToken: Boolean(process.env.BOT_TOKEN),
    hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
  });
});

router.get("/db-test", async (_request, response) => {
  if (!process.env.DATABASE_URL) {
    return response.status(500).json({
      success: false,
      error: "Database connection failed",
    });
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let statusCode = 200;
  let result;

  try {
    const queryResult = await pool.query("SELECT NOW()");
    result = {
      success: true,
      databaseTime: queryResult.rows[0].now,
    };
  } catch {
    statusCode = 500;
    result = {
      success: false,
      error: "Database query failed",
    };
  } finally {
    await pool.end().catch(() => {});
  }

  return response.status(statusCode).json(result);
});

router.get("/api/services", async (_request, response) => {
  if (!validateOptionalInitDataHeader(_request, response)) {
    return;
  }

  try {
    const result = await queryDatabase(
      "SELECT * FROM services WHERE is_active = TRUE ORDER BY sort_order, id",
    );
    return response.json(result.rows);
  } catch {
    return response.status(500).json({
      success: false,
      error: "Database operation failed",
    });
  }
});

router.get("/api/working-hours", async (_request, response) => {
  if (!validateOptionalInitDataHeader(_request, response)) {
    return;
  }

  try {
    const result = await queryDatabase(
      "SELECT * FROM working_hours ORDER BY weekday",
    );
    return response.json(result.rows);
  } catch {
    return response.status(500).json({
      success: false,
      error: "Database operation failed",
    });
  }
});

router.get("/api/my-bookings", async (request, response) => {
  const validation = validateInitData(request.query.initDataRaw);
  // Демо-режим: показываем записи гостя, созданные из браузера (только при DEMO_MODE=1).
  const demoIdentity =
    process.env.DEMO_MODE === "1"
      ? { userId: 1000000001, firstName: "Гость (демо)" }
      : null;
  if (!validation.valid && !demoIdentity) {
    return response.status(403).json({ error: "Invalid signature" });
  }
  const viewerId = validation.valid ? validation.userId : demoIdentity.userId;

  try {
    const result = await queryDatabase(
      "SELECT bookings.id, users.telegram_user_id AS user_id, bookings.service_id, services.name AS service_name, services.price AS service_price, bookings.starts_at, bookings.ends_at, bookings.status, bookings.comment, bookings.created_at FROM bookings JOIN users ON users.id = bookings.user_id JOIN services ON services.id = bookings.service_id WHERE users.telegram_user_id = $1 ORDER BY bookings.starts_at DESC",
      [String(viewerId)],
    );
    return response.json(
      result.rows.map((booking) => ({
        ...booking,
        user_id: Number(booking.user_id),
      })),
    );
  } catch {
    return response.status(500).json({ error: "Unable to load bookings" });
  }
});

router.get("/api/slots", async (request, response) => {
  if (!validateOptionalInitDataHeader(request, response)) {
    return;
  }

  const date = parseLocalDate(request.query.date);
  const serviceId = parsePositiveInteger(request.query.service_id);
  if (!date || serviceId === null) {
    return response.status(400).json({ error: "Invalid request" });
  }

  try {
    const serviceResult = await queryDatabase(
      "SELECT id, duration_minutes FROM services WHERE id = $1 AND is_active = TRUE",
      [serviceId],
    );
    const service = serviceResult.rows[0];
    if (!service) {
      return response.status(404).json({ error: "Service not found" });
    }

    const durationSeconds = Number(service.duration_minutes) * 60;
    if (!Number.isSafeInteger(durationSeconds) || durationSeconds <= 0) {
      return response.status(500).json({ error: "Unable to load available slots" });
    }

    const hoursResult = await queryDatabase(
      "SELECT start_time, end_time, break_start, break_end, is_working_day FROM working_hours WHERE weekday = $1",
      [date.weekday],
    );
    const hours = hoursResult.rows[0];
    if (!hours || !hours.is_working_day) {
      return response.json([]);
    }

    const dayStart = parseTimeToSeconds(hours.start_time);
    const dayEnd = parseTimeToSeconds(hours.end_time);
    const breakStart = parseTimeToSeconds(hours.break_start);
    const breakEnd = parseTimeToSeconds(hours.break_end);
    if (dayStart === null || dayEnd === null || dayEnd <= dayStart) {
      return response.status(500).json({ error: "Unable to load available slots" });
    }

    const bookingsResult = await queryDatabase(
      "SELECT starts_at, ends_at FROM bookings WHERE status IN ('pending', 'confirmed') AND (starts_at AT TIME ZONE $2)::date = $1::date",
      [date.value, MASTER_TIME_ZONE],
    );
    const activeBookings = bookingsResult.rows.map((booking) => ({
      start: new Date(booking.starts_at).getTime(),
      end: new Date(booking.ends_at).getTime(),
    }));
    const slots = [];

    // Candidate windows may overlap each other; this is expected. Once one is booked,
    // the overlap check below removes every conflicting candidate from later results.
    for (
      let candidateStart = dayStart;
      candidateStart <= dayEnd - durationSeconds;
      candidateStart += SLOT_STEP_SECONDS
    ) {
      const candidateEnd = candidateStart + durationSeconds;
      if (
        breakStart !== null &&
        breakEnd !== null &&
        candidateStart < breakEnd &&
        candidateEnd > breakStart
      ) {
        continue;
      }

      const startsAt = localDateTimeToUtc(date.value, candidateStart);
      if (!startsAt) {
        continue;
      }
      const endsAt = new Date(startsAt.getTime() + durationSeconds * 1000);
      const startMs = startsAt.getTime();
      if (startMs <= Date.now()) continue; // слот уже прошёл — не показываем клиенту
      const endMs = endsAt.getTime();
      const overlapsBooking = activeBookings.some(
        (booking) => startMs < booking.end && endMs > booking.start,
      );
      if (overlapsBooking) {
        continue;
      }

      slots.push({
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
        local_time: formatLocalTime(candidateStart),
      });
    }

    slots.sort((left, right) =>
      left.starts_at.localeCompare(right.starts_at),
    );
    return response.json(slots);
  } catch {
    return response.status(500).json({ error: "Unable to load available slots" });
  }
});

router.post("/api/bookings", async (request, response) => {
  const validation = validateInitData(request.body?.initDataRaw);
  const rateLimitKey = validation.valid
    ? `telegram:${validation.userId}`
    : `ip:${request.ip}`;
  if (isBookingRateLimited(rateLimitKey)) {
    response.set("Retry-After", "60");
    return response.status(429).json({ error: "Too many requests" });
  }

  // Демо-режим: запись из браузера без подписи Telegram (только при DEMO_MODE=1).
  const demoMode = process.env.DEMO_MODE === "1";
  if (!validation.valid && !demoMode) {
    return response.status(403).json({ error: "Invalid signature" });
  }
  const identity = validation.valid
    ? { userId: validation.userId, firstName: validation.firstName, demo: false }
    : { userId: 1000000001, firstName: "Гость (демо)", demo: true };

  const serviceId = parsePositiveInteger(request.body?.service_id);
  const startsAt = parseIsoInstant(request.body?.starts_at);
  const comment = request.body?.comment ?? null;
  if (
    serviceId === null ||
    !startsAt ||
    startsAt.getUTCMilliseconds() !== 0 ||
    (comment !== null && typeof comment !== "string")
  ) {
    return response.status(400).json({ error: "Invalid request" });
  }
  if (startsAt.getTime() <= Date.now()) {
    return response.status(422).json({ error: "Booking time is in the past" });
  }
  try {
    const serviceResult = await queryDatabase(
      "SELECT id, name, duration_minutes, price FROM services WHERE id = $1 AND is_active = TRUE",
      [serviceId],
    );
    const service = serviceResult.rows[0];
    if (!service) {
      return response.status(404).json({ error: "Service not found" });
    }

    const durationMinutes = Number(service.duration_minutes);
    if (!Number.isSafeInteger(durationMinutes) || durationMinutes <= 0) {
      return response.status(500).json({ error: "Unable to create booking" });
    }

    const localStart = getMoscowDateTimeParts(startsAt);
    const localDate = formatDateKey(localStart);
    const localDay = parseLocalDate(localDate);
    const endsAt = new Date(startsAt.getTime() + durationMinutes * 60 * 1000);
    const localEnd = getMoscowDateTimeParts(endsAt);
    if (!localDay || formatDateKey(localEnd) !== localDate) {
      return response.status(422).json({ error: "Booking outside working hours" });
    }

    const hoursResult = await queryDatabase(
      "SELECT start_time, end_time, break_start, break_end, is_working_day FROM working_hours WHERE weekday = $1",
      [localDay.weekday],
    );
    const hours = hoursResult.rows[0];
    if (!hours || !hours.is_working_day) {
      return response.status(422).json({ error: "Booking outside working hours" });
    }

    const dayStart = parseTimeToSeconds(hours.start_time);
    const dayEnd = parseTimeToSeconds(hours.end_time);
    const breakStart = parseTimeToSeconds(hours.break_start);
    const breakEnd = parseTimeToSeconds(hours.break_end);
    if (
      dayStart === null ||
      dayEnd === null ||
      dayEnd <= dayStart ||
      ((hours.break_start === null) !== (hours.break_end === null)) ||
      (hours.break_start !== null &&
        (breakStart === null || breakEnd === null || breakEnd <= breakStart))
    ) {
      return response.status(500).json({ error: "Unable to validate booking" });
    }

    const startSeconds =
      localStart.hour * 3600 + localStart.minute * 60 + localStart.second;
    const endSeconds =
      localEnd.hour * 3600 + localEnd.minute * 60 + localEnd.second;
    const crossesBreak =
      breakStart !== null &&
      breakEnd !== null &&
      startSeconds < breakEnd &&
      endSeconds > breakStart;
    const alignedToSlotGrid =
      (startSeconds - dayStart) % SLOT_STEP_SECONDS === 0;
    if (
      startSeconds < dayStart ||
      endSeconds > dayEnd ||
      !alignedToSlotGrid ||
      crossesBreak
    ) {
      return response.status(422).json({ error: "Booking outside working hours" });
    }

    const serviceName =
      typeof service.name === "string" ? service.name.trim() : "";
    const numericPrice = Number(service.price);
    if (
      serviceName.length === 0 ||
      !Number.isFinite(numericPrice) ||
      numericPrice < 0
    ) {
      return response.status(500).json({ error: "Unable to create booking" });
    }

    const weekday = new Intl.DateTimeFormat("ru-RU", {
      timeZone: MASTER_TIME_ZONE,
      weekday: "long",
    }).format(startsAt);
    const localDateText = new Intl.DateTimeFormat("ru-RU", {
      timeZone: MASTER_TIME_ZONE,
      day: "numeric",
      month: "long",
    }).format(startsAt);
    const localTime = new Intl.DateTimeFormat("ru-RU", {
      timeZone: MASTER_TIME_ZONE,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(startsAt);
    const price = new Intl.NumberFormat("ru-RU", {
      useGrouping: false,
      maximumFractionDigits: 2,
    }).format(numericPrice);
    const confirmationText = [
      "✅ Вы записаны",
      `Услуга: ${serviceName}`,
      `Когда: ${weekday}, ${localDateText}, ${localTime} (МСК)`,
      `Длительность: ${durationMinutes} мин`,
      `Стоимость: ${price} ₽`,
      "Ждём вас! Подробности и отмена — в приложении по кнопке «Мои записи».",
    ].join("\n");

    const booking = await withDatabaseTransaction(async (client) => {
      // Serialize booking attempts for the same master-local date.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('slot:' || $1))",
        [localDate],
      );

      const overlapResult = await client.query(
        "SELECT id FROM bookings WHERE status IN ('pending', 'confirmed') AND (starts_at AT TIME ZONE $4)::date = $1::date AND NOT ($2::timestamptz <= starts_at OR $3::timestamptz >= ends_at) LIMIT 1",
        [localDate, endsAt.toISOString(), startsAt.toISOString(), MASTER_TIME_ZONE],
      );
      if (overlapResult.rows.length > 0) {
        throw new SlotAlreadyTakenError();
      }

      // Ignore request.body.user_id entirely: only the signed initData identity
      // is mapped to a database user for this booking.
      const userResult = await client.query(
        "INSERT INTO users (telegram_user_id, first_name) VALUES ($1, $2) ON CONFLICT (telegram_user_id) DO UPDATE SET first_name = EXCLUDED.first_name RETURNING id",
        [String(identity.userId), identity.firstName],
      );
      const databaseUserId = Number(userResult.rows[0].id);
      const inserted = await client.query(
        "INSERT INTO bookings (user_id, service_id, starts_at, ends_at, status, comment) VALUES ($1, $2, $3, $4, 'pending', $5) RETURNING *",
        [
          databaseUserId,
          serviceId,
          startsAt.toISOString(),
          endsAt.toISOString(),
          comment,
        ],
      );
      return inserted.rows[0];
    });

    // This runs after COMMIT and is deliberately detached from the HTTP response.
    void (async () => {
      try {
        const botToken = process.env.BOT_TOKEN;
        if (identity.demo) throw new Error("demo booking: telegram notice skipped");
        if (!botToken) {
          throw new Error("Telegram bot token is unavailable");
        }

        const telegramResponse = await fetch(
          `https://api.telegram.org/bot${botToken}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              // In a private chat, Telegram chat_id equals the authenticated user.id.
              chat_id: identity.userId,
              text: confirmationText,
            }),
            signal: AbortSignal.timeout(5000),
          },
        );
        const telegramResult = await telegramResponse.json();
        if (!telegramResponse.ok || !telegramResult.ok) {
          throw new Error("Telegram rejected the confirmation");
        }
      } catch {
        console.error("Failed to send booking confirmation via Telegram");
      }
    })();

    // The stored FK is users.id; expose the signed Telegram ID as API user_id.
    return response.status(201).json({
      ...booking,
      user_id: identity.userId,
    });
  } catch (error) {
    if (error instanceof SlotAlreadyTakenError) {
      return response.status(409).json({ error: "Slot already taken" });
    }
    return response.status(500).json({ error: "Unable to create booking" });
  }
});
// Публичный бренд (не секрет, без подписи): фронт и бот читают его вместо литералов.
router.get("/api/brand", (_request, response) => {
  response.json({
    title: process.env.BRAND_TITLE || "Запись к мастеру",
    name: process.env.BRAND_NAME || "Демо-мастер",
    tagline: process.env.BRAND_TAGLINE || "Запись онлайн",
    greeting: process.env.BRAND_GREETING || "Привет! Выберите действие:",
    aboutButton: process.env.BRAND_ABOUT_BTN || "ℹ️ О мастере",
    aboutText: process.env.BRAND_ABOUT_TEXT || "Демо мастера: здесь можно узнать об услугах и записаться.",
  });
});
// POST /api/assistant — клиентский AI-помощник (mock сегодня).
// Подпись обязательна: контекст строим из ЛИЧНЫХ данных клиента из initData.
router.post("/api/assistant", async (request, response) => {
  console.log("ASSISTANT DIAG:", {
    header: Boolean(request.get("X-Telegram-Init-Data")),
    body: Boolean(request.body?.initDataRaw),
    query: Boolean(request.query?.initDataRaw),
  });
  const validation = validateInitData(
    request.get("X-Telegram-Init-Data") ??
      request.body?.initDataRaw ??
      request.query?.initDataRaw,
  );
  if (!validation.valid) return response.status(403).json({ error: "Invalid signature" });

  const question = request.body?.question;
  if (
    question !== undefined &&
    (typeof question !== "string" || question.length > 500)
  ) {
    return response.status(400).json({ error: "Invalid question" });
  }
  const normalizedQuestion =
    typeof question === "string" && question.trim()
      ? question.trim()
      : undefined;

  try {
    const nearest = await queryDatabase(
      `SELECT s.name AS service, s.price, b.starts_at
       FROM bookings b
       JOIN services s ON s.id = b.service_id
       JOIN users u ON u.id = b.user_id
       WHERE u.telegram_user_id = $1
         AND b.status IN ('pending', 'confirmed')
         AND b.starts_at > NOW()
       ORDER BY b.starts_at ASC
       LIMIT 1`,
      [validation.userId],
    );
    const row = nearest.rows[0];
    const nextBooking = row
      ? {
          service: row.service,
          when: new Date(row.starts_at).toLocaleString("ru-RU", {
            timeZone: MASTER_TIME_ZONE,
            day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
          }),
          price: Number(row.price),
        }
      : null;
    const servicesResult = await queryDatabase(
      "SELECT id, name, price, duration_minutes FROM services WHERE is_active = TRUE ORDER BY id",
    );
    const services = servicesResult.rows.map((service) => ({
      id: Number(service.id),
      name: service.name,
      price: Number(service.price),
      durationMinutes: Number(service.duration_minutes),
    }));
    return response.json(
      await askAssistant({
        nextBooking,
        services,
        question: normalizedQuestion,
      }),
    );
  } catch {
    console.error("Assistant request failed");
    return response.status(500).json({ error: "Assistant is unavailable" });
  }
});
export default router;