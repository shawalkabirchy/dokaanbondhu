import pino, { type Logger } from "pino";

// JSON logs with pino (spec 3.5, 17). Secrets are never logged: every value under a key that names authorization,
// a secret, a password or a key is replaced, and the password inside a connection string is masked.

const SECRET_KEY = /authorization|secret|password|key/i;
const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^:/?#\s]+:)[^@/\s]+@/gi;

export function redactSecrets(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.replace(URL_PASSWORD, "$1***@");
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, depth + 1));
  if (value instanceof Error) return { name: value.name, message: redactSecrets(value.message, depth + 1) };
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SECRET_KEY.test(key) ? "[redacted]" : redactSecrets(item, depth + 1),
    ]),
  );
}

export function createLogger(options: { name: string; level?: string }): Logger {
  return pino({
    name: options.name,
    level: options.level ?? "info",
    formatters: { log: (object) => redactSecrets(object) as Record<string, unknown> },
  });
}

export type { Logger };
