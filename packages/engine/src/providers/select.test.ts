import { describe, expect, it } from "vitest";
import { recentHealth, recordProviderCall, speechHealth } from "./health";
import { selectProviders, type ProviderRow } from "./select";

const SHOP = "shop-a";
const row = (fields: Partial<ProviderRow> & Pick<ProviderRow, "id" | "job" | "provider">): ProviderRow => ({
  shopId: null,
  model: null,
  priority: null,
  active: false,
  external: false,
  enabled: true,
  ...fields,
});

describe("which provider answers", () => {
  const rows = [
    row({ id: "g-cf", job: "llm", provider: "cloudflare", priority: 1 }),
    row({ id: "g-ds", job: "llm", provider: "deepseek", priority: 2, external: true }),
    row({ id: "g-oa", job: "llm", provider: "openai", priority: 3, external: true, enabled: false }),
    row({ id: "g-stt", job: "stt", provider: "speech_worker", active: true }),
    row({ id: "a-stt", shopId: SHOP, job: "stt", provider: "speech_worker", active: true }),
    row({ id: "a-scribe", shopId: SHOP, job: "stt", provider: "elevenlabs", external: true }),
    row({ id: "g-tts", job: "tts", provider: "speech_worker", active: true }),
    row({ id: "b-tts", shopId: "shop-b", job: "tts", provider: "elevenlabs", active: true }),
  ];

  it("drops external and disabled rows unless allowed, in priority order", () => {
    expect(selectProviders(rows, SHOP, false).llm.map((r) => r.id)).toEqual(["g-cf"]);
    expect(selectProviders(rows, SHOP, true).llm.map((r) => r.id)).toEqual(["g-cf", "g-ds"]);
  });

  it("uses the shop's own rows when it has any, else the global ones", () => {
    const used = selectProviders(rows, SHOP, false);
    expect(used.stt?.id).toBe("a-stt");
    expect(used.tts?.id).toBe("g-tts"); // shop B's row never counts for shop A
  });

  it("falls back to the global rows when the shop's own rows are all external and not allowed", () => {
    const onlyExternal = rows.filter((r) => r.id !== "a-stt");
    expect(selectProviders(onlyExternal, SHOP, false).stt?.id).toBe("g-stt");
    expect(selectProviders(onlyExternal, SHOP, true).stt).toBeNull(); // its own rows count, and none is active
  });
});

describe("provider health", () => {
  it("reports the last real call of the past 5 minutes, else unknown", () => {
    const now = 1_000_000;
    expect(recentHealth("llm", now)).toBe("unknown");
    recordProviderCall("llm", true, now);
    expect(recentHealth("llm", now + 60_000)).toBe("ok");
    expect(recentHealth("llm", now + 6 * 60_000)).toBe("unknown");
    recordProviderCall("stt", true, now);
    recordProviderCall("tts", false, now);
    expect(speechHealth(now)).toBe("down");
  });
});
