import type { CapabilityPatch, CapabilityView } from "@dokaanbondhu/contracts";
import { capabilities, capabilityParams, type Tx } from "@dokaanbondhu/platform-db";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  SAFETY_CRITICAL_SLOTS,
  type ImportedCapability,
  type ImportedDocument,
  type ImportedParam,
} from "./openapi-import";

// The capability registry (spec 7.2, 11.8; D134): an import saved with the re-import rules, the owner's changes, and
// the rules for switching a capability on. Every call runs inside the caller's withShop() transaction.

type CapabilityRow = typeof capabilities.$inferSelect;
type ParamRow = typeof capabilityParams.$inferSelect;

interface Compensation {
  operation: string;
  id_from: string;
  body: Record<string, unknown>;
}
interface ReadBack {
  operation: string;
  id_from: string;
}

export interface ImportSummary {
  added: string[];
  changed: string[];
  kept: string[];
  removed: string[];
  unresolved: string[];
}

export class CapabilityChangeRefused extends Error {
  constructor(
    readonly code: "CAPABILITY_NOT_VERIFIED" | "VALIDATION_FAILED",
    readonly details: Record<string, unknown>,
  ) {
    super(code);
  }
}

const compensationOf = (capability: ImportedCapability): Compensation | null =>
  capability.compensation
    ? {
        operation: capability.compensation.operation,
        id_from: capability.compensation.idFrom,
        body: capability.compensation.body,
      }
    : null;

const readBackOf = (capability: ImportedCapability): ReadBack | null =>
  capability.readBack
    ? { operation: capability.readBack.operation, id_from: capability.readBack.idFrom }
    : null;

const paramValues = (shopId: string, capabilityId: string, param: ImportedParam) => ({
  shopId,
  capabilityId,
  path: param.path,
  location: param.location,
  type: param.type,
  required: param.required,
  enumValues: param.enumValues,
  entityConcept: param.entityConcept,
  semanticSlot: param.semanticSlot,
  safetyCritical: param.safetyCritical,
  spokenMap: param.spokenMap,
  confirmed: false,
});

/** The same leaf: its confirmed choices still hold. */
const sameLeaf = (old: ParamRow, param: ImportedParam) =>
  old.location === param.location &&
  old.type === param.type &&
  JSON.stringify(old.enumValues ?? null) === JSON.stringify(param.enumValues ?? null);

/**
 * Saves an import (spec 11.8 step 5). New: added switched off with every proposal unconfirmed. Same hash: every choice
 * the owner made stays; a hint only fills an empty compensation or read-back. Changed hash: switched off and
 * unverified until the sandbox passes it again; role and template stay, a hint replaces what it names, and a
 * parameter keeps its confirmed choices only while its leaf is the same. Gone from the document: switched off and
 * unverified, kept for the action log. Compensations are then linked by name.
 */
