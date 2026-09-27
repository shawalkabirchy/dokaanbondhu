import { createLogger, type Logger } from "@dokaanbondhu/engine/log";
import { createPlatform, type Platform } from "@dokaanbondhu/platform-db";
import { serverEnv } from "../env";

// Process-wide singletons on globalThis, so every route bundle and every hot reload shares one instance (spec 8.1).

const holder = globalThis as { __dokaanPlatform?: Platform; __dokaanLogger?: Logger };

/**
 * The platform database as platform_api, pool of 8 (spec 4.2). Unused connections stay open 5 minutes: a new one to
 * the Singapore pooler costs about 0.4 s more than a warm one, on every health check and turn (D82).
 */
export function platform(): Platform {
  return (holder.__dokaanPlatform ??= createPlatform(serverEnv().PLATFORM_DATABASE_URL, {
    max: 8,
    idleTimeoutMs: 300_000,
    onIdleError: (error) => logger().warn({ err: error }, "platform DB connection dropped while idle"),
  }));
}

export function logger(): Logger {
  return (holder.__dokaanLogger ??= createLogger({ name: "server", level: serverEnv().LOG_LEVEL }));
}
