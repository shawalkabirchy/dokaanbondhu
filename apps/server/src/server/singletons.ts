import { createLogger, type Logger } from "@dokaanbondhu/engine/log";
import { createPlatform, type Platform } from "@dokaanbondhu/platform-db";
import { serverEnv } from "../env";

// Process-wide singletons on globalThis, so every route bundle and every hot reload shares one instance (spec 8.1).

const holder = globalThis as { __dokaanPlatform?: Platform; __dokaanLogger?: Logger };

/** The platform database as platform_api, pool of 8 (spec 4.2). */
export function platform(): Platform {
  return (holder.__dokaanPlatform ??= createPlatform(serverEnv().PLATFORM_DATABASE_URL, { max: 8 }));
}

export function logger(): Logger {
  return (holder.__dokaanLogger ??= createLogger({ name: "server", level: serverEnv().LOG_LEVEL }));
}