export async function saveImport(
  tx: Tx,
  shopId: string,
  connectionId: string,
  imported: ImportedDocument,
  source: "openapi" | "scanner" = "openapi",
): Promise<ImportSummary> {
  const summary: ImportSummary = { added: [], changed: [], kept: [], removed: [], unresolved: [] };
  const existing = await tx.select().from(capabilities).where(eq(capabilities.connectionId, connectionId));
  const byName = new Map(existing.map((row) => [row.name, row]));
  const now = new Date();

  for (const capability of imported.capabilities) {
    const row = byName.get(capability.name);
    const compensation = compensationOf(capability);
    const readBack = readBackOf(capability);
    const fromDocument = {
      description: capability.description || null,
      kind: capability.kind,
      httpMethod: capability.httpMethod,
      path: capability.path,
      operationId: capability.operationId,
      source,
      requestSchema: capability.requestSchema,
      responseSchema: capability.responseSchema,
      schemaHash: capability.schemaHash,
      preview: { dry_run: capability.supportsDryRun },
      updatedAt: now,
    };
    if (!row) {
      const [inserted] = await tx
        .insert(capabilities)
        .values({
          shopId,
          connectionId,
          name: capability.name,
          ...fromDocument,
          requiredRole: capability.requiredRole,
          template: capability.template,
          compensation,
          readBack,
        })
        .returning({ id: capabilities.id });
      if (capability.params.length) {
        await tx
          .insert(capabilityParams)
          .values(capability.params.map((param) => paramValues(shopId, inserted!.id, param)));
      }
      summary.added.push(capability.name);
      continue;
    }
    if (row.schemaHash === capability.schemaHash) {
      await tx
        .update(capabilities)
        .set({
          description: fromDocument.description,
          responseSchema: fromDocument.responseSchema,
          preview: fromDocument.preview,
          compensation: row.compensation ?? compensation,
          readBack: row.readBack ?? readBack,
          updatedAt: now,
        })
        .where(eq(capabilities.id, row.id));
      summary.kept.push(capability.name);
      continue;
    }
    await tx
      .update(capabilities)
      .set({
        ...fromDocument,
        compensation: compensation ?? row.compensation,
        readBack: readBack ?? row.readBack,
        enabled: false,
        verifiedAt: null,
        verificationReport: null,
      })
      .where(eq(capabilities.id, row.id));
    const old = await tx.select().from(capabilityParams).where(eq(capabilityParams.capabilityId, row.id));
    const oldByPath = new Map(old.map((param) => [param.path, param]));
    const kept = new Map<string, ImportedParam>();
    for (const param of capability.params) {
      const previous = oldByPath.get(param.path);
      if (previous && sameLeaf(previous, param)) kept.set(previous.id, param);
    }
    const gone = old.filter((param) => !kept.has(param.id)).map((param) => param.id);
    if (gone.length) await tx.delete(capabilityParams).where(inArray(capabilityParams.id, gone));
    for (const [id, param] of kept) {
      await tx.update(capabilityParams).set({ required: param.required }).where(eq(capabilityParams.id, id));
    }
    const keptPaths = new Set([...kept.values()].map((param) => param.path));
    const added = capability.params.filter((param) => !keptPaths.has(param.path));
    if (added.length) {
      await tx.insert(capabilityParams).values(added.map((param) => paramValues(shopId, row.id, param)));
    }
    summary.changed.push(capability.name);
  }

  const names = new Set(imported.capabilities.map((capability) => capability.name));
  for (const row of existing) {
    if (names.has(row.name) || row.source !== source) continue;
    await tx
      .update(capabilities)
      .set({ enabled: false, verifiedAt: null, verificationReport: null, updatedAt: now })
      .where(eq(capabilities.id, row.id));
    summary.removed.push(row.name);
  }

  // Compensations by name, among what the document still has.
  const rows = await tx
    .select({
      id: capabilities.id,
      name: capabilities.name,
      compensation: capabilities.compensation,
      compensatingCapabilityId: capabilities.compensatingCapabilityId,
    })
    .from(capabilities)
    .where(eq(capabilities.connectionId, connectionId));
  const live = new Map(
    rows
      .filter((row) => names.has(row.name) || !summary.removed.includes(row.name))
      .map((row) => [row.name, row.id]),
  );
  for (const row of rows) {
    const operation = (row.compensation as Compensation | null)?.operation;
    const target = operation ? (live.get(operation) ?? null) : null;
    if (operation && !target && !summary.removed.includes(row.name)) summary.unresolved.push(row.name);
    if (row.compensatingCapabilityId !== target) {
      await tx
        .update(capabilities)
        .set({ compensatingCapabilityId: target })
        .where(eq(capabilities.id, row.id));
    }
  }
  return summary;
}

