import {
  shopSettingsSchema,
  type ProviderView,
  type ProvidersInUse,
  type ShopSettingsView,
  type UserView,
} from "@dokaanbondhu/contracts";
import { parseAesKey } from "@dokaanbondhu/engine/crypto";
import {
  llmChain,
  selectProviders,
  type LlmProvider,
  type ProviderJob,
  type Sides,
} from "@dokaanbondhu/engine/providers";
import { aiProviders, shops, type Tx, type users } from "@dokaanbondhu/platform-db";
import { eq } from "drizzle-orm";
import { serverEnv } from "../env";
import { appError } from "./errors";
import { platform } from "./singletons";

// The shop's settings and providers, and the views the endpoints return (spec 8.3, 13.2).

type ProviderRowDb = typeof aiProviders.$inferSelect;
type ShopRow = typeof shops.$inferSelect;

export function settingsOf(shop: ShopRow): ShopSettingsView {
  return shopSettingsSchema.parse(shop.settings ?? {});
}

export async function loadShop(tx: Tx, shopId: string): Promise<ShopRow> {
  const [shop] = await tx.select().from(shops).where(eq(shops.id, shopId));
  if (!shop) throw appError("NOT_FOUND", 404, { entity: "shop" });
  return shop;
}

export function userView(row: typeof users.$inferSelect): UserView {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    role: row.role as UserView["role"],
    status: row.status as UserView["status"],
  };
}

export function providerView(row: ProviderRowDb): ProviderView {
  return {
    id: row.id,
    job: row.job as ProviderJob,
    provider: row.provider,
    model: row.model,
    scope: row.shopId === null ? "global" : "shop",
    active: row.active,
    external: row.external,
    enabled: row.enabled,
    priority: row.priority,
  };
}

// The provider rows are cached per shop for 30 s (spec 13.2).
const CACHE_MS = 30_000;
const holder = globalThis as { __dokaanProviders?: Map<string, { rows: ProviderRowDb[]; expires: number }> };
const cache = (holder.__dokaanProviders ??= new Map());

/** The developer's switches in the server's environment (D98): which side answers chat, listening and speaking. */
export function serverSides(): Sides {
  const env = serverEnv();
  return { chat: env.AI_CHAT, listen: env.AI_LISTEN, speak: env.AI_SPEAK };
}

/** Every provider row this shop can see: its own rows and the global ones (row-level security does the rest). */
export async function providerRows(shopId: string): Promise<ProviderRowDb[]> {
  const cached = cache.get(shopId);
  if (cached && cached.expires > Date.now()) return cached.rows;
  const rows = await platform().withShop(shopId, (tx) => tx.select().from(aiProviders));
  cache.set(shopId, { rows, expires: Date.now() + CACHE_MS });
  return rows;
}

export function providersInUse(rows: ProviderRowDb[], shopId: string): ProvidersInUse {
  const used = selectProviders(rows, shopId, serverSides());
  return {
    llm: used.llm.map(providerView),
    stt: used.stt ? providerView(used.stt) : null,
    tts: used.tts ? providerView(used.tts) : null,
  };
}

/** The shop's LLM chain (spec 13.2, 13.3): the chosen side in priority order, then the other side as the backup. */
export async function shopLlm(shopId: string): Promise<LlmProvider[]> {
  return llmChain(await providerRows(shopId), shopId, serverSides(), parseAesKey(serverEnv().AES_KEY));
}
