import { describe, expect, it } from "vitest";
import { SchemaMapError } from "./schema-map";
import { buildQuery, type QuerySpec } from "./sql";
import { testMap } from "./test-map";

const partsWithStock: QuerySpec = {
  from: { concept: "Part", alias: "p" },
  joins: [
    {
      entity: { concept: "Fitment", alias: "f" },
      kind: "inner",
      on: [{ left: { alias: "f", field: "part_id" }, right: { alias: "p", field: "id" } }],
    },
    {
      entity: { concept: "StockItem", alias: "s" },
      kind: "left",
      on: [{ left: { alias: "s", field: "part_id" }, right: { alias: "p", field: "id" } }],
    },
  ],
  select: [
    { ref: { alias: "p", field: "id" }, as: "part_id" },
    { ref: { alias: "p", field: "name" }, as: "name" },
    { ref: { alias: "s", field: "quantity" }, as: "stock" },
    { ref: { alias: "s", field: "rack_location" }, as: "rack" },
  ],
  where: [
    { ref: { alias: "p", field: "id" }, op: "in", values: ["a", "b"] },
    { ref: { alias: "f", field: "vehicle_id" }, op: "in", values: ["v1"] },
    { ref: { alias: "p", field: "quality" }, op: "eq", value: "genuine" },
  ],
  limit: 20,
};

describe("buildQuery (spec 11.2)", () => {
  it("renders PostgreSQL with quoted names, $n parameters and every row filter", () => {
    const built = buildQuery(testMap("postgres"), partsWithStock);
    expect(built.text).toBe(
      'SELECT "p"."id" AS "part_id", "p"."title" AS "name", "s"."qty" AS "stock", "s__items"."shelf" AS "rack" ' +
        'FROM "items" AS "p" ' +
        'JOIN "item_cars" AS "f" ON "f"."item_id" = "p"."id" ' +
        'LEFT JOIN "stock" AS "s" ON "s"."item_id" = "p"."id" ' +
        'LEFT JOIN "items" AS "s__items" ON "s"."item_id" = "s__items"."id" ' +
        'WHERE "p"."deleted_at" IS NULL AND "p"."is_active" IS TRUE ' +
        'AND ("f"."status" IS NULL OR "f"."status" <> $1) ' +
        'AND "p"."id" = ANY($2) AND "f"."car_id" = ANY($3) AND "p"."grade" = $4 LIMIT 20',
    );
    expect(built.values).toEqual(["removed", ["a", "b"], ["v1"], "genuine"]);
    expect(built.columns.find((column) => column.as === "stock")).toMatchObject({ kind: "quantity" });
  });

  it("renders MySQL with backticks and ? parameters in text order", () => {
    const built = buildQuery(testMap("mysql"), partsWithStock);
    expect(built.text).toContain("FROM `items` AS `p`");
    expect(built.text).toContain("`p`.`id` IN (?, ?) AND `f`.`car_id` IN (?) AND `p`.`grade` = ?");
    expect(built.values).toEqual(["removed", "a", "b", "v1", "genuine"]);
  });

  it("joins an entity's own table only when one of its fields is used", () => {
    const names = buildQuery(testMap(), {
      from: { concept: "Part", alias: "p" },
      select: [{ ref: { alias: "p", field: "name" }, as: "name" }],
    });
    expect(names.text).not.toContain("item_codes");
    const numbers = buildQuery(testMap(), {
      from: { concept: "Part", alias: "p" },
      select: [
        { ref: { alias: "p", field: "id" }, as: "id" },
        { ref: { alias: "p", field: "part_number" }, as: "numbers", aggregate: "list" },
      ],
      groupBy: [{ alias: "p", field: "id" }],
    });
    expect(numbers.text).toBe(
      'SELECT "p"."id" AS "id", array_agg(DISTINCT "p__item_codes"."code") AS "numbers" FROM "items" AS "p" ' +
        'LEFT JOIN "item_codes" AS "p__item_codes" ON "p"."id" = "p__item_codes"."item_id" AND "p__item_codes"."deleted_at" IS NULL ' +
        'WHERE "p"."deleted_at" IS NULL AND "p"."is_active" IS TRUE GROUP BY "p"."id"',
    );
  });

  it("always applies a parent's filters, so lines of a voided sale never count (D17)", () => {
    const built = buildQuery(testMap(), {
      from: { concept: "SaleItem", alias: "l" },
      select: [{ ref: { alias: "l", field: "quantity" }, as: "qty", aggregate: "sum" }],
    });
    expect(built.text).toBe(
      'SELECT SUM("l"."qty") AS "qty" FROM "bill_lines" AS "l" ' +
        'LEFT JOIN "bills" AS "l__bills" ON "l"."bill_id" = "l__bills"."id" ' +
        'WHERE ("l__bills"."id" IS NULL OR ("l__bills"."state" IS NULL OR "l__bills"."state" <> $1))',
    );
    expect(built.values).toEqual(["void"]);
  });

  it("keeps a part without a brand: an entity's own lookups are left joins", () => {
    const map = testMap();
    map.entities.Part!.joins.push({ table: "makers", on: [{ left: "items.maker_id", right: "makers.id" }] });
    map.entities.Part!.fields.brand = {
      conceptField: "brand",
      hostTable: "makers",
      hostColumn: "name",
      dataType: null,
      idType: null,
      confirmed: true,
    };
    const built = buildQuery(map, {
      from: { concept: "Part", alias: "p" },
      select: [{ ref: { alias: "p", field: "brand" }, as: "brand" }],
    });
    expect(built.text).toContain('LEFT JOIN "makers" AS "p__makers" ON "p"."maker_id" = "p__makers"."id"');
  });

  it("accepts only confirmed entities and fields, and safe aliases", () => {
    const map = testMap();
    map.entities.Customer!.fields.name!.confirmed = false;
    expect(() =>
      buildQuery(map, {
        from: { concept: "Customer", alias: "c" },
        select: [{ ref: { alias: "c", field: "name" }, as: "n" }],
      }),
    ).toThrow(SchemaMapError);
    expect(() =>
      buildQuery(testMap(), {
        from: { concept: "Sale", alias: "s" },
        select: [{ ref: { alias: "s", field: "id" }, as: "id" }],
      }),
    ).toThrow(SchemaMapError);
    expect(() => buildQuery(testMap(), { from: { concept: "Part", alias: 'p"; drop' }, select: [] })).toThrow(
      SchemaMapError,
    );
  });

  it("doubles quote characters inside names", () => {
    const map = testMap("mysql");
    map.entities.Customer!.fields.name!.hostColumn = "na`me";
    const built = buildQuery(map, {
      from: { concept: "Customer", alias: "c" },
      select: [{ ref: { alias: "c", field: "name" }, as: "name" }],
    });
    expect(built.text).toContain("`c`.`na``me`");
  });
});
