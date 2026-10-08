import { resultText, type ResultFields } from "@dokaanbondhu/core";
import { HostCallFailed } from "../host/api";
import { answerFacts, readPath, refusalOf, type AnswerFacts } from "./request";
import type { ActionPreview, HostResponse, PendingAction, WriteCapability, WriteHost } from "./types";
import { changedAsExpected, savedAnyway, snapshot, type ReadPath, type Snapshot } from "./verify";

// The write executor after "yes" (spec 11.9 steps 4 to 8) and undo (11.9.1). Nothing is retried after a refusal; a
// timeout or 5xx is read back first and retried once with the same key; success is verified before it is claimed.

export const UNDO_REASON = "Undo in DokaanBondhu";
const NO_ANSWER = "অ্যাপ সাড়া দেয়নি।";

export interface Execution {
  status: "done" | "failed" | "review";
  response: unknown;
  verifyStatus: "ok" | "mismatch" | "skipped";
  text: string;
  undoAvailable: boolean;
}

function headers(host: WriteHost, idempotencyKey: string, actingUser: string): Record<string, string> {
  const out: Record<string, string> = {};
  const key = host.features.idempotency_header;
  if (typeof key === "string" && key) out[key] = idempotencyKey;
  const acting = host.features.acting_user_header;
  if (typeof acting === "string" && acting && actingUser.trim())
    out[acting] = actingUser.trim().slice(0, 100);
  return out;
}

/** The host's answer, or null when it did not answer usably (timeout, network, 5xx). */
async function send(
  host: WriteHost,
  request: Parameters<WriteHost["call"]>[0],
): Promise<HostResponse | null> {
  try {
    const response = await host.call(request);
    return response.status >= 500 ? null : response;
  } catch (error) {
    if (error instanceof HostCallFailed) return null;
    throw error;
  }
}

/** The result sentence's values: names from the preview, balances only from the host's answer (spec 11.10). */
function resultFields(preview: ActionPreview, facts: AnswerFacts | null): ResultFields {
  const line = preview.lines[0];
  return {
    customer: preview.customer?.name ?? null,
    supplier: preview.supplier?.name ?? null,
    due: facts?.customerDue != null ? BigInt(facts.customerDue) : null,
    payable: facts?.supplierPayable != null ? BigInt(facts.supplierPayable) : null,
    part: line?.name ?? null,
    rack: line?.rack ?? null,
  };
}

async function safely<T>(work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch {
    return null; // a check that cannot run is skipped, never a reason to fail the action
  }
}

export async function executeAction(input: {
  capability: WriteCapability;
  action: PendingAction;
  host: WriteHost;
  actingUser: string;
  read: ReadPath | null;
  now: () => Date;
}): Promise<Execution> {
  const { capability, action, host, read } = input;
  const preview = action.preview;
  const before: Snapshot | null = read ? await safely(() => snapshot(read, preview)) : null;
  const request = {
    method: action.request.method,
    path: action.request.path,
    query: action.request.query,
    ...(action.request.body ? { body: action.request.body } : {}),
    headers: headers(host, action.idempotencyKey, input.actingUser),
  };
  let response = await send(host, request);
  if (!response) {
    // Read back first: saved anyway is done; not found (or not knowable) is retried once, with the same key.
    const saved = read ? await safely(() => savedAnyway(read, preview, input.now())) : null;
    if (saved) {
      return {
        status: "done",
        response: null,
        verifyStatus: "skipped",
        text: resultText("done", preview.template, resultFields(preview, null)),
        undoAvailable: false,
      };
    }
    response = await send(host, request);
  }
  if (!response) {
    return {
      status: "failed",
      response: null,
      verifyStatus: "skipped",
      text: resultText("failed", preview.template, { reason: NO_ANSWER }),
      undoAvailable: false,
    };
  }
  if (response.status >= 300) {
    return {
      status: "failed",
      response: response.body,
      verifyStatus: "skipped",
      text: resultText("failed", preview.template, { reason: refusalOf(response, host.features) }),
      undoAvailable: false,
    };
  }

  // Verify: the record reads back, and stock and balance moved as expected.
  let mismatch = false;
  let checked = false;
  const readBack = capability.readBack;
  const operation = readBack ? host.operations[readBack.operation] : undefined;
  if (readBack && operation) {
    const id = readPath(response.body, readBack.idFrom);
    if (id === undefined || id === null) mismatch = true;
    else {
      const found = await send(host, {
        method: operation.httpMethod,
        path: operation.path.replace(/\{[^}]+\}/, encodeURIComponent(String(id))),
      });
      checked = true;
      if (!found || found.status !== 200) mismatch = true;
    }
  }
  if (read && before) {
    const after = await safely(() => snapshot(read, preview));
    const changed = after ? changedAsExpected(before, after, preview) : null;
    if (changed !== null) checked = true;
    if (changed === false) mismatch = true;
  }
  const facts = answerFacts(response.body);
  const status = mismatch ? "review" : "done";
  const compensationId = capability.compensation
    ? readPath(response.body, capability.compensation.idFrom)
    : undefined;
  return {
    status,
    response: response.body,
    verifyStatus: mismatch ? "mismatch" : checked ? "ok" : "skipped",
    text:
      status === "done"
        ? resultText("done", preview.template, resultFields(preview, facts))
        : resultText("review", preview.template),
    undoAvailable:
      status === "done" &&
      capability.compensation !== null &&
      compensationId !== undefined &&
      compensationId !== null &&
      host.operations[capability.compensation.operation] !== undefined,
  };
}

