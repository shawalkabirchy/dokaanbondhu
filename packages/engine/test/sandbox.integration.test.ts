import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { callHost, fetchOpenApi, type ApiConnection } from "../src/host/api";
import { readCatalog, toCatalog } from "../src/host/catalog";
import { importOpenApi } from "../src/host/openapi-import";
import { HostPools, type HostDb } from "../src/host/pool";
import { verifyCapabilities, writeHostOf } from "../src/write/sandbox";
import { geargridMap } from "./geargrid-map";

// The sandbox check (spec 11.11; D139) on the test host's API that the CI job starts on port 4000: the three writes of
// step 5 pass with their compensations; the kinds without a sample yet are skipped, never passed; every record it
// saves is undone, so the seed stays as the other test files expect it.

const apiUrl = process.env.GEARGRID_API_URL ?? "";
const seedKey = process.env.SEED_API_KEY ?? "";
const migrationUrl = process.env.MIGRATION_DATABASE_URL ?? "";
const local = (url: string) => {
  try {
    return ["localhost", "127.0.0.1"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
};
const ready = local(apiUrl) && local(migrationUrl) && seedKey.length > 0;
if (process.env.CI === "true" && !ready)
  throw new Error("the sandbox test needs the CI job's API and database");

describe.skipIf(!ready)("the sandbox check on the test host", () => {
  const pools = new HostPools();
  afterAll(() => pools.closeAll());

  it("passes sale, payment and stock-in with their undo, and skips the kinds it has no sample for", async () => {
    const url = new URL(migrationUrl);
    const db: HostDb = {
      id: "sandbox-test",
      dialect: "postgres",
      host: url.hostname,
      port: Number(url.port || 5432),
      database: url.pathname.slice(1),
      username: "dokaanbondhu_ro",
      password: process.env.DOKAAN_RO_PASSWORD ?? "",
      sslMode: "disable",
      sslCa: null,
      poolMax: 2,
    };
    const connection: ApiConnection = {
      id: "sandbox",
      baseUrl: apiUrl,
      authType: "api_key",
      authHeader: "X-Api-Key",
      secret: seedKey,
      features: {},
    };
    const { document, path } = await fetchOpenApi(connection);
    const imported = importOpenApi(document, path);
    connection.features = imported.features;
    const run = (query: { text: string; values: unknown[] }) => pools.readOnly(db, (each) => each(query));
    const report = await verifyCapabilities({
      imported,
      host: writeHostOf(imported, (request) => callHost(connection, request), randomUUID),
      read: { map: geargridMap, run },
      catalog: toCatalog(await pools.readOnly(db, (each) => readCatalog(each, geargridMap))),
      hostName: "test host",
      commit: "ci",
      now: () => new Date(),
      newId: randomUUID,
    });
    const result = Object.fromEntries(report.capabilities.map((entry) => [entry.name, entry.result]));
    expect(result).toMatchObject({
      record_sale: "pass",
      void_sale: "pass",
      receive_payment: "pass",
      reverse_payment: "pass",
      stock_in: "pass",
      reverse_purchase: "pass",
      record_return: "skipped",
      update_price: "skipped",
      add_fitment: "skipped",
    });
    const sale = report.capabilities.find((entry) => entry.name === "record_sale")!;
    expect(sale.schema_hash).toBe(
      imported.capabilities.find((item) => item.name === "record_sale")!.schemaHash,
    );
    expect(sale.checks.map((check) => check.name)).toEqual([
      "dry_run_changes_nothing",
      "saved",
      "read_back_stock_and_balance",
      "undo_puts_everything_back",
    ]);
  });
});
