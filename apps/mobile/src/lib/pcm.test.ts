import { base64ToBytes, PeakMeter, RmsMeter } from "./pcm";

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

describe("recorded PCM", () => {
  it("decodes base64 to exactly the recorded bytes (no gain)", () => {
    const recorded = new Uint8Array([0x00, 0x80, 0xff, 0x7f, 0x10, 0x00, 0xab]);
    expect(Array.from(base64ToBytes(toBase64(recorded)))).toEqual(Array.from(recorded));
  });

  it("measures RMS on samples scaled to -1…1", () => {
    const meter = new RmsMeter();
    const samples = new Int16Array([16384, -16384, 16384, -16384]); // ±0.5
    meter.add(new Uint8Array(samples.buffer));
    expect(meter.value).toBeCloseTo(0.5, 5);
    const silence = new RmsMeter();
    silence.add(new Uint8Array(3200));
    expect(silence.value).toBe(0);
  });

  it("finds the loudest 300 ms, however long the button was held through silence (D150)", () => {
    /** 100 ms of a steady level (samples alternating ±level). */
    const block = (level: number) =>
      new Uint8Array(
        new Int16Array(Array.from({ length: 1600 }, (_, i) => Math.round((i % 2 ? -1 : 1) * level * 32767)))
          .buffer,
      );
    const meter = new PeakMeter();
    for (let i = 0; i < 20; i++) meter.add(block(0.001)); // two seconds of near silence
    for (let i = 0; i < 3; i++) meter.add(block(0.02)); // one quiet word
    for (let i = 0; i < 10; i++) meter.add(block(0.001));
    expect(meter.value).toBeCloseTo(0.02, 3);
    const short = new PeakMeter();
    short.add(block(0.05)); // under 300 ms: the RMS of all of it
    expect(short.value).toBeCloseTo(0.05, 3);
  });
});
