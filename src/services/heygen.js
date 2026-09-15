const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY;
const DEFAULT_VOICE_ID = "ba1544b5eae84eae9cb92598f078b6b0"; // Oleg, russian male

async function uploadTalkingPhoto(photoBuffer) {
  const res = await fetch("https://upload.heygen.com/v1/talking_photo", {
    method: "POST",
    headers: { "x-api-key": HEYGEN_API_KEY, "Content-Type": "image/jpeg" },
    body: photoBuffer,
  });
  const json = await res.json();
  if (!res.ok || !json?.data?.talking_photo_id) {
    throw new Error(`HeyGen upload failed: ${JSON.stringify(json)}`);
  }
  return json.data.talking_photo_id;
}

async function createVideo(talkingPhotoId, text) {
  const res = await fetch("https://api.heygen.com/v2/video/generate", {
    method: "POST",
    headers: { "x-api-key": HEYGEN_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      video_inputs: [
        {
          character: { type: "talking_photo", talking_photo_id: talkingPhotoId },
          voice: { type: "text", input_text: text, voice_id: DEFAULT_VOICE_ID },
        },
      ],
      dimension: { width: 720, height: 1280 },
    }),
  });
  const json = await res.json();
  if (!res.ok || !json?.data?.video_id) {
    throw new Error(`HeyGen generate failed: ${JSON.stringify(json)}`);
  }
  return json.data.video_id;
}

async function waitForVideo(videoId, { intervalMs = 5000, timeoutMs = 5 * 60 * 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`https://api.heygen.com/v1/video_status.get?video_id=${videoId}`, {
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

export async function generateGreetingVideo({ photoBuffer, text }) {
  if (!HEYGEN_API_KEY) {
    throw new Error("HEYGEN_API_KEY не задан — добавь его через /settings");
  }
  const talkingPhotoId = await uploadTalkingPhoto(photoBuffer);
  const videoId = await createVideo(talkingPhotoId, text);
  return waitForVideo(videoId);
}
