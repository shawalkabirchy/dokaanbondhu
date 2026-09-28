import { randomUUID } from "node:crypto";
import { connectionCreateSchema } from "@dokaanbondhu/contracts";
import { encryptSecret, parseAesKey } from "@dokaanbondhu/engine/crypto";
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

/** POST /setup/connections (owner): a database connection; the password is encrypted at once (spec 8.3, 13.5). */
export const POST = route({ role: "owner", limit: "setup" }, async ({ request, caller }) => {
  const body = await readBody(request, connectionCreateSchema);
  if (body.ssl_mode === "disable" && !LOCAL.has(body.host.toLowerCase()))
    throw appError("VALIDATION_FAILED", 400, { field: "ssl_mode", reason: "disable is only for localhost" });
  if (body.ssl_ca && !body.ssl_ca.includes("-----BEGIN CERTIFICATE-----"))
    throw appError("VALIDATION_FAILED", 400, { field: "ssl_ca", reason: "not a PEM certificate" });
  const id = randomUUID(); // made before the insert, because the encryption is bound to the row (spec 13.5)
  const [row] = await platform().withShop(caller.shopId, (tx) =>
    tx
      .insert(connections)
      .values({
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
        secretEncrypted: encryptSecret(
          parseAesKey(serverEnv().AES_KEY),
          { table: "connections", rowId: id, column: "secret_encrypted" },
          body.password,
        ),
      })
      .returning(),
  );
  return Response.json({ connection: connectionView(row!) }, { status: 201 });
});
