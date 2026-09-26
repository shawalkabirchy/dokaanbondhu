import { parseAesKey } from "@dokaanbondhu/engine/crypto";
import { z } from "zod";

// The server's environment (spec 4.3), checked once at start-up (instrumentation.ts) and on first use.

const schema = z.object({
  PLATFORM_DATABASE_URL: z.string().min(1),
  SUPABASE_URL: z.url(),
  SUPABASE_SECRET_KEY: z.string().min(20),
  AES_KEY: z.string().refine((value) => {
    try {
      parseAesKey(value);
      return true;
    } catch {
      return false;
    }
  }, "must be 32 bytes, base64"),
  EVAL_MODE_SECRET: z.string().min(16).optional(),
  JWT_TEST_SECRET: z.string().min(16).optional(), // CI only: HS256 test tokens instead of the JWKS (D20)
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export type ServerEnv = z.infer<typeof schema>;

const holder = globalThis as { __dokaanServerEnv?: ServerEnv };

export function serverEnv(): ServerEnv {
  if (holder.__dokaanServerEnv) return holder.__dokaanServerEnv;
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const names = result.error.issues.map((issue) => `${issue.path.join(".")} (${issue.message})`).join(", ");
    throw new Error(`The server cannot start: missing or invalid variables: ${names}`);
  }
  holder.__dokaanServerEnv = result.data;
  return result.data;
}
