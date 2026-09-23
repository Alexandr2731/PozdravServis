import { fetchWithTimeout } from "../utils/fetchWithTimeout.js";

const MUREKA_API_KEY = process.env.MUREKA_API_KEY;
const BASE = "https://api.mureka.ai/v1";

async function murekaFetch(path, options = {}) {
  const res = await fetchWithTimeout(`${BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${MUREKA_API_KEY}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Mureka API error (${path}): ${JSON.stringify(json)}`);
  }
  return json;
}

export async function generateLyrics(prompt) {
  const json = await murekaFetch("/lyrics/generate", {
    method: "POST",
    body: JSON.stringify({ prompt }),
  });
  return json.lyrics;
}

export async function generateSong({ lyrics, stylePrompt }) {
  const json = await murekaFetch("/song/generate", {
    method: "POST",
    body: JSON.stringify({ lyrics, model: "auto", prompt: stylePrompt }),
  });
  return json.id;
}

// Статусы "ещё не готово" по факту (подтверждено живым тестом в den-rozhdeniya
// 07.09.2026) — считаем готовым всё, что НЕ входит в этот список, а не наоборот, чтобы
// не зависнуть навсегда на незнакомом статусе.
const MUREKA_IN_PROGRESS_STATUSES = ["preparing", "queued", "running", "streaming"];

export async function waitForSong(taskId, { intervalMs = 8000, timeoutMs = 6 * 60 * 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let json;
    try {
      json = await murekaFetch(`/song/query/${taskId}`);
    } catch (err) {
      // Mureka роняет соединение при опросе статуса чаще, чем при обычных запросах —
      // это не провал генерации, продолжаем опрашивать тот же taskId.
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }
    const status = json?.status;
    if (!MUREKA_IN_PROGRESS_STATUSES.includes(status)) {
      if (status !== "succeeded" || !json?.choices?.length) {
        throw new Error(`Mureka song generation ended with status "${status}": ${JSON.stringify(json)}`);
      }
      // Mureka по умолчанию отдаёт 2 варианта на одну генерацию (подтверждено живым
      // тестом) — раньше здесь бралось только json.mp3_url/json.video.video_url, второй
      // вариант молча терялся. lyrics_sections — тайминги по словам, уже готовые для
      // будущего караоке, отдельный STT-этап не нужен. "video" Mureka не отдаёт — клип
      // делается отдельно (HeyGen), это не то же самое, что песня.
      return {
        choices: json.choices.map((c) => ({
          mp3Url: c.url,
          flacUrl: c.flac_url,
          wavUrl: c.wav_url,
          durationMs: c.duration,
          lyricsSections: c.lyrics_sections ?? [],
        })),
      };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("Mureka song generation timed out");
}
