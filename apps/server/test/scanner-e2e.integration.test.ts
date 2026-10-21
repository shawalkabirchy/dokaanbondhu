import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  readReplyStream,
  scannerSummarySchema,
  type ReplyEvent,
  type ScannerSummary,
} from "@dokaanbondhu/contracts";
import { encryptSecret } from "@dokaanbondhu/engine/crypto";
import {
  applyVerification,
  callHost,
  confirmEntity,
  HostPools,
  importScannerSummary,
  readCatalog,
  syncConnection,
  toCatalog,
  type ApiConnection,
  type HostDb,
} from "@dokaanbondhu/engine/host";
import { verifyCapabilities, writeHostOf } from "@dokaanbondhu/engine/write";
import {
  actionLogs,
  aiProviders,
  capabilities,
  capabilityParams,
  connections,
  createPlatform,
  shops,
  users,
  type Platform,
} from "@dokaanbondhu/platform-db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { shopBMap } from "../../../packages/engine/test/shop-b-map";
import { chatCall, post, token, urls, useTestEnvironment } from "./harness";
import { startStubLlm, type StubLlm } from "./stub-llm";

// The Laravel scanner end to end (spec 16.4, 20 step 7; D182): the scanner runs inside the test backend's folder
// (tools/laravel-scanner/test-backend, a Laravel app over test shop B's MySQL tables) and uploads its summary with a
// one-time token; the summary's sale becomes a capability, the sandbox check passes it against the app through the
// session sign-in, the owner switches it on, and a sale asked for in chat (Bangla and Banglish) is saved in the app's
// MySQL and undone again. Run by run-e2e.sh on the laptop only: skipped unless the test backend is up.

const aesKey = useTestEnvironment();
const backend = process.env.LARAVEL_TEST_BACKEND ?? "";
const compose = process.env.LARAVEL_TEST_COMPOSE ?? "";
const OWNER_LOGIN = { user: "owner@shop.test", password: "test-owner-pass" };
const LOGIN_CONFIG = {
  login_path: "/login",
  user_field: "email",
  password_field: "password",
  user: OWNER_LOGIN.user,
};
const shopDb: HostDb = {
  id: `laravel-${randomUUID()}`,
  dialect: "mysql",
  host: "127.0.0.1",
  port: 3307,
  database: "shopb",
  username: "dokaan_ro",
  password: "test-backend-ro",
  sslMode: "disable",
  sslCa: null,
  poolMax: 2,
};

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

/** A command's exit code and output, with this text on its input. */
function run(
  command: string,
  args: string[],
  input = "",
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", fail);
    child.on("close", (code) => done({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input);
  });
}
const inApp = (args: string[], input = "") =>
  run("docker", ["compose", "-f", compose, "exec", "-T", "app", ...args], input);

const SALE = {
  Bangla: {
    text: "রহমান অটো ওয়ার্কসকে ফিল্ডারের ব্রেক প্যাড এক সেট বাকিতে দাও",
    args: {
      customer: "রহমান অটো ওয়ার্কস",
      items: [{ part: { part_type: "ব্রেক প্যাড", vehicle: "ফিল্ডার" }, quantity: "এক সেট" }],
      payment: { method_word: "বাকিতে" },
    },
    yes: "হ্যাঁ",
  },
  Banglish: {
    text: "Rahman Auto Works ke fielder er brake pad ek set bakite dao",
    args: {
      customer: "Rahman Auto Works",
      items: [{ part: { part_type: "brake pad", vehicle: "fielder" }, quantity: "ek set" }],
      payment: { method_word: "bakite" },
    },
    yes: "ha",
  },
} as const;