function paramView(param: ParamRow): CapabilityView["params"][number] {
  return {
    id: param.id,
    path: param.path,
    location: param.location as CapabilityView["params"][number]["location"],
    type: param.type,
    required: param.required,
    enum_values: (param.enumValues as string[] | null) ?? null,
    entity_concept: param.entityConcept,
    semantic_slot: param.semanticSlot,
    safety_critical: param.safetyCritical,
    spoken_map: (param.spokenMap as Record<string, string> | null) ?? null,
    confirmed: param.confirmed,
  };
}

function capabilityView(row: CapabilityRow, params: ParamRow[], isCompensation: boolean): CapabilityView {
  const compensation = row.compensation as Compensation | null;
  return {
    id: row.id,
    connection_id: row.connectionId,
    name: row.name,
    description: row.description,
    kind: row.kind as CapabilityView["kind"],
    http_method: row.httpMethod,
    path: row.path,
    source: row.source as CapabilityView["source"],
    schema_hash: row.schemaHash,
    required_role: row.requiredRole as CapabilityView["required_role"],
    template: row.template as CapabilityView["template"],
    enabled: row.enabled,
    verified_at: row.verifiedAt?.toISOString() ?? null,
    dry_run: (row.preview as { dry_run?: boolean } | null)?.dry_run === true,
    compensation: compensation ? { ...compensation, capability_id: row.compensatingCapabilityId } : null,
    read_back: (row.readBack as ReadBack | null) ?? null,
    is_compensation: isCompensation,
    params: params.map(paramView),
  };
}

