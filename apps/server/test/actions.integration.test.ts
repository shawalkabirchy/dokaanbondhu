import { readReplyStream, type ReplyEvent } from "@dokaanbondhu/contracts";
import { formatTaka } from "@dokaanbondhu/core";
import { encryptSecret } from "@dokaanbondhu/engine/crypto";
import { importOpenApi, loadWriteHost, saveImport } from "@dokaanbondhu/engine/host";
import { undoAction } from "@dokaanbondhu/engine/write";
import {
  actionLogs,
  capabilities,
  capabilityParams,
  connections,
  conversations,
  createPlatform,
  type Platform,
} from "@dokaanbondhu/platform-db";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
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

// The write path through the server (spec 8.3, 9.9, 11.9; D136): a sale asked for in chat is confirmed, the action
// waits in action_logs, and the sheet's yes (or a spoken yes) saves it on the test host's API that the CI job starts
// on port 4000; no cancels it; the sheet refuses what it may not decide. Every sale is undone again, so the seed's
// balances and stock stay as the other test files expect them.

const aesKey = useTestEnvironment();
const apiUrl = process.env.GEARGRID_API_URL ?? "";
const seedKey = process.env.SEED_API_KEY ?? "";
const apiLocal = (() => {
  try {
    return ["localhost", "127.0.0.1"].includes(new URL(apiUrl).hostname) && seedKey.length > 0;
  } catch {
    return false;
  }
})();
if (process.env.CI === "true" && !apiLocal) throw new Error("these tests need the API the CI job starts");

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

const saleArgs = (style: "Bangla" | "Banglish") =>
  style === "Bangla"
    ? {
        customer: "রহিম মোটরস",
        items: [
          {
            part: {
              part_type: "ব্রেক প্যাড",
              vehicle: "এক্সিও",
              year: "২০১৪",
              position: "সামনের",
              quality: "নন-জেনুইন",
            },
            quantity: "দুই সেট",
          },
        ],
        payment: { method_word: "বাকিতে" },
      }
    : {
        customer: "Rahim Motors",
        items: [
          {
            part: {
              part_type: "brake pad",
              vehicle: "axio",
              year: "2014",
              position: "samner",
              quality: "non genuine",
            },
            quantity: "dui set",
          },
        ],
        payment: { method_word: "bakite" },
      };
const saleText = {
  Bangla: "রহিম মোটরসকে এক্সিও ২০১৪ সামনের নন-জেনুইন ব্রেক প্যাড দুই সেট বাকিতে দাও",
  Banglish: "Rahim Motors ke axio 2014 samner non genuine brake pad dui set bakite dao",
} as const;
const CONFIRMATION =
  "Rahim Motors — এক্সিও ২০১৪, সামনের ব্রেক প্যাড, নন-জেনুইন, ২ সেট, ৩,২০০ টাকা, বাকিতে। ঠিক আছে?";

