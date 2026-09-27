import { connections, schemaEntities, schemaFields, type Tx } from "@dokaanbondhu/platform-db";
import { and, eq, inArray } from "drizzle-orm";
import { decryptSecret } from "../crypto";
import type { Proposal } from "./mapper";
import type { HostDb } from "./pool";
import type { Concept, Dialect, EntityMap, FieldMap, JoinMap, RowFilter, SchemaMap } from "./schema-map";

// The schema map and host connections in the platform DB (spec 7.2). Every call runs inside the caller's withShop()
// transaction, so row-level security keeps each shop to its own rows.

export class ConnectionNotUsable extends Error {}

/** A database connection with its password decrypted (only here, never logged; spec 13.5). */
export async function loadHostDb(tx: Tx, connectionId: string, aesKey: Buffer): Promise<HostDb> {
  const [row] = await tx.select().from(connections).where(eq(connections.id, connectionId));
  if (!row || row.kind !== "db" || !row.dialect || !row.host || !row.database || !row.username) {
    throw new ConnectionNotUsable("not a complete database connection");
  }
  const password = decryptSecret(
    aesKey,
    { table: "connections", rowId: row.id, column: "secret_encrypted" },
    row.secretEncrypted,
  );
  return {
    id: row.id,
    dialect: row.dialect as Dialect,
    host: row.host,
    port: row.port ?? (row.dialect === "mysql" ? 3306 : 5432),
    database: row.database,
    username: row.username,
    password,
    sslMode: (row.sslMode ?? "verify-full") as HostDb["sslMode"],
    sslCa: row.sslCa,
    poolMax: row.poolMax,
  };
}

/** The connection's schema map, confirmed and unconfirmed entries alike (callers check confirmation). */
export async function loadSchemaMap(tx: Tx, connectionId: string, dialect: Dialect): Promise<SchemaMap> {
  const entities = await tx
    .select()
    .from(schemaEntities)
    .where(eq(schemaEntities.connectionId, connectionId));
  const ids = entities.map((entity) => entity.id);
  const fields = ids.length
    ? await tx.select().from(schemaFields).where(inArray(schemaFields.entityId, ids))
    : [];
  const map: SchemaMap = { dialect, entities: {} };
  for (const entity of entities) {
    const own = fields.filter((field) => field.entityId === entity.id);
    map.entities[entity.concept as Concept] = {
      concept: entity.concept as Concept,
      hostTable: entity.hostTable,
      joins: entity.joins as JoinMap[],
      rowFilters: entity.rowFilters as RowFilter[],
      confirmed: entity.confirmed,
      fields: Object.fromEntries(
        own.map((field): [string, FieldMap] => [
          field.conceptField,
          {
            conceptField: field.conceptField,
            hostTable: field.hostTable,
            hostColumn: field.hostColumn,
            dataType: field.dataType,
            idType: field.idType as FieldMap["idType"],
            valueScale: field.valueScale,
            confirmed: field.confirmed,
          },
        ]),
      ),
    };
  }
  return map;
}

async function writeEntity(
  tx: Tx,
  shopId: string,
  connectionId: string,
  entity: EntityMap,
  confirmedBy: string | null,
): Promise<string> {
  const [existing] = await tx
    .select({ id: schemaEntities.id })
    .from(schemaEntities)
    .where(and(eq(schemaEntities.connectionId, connectionId), eq(schemaEntities.concept, entity.concept)));
  const values = {
    hostTable: entity.hostTable,
    joins: entity.joins,
    rowFilters: entity.rowFilters,
    confirmed: entity.confirmed,
    confirmedAt: entity.confirmed ? new Date() : null,
    confirmedBy: entity.confirmed ? confirmedBy : null,
  };
  let id: string;
  if (existing) {
    id = existing.id;
    await tx.update(schemaEntities).set(values).where(eq(schemaEntities.id, id));
    await tx.delete(schemaFields).where(eq(schemaFields.entityId, id));
  } else {
    const [created] = await tx
      .insert(schemaEntities)
      .values({ shopId, connectionId, concept: entity.concept, ...values })
      .returning({ id: schemaEntities.id });
    id = created!.id;
  }
  const fields = Object.values(entity.fields);
  if (fields.length) {
    await tx.insert(schemaFields).values(
      fields.map((field) => ({
        shopId,
        entityId: id,
        conceptField: field.conceptField,
        hostTable: field.hostTable,
        hostColumn: field.hostColumn,
        dataType: field.dataType,
        idType: field.idType,
        valueScale: field.valueScale,
        confirmed: entity.confirmed && field.confirmed,
      })),
    );
  }
  return id;
}

/** Stores a proposal: unconfirmed concepts are replaced; a concept the owner already confirmed is kept. */
export async function saveProposal(
  tx: Tx,
  shopId: string,
  connectionId: string,
  proposal: Proposal,
): Promise<void> {
  const current = await tx
    .select({ concept: schemaEntities.concept, confirmed: schemaEntities.confirmed })
    .from(schemaEntities)
    .where(eq(schemaEntities.connectionId, connectionId));
  const confirmed = new Set(current.filter((row) => row.confirmed).map((row) => row.concept));
  for (const entity of proposal.entities) {
    if (confirmed.has(entity.concept)) continue;
    await writeEntity(tx, shopId, connectionId, { ...entity, confirmed: false }, null);
  }
}

/** The owner confirms one concept, as proposed or corrected: the entity and all its given fields. */
export async function confirmEntity(
  tx: Tx,
  shopId: string,
  connectionId: string,
  entity: EntityMap,
  userId: string,
): Promise<string> {
  const fields = Object.fromEntries(
    Object.entries(entity.fields).map(([name, field]) => [name, { ...field, confirmed: true }]),
  );
  return writeEntity(tx, shopId, connectionId, { ...entity, fields, confirmed: true }, userId);
}
