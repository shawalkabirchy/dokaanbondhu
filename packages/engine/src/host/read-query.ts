import pkg from "node-sql-parser";
import { toPaisa, toUnits } from "./find-parts";
import type { Row, RunQuery } from "./pool";
import {
  CONCEPT_FIELDS,
  joinShape,
  type Dialect,
  type EntityMap,
  type FieldKind,
  type RowFilter,
  type SchemaMap,
} from "./schema-map";
import { quoteName } from "./sql";

// The run_read_query guard (spec 11.6): the LLM's SQL is parsed in the host's dialect and accepted only as one plain
// SELECT over confirmed tables and columns with allowed functions. Every table it reads is replaced by its filtered
// version: one WITH clause defines, under each table's own name, (SELECT t.* FROM t WHERE <row filters>), with a
// parent's filters through its confirmed join, so deleted, voided and reversed rows can never be counted (D17). The
// LIMIT is added or capped at 200; lineage gives each result column its value scale (D18).

const { Parser } = pkg;
const parser = new Parser();

export const READ_LIMIT = 200;
export const TABLE_ROWS = 50;

const ALLOWED_FUNCTIONS = new Set([
  "count",
  "sum",
  "min",
  "max",
  "avg",
  "coalesce",
  "nullif",
  "greatest",
  "least",
  "round",
  "abs",
  "floor",
  "ceil",
  "ceiling",
  "lower",
  "upper",
  "trim",
  "length",
  "char_length",
  "concat",
  "substring",
  "substr",
  "replace",
  "left",
  "right",
  "date",
  "date_trunc",
  "date_part",
  "extract",
  "to_char",
  "now",
  "current_date",
  "current_timestamp",
  "curdate",
  "date_format",
  "datediff",
  "date_sub",
  "date_add",
  "year",
  "month",
  "day",
]);

export class ReadQueryRejected extends Error {}

type ResultKind = "money" | "quantity" | "count" | "number" | "text" | "date" | "unscaled";

export interface ResultColumn {
  key: string;
  kind: ResultKind;
  valueScale: number;
}

export interface ReadQueryResult {
  sql: string;
  columns: ResultColumn[];
  /** Rows with money in paisa and quantities in units (unscaled values as the host gave them). */
  rows: Row[];
  truncated: boolean;
}

interface Allowed {
  tables: Map<string, Set<string>>; // host table -> readable columns
  fields: Map<string, { kind: FieldKind; valueScale: number }>; // "table.column" -> mapped field
}

function allowedOf(map: SchemaMap): Allowed {
  const tables = new Map<string, Set<string>>();
  const fields = new Map<string, { kind: FieldKind; valueScale: number }>();
  const add = (table: string, column: string) =>
    tables.set(table, (tables.get(table) ?? new Set()).add(column));
  for (const entity of Object.values(map.entities)) {
    if (!entity?.confirmed) continue;
    for (const field of Object.values(entity.fields)) {
      if (!field.confirmed) continue;
      add(field.hostTable, field.hostColumn);
      const kind = CONCEPT_FIELDS[entity.concept][field.conceptField] ?? "text";
      if (!fields.has(`${field.hostTable}.${field.hostColumn}`) || kind === "money" || kind === "quantity") {
        fields.set(`${field.hostTable}.${field.hostColumn}`, { kind, valueScale: field.valueScale });
      }
    }
    for (const join of entity.joins) {
      for (const pair of join.on) {
        for (const side of [pair.left, pair.right]) {
          const dot = side.lastIndexOf(".");
          if (
            tables.has(side.slice(0, dot)) ||
            side.slice(0, dot) === entity.hostTable ||
            side.slice(0, dot) === join.table
          ) {
            add(side.slice(0, dot), side.slice(dot + 1));
          }
        }
      }
    }
  }
  return { tables, fields };
}

function literal(value: RowFilter["value"]): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function filterSql(dialect: Dialect, alias: string, filter: RowFilter): string {
  const column = `${alias}.${quoteName(dialect, filter.column)}`;
  switch (filter.op) {
    case "is_null":
      return `${column} IS NULL`;
    case "is_true":
      return `${column} IS TRUE`;
    case "eq":
      return `${column} = ${literal(filter.value)}`;
    case "ne":
      return `(${column} IS NULL OR ${column} <> ${literal(filter.value)})`;
  }
}

