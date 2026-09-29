import { describe, expect, it } from "vitest";
import { recentHealth, recordProviderCall, speechHealth } from "./health";
import {
  OWN_SIDE,
  selectProviders,
  sideOf,
  sidesFrom,
  type ProviderRow,
  type Side,
  type Sides,
} from "./select";

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

describe("which provider answers (spec 13.2, D98)", () => {
  const rows = [
    row({ id: "g-cf", job: "llm", provider: "cloudflare", priority: 1, external: true }),
    row({ id: "g-ds", job: "llm", provider: "deepseek", priority: 2, external: true }),
    row({ id: "g-oa", job: "llm", provider: "openai", priority: 3, external: true, enabled: false }),
    row({ id: "g-stt", job: "stt", provider: "speech_worker", active: true }),
    row({ id: "a-stt", shopId: SHOP, job: "stt", provider: "speech_worker", active: true }),
    row({ id: "g-scribe", job: "stt", provider: "elevenlabs", external: true }),
    row({ id: "g-tts", job: "tts", provider: "speech_worker", active: true }),
    row({ id: "b-tts", shopId: "shop-b", job: "tts", provider: "elevenlabs", active: true }),
  ];
  const sides = (chat: Side, listen: Side = "own", speak: Side = "own"): Sides => ({ chat, listen, speak });

  it("puts the chosen side first and the other side after it as the backup, skipping disabled rows", () => {
    expect(selectProviders(rows, SHOP, OWN_SIDE).llm.map((r) => r.id)).toEqual(["g-cf", "g-ds"]);
    expect(selectProviders(rows, SHOP, sides("api")).llm.map((r) => r.id)).toEqual(["g-ds", "g-cf"]);
  });

  it("switches listening and speaking separately, each on its own side", () => {
    const api = selectProviders(rows, SHOP, sides("own", "api", "own"));
    expect(api.stt?.id).toBe("g-scribe");
    expect(api.tts?.id).toBe("g-tts");
    // speaking on the APIs: this shop has no ElevenLabs voice (shop B's row never counts), so our own answers
    expect(selectProviders(rows, SHOP, sides("own", "own", "api")).tts?.id).toBe("g-tts");
  });

  it("uses the shop's own rows of a side when it has any, else the global ones", () => {
    expect(selectProviders(rows, SHOP, OWN_SIDE).stt?.id).toBe("a-stt");
    expect(selectProviders(rows, "shop-c", OWN_SIDE).stt?.id).toBe("g-stt");
    expect(selectProviders(rows, "shop-b", sides("own", "own", "api")).tts?.id).toBe("b-tts");
  });

  it("reads the switches from the environment: unset or empty is own, anything else is refused", () => {
    expect(sidesFrom({})).toEqual(OWN_SIDE);
    expect(sidesFrom({ AI_CHAT: "api", AI_LISTEN: "", AI_SPEAK: " api " })).toEqual(
      sides("api", "own", "api"),
    );
    expect(() => sidesFrom({ AI_CHAT: "deepseek" })).toThrow('AI_CHAT must be own or api, not "deepseek"');
    expect(sideOf("cloudflare")).toBe("own");
    expect(sideOf("elevenlabs")).toBe("api");
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