describe.skipIf(!allLocal || !apiLocal)("actions through the server", () => {
  let admin: Platform;
  let llm: StubLlm;
  let shop: HostShop;
  const apiId = randomUUID();
  let routes: Record<"conversations" | "chat" | "decision", { POST: unknown }>;

  async function newConversation(auth = shop.owner.auth): Promise<string> {
    const response = await post(routes.conversations.POST, auth, { channel: "chat" });
    return ((await response.json()) as { conversation: { id: string } }).conversation.id;
  }

  /** POST /actions/{id}/decision, the reply read like a chat turn's. */
  async function decide(actionId: string, decision: "yes" | "no", auth = shop.owner.auth) {
    const request = new Request(`http://localhost:3100/api/v1/actions/${actionId}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${await token(auth)}` },
      body: JSON.stringify({ decision }),
    });
    const response = await (routes.decision.POST as Handler)(request, {
      params: Promise.resolve({ actionId }),
    });
    const events: ReplyEvent[] = [];
    if (response.headers.get("content-type")?.startsWith("application/x-ndjson"))
      await readReplyStream(response.body!.getReader(), (event) => events.push(event));
    const reply = events
      .filter((event): event is Extract<ReplyEvent, { type: "text" }> => event.type === "text")
      .map((event) => event.text)
      .join(" ");
    return { response, events, reply };
  }

  let rahimId = "";
  /** Rahim Motors' due as the host's API reads it. */
  async function due(): Promise<number> {
    const response = await fetch(new URL(`/api/v1/customers/${rahimId}`, apiUrl), {
      headers: { "x-api-key": seedKey },
    });
    return ((await response.json()) as { customer: { due_balance_taka: number } }).customer.due_balance_taka;
  }

  /** Asks for the sale in chat and returns its confirmation. */
  async function askSale(style: "Bangla" | "Banglish", conversationId: string) {
    llm.script.push({ calls: [{ name: "record_sale", arguments: saleArgs(style) }] });
    const asked = await chatCall(routes.chat.POST, shop.owner.auth, {
      conversation_id: conversationId,
      text: saleText[style],
    });
    const confirm = asked.events.find((event) => event.type === "confirm") as Extract<
      ReplyEvent,
      { type: "confirm" }
    >;
    return { ...asked, confirm };
  }

  /** Undoes a saved sale through the host, so the seed stays as the other files expect it. */
  async function undoSale(actionId: string) {
    const { platform } = await import("../src/server/singletons");
    const [row] = await admin.withAdmin((tx) =>
      tx.select().from(actionLogs).where(eq(actionLogs.id, actionId)),
    );
    const writes = await platform().withShop(shop.shopId, (tx) => loadWriteHost(tx, aesKey));
    const undone = await undoAction({
      capability: writes!.all.find((item) => item.id === row!.capabilityId)!,
      done: { response: row!.response, preview: row!.preview as never },
      host: writes!.host,
      actingUser: "Owner",
      idempotencyKey: randomUUID(),
    });
    expect(undone).toMatchObject({ status: "undone" });
  }

  beforeAll(async () => {
    llm = await startStubLlm();
    admin = createPlatform(urls.admin, { max: 1 });
    shop = await createHostShop(admin, aesKey, llm.baseUrl, "Action shop");
    const document = await (await fetch(new URL("/api/openapi.json", apiUrl))).json();
    const imported = importOpenApi(document);
    await admin.withAdmin(async (tx) => {
      await tx.insert(connections).values({
        id: apiId,
        shopId: shop.shopId,
        kind: "api",
        label: "Shop API",
        baseUrl: apiUrl,
        authType: "api_key",
        authHeader: "X-Api-Key",
        sslMode: null,
        status: "active",
        features: imported.features,
        featuresConfirmedAt: new Date(),
        secretEncrypted: encryptSecret(
          aesKey,
          { table: "connections", rowId: apiId, column: "secret_encrypted" },
          seedKey,
        ),
      });
      await saveImport(tx, shop.shopId, apiId, imported);
      // As setup leaves it after the sandbox check: the sale and the payment verified, confirmed and switched on.
      const enabled = await tx
        .update(capabilities)
        .set({ enabled: true, verifiedAt: new Date() })
        .where(
          and(
            eq(capabilities.connectionId, apiId),
            inArray(capabilities.name, ["record_sale", "receive_payment"]),
          ),
        )
        .returning({ id: capabilities.id });
      await tx
        .update(capabilityParams)
        .set({ confirmed: true })
        .where(
          inArray(
            capabilityParams.capabilityId,
            enabled.map((row) => row.id),
          ),
        );
    });
    const { shopHost } = await import("../src/server/host");
    rahimId = (await shopHost(shop.shopId)).host.catalog.customers.find(
      (item) => item.name === "Rahim Motors",
    )!.hostId;
    routes = {
      conversations: await import("../app/api/v1/conversations/route"),
      chat: await import("../app/api/v1/chat/messages/route"),
      decision: await import("../app/api/v1/actions/[actionId]/decision/route"),
    };
  });

  beforeEach(() => {
    llm.script.length = 0;
    llm.received.length = 0;
    (globalThis as { __dokaanRateLimiter?: unknown }).__dokaanRateLimiter = undefined;
  });

  afterAll(async () => {
    await disableConnection(admin, shop.connectionId);
    await disableConnection(admin, apiId);
    const { hostPools } = await import("../src/server/host");
    await hostPools().closeAll();
    await llm.close();
  });

  it("offers the switched-on writes as tools, never an undo action (D52), and confirms a sale it waits on (Bangla)", async () => {
    const conversationId = await newConversation();
    const before = await due();
    const { reply, confirm, events } = await askSale("Bangla", conversationId);
    const offered = (llm.received[0]?.tools ?? []).map((tool) => tool.function.name);
    expect(offered).toEqual(expect.arrayContaining(["record_sale", "receive_payment"]));
    expect(offered).not.toContain("void_sale");
    expect(offered).not.toContain("stock_in"); // not switched on
    expect(reply).toBe(CONFIRMATION);
    expect(events.at(-1)).toMatchObject({ type: "done", state: "CONFIRMING" });
    const [row] = await admin.withAdmin((tx) =>
      tx.select().from(actionLogs).where(eq(actionLogs.id, confirm.action_id)),
    );
    expect(row).toMatchObject({ status: "pending", userId: shop.owner.id, conversationId });
    expect(row!.request).toMatchObject({
      method: "POST",
      path: "/api/v1/sales",
      body: { customer_id: rahimId },
    });
    expect(await due()).toBe(before); // nothing is saved before yes

    const yes = await decide(confirm.action_id, "yes");
    expect(yes.response.status).toBe(200);
    expect(yes.events.find((event) => event.type === "action_result")).toMatchObject({
      action_id: confirm.action_id,
      status: "done",
      undo_available: true,
    });
    expect(yes.reply).toBe(
      `হয়ে গেছে। Rahim Motors-এর মোট বাকি এখন ${formatTaka(BigInt(before + 3200))} টাকা। ব্রেক প্যাড B-3 তাকে আছে।`,
    );
    expect(await due()).toBe(before + 3200);
    const [saved] = await admin.withAdmin((tx) =>
      tx.select().from(actionLogs).where(eq(actionLogs.id, confirm.action_id)),
    );
    expect(saved).toMatchObject({ status: "done", verifyStatus: "ok" });
    expect(saved!.confirmedAt).toBeInstanceOf(Date);
    expect(saved!.doneAt).toBeInstanceOf(Date);
    const [conversation] = await admin.withAdmin((tx) =>
      tx.select().from(conversations).where(eq(conversations.id, conversationId)),
    );
    expect(conversation!.state).toBe("IDLE");

    expect((await decide(confirm.action_id, "yes")).response.status).toBe(409); // decided already
    await undoSale(confirm.action_id);
    expect(await due()).toBe(before);
  });

  it("saves a sale on a spoken yes in chat (Banglish)", async () => {
    const conversationId = await newConversation();
    const before = await due();
    const { reply, confirm } = await askSale("Banglish", conversationId);
    expect(reply).toBe(CONFIRMATION);
    const yes = await chatCall(routes.chat.POST, shop.owner.auth, {
      conversation_id: conversationId,
      text: "ha",
    });
    expect(yes.events.find((event) => event.type === "action_result")).toMatchObject({ status: "done" });
    expect(await due()).toBe(before + 3200);
    await undoSale(confirm.action_id);
    expect(await due()).toBe(before);
  });

  it.each(["Bangla", "Banglish"] as const)(
    "no on the sheet cancels the sale and nothing is saved (%s)",
    async (style) => {
      const conversationId = await newConversation();
      const before = await due();
      const { confirm } = await askSale(style, conversationId);
      const no = await decide(confirm.action_id, "no");
      expect(no.reply).toBe("বাতিল করা হয়েছে, কিছু সেভ হয়নি।");
      expect(no.events.find((event) => event.type === "action_result")).toMatchObject({
        status: "cancelled",
      });
      const [row] = await admin.withAdmin((tx) =>
        tx.select().from(actionLogs).where(eq(actionLogs.id, confirm.action_id)),
      );
      expect(row!.status).toBe("cancelled");
      expect(await due()).toBe(before);
    },
  );

  it("refuses another user's action, and an expired one", async () => {
    const conversationId = await newConversation();
    const { confirm } = await askSale("Bangla", conversationId);
    const other = await decide(confirm.action_id, "yes", shop.staff.auth);
    expect(other.response.status).toBe(404);
    await admin.withAdmin((tx) =>
      tx
        .update(actionLogs)
        .set({ createdAt: new Date(Date.now() - 2 * 60_000) })
        .where(eq(actionLogs.id, confirm.action_id)),
    );
    const late = await decide(confirm.action_id, "yes");
    expect(late.response.status).toBe(409);
    expect(((await late.response.json()) as { error: { code: string } }).error.code).toBe("ACTION_EXPIRED");
    const [row] = await admin.withAdmin((tx) =>
      tx.select().from(actionLogs).where(eq(actionLogs.id, confirm.action_id)),
    );
    expect(row!.status).toBe("cancelled");
  });
});
