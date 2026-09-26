import bn from "../bn.json";
import en from "../en.json";

// Every string the app shows, in Bangla (the default) and English (spec 15.6). The server takes its error messages
// from the same files, so both languages always say the same thing.

export type Language = "bn" | "en";
export const messages = { bn, en } as const;

/** The text for a dotted key such as "errors.RATE_LIMITED", or the key itself when it is missing. */
export function translate(language: Language, key: string): string {
  let node: unknown = messages[language];
  for (const part of key.split(".")) {
    node = typeof node === "object" && node !== null ? (node as Record<string, unknown>)[part] : undefined;
  }
  return typeof node === "string" ? node : key;
}
