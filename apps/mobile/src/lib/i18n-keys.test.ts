import { messages } from "@dokaanbondhu/i18n";

/** Every dotted key of a message tree. */
function keys(node: unknown, prefix = ""): string[] {
  if (typeof node !== "object" || node === null) return [prefix];
  return Object.entries(node).flatMap(([key, value]) => keys(value, prefix ? `${prefix}.${key}` : key));
}

describe("language files", () => {
  it("have the same keys in Bangla and English (spec 15.6)", () => {
    expect(keys(messages.bn).sort()).toEqual(keys(messages.en).sort());
  });
});
