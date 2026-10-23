import { aliasEntries, buildDictionary, catalogEntries, GLOSSARY, type Dictionary } from "@dokaanbondhu/core";
import type { TurnHost } from "@dokaanbondhu/engine/conversation";
import { parseAesKey } from "@dokaanbondhu/engine/crypto";
import {
  catalogVersion,
  chosenPaikari,
  countsOf,
  HostConnectionError,
  hostCounts,
  HostPools,
  loadCatalog,
  loadHostDb,
  loadSchemaMap,
  loadWriteHost,
  syncConnection,
  type AppWords,
  type Catalog,
  type CatalogCounts,
  type ReportName,
} from "@dokaanbondhu/engine/host";
import type { WriteCapability } from "@dokaanbondhu/engine/write";
import { aliases, connections, fitmentExtra, rackExtra, reportFormulas } from "@dokaanbondhu/platform-db";
import { and, asc, eq, max } from "drizzle-orm";
import { serverEnv } from "../env";
import { logger, platform } from "./singletons";

// The shop's host for a turn (spec 11.4): its active database connection, the schema map, the catalog,
// DokaanBondhu's own fitment and rack rows, and its API connection's writes (spec 9.6), kept in memory per shop. A turn checks the catalog's newest sync time and
// the shop's newest alias (words learned, D102) when the entry is older than 60 s and reloads it when either changed;
// a setup change clears the entry at once.

const VERSION_CHECK_MS = 60_000;
const SHOP_WORDS = 60;

export interface ShopHost {
  host: TurnHost;
  dictionary: Dictionary;
  /** "alias = catalog term" for the system prompt (spec 9.7). */
  shopWords: string[];
  /** Every write of the API connection, switched on or not: an action is decided and undone by its own (spec 11.9). */
  allWrites: WriteCapability[];
  /** The database connection whose catalog the turn uses, for a record added at once (D173). */
  connectionId: string | null;
}

interface Entry {
  value: ShopHost;
  connectionId: string | null;
  /** The catalog's newest sync and the shop's newest alias: a change in either reloads the entry. */
  version: string;
  checkedAt: number;
}

const versionOf = (synced: Date | null, words: number) => `${synced?.getTime() ?? 0}|${words}`;

/** What the server knows of a shop's copy between turns (D208). */
interface Freshness {
  /** The app's counts at the last check: a change means a name was added or removed. */
  counts: CatalogCounts | null;
  /**
   * When the server's last refresh began, so its copy shows the app from then on (the copy's own time also moves when
   * a turn adds a record, so it is not used once the server has refreshed).
   */
  refreshedAt: number | null;
  /** The refresh under way, if any: one at a time per shop. */
  running: Promise<void> | null;
}

const holder = globalThis as {
  __dokaanHosts?: Map<string, Entry>;
  __dokaanHostPools?: HostPools;
  __dokaanFreshness?: Map<string, Freshness>;
};
const cache = (holder.__dokaanHosts ??= new Map());
const freshness = (holder.__dokaanFreshness ??= new Map<string, Freshness>());

/** The host database pools, one per connection, shared by every route (spec 8.1). */
export function hostPools(): HostPools {
  return (holder.__dokaanHostPools ??= new HostPools((error) =>
    logger().warn({ err: error }, "host DB connection dropped while idle"),
  ));
}

export function clearHostCache(shopId: string): void {
  cache.delete(shopId);
  freshness.delete(shopId);
}

/** Tests only: the next shopHost() runs its once-a-minute check at once. */
export function expireHostCheck(shopId: string): void {
  const entry = cache.get(shopId);
  if (entry) entry.checkedAt = 0;
}

const EMPTY_CATALOG: Catalog = { syncedAt: null, parts: [], vehicles: [], customers: [], suppliers: [] };

