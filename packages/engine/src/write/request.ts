import { refusalText } from "@dokaanbondhu/core";
import { snakeCase } from "../host/openapi-import";
import type { HostResponse } from "../host/api";
import type { WriteCapability, WriteParam } from "./types";

// Host requests and answers by their parameters' paths and names (spec 9.6, 11.9; D136): nothing here names a host.
// A body is built from the confirmed semantic slots; an answer is read by field names (a total, the customer's due,
// the supplier's payable, warnings), since every host words its answer its own way.

type Json = Record<string, unknown>;

/** The leaf of a path in snake_case: lines[].partId -> part_id. */
export function leafOf(path: string): string {
  return snakeCase(path.split(".").at(-1)!.replace(/\[\]$/, ""));
}

/** Writes a value at a JSON path; an array segment ("items[]") takes the line at `index`. */
export function setPath(target: Json, path: string, value: unknown, index = 0): void {
  const segments = path.split(".");
  let node: Json = target;
  segments.forEach((segment, position) => {
    const last = position === segments.length - 1;
    if (segment.endsWith("[]")) {
      const key = segment.slice(0, -2);
      const list = (node[key] ??= []) as Json[];
      if (last) {
        list[index] = value as Json;
        return;
      }
      node = list[index] ??= {};
      return;
    }
    if (last) node[segment] = value;
    else node = (node[segment] ??= {}) as Json;
  });
}

/** Reads a dotted path ("sale.id", "error.message_bn"); a number segment reads a list's item. */
export function readPath(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => {
    if (node === null || node === undefined) return undefined;
    if (Array.isArray(node)) return /^\d+$/.test(key) ? node[Number(key)] : undefined;
    return typeof node === "object" ? (node as Json)[key] : undefined;
  }, source);
}

/** A value as the parameter's type wants it: an integer ID from text, a UUID as text. */
export function coerce(param: Pick<WriteParam, "type">, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (param.type.startsWith("integer")) return Number.parseInt(String(value), 10);
  if (param.type.startsWith("number")) return Number(value);
  if (param.type.startsWith("boolean")) return Boolean(value);
  return String(value);
}

/** What a turn has understood, in host values. */
export interface ResolvedWrite {
  customer?: { hostId: string; name: string } | null;
  supplier?: { hostId: string; name: string } | null;
  line?: { hostPartId: string; quantity: number; unitCost?: number | null } | null;
  /** Empty: on credit (বাকিতে). An amount of null is filled from the total. */
  payments?: { method: string; amount: number | null; trxId?: string | null }[];
  amount?: number | null;
  note?: string | null;
  reason?: string | null;
  /** Required parameters without a slot, by their leaf name (spec 9.6 extra.<name>). */
  extras?: Record<string, string>;
}

const inList = (param: WriteParam) => param.path.includes("[]");

/** The value of one parameter, or undefined to leave it out. */
function valueFor(param: WriteParam, resolved: ResolvedWrite, index: number): unknown {
  const leaf = leafOf(param.path);
  switch (param.semanticSlot) {
    case "customer":
    case "supplier": {
      const party = resolved[param.semanticSlot];
      if (!party) return undefined;
      return param.entityConcept || /_id$/.test(leaf) ? party.hostId : party.name;
    }
    case "items": {
      const line = resolved.line;
      if (!line || index > 0) return undefined;
      if (/part_?id$/.test(leaf)) return line.hostPartId;
      if (/quantity|qty/.test(leaf)) return line.quantity;
      if (/cost/.test(leaf)) return line.unitCost ?? undefined;
      return undefined; // a unit price is the host's own price for the customer (custom prices come in step 6)
    }
    case "payment": {
      const payment = resolved.payments?.[index];
      if (!payment) return undefined;
      if (/method/.test(leaf)) return payment.method;
      if (/amount/.test(leaf)) return payment.amount ?? undefined;
      if (/trx/.test(leaf)) return payment.trxId ?? undefined;
      return undefined;
    }
    case "amount":
      return resolved.amount ?? undefined;
    case "note":
      return resolved.note ?? undefined;
    case "reason":
      return resolved.reason ?? undefined;
    default:
      return param.required ? resolved.extras?.[leaf] : undefined;
  }
}

/**
 * The request body from what was understood: each body parameter from its slot, in the host's type. Lists get one
 * line per payment (and one part line). Returns the required parameters that are still empty.
 */
