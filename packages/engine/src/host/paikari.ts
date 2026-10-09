import type { Catalog } from "./catalog";
import { toTaka } from "./find-parts";
import type { RunQuery } from "./pool";
import { hasField, type SchemaMap } from "./schema-map";
import { buildQuery } from "./sql";

// Which of the app's trade prices is paikari (D143, D146). The owner only ever sees two price kinds, khuchra and
// paikari (D145); an app with both a garage and a wholesale price column is asked once which one is paikari, each shown
// as the app names it with one part's price in it. Until the owner chooses: the garage price, else the wholesale price.

export type PaikariField = "garage_price" | "wholesale_price";
export const PAIKARI_FIELDS: readonly PaikariField[] = ["garage_price", "wholesale_price"];

export interface PaikariOption {
  field: PaikariField;
  /** The column as the app names it ("dealer_rate"). */
  column: string;
  example: { part: string; taka: number } | null;
}

/**
 * The map's trade price columns, each with an example: the same part for every column, one whose prices differ when
 * there is one, so the owner sees at once which number is the paikari price. Without a query runner (the app did not
 * answer), the columns come without examples.
 */
export async function paikariOptions(
  map: SchemaMap,
  run: RunQuery | null,
  catalog: Catalog,
): Promise<PaikariOption[]> {
  const fields = PAIKARI_FIELDS.filter((field) => hasField(map, "Price", field));
  if (!fields.length) return [];
  const names = new Map(catalog.parts.map((part) => [part.hostId, part.nameBn ?? part.name]));
  let example: Record<string, unknown> | undefined;
  if (run && hasField(map, "Price", "part_id")) {
    const rows = await run(
      buildQuery(map, {
        from: { concept: "Price", alias: "pr" },
        select: [
          { ref: { alias: "pr", field: "part_id" }, as: "part_id" },
          ...fields.map((field) => ({ ref: { alias: "pr", field }, as: field })),
        ],
        where: fields.map((field) => ({ ref: { alias: "pr", field }, op: "not_null" as const })),
        limit: 50,
      }),
    );
    const known = rows.filter((row) => names.has(String(row.part_id)));
    const differ = (row: Record<string, unknown>) =>
      new Set(fields.map((field) => String(toTaka(row[field])))).size === fields.length;
    example = known.find(differ) ?? known[0];
  }
  return fields.map((field) => {
    const taka = example ? toTaka(example[field]) : null;
    return {
      field,
      column: map.entities.Price!.fields[field]!.hostColumn,
      example:
        example && taka !== null ? { part: names.get(String(example.part_id))!, taka: Number(taka) } : null,
    };
  });
}

/** The owner's choice, if it is still one of the map's columns; otherwise the default rule applies. */
export function chosenPaikari(map: SchemaMap | null, chosen: string | null): PaikariField | null {
  if (!map || !chosen) return null;
  return PAIKARI_FIELDS.find((field) => field === chosen && hasField(map, "Price", field)) ?? null;
}
