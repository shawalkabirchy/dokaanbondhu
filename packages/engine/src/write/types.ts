import type { ActionTemplate } from "@dokaanbondhu/core";
import type { HostRequest, HostResponse } from "../host/api";

// The write path's data (spec 9.6, 9.9, 11.9): the capabilities a turn may offer as tools, the host they are sent to,
// and an action from its confirmation to its result. Everything host-shaped is data from the capability registry.

export interface WriteParam {
  /** JSON path as the host writes it: customer_id, items[].part_id. */
  path: string;
  location: "body" | "query" | "path";
  type: string;
  required: boolean;
  enumValues: string[] | null;
  entityConcept: string | null;
  semanticSlot: string | null;
  /** Spoken word -> the host's value. */
  spokenMap: Record<string, string> | null;
}

export interface OperationRef {
  operation: string;
  idFrom: string;
}

export interface WriteCapability {
  id: string;
  name: string;
  description: string | null;
  template: ActionTemplate;
  requiredRole: "staff" | "owner";
  httpMethod: string;
  path: string;
  /** The capability can run as a dry run (and the host's feature list says how). */
  dryRun: boolean;
  params: WriteParam[];
  compensation: (OperationRef & { capabilityId: string; body: Record<string, unknown> }) | null;
  readBack: OperationRef | null;
}

/** Any of the connection's operations, by name: read-backs and compensations are called through these. */
export interface HostOperation {
  id: string;
  name: string;
  httpMethod: string;
  path: string;
}

export interface WriteHost {
  /** Enabled writes; the turn offers those the user's role may use, never a compensation (D52). */
  capabilities: WriteCapability[];
  operations: Record<string, HostOperation>;
  /** The host feature list (spec 11.13). */
  features: Record<string, unknown>;
  /** One call through the connection's auth adapter (spec 11.12). */
  call: (request: HostRequest) => Promise<HostResponse>;
}

/** A host call as sent, kept in action_logs.request. */
export interface HostCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, unknown> | null;
}

/** One part line of an action, with what the checks after it need. */
export interface PreviewLine {
  hostPartId: string;
  name: string;
  quantity: number;
  unit: string | null;
  rack: string | null;
}

/** What the confirmation showed and what the action is expected to change (action_logs.preview). */
export interface ActionPreview {
  template: ActionTemplate;
  text: string;
  fields: { label: string; value: string; highlight: boolean }[];
  warnings: string[];
  total: number | null;
  paid: number;
  lines: PreviewLine[];
  customer: { hostId: string; name: string } | null;
  supplier: { hostId: string; name: string } | null;
  /** Expected changes: stock per part (units), and the customer's due or the supplier's payable (taka). */
  expect: { stock: Record<string, number>; balance: number | null };
  /** The values an undo may put back ({previous.<field>}). */
  previous?: Record<string, unknown>;
}

/** An action waiting for yes or no (spec 9.9): its row in action_logs. */
export interface PendingAction {
  id: string;
  capabilityId: string;
  request: HostCall;
  preview: ActionPreview;
  idempotencyKey: string;
  expiresAt: string;
}

export type ActionStatus = "pending" | "done" | "failed" | "review" | "cancelled" | "undone";

/** A change to action_logs that the turn asks the server to save. */
export interface ActionRecord {
  id: string;
  capabilityId: string;
  status: ActionStatus;
  request?: HostCall;
  preview?: ActionPreview;
  response?: unknown;
  verifyStatus?: "ok" | "mismatch" | "skipped";
  idempotencyKey?: string;
  undoOf?: string;
  confirmedAt?: string;
  doneAt?: string;
  undoneAt?: string;
}

export type { HostRequest, HostResponse };
