import type { ConnectionView, EntityView, SchemaView } from "@dokaanbondhu/contracts";
import { parseAesKey } from "@dokaanbondhu/engine/crypto";
import {
  CONCEPTS,
  introspect,
  loadHostDb,
  loadSchemaMap,
  spokenSamples,
  type Dialect,
  type EntityMap,
  type HostDb,
  type IntrospectedTable,
} from "@dokaanbondhu/engine/host";
import { connections, schemaEntities } from "@dokaanbondhu/platform-db";
import { and, eq } from "drizzle-orm";
import { serverEnv } from "../env";
import { appError } from "./errors";
import { hostPools } from "./host";
import { platform } from "./singletons";

// Setup helpers (spec 8.3, 11.3): the connection view without its secret, the introspection kept for 10 minutes so the
// schema review can show sample values without asking the host again, and the schema map as the review shows it.

type ConnectionRow = typeof connections.$inferSelect;

const INTROSPECTION_MS = 10 * 60_000;
const holder = globalThis as {
  __dokaanIntrospection?: Map<string, { tables: IntrospectedTable[]; at: number }>;
};
const introspections = (holder.__dokaanIntrospection ??= new Map());

export function connectionView(row: ConnectionRow): ConnectionView {
  return {
    id: row.id,
    kind: row.kind as ConnectionView["kind"],
    label: row.label,
    dialect: row.dialect as ConnectionView["dialect"],
    host: row.host,
    port: row.port,
    database: row.database,
    username: row.username,
    ssl_mode: row.sslMode as ConnectionView["ssl_mode"],
    has_ssl_ca: Boolean(row.sslCa),
    status: row.status as ConnectionView["status"],
    last_checked_at: row.lastCheckedAt?.toISOString() ?? null,
    last_error: row.lastError,
    created_at: row.createdAt.toISOString(),
  };
}

/** One of the shop's database connections; another shop's, or an API connection, is not found. */
export async function dbConnection(shopId: string, connectionId: string): Promise<ConnectionRow> {
  const [row] = await platform().withShop(shopId, (tx) =>
    tx
      .select()
      .from(connections)
      .where(and(eq(connections.id, connectionId), eq(connections.kind, "db"))),
  );
  if (!row) throw appError("NOT_FOUND", 404, { entity: "connection" });
  return row;
}

export async function hostDbOf(shopId: string, connectionId: string): Promise<HostDb> {
  const aesKey = parseAesKey(serverEnv().AES_KEY);
  return platform().withShop(shopId, (tx) => loadHostDb(tx, connectionId, aesKey));
}

/** Tables, columns, keys and five sample rows, through the read-only connection (spec 11.3 step 1). */
export async function introspected(
  shopId: string,
  connectionId: string,
  fresh = false,
): Promise<IntrospectedTable[]> {
  const cached = introspections.get(connectionId);
  if (!fresh && cached && Date.now() - cached.at < INTROSPECTION_MS) return cached.tables;
  const db = await hostDbOf(shopId, connectionId);
  const tables = await hostPools().readOnly(db, (run) => introspect(run, db.dialect));
  introspections.set(connectionId, { tables, at: Date.now() });
  return tables;
}

export function forgetIntrospection(connectionId: string): void {
  introspections.delete(connectionId);
}

export function entityView(id: string, entity: EntityMap, tables: IntrospectedTable[]): EntityView {
  return {
    id,
    concept: entity.concept,
    host_table: entity.hostTable,
    joins: entity.joins,
    row_filters: entity.rowFilters,
    confirmed: entity.confirmed,
    fields: Object.values(entity.fields).map((field) => ({
      concept_field: field.conceptField,
      host_table: field.hostTable,
      host_column: field.hostColumn,
      value_scale: field.valueScale,
      id_type: field.idType,
      confirmed: field.confirmed,
      samples: spokenSamples(entity, field, tables),
    })),
  };
}

/** The schema map as the review shows it; sample values need the host, and are left empty when it cannot answer. */
export async function schemaView(
  shopId: string,
  connectionId: string,
  warnings: string[] = [],
): Promise<SchemaView> {
  const connection = await dbConnection(shopId, connectionId);
  const { map, ids } = await platform().withShop(shopId, async (tx) => ({
    map: await loadSchemaMap(tx, connectionId, connection.dialect as Dialect),
    ids: await tx
      .select({ id: schemaEntities.id, concept: schemaEntities.concept })
      .from(schemaEntities)
      .where(eq(schemaEntities.connectionId, connectionId)),
  }));
  let tables: IntrospectedTable[] = [];
  try {
    tables = await introspected(shopId, connectionId);
  } catch {
    tables = [];
  }
  const idOf = new Map(ids.map((row) => [row.concept, row.id]));
  const entities = CONCEPTS.flatMap((concept) => {
    const entity = map.entities[concept];
    const id = idOf.get(concept);
    return entity && id ? [entityView(id, entity, tables)] : [];
  });
  return {
    connection_id: connectionId,
    entities,
    missing: CONCEPTS.filter((concept) => !map.entities[concept]),
    warnings,
  };
}
