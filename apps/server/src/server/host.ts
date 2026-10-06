import { aliasEntries, buildDictionary, GLOSSARY, type Dictionary } from "@dokaanbondhu/core";
import type { TurnHost } from "@dokaanbondhu/engine/conversation";
import { parseAesKey } from "@dokaanbondhu/engine/crypto";
import {
  catalogVersion,
  HostConnectionError,
  HostPools,
  loadCatalog,
  loadHostDb,
  loadSchemaMap,
  type AppWords,
  type Catalog,
  type ReportName,
} from "@dokaanbondhu/engine/host";
import { aliases, connections, fitmentExtra, rackExtra, reportFormulas } from "@dokaanbondhu/platform-db";
import { and, asc, eq, max } from "drizzle-orm";
import { serverEnv } from "../env";
import { logger, platform } from "./singletons";

// The shop's host for a turn (spec 11.4): its active database connection, the schema map, the catalog, and
// DokaanBondhu's own fitment and rack rows, kept in memory per shop. A turn checks the catalog's newest sync time and
// the shop's newest alias (words learned, D102) when the entry is older than 60 s and reloads it when either changed;
// a setup change clears the entry at once.

const VERSION_CHECK_MS = 60_000;
const SHOP_WORDS = 60;

export interface ShopHost {
  host: TurnHost;
  dictionary: Dictionary;
  /** "alias = catalog term" for the system prompt (spec 9.7). */
  shopWords: string[];
}

interface Entry {
  value: ShopHost;
  connectionId: string | null;
  /** The catalog's newest sync and the shop's newest alias: a change in either reloads the entry. */
  version: string;
  checkedAt: number;
}

const versionOf = (synced: Date | null, words: number) => `${synced?.getTime() ?? 0}|${words}`;

const holder = globalThis as { __dokaanHosts?: Map<string, Entry>; __dokaanHostPools?: HostPools };
const cache = (holder.__dokaanHosts ??= new Map());

/** The host database pools, one per connection, shared by every route (spec 8.1). */
export function hostPools(): HostPools {
  return (holder.__dokaanHostPools ??= new HostPools((error) =>
    logger().warn({ err: error }, "host DB connection dropped while idle"),
  ));
}

export function clearHostCache(shopId: string): void {
  cache.delete(shopId);
}

const EMPTY_CATALOG: Catalog = { syncedAt: null, parts: [], vehicles: [], customers: [], suppliers: [] };

async function load(shopId: string): Promise<Entry> {
  const aesKey = parseAesKey(serverEnv().AES_KEY);
  return platform().withShop(shopId, async (tx) => {
    const own = await tx.select().from(aliases).where(eq(aliases.shopId, shopId));
    const dictionary = buildDictionary([...GLOSSARY, ...aliasEntries(own)]);
    const wordsVersion = own.reduce((latest, row) => Math.max(latest, row.createdAt.getTime()), 0);
    const shopWords = own.slice(0, SHOP_WORDS).map((row) => `${row.aliasText} = ${row.targetValue}`);

    const [connection] = await tx
      .select({ id: connections.id, appWords: connections.appWords })
      .from(connections)
      .where(and(eq(connections.kind, "db"), eq(connections.status, "active")))
      .orderBy(asc(connections.createdAt))
      .limit(1);
    if (!connection) {
      const host: TurnHost = {
        map: null,
        run: null,
        catalog: EMPTY_CATALOG,
        fitmentExtra: [],
        rackExtra: new Map(),
        formulas: [],
        hostReports: [],
      };
      return {
        value: { host, dictionary, shopWords },
        connectionId: null,
        version: versionOf(null, wordsVersion),
        checkedAt: Date.now(),
      };
    }

    const db = await loadHostDb(tx, connection.id, aesKey);
    const map = await loadSchemaMap(tx, connection.id, db.dialect);
    const catalog = await loadCatalog(tx, connection.id);
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
      })),
      rackExtra: new Map(racks.map((row) => [row.hostPartId, row.rackLocation])),
      formulas: formulas.map((row) => ({
        name: row.name as ReportName,
        definition: row.definition,
        confirmed: row.confirmedAt !== null,
      })),
      hostReports: [], // a host's own report endpoints come with API connections (spec 11.13)
      appWords: connection.appWords as AppWords,
    };
    return {
      value: { host, dictionary, shopWords },
      connectionId: connection.id,
      version: versionOf(catalog.syncedAt, wordsVersion),
      checkedAt: Date.now(),
    };
  });
}

export async function shopHost(shopId: string): Promise<ShopHost> {
  const entry = cache.get(shopId);
  const now = Date.now();
  if (entry && now - entry.checkedAt < VERSION_CHECK_MS) return entry.value;
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
      return entry.value;
    }
  }
  const fresh = await load(shopId);
  cache.set(shopId, fresh);
  return fresh.value;
}
