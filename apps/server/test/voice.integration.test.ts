import { randomUUID } from "node:crypto";
import { readReplyStream, type ReplyEvent } from "@dokaanbondhu/contracts";
import { ASK_AGAIN } from "@dokaanbondhu/core";
import { aiProviders, createPlatform, messages, type Platform } from "@dokaanbondhu/platform-db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  allLocal,
  chatCall,
  createHostShop,
  disableConnection,
  EVAL_KEY,
  post,
  token,
  urls,
  useTestEnvironment,
  type HostShop,
} from "./harness";
import { startStubLlm, type StubLlm } from "./stub-llm";
import { fakeMp3, startStubSpeech, type StubSpeech } from "./stub-speech";

// Voice turns end to end (spec 8.4, 8.5, 9.1, 12.3): PCM chunks, finish, silence trim, the speech worker (a stub on a
// local port), the engine with a stub LLM and the CI copy of GearGrid, and spoken replies in sentence order.

const aesKey = useTestEnvironment();

/** PCM for stretches of [milliseconds, amplitude]: a 200 Hz tone stands in for speech, a faint one for silence. */
function clip(parts: [number, number][]): Uint8Array {
  const total = parts.reduce((sum, [ms]) => sum + ms * 16, 0);
  const pcm = new Uint8Array(total * 2);
  const view = new DataView(pcm.buffer);
  let at = 0;
  for (const [ms, amplitude] of parts) {
    for (let i = 0; i < ms * 16; i++, at++) {
      view.setInt16(at * 2, Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * 200 * at) / 16000)), true);
    }
  }
  return pcm;
}

const spoken = () =>
  clip([
    [1000, 0.002],
    [1200, 0.2],
    [1000, 0.002],
  ]);
const silent = () => clip([[2000, 0.002]]);

const split = (pcm: Uint8Array, size = 16_000) =>
  Array.from({ length: Math.ceil(pcm.byteLength / size) }, (_, i) => pcm.slice(i * size, (i + 1) * size));

