// The shop's schema map (spec 7.2, 11.3): which host tables and columns hold each concept. Only confirmed entities
// and fields are ever queried. Nothing here names a host.

export const CONCEPTS = [
  "Part",
  "Vehicle",
  "Fitment",
  "StockItem",
  "Price",
  "Customer",
  "Sale",
  "SaleItem",
  "Return",
  "Payment",
  "Supplier",
  "Purchase",
] as const;
export type Concept = (typeof CONCEPTS)[number];

/** How a concept field's values are read: money as whole taka (D110), quantity as units. */
export type FieldKind = "id" | "ref" | "text" | "money" | "quantity" | "number" | "boolean" | "time";

/** The fields each concept can have (architecture, standard spare parts concepts), with their kind. */
export const CONCEPT_FIELDS: Record<Concept, Record<string, FieldKind>> = {
  Part: {
    id: "id",
    name: "text",
    name_bn: "text",
    category: "text",
    part_number: "text",
    brand: "text",
    quality: "text",
    position: "text",
    unit: "text",
    pack_size: "quantity",
    vehicle_type: "text",
    notes: "text",
  },
  Vehicle: {
    id: "id",
    vehicle_type: "text",
    make: "text",
    model: "text",
    year_from: "number",
    year_to: "number",
    engine_code: "text",
    body: "text",
  },
  Fitment: { part_id: "ref", vehicle_id: "ref", note: "text", verified: "boolean" },
  StockItem: { part_id: "ref", quantity: "quantity", rack_location: "text", reorder_level: "quantity" },
  Price: {
    part_id: "ref",
    retail_price: "money",
    garage_price: "money",
    wholesale_price: "money",
    cost: "money",
    valid_from: "time",
  },
  Customer: {
    id: "id",
    name: "text",
    name_bn: "text",
    type: "text",
    price_tier: "text",
    phone: "text",
    due_balance: "money",
    credit_limit: "money",
  },
  Sale: {
    id: "id",
    date_time: "time",
    customer_id: "ref",
    total: "money",
    paid: "money",
    due: "money",
    payment_type: "text",
  },
  SaleItem: { sale_id: "ref", part_id: "ref", quantity: "quantity", unit_price: "money" },
  Return: {
    id: "id",
    sale_id: "ref",
    part_id: "ref",
    quantity: "quantity",
    reason: "text",
    date_time: "time",
  },
  Payment: {
    id: "id",
    customer_id: "ref",
    amount: "money",
    date_time: "time",
    method: "text",
    trx_id: "text",
  },
  Supplier: { id: "id", name: "text", name_bn: "text", phone: "text", payable_balance: "money" },
  Purchase: {
    id: "id",
    supplier_id: "ref",
    date_time: "time",
    part_id: "ref",
    quantity: "quantity",
    cost: "money",
  },
};

export type Dialect = "postgres" | "mysql";

export interface RowFilter {
  table: string;
  column: string;
  op: "is_null" | "eq" | "ne" | "is_true";
  value?: string | number | boolean | null;
}

export interface JoinMap {
  table: string;
  /** Columns as "table.column". */
  on: { left: string; right: string }[];
  /**
   * parent: the entity's table points to the joined row (a sale line's sale, a part's brand); always joined, and
   * a row is left out when its parent exists and fails a filter. child: the joined rows point to the entity (a
   * part's numbers); joined only when one of its fields is used, and its filters only trim that list. When missing,
   * a join is a parent when the entity's own column ends in _id.
   */
  kind?: "parent" | "child";
}

/** A join's kind, and the joined table's column that is null when there is no joined row. */
export function joinShape(
  entity: { hostTable: string },
  join: JoinMap,
): { kind: "parent" | "child"; presence: string } {
  const pair = join.on[0];
  if (!pair) return { kind: "child", presence: `${join.table}.id` };
  const [own, other] = pair.left.startsWith(`${join.table}.`)
    ? [pair.right, pair.left]
    : [pair.left, pair.right];
  const kind =
    join.kind ?? (own.startsWith(`${entity.hostTable}.`) && own.endsWith("_id") ? "parent" : "child");
  return { kind, presence: other };
}

export interface FieldMap {
  conceptField: string;
  hostTable: string;
  hostColumn: string;
  dataType: string | null;
  idType: "integer" | "uuid" | "text" | null;
  confirmed: boolean;
}

export interface EntityMap {
  concept: Concept;
  hostTable: string;
  joins: JoinMap[];
  rowFilters: RowFilter[];
  confirmed: boolean;
  fields: Record<string, FieldMap>;
}

export interface SchemaMap {
  dialect: Dialect;
  entities: Partial<Record<Concept, EntityMap>>;
}

export class SchemaMapError extends Error {}

/** A confirmed entity, or an error naming what is not confirmed. */
export function confirmedEntity(map: SchemaMap, concept: Concept): EntityMap {
  const entity = map.entities[concept];
  if (!entity?.confirmed) throw new SchemaMapError(`${concept} is not confirmed in the schema map`);
  return entity;
}

/** A confirmed field of a confirmed entity. */
export function confirmedField(map: SchemaMap, concept: Concept, field: string): FieldMap {
  const found = confirmedEntity(map, concept).fields[field];
  if (!found?.confirmed) throw new SchemaMapError(`${concept}.${field} is not confirmed in the schema map`);
  return found;
}

/** Whether a confirmed field exists (optional fields such as garage_price). */
export function hasField(map: SchemaMap, concept: Concept, field: string): boolean {
  const entity = map.entities[concept];
  return Boolean(entity?.confirmed && entity.fields[field]?.confirmed);
}