async function load(shopId: string): Promise<Entry> {
  const aesKey = parseAesKey(serverEnv().AES_KEY);
  return platform().withShop(shopId, async (tx) => {
    const own = await tx.select().from(aliases).where(eq(aliases.shopId, shopId));
    const wordsVersion = own.reduce((latest, row) => Math.max(latest, row.createdAt.getTime()), 0);
    const shopWords = own.slice(0, SHOP_WORDS).map((row) => `${row.aliasText} = ${row.targetValue}`);
    const writes = await loadWriteHost(tx, aesKey);
    const writeHost = writes ? { writes: writes.host } : {};
    const allWrites = writes?.all ?? [];

    const [connection] = await tx
      .select({ id: connections.id, appWords: connections.appWords, paikariPrice: connections.paikariPrice })
      .from(connections)
      .where(and(eq(connections.kind, "db"), eq(connections.status, "active")))
      .orderBy(asc(connections.createdAt))
      .limit(1);
    if (!connection) {
      const dictionary = buildDictionary([...GLOSSARY, ...aliasEntries(own)]);
      const host: TurnHost = {
        map: null,
        run: null,
        catalog: EMPTY_CATALOG,
        fitmentExtra: [],
        rackExtra: new Map(),
        formulas: [],
        hostReports: [],
        ...writeHost,
      };
      return {
        value: { host, dictionary, shopWords, allWrites, connectionId: null },
        connectionId: null,
        version: versionOf(null, wordsVersion),
        checkedAt: Date.now(),
      };
    }

    const db = await loadHostDb(tx, connection.id, aesKey);
    const map = await loadSchemaMap(tx, connection.id, db.dialect);
    const catalog = await loadCatalog(tx, connection.id);
    // The app's own car models, categories and part kinds are words too (D122), before the shop's aliases.
    const dictionary = buildDictionary([...GLOSSARY, ...catalogEntries(catalog), ...aliasEntries(own)]);
    const fitments = await tx.select().from(fitmentExtra).where(eq(fitmentExtra.connectionId, connection.id));
    const racks = await tx.select().from(rackExtra).where(eq(rackExtra.connectionId, connection.id));
    const formulas = await tx
      .select()
      .from(reportFormulas)
      .where(eq(reportFormulas.connectionId, connection.id));
    const pools = hostPools();
    const host: TurnHost = {
      map,
      // A failure of the host's database (unreachable, timed out) is a host error, not the server's own.
      run: async (query) => {
        try {
          return await pools.readOnly(db, (run) => run(query));
        } catch (error) {
          throw new HostConnectionError(error instanceof Error ? error.message : "host query failed", {
            cause: error,
          });
        }
      },
      catalog,
      fitmentExtra: fitments.map((row) => ({
        hostPartId: row.hostPartId,
        make: row.make,
        model: row.model,
        yearFrom: row.yearFrom,
        yearTo: row.yearTo,
        engineCode: row.engineCode,
        verified: row.verified,
        source: row.source as "parsed" | "owner",
      })),
      rackExtra: new Map(racks.map((row) => [row.hostPartId, row.rackLocation])),
      formulas: formulas.map((row) => ({
        name: row.name as ReportName,
        definition: row.definition,
        confirmed: row.confirmedAt !== null,
      })),
      hostReports: [], // a host's own report endpoints come with API connections (spec 11.13)
      appWords: connection.appWords as AppWords,
      paikari: chosenPaikari(map, connection.paikariPrice),
      ...writeHost,
    };
    return {
      value: { host, dictionary, shopWords, allWrites, connectionId: connection.id },
      connectionId: connection.id,
      version: versionOf(catalog.syncedAt, wordsVersion),
      checkedAt: Date.now(),
    };
  });
}

/** A rack kept in DokaanBondhu's own list (D195, D199), in the cached host at once: the next answer says it. */
export function keepRack(value: ShopHost, hostPartId: string, rack: string): void {
  (value.host.rackExtra as Map<string, string>).set(hostPartId, rack);
}

