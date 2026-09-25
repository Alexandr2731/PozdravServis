import { fetchWithTimeout } from "../utils/fetchWithTimeout.js";

const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY;
const DEFAULT_VOICE_ID = "ba1544b5eae84eae9cb92598f078b6b0"; // Oleg, russian male

async function uploadImageAsset(photoBuffer) {
  const res = await fetchWithTimeout("https://upload.heygen.com/v1/asset", {
    method: "POST",
    headers: { "x-api-key": HEYGEN_API_KEY, "Content-Type": "image/jpeg" },
    body: photoBuffer,
  });
  const json = await res.json();
  if (!res.ok || !json?.data?.id) {
    throw new Error(`HeyGen asset upload failed: ${JSON.stringify(json)}`);
  }
  return json.data.id;
}

async function uploadAudioAsset(audioBuffer) {
  const form = new FormData();
  form.append("file", new Blob([audioBuffer], { type: "audio/mpeg" }), "voice.mp3");
  const res = await fetchWithTimeout("https://api.heygen.com/v3/assets", {
    method: "POST",
    headers: { "x-api-key": HEYGEN_API_KEY },
    body: form,
  });
  const json = await res.json();
  if (!res.ok || !json?.data?.asset_id) {
    throw new Error(`HeyGen audio asset upload failed: ${JSON.stringify(json)}`);
  }
  return json.data.asset_id;
}

async function cloneVoice(audioAssetId) {
  const res = await fetchWithTimeout("https://api.heygen.com/v3/voices/clone", {
    method: "POST",
    headers: { "x-api-key": HEYGEN_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      voice_name: `${CLONE_NAME_PREFIX}${Date.now()}`, // время в имени — по нему чистим старые клоны
      audio: { type: "asset_id", asset_id: audioAssetId },
      language: "ru",
    }),
  });
  const json = await res.json();
  if (!res.ok || !json?.data?.voice_clone_id) {
    throw new Error(`HeyGen voice clone failed: ${JSON.stringify(json)}`);
  }
  return json.data.voice_clone_id;
}

async function waitForVoiceClone(voiceCloneId, { intervalMs = 5000, timeoutMs = 3 * 60 * 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetchWithTimeout(`https://api.heygen.com/v3/voices/${voiceCloneId}`, {
      headers: { "x-api-key": HEYGEN_API_KEY },
    });
    const json = await res.json();
    const status = json?.data?.status;
    if (status === "complete") return voiceCloneId;
    if (status === "failed") throw new Error(`HeyGen voice clone failed: ${JSON.stringify(json)}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("HeyGen voice clone timed out");
}

// Тариф HeyGen держит всего 2 клона голоса одновременно (живой тест 25.09.2026:
// resource_limit_reached на третьем заказе). Клон нужен только на время одной генерации —
// после видео удаляем (deleteVoice), а если слот всё же занят (упал процесс, не успели
// удалить) — чистим свои старые клоны и повторяем один раз.
const CLONE_NAME_PREFIX = "client-";
// Клон моложе этого может принадлежать заказу, который генерируется прямо сейчас, — не трогаем.
const STALE_CLONE_AGE_MS = 30 * 60 * 1000;

export async function deleteVoice(voiceId) {
  const res = await fetchWithTimeout(`https://api.heygen.com/v3/voices/${voiceId}`, {
    method: "DELETE",
    headers: { "x-api-key": HEYGEN_API_KEY },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`HeyGen voice delete failed: ${res.status} ${await res.text()}`);
  }
}

async function deleteStaleClones() {
  const res = await fetchWithTimeout("https://api.heygen.com/v3/voices?type=private", {
    headers: { "x-api-key": HEYGEN_API_KEY },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`HeyGen list voices failed: ${JSON.stringify(json)}`);
  const now = Date.now();
  const stale = (json?.data ?? []).filter((v) => {
    if (!v.name?.startsWith(CLONE_NAME_PREFIX)) return false; // чужие/ручные голоса аккаунта не трогаем
    const createdAt = Number(v.name.slice(CLONE_NAME_PREFIX.length));
    return Number.isFinite(createdAt) && now - createdAt > STALE_CLONE_AGE_MS;
  });
  for (const v of stale) await deleteVoice(v.voice_id);
  return stale.length;
}

export async function cloneVoiceFromAudio(audioBuffer) {
  const assetId = await uploadAudioAsset(audioBuffer);
  let voiceCloneId;
  try {
    voiceCloneId = await cloneVoice(assetId);
  } catch (err) {
    if (!err.message.includes("resource_limit_reached")) throw err;
    const deleted = await deleteStaleClones();
    console.log(`HeyGen clone limit reached — deleted ${deleted} stale clone(s), retrying`);
    voiceCloneId = await cloneVoice(assetId);
  }
  return waitForVoiceClone(voiceCloneId);
}

async function createVideo({ assetId, text, voiceId }) {
  const res = await fetchWithTimeout("https://api.heygen.com/v3/videos", {
    method: "POST",
    headers: { "x-api-key": HEYGEN_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "image",
      image: { type: "asset_id", asset_id: assetId },
      script: text,
      voice_id: voiceId || DEFAULT_VOICE_ID,
      resolution: "1080p",
      aspect_ratio: "auto",
    }),
  });
  const json = await res.json();
  if (!res.ok || !json?.data?.video_id) {
    throw new Error(`HeyGen video create failed: ${JSON.stringify(json)}`);
  }
  return json.data.video_id;
}

async function waitForVideo(videoId, { intervalMs = 8000, timeoutMs = 5 * 60 * 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetchWithTimeout(`https://api.heygen.com/v3/videos/${videoId}`, {
      headers: { "x-api-key": HEYGEN_API_KEY },
    });
    const json = await res.json();
    const status = json?.data?.status;
    if (status === "completed") return json.data.video_url;
    if (status === "failed") throw new Error(`HeyGen video failed: ${JSON.stringify(json)}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("HeyGen video generation timed out");
}

export async function generateGreetingVideo({ photoBuffer, text, voiceId }) {
  if (!HEYGEN_API_KEY) {
    throw new Error("HEYGEN_API_KEY не задан — добавь его через /settings");
  }
  const assetId = await uploadImageAsset(photoBuffer);
  const videoId = await createVideo({ assetId, text, voiceId });
  return waitForVideo(videoId);
}
