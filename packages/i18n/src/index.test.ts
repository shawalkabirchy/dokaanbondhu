import { describe, expect, it } from "vitest";
import { messages, translate } from ".";

/** Every dotted key of a message tree. */
function keys(node: unknown, prefix = ""): string[] {
  if (typeof node !== "object" || node === null) return [prefix];
  return Object.entries(node).flatMap(([key, value]) => keys(value, prefix ? `${prefix}.${key}` : key));
}

describe("language files", () => {
  it("have the same keys in Bangla and English", () => {
    expect(keys(messages.bn).sort()).toEqual(keys(messages.en).sort());
  });

  it("translate a key, and fall back to the key when it is missing", () => {
    expect(translate("en", "errors.RATE_LIMITED")).toBe("Too many requests. Please wait a moment.");
    expect(translate("bn", "errors.NOT_FOUND")).toBe("পাওয়া যায়নি।");
    expect(translate("bn", "errors.NO_SUCH_CODE")).toBe("errors.NO_SUCH_CODE");
  });
});
