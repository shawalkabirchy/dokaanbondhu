import { banglaDigits, formatTaka, quantity } from "@dokaanbondhu/core";
import type { Language } from "./settings-store";

// Numbers on screen (spec 10.8): money arrives in paisa and is shown in taka with Bangladeshi grouping; Bangla digits
// when the app is in Bangla.

export function takaText(paisa: number, language: Language): string {
  const value = BigInt(Math.round(paisa));
  return language === "bn" ? `${formatTaka(value)} টাকা` : `Tk ${formatTaka(value, { bangla: false })}`;
}

export function numberText(value: number, language: Language): string {
  return language === "bn" ? banglaDigits(String(value)) : String(value);
}

export function stockText(stock: number, unit: string | null | undefined, language: Language): string {
  const word = unit ?? "piece";
  return language === "bn" ? quantity(stock, word) : `${stock} ${word}`;
}
