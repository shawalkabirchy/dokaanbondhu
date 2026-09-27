import type { ToolDef } from "../providers";
import { CONCEPT_FIELDS, type SchemaMap } from "../host/schema-map";

// The tools the LLM sees (spec 9.6). Five are always offered (run_read_query only with a confirmed DB connection);
// capability tools join with the write path. The LLM never writes host IDs or final numbers: every argument is a
// string as the user said it.

const partQuery = {
  type: "object",
  properties: {
    part_type: { type: "string", description: "the part as said, e.g. সামনের প্যাড, self, mobil filter" },
    vehicle: { type: "string", description: "the car model as said, e.g. এক্সিও, noah" },
    year: { type: "string", description: "the model year as said" },
    engine: { type: "string", description: "the engine code as said" },
    position: { type: "string", description: "front, rear, left or right, as said" },
    quality: { type: "string", description: "genuine, non-genuine, reconditioned, as said" },
    brand: { type: "string", description: "the brand as said" },
    part_number: { type: "string", description: "a part number, as said" },
  },
  additionalProperties: false,
} as const;

const fn = (name: string, description: string, parameters: Record<string, unknown>): ToolDef => ({
  type: "function",
  function: { name, description, parameters },
});

export const FIND_PARTS = fn(
  "find_parts",
  "Find parts in the shop's stock for a vehicle: stock, price, rack and recorded fitment.",
  partQuery,
);

export const GET_REPORT = fn(
  "get_report",
  "The only way to answer profit, cash book or stock value. Never write SQL for these.",
  {
    type: "object",
    properties: {
      name: { type: "string", enum: ["stock_value", "profit_loss", "cash_book"] },
      from: { type: "string", description: "start date as said" },
      to: { type: "string", description: "end date as said" },
    },
    required: ["name"],
    additionalProperties: false,
  },
);

export const RESOLVE_CUSTOMER = fn("resolve_customer", "Find a customer by the name as said.", {
  type: "object",
  properties: { name: { type: "string" } },
  required: ["name"],
  additionalProperties: false,
});

export const ASK_USER = fn("ask_user", "Ask the user for one missing thing only.", {
  type: "object",
  properties: {
    slot: { type: "string", description: "what is missing, e.g. year, quality, customer" },
    question: { type: "string" },
    options: { type: "array", items: { type: "string" } },
  },
  required: ["slot", "question"],
  additionalProperties: false,
});

/** run_read_query, described with the confirmed tables and columns the SQL may use. */
export function readQueryTool(map: SchemaMap): ToolDef {
  const tables = new Map<string, Set<string>>();
  for (const entity of Object.values(map.entities)) {
    if (!entity?.confirmed) continue;
    for (const field of Object.values(entity.fields)) {
      if (!field.confirmed) continue;
      const kind = CONCEPT_FIELDS[entity.concept][field.conceptField];
      tables.set(
        field.hostTable,
        (tables.get(field.hostTable) ?? new Set()).add(
          `${field.hostColumn} (${entity.concept}.${field.conceptField}${kind === "money" || kind === "quantity" ? `, ${kind}` : ""})`,
        ),
      );
    }
    for (const join of entity.joins) {
      for (const pair of join.on) {
        for (const side of [pair.left, pair.right]) {
          const dot = side.lastIndexOf(".");
          const table = side.slice(0, dot);
          if (!tables.has(table)) continue;
          const column = side.slice(dot + 1);
          if (![...(tables.get(table) ?? [])].some((entry) => entry.startsWith(`${column} `)))
            tables.get(table)!.add(column);
        }
      }
    }
  }
  const schema = [...tables.entries()]
    .map(([table, columns]) => `${table}(${[...columns].join(", ")})`)
    .join("; ");
  return fn(
    "run_read_query",
    `Answer other reads (dues, sales, low stock, which cars a part fits) with one SELECT over these tables and columns only: ${schema}. Deleted, voided and reversed rows are left out for you.`,
    {
      type: "object",
      properties: { sql: { type: "string" }, purpose: { type: "string" } },
      required: ["sql", "purpose"],
      additionalProperties: false,
    },
  );
}

export function readTools(map: SchemaMap | null): ToolDef[] {
  return [FIND_PARTS, ...(map ? [readQueryTool(map)] : []), GET_REPORT, RESOLVE_CUSTOMER, ASK_USER];
}
