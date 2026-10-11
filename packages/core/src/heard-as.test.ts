import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAmount, saysCredit } from "./actions";
import { buildDictionary, matchConcept, type AliasConcept } from "./glossary";
import { parseYear } from "./numbers";
import { resolveCustomer, type CatalogCustomer } from "./resolve";
import { normalize } from "./text";

// The owner's real mishearings (D149, D152): how speech-to-text wrote shop words in the voice tests of 29 Sep to
// 10 Oct, and how staff type them in a hurry (Banglish, D96). A line the matcher understands must stay understood;
// a line left to the LLM (C of D149) must never be understood as something else.

interface HeardAs {
  heard: string;
  meant: string;
  concept: AliasConcept | "customer" | "supplier" | "payment" | "number";
  value: string;
  style: "bangla" | "banglish";
  layer: "matcher" | "llm";
}

const lines = readFileSync(join(__dirname, "../data/heard-as.jsonl"), "utf8")
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line) as HeardAs);

const dictionary = buildDictionary();
const people = (names: string[], prefix: string): CatalogCustomer[] =>
  names.map((name, index) => ({ hostId: `${prefix}${index}`, name, nameBn: null }));
const customers = people(["Rahim Motors", "Rahim Auto Garage", "New Dhaka Garage", "Karim Auto"], "c");
const suppliers = people(
  [
    "Nawabpur Auto Parts Ltd.",
    "Bangshal Motor Supply",
    "Japan Auto Parts Importer",
    "Dhaka Bike Parts Center",
    "Eastern Lubricants",
  ],
  "s",
);

/** What the matcher alone understands for a line: a value, or null when it is unclear. */
function understood(line: HeardAs): string | null {
  switch (line.concept) {
    case "customer":
    case "supplier": {
      const match = resolveCustomer(
        line.heard,
        [],
        line.concept === "customer" ? customers : suppliers,
        dictionary,
      );
      const taken = match.decision === "understood" || match.decision === "understood_bold";
      return taken ? (match.candidates[0]?.customer.name ?? null) : null;
    }
    case "payment":
      return saysCredit(line.heard) ? "credit" : null;
    case "number":
      return /^(19|20)\d\d$/.test(line.value)
        ? String(parseYear(normalize(line.heard).tokens, { now: new Date() }))
        : String(parseAmount(line.heard));
    default: {
      const match = matchConcept(line.concept, line.heard, [], dictionary);
      return match.decision === "unclear" ? null : (match.candidates[0]?.value ?? null);
    }
  }
}

describe("the owner's real mishearings (D152)", () => {
  it("has both scripts and both layers", () => {
    expect(new Set(lines.map((line) => line.style))).toEqual(new Set(["bangla", "banglish"]));
    expect(lines.filter((line) => line.layer === "matcher").length).toBeGreaterThanOrEqual(80);
  });

  it.each(
    lines.filter((line) => line.layer === "matcher").map((line) => [line.heard, line.value, line] as const),
  )("understands %s as %s", (_heard, value, line) => {
    expect(understood(line)).toBe(value);
  });

  it.each(lines.filter((line) => line.layer === "llm").map((line) => [line.heard, line] as const))(
    "never takes %s for something else (left to the LLM)",
    (_heard, line) => {
      const value = understood(line);
      if (value !== null && value !== "null") expect(value).toBe(line.value);
    },
  );
});
