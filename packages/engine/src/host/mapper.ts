import { banglaDigits, formatTaka } from "@dokaanbondhu/core";
import { z } from "zod";
import { llmStream, type LlmProvider } from "../providers";
import type { IntrospectedTable } from "./introspect";
import { toTaka, toUnits } from "./find-parts";
import { repairProposal } from "./repair";
import { CONCEPT_FIELDS, CONCEPTS, type Concept, type EntityMap, type FieldMap } from "./schema-map";

// Schema mapper, step 2 (spec 11.3): name heuristics, then one LLM call that returns the proposal JSON, validated
// with zod and checked against the introspected tables. Anything that names an unknown table, column or field is
// dropped with a warning. The owner confirms each concept in the setup wizard.

const filterSchema = z.object({
  table: z.string(),
  column: z.string(),
  op: z.enum(["is_null", "eq", "ne", "is_true"]),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
});

export const proposalSchema = z.object({
  entities: z.array(
    z.object({
      concept: z.enum(CONCEPTS),
      host_table: z.string(),
      joins: z
        .array(
          z.object({
            table: z.string(),
            on: z.array(z.object({ left: z.string(), right: z.string() })).min(1),
          }),
        )
        .default([]),
      row_filters: z.array(filterSchema).default([]),
      fields: z.array(
        z.object({
          concept_field: z.string(),
          host_table: z.string(),
          host_column: z.string(),
        }),
      ),
    }),
  ),
});

export interface Proposal {
  entities: EntityMap[];
  warnings: string[];
}

/** Hints from column names and types, given to the LLM with the schema (spec 11.3: heuristics first). */
export function columnHint(
  table: IntrospectedTable,
  column: IntrospectedTable["columns"][number],
): string | null {
  const name = column.name.toLowerCase();
  const numeric = /int|numeric|decimal|real|double|float|money/.test(column.dataType.toLowerCase());
  if (column.references) return `link to ${column.references.table}.${column.references.column}`;
  if (column.primaryKey) return "primary key";
  if (/(^|_)(deleted|removed)(_at|_on)?$|^is_deleted$/.test(name))
    return "soft delete: keep rows where empty";
  if (/^(is_)?active$|^enabled$/.test(name)) return "active flag";
  if (name === "status" && table.samples.some((row) => /void|cancel|revers/i.test(row[column.name] ?? ""))) {
    return "status with void or reversed rows";
  }
  if (numeric && /(price|cost|total|paid|due|amount|balance|limit|payable)/.test(name)) return "money";
  if (numeric && /(qty|quantity|stock|reorder)/.test(name)) return "quantity";
  return null;
}

function schemaText(tables: IntrospectedTable[]): string {
  return tables
    .map((table) => {
      const columns = table.columns.map((column) => {
        const samples = [
          ...new Set(table.samples.map((row) => row[column.name]).filter((v) => v !== null)),
        ].slice(0, 3);
        const hint = columnHint(table, column);
        const values = column.values?.length ? ` values: ${column.values.join(" | ")}` : "";
        return `  ${column.name} ${column.dataType}${hint ? ` [${hint}]` : ""}${values || (samples.length ? ` e.g. ${samples.join(" | ")}` : "")}`;
      });
      return `${table.name}\n${columns.join("\n")}`;
    })
    .join("\n");
}

const CONCEPT_TEXT = CONCEPTS.map(
  (concept) =>
    `${concept}: ${Object.entries(CONCEPT_FIELDS[concept])
      .map(([field, kind]) => `${field} (${kind})`)
      .join(", ")}`,
).join("\n");

