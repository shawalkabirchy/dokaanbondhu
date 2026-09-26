// Raw PCM from the recorder (spec 15.3): base64 16-bit little-endian mono samples, used exactly as recorded (no gain,
// no normalizing). RMS is measured on samples scaled to -1…1 (a sample divided by 32768), as on the server.

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = new Uint8Array(256);
for (let i = 0; i < B64.length; i++) LOOKUP[B64.charCodeAt(i)] = i;

export function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/[^A-Za-z0-9+/]/g, "");
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let out = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = LOOKUP[clean.charCodeAt(i)] ?? 0;
    const b = LOOKUP[clean.charCodeAt(i + 1)] ?? 0;
    const c = LOOKUP[clean.charCodeAt(i + 2)] ?? 0;
    const d = LOOKUP[clean.charCodeAt(i + 3)] ?? 0;
    if (out < bytes.length) bytes[out++] = (a << 2) | (b >> 4);
    if (out < bytes.length) bytes[out++] = ((b & 15) << 4) | (c >> 2);
    if (out < bytes.length) bytes[out++] = ((c & 3) << 6) | d;
  }
  return bytes;
}

/** Keeps a running sum of squares over every chunk of a turn. */
export class RmsMeter {
  private sumSquares = 0;
  private samples = 0;

  add(bytes: Uint8Array): void {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i + 1 < bytes.byteLength; i += 2) {
      const sample = view.getInt16(i, true) / 32768;
      this.sumSquares += sample * sample;
      this.samples++;
    }
  }

  get value(): number {
    return this.samples === 0 ? 0 : Math.sqrt(this.sumSquares / this.samples);
  }
}
