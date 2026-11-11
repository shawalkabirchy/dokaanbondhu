import { spawn } from "node:child_process";

// Clips for voice items (spec 18.4): any recording is converted with ffmpeg to 16 kHz mono 16-bit PCM, the format the
// app records and uploads.

/**
 * A recording file as 16 kHz mono PCM. A phone's M4A keeps its index at the end of the file, which ffmpeg cannot reach
 * through a pipe, so a file is read by its path. An empty result is an error, never a silent clip.
 */
export async function fileToPcm16k(path: string): Promise<Uint8Array> {
  const pcm = await toPcm16k(null, path);
  if (pcm.byteLength < 6_400) throw new Error(`${path}: under 0.2 s of audio after conversion`);
  return pcm;
}

export function toPcm16k(input: Uint8Array | null, path?: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        path ?? "pipe:0",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "s16le",
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    ffmpeg.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    ffmpeg.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    ffmpeg.on("error", (error) =>
      reject(new Error(`ffmpeg could not start (${error.message}); is it installed?`)),
    );
    ffmpeg.on("close", (code) => {
      if (code === 0) resolve(new Uint8Array(Buffer.concat(out)));
      else reject(new Error(`ffmpeg failed (${code}): ${Buffer.concat(err).toString("utf8").slice(0, 300)}`));
    });
    ffmpeg.stdin.on("error", () => undefined); // ffmpeg may stop reading early; its exit code tells
    ffmpeg.stdin.end(input ? Buffer.from(input) : undefined);
  });
}
