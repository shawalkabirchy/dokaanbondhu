// In-memory token buckets, one server process (spec 8.7): 20 turns a minute per user and 120 per shop; 200 chunk
// uploads a minute per user; 30 setup calls a minute per shop. Over the limit: 429 RATE_LIMITED with Retry-After.

export type LimitKind = "turn" | "chunk" | "setup";

interface Rule {
  scope: "user" | "shop";
  perMinute: number;
}

const RULES: Record<LimitKind, Rule[]> = {
  turn: [
    { scope: "user", perMinute: 20 },
    { scope: "shop", perMinute: 120 },
  ],
  chunk: [{ scope: "user", perMinute: 200 }],
  setup: [{ scope: "shop", perMinute: 30 }],
};

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  /** Takes one token from every bucket the call counts against; returns the seconds to wait when one is empty. */
  take(
    kind: LimitKind,
    ids: { userId: string; shopId: string },
    now = Date.now(),
  ): { ok: true } | { ok: false; retryAfter: number } {
    const rules = RULES[kind].map((rule) => ({
      rule,
      key: `${kind}:${rule.scope}:${rule.scope === "user" ? ids.userId : ids.shopId}`,
    }));
    const filled = rules.map(({ rule, key }) => {
      const rate = rule.perMinute / 60_000; // tokens per millisecond
      const bucket = this.buckets.get(key) ?? { tokens: rule.perMinute, updatedAt: now };
      const tokens = Math.min(rule.perMinute, bucket.tokens + (now - bucket.updatedAt) * rate);
      return { key, rate, tokens };
    });
    const empty = filled.filter((bucket) => bucket.tokens < 1);
    if (empty.length > 0) {
      const waitMs = Math.max(...empty.map((bucket) => (1 - bucket.tokens) / bucket.rate));
      for (const bucket of filled) this.buckets.set(bucket.key, { tokens: bucket.tokens, updatedAt: now });
      return { ok: false, retryAfter: Math.ceil(waitMs / 1000) };
    }
    for (const bucket of filled) this.buckets.set(bucket.key, { tokens: bucket.tokens - 1, updatedAt: now });
    return { ok: true };
  }
}

const holder = globalThis as { __dokaanRateLimiter?: RateLimiter };
export const rateLimiter = (): RateLimiter => (holder.__dokaanRateLimiter ??= new RateLimiter());
