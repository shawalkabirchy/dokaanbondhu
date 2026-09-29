import { parseAesKey } from "@dokaanbondhu/engine/crypto";
import { HostPools, runSpeechCheck } from "@dokaanbondhu/engine/host";
import { createLogger } from "@dokaanbondhu/engine/log";
import { createPlatform } from "@dokaanbondhu/platform-db";
import { PgBoss } from "pg-boss";
import { z } from "zod";
import { runCatalogSync } from "./jobs/catalog-sync";
import { runHealthProbe } from "./jobs/health-probe";
import { runRetention } from "./jobs/retention";

// The worker (spec 7.4): pg-boss in the platform database's pgboss schema, as platform_api, with its own pool of 2
// and createSchema: false (the custom migration made the schema; pg-boss creates only its tables there). Cross-shop
// jobs (retention, the health probe, catalog.sync) use a platform_admin pool; host databases are read through the
// engine's pools.

const env = z
  .object({
    PLATFORM_DATABASE_URL: z.string().min(1),
    PLATFORM_ADMIN_DATABASE_URL: z.string().min(1),
    AES_KEY: z.string().min(40),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  })
  .safeParse(process.env);
if (!env.success) {
  console.error(
    `The worker cannot start: missing ${env.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
  );
  process.exit(1);
}

const log = createLogger({ name: "worker", level: env.data.LOG_LEVEL });
const aesKey = parseAesKey(env.data.AES_KEY);
const admin = createPlatform(env.data.PLATFORM_ADMIN_DATABASE_URL, {
  max: 2,
  onIdleError: (error) => log.warn({ err: error }, "platform DB connection dropped while idle"),
});
const pools = new HostPools((error) => log.warn({ err: error }, "host DB connection dropped while idle"));
const boss = new PgBoss({
  connectionString: env.data.PLATFORM_DATABASE_URL,
  schema: "pgboss",
  createSchema: false,
  max: 2,
});
boss.on("error", (error) => log.error({ err: error }, "pg-boss error"));

await boss.start();
await boss.createQueue("retention.nightly");
await boss.createQueue("health.probe");
await boss.createQueue("catalog.sync");
await boss.createQueue("speech.calibrate");
await boss.schedule("retention.nightly", "0 2 * * *", null, { tz: "Asia/Dhaka" });
await boss.schedule("health.probe", "*/5 * * * *", null, { tz: "Asia/Dhaka" });
await boss.schedule("catalog.sync", "*/10 * * * *", null, { tz: "Asia/Dhaka" });

// Job payloads carry only IDs, never secrets (spec 7.3).
await boss.work("retention.nightly", async () => {
  const deleted = await runRetention(admin);
  log.info({ job: "retention.nightly", ...deleted }, "retention done");
});
await boss.work("health.probe", async () => {
  const result = await runHealthProbe(admin, pools, aesKey);
  log.info({ job: "health.probe", ...result }, "health probe done");
});
await boss.work("catalog.sync", async () => {
  const result = await runCatalogSync(admin, pools, aesKey);
  log.info({ job: "catalog.sync", synced: result.synced, failed: result.failed }, "catalog sync done");
  // The listening check follows each sync; it returns at once when the shop has no unchecked name (D102 A).
  for (const synced of result.results.filter((entry) => !entry.error)) {
    await boss.send(
      "speech.calibrate",
      { shopId: synced.shopId, connectionId: synced.connectionId },
      { singletonKey: synced.shopId },
    );
  }
  for (const failure of result.results.filter((entry) => entry.error)) {
    log.warn(
      { job: "catalog.sync", connectionId: failure.connectionId, error: failure.error },
      "catalog sync failed",
    );
  }
});
await boss.work<{ shopId: string; connectionId: string }>("speech.calibrate", async (jobs) => {
  for (const job of jobs) {
    const result = await runSpeechCheck(
      (fn) => admin.withAdmin(fn),
      aesKey,
      job.data.shopId,
      job.data.connectionId,
      {
        log: (line) => log.debug({ job: "speech.calibrate", shopId: job.data.shopId }, line),
      },
    );
    if (result.checked || result.stopped) {
      log.info({ job: "speech.calibrate", shopId: job.data.shopId, ...result }, "listening check done");
    }
  }
});
log.info("worker started");

async function shutdown(signal: string) {
  log.info({ signal }, "worker stopping");
  await boss.stop({ graceful: true, timeout: 10_000 });
  await pools.closeAll();
  await admin.end();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
