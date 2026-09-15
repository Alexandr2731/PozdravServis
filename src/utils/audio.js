import ffmpegPath from "ffmpeg-static";
import ffmpeg from "fluent-ffmpeg";
import { PassThrough } from "node:stream";

ffmpeg.setFfmpegPath(ffmpegPath);

export function convertOggToMp3(oggBuffer) {
  return new Promise((resolve, reject) => {
    const input = new PassThrough();
    input.end(oggBuffer);
    const chunks = [];
    ffmpeg(input)
      .inputFormat("ogg")
      .audioCodec("libmp3lame")
      .format("mp3")
      .on("error", reject)
      .pipe()
      .on("data", (chunk) => chunks.push(chunk))
      .on("end", () => resolve(Buffer.concat(chunks)))
      .on("error", reject);
  });
}
