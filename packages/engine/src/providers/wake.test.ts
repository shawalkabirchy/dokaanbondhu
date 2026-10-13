import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StoredProviderRow } from "./chain";
import { recordProviderCall, speechHealth } from "./health";
import { wakeSpeech } from "./wake";

// Waking the speech worker (spec 13.4, D164) against a stub worker whose /health answers after a set delay, as Modal
// while it starts: one call however often it is asked, "waking" until it answers, and nothing to wake for ElevenLabs.

describe("speech wake", () => {
  let server: Server;
  let baseUrl: string;
  let delayMs = 0;
  let status = "ok";
  let calls = 0;
  const aesKey = randomBytes(32);
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === "/health") calls++;
      setTimeout(
        () => response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ status })),
        delayMs,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const row = (job: "stt" | "tts", overrides: Partial<StoredProviderRow> = {}): StoredProviderRow => ({
    id: `row-${job}`,
    shopId: null,
    job,
    provider: "speech_worker",
    model: null,
    priority: null,
    active: true,
    external: false,
    enabled: true,
    baseUrl,
    secretEncrypted: null,
    options: {},
    ...overrides,
  });

  it("calls a sleeping worker once, says waking until it answers, then ok", async () => {
    recordProviderCall("stt", false);
    recordProviderCall("tts", false);
    calls = 0;
    delayMs = 300;
    const used = { stt: row("stt"), tts: row("tts", { baseUrl: `${baseUrl}/` }) }; // one worker, two rows
    const first = wakeSpeech(used, aesKey, 50);
    const second = wakeSpeech(used, aesKey, 50);
    expect(await first).toBe("waking");
    expect(await second).toBe("waking");
    expect(speechHealth()).toBe("waking");
    await pause(400);
    expect(speechHealth()).toBe("ok");
    expect(calls).toBe(1);
  });

  it("only keeps an awake worker awake, never saying waking", async () => {
    calls = 0;
    delayMs = 300;
    const used = { stt: row("stt"), tts: row("tts") };
    expect(await wakeSpeech(used, aesKey, 50)).toBe("ok");
    expect(speechHealth()).toBe("ok");
    await pause(400);
    expect(calls).toBe(1);
  });

  it("answers ok at once when the worker is quick, and down when it does not say ok", async () => {
    delayMs = 0;
    recordProviderCall("stt", false);
    expect(await wakeSpeech({ stt: row("stt"), tts: null }, aesKey, 1000)).toBe("ok");
    status = "loading";
    expect(await wakeSpeech({ stt: row("stt"), tts: null }, aesKey, 1000)).toBe("down");
    status = "ok";
  });

  it("has nothing to wake for providers that never sleep", async () => {
    calls = 0;
    const eleven = { stt: row("stt", { provider: "elevenlabs" }), tts: null };
    await wakeSpeech(eleven, aesKey, 50);
    expect(calls).toBe(0);
  });
});
