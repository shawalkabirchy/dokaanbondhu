import { createHash } from "node:crypto";

// The OpenAPI importer (spec 11.8, 11.13): every operation of a host's OpenAPI 3.0 or 3.1 document becomes a capability
// candidate with one parameter per leaf of its request, and every leaf gets proposals (an entity, a semantic slot, a
// spoken map) that the owner confirms. The host's generic x- hints pre-fill the feature list, dry-run support,
// compensation and read-back. Nothing here knows a host: every proposal comes from names, formats and enumerations.

type Json = Record<string, unknown>;

export interface ImportedParam {
  /** JSON path of the leaf: customer_id, items[].part_id, payments[].method. */
  path: string;
  location: "body" | "query" | "path";
  type: string;
  required: boolean;
  enumValues: string[] | null;
  /** Proposed: the entity an ID names (customer_id -> Customer). */
  entityConcept: string | null;
  /** Proposed: the tool argument it is filled from (spec 9.6). */
  semanticSlot: string | null;
  safetyCritical: boolean;
  /** Proposed: spoken words for the enumeration's values. */
  spokenMap: Record<string, string> | null;
}

export interface ImportedOperationRef {
  /** The other capability, by its name (snake_case operationId). */
  operation: string;
  idFrom: string;
}

export interface ImportedCapability {
  name: string;
  description: string;
  kind: "read" | "write";
  httpMethod: string;
  path: string;
  operationId: string;
  requestSchema: { parameters: Json[]; body: Json | null };
  responseSchema: Json | null;
  schemaHash: string;
  supportsDryRun: boolean;
  compensation: (ImportedOperationRef & { body: Json }) | null;
  readBack: ImportedOperationRef | null;
  /** Proposed confirmation template kind (spec 11.10). */
  template: string;
  /** Proposed: who may use it. */
  requiredRole: "staff" | "owner";
  params: ImportedParam[];
}

export interface ImportedDocument {
  /** Proposed connections.features (spec 11.13). */
  features: Record<string, unknown>;
  capabilities: ImportedCapability[];
}

export class OpenApiImportError extends Error {}

/** recordSale -> record_sale (the capability name, D46). */
export function snakeCase(operationId: string): string {
  return operationId
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase()
    .replace(/^_|_$/g, "");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical((value as Json)[key])]),
    );
  }
  return value;
}

/** Follows local $refs and merges allOf, so every schema below is plain. */
function resolver(document: Json) {
  const lookup = (ref: string): unknown => {
    if (!ref.startsWith("#/")) throw new OpenApiImportError(`only local $refs are supported: ${ref}`);
    return ref
      .slice(2)
      .split("/")
      .reduce<unknown>(
        (node, key) => (node as Json | undefined)?.[key.replace(/~1/g, "/").replace(/~0/g, "~")],
        document,
      );
  };
  const resolve = (schema: unknown, depth = 0): Json => {
    if (depth > 32) throw new OpenApiImportError("the schema nests too deep or refers to itself");
    if (!schema || typeof schema !== "object") return {};
    let node = schema as Json;
    if (typeof node.$ref === "string") return resolve(lookup(node.$ref), depth + 1);
    if (Array.isArray(node.allOf)) {
      const parts = node.allOf.map((part) => resolve(part, depth + 1));
      const merged: Json = { type: "object", properties: {}, required: [] };
      for (const part of parts) {
        Object.assign(merged.properties as Json, (part.properties as Json) ?? {});
        (merged.required as string[]).push(...((part.required as string[]) ?? []));
      }
      const rest = { ...node };
      delete rest.allOf;
      node = { ...merged, ...rest };
    }
    const out: Json = { ...node };
    if (out.properties && typeof out.properties === "object") {
      out.properties = Object.fromEntries(
        Object.entries(out.properties as Json).map(([key, value]) => [key, resolve(value, depth + 1)]),
      );
    }
    if (out.items) out.items = resolve(out.items, depth + 1);
    for (const key of ["anyOf", "oneOf"] as const) {
      if (Array.isArray(out[key])) out[key] = (out[key] as unknown[]).map((part) => resolve(part, depth + 1));
    }
    return out;
  };
  return resolve;
}

/** The leaf's type without null: ["string", "null"] -> string; 3.0's nullable flag is ignored the same way. */
function typeOf(schema: Json): string {
  if (Array.isArray(schema.type))
    return (schema.type as string[]).find((type) => type !== "null") ?? "string";
  if (typeof schema.type === "string") return schema.type;
  for (const key of ["anyOf", "oneOf"] as const) {
    const parts = schema[key];
    if (Array.isArray(parts)) {
      const first = (parts as Json[]).find((part) => typeOf(part) !== "null");
      if (first) return typeOf(first);
    }
  }
  if (schema.properties) return "object";
  return "string";
}

function enumOf(schema: Json): string[] | null {
  const values = Array.isArray(schema.enum) ? schema.enum : null;
  return values ? values.filter((value) => value !== null).map(String) : null;
}

