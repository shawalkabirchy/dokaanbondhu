import { parseAesKey } from "@dokaanbondhu/engine/crypto";
import { createLogger } from "@dokaanbondhu/engine/log";
import { createPlatform } from "@dokaanbondhu/platform-db";
import { PgBoss } from "pg-boss";
import { z } from "zod";
import { runHealthProbe } from "./jobs/health-probe";
import { runRetention } from "./jobs/retention";

// The worker (spec 7.4): pg-boss in the platform database's pgboss schema, as platform_api, with its own pool of 2
// and createSchema: false (the custom migration made the schema; pg-boss creates only its tables there). Cross-shop
// jobs (retention, the health probe) use a platform_admin pool. catalog.sync joins in step 3.

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
const admin = createPlatform(env.data.PLATFORM_ADMIN_DATABASE_URL, { max: 2 });
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
await boss.schedule("retention.nightly", "0 2 * * *", null, { tz: "Asia/Dhaka" });
await boss.schedule("health.probe", "*/5 * * * *", null, { tz: "Asia/Dhaka" });

// Job payloads carry only IDs, never secrets (spec 7.3).
await boss.work("retention.nightly", async () => {
  const deleted = await runRetention(admin);
  log.info({ job: "retention.nightly", ...deleted }, "retention done");
});
await boss.work("health.probe", async () => {
  const result = await runHealthProbe(admin, aesKey);
  log.info({ job: "health.probe", ...result }, "health probe done");
});
log.info("worker started");

async function shutdown(signal: string) {
  log.info({ signal }, "worker stopping");
  await boss.stop({ graceful: true, timeout: 10_000 });
  await admin.end();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