/** The filtered version of one host table: its own row filters, and its parents' through their joins. */
function filteredTable(map: SchemaMap, table: string): string {
  const q = (name: string) => quoteName(map.dialect, name);
  const entities = Object.values(map.entities).filter((entity): entity is EntityMap =>
    Boolean(entity?.confirmed),
  );
  const own = entities.flatMap((entity) => entity.rowFilters.filter((filter) => filter.table === table));
  const conditions = [
    ...new Map(own.map((filter) => [JSON.stringify(filter), filterSql(map.dialect, "t", filter)])).values(),
  ];
  const joins: string[] = [];
  let index = 0;
  for (const entity of entities.filter((candidate) => candidate.hostTable === table)) {
    for (const join of entity.joins) {
      const shape = joinShape(entity, join);
      const parentFilters = entity.rowFilters.filter((filter) => filter.table === join.table);
      if (shape.kind !== "parent" || !parentFilters.length) continue;
      const alias = `p${index++}`;
      const side = (qualified: string) => {
        const dot = qualified.lastIndexOf(".");
        return `${qualified.slice(0, dot) === table ? "t" : alias}.${q(qualified.slice(dot + 1))}`;
      };
      joins.push(
        `LEFT JOIN ${q(join.table)} AS ${alias} ON ${join.on.map((pair) => `${side(pair.left)} = ${side(pair.right)}`).join(" AND ")}`,
      );
      const presence = side(shape.presence);
      for (const filter of parentFilters)
        conditions.push(`(${presence} IS NULL OR ${filterSql(map.dialect, alias, filter)})`);
    }
  }
  const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
  return `${q(table)} AS (SELECT t.* FROM ${q(table)} AS t${joins.length ? ` ${joins.join(" ")}` : ""}${where})`;
}

function walk(node: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, visit));
  } else if (node && typeof node === "object") {
    visit(node as Record<string, unknown>);
    Object.values(node).forEach((child) => walk(child, visit));
  }
}

function functionName(node: Record<string, unknown>): string | null {
  if (node.type === "aggr_func" && typeof node.name === "string") return node.name.toLowerCase();
  if (node.type === "function") {
    const name = node.name as { name?: { value?: string }[] } | string | undefined;
    if (typeof name === "string") return name.toLowerCase();
    return (name?.name ?? [])
      .map((part) => part.value ?? "")
      .join(".")
      .toLowerCase();
  }
  return null;
}