export function buildBody(
  capability: WriteCapability,
  resolved: ResolvedWrite,
): { body: Json; missing: string[] } {
  const body: Json = {};
  const missing: string[] = [];
  for (const param of capability.params.filter((item) => item.location === "body")) {
    const lines = inList(param) && param.semanticSlot === "payment" ? (resolved.payments?.length ?? 0) : 1;
    for (let index = 0; index < lines; index++) {
      const value = valueFor(param, resolved, index);
      if (value !== undefined && value !== null && value !== "")
        setPath(body, param.path, coerce(param, value), index);
    }
    // the importer's required already says whether the list itself is required (D133)
    if (param.required && !hasPath(body, param.path)) missing.push(param.path);
  }
  return { body, missing };
}

function hasPath(body: Json, path: string): boolean {
  const [head, ...rest] = path.split("[].");
  const value = readPath(body, head!.replace(/\[\]$/, ""));
  if (!rest.length) return value !== undefined;
  return (
    Array.isArray(value) && value.length > 0 && value.every((item) => hasPath(item as Json, rest.join("[].")))
  );
}

/** The parameter that names how a payment is made. */
export const methodParam = (capability: WriteCapability) =>
  capability.params.find((param) => param.semanticSlot === "payment" && /method/.test(leafOf(param.path))) ??
  null;

/** The host's value for cash, from the confirmed spoken words or the values themselves. */
export function cashMethod(capability: WriteCapability): string | null {
  const param = methodParam(capability);
  if (!param) return null;
  const map = param.spokenMap ?? {};
  return (
    map["নগদে"] ??
    map["নগদ"] ??
    map.nogode ??
    param.enumValues?.find((value) => value.toLowerCase() === "cash") ??
    null
  );
}

/** The dry-run switch of the feature list ("?dry_run=true") as query parameters, or null without one. */
export function dryRunQuery(features: Json): Record<string, string> | null {
  const hint = features.dry_run;
  if (typeof hint !== "string" || !hint.includes("=")) return null;
  return Object.fromEntries(new URLSearchParams(hint.replace(/^\?/, "")));
}

const numberOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)
      ? Number(value)
      : null;

/** Breadth first: the first value whose key (and the keys above it) the test accepts. */
function find(source: unknown, test: (key: string, above: string[]) => boolean): unknown {
  const queue: { node: unknown; above: string[] }[] = [{ node: source, above: [] }];
  while (queue.length) {
    const { node, above } = queue.shift()!;
    if (!node || typeof node !== "object" || Array.isArray(node)) continue;
    for (const [key, value] of Object.entries(node as Json)) {
      if (test(snakeCase(key), above)) return value;
      if (value && typeof value === "object" && !Array.isArray(value))
        queue.push({ node: value, above: [...above, snakeCase(key)] });
    }
  }
  return undefined;
}

export interface AnswerFacts {
  total: number | null;
  /** The customer's due after the action. */
  customerDue: number | null;
  /** The supplier's payable after the action. */
  supplierPayable: number | null;
  warnings: string[];
}

/** A host's answer read by field names: a nested sale.total_taka and customer.due_balance_taka, or a flat total and
 * customer_due. */
export function answerFacts(answer: unknown): AnswerFacts {
  const total = numberOf(find(answer, (key) => /^(grand_)?total(_taka|_amount)?$/.test(key)));
  const customerDue = numberOf(
    find(
      answer,
      (key, above) =>
        /^(customer_due|due_balance|balance_due|customer_balance)(_taka)?$/.test(key) ||
        (above.at(-1) === "customer" && /^(due|balance)(_balance)?(_taka)?$/.test(key)),
    ),
  );
  const supplierPayable = numberOf(
    find(
      answer,
      (key, above) =>
        /^(supplier_payable|payable_balance|balance_payable|supplier_balance)(_taka)?$/.test(key) ||
        (above.at(-1) === "supplier" && /^(payable|balance)(_balance)?(_taka)?$/.test(key)),
    ),
  );
  const listed = find(answer, (key) => key === "warnings");
  const warnings = Array.isArray(listed)
    ? listed
        .map((item) =>
          typeof item === "string"
            ? item
            : item && typeof item === "object"
              ? String(
                  (item as Json).message_bn ??
                    (item as Json).message ??
                    (item as Json).message_en ??
                    (item as Json).code ??
                    "",
                )
              : "",
        )
        .filter(Boolean)
    : [];
  return { total, customerDue, supplierPayable, warnings };
}

/** Why the host refused: its Bangla message where the feature list names it, else a sentence for the status. */
export function refusalOf(response: HostResponse, features: Json): string {
  const path = typeof features.bangla_errors === "string" ? features.bangla_errors : null;
  const message = path ? readPath(response.body, path) : undefined;
  if (typeof message === "string" && message.trim()) {
    const text = message.trim();
    return /[।.!?]$/.test(text) ? text : `${text}।`;
  }
  return refusalText(response.status);
}

export { numberOf };
