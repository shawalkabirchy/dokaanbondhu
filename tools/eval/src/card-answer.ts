import { asciiDigits, normalize } from "@dokaanbondhu/core";
import type { Item } from "./items";
import type { TurnRecord } from "./score";

// A question the script has no answer for, answered from the card as the speaker would (the owner's decisions, D237,
// D239): a voice card is said in the speaker's own words, and a detail it names may be left out ("ফিল্টার" for the
// card's air filter) or misheard (a phone's digits, a car), so the assistant's question is fair. The runner answers
// only with words on the card: the one button whose words are all on it, else the value the card names for the slot
// asked (the year, car, part, side or quality; the phone, price or count), typed as a speaker would say it when no
// button has it. Such a question still counts as unnecessary in the report; only the item can still be right.

/** A slot the assistant asks, and the card's detail that answers it (D239). */
const FROM_SLOTS: Record<string, string> = {
  new_phone: "phone",
  unit_price: "unit_price",
  unit_cost: "unit_cost",
  quantity: "quantity",
  amount: "amount",
  new_rack: "rack",
};

/** The details the card names: the expected search, or the write's part, its own values, and a fitment's new car. */
function cardDetails(item: Item): Record<string, unknown> {
  const expected = item.expected as Record<string, unknown>;
  const part = (expected.params ?? expected.part ?? {}) as Record<string, unknown>;
  const slots = (expected.slots ?? {}) as Record<string, unknown>;
  const fit = slots.vehicle as Record<string, unknown> | undefined;
  const own = Object.fromEntries(
    Object.entries(FROM_SLOTS)
      .filter(([, key]) => typeof slots[key] === "string" || typeof slots[key] === "number")
      .map(([slot, key]) => [slot, slots[key]]),
  );
  return {
    ...part,
    ...own,
    ...(fit && typeof fit === "object" ? { fit_vehicle: fit.model, fit_year: fit.year } : {}),
  };
}

/** The card's words, each number whole ("5,850" is 5850), for finding a value said on it. */
function cardWords(item: Item): string {
  const text = asciiDigits(`${item.task_card} ${item.task_card_bn ?? ""}`).replace(/(\d),(?=\d{3}\b)/g, "$1");
  return ` ${normalize(text).tokens.join(" ")} `;
}

/** The answer the card gives to a question the script does not answer, or null when the card does not say. */
export function cardAnswer(item: Item, turn: Pick<TurnRecord, "slot" | "options">): string | null {
  if (turn.options?.length) {
    // A button's own words, before its details ("এয়ার ফিল্টার, Toyota"), all on the card; only when one button is.
    const forms = new Set(normalize(`${item.task_card_bn ?? ""} ${item.task_card}`).forms.flat());
    const fitting = turn.options.filter((label) => {
      const words = normalize(label.split(",")[0] ?? "").forms;
      return words.length > 0 && words.every((word) => word.some((form) => forms.has(form)));
    });
    if (fitting.length === 1) return fitting[0]!;
    if (fitting.length > 1) return null;
    // No button has it (the shop's common cars, not the RAV4 on the card): said in words, as a speaker would.
  }
  const said = cardWords(item);
  const onCard = (value: string) => said.includes(` ${normalize(value).tokens.join(" ")} `);
  const value = turn.slot ? cardDetails(item)[turn.slot] : undefined;
  if (typeof value !== "string" && typeof value !== "number") return null;
  // A car is on the card by its model ("Premio" for Toyota Premio).
  const shown =
    turn.slot === "vehicle" || turn.slot === "fit_vehicle" ? String(value).split(" ").at(-1)! : String(value);
  return onCard(shown) ? String(value) : null;
}