describe.skipIf(!backend || !compose)("the Laravel scanner, end to end", () => {
  let admin: Platform;
  let llm: StubLlm;
  let uploadServer: Server;
  let uploadUrl = "";
  let summary: ScannerSummary;
  const pools = new HostPools();
  const shopId = randomUUID();
  const owner = { id: randomUUID(), auth: randomUUID() };
  const dbId = randomUUID();
  const apiId = randomUUID();
  let routes: Record<string, Record<string, unknown>>;

  const sql = (text: string) => pools.readOnly(shopDb, (each) => each({ text, values: [] }));
  /** Rahman Auto Works' balance, item 1's stock and the number of sales, as the app's MySQL has them. */
  async function appState() {
    const [party] = await sql("SELECT balance FROM parties WHERE party_id = 1");
    const [stock] = await sql("SELECT SUM(qty) AS qty FROM branch_stock WHERE item_id = 1");
    const [sales] = await sql("SELECT COUNT(*) AS n FROM sales WHERE status = 'posted' AND party_id = 1");
    return { balance: Number(party!.balance), stock: Number(stock!.qty), sales: Number(sales!.n) };
  }
  const capabilityRow = async (name: string) =>
    (
      await admin.withAdmin((tx) =>
        tx
          .select()
          .from(capabilities)
          .where(and(eq(capabilities.connectionId, apiId), eq(capabilities.name, name))),
      )
    )[0]!;
  async function call(
    handler: unknown,
    path: string,
    body: unknown,
    params: Record<string, string> = {},
    method = "POST",
  ) {
    const request = new Request(`http://localhost:3100/api/v1${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${await token(owner.auth)}` },
      body: JSON.stringify(body),
    });
    const response = await (handler as Handler)(request, { params: Promise.resolve(params) });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  beforeAll(async () => {
    llm = await startStubLlm();
    admin = createPlatform(urls.admin, { max: 1 });
    await admin.withAdmin(async (tx) => {
      await tx.insert(shops).values({ id: shopId, name: "Laravel test shop", ownerUserId: owner.id });
      await tx.insert(users).values({
        id: owner.id,
        shopId,
        authUserId: owner.auth,
        name: "Owner",
        email: `laravel-owner-${shopId}@t`,
        role: "owner",
      });
      await tx.insert(aiProviders).values({
        shopId,
        job: "llm",
        provider: "vllm",
        model: "stub",
        baseUrl: llm.baseUrl,
        priority: 1,
        external: false,
      });
      await tx.insert(connections).values({
        id: dbId,
        shopId,
        kind: "db",
        dialect: "mysql",
        host: shopDb.host,
        port: shopDb.port,
        database: shopDb.database,
        username: shopDb.username,
        sslMode: "disable",
        status: "active",
        secretEncrypted: encryptSecret(
          aesKey,
          { table: "connections", rowId: dbId, column: "secret_encrypted" },
          shopDb.password,
        ),
      });
      // The app's API connection with its session sign-in, as admin set-session-login leaves it.
      await tx.insert(connections).values({
        id: apiId,
        shopId,
        kind: "api",
        label: "Laravel app",
        baseUrl: backend,
        authType: "session",
        loginConfig: LOGIN_CONFIG,
        sslMode: null,
        poolMax: 1,
        status: "pending",
        secretEncrypted: encryptSecret(
          aesKey,
          { table: "connections", rowId: apiId, column: "secret_encrypted" },
          OWNER_LOGIN.password,
        ),
      });
    });
    for (const entity of Object.values(shopBMap.entities))
      if (entity) await admin.withAdmin((tx) => confirmEntity(tx, shopId, dbId, entity, owner.id));
    await syncConnection((fn) => admin.withAdmin(fn), pools, aesKey, shopId, dbId);
    routes = {
      test: await import("../app/api/v1/setup/connections/[id]/test/route"),
      tokens: await import("../app/api/v1/setup/scanner-tokens/route"),
      upload: await import("../app/api/v1/setup/scanner-upload/route"),
      capability: await import("../app/api/v1/setup/capabilities/[id]/route"),
      appWords: await import("../app/api/v1/setup/app-words/route"),
      conversations: await import("../app/api/v1/conversations/route"),
      chat: await import("../app/api/v1/chat/messages/route"),
      decision: await import("../app/api/v1/actions/[actionId]/decision/route"),
      undo: await import("../app/api/v1/actions/[actionId]/undo/route"),
    };
    // The upload endpoint on this computer, for the scanner in the container (host.docker.internal).
    uploadServer = createServer(async (incoming, outgoing) => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers))
        if (typeof value === "string") headers.set(key, value);
      const response = await (routes.upload!.POST as Handler)(
        new Request(`http://localhost${incoming.url}`, {
          method: incoming.method,
          headers,
          body: Buffer.concat(chunks),
        }),
        { params: Promise.resolve({}) },
      );
      outgoing.writeHead(response.status, { "content-type": "application/json" });
      outgoing.end(await response.text());
    });
    await new Promise<void>((resolve) => uploadServer.listen(0, "0.0.0.0", resolve));
    uploadUrl = `http://host.docker.internal:${(uploadServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await admin.withAdmin((tx) =>
      tx.update(connections).set({ status: "disabled" }).where(eq(connections.shopId, shopId)),
    );
    await pools.closeAll();
    const { hostPools } = await import("../src/server/host");
    await hostPools().closeAll();
    await new Promise((resolve) => uploadServer.close(resolve));
    await llm.close();
    await admin.end();
  });

  it("signs in to the app with its session: the connection test", async () => {
    const tested = await call(routes.test!.POST, `/setup/connections/${apiId}/test`, {}, { id: apiId });
    expect(tested.status).toBe(200);
    expect(tested.body).toMatchObject({ ok: true });
    const [row] = await admin.withAdmin((tx) =>
      tx.select().from(connections).where(eq(connections.id, apiId)),
    );
    expect(row!.status).toBe("active");
  });

  it("scans the app in its folder and uploads the summary with a one-time token, after a yes", async () => {
    const issued = await post(routes.tokens!.POST, owner.auth, {});
    const { token: setupToken } = (await issued.json()) as { token: string };
    const scanned = await inApp(
      [
        "node",
        "/scanner/dokaanbondhu-laravel-scan.mjs",
        "--dir",
        "/app",
        "--out",
        "/tmp/summary.json",
        "--server",
        uploadUrl,
        "--token",
        setupToken,
      ],
      "y\n",
    );
    expect(scanned.stderr).toBe("");
    expect(scanned.code).toBe(0);
    expect(scanned.stdout).toContain("Upload this summary? [y/N]");
    expect(scanned.stdout).toMatch(/Uploaded: \d+ new/);
    expect(scanned.stdout).toContain("POST   /sales   [session sign-in]   SaleController@store");
    summary = scannerSummarySchema.parse(JSON.parse((await inApp(["cat", "/tmp/summary.json"])).stdout));
    expect(summary.routes.map((route) => `${route.method} ${route.path}`)).toEqual(
      expect.arrayContaining([
        "POST /login",
        "POST /sales",
        "GET /sales/{sale}",
        "POST /sales/{sale}/void",
        "POST /payments",
      ]),
    );
    expect(summary.skipped).toContain("GET /up (closure route)");
    const sale = await capabilityRow("sales_store");
    expect(sale).toMatchObject({ source: "scanner", template: "sale", enabled: false, verifiedAt: null });
  });

  it("passes the sandbox check through the session sign-in, and is switched on", async () => {
    const compensation = { operation: "sales_void", id_from: "sale.id", body: { reason: "{undo_reason}" } };
    const sale = await capabilityRow("sales_store");
    const params = await admin.withAdmin((tx) =>
      tx.select().from(capabilityParams).where(eq(capabilityParams.capabilityId, sale.id)),
    );
    // The owner confirms the proposals and names the undo (the scanner cannot see one).
    const patched = await call(
      routes.capability!.PATCH,
      `/setup/capabilities/${sale.id}`,
      { compensation, params: params.map((param) => ({ path: param.path, confirmed: true })) },
      { id: sale.id },
      "PATCH",
    );
    expect(patched.status).toBe(200);

    const imported = importScannerSummary(summary);
    const saleImported = imported.capabilities.find((item) => item.name === "sales_store")!;
    saleImported.compensation = { operation: "sales_void", idFrom: "sale.id", body: compensation.body };
    const connection: ApiConnection = {
      id: `sandbox-${apiId}`,
      baseUrl: backend,
      authType: "session",
      authHeader: null,
      secret: OWNER_LOGIN.password,
      features: imported.features,
      loginConfig: LOGIN_CONFIG,
    };
    const run = (query: { text: string; values: unknown[] }) => pools.readOnly(shopDb, (each) => each(query));
    const before = await appState();
    const report = await verifyCapabilities({
      imported,
      host: writeHostOf(imported, (request) => callHost(connection, request), randomUUID),
      read: { map: shopBMap, run },
      catalog: toCatalog(await pools.readOnly(shopDb, (each) => readCatalog(each, shopBMap))),
      hostName: "laravel-test-backend",
      commit: "local",
      now: () => new Date(),
      newId: randomUUID,
    });
    const entry = report.capabilities.find((item) => item.name === "sales_store")!;
    expect(entry, JSON.stringify(report.capabilities, null, 2)).toMatchObject({ result: "pass" });
    expect(report.capabilities.find((item) => item.name === "sales_void")).toMatchObject({ result: "pass" });
    expect(await appState()).toEqual(before); // its undo put everything back

    // The owner says what the app's customer kind means: a mechanic buys at the paikari (garage) price (D121, D145).
    const word = await call(
      routes.appWords!.PUT,
      "/setup/app-words",
      { connection_id: dbId, concept: "price_tier", value: "Mechanic", our: "paikari" },
      {},
      "PUT",
    );
    expect(word.status, JSON.stringify(word.body)).toBe(200);
    const applied = await admin.withAdmin((tx) => applyVerification(tx, apiId, report, new Date()));
    expect(applied.verified).toContain("sales_store");
    const enabled = await call(
      routes.capability!.PATCH,
      `/setup/capabilities/${sale.id}`,
      { enabled: true },
      { id: sale.id },
      "PATCH",
    );
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
  });

  it.each(["Bangla", "Banglish"] as const)(
    "saves a sale asked for in chat in the app's MySQL, through the session sign-in, and undoes it (%s)",
    async (style) => {
      const said = SALE[style];
      const before = await appState();
      const conversation = await post(routes.conversations!.POST, owner.auth, { channel: "chat" });
      const conversationId = ((await conversation.json()) as { conversation: { id: string } }).conversation
        .id;
      llm.script.length = 0;
      llm.script.push({ calls: [{ name: "sales_store", arguments: said.args }] });
      const asked = await chatCall(routes.chat!.POST, owner.auth, {
        conversation_id: conversationId,
        text: said.text,
      });
      const confirm = asked.events.find((event) => event.type === "confirm") as Extract<
        ReplyEvent,
        { type: "confirm" }
      >;
      expect(confirm, asked.reply).toBeDefined();
      expect(asked.reply).toMatch(/Rahman Auto Works — .*ব্রেক প্যাড.*১ সেট, ৪,২০০ টাকা, বাকিতে। ঠিক আছে\?$/);
      expect(await appState()).toEqual(before); // nothing is saved before yes

      const yes = await chatCall(routes.chat!.POST, owner.auth, {
        conversation_id: conversationId,
        text: said.yes,
      });
      expect(
        yes.events.find((event) => event.type === "action_result"),
        yes.reply,
      ).toMatchObject({ status: "done" });
      const [logged] = await admin.withAdmin((tx) =>
        tx.select().from(actionLogs).where(eq(actionLogs.id, confirm.action_id)),
      );
      expect(logged).toMatchObject({ status: "done", verifyStatus: "ok" });
      expect(await appState()).toEqual({
        balance: before.balance + 4200,
        stock: before.stock - 1,
        sales: before.sales + 1,
      });

      const request = new Request(`http://localhost:3100/api/v1/actions/${confirm.action_id}/undo`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${await token(owner.auth)}` },
        body: "{}",
      });
      const undone = await (routes.undo!.POST as Handler)(request, {
        params: Promise.resolve({ actionId: confirm.action_id }),
      });
      const events: ReplyEvent[] = [];
      await readReplyStream(undone.body!.getReader(), (event) => events.push(event));
      expect(events.find((event) => event.type === "action_result")).toMatchObject({ status: "done" });
      expect(await appState()).toEqual(before);
    },
  );
});
