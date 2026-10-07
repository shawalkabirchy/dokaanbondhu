import { randomUUID } from "node:crypto";
import { connectionCreateSchema } from "@dokaanbondhu/contracts";
import { encryptSecret, parseAesKey } from "@dokaanbondhu/engine/crypto";
import { baseUrlProblem } from "@dokaanbondhu/engine/host";
import { connections } from "@dokaanbondhu/platform-db";
import { asc } from "drizzle-orm";
import { serverEnv } from "../../../../../src/env";
import { appError } from "../../../../../src/server/errors";
import { readBody, route } from "../../../../../src/server/route";
import { connectionView } from "../../../../../src/server/setup";
import { platform } from "../../../../../src/server/singletons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOCAL = new Set(["localhost", "127.0.0.1", "::1"]);

/** GET /setup/connections (owner): the shop's connections, without their secrets. */
export const GET = route({ role: "owner", limit: "setup" }, async ({ caller }) => {
  const rows = await platform().withShop(caller.shopId, (tx) =>
    tx.select().from(connections).orderBy(asc(connections.createdAt)),
  );
  return Response.json({ connections: rows.map(connectionView) });
});

/**
 * POST /setup/connections (owner): a database or an API connection; the password or API secret is encrypted at once
 * (spec 8.3, 11.12, 13.5).
 */
export const POST = route({ role: "owner", limit: "setup" }, async ({ request, caller }) => {
  const body = await readBody(request, connectionCreateSchema);
  const id = randomUUID(); // made before the insert, because the encryption is bound to the row (spec 13.5)
  const encrypted = (secret: string) =>
    encryptSecret(
      parseAesKey(serverEnv().AES_KEY),
      { table: "connections", rowId: id, column: "secret_encrypted" },
      secret,
    );
  let values: typeof connections.$inferInsert;
  if (body.kind === "api") {
    const problem = baseUrlProblem(body.base_url);
    if (problem) throw appError("VALIDATION_FAILED", 400, { field: "base_url", reason: problem });
    if (body.auth_type === "bearer" && body.auth_header)
      throw appError("VALIDATION_FAILED", 400, {
        field: "auth_header",
        reason: "only an API key goes in a header",
      });
    values = {
      id,
      shopId: caller.shopId,
      kind: "api",
      label: body.label ?? null,
      baseUrl: body.base_url.replace(/\/+$/, ""),
      authType: body.auth_type,
      authHeader: body.auth_header ?? null,
      sslMode: null, // a database setting; the API is https (or localhost)
      poolMax: 1,
      status: "pending",
      secretEncrypted: encrypted(body.secret),
    };
  } else {
    if (body.ssl_mode === "disable" && !LOCAL.has(body.host.toLowerCase()))
      throw appError("VALIDATION_FAILED", 400, {
        field: "ssl_mode",
        reason: "disable is only for localhost",
      });
    if (body.ssl_ca && !body.ssl_ca.includes("-----BEGIN CERTIFICATE-----"))
      throw appError("VALIDATION_FAILED", 400, { field: "ssl_ca", reason: "not a PEM certificate" });
    values = {
      id,
      shopId: caller.shopId,
      kind: "db",
      label: body.label ?? null,
      dialect: body.dialect,
      host: body.host,
      port: body.port ?? (body.dialect === "mysql" ? 3306 : 5432),
      database: body.database,
      username: body.username,
      sslMode: body.ssl_mode,
      sslCa: body.ssl_ca ?? null,
      poolMax: body.pool_max,
      status: "pending",
      secretEncrypted: encrypted(body.password),
    };
  }
  const [row] = await platform().withShop(caller.shopId, (tx) =>
    tx.insert(connections).values(values).returning(),
  );
  return Response.json({ connection: connectionView(row!) }, { status: 201 });
});