/** The shop's capabilities with their parameters: one connection's, one by ID, or all. */
export async function capabilityViews(
  tx: Tx,
  filter: { connectionId?: string; id?: string } = {},
): Promise<CapabilityView[]> {
  const where = filter.id
    ? eq(capabilities.id, filter.id)
    : filter.connectionId
      ? eq(capabilities.connectionId, filter.connectionId)
      : undefined;
  const rows = await tx
    .select()
    .from(capabilities)
    .where(where)
    .orderBy(asc(capabilities.kind), asc(capabilities.name));
  if (!rows.length) return [];
  const connectionIds = [...new Set(rows.map((row) => row.connectionId))];
  const links = await tx
    .select({ id: capabilities.id, target: capabilities.compensatingCapabilityId })
    .from(capabilities)
    .where(inArray(capabilities.connectionId, connectionIds));
  const compensations = new Set(
    links.filter((link) => link.target && link.target !== link.id).map((link) => link.target),
  );
  const params = await tx
    .select()
    .from(capabilityParams)
    .where(
      inArray(
        capabilityParams.capabilityId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(asc(capabilityParams.path));
  return rows.map((row) =>
    capabilityView(
      row,
      params.filter((param) => param.capabilityId === row.id),
      compensations.has(row.id),
    ),
  );
}

async function sibling(tx: Tx, connectionId: string, name: string) {
  const [row] = await tx
    .select({ id: capabilities.id, kind: capabilities.kind })
    .from(capabilities)
    .where(and(eq(capabilities.connectionId, connectionId), eq(capabilities.name, name)));
  return row ?? null;
}

/**
 * The owner's change to one capability (PATCH /setup/capabilities/{id}). It is switched on only when it is a write,
 * not another capability's compensation (D52), verified by the sandbox (spec 11.11) and every required parameter is
 * confirmed (spec 11.8); a change that would leave a switched-on capability short of that is refused. Null: not found.
 */
export async function changeCapability(
  tx: Tx,
  capabilityId: string,
  patch: CapabilityPatch,
): Promise<CapabilityView | null> {
  const [row] = await tx.select().from(capabilities).where(eq(capabilities.id, capabilityId)).for("update");
  if (!row) return null;
  const params = await tx
    .select()
    .from(capabilityParams)
    .where(eq(capabilityParams.capabilityId, capabilityId));
  const byPath = new Map(params.map((param) => [param.path, param]));

  const paramChanges: { id: string; set: Partial<ParamRow> }[] = [];
  for (const change of patch.params ?? []) {
    const param = byPath.get(change.path);
    if (!param) {
      throw new CapabilityChangeRefused("VALIDATION_FAILED", {
        field: "params",
        path: change.path,
        reason: "no such parameter",
      });
    }
    if (change.spoken_map) {
      const values = (param.enumValues as string[] | null) ?? [];
      const unknown = Object.values(change.spoken_map).filter((value) => !values.includes(value));
      if (unknown.length) {
        throw new CapabilityChangeRefused("VALIDATION_FAILED", {
          field: "params",
          path: change.path,
          reason: "a spoken word must name one of the parameter's values",
          values: unknown,
        });
      }
    }
    const set: Partial<ParamRow> = {};
    if (change.entity_concept !== undefined) set.entityConcept = change.entity_concept;
    if (change.semantic_slot !== undefined) {
      set.semanticSlot = change.semantic_slot;
      set.safetyCritical = SAFETY_CRITICAL_SLOTS.has(change.semantic_slot ?? "");
    }
    if (change.spoken_map !== undefined) set.spokenMap = change.spoken_map;
    if (change.confirmed !== undefined) set.confirmed = change.confirmed;
    Object.assign(param, set);
    paramChanges.push({ id: param.id, set });
  }

  const set: Partial<CapabilityRow> = { updatedAt: new Date() };
  if (patch.required_role) set.requiredRole = patch.required_role;
  if (patch.template) set.template = patch.template;
  if (patch.compensation !== undefined) {
    if (patch.compensation === null) {
      set.compensation = null;
      set.compensatingCapabilityId = null;
    } else {
      const target = await sibling(tx, row.connectionId, patch.compensation.operation);
      if (!target || target.kind !== "write") {
        throw new CapabilityChangeRefused("VALIDATION_FAILED", {
          field: "compensation",
          reason: "the compensation must name a write of the same connection",
        });
      }
      set.compensation = { ...patch.compensation, body: patch.compensation.body ?? {} };
      set.compensatingCapabilityId = target.id;
    }
  }
  if (patch.read_back !== undefined) {
    if (patch.read_back) {
      const target = await sibling(tx, row.connectionId, patch.read_back.operation);
      if (!target || target.kind !== "read") {
        throw new CapabilityChangeRefused("VALIDATION_FAILED", {
          field: "read_back",
          reason: "the read-back must name a read of the same connection",
        });
      }
    }
    set.readBack = patch.read_back;
  }

  const enabled = patch.enabled ?? row.enabled;
  if (enabled) {
    if (row.kind !== "write") {
      throw new CapabilityChangeRefused("VALIDATION_FAILED", {
        field: "enabled",
        reason: "only writes become tools; reads go through the read path (D43)",
      });
    }
    if (patch.enabled) {
      const [link] = await tx
        .select({ id: capabilities.id })
        .from(capabilities)
        .where(
          and(
            eq(capabilities.compensatingCapabilityId, row.id),
            eq(capabilities.connectionId, row.connectionId),
          ),
        );
      if (link && link.id !== row.id) {
        throw new CapabilityChangeRefused("VALIDATION_FAILED", {
          field: "enabled",
          reason: "an undo action is never a tool (D52)",
        });
      }
    }
    if (!row.verifiedAt)
      throw new CapabilityChangeRefused("CAPABILITY_NOT_VERIFIED", { capability: row.name });
    const unconfirmed = params
      .filter((param) => param.required && !param.confirmed)
      .map((param) => param.path);
    if (unconfirmed.length) {
      throw new CapabilityChangeRefused("VALIDATION_FAILED", {
        field: "params",
        reason: "every required parameter must be confirmed first",
        unconfirmed,
      });
    }
    set.enabled = true;
  } else {
    set.enabled = false;
  }

  for (const change of paramChanges) {
    await tx.update(capabilityParams).set(change.set).where(eq(capabilityParams.id, change.id));
  }
  await tx.update(capabilities).set(set).where(eq(capabilities.id, capabilityId));
  return (await capabilityViews(tx, { id: capabilityId }))[0]!;
}
