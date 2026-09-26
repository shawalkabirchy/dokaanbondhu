import { randomUUID } from "node:crypto";
import { AppError } from "@dokaanbondhu/core";
import { users } from "@dokaanbondhu/platform-db";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import { bearerToken, verifyAccessToken } from "./auth";
import { appError, errorResponse } from "./errors";
import { rateLimiter, type LimitKind } from "./rate-limit";
import { logger, platform } from "./singletons";

// Every handler is wrapped by one function that authenticates, loads the user, applies the rate limit and turns
// thrown AppErrors into the error shape (spec 8.1). The shop and role come only from the users row (spec 8.2).

export interface Caller {
  userId: string;
  authUserId: string;
  shopId: string;
  role: "owner" | "staff";
}

const USER_CACHE_MS = 60_000;
const holder = globalThis as {
  __dokaanUsers?: Map<string, { caller: Caller | "disabled"; expires: number }>;
};
const userCache = (holder.__dokaanUsers ??= new Map());

/** Forgets a cached login, so a disabled user is refused on the next request instead of within 60 s. */
export function forgetUser(authUserId: string): void {
  userCache.delete(authUserId);
}

async function loadCaller(authUserId: string): Promise<Caller> {
  const cached = userCache.get(authUserId);
  let caller = cached && cached.expires > Date.now() ? cached.caller : undefined;
  if (!caller) {
    const [row] = await platform().withAuthUser(authUserId, (tx) =>
      tx.select().from(users).where(eq(users.authUserId, authUserId)),
    );
    if (!row) throw appError("FORBIDDEN", 403);
    caller =
      row.status === "active"
        ? { userId: row.id, authUserId, shopId: row.shopId, role: row.role as Caller["role"] }
        : "disabled";
    userCache.set(authUserId, { caller, expires: Date.now() + USER_CACHE_MS });
  }
  if (caller === "disabled") throw appError("USER_DISABLED", 403);
  return caller;
}

export interface RouteContext<P> {
  request: Request;
  caller: Caller;
  params: P;
  requestId: string;
}

export function route<P extends Record<string, string> = Record<string, never>>(
  options: { role: "any" | "owner"; limit?: LimitKind },
  handler: (context: RouteContext<P>) => Promise<Response>,
) {
  return async (request: Request, context: { params: Promise<P> }): Promise<Response> => {
    const requestId = randomUUID();
    try {
      const caller = await loadCaller(await verifyAccessToken(bearerToken(request)));
      if (options.role === "owner" && caller.role !== "owner") throw appError("FORBIDDEN", 403);
      if (options.limit) {
        const taken = rateLimiter().take(options.limit, caller);
        if (!taken.ok) {
          return errorResponse(appError("RATE_LIMITED", 429, { retry_after: taken.retryAfter }), requestId, {
            "Retry-After": String(taken.retryAfter),
          });
        }
      }
      return await handler({ request, caller, params: await context.params, requestId });
    } catch (error) {
      if (!(error instanceof AppError)) {
        logger().error(
          { err: error, request_id: requestId, path: new URL(request.url).pathname },
          "request failed",
        );
      }
      return errorResponse(error, requestId);
    }
  };
}

/** Reads and checks a JSON body; a body that does not match is VALIDATION_FAILED with the issues. */
export async function readBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    throw appError("VALIDATION_FAILED", 400, { issues: [{ path: [], message: "body is not JSON" }] });
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    throw appError("VALIDATION_FAILED", 400, {
      issues: result.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
    });
  }
  return result.data;
}
