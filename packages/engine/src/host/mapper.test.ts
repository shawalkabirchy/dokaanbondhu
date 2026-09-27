import { describe, expect, it } from "vitest";
import type { LlmDelta, LlmProvider } from "../providers";
import type { IntrospectedTable } from "./introspect";
import { columnHint, proposeSchemaMap, spokenSamples } from "./mapper";

const tables: IntrospectedTable[] = [
  {
    name: "items",
    columns: [
      { name: "id", dataType: "uuid", nullable: false, primaryKey: true, references: null },
      { name: "title", dataType: "text", nullable: false, primaryKey: false, references: null },
      { name: "price_retail", dataType: "bigint", nullable: true, primaryKey: false, references: null },
      {
        name: "deleted_at",
        dataType: "timestamp with time zone",
        nullable: true,
        primaryKey: false,
        references: null,
      },
      { name: "is_active", dataType: "boolean", nullable: false, primaryKey: false, references: null },
    ],
    samples: [
      { id: "a1", title: "Front brake pad set", price_retail: "450000", deleted_at: null, is_active: "true" },
      { id: "a2", title: "Oil filter", price_retail: "65000", deleted_at: null, is_active: "true" },
    ],
  },
  {
    name: "stock",
    columns: [
      {
        name: "item_id",
        dataType: "uuid",
        nullable: false,
        primaryKey: false,
        references: { table: "items", column: "id" },
      },
      { name: "qty_milli", dataType: "bigint", nullable: false, primaryKey: false, references: null },
    ],
    samples: [{ item_id: "a1", qty_milli: "3000" }],
  },
];

function stubLlm(responses: string[]): LlmProvider & { calls: number } {
  const provider = {
    id: "stub",
    external: false,
    calls: 0,
    async *stream(): AsyncIterable<LlmDelta> {
      const text = responses[provider.calls] ?? "";
      provider.calls += 1;
      yield { type: "start" };
      yield { type: "text", text };
      yield { type: "finish", reason: "stop" };
    },
  };
  return provider;
}

const good = JSON.stringify({
  entities: [
    {
      concept: "Part",
      host_table: "items",
      row_filters: [
        { table: "items", column: "deleted_at", op: "is_null" },
        { table: "items", column: "is_active", op: "is_true" },
        { table: "items", column: "no_such", op: "is_null" },
      ],
      fields: [
        { concept_field: "id", host_table: "items", host_column: "id" },
        { concept_field: "name", host_table: "items", host_column: "title" },
        { concept_field: "colour", host_table: "items", host_column: "title" },
      ],
    },
    {
      concept: "Price",
      host_table: "items",
      fields: [
        { concept_field: "part_id", host_table: "items", host_column: "id" },
        { concept_field: "retail_price", host_table: "items", host_column: "price_retail", value_scale: 100 },
      ],
    },
    {
      concept: "StockItem",
      host_table: "stock",
      fields: [
        { concept_field: "part_id", host_table: "stock", host_column: "item_id" },
        { concept_field: "quantity", host_table: "stock", host_column: "qty_milli", value_scale: 1000 },
      ],
    },
    { concept: "Customer", host_table: "clients", fields: [] },
  ],
});

describe("schema mapper (spec 11.3)", () => {
  it("hints money, quantities, links, soft deletes and active flags from names", () => {
    const [items, stock] = tables;
    const hint = (table: IntrospectedTable, name: string) =>
      columnHint(
        table,
        table.columns.find((column) => column.name === name)!,
      );
    expect(hint(items!, "price_retail")).toBe("money");
    expect(hint(items!, "deleted_at")).toMatch(/soft delete/);
    expect(hint(items!, "is_active")).toBe("active flag");
    expect(hint(stock!, "item_id")).toBe("link to items.id");
    expect(hint(stock!, "qty_milli")).toBe("quantity");
  });

  it("keeps what matches the database and drops the rest with a warning", async () => {
    const llm = stubLlm([`Here you go:\n\`\`\`json\n${good}\n\`\`\``]);
    const proposal = await proposeSchemaMap([llm], tables);
    expect(proposal.entities.map((entity) => entity.concept)).toEqual(["Part", "Price", "StockItem"]);
    const part = proposal.entities[0]!;
    expect(part.rowFilters).toHaveLength(2);
    expect(Object.keys(part.fields)).toEqual(["id", "name"]);
    expect(part.fields.id).toMatchObject({ idType: "uuid", confirmed: false });
    expect(proposal.warnings).toEqual([
      "Part: row filter on items.no_such dropped",
      "Part.colour: not a field of the concept",
      "Customer: unknown table clients",
    ]);
  });

  it("asks once more when the first answer is not valid JSON", async () => {
    const llm = stubLlm(["not json", good]);
    const proposal = await proposeSchemaMap([llm], tables);
    expect(llm.calls).toBe(2);
    expect(proposal.entities).toHaveLength(3);
  });

  it("shows sample values as they will be spoken, so a wrong scale shows at once", async () => {
    const proposal = await proposeSchemaMap([stubLlm([good])], tables);
    const price = proposal.entities.find((entity) => entity.concept === "Price")!;
    expect(spokenSamples(price, price.fields.retail_price!, tables)).toEqual(["৪,৫০০ টাকা", "৬৫০ টাকা"]);
    const stock = proposal.entities.find((entity) => entity.concept === "StockItem")!;
    expect(spokenSamples(stock, stock.fields.quantity!, tables)).toEqual(["৩"]);
  });
});
