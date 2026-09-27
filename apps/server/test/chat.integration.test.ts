import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readReplyStream, type ReplyEvent } from "@dokaanbondhu/contracts";
import { CANNOT_ANSWER_NOW, SEE_IN_APP } from "@dokaanbondhu/core";
import { encryptSecret } from "@dokaanbondhu/engine/crypto";
import { confirmEntity, HostPools, syncConnection } from "@dokaanbondhu/engine/host";
import {
  aiProviders,
  connections,
  conversations,
  createPlatform,
  messages,
  requestFrames,
  shops,
  users,
  type Platform,
} from "@dokaanbondhu/platform-db";
import { eq, sql } from "drizzle-orm";
import { SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { geargridMap } from "../../../packages/engine/test/geargrid-map";

// The chat endpoints end to end (spec 8.3, 8.5): the server, the platform DB and the CI copy of GearGrid, with an
// OpenAI-compatible stub LLM on a local port, so the adapter, the NDJSON stream and what is saved are all real.

const SUPABASE_URL = "http://localhost:54321";
const JWT_SECRET = "server-test-secret-0123456789";
const EVAL_KEY = "eval-key-for-integration-tests";
const urls = {
  api: process.env.PLATFORM_DATABASE_URL ?? "",
  admin: process.env.PLATFORM_ADMIN_DATABASE_URL ?? "",
  host: process.env.MIGRATION_DATABASE_URL ?? "",
};
const isLocal = (url: string) => {
  try {
    return ["localhost", "127.0.0.1"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
};
const allLocal = isLocal(urls.api) && isLocal(urls.admin) && isLocal(urls.host);
if (process.env.CI === "true" && !allLocal)
  throw new Error("chat integration tests need the local CI databases");

const aesKey = randomBytes(32);
Object.assign(process.env, {
  SUPABASE_URL,
  SUPABASE_SECRET_KEY: "sb_secret_fake_for_integration_tests",
  AES_KEY: aesKey.toString("base64"),
  JWT_TEST_SECRET: JWT_SECRET,
  EVAL_MODE_SECRET: EVAL_KEY,
});

const token = (authUserId: string) =>
  new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(authUserId)
    .setIssuer(`${SUPABASE_URL}/auth/v1`)
    .setAudience("authenticated")
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(JWT_SECRET));

// The stub LLM answers each request with the next scripted step as a streamed chat completion; with no step left it
// answers 500, which the fallback chain treats as a failed provider.
interface Step {
  text?: string;
  calls?: { name: string; arguments: Record<string, unknown> }[];
}
const script: Step[] = [];
const received: { tools?: { function: { name: string } }[]; stream?: boolean; messages: unknown[] }[] = [];

function stubLlm(): Server {
  return createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      received.push(JSON.parse(body) as (typeof received)[number]);
      const step = script.shift();
      if (!step) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "no scripted step" } }));
        return;
      }
      const base = { id: "stub", object: "chat.completion.chunk", created: 0, model: "stub" };
      const chunk = (delta: object, finish: string | null = null) => ({
        ...base,
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
      const chunks = [chunk({ role: "assistant" })];
      if (step.text) chunks.push(chunk({ content: step.text }));
      step.calls?.forEach((call, index) =>
        chunks.push(
          chunk({
            tool_calls: [
              {
                index,
                id: `call_${index}`,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              },
            ],
          }),
        ),
      );
      chunks.push(chunk({}, step.calls?.length ? "tool_calls" : "stop"));
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const item of chunks) response.write(`data: ${JSON.stringify(item)}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
}

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

describe.skipIf(!allLocal)("chat endpoints", () => {
  let admin: Platform;
  let llm: Server;
  let routes: { conversations: { POST: unknown }; chat: { POST: unknown } };
  const shopId = randomUUID();
  const owner = { id: randomUUID(), auth: randomUUID() };
  const staff = { id: randomUUID(), auth: randomUUID() };
  const connectionId = randomUUID();

  async function post(handler: unknown, auth: string, body: unknown, headers: Record<string, string> = {}) {
    const request = new Request("http://localhost:3100/api/v1/test", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await token(auth)}`,
        ...headers,
      },
      body: JSON.stringify(body),
    });
    return (handler as Handler)(request, { params: Promise.resolve({}) });
  }

  async function newConversation(auth = owner.auth): Promise<string> {
    const response = await post(routes.conversations.POST, auth, { channel: "chat" });
    expect(response.status).toBe(201);
    return ((await response.json()) as { conversation: { id: string } }).conversation.id;
  }

  async function chat(body: Record<string, unknown>, headers: Record<string, string> = {}) {
    const response = await post(routes.chat.POST, owner.auth, body, headers);
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

  beforeAll(async () => {
    llm = stubLlm();
    await new Promise<void>((resolve) => llm.listen(0, "127.0.0.1", resolve));
    const port = (llm.address() as AddressInfo).port;
    admin = createPlatform(urls.admin, { max: 1 });
    const host = new URL(urls.host);
    await admin.withAdmin(async (tx) => {
      await tx.insert(shops).values({ id: shopId, name: "Chat shop", ownerUserId: owner.id });
      await tx.insert(users).values([
        { id: owner.id, shopId, authUserId: owner.auth, name: "Owner", email: "chat-owner@t", role: "owner" },
        { id: staff.id, shopId, authUserId: staff.auth, name: "Staff", email: "chat-staff@t", role: "staff" },
      ]);
      await tx.insert(aiProviders).values({
        shopId,
        job: "llm",
        provider: "vllm",
        model: "stub",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        priority: 1,
        external: false,
      });
      await tx.insert(connections).values({
        id: connectionId,
        shopId,
        kind: "db",
        dialect: "postgres",
        host: host.hostname,
        port: Number(host.port || 5432),
        database: host.pathname.slice(1),
        username: "dokaanbondhu_ro",
        sslMode: "disable",
        status: "active",
        secretEncrypted: encryptSecret(
          aesKey,
          { table: "connections", rowId: connectionId, column: "secret_encrypted" },
          process.env.DOKAAN_RO_PASSWORD ?? "",
        ),
      });
    });
    for (const entity of Object.values(geargridMap.entities)) {
      if (entity) await admin.withAdmin((tx) => confirmEntity(tx, shopId, connectionId, entity, owner.id));
    }
    const pools = new HostPools();
    try {
      await syncConnection((fn) => admin.withAdmin(fn), pools, aesKey, shopId, connectionId);
    } finally {
      await pools.closeAll();
    }
    routes = {
      conversations: await import("../app/api/v1/conversations/route"),
      chat: await import("../app/api/v1/chat/messages/route"),
    };
  });

  beforeEach(() => {
    script.length = 0;
    received.length = 0;
  });

  afterAll(async () => {
    // The CI database is thrown away after the job; the connection is only switched off, so a catalog sync running
    // in another test file at the same time never meets a half-deleted shop.
    await admin.withAdmin((tx) =>
      tx.update(connections).set({ status: "disabled" }).where(eq(connections.id, connectionId)),
    );
    const { hostPools } = await import("../src/server/host");
    await hostPools().closeAll();
    await new Promise((resolve) => llm.close(resolve));
  });

  it("answers a parts question as an NDJSON stream, with the tools offered, and saves the turn", async () => {
    const conversationId = await newConversation();
    const phrased =
      "এক্সিও ২০১৪-এর সামনের প্যাড দুই রকম আছে: জেনুইন ৩ সেট, ৪,৫০০ টাকা; নন-জেনুইন ৬ সেট, ১,৮০০ টাকা। দুটোই B-3 তাকে।";
    script.push(
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
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(events[0]).toMatchObject({ type: "status", state: "UNDERSTANDING" });
    expect(events.find((event) => event.type === "cards")).toMatchObject({ parts: [{}, {}] });
    expect(reply).toBe(phrased);
    const done = events.at(-1)!;
    expect(done).toMatchObject({ type: "done", state: "IDLE" });
    expect(done).not.toHaveProperty("trace"); // only with the evaluation key

    expect(received[0]?.stream).toBe(true);
    expect(received[0]?.tools?.map((tool) => tool.function.name)).toEqual([
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
    script.push({ calls: [{ name: "find_parts", arguments: { part_type: "সেলফ", vehicle: "নোয়া" } }] });
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
    expect(received).toHaveLength(1); // the tap was answered without a second LLM call
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
    script.push({ calls: [{ name: "get_report", arguments: { name: "profit_loss" } }] });
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
    const staffConversation = await newConversation(staff.auth);
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
