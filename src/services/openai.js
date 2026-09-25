import { fetchWithTimeout } from "../utils/fetchWithTimeout.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// style: "prose" (обычный текст) | "poem" (стихи) — выбор клиента на шаге до генерации.
// count: сколько независимых вариантов вернуть за один запрос (n у OpenAI) — генерация
// текста дешёвая, 2 варианта почти не увеличивают стоимость, но дают клиенту выбор.
// Возвращает массив строк длиной count (даже при count=1 — единообразия ради).
//
// Модель выбрана слепым сравнением 24.09.2026 (Александр): на одних и тех же вводных
// gpt-4o-mini писала битые рифмы и несуществующие слова ("друг мой dear", "мечтаета"),
// 2 из 3 понравившихся вариантов — gpt-5.5, третий — gpt-5.4-mini; YandexGPT не выбран
// ни разу. Решение временное — будем тестировать ещё (knowledge/tasks.md, ТЕКСТ-1).
const GREETING_TEXT_MODEL = "gpt-5.5";
// Сколько раз переспросить модель, если вариант длиннее maxWords. Промпт просит
// уложиться, но модели это не гарантируют (живой прогон 23.09: 65+ слов при просьбе ~75).
const MAX_LENGTH_RETRIES = 2;

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export async function generateGreetingText({ occasion, personInfo, style = "prose", count = 1, maxWords = 75 }) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY не задан — добавь его через /settings");
  }
  // ~75 слов — ориентир на 30 секунд озвучки в видео (обычная русская речь ~2.5 слова/сек,
  // см. greeting.js MAX_GREETING_TEXT_WORDS). Дольше — дороже в генерации видео, чем
  // заложено в цену.
  const lengthInstruction = `Уложись примерно в ${maxWords} слов (не больше) — поздравление рассчитано на ~30 секунд озвучки.`;
  const systemPrompt =
    style === "poem"
      ? "Ты пишешь тёплые, живые поздравления в стихах на русском языке. Настоящие стихи с рифмой и ритмом " +
        `(не рифмованная проза) — 4-8 строк, без клише и канцелярита. ${lengthInstruction}`
      : "Ты пишешь тёплые, живые поздравления на русском языке. Обычный текст, НЕ стихи, без рифмы — 4-8 строк, " +
        `без клише и канцелярита. ${lengthInstruction}`;
  async function requestVariants(n) {
    const res = await fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: GREETING_TEXT_MODEL,
        n,
        // короткий творческий текст — долгое "обдумывание" не нужно, только удлиняет ожидание
        reasoning_effort: "low",
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

  const variants = await requestVariants(count);
  for (let attempt = 0; attempt < MAX_LENGTH_RETRIES; attempt++) {
    const tooLong = variants.map((t, i) => (countWords(t) > maxWords ? i : -1)).filter((i) => i >= 0);
    if (tooLong.length === 0) break;
    const retries = await requestVariants(tooLong.length);
    // заменяем, только если новый вариант короче — иначе ретрай может сделать хуже
    tooLong.forEach((idx, k) => {
      if (countWords(retries[k]) < countWords(variants[idx])) variants[idx] = retries[k];
    });
  }
  return variants;
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

// Картинку потом «оживляет» HeyGen, а ему нужно чётко различимое человеческое лицо: по
// размытой просьбе «в мультяшном стиле, тот же кадр» на фото со сцены лицо выходило мелким
// и условным — «No face detected in the image» (живой тест 25.09.2026). Поэтому: объёмный
// стиль анимационного кино с человеческими пропорциями, лицо крупно и анфас, глаза и рот
// прорисованы. closeUp — вторая попытка после «лицо не найдено»: портрет по плечи.
const CARTOON_PROMPT =
  "Redraw this person as a character from a modern 3D animated family movie (Pixar/Disney style), " +
  "with realistic human proportions. Keep the likeness clearly recognizable: face shape, hairstyle, " +
  "skin tone, facial hair, glasses if any. The face must be large, well lit, facing the camera, " +
  "with both eyes open and a clearly drawn closed mouth, nothing covering the face. " +
  "Keep the same clothing; simplify the background.";
const CARTOON_CLOSEUP_PROMPT =
  CARTOON_PROMPT + " Crop to a head-and-shoulders portrait so the face fills most of the image.";

export async function stylizeCartoon(photoBuffer, { closeUp = false } = {}) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY не задан — добавь его через /settings");
  }
  const form = new FormData();
  form.append("image", new Blob([photoBuffer], { type: "image/jpeg" }), "photo.jpg");
  form.append("model", "gpt-image-1");
  form.append("prompt", closeUp ? CARTOON_CLOSEUP_PROMPT : CARTOON_PROMPT);
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
