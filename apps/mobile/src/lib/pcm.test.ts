import { base64ToBytes, RmsMeter } from "./pcm";

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
});
