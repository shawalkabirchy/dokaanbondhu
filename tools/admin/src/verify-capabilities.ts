import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  apiKeyHeaderOf,
  callHost,
  fetchOpenApi,
  HostPools,
  importOpenApi,
  readCatalog,
  toCatalog,
  type ApiConnection,
  type HostDb,
  type SchemaMap,
} from "@dokaanbondhu/engine/host";
import { verifyCapabilities, writeHostOf } from "@dokaanbondhu/engine/write";
import { z } from "zod";

// npm run verify-capabilities -- --map <module> [--host <name>] [--commit <sha>] [--out <file>] (spec 11.11; D139):
// the sandbox check against a throw-away copy of a host, run by the verify-capabilities workflow. It reads the host's
// OpenAPI description, runs every write with sample values from the host's own data, checks the effects through the
// read-only role, runs each compensation, and writes verification-report.json for admin import-verification. Only
// against a throw-away copy: every check saves and undoes real records.

const env = z
  .object({
    SANDBOX_API_URL: z.url(),
    SANDBOX_API_SECRET: z.string().min(1),
    SANDBOX_AUTH: z.enum(["api_key", "bearer"]).default("api_key"),
    /** Left out, the header comes from the document's apiKey scheme. */
    SANDBOX_KEY_HEADER: z.string().optional(),
    /** The read-only role on the sandbox's database, postgres:// or mysql://. */
    SANDBOX_READ_URL: z.string().min(1),
  })
  .parse(process.env);

const { values } = parseArgs({
  options: {
    map: { type: "string" },
    host: { type: "string", default: "host" },
    commit: { type: "string", default: "unknown" },
    out: { type: "string", default: "verification-report.json" },
  },
});

// The host's confirmed schema map, from a module that exports it (for the test host, its known map).
const mapModule = (await import(pathToFileURL(resolve(z.string().min(1).parse(values.map))).href)) as Record<
  string,
  unknown
>;
const map = Object.values(mapModule).find(
  (value): value is SchemaMap =>
    typeof value === "object" && value !== null && "entities" in value && "dialect" in value,
);
if (!map) throw new Error("the --map module exports no schema map");

const read = new URL(env.SANDBOX_READ_URL);
const local = ["localhost", "127.0.0.1"].includes(read.hostname);
if (!local) throw new Error("the sandbox check runs only against a throw-away copy on this machine");
const db: HostDb = {
  id: "sandbox",
  dialect: read.protocol.startsWith("mysql") ? "mysql" : "postgres",
  host: read.hostname,
  port: Number(read.port || (read.protocol.startsWith("mysql") ? 3306 : 5432)),
  database: read.pathname.slice(1),
  username: decodeURIComponent(read.username),
  password: decodeURIComponent(read.password),
  sslMode: "disable",
  sslCa: null,
  poolMax: 2,
};
const pools = new HostPools();
try {
  const connection: ApiConnection = {
    id: "sandbox-api",
    baseUrl: env.SANDBOX_API_URL,
    authType: env.SANDBOX_AUTH,
    authHeader: env.SANDBOX_KEY_HEADER ?? null,
    secret: env.SANDBOX_API_SECRET,
    features: {},
  };
  const { document, path } = await fetchOpenApi(connection);
  if (connection.authType === "api_key" && !connection.authHeader)
    connection.authHeader = apiKeyHeaderOf(document);
  const imported = importOpenApi(document, path);
  connection.features = imported.features;
  const run = (query: { text: string; values: unknown[] }) => pools.readOnly(db, (each) => each(query));
  const report = await verifyCapabilities({
    imported,
    host: writeHostOf(imported, (request) => callHost(connection, request), randomUUID),
    read: { map, run },
    catalog: toCatalog(await pools.readOnly(db, (each) => readCatalog(each, map))),
    hostName: values.host!,
    commit: values.commit!,
    now: () => new Date(),
    newId: randomUUID,
  });
  await writeFile(values.out!, `${JSON.stringify(report, null, 2)}\n`);
  for (const entry of report.capabilities) {
    const failed = entry.checks.filter((check) => !check.ok).map((check) => check.name);
    process.stdout.write(
      `${entry.result.padEnd(7)} ${entry.name}${failed.length ? `  (${failed.join(", ")})` : ""}\n`,
    );
  }
  process.stdout.write(`Written: ${values.out}\n`);
} finally {
  await pools.closeAll();
}
