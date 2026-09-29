import { describe, expect, it } from "vitest";
import { quotedValues, type IntrospectedColumn, type IntrospectedTable } from "./introspect";
import { checkProposal, proposalSchema } from "./mapper";
import { repairProposal } from "./repair";

// The mapper's repairs (spec 11.3), on a schema unlike the first host's, with the mistakes a real LLM made on it:
// names held as links, a part number on the part's own key, missing rack and part numbers, a status used as a
// field, a reference to the wrong table, and missing filters for inactive, voided and reversed rows.

const col = (
  name: string,
  dataType: string,
  extra: Partial<IntrospectedColumn> = {},
): IntrospectedColumn => ({
  name,
  dataType,
  nullable: true,
  primaryKey: false,
  references: null,
  ...extra,
});
const key = (name = "id") => col(name, "uuid", { primaryKey: true, nullable: false });
const link = (name: string, table: string) => col(name, "uuid", { references: { table, column: "id" } });
const deleted = () => col("deleted_at", "timestamp with time zone");
const table = (name: string, columns: IntrospectedColumn[]): IntrospectedTable => ({
  name,
  columns,
  samples: [],
});

const tables: IntrospectedTable[] = [
  table("goods", [
    key(),
    col("title", "text"),
    link("group_id", "groups"),
    link("maker_id", "makers"),
    col("shelf", "text"),
    col("min_stock", "integer"),
    col("active", "boolean"),
    deleted(),
  ]),
  table("goods_codes", [key(), link("goods_id", "goods"), col("number", "text"), deleted()]),
  table("groups", [key(), col("name", "text")]),
  table("makers", [key(), col("label", "text")]),
  table("stock", [link("goods_id", "goods"), col("qty", "numeric")]),
  table("bills", [
    key(),
    col("status", "text", { values: ["done", "void"] }),
    col("total", "bigint"),
    deleted(),
  ]),
  table("bill_lines", [key(), link("bill_id", "bills"), link("goods_id", "goods"), col("qty", "numeric")]),
  table("receipts", [key(), col("status", "text", { values: ["ok", "reversed"] }), col("amount", "bigint")]),
];

const on = (left: string, right: string) => [{ left, right }];
const field = (concept_field: string, host: string) => {
  const [host_table, host_column] = host.split(".");
  return { concept_field, host_table: host_table!, host_column: host_column! };
};

const llmAnswer = proposalSchema.parse({
  entities: [
    {
      concept: "Part",
      host_table: "goods",
      row_filters: [{ table: "goods", column: "deleted_at", op: "is_null" }],
      fields: [
        field("id", "goods.id"),
        field("name", "goods.title"),
        field("category", "goods.group_id"),
        field("brand", "goods.maker_id"),
        field("part_number", "goods.id"),
      ],
    },
    {
      concept: "StockItem",
      host_table: "stock",
      joins: [{ table: "goods", on: on("stock.goods_id", "goods.id") }],
      fields: [field("part_id", "stock.goods_id"), field("quantity", "stock.qty")],
    },
    {
      concept: "Sale",
      host_table: "bills",
      fields: [field("id", "bills.id"), field("total", "bills.total"), field("payment_type", "bills.status")],
    },
    {
      concept: "SaleItem",
      host_table: "bill_lines",
      joins: [{ table: "bills", on: on("bill_lines.bill_id", "bills.id") }],
      fields: [
        field("sale_id", "bill_lines.bill_id"),
        field("part_id", "bill_lines.bill_id"),
        field("quantity", "bill_lines.qty"),
      ],
    },
    {
      concept: "Payment",
      host_table: "receipts",
      fields: [field("id", "receipts.id"), field("amount", "receipts.amount")],
    },
  ],
});

const repaired = repairProposal(checkProposal(llmAnswer, tables), tables);
const entity = (concept: string) => repaired.entities.find((candidate) => candidate.concept === concept)!;
const where = (concept: string, name: string) => {
  const mapped = entity(concept).fields[name];
  return mapped ? `${mapped.hostTable}.${mapped.hostColumn}` : undefined;
};
const filters = (concept: string) =>
  entity(concept).rowFilters.map(
    (f) => `${f.table}.${f.column} ${f.op}${f.value == null ? "" : ` ${String(f.value)}`}`,
  );

