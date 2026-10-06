import type { EntityMap, FieldMap, SchemaMap } from "../src/host/schema-map";

// Test shop B's schema map as its owner would confirm it (D122; tools/fixtures/shop-b): MySQL, other names, models
// without a make and with their years as text, a part-to-car table for some items only, stock per branch and a
// price history.

type Spec = string | [table: string, column: string];

function fields(table: string, pairs: Record<string, Spec>): Record<string, FieldMap> {
  return Object.fromEntries(
    Object.entries(pairs).map(([conceptField, spec]) => {
      const [hostTable, hostColumn] = typeof spec === "string" ? [table, spec] : spec;
      return [
        conceptField,
        { conceptField, hostTable, hostColumn, dataType: null, idType: null, confirmed: true },
      ];
    }),
  );
}

const live = (table: string) => ({ table, column: "is_deleted", op: "eq" as const, value: 0 });
const entity = (value: Omit<EntityMap, "confirmed">): EntityMap => ({ ...value, confirmed: true });

export const shopBMap: SchemaMap = {
  dialect: "mysql",
  entities: {
    Part: entity({
      concept: "Part",
      hostTable: "items",
      joins: [
        { table: "item_codes", on: [{ left: "items.item_id", right: "item_codes.item_id" }], kind: "child" },
        {
          table: "item_groups",
          on: [{ left: "items.group_id", right: "item_groups.group_id" }],
          kind: "parent",
        },
      ],
      rowFilters: [live("items")],
      fields: fields("items", {
        id: "item_id",
        name: "item_name",
        category: ["item_groups", "title"],
        part_number: ["item_codes", "code"],
        quality: "grade",
        position: "side",
        unit: "uom",
        notes: "remarks",
      }),
    }),
    Vehicle: entity({
      concept: "Vehicle",
      hostTable: "car_models",
      joins: [],
      rowFilters: [],
      fields: fields("car_models", {
        id: "model_id",
        model: "model_name",
        year_from: "years",
        engine_code: "engine",
      }),
    }),
    Fitment: entity({
      concept: "Fitment",
      hostTable: "item_cars",
      joins: [],
      rowFilters: [],
      fields: fields("item_cars", { part_id: "item_id", vehicle_id: "model_id" }),
    }),
    StockItem: entity({
      concept: "StockItem",
      hostTable: "branch_stock",
      joins: [],
      rowFilters: [],
      fields: fields("branch_stock", { part_id: "item_id", quantity: "qty", rack_location: "shelf" }),
    }),
    Price: entity({
      concept: "Price",
      hostTable: "item_prices",
      joins: [],
      rowFilters: [],
      fields: fields("item_prices", {
        part_id: "item_id",
        retail_price: "sale_rate",
        garage_price: "workshop_rate",
        wholesale_price: "dealer_rate",
        cost: "cost_rate",
        valid_from: "effective_from",
      }),
    }),
    Customer: entity({
      concept: "Customer",
      hostTable: "parties",
      joins: [],
      rowFilters: [live("parties")],
      fields: fields("parties", {
        id: "party_id",
        name: "party_name",
        type: "party_kind",
        phone: "mobile",
        due_balance: "balance",
      }),
    }),
    Supplier: entity({
      concept: "Supplier",
      hostTable: "vendors",
      joins: [],
      rowFilters: [],
      fields: fields("vendors", { id: "vendor_id", name: "vendor_name", phone: "phone" }),
    }),
  },
};