/** Fills {undo_reason} and {previous.<field>} placeholders of a compensation's body. */
export function fillBody(
  body: Record<string, unknown>,
  previous: Record<string, unknown> = {},
): Record<string, unknown> {
  const fill = (value: unknown): unknown => {
    if (typeof value === "string") {
      const match = /^\{([^{}]+)\}$/.exec(value);
      if (!match) return value;
      if (match[1] === "undo_reason") return UNDO_REASON;
      if (match[1]!.startsWith("previous."))
        return readPath(previous, match[1]!.slice("previous.".length)) ?? null;
      return value;
    }
    if (Array.isArray(value)) return value.map(fill);
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, fill(inner)]));
    return value;
  };
  return fill(body) as Record<string, unknown>;
}

export interface Undo {
  status: "undone" | "failed";
  request: {
    method: string;
    path: string;
    query: Record<string, string>;
    body: Record<string, unknown> | null;
  };
  response: unknown;
  text: string;
}

/** Undo (spec 11.9.1): the compensation with the ID from the answer, its body, the acting user and a new key. */
export async function undoAction(input: {
  capability: WriteCapability;
  done: { response: unknown; preview: ActionPreview };
  host: WriteHost;
  actingUser: string;
  idempotencyKey: string;
}): Promise<Undo | null> {
  const { capability, done, host } = input;
  const compensation = capability.compensation;
  const operation = compensation ? host.operations[compensation.operation] : undefined;
  const id = compensation ? readPath(done.response, compensation.idFrom) : undefined;
  if (!compensation || !operation || id === undefined || id === null) return null;
  const request = {
    method: operation.httpMethod,
    path: operation.path.replace(/\{[^}]+\}/, encodeURIComponent(String(id))),
    query: {},
    body: fillBody(compensation.body, done.preview.previous),
  };
  const response = await send(host, {
    ...request,
    headers: headers(host, input.idempotencyKey, input.actingUser),
  });
  if (!response) {
    return {
      status: "failed",
      request,
      response: null,
      text: resultText("failed", done.preview.template, { reason: NO_ANSWER }),
    };
  }
  if (response.status >= 300) {
    return {
      status: "failed",
      request,
      response: response.body,
      text: resultText("failed", done.preview.template, { reason: refusalOf(response, host.features) }),
    };
  }
  return {
    status: "undone",
    request,
    response: response.body,
    text: resultText("undone", done.preview.template, resultFields(done.preview, answerFacts(response.body))),
  };
}

/** How long staff may undo their own action (spec 11.9.1, D38). */
export const STAFF_UNDO_MS = 10 * 60_000;

/**
 * Who may undo (spec 11.9.1, D38): the owner always; staff only their own action, in the same conversation, within
 * 10 minutes of its done_at.
 */
export function mayUndo(input: {
  role: "owner" | "staff";
  userId: string;
  conversationId: string | null;
  now: Date;
  action: { userId: string; conversationId: string | null; doneAt: Date | null };
}): boolean {
  if (input.role === "owner") return true;
  const { action } = input;
  return (
    action.userId === input.userId &&
    action.conversationId !== null &&
    action.conversationId === input.conversationId &&
    action.doneAt !== null &&
    input.now.getTime() - action.doneAt.getTime() <= STAFF_UNDO_MS
  );
}
