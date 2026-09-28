import type { IntrospectedColumn, IntrospectedTable } from "./introspect";
import type { Proposal } from "./mapper";
import {
  CONCEPT_FIELDS,
  type Concept,
  type EntityMap,
  type FieldMap,
  type JoinMap,
  type RowFilter,
} from "./schema-map";

// The schema mapper's checks after the LLM (spec 11.3, heuristics): mistakes an LLM makes on any host are repaired
// from the keys and column names, so the owner reviews a map that is right in its structure. Only the LLM's proposal
// is repaired; the owner's own corrections are taken as given. Every repair is a warning the review shows.

/** The concept a reference field points at. */
const REF_TARGET: Record<string, Concept> = {
  part_id: "Part",
  vehicle_id: "Vehicle",
  customer_id: "Customer",
  sale_id: "Sale",
  supplier_id: "Supplier",
};

/** Lines that belong to a header: they leave out what their header leaves out (a voided sale's lines). */
const OWNER: Partial<Record<Concept, Concept>> = { SaleItem: "Sale" };

/**
 * Records that an active flag switches off. A price or stock row on the same table still counts: a discontinued part
 * in stock keeps its value.
 */
const MASTER = new Set<Concept>(["Part", "Vehicle", "Customer", "Supplier"]);

const NAME_COLUMNS = ["name_en", "name", "title", "label", "display_name", "code"];
const SOFT_DELETE = /^(deleted|removed)_(at|on)$/i;
const ACTIVE_FLAG = /^(is_)?active$|^enabled$/i;
const STATUS_COLUMN = /^(status|state)$|_status$/i;
const VOID_VALUE = /^(void|voided|cancell?ed|reversed|deleted)$/i;
const TEXT_TYPE = /char|text|string/i;

/** Fields the LLM often leaves out, found by column name: where to look, and how. */
const FILL: { concept: Concept; field: string; pattern: RegExp; child?: boolean }[] = [
  {
    concept: "Part",
    field: "part_number",
    pattern: /^(number|part_number|part_no|oem_number|oem_no)$/i,
    child: true,
  },
  {
    concept: "StockItem",
    field: "rack_location",
    pattern: /^(rack|rack_location|shelf|bin|location|rack_no)$/i,
  },
  {
    concept: "StockItem",
    field: "reorder_level",
    pattern: /^(reorder_level|reorder_point|min_stock|minimum_stock)$/i,
  },
];

