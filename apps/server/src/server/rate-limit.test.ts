import { describe, expect, it } from "vitest";
import { RateLimiter } from "./rate-limit";

const ids = { userId: "user-1", shopId: "shop-1" };

describe("rate limits", () => {
  it("allows 20 turns a minute per user, then asks to wait", () => {
    const limiter = new RateLimiter();
    const now = 1_000_000;
    for (let i = 0; i < 20; i++) expect(limiter.take("turn", ids, now).ok).toBe(true);
    const refused = limiter.take("turn", ids, now);
    expect(refused).toEqual({ ok: false, retryAfter: 3 }); // one token comes back every 3 s
    expect(limiter.take("turn", ids, now + 3000).ok).toBe(true);
  });

  it("counts turns per shop too: 120 a minute across its users", () => {
    const limiter = new RateLimiter();
    const now = 2_000_000;
    for (let user = 0; user < 6; user++) {
      for (let i = 0; i < 20; i++)
        expect(limiter.take("turn", { userId: `u${user}`, shopId: "s" }, now).ok).toBe(true);
    }
    expect(limiter.take("turn", { userId: "u7", shopId: "s" }, now).ok).toBe(false);
    expect(limiter.take("turn", { userId: "u7", shopId: "other" }, now).ok).toBe(true);
  });

  it("allows 200 chunk uploads a minute per user and 30 setup calls per shop", () => {
    const limiter = new RateLimiter();
    const now = 3_000_000;
    for (let i = 0; i < 200; i++) expect(limiter.take("chunk", ids, now).ok).toBe(true);
    expect(limiter.take("chunk", ids, now).ok).toBe(false);
    for (let i = 0; i < 30; i++) expect(limiter.take("setup", ids, now).ok).toBe(true);
    expect(limiter.take("setup", ids, now).ok).toBe(false);
  });
});
