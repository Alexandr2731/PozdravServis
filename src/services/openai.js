import { fetchWithTimeout } from "../utils/fetchWithTimeout.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

export async function generateGreetingText({ occasion, personInfo }) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY не задан — добавь его через /settings");
  }
  const res = await fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "Ты пишешь тёплые, живые поздравления на русском языке. Без клише и канцелярита, 4-8 строк.",
        },
        {
          role: "user",
          content: `Повод: ${occasion}.\nО человеке: ${personInfo}.\nНапиши поздравление.`,
        },
      ],
    }),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`OpenAI error: ${JSON.stringify(json)}`);
  }
  return json.choices[0].message.content.trim();
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
