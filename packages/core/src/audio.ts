// Voice clips on the server (spec 8.4, D45): 16-bit little-endian mono PCM at 16 kHz. RMS is measured on samples scaled
// to -1…1 (a sample divided by 32768), as on the phone and in the speech worker.

export const SAMPLE_RATE = 16_000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;

/** The RMS of a stretch of PCM (samples scaled to -1…1); 0 for an empty one. */
export function pcmRms(pcm: Uint8Array, from = 0, to = pcm.byteLength): number {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let sum = 0;
  let count = 0;
  for (let i = from; i + 1 < to; i += 2) {
    const sample = view.getInt16(i, true) / 32768;
    sum += sample * sample;
    count++;
  }
  return count === 0 ? 0 : Math.sqrt(sum / count);
}

/** Milliseconds of audio in a PCM clip. */
export const pcmDurationMs = (pcm: Uint8Array) => Math.round((pcm.byteLength / BYTES_PER_SECOND) * 1000);

export interface Trimmed {
  /** The clip from 250 ms before the first speech frame to 250 ms after the last; empty when there is no speech. */
  pcm: Uint8Array;
  speech: boolean;
  noiseFloor: number;
}

const FRAME_MS = 30;
const KEEP_MS = 250;

/**
 * Cuts leading and trailing silence (D45): 30 ms frames; the noise floor is the 20th percentile of the frames' RMS;
 * a speech frame has an RMS of at least max(0.015, 2.5 × floor); everything before the first and after the last speech
 * frame is cut, keeping 250 ms on each side. Starting values, tuned on the open half of the test set.
 */
export function trimSilence(pcm: Uint8Array): Trimmed {
  const frameBytes = (SAMPLE_RATE * FRAME_MS * 2) / 1000;
  const frames: number[] = [];
  for (let start = 0; start + 1 < pcm.byteLength; start += frameBytes) {
    frames.push(pcmRms(pcm, start, Math.min(start + frameBytes, pcm.byteLength)));
  }
  if (!frames.length) return { pcm: new Uint8Array(0), speech: false, noiseFloor: 0 };
  const sorted = [...frames].sort((a, b) => a - b);
  const noiseFloor = sorted[Math.floor(0.2 * (sorted.length - 1))]!;
  const threshold = Math.max(0.015, 2.5 * noiseFloor);
  const first = frames.findIndex((rms) => rms >= threshold);
  if (first < 0) return { pcm: new Uint8Array(0), speech: false, noiseFloor };
  let last = first;
  frames.forEach((rms, index) => {
    if (rms >= threshold) last = index;
  });
  const keep = (SAMPLE_RATE * KEEP_MS * 2) / 1000;
  const start = Math.max(0, first * frameBytes - keep);
  const end = Math.min(pcm.byteLength, (last + 1) * frameBytes + keep);
  return { pcm: pcm.slice(start, end - ((end - start) % 2)), speech: true, noiseFloor };
}

/** A WAV file of the PCM: the 44-byte header (PCM, mono, 16 kHz, 16-bit) and the samples (spec 8.4). */
export function pcmToWav(pcm: Uint8Array): Uint8Array {
  const wav = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(wav.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) wav[offset + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // size of the fmt chunk
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, BYTES_PER_SECOND, true);
  view.setUint16(32, 2, true); // bytes per sample frame
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  wav.set(pcm, 44);
  return wav;
}
