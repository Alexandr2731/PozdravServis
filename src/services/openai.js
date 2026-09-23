import { fetchWithTimeout } from "../utils/fetchWithTimeout.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// style: "prose" (обычный текст) | "poem" (стихи) — выбор клиента на шаге до генерации.
// count: сколько независимых вариантов вернуть за один запрос (n у OpenAI) — генерация
// текста дешёвая, 2 варианта почти не увеличивают стоимость, но дают клиенту выбор.
// Возвращает массив строк длиной count (даже при count=1 — единообразия ради).
export async function generateGreetingText({ occasion, personInfo, style = "prose", count = 1 }) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY не задан — добавь его через /settings");
  }
  // ~75 слов — ориентир на 30 секунд озвучки в видео (обычная русская речь ~2.5 слова/сек,
  // см. greeting.js MAX_GREETING_TEXT_WORDS). Дольше — дороже в генерации видео, чем
  // заложено в цену.
  const lengthInstruction = "Уложись примерно в 75 слов (не больше) — поздравление рассчитано на ~30 секунд озвучки.";
  const systemPrompt =
    style === "poem"
      ? "Ты пишешь тёплые, живые поздравления в стихах на русском языке. Настоящие стихи с рифмой и ритмом " +
        `(не рифмованная проза) — 4-8 строк, без клише и канцелярита. ${lengthInstruction}`
      : "Ты пишешь тёплые, живые поздравления на русском языке. Обычный текст, НЕ стихи, без рифмы — 4-8 строк, " +
        `без клише и канцелярита. ${lengthInstruction}`;
  const res = await fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      n: count,
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content:
            `Повод: ${occasion}.\n` +
            `Информация о человеке (дословно от клиента, могла быть надиктована голосом и распознана автоматически): "${personInfo}"\n\n` +
            `Внимательно разбери эти факты, прежде чем писать. Не путай их: например, "мы знакомы N лет" или ` +
            `"дружим N лет" — это про длительность знакомства/дружбы, а НЕ про возраст человека или дату. ` +
            `Не приписывай человеку конкретный возраст, дату или другие факты, которых нет в тексте дословно — ` +
            `если что-то не сказано явно, не выдумывай это. Поздравление должно быть явно про указанный повод — ` +
            `не пиши про день рождения или другой повод, если он не указан.\n\n` +
            `Напиши поздравление.`,
        },
      ],
    }),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`OpenAI error: ${JSON.stringify(json)}`);
  }
  return json.choices.map((c) => c.message.content.trim());
}

export async function transcribeVoice(audioBuffer, filename = "voice.mp3") {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY не задан — добавь его через /settings");
  }
  const form = new FormData();
  form.append("file", new Blob([audioBuffer], { type: "audio/mpeg" }), filename);
  form.append("model", "whisper-1");
  form.append("language", "ru");
  const res = await fetchWithTimeout("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`OpenAI transcription error: ${JSON.stringify(json)}`);
  }
  return json.text;
}

export async function stylizeCartoon(photoBuffer) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY не задан — добавь его через /settings");
  }
  const form = new FormData();
  form.append("image", new Blob([photoBuffer], { type: "image/jpeg" }), "photo.jpg");
  form.append("model", "gpt-image-1");
  form.append(
    "prompt",
    "Redraw this person in a friendly cartoon/animation style, keep the likeness recognizable, same pose and framing."
  );
  const res = await fetchWithTimeout(
    "https://api.openai.com/v1/images/edits",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
    },
    60000
  );
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`OpenAI image edit error: ${JSON.stringify(json)}`);
  }
  return Buffer.from(json.data[0].b64_json, "base64");
}
