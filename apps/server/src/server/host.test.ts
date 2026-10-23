import { describe, expect, it } from "vitest";
import { needsRefresh } from "./host";

// When the server refreshes a shop's copy of the app's names by itself (D208): at once when a name was added or
// removed in the app, in the background when the copy is older than 10 minutes, else not.

const counts = { part: 239, vehicle: 40, customer: 30, supplier: 5 };
const now = Date.parse("2026-12-10T10:00:00Z");
const minutesAgo = (minutes: number) => now - minutes * 60_000;

describe("refreshing the copy of the app's names", () => {
  it("leaves a copy alone whose counts match and which is under 10 minutes old", () => {
    expect(needsRefresh({ counts, known: { ...counts }, refreshedAt: minutesAgo(3), now })).toBe("no");
  });

  it("refreshes at once when a name was added or removed in the app", () => {
    for (const changed of [
      { ...counts, customer: 31 }, // a customer added on the web
      { ...counts, part: 238 }, // a part removed
      { ...counts, vehicle: 41 },
      { ...counts, supplier: 6 },
    ]) {
      expect(needsRefresh({ counts: changed, known: counts, refreshedAt: minutesAgo(1), now })).toBe("now");
    }
  });

  it("refreshes in the background when the copy is older than 10 minutes, or was never made", () => {
    expect(needsRefresh({ counts, known: counts, refreshedAt: minutesAgo(11), now })).toBe("background");
    expect(needsRefresh({ counts, known: counts, refreshedAt: null, now })).toBe("background");
  });

  it("puts a changed count before an old copy: the answer must see the new name", () => {
    expect(
      needsRefresh({ counts: { ...counts, customer: 31 }, known: counts, refreshedAt: minutesAgo(30), now }),
    ).toBe("now");
  });
});
