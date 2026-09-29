import type { WordsView } from "@dokaanbondhu/contracts";
import { runSpeechCheck } from "@dokaanbondhu/engine/host";
import { aiProviders, aliases, createPlatform, speechChecks, type Platform } from "@dokaanbondhu/platform-db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  allLocal,
  chatCall,
  createHostShop,
  disableConnection,
  post,
  token,
  urls,
  useTestEnvironment,
  type HostShop,
} from "./harness";
import { startStubLlm, type StubLlm } from "./stub-llm";
import { startStubSpeech, type StubSpeech } from "./stub-speech";

// How each shop learns its own words (D102), end to end: the listening check with a stub speech worker that writes
// names the way speech-to-text splits them, and words learned from answered questions, offered in setup and added
// by the owner. Bangla and Banglish alike (D96).

const aesKey = useTestEnvironment();

describe.skipIf(!allLocal)("words the assistant learns", () => {
  let admin: Platform;
  let llm: StubLlm;
  let speech: StubSpeech;
  let shop: HostShop;
  let routes: {
    conversations: { POST: unknown };
    chat: { POST: unknown };
    words: { GET: unknown };
    word: { PUT: unknown };
  };

  type Handler = (
    request: Request,
    context: { params: Promise<Record<string, string>> },
  ) => Promise<Response>;

  async function call(handler: unknown, method: string, path: string, body?: unknown, params = {}) {
    const request = new Request(`http://localhost:3100/api/v1${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await token(shop.owner.auth)}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const response = await (handler as Handler)(request, { params: Promise.resolve(params) });
    return { status: response.status, body: (await response.json()) as { words: WordsView } };
  }

  async function newConversation(): Promise<string> {
    const response = await post(routes.conversations.POST, shop.owner.auth, { channel: "chat" });
    return ((await response.json()) as { conversation: { id: string } }).conversation.id;
  }

  const chat = (conversationId: string, text: string) =>
    chatCall(routes.chat.POST, shop.owner.auth, { conversation_id: conversationId, text });

  beforeAll(async () => {
    llm = await startStubLlm();
    speech = await startStubSpeech();
    admin = createPlatform(urls.admin, { max: 1 });
    shop = await createHostShop(admin, aesKey, llm.baseUrl, "Words shop");
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
      ]),
    );
    routes = {
      conversations: await import("../app/api/v1/conversations/route"),
      chat: await import("../app/api/v1/chat/messages/route"),
      words: await import("../app/api/v1/setup/words/route"),
      word: await import("../app/api/v1/setup/words/[id]/route"),
    };
  });

  beforeEach(() => {
    llm.script.length = 0;
    llm.received.length = 0;
    speech.asrEcho = null;
  });

  afterAll(async () => {
    await disableConnection(admin, shop.connectionId);
    const { hostPools } = await import("../src/server/host");
    await hostPools().closeAll();
    await llm.close();
    await speech.close();
  });

  it("the listening check suggests what the matcher would miss, checks each name once, and adds nothing until the owner does (D102 A, D105)", async () => {
    // Speech-to-text writes "এক্সিও" as "এক্সেও" (the matcher understands that anyway), "ডায়নামো" as "ডায়ালাম"
    // (which it would miss), and every other name as said.
    speech.asrEcho = (spoken) => {
      const name = spoken.replace(/ আছে\?$/, "");
      if (name === "এক্সিও") return ["এক্সেও আছে", "এক্সিও আছে"];
      if (name === "ডায়নামো") return ["ডায়ালাম আছে", "ডায়ালাম আছি"];
      return [`${name} আছে`];
    };
    const withAdmin = <T>(fn: Parameters<Platform["withAdmin"]>[0]) => admin.withAdmin(fn) as Promise<T>;
    const first = await runSpeechCheck(withAdmin, aesKey, shop.shopId, shop.connectionId, { limit: 200 });
    expect(first.checked).toBeGreaterThan(10);
    expect(first.suggested).toBe(1);
    // Motorcycles without a Bangla word need one from the LLM, which is down here: they wait for the next run.
    expect(first.left).toBe(first.skipped);
    expect(first.stopped).toBeUndefined();
    const checked = await admin.withAdmin((tx) =>
      tx.select().from(speechChecks).where(eq(speechChecks.shopId, shop.shopId)),
    );
    expect(checked).toHaveLength(first.checked);
    const again = await runSpeechCheck(withAdmin, aesKey, shop.shopId, shop.connectionId, { limit: 200 });
    expect(again).toMatchObject({ checked: 0, suggested: 0 }); // each name once

    // Nothing is a word yet: the owner sees the suggestion at once, and adds it.
    const words = await admin.withAdmin((tx) =>
      tx
        .select()
        .from(aliases)
        .where(and(eq(aliases.shopId, shop.shopId), eq(aliases.source, "asr_check"))),
    );
    expect(words).toEqual([]);
    const listed = (await call(routes.words.GET, "GET", "/setup/words")).body.words;
    const suggestion = listed.suggestions.find((word) => word.heard === "ডায়ালাম")!;
    expect(suggestion).toMatchObject({ concept: "part_type", value: "Alternator", origin: "listening" });
    expect(listed.checked).toEqual({ names: first.checked, words: 1 });
    await call(
      routes.word.PUT,
      "PUT",
      `/setup/words/${suggestion.id}`,
      { action: "add" },
      { id: suggestion.id },
    );
    const added = await admin.withAdmin((tx) =>
      tx
        .select()
        .from(aliases)
        .where(and(eq(aliases.shopId, shop.shopId), eq(aliases.source, "asr_check"))),
    );
    expect(added.map((row) => [row.aliasText, row.targetValue])).toEqual([["ডায়ালাম", "Alternator"]]);

    // Now a request with the word finds the part: the question is the car, not the part.
    llm.script.push({ calls: [{ name: "find_parts", arguments: { part_type: "ডায়ালাম" } }] });
    const turn = await chat(await newConversation(), "ডায়ালাম আছে?");
    expect(turn.reply).toBe("কোন গাড়ির?");
  });

  it.each([
    {
      style: "Bangla",
      text: "নৌকার সেলফ আছে?",
      heard: "নৌকা",
      part: "সেলফ",
      answer: "নোয়া",
      value: "Toyota Noah",
    },
    // A different car: once "নৌকা" is Noah's word, Banglish "nouka" sounds the same and is understood at once.
    // "rayas" is how speech-to-text wrote Prius in the first live listening check.
    {
      style: "Banglish",
      text: "rayas er brake pad ache?",
      heard: "rayas",
      part: "brake pad",
      answer: "prius",
      value: "Toyota Prius",
    },
  ])(
    "learns a car name from answered questions, offers it in setup once seen twice, and the owner adds it (D102 B; $style)",
    async ({ text, heard, part, answer, value }) => {
      const ask = async () => {
        const conversationId = await newConversation();
        llm.script.push({ calls: [{ name: "find_parts", arguments: { part_type: part, vehicle: heard } }] });
        const first = await chat(conversationId, text);
        expect(first.reply).toBe("কোন গাড়ির?");
        const second = await chat(conversationId, answer);
        expect(second.reply).not.toBe("কোন গাড়ির?"); // the answer resolved the car
      };

      await ask();
      expect((await call(routes.words.GET, "GET", "/setup/words")).body.words.suggestions).toEqual([]); // once only
      await ask();
      const listed = (await call(routes.words.GET, "GET", "/setup/words")).body.words;
      const suggestion = listed.suggestions.find((word) => word.heard === heard)!;
      expect(suggestion).toMatchObject({ concept: "vehicle_model", value, origin: "answers", seen: 2 });

      const decided = await call(
        routes.word.PUT,
        "PUT",
        `/setup/words/${suggestion.id}`,
        { action: "add" },
        {
          id: suggestion.id,
        },
      );
      expect(decided.status).toBe(200);
      expect(
        decided.body.words.suggestions.find((word: { heard: string }) => word.heard === heard),
      ).toBeUndefined();

      // Next time the name is understood at once: the car is not asked again.
      llm.script.push({ calls: [{ name: "find_parts", arguments: { part_type: part, vehicle: heard } }] });
      const after = await chat(await newConversation(), text);
      expect(after.reply).not.toBe("কোন গাড়ির?");
    },
  );

  it("refuses a decision on an unknown word or an unknown action", async () => {
    const unknown = "00000000-0000-4000-8000-000000000000";
    expect(
      (await call(routes.word.PUT, "PUT", `/setup/words/${unknown}`, { action: "dismiss" }, { id: unknown }))
        .status,
    ).toBe(404);
    expect(
      (await call(routes.word.PUT, "PUT", "/setup/words/x", { action: "maybe" }, { id: unknown })).status,
    ).toBe(400);
  });
});