/** Every leaf of a schema with its JSON path; a leaf is required only when every object above it requires it. */
function leaves(schema: Json, prefix: string, required: boolean): Omit<ImportedParam, "location">[] {
  const type = typeOf(schema);
  if (type === "object" && schema.properties) {
    const needed = new Set((schema.required as string[]) ?? []);
    return Object.entries(schema.properties as Record<string, Json>).flatMap(([key, child]) =>
      leaves(child, prefix ? `${prefix}.${key}` : key, required && needed.has(key)),
    );
  }
  if (type === "array" && schema.items && typeOf(schema.items as Json) === "object") {
    return leaves(schema.items as Json, `${prefix}[]`, required);
  }
  const format = typeof schema.format === "string" ? `:${schema.format}` : "";
  return [
    {
      path: prefix,
      type: type === "array" ? `array<${typeOf((schema.items as Json) ?? {})}>` : `${type}${format}`,
      required,
      enumValues: enumOf(schema),
      entityConcept: null,
      semanticSlot: null,
      safetyCritical: false,
      spokenMap: null,
    },
  ];
}

// The concepts of the schema map (spec 7.2) an ID may name.
const CONCEPTS = [
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
];

/** customer_id -> Customer, sale_item_id -> SaleItem; a name that is no concept proposes none. */
function conceptOf(name: string): string | null {
  const match = /^(.+?)_?id$/i.exec(name);
  if (!match) return null;
  const pascal = match[1]!
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase())
    .join("");
  return CONCEPTS.includes(pascal) ? pascal : null;
}

// Spoken words for payment methods, proposed when an enumeration holds such values; the owner confirms each (spec 11.8).
const METHOD_WORDS: Record<string, string[]> = {
  cash: ["নগদ", "নগদে", "ক্যাশ", "cash", "nogod", "nogode"],
  bkash: ["বিকাশ", "বিকাশে", "bkash", "bikash"],
  nagad: ["নগদ অ্যাকাউন্টে", "nagad"],
  rocket: ["রকেট", "রকেটে", "rocket"],
  bank: ["ব্যাংক", "ব্যাংকে", "bank"],
  cheque: ["চেক", "চেকে", "cheque", "check"],
};

function spokenMapOf(values: string[] | null): Record<string, string> | null {
  if (!values) return null;
  const map: Record<string, string> = {};
  for (const value of values) for (const word of METHOD_WORDS[value.toLowerCase()] ?? []) map[word] = value;
  return Object.keys(map).length ? map : null;
}

/** A path with every name in snake_case, so camelCase hosts match the same rules: lines[].partId -> lines[].part_id. */
function normalPath(path: string): string {
  return path
    .split(".")
    .map((segment) => (segment.endsWith("[]") ? `${snakeCase(segment.slice(0, -2))}[]` : snakeCase(segment)))
    .join(".");
}

/** The semantic slot proposed for a leaf (spec 9.6), from its (normalized) path alone. */
function slotOf(path: string, linesWithParts: Set<string>): string | null {
  const parts = path.split(".");
  const leaf = parts.at(-1)!.replace(/\[\]$/, "");
  const parent = parts.length > 1 ? parts.slice(0, -1).join(".") : "";
  if (parent && parent.endsWith("[]")) {
    // A list of lines that name a part: the items of a sale or a purchase.
    if (linesWithParts.has(parent)) return "items";
    if (/sale_?item_?id$/i.test(leaf)) return "sale_ref";
    if (/quantity|qty/i.test(leaf)) return "items";
    if (/method|amount|trx/i.test(leaf) || parent.startsWith("payment")) return "payment";
  }
  if (parent.startsWith("payment") || parent === "cheque" || parent.startsWith("cheque")) return "payment";
  if (/^customer_?id$/i.test(leaf)) return "customer";
  if (/^supplier_?id$/i.test(leaf)) return "supplier";
  if (/^part_?id$/i.test(leaf)) return "part";
  if (/^vehicle_?id$/i.test(leaf)) return "vehicle";
  if (/^sale_?id$/i.test(leaf)) return "sale_ref";
  if (/^(method|payment_method|trx_?id)$/i.test(leaf)) return "payment";
  if (/^(retail|garage|wholesale)_price/i.test(leaf)) return "prices";
  if (/^refund_(due|cash)/i.test(leaf)) return "refund";
  if (/^amount/i.test(leaf)) return "amount";
  if (/^reason$/i.test(leaf)) return "reason";
  if (/^note$/i.test(leaf)) return "note";
  return null;
}

const SAFETY_CRITICAL = new Set([
  "customer",
  "supplier",
  "items",
  "amount",
  "prices",
  "refund",
  "part",
  "payment",
]);

/** The confirmation template kind proposed from the slots a write uses (spec 11.10). */
function templateOf(kind: "read" | "write", slots: Set<string | null>): string {
  if (kind === "read") return "generic";
  if (slots.has("sale_ref") && slots.has("refund")) return "return";
  if (slots.has("customer") && slots.has("items")) return "sale";
  if (slots.has("supplier") && slots.has("items")) return "stock_in";
  if (slots.has("customer") && slots.has("amount")) return "payment";
  if (slots.has("prices")) return "price_update";
  if (slots.has("part") && slots.has("vehicle")) return "add_fitment";
  return "generic";
}