export function repairProposal(proposal: Proposal, tables: IntrospectedTable[]): Proposal {
  const warnings = [...proposal.warnings];
  const byName = new Map(tables.map((table) => [table.name, table]));
  const columnOf = (table: string, name: string): IntrospectedColumn | undefined =>
    byName.get(table)?.columns.find((column) => column.name === name);
  const primaryKey = (table: string) => byName.get(table)?.columns.find((column) => column.primaryKey);
  const hostOf = new Map(proposal.entities.map((entity) => [entity.concept, entity.hostTable]));
  const entities: EntityMap[] = proposal.entities.map((entity) => structuredClone(entity));

  const hasJoin = (entity: EntityMap, table: string) => entity.joins.some((join) => join.table === table);
  const addJoin = (entity: EntityMap, join: JoinMap) => {
    if (!hasJoin(entity, join.table)) entity.joins.push(join);
  };
  const addFilter = (entity: EntityMap, filter: RowFilter, why: string) => {
    const same = entity.rowFilters.some(
      (f) =>
        f.table === filter.table &&
        f.column === filter.column &&
        f.op === filter.op &&
        f.value === filter.value,
    );
    if (same) return;
    entity.rowFilters.push(filter);
    warnings.push(
      `${entity.concept}: row filter ${filter.table}.${filter.column} ${filter.op}${filter.value === null || filter.value === undefined ? "" : ` ${String(filter.value)}`} added (${why})`,
    );
  };
  const field = (table: string, column: IntrospectedColumn, conceptField: string, scale = 1): FieldMap => ({
    conceptField,
    hostTable: table,
    hostColumn: column.name,
    dataType: column.dataType,
    idType: null,
    valueScale: scale,
    confirmed: false,
  });
  /** A table's parent: the host table's link column pointing at it, as a join. */
  const parentJoin = (host: string, parent: string): JoinMap | null => {
    const link = byName.get(host)?.columns.find((column) => column.references?.table === parent);
    return link
      ? {
          table: parent,
          on: [{ left: `${host}.${link.name}`, right: `${parent}.${link.references!.column}` }],
          kind: "parent",
        }
      : null;
  };

  for (const entity of entities) {
    const kinds = CONCEPT_FIELDS[entity.concept];
    for (const [name, mapped] of Object.entries(entity.fields)) {
      const kind = kinds[name];
      const column = columnOf(mapped.hostTable, mapped.hostColumn);
      if (!kind || !column) continue;
      const where = `${mapped.hostTable}.${mapped.hostColumn}`;

      // A name held as a link (category_id): the linked table's name column, through a parent join.
      if (kind === "text" && column.references && mapped.hostTable === entity.hostTable) {
        const target = byName.get(column.references.table);
        const nameColumn =
          NAME_COLUMNS.map((candidate) => target?.columns.find((c) => c.name === candidate)).find(Boolean) ??
          target?.columns.find((c) => TEXT_TYPE.test(c.dataType) && !c.primaryKey && !c.references);
        if (target && nameColumn) {
          addJoin(entity, {
            table: target.name,
            on: [{ left: where, right: `${target.name}.${column.references.column}` }],
            kind: "parent",
          });
          entity.fields[name] = field(target.name, nameColumn, name);
          warnings.push(
            `${entity.concept}.${name}: ${where} is a link; ${target.name}.${nameColumn.name} used`,
          );
        } else {
          delete entity.fields[name];
          warnings.push(`${entity.concept}.${name}: ${where} is a link, dropped`);
        }
        continue;
      }

      // A reference must be the link to its concept's table, or that table's own key.
      if (kind === "ref") {
        const targetTable = hostOf.get(REF_TARGET[name] ?? ("" as Concept));
        if (!targetTable) continue;
        const ok =
          column.references?.table === targetTable || (mapped.hostTable === targetTable && column.primaryKey);
        if (!ok) {
          delete entity.fields[name];
          warnings.push(`${entity.concept}.${name}: ${where} does not link to ${targetTable}, dropped`);
        }
        continue;
      }

      // A value never lives in a key or in a status column.
      if (kind !== "id" && column.primaryKey) {
        delete entity.fields[name];
        warnings.push(`${entity.concept}.${name}: ${where} is a key, dropped`);
      } else if (STATUS_COLUMN.test(column.name) && !/status$/.test(name)) {
        delete entity.fields[name];
        warnings.push(`${entity.concept}.${name}: ${where} is a status, dropped`);
      }
    }

    // Fields the LLM left out, found by name in the host table, its parents, or (part numbers) a child table.
    for (const fill of FILL.filter((rule) => rule.concept === entity.concept && !entity.fields[rule.field])) {
      const host = byName.get(entity.hostTable);
      if (!host) continue;
      const numeric = CONCEPT_FIELDS[entity.concept][fill.field] !== "text";
      const fits = (column: IntrospectedColumn) =>
        fill.pattern.test(column.name) && TEXT_TYPE.test(column.dataType) !== numeric;
      const use = (table: IntrospectedTable, join: JoinMap | null) => {
        if (join) addJoin(entity, join);
        const column = table.columns.find(fits)!;
        entity.fields[fill.field] = field(table.name, column, fill.field);
        warnings.push(`${entity.concept}.${fill.field}: ${table.name}.${column.name} added`);
      };
      // The host table itself, then a table it links to (a part's rack on the parts table), then, for part
      // numbers, a table of numbers that links to it.
      if (host.columns.some(fits)) {
        use(host, null);
        continue;
      }
      const parent = host.columns
        .flatMap((column) => (column.references ? [byName.get(column.references.table)] : []))
        .find((table) => table?.columns.some(fits));
      const join = parent ? parentJoin(host.name, parent.name) : null;
      if (parent && join) {
        use(parent, join);
        continue;
      }
      const key = primaryKey(host.name);
      const child = fill.child
        ? tables.find(
            (table) =>
              table.columns.some((column) => column.references?.table === host.name) &&
              table.columns.some(fits),
          )
        : undefined;
      const link = child?.columns.find((column) => column.references?.table === host.name);
      if (child && link && key) {
        use(child, {
          table: child.name,
          on: [{ left: `${host.name}.${key.name}`, right: `${child.name}.${link.name}` }],
          kind: "child",
        });
      }
    }

    // Rows that must never count: soft-deleted rows of the host table and its child tables (a parent's are its own
    // entity's business), voided or reversed rows of the host table, and inactive master records.
    for (const table of [entity.hostTable, ...entity.joins.map((join) => join.table)]) {
      if (table !== entity.hostTable && entity.joins.find((join) => join.table === table)?.kind === "parent")
        continue;
      const deleted = byName.get(table)?.columns.find((column) => SOFT_DELETE.test(column.name));
      if (deleted)
        addFilter(entity, { table, column: deleted.name, op: "is_null", value: null }, "deleted rows");
    }
    const host = byName.get(entity.hostTable);
    const active = host?.columns.find(
      (column) => ACTIVE_FLAG.test(column.name) && /bool/i.test(column.dataType),
    );
    if (active && MASTER.has(entity.concept))
      addFilter(
        entity,
        { table: entity.hostTable, column: active.name, op: "is_true", value: null },
        "inactive rows",
      );
    for (const column of host?.columns ?? []) {
      for (const value of column.values ?? []) {
        if (VOID_VALUE.test(value)) {
          addFilter(
            entity,
            { table: entity.hostTable, column: column.name, op: "ne", value },
            `${value} rows`,
          );
        }
      }
    }
  }

  // Lines leave out what their header leaves out, through a parent join to the header's table.
  for (const entity of entities) {
    const ownerConcept = OWNER[entity.concept];
    const owner = entities.find((candidate) => candidate.concept === ownerConcept);
    if (!owner) continue;
    const join = hasJoin(entity, owner.hostTable) ? null : parentJoin(entity.hostTable, owner.hostTable);
    if (join) addJoin(entity, join);
    if (!hasJoin(entity, owner.hostTable)) continue;
    for (const filter of owner.rowFilters.filter((candidate) => candidate.table === owner.hostTable)) {
      addFilter(entity, { ...filter }, `as its ${ownerConcept}`);
    }
  }

  return { entities, warnings };
}
