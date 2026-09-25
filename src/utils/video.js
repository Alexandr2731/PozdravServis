import ffmpegPath from "ffmpeg-static";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// Telegram Bot API: видео файлом — до 50 МБ (по ссылке Telegram сам качает только до 20 МБ —
// живой тест 25.09.2026: реалистичное 1080p от HeyGen не прошло, «failed to get HTTP URL content»).
export const TELEGRAM_VIDEO_LIMIT_BYTES = 48 * 1024 * 1024;

/**
 * Ужимает видео до 720p (H.264 + AAC, faststart — чтобы в Telegram начинало играть сразу).
 * ~30 с поздравления после этого весят единицы мегабайт. Через временные файлы: mp4 с
 * faststart нельзя писать в поток.
 */
export async function compressVideo(buffer) {
  const dir = await mkdtemp(join(tmpdir(), "pozdrav-"));
  const input = join(dir, "in.mp4");
  const output = join(dir, "out.mp4");
  try {
    await writeFile(input, buffer);
    await run(ffmpegPath, [
      "-y", "-loglevel", "error", "-i", input,
      "-vf", "scale=-2:720", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
      "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", output,
    ], { maxBuffer: 10 * 1024 * 1024 });
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