function operationRef(value: unknown): ImportedOperationRef | null {
  if (!value || typeof value !== "object") return null;
  const hint = value as Json;
  if (typeof hint.operation !== "string" || typeof hint.id_from !== "string") return null;
  return { operation: snakeCase(hint.operation), idFrom: hint.id_from };
}

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

export function importOpenApi(input: unknown, documentPath = "/api/openapi.json"): ImportedDocument {
  if (!input || typeof input !== "object") throw new OpenApiImportError("not a JSON object");
  const document = input as Json;
  const version = String(document.openapi ?? "");
  if (!/^3\.[01]\./.test(version))
    throw new OpenApiImportError(`OpenAPI 3.0 or 3.1 is needed, not "${version}"`);
  const resolve = resolver(document);
  const capabilities: ImportedCapability[] = [];
  let anyDryRun = false;

  for (const [path, item] of Object.entries((document.paths as Record<string, Json>) ?? {})) {
    for (const method of METHODS) {
      const operation = item[method] as Json | undefined;
      if (!operation || typeof operation.operationId !== "string") continue;
      const parameters = [
        ...((item.parameters as Json[]) ?? []),
        ...((operation.parameters as Json[]) ?? []),
      ].map((parameter) => resolve(parameter));
      const content = (resolve(operation.requestBody).content as Json | undefined)?.["application/json"] as
        Json | undefined;
      const body = content ? resolve(content.schema) : null;
      const responses = (operation.responses as Record<string, Json>) ?? {};
      const success = Object.keys(responses)
        .filter((status) => /^2\d\d$/.test(status))
        .sort()
        .map((status) => resolve(responses[status]))
        .find((response) => (response.content as Json | undefined)?.["application/json"]);
      const responseSchema = success
        ? resolve(((success.content as Json)["application/json"] as Json).schema)
        : null;

      // Headers and the dry-run switch belong to the feature list, not to a capability's parameters.
      const params: ImportedParam[] = [];
      for (const parameter of parameters) {
        const location = parameter.in;
        if (location !== "query" && location !== "path") continue;
        if (parameter.name === "dry_run") continue;
        for (const leaf of leaves(
          resolve(parameter.schema),
          String(parameter.name),
          parameter.required === true,
        )) {
          params.push({ ...leaf, location });
        }
      }
      if (body) {
        const required = (resolve(operation.requestBody).required as boolean | undefined) ?? true;
        for (const leaf of leaves(body, "", required)) params.push({ ...leaf, location: "body" });
      }
      const normal = new Map(params.map((param) => [param, normalPath(param.path)]));
      const linesWithParts = new Set(
        [...normal.values()]
          .filter((path) => /\[\]\.part_id$/.test(path))
          .map((path) => path.slice(0, path.lastIndexOf("."))),
      );
      for (const param of params) {
        const path = normal.get(param)!;
        const leaf = path.split(".").at(-1)!;
        param.entityConcept = param.type.endsWith(":uuid") || /_id$/.test(leaf) ? conceptOf(leaf) : null;
        param.semanticSlot =
          param.location === "body" || param.location === "query" ? slotOf(path, linesWithParts) : null;
        param.safetyCritical = SAFETY_CRITICAL.has(param.semanticSlot ?? "");
        param.spokenMap = spokenMapOf(param.enumValues);
      }

      const kind = method === "get" ? "read" : "write";
      const requestSchema = { parameters, body };
      const supportsDryRun = operation["x-supports-dry-run"] === true;
      anyDryRun ||= supportsDryRun;
      const compensationHint = operation["x-compensating-operation"] as Json | undefined;
      const compensation = operationRef(compensationHint);
      const template = templateOf(kind, new Set(params.map((param) => param.semanticSlot)));
      capabilities.push({
        name: snakeCase(operation.operationId),
        description: [operation.summary, operation.description].filter(Boolean).join(". "),
        kind,
        httpMethod: method.toUpperCase(),
        path,
        operationId: operation.operationId,
        requestSchema,
        responseSchema,
        schemaHash: createHash("sha256")
          .update(`${method.toUpperCase()} ${path} ${JSON.stringify(canonical(requestSchema))}`)
          .digest("hex"),
        supportsDryRun,
        compensation: compensation
          ? { ...compensation, body: ((compensationHint!.body as Json) ?? {}) as Json }
          : null,
        readBack: operationRef(operation["x-read-back"]),
        template,
        requiredRole: template === "price_update" ? "owner" : "staff",
        params,
      });
    }
  }

  const features: Record<string, unknown> = { openapi: documentPath };
  const hinted = document["x-host-features"];
  if (hinted && typeof hinted === "object") Object.assign(features, hinted as Json);
  else if (anyDryRun) features.dry_run = "?dry_run=true";
  for (const path of Object.keys((document.paths as Json) ?? {})) {
    if (/\/sync\/status$/.test(path)) features.sync_status ??= `GET ${path}`;
    if (/\/reports\/\{[^}]+\}$/.test(path)) features.report_path ??= `GET ${path}`;
  }
  return { features, capabilities };
}
