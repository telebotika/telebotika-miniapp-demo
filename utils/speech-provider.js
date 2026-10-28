// utils/speech-provider.js — голосовой контракт (Модуль 6.5).
// transcribeAudio(oggBytes) -> {provider, text}; synthesizeSpeech(text) -> {provider, bytes}.
// Провайдер один: Yandex SpeechKit. Fail-closed: нет ключей -> throw, вызывающий деградирует в текст.
// Аудио в логи не пишем (голос = персональные данные): только длины и статусы.
export async function transcribeAudio(audioBytes) {
  const key = process.env.YANDEX_SPEECHKIT_API_KEY;
  const folderId = process.env.YANDEX_FOLDER_ID;
  if (!key || !folderId) throw new Error("speechkit not configured");
  // STT: синхронный v1, аудио уходит бинарным телом, параметры — в query.
  const url = new URL("https://stt.api.cloud.yandex.net/speech/v1/stt:recognize");
  url.searchParams.set("folderId", folderId);
  url.searchParams.set("topic", "general");
  url.searchParams.set("lang", "ru-RU");
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Api-Key ${key}`, "Content-Type": "audio/ogg" },
    body: audioBytes,
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`stt http ${r.status}`);
  const data = await r.json();
  const text = String(data.result ?? "").trim();
  if (!text) throw new Error("stt empty result");
  return { provider: "yandex", text };
}

export async function synthesizeSpeech(text) {
  const key = process.env.YANDEX_SPEECHKIT_API_KEY;
  const folderId = process.env.YANDEX_FOLDER_ID;
  if (!key || !folderId) throw new Error("speechkit not configured");

  // TTS: REST v1, параметры формой, ответ — бинарный ogg/opus.
  const body = new URLSearchParams({ folderId, text, voice: process.env.TTS_VOICE || "alyss", format: "oggopus" });
  const r = await fetch("https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize", {
    method: "POST",
    headers: { Authorization: `Api-Key ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(7000),
  });
  if (!r.ok) throw new Error(`tts http ${r.status}`);
  const bytes = Buffer.from(await r.arrayBuffer());
  if (bytes.length === 0) throw new Error("tts empty audio");
  return { provider: "yandex", bytes };
}