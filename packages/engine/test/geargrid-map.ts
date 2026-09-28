import type { EntityMap, FieldMap, SchemaMap } from "../src/host/schema-map";

// GearGrid's schema map as the owner confirms it (spec 5.2), for integration tests against the CI copy of GearGrid.
// Money is whole taka (value scale 1, D92); quantities are numeric (scale 1).

type Spec = string | [table: string, column: string, scale?: number];

function fields(table: string, pairs: Record<string, Spec>): Record<string, FieldMap> {
  return Object.fromEntries(
    Object.entries(pairs).map(([conceptField, spec]) => {
      const [hostTable, hostColumn, valueScale = 1] = typeof spec === "string" ? [table, spec] : spec;
      return [
        conceptField,
        { conceptField, hostTable, hostColumn, dataType: null, idType: null, valueScale, confirmed: true },
      ];
    }),
  );
}

const deleted = (table: string) => ({ table, column: "deleted_at", op: "is_null" as const });
const entity = (value: Omit<EntityMap, "confirmed">): EntityMap => ({ ...value, confirmed: true });

export const geargridMap: SchemaMap = {
  dialect: "postgres",
  entities: {
    Part: entity({
      concept: "Part",
      hostTable: "parts",
      joins: [
        { table: "part_numbers", on: [{ left: "parts.id", right: "part_numbers.part_id" }], kind: "child" },
        { table: "brands", on: [{ left: "parts.brand_id", right: "brands.id" }], kind: "parent" },
        { table: "categories", on: [{ left: "parts.category_id", right: "categories.id" }], kind: "parent" },
      ],
      rowFilters: [
        deleted("parts"),
        { table: "parts", column: "is_active", op: "is_true" },
        deleted("part_numbers"),
      ],
      fields: fields("parts", {
        id: "id",
        name: "name_en",
        name_bn: "name_bn",
        category: ["categories", "name_en"],
        part_number: ["part_numbers", "number"],
        brand: ["brands", "name"],
        quality: "quality",
        position: "position",
        unit: "unit",
        pack_size: "pack_size",
        vehicle_type: "vehicle_type",
        notes: "notes",
      }),
    }),
    Vehicle: entity({
      concept: "Vehicle",
      hostTable: "vehicles",
      joins: [],
      rowFilters: [deleted("vehicles")],
      fields: fields("vehicles", {
        id: "id",
        vehicle_type: "vehicle_type",
        make: "make",
        model: "model",
        year_from: "year_from",
        year_to: "year_to",
        engine_code: "engine_code",
        body: "body",
      }),
    }),
    Fitment: entity({
      concept: "Fitment",
      hostTable: "fitments",
      joins: [],
      rowFilters: [deleted("fitments")],
      fields: fields("fitments", {
        part_id: "part_id",
        vehicle_id: "vehicle_id",
        note: "note",
        verified: "verified",
      }),
    }),
    StockItem: entity({
      concept: "StockItem",
      hostTable: "stock_levels",
      joins: [{ table: "parts", on: [{ left: "stock_levels.part_id", right: "parts.id" }], kind: "parent" }],
      rowFilters: [],
      fields: fields("stock_levels", {
        part_id: "part_id",
        quantity: "quantity",
        rack_location: ["parts", "rack_location"],
        reorder_level: ["parts", "reorder_level"],
      }),
    }),
    Price: entity({
      concept: "Price",
      hostTable: "parts",
      joins: [],
      rowFilters: [],
      fields: fields("parts", {
        part_id: "id",
        retail_price: ["parts", "retail_price"],
        garage_price: ["parts", "garage_price"],
        wholesale_price: ["parts", "wholesale_price"],
        cost: ["parts", "avg_cost"],
      }),
    }),
    Customer: entity({
      concept: "Customer",
      hostTable: "customers",
      joins: [],
      rowFilters: [deleted("customers")],
      fields: fields("customers", {
        id: "id",
        name: "name",
        type: "type",
        price_tier: "price_tier",
        phone: "phone",
        due_balance: ["customers", "due_balance"],
        credit_limit: ["customers", "credit_limit"],
      }),
    }),
    Sale: entity({
      concept: "Sale",
      hostTable: "sales",
      joins: [],
      rowFilters: [deleted("sales"), { table: "sales", column: "status", op: "ne", value: "void" }],
      fields: fields("sales", {
        id: "id",
        date_time: "sale_time",
        customer_id: "customer_id",
        total: ["sales", "total"],
        paid: ["sales", "paid"],
        due: ["sales", "due"],
      }),
    }),
    SaleItem: entity({
      concept: "SaleItem",
      hostTable: "sale_items",
      joins: [{ table: "sales", on: [{ left: "sale_items.sale_id", right: "sales.id" }], kind: "parent" }],
      rowFilters: [deleted("sale_items"), { table: "sales", column: "status", op: "ne", value: "void" }],
      fields: fields("sale_items", {
        sale_id: "sale_id",
        part_id: "part_id",
        quantity: "quantity",
        unit_price: ["sale_items", "unit_price"],
      }),
    }),
    Payment: entity({
      concept: "Payment",
      hostTable: "customer_payments",
      joins: [],
      rowFilters: [
        deleted("customer_payments"),
        { table: "customer_payments", column: "status", op: "ne", value: "reversed" },
      ],
      fields: fields("customer_payments", {
        id: "id",
        customer_id: "customer_id",
        amount: ["customer_payments", "amount"],
        date_time: "received_at",
        method: "method",
        trx_id: "trx_id",
      }),
    }),
    Supplier: entity({
      concept: "Supplier",
      hostTable: "suppliers",
      joins: [],
      rowFilters: [deleted("suppliers")],
      fields: fields("suppliers", {
        id: "id",
        name: "name",
        phone: "phone",
        payable_balance: ["suppliers", "payable_balance"],
      }),
    }),
  },
};