export const MAPPER_PROMPT = `You map a car spare parts shop's database to standard concepts. Reply with JSON only, no prose:
{"entities":[{"concept":"Part","host_table":"...","joins":[{"table":"...","on":[{"left":"table.column","right":"table.column"}]}],"row_filters":[{"table":"...","column":"...","op":"is_null|eq|ne|is_true","value":"..."}],"fields":[{"concept_field":"...","host_table":"...","host_column":"..."}]}]}

Concepts and their fields (kind in brackets):
${CONCEPT_TEXT}

Rules:
- At most one entity per concept; leave out a concept the database does not have. host_table holds one row per item.
- A field may live in a joined table; list that table in joins, with "on" as "table.column" pairs.
- row_filters leave out deleted, inactive, voided and reversed rows: is_null for a deleted_at column, is_true for an
  active flag, ne with the value for a status such as void. Filters may name the host_table or a joined table.
  A sale line repeats its sale's filters (join the sale's table).
- A text field such as category or brand is a name. When the table holds only a link (category_id), join the linked
  table and use its name column.
- A ..._id field (part_id, customer_id, sale_id, supplier_id, vehicle_id) is the column that links to that concept's
  table, or that table's own key when the entity lives in the same table. Never map a field to an unrelated key.
- part_number may live in a separate table of numbers per part, and rack_location on the part's table: join them.
- Use only the tables and columns listed. Do not invent fields that are not in the concept list.`;

