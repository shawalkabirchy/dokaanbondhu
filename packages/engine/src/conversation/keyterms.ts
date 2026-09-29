import { isBangla, type Dictionary } from "@dokaanbondhu/core";
import type { Catalog } from "../host/catalog";
import type { SessionContext } from "./turn";

// Speech-recognition keyterms (spec 10.4, D99): at most 25 Bangla terms before each voice turn, most useful first; the
// speech worker keeps only what fits its 80-token budget, which is some 6 to 10 Bangla words. Part types are ranked by
// what the shop sold in the last 30 days (the catalog's sold_30d, summed over the parts whose name holds the type).
// With a current vehicle: the part types, then that vehicle's names. Without one: part types and the vehicle models in
// the catalog taken in turn, so both reach the prompt, then the garages with the most sales. Bangla forms only,
// because the model writes Bangla.

export const MAX_KEYTERMS = 25;

/** The Bangla spellings of each value of a concept, in dictionary order (the global glossary, then the shop's). */
function banglaWords(dictionary: Dictionary, concept: "part_type" | "vehicle_model"): Map<string, string[]> {
  const words = new Map<string, string[]>();
  for (const term of dictionary.terms) {
    if (term.concept !== concept || !isBangla(term.text)) continue;
    const list = words.get(term.value) ?? [];
    if (!list.includes(term.text)) list.push(term.text);
    words.set(term.value, list);
  }
  return words;
}

export function buildKeyterms(catalog: Catalog, dictionary: Dictionary, context: SessionContext): string[] {
  const out: string[] = [];
  const add = (word: string | undefined) => {
    if (word && out.length < MAX_KEYTERMS && !out.includes(word)) out.push(word);
  };

  // Part types by 30-day sales; a type the shop has no part of is left out.
  const types = banglaWords(dictionary, "part_type");
  const sales = [...types.keys()]
    .map((type) => {
      const needle = type.toLowerCase();
      const parts = catalog.parts.filter((part) => part.name.toLowerCase().includes(needle));
      const sold = parts.reduce((sum, part) => sum + (Number(part.attrs.sold_30d) || 0), 0);
      return { type, parts: parts.length, sold };
    })
    .filter((entry) => entry.parts > 0)
    .sort((a, b) => b.sold - a.sold || b.parts - a.parts);
  // Each type by its usual word (the first Bangla form).
  const typeWords = sales.map((entry) => types.get(entry.type)?.[0]);

  const models = banglaWords(dictionary, "vehicle_model");
  if (context.vehicle) {
    for (const word of typeWords.slice(0, MAX_KEYTERMS - 2)) add(word);
    for (const word of models.get(context.vehicle.model) ?? []) add(word);
    return out;
  }
  const inCatalog = new Map<string, number>();
  for (const vehicle of catalog.vehicles) {
    const name = `${vehicle.make} ${vehicle.model}`;
    inCatalog.set(name, (inCatalog.get(name) ?? 0) + 1);
  }
  const modelWords = [...inCatalog].sort((a, b) => b[1] - a[1]).map(([model]) => models.get(model)?.[0]);
  for (let i = 0; i < Math.max(typeWords.length, modelWords.length); i++) {
    add(typeWords[i]);
    add(modelWords[i]);
  }
  const garages = [...catalog.customers]
    .filter((customer) => customer.nameBn)
    .sort((a, b) => (Number(b.attrs.sales_30d) || 0) - (Number(a.attrs.sales_30d) || 0));
  for (const garage of garages) add(garage.nameBn ?? undefined);
  return out;
}
