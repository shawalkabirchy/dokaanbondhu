import { describe, expect, it } from "vitest";
import { pcmDurationMs, pcmRms, pcmToWav, SAMPLE_RATE, trimSilence } from "./audio";

// Silence trim and the WAV header (spec 8.4, D45), on synthetic clips: quiet noise with a louder tone as the "speech".

/** PCM for a list of stretches: [milliseconds, amplitude 0…1]; a 200 Hz tone, so the RMS is amplitude / √2. */
function clip(parts: [number, number][]): Uint8Array {
  const samples = parts.reduce((sum, [ms]) => sum + (SAMPLE_RATE * ms) / 1000, 0);
  const pcm = new Uint8Array(samples * 2);
  const view = new DataView(pcm.buffer);
  let at = 0;
  for (const [ms, amplitude] of parts) {
    for (let i = 0; i < (SAMPLE_RATE * ms) / 1000; i++, at++) {
      const value = Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * 200 * at) / SAMPLE_RATE));
      view.setInt16(at * 2, value, true);
    }
  }
  return pcm;
}

describe("silence trim (D45)", () => {
  it("cuts silence before and after the speech, keeping 250 ms on each side", () => {
    const trimmed = trimSilence(
      clip([
        [2000, 0.002],
        [1200, 0.2],
        [3000, 0.002],
      ]),
    );
    expect(trimmed.speech).toBe(true);
    // 1.2 s of speech plus 250 ms on each side, to within one 30 ms frame
    expect(pcmDurationMs(trimmed.pcm)).toBeGreaterThanOrEqual(1680);
    expect(pcmDurationMs(trimmed.pcm)).toBeLessThanOrEqual(1760);
  });

  it("keeps a clip that is speech from the start, and never adds gain", () => {
    const original = clip([
      [800, 0.3],
      [400, 0.001],
    ]);
    const trimmed = trimSilence(original);
    expect(Array.from(trimmed.pcm.slice(0, 64))).toEqual(Array.from(original.slice(0, 64)));
    expect(pcmRms(trimmed.pcm)).toBeLessThanOrEqual(0.3);
  });

  it("finds no speech in quiet noise, and none in an empty clip", () => {
    expect(trimSilence(clip([[1500, 0.01]])).speech).toBe(false); // RMS 0.007, under the 0.015 floor
    expect(trimSilence(new Uint8Array(0))).toMatchObject({ speech: false, pcm: new Uint8Array(0) });
  });

  it("raises the threshold with the noise floor, so steady fan noise is not speech", () => {
    // noise at RMS 0.028 (above 0.015) everywhere; speech must reach 2.5 × floor = 0.07
    const noisy = trimSilence(
      clip([
        [1000, 0.04],
        [600, 0.3],
        [1000, 0.04],
      ]),
    );
    expect(noisy.speech).toBe(true);
    expect(pcmDurationMs(noisy.pcm)).toBeLessThan(1200);
  });
});

describe("WAV header", () => {
  it("adds the 44-byte header for 16 kHz mono 16-bit PCM", () => {
    const pcm = clip([[100, 0.1]]);
    const wav = pcmToWav(pcm);
    const view = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(wav.slice(8, 16))).toBe("WAVEfmt ");
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(pcm.byteLength);
    expect(wav.byteLength).toBe(44 + pcm.byteLength);
  });
});
