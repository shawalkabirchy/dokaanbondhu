import {
  CONCEPT_FIELDS,
  confirmedEntity,
  confirmedField,
  SchemaMapError,
  type Concept,
  type Dialect,
  type EntityMap,
  type FieldKind,
  type RowFilter,
  type SchemaMap,
} from "./schema-map";

// The SQL builder (spec 11.2): the only code that builds SQL for a host. Names come only from the confirmed schema
// map and are quoted per dialect; every value is a parameter. An entity's own joins are added only when a field of
// the joined table is used, and every row filter of each table used applies (D17, D21).

export interface ColumnRef {
  alias: string;
  field: string;
}

type Scalar = string | number | boolean | bigint | null;

export type Condition =
  | { ref: ColumnRef; op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte"; value: Scalar }
  | { ref: ColumnRef; op: "in"; values: readonly Scalar[] }
  | { ref: ColumnRef; op: "is_null" | "not_null" | "is_true" }
  | { ref: ColumnRef; op: "contains"; value: string };

export interface EntityUse {
  concept: Concept;
  alias: string;
}

export interface SelectItem {
  ref: ColumnRef;
  as: string;
  aggregate?: "sum" | "count" | "min" | "max" | "list";
}

export interface QuerySpec {
  from: EntityUse;
  joins?: { entity: EntityUse; kind: "inner" | "left"; on: { left: ColumnRef; right: ColumnRef }[] }[];
  select: SelectItem[];
  where?: Condition[];
  groupBy?: ColumnRef[];
  orderBy?: { as: string; direction: "asc" | "desc" }[];
  limit?: number;
}

export interface OutputColumn {
  as: string;
  concept: Concept;
  field: string;
  kind: FieldKind;
  valueScale: number;
  aggregate?: SelectItem["aggregate"];
}

export interface BuiltQuery {
  text: string;
  values: unknown[];
  columns: OutputColumn[];
}

export function quoteName(dialect: Dialect, name: string): string {
  return dialect === "postgres" ? `"${name.replaceAll('"', '""')}"` : `\`${name.replaceAll("`", "``")}\``;
}

const ALIAS = /^[a-z][a-z0-9_]{0,30}$/;

class Builder {
  readonly values: unknown[] = [];
  /** Per query alias: the entity and the joined tables it needs. */
  private readonly uses = new Map<string, { entity: EntityMap; tables: Set<string> }>();

  constructor(
    private readonly map: SchemaMap,
    private readonly dialect: Dialect,
  ) {}

  q(name: string): string {
    return quoteName(this.dialect, name);
  }

  param(value: unknown): string {
    this.values.push(typeof value === "bigint" ? value.toString() : value);
    return this.dialect === "postgres" ? `$${this.values.length}` : "?";
  }

  register(use: EntityUse): void {
    if (!ALIAS.test(use.alias)) throw new SchemaMapError(`bad alias ${use.alias}`);
    if (this.uses.has(use.alias)) throw new SchemaMapError(`alias ${use.alias} used twice`);
    this.uses.set(use.alias, { entity: confirmedEntity(this.map, use.concept), tables: new Set() });
  }

  /** The SQL for a concept field, noting the joined table it needs. */
  column(ref: ColumnRef): string {
    const use = this.uses.get(ref.alias);
    if (!use) throw new SchemaMapError(`unknown alias ${ref.alias}`);
    const field = confirmedField(this.map, use.entity.concept, ref.field);
    if (field.hostTable !== use.entity.hostTable) {
      if (!use.entity.joins.some((join) => join.table === field.hostTable)) {
        throw new SchemaMapError(
          `${use.entity.concept}.${ref.field}: table ${field.hostTable} is not joined`,
        );
      }
      use.tables.add(field.hostTable);
    }
    return `${this.q(this.tableAlias(ref.alias, use.entity, field.hostTable))}.${this.q(field.hostColumn)}`;
  }

  tableAlias(alias: string, entity: EntityMap, table: string): string {
    return table === entity.hostTable ? alias : `${alias}__${table}`;
  }

  filter(alias: string, entity: EntityMap, filter: RowFilter): string {
    const column = `${this.q(this.tableAlias(alias, entity, filter.table))}.${this.q(filter.column)}`;
    switch (filter.op) {
      case "is_null":
        return `${column} IS NULL`;
      case "is_true":
        return `${column} IS TRUE`;
      case "eq":
        return `${column} = ${this.param(filter.value)}`;
      case "ne":
        return `(${column} IS NULL OR ${column} <> ${this.param(filter.value)})`;
    }
  }

  condition(condition: Condition): string {
    const column = this.column(condition.ref);
    switch (condition.op) {
      case "is_null":
        return `${column} IS NULL`;
      case "not_null":
        return `${column} IS NOT NULL`;
      case "is_true":
        return `${column} IS TRUE`;
      case "in":
        if (condition.values.length === 0) return "1 = 0";
        if (this.dialect === "postgres")
          return `${column} = ANY(${this.param(condition.values.map(String))})`;
        return `${column} IN (${condition.values.map((value) => this.param(value)).join(", ")})`;
      case "contains":
        return this.dialect === "postgres"
          ? `${column} ILIKE ${this.param(`%${condition.value}%`)}`
          : `${column} LIKE ${this.param(`%${condition.value}%`)}`;
      default: {
        const ops = { eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" } as const;
        return `${column} ${ops[condition.op]} ${this.param(condition.value)}`;
      }
    }
  }

  /**
   * FROM or JOIN text of one entity use, with the joined tables it needs and their row filters. The row filters of
   * a FROM or inner-joined entity's own table go to WHERE (returned as deferred, so positional parameters stay in
   * text order); a left-joined entity keeps them in its ON clause.
   */
  entitySql(
    alias: string,
    kind: "from" | "inner" | "left",
    on: string[],
  ): { sql: string; deferred: (() => string)[] } {
    const use = this.uses.get(alias);
    if (!use) throw new SchemaMapError(`unknown alias ${alias}`);
    const { entity, tables } = use;
    const primaryFilters = entity.rowFilters.filter((filter) => filter.table === entity.hostTable);
    const primary = `${this.q(entity.hostTable)} AS ${this.q(alias)}`;
    const parts: string[] = [];
    const deferred = primaryFilters.map((filter) => () => this.filter(alias, entity, filter));
    if (kind === "from") {
      parts.push(`FROM ${primary}`);
    } else if (kind === "inner") {
      parts.push(`JOIN ${primary} ON ${on.join(" AND ")}`);
    } else {
      parts.push(`LEFT JOIN ${primary} ON ${[...on, ...deferred.map((render) => render())].join(" AND ")}`);
      deferred.length = 0;
    }
    for (const join of entity.joins) {
      if (!tables.has(join.table)) continue;
      const joinAlias = this.tableAlias(alias, entity, join.table);
      const onColumns = join.on.map(
        ({ left, right }) =>
          `${this.hostColumn(alias, entity, left)} = ${this.hostColumn(alias, entity, right)}`,
      );
      const filters = entity.rowFilters
        .filter((filter) => filter.table === join.table)
        .map((filter) => this.filter(alias, entity, filter));
      const joinKind = kind === "left" ? "LEFT JOIN" : "JOIN";
      parts.push(
        `${joinKind} ${this.q(join.table)} AS ${this.q(joinAlias)} ON ${[...onColumns, ...filters].join(" AND ")}`,
      );
    }
    return { sql: parts.join(" "), deferred };
  }

  /** "table.column" of an entity's join definition, as SQL. */
  hostColumn(alias: string, entity: EntityMap, qualified: string): string {
    const dot = qualified.lastIndexOf(".");
    if (dot <= 0) throw new SchemaMapError(`bad join column ${qualified}`);
    const table = qualified.slice(0, dot);
    if (table !== entity.hostTable && !entity.joins.some((join) => join.table === table)) {
      throw new SchemaMapError(`join column ${qualified} is outside ${entity.concept}`);
    }
    return `${this.q(this.tableAlias(alias, entity, table))}.${this.q(qualified.slice(dot + 1))}`;
  }

  aggregate(sql: string, aggregate: SelectItem["aggregate"]): string {
    switch (aggregate) {
      case undefined:
        return sql;
      case "list":
        return this.dialect === "postgres" ? `array_agg(DISTINCT ${sql})` : `JSON_ARRAYAGG(${sql})`;
      default:
        return `${aggregate.toUpperCase()}(${sql})`;
    }
  }
}

/** Builds one query over the confirmed schema map: { text, values } plus what each output column holds. */
export function buildQuery(map: SchemaMap, spec: QuerySpec): BuiltQuery {
  const b = new Builder(map, map.dialect);
  const uses = [spec.from, ...(spec.joins ?? []).map((join) => join.entity)];
  uses.forEach((use) => b.register(use));
  // 1. Touch every column, so each entity knows the joined tables it needs (columns are never parameters).
  const refs = [
    ...spec.select.map((item) => item.ref),
    ...(spec.joins ?? []).flatMap((join) => join.on.flatMap(({ left, right }) => [left, right])),
    ...(spec.groupBy ?? []),
    ...(spec.where ?? []).map((condition) => condition.ref),
  ];
  refs.forEach((ref) => b.column(ref));
  // 2. Render in text order, so positional parameters (MySQL's ?) line up with their values.
  const select = spec.select.map(
    (item) => `${b.aggregate(b.column(item.ref), item.aggregate)} AS ${b.q(item.as)}`,
  );
  const from = b.entitySql(spec.from.alias, "from", []);
  const joins = (spec.joins ?? []).map((join) =>
    b.entitySql(
      join.entity.alias,
      join.kind,
      join.on.map(({ left, right }) => `${b.column(left)} = ${b.column(right)}`),
    ),
  );
  const where = [
    ...[from, ...joins].flatMap((part) => part.deferred.map((render) => render())),
    ...(spec.where ?? []).map((condition) => b.condition(condition)),
  ];
  let text = `SELECT ${select.join(", ")} ${from.sql}`;
  for (const join of joins) text += ` ${join.sql}`;
  if (where.length) text += ` WHERE ${where.join(" AND ")}`;
  if (spec.groupBy?.length) text += ` GROUP BY ${spec.groupBy.map((ref) => b.column(ref)).join(", ")}`;
  if (spec.orderBy?.length) {
    const orders = spec.orderBy.map(
      (order) => `${b.q(order.as)} ${order.direction === "desc" ? "DESC" : "ASC"}`,
    );
    text += ` ORDER BY ${orders.join(", ")}`;
  }
  const values = b.values;
  if (spec.limit !== undefined) {
    if (!Number.isInteger(spec.limit) || spec.limit < 1 || spec.limit > 10_000)
      throw new SchemaMapError("bad limit");
    text += ` LIMIT ${spec.limit}`;
  }

  const columns = spec.select.map((item) => {
    const concept = uses.find((entry) => entry.alias === item.ref.alias)?.concept as Concept;
    const field = confirmedField(map, concept, item.ref.field);
    return {
      as: item.as,
      concept,
      field: item.ref.field,
      kind:
        item.aggregate === "count"
          ? ("number" as const)
          : (CONCEPT_FIELDS[concept][item.ref.field] ?? "text"),
      valueScale: item.aggregate === "count" ? 1 : field.valueScale,
      ...(item.aggregate ? { aggregate: item.aggregate } : {}),
    };
  });
  return { text, values, columns };
}
