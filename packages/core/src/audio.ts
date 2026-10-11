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
/** No frame quieter than this is speech, however quiet the room (D150; it was 0.015, above a quiet phone's speech). */
const SPEECH_FLOOR = 0.003;

/** The RMS of each 30 ms frame. */
function frameRms(pcm: Uint8Array): number[] {
  const frameBytes = (SAMPLE_RATE * FRAME_MS * 2) / 1000;
  const frames: number[] = [];
  for (let start = 0; start + 1 < pcm.byteLength; start += frameBytes) {
    frames.push(pcmRms(pcm, start, Math.min(start + frameBytes, pcm.byteLength)));
  }
  return frames;
}

/** The noise floor (the 20th percentile of the frames' RMS) and the speech threshold it sets. */
function speechThreshold(frames: readonly number[]): { noiseFloor: number; threshold: number } {
  const sorted = [...frames].sort((a, b) => a - b);
  const noiseFloor = sorted[Math.floor(0.2 * (sorted.length - 1))]!;
  return { noiseFloor, threshold: Math.max(SPEECH_FLOOR, 2.5 * noiseFloor) };
}

/**
 * Cuts leading and trailing silence (D45, D150): 30 ms frames; the noise floor is the 20th percentile of the frames'
 * RMS; a speech frame has an RMS of at least max(0.003, 2.5 × floor), so the clip's own level decides and a quiet
 * microphone's speech is kept; everything before the first and after the last speech frame is cut, keeping 250 ms on
 * each side. Starting values, tuned on the kept clips (D149).
 */
export function trimSilence(pcm: Uint8Array): Trimmed {
  const frameBytes = (SAMPLE_RATE * FRAME_MS * 2) / 1000;
  const frames = frameRms(pcm);
  if (!frames.length) return { pcm: new Uint8Array(0), speech: false, noiseFloor: 0 };
  const { noiseFloor, threshold } = speechThreshold(frames);
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

/** The level quiet speech is raised to: the speech frames' 95th-percentile RMS (D150). */
const TARGET_RMS = 0.1;
const MAX_GAIN = 12;

export interface Leveled {
  pcm: Uint8Array;
  /** The gain applied; 1 when the clip was left as it was. */
  gain: number;
}

/**
 * Raises quiet speech to a steady level before speech-to-text (D150): the speech frames' 95th-percentile RMS becomes
 * 0.1, by at most 12×, and never so far that a sample clips. A clip already about that loud is left as it is.
 */
export function normalizeLevel(pcm: Uint8Array): Leveled {
  const frames = frameRms(pcm);
  if (!frames.length) return { pcm, gain: 1 };
  const { threshold } = speechThreshold(frames);
  const speech = frames.filter((rms) => rms >= threshold).sort((a, b) => a - b);
  const loud = speech[Math.floor(0.95 * (speech.length - 1))];
  if (!loud) return { pcm, gain: 1 };
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let peak = 0;
  for (let i = 0; i + 1 < pcm.byteLength; i += 2) peak = Math.max(peak, Math.abs(view.getInt16(i, true)));
  const gain = Math.min(MAX_GAIN, TARGET_RMS / loud, peak ? (0.98 * 32767) / peak : MAX_GAIN);
  if (gain <= 1.05) return { pcm, gain: 1 };
  const out = new Uint8Array(pcm.byteLength - (pcm.byteLength % 2));
  const raised = new DataView(out.buffer);
  for (let i = 0; i + 1 < pcm.byteLength; i += 2) {
    const sample = Math.round(view.getInt16(i, true) * gain);
    raised.setInt16(i, Math.max(-32768, Math.min(32767, sample)), true);
  }
  return { pcm: out, gain: Math.round(gain * 100) / 100 };
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
