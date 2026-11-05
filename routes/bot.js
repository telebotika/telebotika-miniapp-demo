import { Router } from "express";
import pg from "pg";
import { askAssistant } from "../utils/ai-provider.js";
import { transcribeAudio, synthesizeSpeech } from "../utils/speech-provider.js";

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
const MASTER_TIME_ZONE = "Europe/Moscow";

let ttsFailStreak = 0;
let ttsCooldownUntil = 0;

router.get("/", (_request, response) => {
  response.json({
    service: "telegram-bot",
    configured: Boolean(process.env.BOT_TOKEN),
  });
});

router.post("/webhook", async (request, response) => {
  const webhookSecret = process.env.WEBHOOK_SECRET;
  const suppliedSecret = request.get("X-Telegram-Bot-Api-Secret-Token");

  if (webhookSecret && suppliedSecret !== webhookSecret) {
    return response.status(401).json({ ok: false });
  }

  const update = request.body;
  const callbackQuery = update?.callback_query;
  const message = update?.message;
  const shouldShowMenu =
    message?.text === "/start" || callbackQuery?.data === "menu";
  const shouldShowAbout = callbackQuery?.data === "about";
  console.log("DEBUG about:", JSON.stringify({ data: callbackQuery?.data, hasMsg: !!callbackQuery?.message, chatId: callbackQuery?.message?.chat?.id, msgId: callbackQuery?.message?.message_id, inlineId: callbackQuery?.inline_message_id, fromId: callbackQuery?.from?.id }));
  // Голос (Модуль 6.5): голосовое -> STT -> ассистент -> голосовой пузырь + текстовый дубль.
  // Стоит ДО раннего return: иначе голосовое считается "не меню и не about" и молча теряется.
  if (message?.voice) {
    response.json({ ok: true }); // отпускаем вебхук мгновенно, обработка в фоне
    void handleVoiceMessage(message);
    return;
  }
  if (!shouldShowMenu && !shouldShowAbout) {
    return response.json({ ok: true });
  }

  if (!process.env.BOT_TOKEN) {
    console.error("Telegram webhook cannot respond because BOT_TOKEN is not configured");
    return response.status(500).json({ ok: false });
  }

  let method;
  let payload;

  if (shouldShowMenu) {
    const chatId = message?.chat?.id ?? callbackQuery?.message?.chat?.id;
    const devDomain = process.env.REPLIT_DEV_DOMAIN;

    if (chatId === undefined || chatId === null || !devDomain) {
      console.error("Telegram webhook received an incomplete menu update");
      return response.status(500).json({ ok: false });
    }

    method = "sendMessage";
    payload = {
      chat_id: chatId,
      text: process.env.BRAND_GREETING || "Привет! Выберите действие:",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "📅 Открыть запись",
              web_app: { url: `https://${devDomain}/miniapp`  },
            },
          ],
          [{ text: process.env.BRAND_ABOUT_BTN, callback_data: "about" }],
        ],
      },
    };
  } else {
    const callbackMessage = callbackQuery.message;
    method = "editMessageText";
    payload = {
      text: process.env.BRAND_ABOUT_TEXT || "Демо мастера: здесь можно узнать об услугах и записаться.",
    };

    if (callbackMessage?.chat?.id !== undefined && callbackMessage?.message_id !== undefined) {
      payload.chat_id = callbackMessage.chat.id;
      payload.message_id = callbackMessage.message_id;
    } else if (callbackQuery.inline_message_id) {
      payload.inline_message_id = callbackQuery.inline_message_id;
    } else {
      console.error("Telegram webhook received an incomplete about callback");
      return response.status(500).json({ ok: false });
    }
  }

  try {
    const telegramResponse = await fetch(
      `https://api.telegram.org/bot${process.env.BOT_TOKEN}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    const telegramResult = await telegramResponse.json();

    if (!telegramResponse.ok || !telegramResult.ok) {
      console.error(`Telegram ${method} request failed`);
      return response.status(502).json({ ok: false });
    }

    return response.json({ ok: true });
  } catch {
    console.error(`Telegram ${method} request failed`);
    return response.status(502).json({ ok: false });
  }
});
async function handleVoiceMessage(message) {
  const chatId = message.chat.id;
  const sendText = (text) =>
    fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    }).catch(() => {});
  try {
    const voice = message.voice;
    if (voice.file_size > 5 * 1024 * 1024) {
      return sendText("Слишком длинное голосовое — напишите, пожалуйста, текстом.");
    }
    const fileMeta = await fetch(
      `https://api.telegram.org/bot${process.env.BOT_TOKEN}/getFile?file_id=${voice.file_id}`,
    ).then((r) => r.json());
    const filePath = fileMeta?.result?.file_path;
    if (!filePath) {
      return sendText("Не удалось получить аудио, попробуйте ещё раз.");
    }
    const audioBytes = Buffer.from(
      await fetch(`https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${filePath}`).then((r) => r.arrayBuffer()),
    );
    console.log("voice in bytes:", audioBytes.length);

    let question;
    try {
      question = (await transcribeAudio(audioBytes)).text;
    } catch (error) {
      console.error("stt failed:", error?.message);
      return sendText("🙈 Не расслышала. Продублируйте, пожалуйста, текстом — я отвечу сразу.");
    }
    await sendText(`🎤 Вы сказали: «${question}»`);

    let nextBooking = null;
    try {
      const rows = await pool.query(
        `SELECT s.name AS service, b.starts_at
         FROM bookings b
         JOIN services s ON s.id = b.service_id
         JOIN users u ON u.id = b.user_id
         WHERE u.telegram_user_id = $1
           AND b.status IN ('pending', 'confirmed')
           AND b.starts_at > NOW()
         ORDER BY b.starts_at ASC LIMIT 1`,
        [String(message.from.id)],
      );
      const row = rows.rows[0];
      if (row) {
        nextBooking = {
          service: row.service,
          when: new Date(row.starts_at).toLocaleString("ru-RU", {
            timeZone: MASTER_TIME_ZONE,
            day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
          }),
        };
      }
    } catch (error) {
      console.error("voice context failed:", error?.message); // без контекста ассистент ответит общей веткой
    }

    let services = [];
    try {
      const svc = await pool.query(
        `SELECT name, price, duration_minutes FROM services WHERE is_active = TRUE ORDER BY sort_order, id`,
      );
      services = svc.rows.map((r) => ({ name: r.name, price: Number(r.price), minutes: Number(r.duration_minutes) }));
    } catch (error) {
      console.error("voice services context failed:", error?.message);
    }
    const answer = (await askAssistant({ nextBooking, question, services })).answer;

    if (Date.now() < ttsCooldownUntil) {
      console.log("tts skipped: circuit breaker cooldown");
    } else {
      try {
        const { bytes } = await synthesizeSpeech(answer);
        const form = new FormData();
        form.append("chat_id", String(chatId));
        form.append("voice", new Blob([bytes], { type: "audio/ogg" }), "answer.ogg");
        const voiceResponse = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendVoice`, {
          method: "POST",
          body: form,
        });
        if (!voiceResponse.ok) {
          throw new Error(`sendVoice http ${voiceResponse.status}`);
        }
        ttsFailStreak = 0;
        console.log("voice out bytes:", bytes.length);
      } catch (error) {
        ttsFailStreak += 1;
        if (ttsFailStreak >= 3) {
          ttsCooldownUntil = Date.now() + 5 * 60 * 1000;
          ttsFailStreak = 0;
          console.log("tts circuit breaker opened for 5 minutes");
        }
        console.error("tts/send failed:", error?.message);
      }
    }
    return sendText(answer); // текстовый дубль ВСЕГДА: доступность + fallback
  } catch (error) {
    console.error("voice pipeline failed:", error?.message);
    return sendText("Голосовой помощник временно недоступен — напишите текстом, я на связи.");
  }
}
export default router;