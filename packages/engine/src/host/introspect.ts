import { quoteName } from "./sql";
import type { RunQuery } from "./pool";
import type { Dialect } from "./schema-map";

// Schema mapper, step 1 (spec 11.3): tables, columns, types, primary and foreign keys, plus five sample rows per
// table and the distinct values of status columns, through the read-only connection. These catalog queries are fixed
// text; table and column names come from the host's own catalog and are quoted.

const STATUS_COLUMN = /^(status|state)$|_status$/i;
const TEXT_TYPE = /char|text|enum|string|user-defined/i; // user-defined: a PostgreSQL enum
const MAX_VALUES = 12;

export interface IntrospectedColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  primaryKey: boolean;
  references: { table: string; column: string } | null;
  /** A status column's distinct values (at most 12), so filters for voided or reversed rows can be proposed. */
  values?: string[];
}

export interface IntrospectedTable {
  name: string;
  columns: IntrospectedColumn[];
  /** Up to five rows, every value as text cut to 60 characters. */
  samples: Record<string, string | null>[];
}

const PG_COLUMNS = `
  SELECT c.table_name AS table_name, c.column_name AS column_name, c.data_type AS data_type,
         c.is_nullable = 'YES' AS nullable
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND has_table_privilege(quote_ident(c.table_schema) || '.' || quote_ident(c.table_name), 'SELECT')
  ORDER BY c.table_name, c.ordinal_position`;

// pg_catalog, not information_schema: a read-only role does not see other owners' constraint columns there.
const PG_KEYS = `
  SELECT t.relname AS table_name, c.contype AS kind, a.attname AS column_name,
         rt.relname AS ref_table, ra.attname AS ref_column
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
  JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
  LEFT JOIN pg_class rt ON rt.oid = c.confrelid
  LEFT JOIN LATERAL unnest(c.confkey) WITH ORDINALITY AS f(attnum, ord) ON f.ord = k.ord
  LEFT JOIN pg_attribute ra ON ra.attrelid = c.confrelid AND ra.attnum = f.attnum
  WHERE c.contype IN ('p', 'f')`;

// The values a status column may hold, from the database's own rules: a CHECK constraint (PostgreSQL) or an enum
// column type (MySQL). A value no row holds yet (no payment reversed so far) still gets its filter.
const PG_CHECKS = `
  SELECT t.relname AS table_name, pg_get_constraintdef(c.oid) AS definition
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
  WHERE c.contype = 'c'`;

const MYSQL_COLUMNS = `
  SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, DATA_TYPE AS data_type,
         COLUMN_TYPE AS column_type, IS_NULLABLE = 'YES' AS nullable
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
  ORDER BY TABLE_NAME, ORDINAL_POSITION`;

const MYSQL_KEYS = `
  SELECT TABLE_NAME AS table_name, IF(CONSTRAINT_NAME = 'PRIMARY', 'p', 'f') AS kind, COLUMN_NAME AS column_name,
         REFERENCED_TABLE_NAME AS ref_table, REFERENCED_COLUMN_NAME AS ref_column
  FROM information_schema.KEY_COLUMN_USAGE
  WHERE TABLE_SCHEMA = DATABASE() AND (CONSTRAINT_NAME = 'PRIMARY' OR REFERENCED_TABLE_NAME IS NOT NULL)`;

/** The quoted values of a CHECK definition or an enum type: 'completed'::text, 'void' -> completed, void. */
export function quotedValues(text: string): string[] {
  return [...text.matchAll(/'((?:[^']|'')*)'/g)].map((match) => match[1]!.replace(/''/g, "'"));
}

function cut(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text =
    value instanceof Date
      ? value.toISOString()
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

export async function introspect(run: RunQuery, dialect: Dialect): Promise<IntrospectedTable[]> {
  const columns = await run({ text: dialect === "postgres" ? PG_COLUMNS : MYSQL_COLUMNS, values: [] });
  const keys = await run({ text: dialect === "postgres" ? PG_KEYS : MYSQL_KEYS, values: [] });
  const checks = dialect === "postgres" ? await run({ text: PG_CHECKS, values: [] }) : [];
  const allowed = new Map<string, string[]>(); // "table.column" -> values its rules allow
  const tables = new Map<string, IntrospectedTable>();
  for (const row of columns) {
    const name = String(row.table_name);
    const table = tables.get(name) ?? { name, columns: [], samples: [] };
    table.columns.push({
      name: String(row.column_name),
      dataType: String(row.data_type),
      nullable: Boolean(Number(row.nullable) || row.nullable === true),
      primaryKey: false,
      references: null,
    });
    const columnType = String(row.column_type ?? "");
    if (/^enum\(/i.test(columnType))
      allowed.set(`${name}.${String(row.column_name)}`, quotedValues(columnType));
    tables.set(name, table);
  }
  for (const check of checks) {
    const table = tables.get(String(check.table_name));
    const definition = String(check.definition);
    for (const column of table?.columns ?? []) {
      if (!STATUS_COLUMN.test(column.name) || !new RegExp(`\\b${column.name}\\b`).test(definition)) continue;
      const key = `${table!.name}.${column.name}`;
      allowed.set(key, [...(allowed.get(key) ?? []), ...quotedValues(definition)]);
    }
  }
  for (const key of keys) {
    const column = tables
      .get(String(key.table_name))
      ?.columns.find((c) => c.name === String(key.column_name));
    if (!column) continue;
    if (key.kind === "p") column.primaryKey = true;
    else if (key.ref_table)
      column.references = { table: String(key.ref_table), column: String(key.ref_column) };
  }
  for (const table of tables.values()) {
    const rows = await run({ text: `SELECT * FROM ${quoteName(dialect, table.name)} LIMIT 5`, values: [] });
    table.samples = rows.map((row) =>
      Object.fromEntries(Object.entries(row).map(([key, value]) => [key, cut(value)])),
    );
    for (const column of table.columns) {
      if (!STATUS_COLUMN.test(column.name) || !TEXT_TYPE.test(column.dataType)) continue;
      const name = quoteName(dialect, column.name);
      const distinct = await run({
        text: `SELECT DISTINCT ${name} AS v FROM ${quoteName(dialect, table.name)} WHERE ${name} IS NOT NULL LIMIT ${MAX_VALUES + 1}`,
        values: [],
      });
      const present = distinct.length <= MAX_VALUES ? distinct.map((row) => String(row.v)) : [];
      const values = [...new Set([...(allowed.get(`${table.name}.${column.name}`) ?? []), ...present])];
      if (values.length) column.values = values;
    }
  }
  return [...tables.values()].sort((a, b) => a.name.localeCompare(b.name));
}
