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
    if (status === "succeeded" || status === "complete" || json?.mp3_url) {
      return { mp3Url: json.mp3_url, videoUrl: json?.video?.video_url };
    }
    if (status === "failed") {
      throw new Error(`Mureka song generation failed: ${JSON.stringify(json)}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("Mureka song generation timed out");
}