/** Checks the LLM's SQL; returns the SQL to run (filtered tables, LIMIT at most 200) and each result column's lineage. */
export function guardReadQuery(map: SchemaMap, sql: string): { sql: string; columns: ResultColumn[] } {
  const options = { database: map.dialect === "postgres" ? "PostgresQL" : "MySQL" };
  const allowed = allowedOf(map);
  let ast: unknown;
  try {
    ast = parser.astify(sql, options);
  } catch {
    throw new ReadQueryRejected("the SQL does not parse");
  }
  const statements = Array.isArray(ast) ? ast : [ast];
  if (statements.length !== 1) throw new ReadQueryRejected("exactly one statement");
  const select = statements[0] as Record<string, unknown>;
  if (select.type !== "select") throw new ReadQueryRejected("only SELECT");
  if (select.with) throw new ReadQueryRejected("no WITH");
  let into = false;
  walk(select, (node) => {
    const position = (node.into as { position?: unknown } | undefined)?.position;
    if (position !== undefined && position !== null) into = true;
  });
  if (into) throw new ReadQueryRejected("no INTO");

  const tables = parser.tableList(sql, options).map((entry) => entry.split("::"));
  const used = new Set<string>();
  for (const [kind, schema, table] of tables) {
    if (kind !== "select") throw new ReadQueryRejected("only reads");
    if (schema && schema !== "null") throw new ReadQueryRejected("no schema-qualified tables");
    if (!table || !allowed.tables.has(table))
      throw new ReadQueryRejected(`table ${table} is not in the confirmed map`);
    used.add(table);
  }
  // Output names may be used in ORDER BY and HAVING.
  const outputs = new Set(
    ((select.columns as { as?: string | null }[] | undefined) ?? [])
      .map((column) => column.as)
      .filter(Boolean) as string[],
  );
  for (const entry of parser.columnList(sql, options)) {
    const [, table, column] = entry.split("::");
    if (!column || column === "(.*)") throw new ReadQueryRejected("name the columns (no *)");
    if (table && table !== "null") {
      if (!allowed.tables.get(table)?.has(column))
        throw new ReadQueryRejected(`column ${table}.${column} is not confirmed`);
    } else if (!outputs.has(column) && ![...used].some((name) => allowed.tables.get(name)?.has(column))) {
      throw new ReadQueryRejected(`column ${column} is not confirmed`);
    }
  }
  walk(select, (node) => {
    const name = functionName(node);
    if (name !== null && !ALLOWED_FUNCTIONS.has(name))
      throw new ReadQueryRejected(`function ${name} is not allowed`);
  });

  // LIMIT: added, or capped at 200 (on every part of a set operation).
  let part: Record<string, unknown> | undefined = select;
  while (part) {
    const limit = part.limit as { value?: { type: string; value: number }[] } | undefined;
    const current = limit?.value?.[0]?.value;
    if (typeof current !== "number" || current > READ_LIMIT) {
      part.limit = { seperator: "", value: [{ type: "number", value: READ_LIMIT }] };
    }
    part = part._next as Record<string, unknown> | undefined;
  }

  // Lineage (D18): a mapped column, or SUM/MIN/MAX/AVG of one, takes its value scale; COUNT is a count.
  const aliases = new Map<string, string>();
  walk(select.from, (node) => {
    if (typeof node.table === "string" && used.has(node.table))
      aliases.set(typeof node.as === "string" ? node.as : node.table, node.table);
  });
  const resolve = (ref: Record<string, unknown>) => {
    const column = ((ref.column as { expr?: { value?: string } } | string | undefined) ?? "") as
      { expr?: { value?: string } } | string;
    const name = typeof column === "string" ? column : (column.expr?.value ?? "");
    const table =
      typeof ref.table === "string"
        ? (aliases.get(ref.table) ?? ref.table)
        : [...used].find((t) => allowed.tables.get(t)?.has(name));
    return { name, field: table ? allowed.fields.get(`${table}.${name}`) : undefined };
  };
  const columns = ((select.columns as Record<string, unknown>[] | undefined) ?? []).map(
    (column, position): ResultColumn => {
      const expr = column.expr as Record<string, unknown>;
      let key = typeof column.as === "string" ? column.as : `column_${position + 1}`;
      let kind: ResultKind = "unscaled";
      let valueScale = 1;
      const lineage = (ref: Record<string, unknown>) => {
        const { name, field } = resolve(ref);
        if (typeof column.as !== "string") key = name || key;
        if (field) {
          kind =
            field.kind === "money" || field.kind === "quantity"
              ? field.kind
              : field.kind === "time"
                ? "date"
                : field.kind === "number"
                  ? "number"
                  : "text";
          valueScale = field.valueScale;
        }
      };
      if (expr?.type === "column_ref") lineage(expr);
      else if (expr?.type === "aggr_func") {
        const name = String(expr.name).toLowerCase();
        if (name === "count") kind = "count";
        else if (["sum", "min", "max", "avg"].includes(name)) {
          const inner = (expr.args as { expr?: Record<string, unknown> } | undefined)?.expr;
          if (inner?.type === "column_ref") lineage(inner);
        }
      }
      return { key, kind, valueScale };
    },
  );

  const ctes = [...used].sort().map((table) => filteredTable(map, table));
  return { sql: `WITH ${ctes.join(", ")} ${parser.sqlify(select as never, options)}`, columns };
}

/** Runs a guarded query read-only (the caller's transaction has the 5 s limit) and scales its values. */
export async function runReadQuery(map: SchemaMap, run: RunQuery, sql: string): Promise<ReadQueryResult> {
  const guarded = guardReadQuery(map, sql);
  const raw = await run({ text: guarded.sql, values: [] });
  const rows = raw.map((row) => {
    const values = Object.values(row);
    return Object.fromEntries(
      guarded.columns.map((column, index) => {
        const value = row[column.key] ?? values[index];
        if (column.kind === "money") return [column.key, toPaisa(value, column.valueScale)];
        if (column.kind === "quantity") return [column.key, toUnits(value, column.valueScale)];
        if (column.kind === "count") return [column.key, value === null ? null : Number(value)];
        return [column.key, value];
      }),
    );
  });
  return { sql: guarded.sql, columns: guarded.columns, rows, truncated: rows.length >= READ_LIMIT };
}