/** Collects the LLM's text and parses the JSON object in it. */
async function askJson(providers: LlmProvider[], schema: string): Promise<unknown> {
  let text = "";
  for await (const delta of llmStream(
    providers,
    {
      messages: [
        { role: "system", content: MAPPER_PROMPT },
        { role: "user", content: `The database:\n${schema}` },
      ],
      temperature: 0,
      maxTokens: 6000,
    },
    { startTimeoutMs: 15_000, deadlineMs: 180_000 },
  )) {
    if (delta.type === "text") text += delta.text;
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("the model returned no JSON");
  return JSON.parse(text.slice(start, end + 1));
}

function idType(dataType: string): FieldMap["idType"] {
  const type = dataType.toLowerCase();
  if (type.includes("uuid")) return "uuid";
  if (/int/.test(type)) return "integer";
  return "text";
}

/** Checks a proposal against the introspected tables; drops what names unknown things. */
export function checkProposal(raw: z.infer<typeof proposalSchema>, tables: IntrospectedTable[]): Proposal {
  const warnings: string[] = [];
  const byName = new Map(tables.map((table) => [table.name, table]));
  const column = (table: string, name: string) => byName.get(table)?.columns.find((c) => c.name === name);
  const qualified = (text: string) => {
    const dot = text.lastIndexOf(".");
    return dot > 0 ? column(text.slice(0, dot), text.slice(dot + 1)) : undefined;
  };
  /** A join from the entity's table to a table a key links it with: parent when it points there, else child. */
  const linkJoin = (host: string, table: string): EntityMap["joins"][number] | null => {
    const up = byName.get(host)?.columns.find((c) => c.references?.table === table);
    if (up)
      return {
        table,
        on: [{ left: `${host}.${up.name}`, right: `${table}.${up.references!.column}` }],
        kind: "parent",
      };
    const down = byName.get(table)?.columns.find((c) => c.references?.table === host);
    if (down) {
      return {
        table,
        on: [{ left: `${host}.${down.references!.column}`, right: `${table}.${down.name}` }],
        kind: "child",
      };
    }
    return null;
  };
  const entities: EntityMap[] = [];
  const seen = new Set<Concept>();
  for (const entity of raw.entities) {
    if (seen.has(entity.concept)) {
      warnings.push(`${entity.concept}: proposed twice, the first kept`);
      continue;
    }
    if (!byName.has(entity.host_table)) {
      warnings.push(`${entity.concept}: unknown table ${entity.host_table}`);
      continue;
    }
    const joins = entity.joins
      .filter((join) => {
        const ok =
          byName.has(join.table) && join.on.every((pair) => qualified(pair.left) && qualified(pair.right));
        if (!ok) warnings.push(`${entity.concept}: join to ${join.table} dropped`);
        return ok;
      })
      .map((join) => {
        // From the foreign keys: the entity's table pointing at the joined table makes it a parent.
        const own = byName.get(entity.host_table)?.columns ?? [];
        const parent = own.some((c) => c.references?.table === join.table);
        const child = (byName.get(join.table)?.columns ?? []).some(
          (c) => c.references?.table === entity.host_table,
        );
        return parent || child ? { ...join, kind: parent ? ("parent" as const) : ("child" as const) } : join;
      });
    const tablesOfEntity = new Set([entity.host_table, ...joins.map((join) => join.table)]);
    // A table the proposal uses but forgot to join is joined when a key links it with the entity's table.
    const joinIfLinked = (table: string, what: string): boolean => {
      if (tablesOfEntity.has(table)) return true;
      const join = linkJoin(entity.host_table, table);
      if (!join) return false;
      joins.push(join);
      tablesOfEntity.add(table);
      warnings.push(`${entity.concept}: join to ${table} added for ${what}`);
      return true;
    };
    const rowFilters = entity.row_filters.filter((filter) => {
      const ok =
        column(filter.table, filter.column) !== undefined &&
        joinIfLinked(filter.table, `the filter on ${filter.column}`);
      if (!ok) warnings.push(`${entity.concept}: row filter on ${filter.table}.${filter.column} dropped`);
      return ok;
    });
    const fields: Record<string, FieldMap> = {};
    for (const field of entity.fields) {
      const found = column(field.host_table, field.host_column);
      if (!(field.concept_field in CONCEPT_FIELDS[entity.concept])) {
        warnings.push(`${entity.concept}.${field.concept_field}: not a field of the concept`);
        continue;
      }
      if (!found || !joinIfLinked(field.host_table, field.concept_field)) {
        warnings.push(
          `${entity.concept}.${field.concept_field}: ${field.host_table}.${field.host_column} dropped`,
        );
        continue;
      }
      fields[field.concept_field] = {
        conceptField: field.concept_field,
        hostTable: field.host_table,
        hostColumn: field.host_column,
        dataType: found.dataType,
        idType: ["id", "ref"].includes(CONCEPT_FIELDS[entity.concept][field.concept_field] ?? "")
          ? idType(found.dataType)
          : null,
        confirmed: false,
      };
    }
    seen.add(entity.concept);
    entities.push({
      concept: entity.concept,
      hostTable: entity.host_table,
      joins,
      rowFilters: rowFilters.map((filter) => ({ ...filter, value: filter.value ?? null })),
      confirmed: false,
      fields,
    });
  }
  return { entities, warnings };
}

/** Introspected tables -> a checked and repaired proposal. One retry if the model's JSON does not validate. */
export async function proposeSchemaMap(
  providers: LlmProvider[],
  tables: IntrospectedTable[],
): Promise<Proposal> {
  const schema = schemaText(tables);
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return repairProposal(
        checkProposal(proposalSchema.parse(await askJson(providers, schema)), tables),
        tables,
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** A field's sample values as they will be spoken (a price as "৪,২০০ টাকা"), so a wrong column shows at once. */
export function spokenSamples(entity: EntityMap, field: FieldMap, tables: IntrospectedTable[]): string[] {
  const table = tables.find((candidate) => candidate.name === field.hostTable);
  const kind = CONCEPT_FIELDS[entity.concept][field.conceptField];
  const values = (table?.samples ?? [])
    .map((row) => row[field.hostColumn])
    .filter((v): v is string => v !== null);
  return [...new Set(values)].slice(0, 3).map((value) => {
    // Money is whole taka (D110); a quantity is the number of units.
    const taka = kind === "money" ? toTaka(value) : null;
    if (taka !== null) return `${formatTaka(taka)} টাকা`;
    const units = kind === "quantity" ? toUnits(value) : null;
    if (units !== null) return banglaDigits(String(units));
    return value;
  });
}
