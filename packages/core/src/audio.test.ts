import { describe, expect, it } from "vitest";
import {
  normalizeLevel,
  pcmDurationMs,
  pcmRms,
  pcmToWav,
  SAMPLE_RATE,
  tooLittleSpeech,
  tooManyWords,
  trimSilence,
} from "./audio";

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
    expect(trimSilence(clip([[1500, 0.01]])).speech).toBe(false); // a steady RMS 0.007: never 2.5 × its own floor
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

  it("keeps quiet speech from a quiet microphone, which the old 0.015 floor cut away (D150)", () => {
    // speech at RMS 0.014 over a room at 0.0014, like the emulator's laptop microphone
    const quiet = trimSilence(
      clip([
        [1000, 0.002],
        [1200, 0.02],
        [1000, 0.002],
      ]),
    );
    expect(quiet.speech).toBe(true);
    expect(pcmDurationMs(quiet.pcm)).toBeGreaterThanOrEqual(1200);
    expect(pcmDurationMs(quiet.pcm)).toBeLessThan(1800);
  });
});

describe("a click and silence (D156)", () => {
  // As the emulator recorded "air filter ache" on 11 Oct: the microphone's switch-on click, silence, a faint blip.
  const clicked = () =>
    clip([
      [100, 0.9],
      [1100, 0],
      [300, 0.015],
      [1500, 0],
    ]);

  it("never takes the switch-on click for speech, and counts only the speech frames", () => {
    const trimmed = trimSilence(clicked());
    expect(trimmed.speech).toBe(true);
    expect(trimmed.speechMs).toBeGreaterThanOrEqual(270);
    expect(trimmed.speechMs).toBeLessThanOrEqual(330);
    expect(pcmDurationMs(trimmed.pcm)).toBeLessThan(900); // the click is cut away with the silence
    expect(
      trimSilence(
        clip([
          [100, 0.9],
          [2000, 0],
        ]),
      ).speech,
    ).toBe(false); // the click alone is no speech
  });

  it.each([
    { style: "Bangla", madeUp: "রাতে বিশ্ববিদ্যালয়ের প্রধান বিভাগের পরিচালক মো", said: "এয়ার ফিল্টার আছে" },
    {
      style: "Banglish",
      madeUp: "rate bishwobiddaloyer prodhan bibhager porichalok mo",
      said: "air filter ache",
    },
  ])("finds a transcript with more words than its speech could hold ($style)", ({ madeUp, said }) => {
    const { speechMs } = trimSilence(clicked());
    expect(tooManyWords(madeUp, speechMs)).toBe(true);
    expect(tooManyWords(said, speechMs)).toBe(false);
    expect(tooManyWords(madeUp, 2000)).toBe(false); // the same words in two seconds of speech are possible
  });

  it.each([
    { style: "Bangla", blip: "ভিডার", yes: "হ্যাঁ", no: "না", number: "দুই" },
    { style: "Banglish", blip: "vidar", yes: "ha", no: "na", number: "2" },
  ])(
    "from under 0.3 s of speech takes only yes, no or a number (D158, $style)",
    ({ blip, yes, no, number }) => {
      expect(tooLittleSpeech(blip, 180)).toBe(true);
      for (const short of [yes, no, number]) expect(tooLittleSpeech(short, 180)).toBe(false);
      expect(tooLittleSpeech(blip, 390)).toBe(false); // the owner's shortest real answer, হ্যাঁ, had 0.39 s
    },
  );
});

describe("level (D150)", () => {
  it("raises quiet speech to a steady level, by at most 12 times and without clipping", () => {
    const quiet = trimSilence(
      clip([
        [500, 0.002],
        [1200, 0.02],
        [500, 0.002],
      ]),
    ).pcm;
    const raised = normalizeLevel(quiet);
    expect(raised.gain).toBeGreaterThan(5);
    expect(raised.gain).toBeLessThanOrEqual(12);
    expect(raised.pcm.byteLength).toBe(quiet.byteLength);
    expect(pcmRms(raised.pcm)).toBeGreaterThan(5 * pcmRms(quiet));
    const view = new DataView(raised.pcm.buffer);
    let peak = 0;
    for (let i = 0; i < raised.pcm.byteLength; i += 2)
      peak = Math.max(peak, Math.abs(view.getInt16(i, true)));
    expect(peak).toBeLessThanOrEqual(32767);

    // a whisper in a silent room: the gain stops at 12
    const faint = clip([
      [500, 0.0005],
      [1000, 0.006],
      [500, 0.0005],
    ]);
    expect(normalizeLevel(faint).gain).toBe(12);
  });

  it("leaves speech that is already loud as it is, and never raises a peak past full scale", () => {
    const loud = clip([[1000, 0.3]]);
    expect(normalizeLevel(loud)).toEqual({ pcm: loud, gain: 1 });
    // quiet on average but with one near-full-scale click: the click caps the gain
    const clicked = clip([
      [990, 0.02],
      [10, 0.9],
    ]);
    const raised = normalizeLevel(clicked);
    expect(raised.gain).toBeLessThanOrEqual((0.98 * 32767) / Math.round(0.9 * 32767) + 0.01);
    expect(normalizeLevel(new Uint8Array(0)).gain).toBe(1);
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