describe.skipIf(!allLocal)("voice turns", () => {
  let admin: Platform;
  let llm: StubLlm;
  let speech: StubSpeech;
  let shop: HostShop;
  let routes: {
    conversations: { POST: unknown };
    chat: { POST: unknown };
    chunks: { POST: unknown };
    finish: { POST: unknown };
  };

  type Handler = (
    request: Request,
    context: { params: Promise<Record<string, string>> },
  ) => Promise<Response>;

  async function sendChunk(
    turnId: string,
    conversationId: string,
    seq: number,
    bytes: Uint8Array,
    auth?: string,
  ) {
    const request = new Request(
      `http://localhost:3100/api/v1/voice/turns/${turnId}/chunks?conversation_id=${conversationId}&seq=${seq}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          authorization: `Bearer ${await token(auth ?? shop.owner.auth)}`,
        },
        body: new Uint8Array(bytes),
      },
    );
    return (routes.chunks.POST as Handler)(request, { params: Promise.resolve({ turnId }) });
  }

  async function finish(
    turnId: string,
    conversationId: string,
    chunkCount: number,
    headers: Record<string, string> = {},
  ) {
    const request = new Request(`http://localhost:3100/api/v1/voice/turns/${turnId}/finish`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await token(shop.owner.auth)}`,
        ...headers,
      },
      body: JSON.stringify({
        conversation_id: conversationId,
        chunk_count: chunkCount,
        duration_ms: 3200,
        rms: 0.1,
      }),
    });
    const response = await (routes.finish.POST as Handler)(request, { params: Promise.resolve({ turnId }) });
    const events: ReplyEvent[] = [];
    if (response.headers.get("content-type")?.startsWith("application/x-ndjson")) {
      await readReplyStream(response.body!.getReader(), (event) => events.push(event));
    }
    const reply = events
      .filter((event): event is Extract<ReplyEvent, { type: "text" }> => event.type === "text")
      .map((event) => event.text)
      .join(" ");
    return { response, events, reply };
  }

  /** Sends a whole clip as chunks (in the given order) and finishes the turn. */
  async function say(pcm: Uint8Array, headers: Record<string, string> = {}, order?: number[]) {
    const conversationId = await newConversation();
    const turnId = randomUUID();
    const chunks = split(pcm);
    for (const seq of order ?? chunks.keys()) {
      expect((await sendChunk(turnId, conversationId, seq, chunks[seq]!)).status).toBe(204);
    }
    return { conversationId, ...(await finish(turnId, conversationId, chunks.length, headers)) };
  }

  async function newConversation(): Promise<string> {
    const response = await post(routes.conversations.POST, shop.owner.auth, { channel: "voice" });
    return ((await response.json()) as { conversation: { id: string } }).conversation.id;
  }

  const padsCall = {
    calls: [
      {
        name: "find_parts",
        arguments: { part_type: "ব্রেক প্যাড", vehicle: "এক্সিও", year: "২০১৪", position: "সামনের" },
      },
    ],
  };
  const padsQuestion = "এক্সিও ২০১৪-এর সামনের ব্রেক প্যাড আছে?";

  beforeAll(async () => {
    llm = await startStubLlm();
    speech = await startStubSpeech();
    admin = createPlatform(urls.admin, { max: 1 });
    shop = await createHostShop(admin, aesKey, llm.baseUrl, "Voice shop");
    await admin.withAdmin((tx) =>
      tx.insert(aiProviders).values([
        {
          shopId: shop.shopId,
          job: "stt",
          provider: "speech_worker",
          baseUrl: speech.baseUrl,
          active: true,
          external: false,
        },
        {
          shopId: shop.shopId,
          job: "tts",
          provider: "speech_worker",
          baseUrl: speech.baseUrl,
          active: true,
          external: false,
        },
        // the paid side (D98): chosen only with AI_LISTEN=api, never for evaluation requests
        {
          shopId: shop.shopId,
          job: "stt",
          provider: "elevenlabs",
          model: "scribe_v2",
          active: false, // one active speech row per shop and job; a side without one uses its first row
          external: true,
        },
      ]),
    );
    routes = {
      conversations: await import("../app/api/v1/conversations/route"),
      chat: await import("../app/api/v1/chat/messages/route"),
      chunks: await import("../app/api/v1/voice/turns/[turnId]/chunks/route"),
      finish: await import("../app/api/v1/voice/turns/[turnId]/finish/route"),
    };
  });

  beforeEach(() => {
    llm.script.length = 0;
    llm.received.length = 0;
    speech.asr.length = 0;
    speech.asrRequests.length = 0;
    speech.ttsTexts.length = 0;
    speech.ttsFails = false;
  });

  afterAll(async () => {
    await disableConnection(admin, shop.connectionId);
    const { hostPools } = await import("../src/server/host");
    await hostPools().closeAll();
    await llm.close();
    await speech.close();
  });

  it("answers a spoken question: the trimmed clip with keyterms, the transcript, then each sentence as text and audio", async () => {
    llm.script.push(padsCall);
    speech.asr.push({ text: padsQuestion, nbest: [padsQuestion, "এক্সিও ২০১৪-এর সামনের ব্রেক প্যার আছে?"] });
    const pcm = spoken();
    const { conversationId, response, events, reply } = await say(pcm, {}, [2, 0, 1, 3, 4, 5, 6]);
    expect(response.status).toBe(200);

    expect(events[0]).toMatchObject({ type: "status", label_key: "status.listening" });
    expect(events.find((event) => event.type === "transcript")).toMatchObject({ text: padsQuestion });
    expect(reply).toContain("এক্সিও ২০১৪-এর সামনের ব্রেক প্যাড দুই রকম আছে");
    // every sentence has its audio, in order, after its text
    const texts = events.filter(
      (event): event is Extract<ReplyEvent, { type: "text" }> => event.type === "text",
    );
    const audio = events.filter(
      (event): event is Extract<ReplyEvent, { type: "audio" }> => event.type === "audio",
    );
    expect(audio.map((event) => event.seq)).toEqual(texts.map((event) => event.seq));
    for (const event of audio) {
      expect(Buffer.from(event.data, "base64")).toEqual(fakeMp3(texts[event.seq]!.text));
      expect(events.indexOf(event)).toBeGreaterThan(events.indexOf(texts[event.seq]!));
    }
    const done = events.at(-1)!;
    expect(done).toMatchObject({ type: "done", state: "IDLE" });
    expect((done as { timings_ms: Record<string, number> }).timings_ms).toMatchObject({
      asr: expect.any(Number),
      first_audio: expect.any(Number),
    });

    // the speech worker got a WAV of the trimmed clip, the keyterms and N-best 5
    const sent = speech.asrRequests[0]!;
    expect(sent.riff).toBe(true);
    expect(sent.wavBytes).toBeLessThan(pcm.byteLength); // 1 s of silence cut on each side
    expect(sent.keyterms).toContain("ব্রেক প্যাড");
    expect(sent.nbest).toBe("5");
    expect(llm.received).toHaveLength(1);

    const saved = await admin.withAdmin((tx) =>
      tx
        .select()
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(messages.createdAt),
    );
    expect(saved[0]).toMatchObject({ role: "user", text: padsQuestion });
    expect((saved[0]!.meta as { voice: { asr: { nbest: string[] } } }).voice.asr.nbest).toHaveLength(2);
  });

  it("asks again without the LLM for a clip with no speech, an empty transcript or a failed speech-to-text", async () => {
    const quiet = await say(silent());
    expect(quiet.reply).toBe(ASK_AGAIN);
    expect(speech.asrRequests).toHaveLength(0); // no provider call at all
    expect(quiet.events.find((event) => event.type === "audio")).toMatchObject({ seq: 0 });

    speech.asr.push({ text: "" });
    const empty = await say(spoken());
    expect(empty.reply).toBe(ASK_AGAIN);

    speech.asr.push({ text: "", status: 503 });
    const broken = await say(spoken());
    expect(broken.events.find((event) => event.type === "error")).toMatchObject({
      code: "SPEECH_UNAVAILABLE",
      fatal: false,
    });
    expect(broken.reply).toBe(ASK_AGAIN);
    expect(llm.received).toHaveLength(0);
  });

  it("refuses missing chunks, another user's turn, a chunk over 64 KB and a turn over 30.5 s", async () => {
    const conversationId = await newConversation();
    const turnId = randomUUID();
    const chunks = split(spoken());
    await sendChunk(turnId, conversationId, 0, chunks[0]!);
    await sendChunk(turnId, conversationId, 1, chunks[1]!);
    const missing = await finish(turnId, conversationId, 3);
    expect(missing.response.status).toBe(409);
    expect(await missing.response.json()).toMatchObject({
      error: { code: "CHUNKS_MISSING", details: { missing: [2] } },
    });

    expect((await sendChunk(turnId, conversationId, 2, chunks[2]!, shop.staff.auth)).status).toBe(404);
    expect((await sendChunk(randomUUID(), conversationId, 0, new Uint8Array(65 * 1024))).status).toBe(413);

    const long = randomUUID();
    let status = 204;
    for (let seq = 0; seq < 16 && status === 204; seq++) {
      status = (await sendChunk(long, conversationId, seq, new Uint8Array(64 * 1024))).status;
    }
    expect(status).toBe(413);
  });

  it("speaks a chat reply when asked, from the cache the second time, and goes on as text when text-to-speech fails", async () => {
    // Replies no earlier test has spoken, so the server's audio cache does not hold them yet.
    const noah = async () => {
      llm.script.push({ calls: [{ name: "find_parts", arguments: { part_type: "self", vehicle: "noah" } }] });
      return chatCall(routes.chat.POST, shop.owner.auth, {
        conversation_id: await newConversation(),
        text: "noah er self ache?",
        speak: true,
      });
    };
    const first = await noah();
    expect(first.reply).toBe("কোন বছরের নোয়া?");
    expect(first.events.filter((event) => event.type === "audio")).toHaveLength(1);
    expect(speech.ttsTexts).toEqual(["কোন বছরের নোয়া?"]);
    const again = await noah();
    expect(again.events.filter((event) => event.type === "audio")).toHaveLength(1);
    expect(speech.ttsTexts).toHaveLength(1); // the same sentence comes from the cache

    speech.ttsFails = true;
    llm.script.push({ calls: [{ name: "resolve_customer", arguments: { name: "রহিম" } }] });
    speech.asr.push({ text: "রহিমের বাকি কত?" });
    const voice = await say(spoken());
    expect(voice.reply).toMatch(/নাকি/);
    expect(voice.events.filter((event) => event.type === "audio")).toHaveLength(0);
    expect(voice.events.filter((event) => event.type === "error")).toEqual([
      { type: "error", code: "TTS_UNAVAILABLE", message_key: "errors.TTS_UNAVAILABLE", fatal: false },
    ]);
    expect(voice.events.at(-1)).toMatchObject({ type: "done", state: "CLARIFYING" });
  });

  it("uses our own speech models for evaluation requests, whatever AI_LISTEN says (D98)", async () => {
    const cached = globalThis as { __dokaanServerEnv?: unknown };
    const before = process.env.AI_LISTEN;
    process.env.AI_LISTEN = "api";
    delete cached.__dokaanServerEnv;
    try {
      // the paid side is chosen, and it has no adapter yet: speech-to-text is unavailable
      const paid = await say(spoken());
      expect(paid.events.find((event) => event.type === "error")).toMatchObject({
        code: "SPEECH_UNAVAILABLE",
      });
      expect(speech.asrRequests).toHaveLength(0);

      speech.asr.push({ text: padsQuestion });
      llm.script.push(padsCall);
      const evaluation = await say(spoken(), { "x-eval-key": EVAL_KEY });
      expect(speech.asrRequests).toHaveLength(1);
      expect(evaluation.events.find((event) => event.type === "transcript")).toMatchObject({
        text: padsQuestion,
      });
    } finally {
      if (before === undefined) delete process.env.AI_LISTEN;
      else process.env.AI_LISTEN = before;
      delete cached.__dokaanServerEnv;
    }
  });
});
