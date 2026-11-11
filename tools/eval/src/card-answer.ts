import { asciiDigits, normalize } from "@dokaanbondhu/core";
import type { Item } from "./items";
import type { TurnRecord } from "./score";

// A question the script has no answer for, answered from the card as the speaker would (the owner's decision, D237):
// a voice card is said in the speaker's own words, and a detail it names may be left out ("ফিল্টার" for the card's air
// filter), so the assistant's question is fair. The runner answers only with words on the card: the one button whose
// words are all on it, else the year, car, part, side or quality the card names. Such a question still counts as
// unnecessary in the report; only the item can still be right.

/** The details the card names for its part: the expected search, or the write's part, and a fitment's new car. */
function cardDetails(item: Item): Record<string, unknown> {
  const expected = item.expected as Record<string, unknown>;
  const part = (expected.params ?? expected.part ?? {}) as Record<string, unknown>;
  const fit = (expected.slots as Record<string, unknown> | undefined)?.vehicle as
    Record<string, unknown> | undefined;
  return { ...part, ...(fit ? { fit_vehicle: fit.model, fit_year: fit.year } : {}) };
}

/** The answer the card gives to a question the script does not answer, or null when the card does not say. */
export function cardAnswer(item: Item, turn: Pick<TurnRecord, "slot" | "options">): string | null {
  const card = normalize(`${item.task_card_bn ?? ""} ${item.task_card}`);
  const forms = new Set(card.forms.flat());
  if (turn.options?.length) {
    // A button's own words, before its details ("এয়ার ফিল্টার, Toyota"), all on the card; only when one button is.
    const fitting = turn.options.filter((label) => {
      const words = normalize(label.split(",")[0] ?? "").forms;
      return words.length > 0 && words.every((word) => word.some((form) => forms.has(form)));
    });
    return fitting.length === 1 ? fitting[0]! : null;
  }
  const said = ` ${normalize(asciiDigits(`${item.task_card} ${item.task_card_bn ?? ""}`)).tokens.join(" ")} `;
  const onCard = (value: string) => said.includes(` ${normalize(value).tokens.join(" ")} `);
  const value = turn.slot ? cardDetails(item)[turn.slot] : undefined;
  if (typeof value !== "string" && typeof value !== "number") return null;
  // A car is on the card by its model ("Premio" for Toyota Premio).
  const shown =
    turn.slot === "vehicle" || turn.slot === "fit_vehicle" ? String(value).split(" ").at(-1)! : String(value);
  return onCard(shown) ? String(value) : null;
}
