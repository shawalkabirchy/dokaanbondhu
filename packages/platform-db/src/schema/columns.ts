import { sql, type SQL } from "drizzle-orm";
import { timestamp, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";

// Shared column shapes (spec 7.1): IDs from gen_random_uuid(), times as timestamptz, a shop_id on every table.

export const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

/** Primary key with a database default. Rows holding a secret set it themselves before the insert (spec 13.5). */
export const id = () => uuid("id").primaryKey().defaultRandom();

export const createdAt = () => timestamptz("created_at").notNull().defaultNow();
export const updatedAt = () => timestamptz("updated_at").notNull().defaultNow();

/** column IN ('a', 'b', ...) for an enumeration kept as text. The values are constants, never user input. */
export function oneOf(column: AnyPgColumn, values: readonly string[]): SQL {
  return sql`${column} in (${sql.raw(values.map((value) => `'${value}'`).join(", "))})`;
}