export async function shopHost(shopId: string): Promise<ShopHost> {
  const entry = cache.get(shopId);
  const now = Date.now();
  if (entry && now - entry.checkedAt < VERSION_CHECK_MS) return entry.value;
  let current: Entry | null = null;
  if (entry) {
    const connectionId = entry.connectionId;
    const version = await platform().withShop(shopId, async (tx) => {
      const [words] = await tx
        .select({ at: max(aliases.createdAt) })
        .from(aliases)
        .where(eq(aliases.shopId, shopId));
      const synced = connectionId ? await catalogVersion(tx, connectionId) : null;
      return versionOf(synced, words?.at?.getTime() ?? 0);
    });
    if (version === entry.version) {
      entry.checkedAt = now;
      current = entry;
    }
  }
  if (!current) {
    current = await load(shopId);
    cache.set(shopId, current);
  }
  // The same once-a-minute check asks the app whether a name was added or removed (D208).
  if (await keepFresh(shopId, current)) {
    current = await load(shopId);
    cache.set(shopId, current);
  }
  return current.value;
}

/** A copy older than this is refreshed in the background (D208), as often as the worker's catalog.sync. */
const REFRESH_AFTER_MS = 10 * 60_000;

const COUNTED = ["part", "vehicle", "customer", "supplier"] as const;

/**
 * Whether the shop's copy must be refreshed (D208): now, before the answer, when the app's counts differ from the
 * known ones (a name added or removed); in the background when the copy is older than 10 minutes (an edit, which no
 * count shows); else not.
 */
export function needsRefresh(input: {
  counts: CatalogCounts;
  known: CatalogCounts;
  refreshedAt: number | null;
  now: number;
}): "now" | "background" | "no" {
  if (COUNTED.some((concept) => input.counts[concept] !== input.known[concept])) return "now";
  if (input.refreshedAt === null || input.now - input.refreshedAt > REFRESH_AFTER_MS) return "background";
  return "no";
}

/**
 * Counts the app's names and refreshes the copy when needsRefresh() says so; true when it refreshed before the
 * answer (the caller reloads). The app out of reach or a failed refresh only warns: the turn goes on with the old copy.
 */
async function keepFresh(shopId: string, entry: Entry): Promise<boolean> {
  const { connectionId, host } = entry.value;
  if (!connectionId || !host.map || !host.run) return false;
  const state = freshness.get(shopId) ?? { counts: null, refreshedAt: null, running: null };
  freshness.set(shopId, state);
  const countedAt = Date.now();
  let counts: CatalogCounts;
  try {
    counts = await hostCounts(host.run, host.map);
  } catch (error) {
    logger().warn({ err: error, shop_id: shopId }, "the app's names could not be counted; the copy stays");
    return false;
  }
  const decision = needsRefresh({
    counts,
    // on a fresh start, the copy's own counts: a name added while the server slept is caught too
    known: state.counts ?? countsOf(host.catalog),
    refreshedAt: state.refreshedAt ?? host.catalog.syncedAt?.getTime() ?? null,
    now: Date.now(),
  });
  state.counts = counts;
  if (decision === "no") return false;
  const start = () =>
    (state.running ??= refresh(shopId, connectionId, state).finally(() => {
      state.running = null;
    }));
  if (decision === "background") {
    void start();
    return false;
  }
  await state.running; // one under way may have begun before this change
  if (state.refreshedAt === null || state.refreshedAt < countedAt) await start();
  return true;
}

/** The same catalog.sync as setup's "sync now", as platform_api for the shop; never throws. */
async function refresh(shopId: string, connectionId: string, state: Freshness): Promise<void> {
  const began = Date.now(); // the copy shows the app as it was read, from about now
  try {
    await syncConnection(
      (fn) => platform().withShop(shopId, fn),
      hostPools(),
      parseAesKey(serverEnv().AES_KEY),
      shopId,
      connectionId,
    );
    state.refreshedAt = began;
    cache.delete(shopId); // the next turn loads the new copy
  } catch (error) {
    logger().warn({ err: error, shop_id: shopId }, "catalog refresh failed; the old copy stays");
  }
}
