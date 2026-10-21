import type { ScannedParam, ScannedRoute, ScannerSummary } from "@dokaanbondhu/contracts";
import { z } from "zod";
import { llmStream, type LlmProvider } from "../providers";
import { importOpenApi, snakeCase, type ImportedDocument } from "./openapi-import";

// A Laravel scanner summary imported as capabilities (spec 11.8 step 6, D183): the summary is written as an OpenAPI
// 3.0 document — each route an operation, its parameters the schema the scanner read from the app's rules — and then
// goes through the same importer as any app's own document, so every proposal, template, role and re-import rule is
// the same. An exists rule becomes the generic x-references hint, which names the entity.

type Json = Record<string, unknown>;

/** One leaf's schema from the rules: type, nullable, enumeration, range or length, format, references. */
function leafSchema(param: ScannedParam): Json {
  const schema: Json = {};
  if (param.type && param.type !== "object") schema.type = param.type;
  if (param.nullable) schema.nullable = true;
  if (param.enum?.length) schema.enum = param.enum;
  const [low, high] =
    param.type === "string"
      ? ["minLength", "maxLength"]
      : param.type === "array"
        ? ["minItems", "maxItems"]
        : ["minimum", "maximum"];
  if (param.min !== null) schema[low] = param.min;
  if (param.max !== null) schema[high] = param.max;
  if (param.format) schema.format = param.format;
  if (param.references) schema["x-references"] = { ...param.references };
  if (param.rules) schema.description = param.rules;
  return schema;
}

interface Field {
  /** The field's own rules (items: required|array). */
  param: ScannedParam | null;
  /** The rules of each element of a list of scalars (codes.*: integer). */
  item: ScannedParam | null;
  list: boolean;
  children: Map<string, Field>;
}

/** The body's fields as a tree: items[].part_id is the part_id of each object in the items list. */
export function fieldTree(params: ScannedParam[]): Field {
  const root: Field = { param: null, item: null, list: false, children: new Map() };
  for (const param of params) {
    let node = root;
    const segments = param.name.split(".");
    segments.forEach((segment, index) => {
      const name = segment.replace(/\[\]$/, "");
      let child = node.children.get(name);
      if (!child)
        node.children.set(name, (child = { param: null, item: null, list: false, children: new Map() }));
      if (segment.endsWith("[]")) child.list = true;
      if (index === segments.length - 1) {
        if (segment.endsWith("[]")) child.item = param;
        else child.param = param;
      }
      node = child;
    });
  }
  return root;
}

/** A field's schema: an object of its children, a list of them, a list of scalars, or a leaf. */
function schemaOf(field: Field): Json {
  const own = field.param ? leafSchema(field.param) : {};
  const list = (items: Json): Json => ({ ...own, type: "array", items });
  if (!field.children.size) {
    // codes.* without children: a list of scalars, its items typed by the codes.* rules.
    if (field.item) return list(leafSchema(field.item));
    return field.list ? list({}) : own;
  }
  const object: Json = { type: "object", properties: {} };
  const required: string[] = [];
  for (const [name, child] of field.children) {
    (object.properties as Json)[name] = schemaOf(child);
    if (child.param?.required) required.push(name);
  }
  if (required.length) object.required = required;
  return field.list || field.param?.type === "array" ? list(object) : { ...own, ...object };
}

/** The route's operation ID: its Laravel name (sales.store), else its handler (SaleController@store → sale_store). */
function operationIdOf(route: ScannedRoute, taken: Set<string>): string {
  const base =
    snakeCase(route.name ?? route.handler.replace(/Controller(?=@|$)/, "").replace("@", "_")) || "route";
  let id = base;
  if (taken.has(id)) id = `${base}_${route.method.toLowerCase()}`;
  for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
  taken.add(id);
  return id;
}

/** The text the owner sees for a route before an LLM description, or when that fails. */
export function routeTitle(route: ScannedRoute): string {
  return `${route.method} ${route.path} (${route.handler})`;
}

/**
 * The summary as an OpenAPI 3.0 document. `descriptions` are the LLM's short descriptions by "METHOD path"; a route
 * without one is described by its method, path and handler.
 */
export function scannerDocument(summary: ScannerSummary, descriptions = new Map<string, string>()): Json {
  const paths: Record<string, Json> = {};
  const taken = new Set<string>();
  for (const route of summary.routes) {
    const parameters = route.params
      .filter((param) => param.location !== "body")
      .map((param) => ({
        name: param.name,
        in: param.location,
        required: param.location === "path" ? true : param.required,
        schema: leafSchema(param),
      }));
    const body = route.params.filter((param) => param.location === "body");
    const operation: Json = {
      operationId: operationIdOf(route, taken),
      summary: descriptions.get(`${route.method} ${route.path}`) ?? routeTitle(route),
      ...(route.validation ? { description: route.validation } : {}),
      ...(parameters.length ? { parameters } : {}),
      ...(body.length
        ? {
            requestBody: {
              required: true,
              content: { "application/json": { schema: schemaOf(fieldTree(body)) } },
            },
          }
        : {}),
      responses: { "200": { description: "OK" } },
    };
    (paths[route.path] ??= {})[route.method.toLowerCase()] = operation;
  }
  return {
    openapi: "3.0.3",
    info: { title: "Laravel app (DokaanBondhu scanner)", version: summary.scanner_version },
    paths,
  };
}

/** The summary's capabilities, through the OpenAPI importer; the features list names no document to fetch again. */
export function importScannerSummary(
  summary: ScannerSummary,
  descriptions = new Map<string, string>(),
): ImportedDocument {
  const imported = importOpenApi(scannerDocument(summary, descriptions));
  delete imported.features.openapi;
  return imported;
}

/** At most this many routes are described, a few at a time. */
const MAX_DESCRIBED = 30;
const AT_ONCE = 4;
const descriptionSchema = z.object({ description: z.string().trim().min(3).max(200) });

/**
 * One LLM call per write route writes a short description for the owner (spec 11.8 step 6), checked with zod. A
 * call that fails or answers otherwise leaves the route described by its method, path and handler; nothing waits on
 * it longer than 20 seconds.
 */
export async function describeRoutes(
  summary: ScannerSummary,
  llm: LlmProvider[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (!llm.length) return found;
  const routes = summary.routes.filter((route) => route.method !== "GET").slice(0, MAX_DESCRIBED);
  const describe = async (route: ScannedRoute) => {
    const prompt =
      "A car spare parts shop's app has this API route. In one short English sentence (at most 15 words), say " +
      'what it does, for the shop owner. Answer only with JSON: {"description": "..."}\n' +
      `Route: ${route.method} ${route.path}\nHandler: ${route.handler}\nFields: ${route.validation ?? "none"}`;
    let text = "";
    try {
      for await (const delta of llmStream(
        llm,
        { messages: [{ role: "user", content: prompt }], temperature: 0, maxTokens: 120 },
        { startTimeoutMs: 10_000, deadlineMs: 20_000 },
      )) {
        if (delta.type === "text") text += delta.text;
      }
      const json = /\{[\s\S]*\}/.exec(text)?.[0];
      const answer = descriptionSchema.safeParse(json ? JSON.parse(json) : null);
      if (answer.success)
        found.set(`${route.method} ${route.path}`, answer.data.description.replace(/\s+/g, " "));
    } catch {
      // the route keeps its own description
    }
  };
  for (let start = 0; start < routes.length; start += AT_ONCE)
    await Promise.all(routes.slice(start, start + AT_ONCE).map(describe));
  return found;
}
