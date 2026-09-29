import type { Dialect, EntityMap, FieldMap, SchemaMap } from "./schema-map";

// A confirmed schema map shaped like a typical host (tables and columns invented for tests), used by unit tests.

function fields(table: string, pairs: Record<string, string | [string, string]>): Record<string, FieldMap> {
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

export function testMap(dialect: Dialect = "postgres"): SchemaMap {
  const entity = (value: Omit<EntityMap, "confirmed">): EntityMap => ({ ...value, confirmed: true });
  return {
    dialect,
    entities: {
      Part: entity({
        concept: "Part",
        hostTable: "items",
        joins: [{ table: "item_codes", on: [{ left: "items.id", right: "item_codes.item_id" }] }],
        rowFilters: [
          { table: "items", column: "deleted_at", op: "is_null" },
          { table: "items", column: "is_active", op: "is_true" },
          { table: "item_codes", column: "deleted_at", op: "is_null" },
        ],
        fields: fields("items", {
          id: "id",
          name: "title",
          name_bn: "title_bn",
          quality: "grade",
          position: "side",
          unit: "unit",
          part_number: ["item_codes", "code"],
          notes: "remarks",
        }),
      }),
      Vehicle: entity({
        concept: "Vehicle",
        hostTable: "cars",
        joins: [],
        rowFilters: [],
        fields: fields("cars", {
          id: "id",
          make: "make",
          model: "model",
          year_from: "from_year",
          year_to: "to_year",
        }),
      }),
      Fitment: entity({
        concept: "Fitment",
        hostTable: "item_cars",
        joins: [],
        rowFilters: [{ table: "item_cars", column: "status", op: "ne", value: "removed" }],
        fields: fields("item_cars", { part_id: "item_id", vehicle_id: "car_id", verified: "checked" }),
      }),
      StockItem: entity({
        concept: "StockItem",
        hostTable: "stock",
        joins: [{ table: "items", on: [{ left: "stock.item_id", right: "items.id" }] }],
        rowFilters: [],
        fields: fields("stock", {
          part_id: "item_id",
          quantity: ["stock", "qty"],
          rack_location: ["items", "shelf"],
        }),
      }),
      Price: entity({
        concept: "Price",
        hostTable: "items",
        joins: [],
        rowFilters: [],
        fields: fields("items", {
          part_id: "id",
          retail_price: ["items", "price_retail"],
          garage_price: ["items", "price_garage"],
        }),
      }),
      SaleItem: entity({
        concept: "SaleItem",
        hostTable: "bill_lines",
        joins: [{ table: "bills", on: [{ left: "bill_lines.bill_id", right: "bills.id" }] }],
        rowFilters: [{ table: "bills", column: "state", op: "ne", value: "void" }],
        fields: fields("bill_lines", { sale_id: "bill_id", part_id: "item_id", quantity: "qty" }),
      }),
      Customer: entity({
        concept: "Customer",
        hostTable: "clients",
        joins: [],
        rowFilters: [{ table: "clients", column: "deleted_at", op: "is_null" }],
        fields: fields("clients", { id: "id", name: "name", due_balance: ["clients", "due"] }),
      }),
    },
  };
}
