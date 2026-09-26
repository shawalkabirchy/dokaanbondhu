// Every enumeration of spec 7.2, kept as text with a CHECK constraint.

export const USER_ROLES = ["owner", "staff"] as const;
export const USER_STATUSES = ["active", "disabled"] as const;

export const CONNECTION_KINDS = ["db", "api"] as const;
export const DIALECTS = ["postgres", "mysql"] as const;
export const SSL_MODES = ["verify-full", "require", "disable"] as const;
export const AUTH_TYPES = ["api_key", "bearer", "session"] as const;
export const CONNECTION_STATUSES = ["pending", "active", "error", "disabled"] as const;

export const CONCEPTS = [
  "Part",
  "Vehicle",
  "Fitment",
  "StockItem",
  "Price",
  "Customer",
  "Sale",
  "SaleItem",
  "Return",
  "Payment",
  "Supplier",
  "Purchase",
] as const;
export const ID_TYPES = ["integer", "uuid", "text"] as const;
export const CAPABILITY_KINDS = ["read", "write"] as const;
export const CAPABILITY_SOURCES = ["openapi", "scanner", "demo"] as const;
export const REQUIRED_ROLES = ["staff", "owner"] as const;
export const PARAM_LOCATIONS = ["body", "query", "path"] as const;
export const CATALOG_CONCEPTS = ["part", "vehicle", "customer", "supplier"] as const;
export const ALIAS_TARGETS = ["part_type", "vehicle_model", "quality", "position", "unit", "brand"] as const;
export const ALIAS_SOURCES = ["global", "owner", "host"] as const;
export const FITMENT_EXTRA_SOURCES = ["parsed", "owner"] as const;

export const CHANNELS = ["voice", "chat"] as const;
export const CONVERSATION_STATES = [
  "IDLE",
  "LISTENING",
  "UNDERSTANDING",
  "CLARIFYING",
  "CONFIRMING",
  "EXECUTING",
  "RESPONDING",
] as const;
export const MESSAGE_ROLES = ["user", "assistant"] as const;
export const FRAME_STATUSES = ["active", "set_aside", "confirming", "done", "cancelled", "expired"] as const;

export const PROVIDER_JOBS = ["llm", "stt", "tts"] as const;
export const PROVIDERS = [
  "vllm",
  "cloudflare",
  "deepseek",
  "openai",
  "openrouter",
  "speech_worker",
  "elevenlabs",
] as const;
export const ACTION_STATUSES = ["pending", "done", "failed", "review", "cancelled", "undone"] as const;
export const VERIFY_STATUSES = ["ok", "mismatch", "skipped"] as const;
export const SETUP_TOKEN_PURPOSES = ["scanner_upload"] as const;