describe("schema mapper repairs (spec 11.3)", () => {
  it("follows a name held as a link to the linked table's name, through a parent join", () => {
    expect(where("Part", "category")).toBe("groups.name");
    expect(where("Part", "brand")).toBe("makers.label");
    expect(entity("Part").joins).toEqual(
      expect.arrayContaining([
        { table: "groups", on: on("goods.group_id", "groups.id"), kind: "parent" },
        { table: "makers", on: on("goods.maker_id", "makers.id"), kind: "parent" },
      ]),
    );
  });

  it("drops a value on a key or a status, and a reference that links elsewhere", () => {
    expect(where("Part", "id")).toBe("goods.id");
    expect(where("Sale", "payment_type")).toBeUndefined();
    expect(where("SaleItem", "part_id")).toBeUndefined();
    expect(where("SaleItem", "sale_id")).toBe("bill_lines.bill_id");
    expect(where("StockItem", "part_id")).toBe("stock.goods_id");
  });

  it("finds part numbers in a child table, and the rack and reorder level on the part's table", () => {
    expect(where("Part", "part_number")).toBe("goods_codes.number");
    expect(entity("Part").joins).toContainEqual({
      table: "goods_codes",
      on: on("goods.id", "goods_codes.goods_id"),
      kind: "child",
    });
    expect(where("StockItem", "rack_location")).toBe("goods.shelf");
    expect(where("StockItem", "reorder_level")).toBe("goods.min_stock");
  });

  it("leaves out inactive master records, deleted rows, and voided or reversed transactions, lines as their sale", () => {
    expect(filters("Part")).toEqual(
      expect.arrayContaining([
        "goods.deleted_at is_null",
        "goods.active is_true",
        "goods_codes.deleted_at is_null",
      ]),
    );
    expect(filters("StockItem")).toEqual([]); // a discontinued part in stock still counts
    expect(filters("Sale")).toEqual(
      expect.arrayContaining(["bills.deleted_at is_null", "bills.status ne void"]),
    );
    expect(filters("SaleItem")).toEqual(
      expect.arrayContaining(["bills.deleted_at is_null", "bills.status ne void"]),
    );
    expect(filters("Payment")).toEqual(["receipts.status ne reversed"]);
  });

  it("joins a linked table the proposal forgot to join, instead of dropping its field", () => {
    const forgot = checkProposal(
      proposalSchema.parse({
        entities: [
          { concept: "Part", host_table: "goods", fields: [field("part_number", "goods_codes.number")] },
        ],
      }),
      tables,
    );
    expect(forgot.entities[0]?.fields.part_number).toMatchObject({
      hostTable: "goods_codes",
      hostColumn: "number",
    });
    expect(forgot.entities[0]?.joins).toEqual([
      { table: "goods_codes", on: on("goods.id", "goods_codes.goods_id"), kind: "child" },
    ]);
    expect(forgot.warnings).toEqual(["Part: join to goods_codes added for part_number"]);
  });

  it("never reads money as paisa, however large: every connected app keeps taka (D110)", () => {
    const priced = [
      table("items", [key(), col("price", "bigint"), col("cost", "bigint")]),
      table("people", [key(), col("owed", "bigint")]),
    ];
    priced[0]!.samples = [{ price: "450000" }, { price: "180000" }, { price: "65000" }];
    const raw = proposalSchema.parse({
      entities: [
        {
          concept: "Price",
          host_table: "items",
          fields: [
            field("part_id", "items.id"),
            field("retail_price", "items.price"),
            field("cost", "items.cost"),
          ],
        },
        { concept: "Customer", host_table: "people", fields: [field("due_balance", "people.owed")] },
      ],
    });
    const result = repairProposal(checkProposal(raw, priced), priced);
    expect(result.warnings.filter((warning) => warning.startsWith("money"))).toEqual([]);
    for (const entity of result.entities)
      for (const mapped of Object.values(entity.fields)) expect(mapped).not.toHaveProperty("valueScale");
  });

  it("reads a status column's allowed values from a CHECK rule or an enum type", () => {
    expect(quotedValues("CHECK ((status = ANY (ARRAY['completed'::text, 'reversed'::text])))")).toEqual([
      "completed",
      "reversed",
    ]);
    expect(quotedValues("enum('ok','it''s void')")).toEqual(["ok", "it's void"]);
  });

  it("names every repair in the warnings, for the owner's review", () => {
    expect(repaired.warnings).toEqual(
      expect.arrayContaining([
        "Part.category: goods.group_id is a link; groups.name used",
        "Part.part_number: goods.id is a key, dropped",
        "Part.part_number: goods_codes.number added",
        "Sale.payment_type: bills.status is a status, dropped",
        "SaleItem.part_id: bill_lines.bill_id does not link to goods, dropped",
        "SaleItem: row filter bills.status ne void added (as its Sale)",
      ]),
    );
  });
});
