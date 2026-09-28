import type { ReplyEvent } from "@dokaanbondhu/contracts";
import { CANNOT_ANSWER_NOW, SEE_IN_APP } from "@dokaanbondhu/core";
import {
  conversations,
  createPlatform,
  messages,
  requestFrames,
  type Platform,
} from "@dokaanbondhu/platform-db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  allLocal,
  chatCall,
  createHostShop,
  disableConnection,
  EVAL_KEY,
  post,
  urls,
  useTestEnvironment,
  type HostShop,
} from "./harness";
import { startStubLlm, type StubLlm } from "./stub-llm";

// The chat endpoints end to end (spec 8.3, 8.5): the server, the platform DB and the CI copy of GearGrid, with an
// OpenAI-compatible stub LLM on a local port, so the adapter, the NDJSON stream and what is saved are all real.

const aesKey = useTestEnvironment();

describe.skipIf(!allLocal)("chat endpoints", () => {
  let admin: Platform;
  let llm: StubLlm;
  let shop: HostShop;
  let routes: { conversations: { POST: unknown }; chat: { POST: unknown } };

  async function newConversation(auth = shop.owner.auth): Promise<string> {
    const response = await post(routes.conversations.POST, auth, { channel: "chat" });
    expect(response.status).toBe(201);
    return ((await response.json()) as { conversation: { id: string } }).conversation.id;
  }

  const chat = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    chatCall(routes.chat.POST, shop.owner.auth, body, headers);

  beforeAll(async () => {
    llm = await startStubLlm();
    admin = createPlatform(urls.admin, { max: 1 });
    shop = await createHostShop(admin, aesKey, llm.baseUrl, "Chat shop");
    routes = {
      conversations: await import("../app/api/v1/conversations/route"),
      chat: await import("../app/api/v1/chat/messages/route"),
    };
  });

  beforeEach(() => {
    llm.script.length = 0;
    llm.received.length = 0;
  });

  afterAll(async () => {
    await disableConnection(admin, shop.connectionId);
    const { hostPools } = await import("../src/server/host");
    await hostPools().closeAll();
    await llm.close();
  });

  it("answers a parts question as an NDJSON stream, with the tools offered, and saves the turn", async () => {
    const conversationId = await newConversation();
    const phrased =
      "এক্সিও ২০১৪-এর সামনের প্যাড দুই রকম আছে: জেনুইন ৩ সেট, ৪,৫০০ টাকা; নন-জেনুইন ৬ সেট, ১,৮০০ টাকা। দুটোই B-3 তাকে।";
    llm.script.push(
      {
        calls: [
          {
            name: "find_parts",
            arguments: {
              part_type: "সামনের ব্রেক প্যাড",
              vehicle: "এক্সিও",
              year: "২০১৪",
              position: "সামনের",
            },
          },
        ],
      },
      { text: phrased },
    );
    const { response, events, reply } = await chat({
      conversation_id: conversationId,
      text: "এক্সিও ২০১৪-এর সামনের ব্রেক প্যাড আছে?",
    });
    expect(response.status).toBe(200);
    if (!events.some((event) => event.type === "cards")) {
      // Diagnostic: what the stub received and why the chain gave up (messages.meta.fallbacks).
      const saved = await admin.withAdmin((tx) =>
        tx.select().from(messages).where(eq(messages.conversationId, conversationId)),
      );
      console.warn("DIAG received", llm.received.length, "events", JSON.stringify(events).slice(0, 600));
      console.warn("DIAG meta", JSON.stringify(saved.map((message) => message.meta)));
    }
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(events[0]).toMatchObject({ type: "status", state: "UNDERSTANDING" });
    expect(events.find((event) => event.type === "cards")).toMatchObject({ parts: [{}, {}] });
    expect(reply).toBe(phrased);
    const done = events.at(-1)!;
    expect(done).toMatchObject({ type: "done", state: "IDLE" });
    expect(done).not.toHaveProperty("trace"); // only with the evaluation key

    expect(llm.received[0]?.stream).toBe(true);
    expect(llm.received[0]?.tools?.map((tool) => tool.function.name)).toEqual([
      "find_parts",
      "run_read_query",
      "get_report",
      "resolve_customer",
      "ask_user",
    ]);

    const saved = await admin.withAdmin(async (tx) => ({
      messages: await tx
        .select()
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(messages.createdAt),
      conversation: (await tx.select().from(conversations).where(eq(conversations.id, conversationId)))[0],
    }));
    expect(saved.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(saved.messages[1]).toMatchObject({ text: phrased, meta: { llm_calls: 2, grounding_failures: 0 } });
    expect(saved.conversation).toMatchObject({
      state: "IDLE",
      context: { vehicle: { model: "Toyota Axio", year: 2014 } },
    });
  });

  it("asks the year with chips, keeps the question across requests, and answers the tapped chip without the LLM", async () => {
    const conversationId = await newConversation();
    llm.script.push({ calls: [{ name: "find_parts", arguments: { part_type: "সেলফ", vehicle: "নোয়া" } }] });
    const first = await chat({ conversation_id: conversationId, text: "নোয়ার সেলফ আছে?" });
    expect(first.reply).toBe("কোন বছরের নোয়া?");
    const choices = first.events.find((event) => event.type === "choices") as Extract<
      ReplyEvent,
      { type: "choices" }
    >;
    const newest = choices.options.find((option) => option.label === "2014–2021")!;
    expect(first.events.at(-1)).toMatchObject({ type: "done", state: "CLARIFYING" });

    const second = await chat({
      conversation_id: conversationId,
      choice: { slot: "year", option_id: newest.id },
    });
    expect(llm.received).toHaveLength(1); // the tap was answered without a second LLM call
    expect(second.reply).toContain("নোয়া ২০১৪-এর");
    expect(second.events.at(-1)).toMatchObject({ type: "done", state: "IDLE" });

    const saved = await admin.withAdmin(async (tx) => ({
      frames: await tx.select().from(requestFrames).where(eq(requestFrames.conversationId, conversationId)),
      messages: await tx
        .select()
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(messages.createdAt),
    }));
    expect(saved.frames).toHaveLength(1);
    expect(saved.frames[0]).toMatchObject({
      intent: "find_parts",
      status: "done",
      request: "নোয়ার সেলফ আছে?",
    });
    expect(saved.messages.map((message) => message.text)).toContain("2014–2021");
  });

  it("sends profit to the app, gives the trace only with the evaluation key, and says so when the LLM is down", async () => {
    const conversationId = await newConversation();
    llm.script.push({ calls: [{ name: "get_report", arguments: { name: "profit_loss" } }] });
    const profit = await chat(
      { conversation_id: conversationId, text: "এই মাসে লাভ কত?" },
      { "x-eval-key": EVAL_KEY },
    );
    expect(profit.reply).toBe(SEE_IN_APP);
    expect(profit.events.at(-1)).toMatchObject({
      type: "done",
      trace: { tool_calls: [{ name: "get_report", result: "see_in_app" }] },
    });

    const outage = await chat({ conversation_id: conversationId, text: "এক্সিওর প্যাড আছে?" });
    expect(outage.reply).toBe(CANNOT_ANSWER_NOW);
    expect(outage.events.at(-1)).toMatchObject({ type: "done", state: "IDLE" });
  });

  it("refuses another user's conversation and a message with neither text nor choice", async () => {
    const staffConversation = await newConversation(shop.staff.auth);
    const other = await chat({ conversation_id: staffConversation, text: "হ্যালো" });
    expect(other.response.status).toBe(404);
    expect(await other.response.json()).toMatchObject({ error: { code: "CONVERSATION_NOT_FOUND" } });
    const empty = await chat({ conversation_id: staffConversation });
    expect(empty.response.status).toBe(400);
    const count = await admin.withAdmin((tx) =>
      tx.execute(sql`select count(*)::int as n from messages where conversation_id = ${staffConversation}`),
    );
    expect(count.rows[0]).toMatchObject({ n: 0 });
  });
});
