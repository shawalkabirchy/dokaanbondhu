import type { ActionTemplate } from "@dokaanbondhu/core";
import type { Catalog } from "../host/catalog";
import { toTaka } from "../host/find-parts";
import type { ImportedDocument } from "../host/openapi-import";
import { hasField } from "../host/schema-map";
import { buildQuery } from "../host/sql";
import { executeAction, undoAction } from "./execute";
import { answerFacts, buildBody, cashMethod, dryRunQuery, type ResolvedWrite } from "./request";
import type { ActionPreview, HostRequest, HostResponse, WriteCapability, WriteHost } from "./types";
import { snapshot, type ReadPath, type Snapshot } from "./verify";

// The sandbox check (spec 11.11; D139): on a throw-away copy of the host, every write is run with sample values from
// the host's own data. Its dry run must change nothing; the real call must save, read back and move stock and balance
// as expected; its compensation must put everything back. The report names each capability with its schema hash, so
// admin import-verification marks only what was checked as it is now. Nothing here names a host.

export interface VerificationEntry {
  name: string;
  schema_hash: string;
  result: "pass" | "fail" | "skipped";
  checks: { name: string; ok: boolean; detail?: string }[];
}

export interface VerificationReport {
  host: string;
  commit: string;
  date: string;
  capabilities: VerificationEntry[];
}

/** The writes of an imported document as the write path uses them, every one switched on. */
export function writeHostOf(
  imported: ImportedDocument,
  call: (request: HostRequest) => Promise<HostResponse>,
  newId: () => string,
): WriteHost {
  const ids = new Map(imported.capabilities.map((capability) => [capability.name, newId()]));
  const undoOnly = new Set(
    imported.capabilities
      .filter(
        (capability) => capability.compensation && capability.compensation.operation !== capability.name,
      )
      .map((capability) => capability.compensation!.operation),
  );
  return {
    capabilities: imported.capabilities
      .filter((capability) => capability.kind === "write" && !undoOnly.has(capability.name))
      .map((capability): WriteCapability => ({
        id: ids.get(capability.name)!,
        name: capability.name,
        description: capability.description || null,
        template: capability.template as ActionTemplate,
        requiredRole: capability.requiredRole,
        httpMethod: capability.httpMethod,
        path: capability.path,
        dryRun: capability.supportsDryRun,
        params: capability.params,
        compensation:
          capability.compensation && ids.has(capability.compensation.operation)
            ? {
                capabilityId: ids.get(capability.compensation.operation)!,
                operation: capability.compensation.operation,
                idFrom: capability.compensation.idFrom,
                body: capability.compensation.body,
              }
            : null,
        readBack: capability.readBack,
      })),
    operations: Object.fromEntries(
      imported.capabilities.map((capability) => [
        capability.name,
        {
          id: ids.get(capability.name)!,
          name: capability.name,
          httpMethod: capability.httpMethod,
          path: capability.path,
        },
      ]),
    ),
    features: imported.features,
    call,
  };
}

interface Samples {
  customer: { hostId: string; name: string } | null;
  supplier: { hostId: string; name: string } | null;
  part: { hostId: string; name: string; unit: string | null; cost: number } | null;
}

/** Sample values from the host's own data: the customer with the largest due, a supplier, the part with most stock. */
async function samplesOf(read: ReadPath, catalog: Catalog): Promise<Samples> {
  const { map, run } = read;
  let customer = catalog.customers[0] ?? null;
  if (hasField(map, "Customer", "id") && hasField(map, "Customer", "due_balance")) {
    const [row] = await run(
      buildQuery(map, {
        from: { concept: "Customer", alias: "c" },
        select: [
          { ref: { alias: "c", field: "id" }, as: "id" },
          { ref: { alias: "c", field: "due_balance" }, as: "due" },
        ],
        orderBy: [{ as: "due", direction: "desc" }],
        limit: 1,
      }),
    );
    customer = catalog.customers.find((item) => item.hostId === String(row?.id)) ?? customer;
  }
  let partId: string | null = catalog.parts[0]?.hostId ?? null;
  if (hasField(map, "StockItem", "part_id") && hasField(map, "StockItem", "quantity")) {
    const [row] = await run(
      buildQuery(map, {
        from: { concept: "StockItem", alias: "s" },
        select: [
          { ref: { alias: "s", field: "part_id" }, as: "part_id" },
          { ref: { alias: "s", field: "quantity" }, as: "quantity", aggregate: "sum" },
        ],
        groupBy: [{ alias: "s", field: "part_id" }],
        orderBy: [{ as: "quantity", direction: "desc" }],
        limit: 1,
      }),
    );
    if (row) partId = String(row.part_id);
  }
  let cost = 100;
  if (partId && hasField(map, "Price", "part_id") && hasField(map, "Price", "cost")) {
    const [row] = await run(
      buildQuery(map, {
        from: { concept: "Price", alias: "p" },
        select: [{ ref: { alias: "p", field: "cost" }, as: "cost" }],
        where: [{ ref: { alias: "p", field: "part_id" }, op: "eq", value: partId }],
        limit: 1,
      }),
    );
    const taka = toTaka(row?.cost);
    if (taka !== null && taka > 0n) cost = Number(taka);
  }
  const part = catalog.parts.find((item) => item.hostId === partId);
  const supplier = catalog.suppliers[0];
  return {
    customer: customer ? { hostId: customer.hostId, name: customer.name } : null,
    supplier: supplier ? { hostId: supplier.hostId, name: supplier.name } : null,
    part: part
      ? { hostId: part.hostId, name: part.name, unit: (part.attrs.unit as string | undefined) ?? null, cost }
      : null,
  };
}

/** The sample request of each template step 5 enables, or null when the check has no sample for it yet. */
function sampleOf(capability: WriteCapability, samples: Samples): ResolvedWrite | null {
  const { customer, supplier, part } = samples;
  if (capability.template === "sale" && customer && part)
    return { customer, line: { hostPartId: part.hostId, quantity: 1 }, payments: [] };
  if (capability.template === "payment" && customer) {
    const cash = cashMethod(capability);
    return cash ? { customer, payments: [{ method: cash, amount: null }], amount: 100 } : null;
  }
  if (capability.template === "stock_in" && supplier && part)
    return { supplier, line: { hostPartId: part.hostId, quantity: 1, unitCost: part.cost }, payments: [] };
  return null;
}

const same = (a: Snapshot, b: Snapshot) => JSON.stringify(a) === JSON.stringify(b);

/** Runs every write of the document on the sandbox host and reports each with its schema hash. */
export async function verifyCapabilities(input: {
  imported: ImportedDocument;
  host: WriteHost;
  read: ReadPath;
  catalog: Catalog;
  hostName: string;
  commit: string;
  now: () => Date;
  newId: () => string;
}): Promise<VerificationReport> {
  const { imported, host, read } = input;
  const samples = await samplesOf(read, input.catalog);
  const hashOf = new Map(imported.capabilities.map((capability) => [capability.name, capability.schemaHash]));
  const entries: VerificationEntry[] = [];
  const dry = dryRunQuery(host.features);

  for (const capability of host.capabilities) {
    const resolved = sampleOf(capability, samples);
    const checks: VerificationEntry["checks"] = [];
    const entry = (result: VerificationEntry["result"]): VerificationEntry => ({
      name: capability.name,
      schema_hash: hashOf.get(capability.name) ?? "",
      result,
      checks,
    });
    if (!resolved) {
      entries.push(entry("skipped"));
      continue;
    }
    const preview: ActionPreview = {
      template: capability.template,
      text: "",
      fields: [],
      warnings: [],
      total: null,
      paid: capability.template === "payment" ? (resolved.amount ?? 0) : 0,
      lines: resolved.line
        ? [
            {
              hostPartId: resolved.line.hostPartId,
              name: samples.part!.name,
              quantity: 1,
              unit: samples.part!.unit,
              rack: null,
            },
          ]
        : [],
      customer: resolved.customer ?? null,
      supplier: resolved.supplier ?? null,
      expect: { stock: {}, balance: null },
    };
    // The samples sell and buy on credit; only a payment has an amount, and it is the payment's own.
    resolved.payments = (resolved.payments ?? []).map((payment) => ({
      ...payment,
      amount: payment.amount ?? resolved.amount ?? null,
    }));
    const body = buildBody(capability, resolved).body;
    const before = await snapshot(read, preview);
    let total: number | null = null;
    if (capability.dryRun && dry) {
      const answer = await host.call({
        method: capability.httpMethod,
        path: capability.path,
        query: dry,
        body,
      });
      total = answerFacts(answer.body).total;
      const unchanged = same(before, await snapshot(read, preview));
      checks.push({ name: "dry_run_changes_nothing", ok: answer.status < 300 && unchanged });
    }
    if (total === null && resolved.line?.unitCost) total = resolved.line.unitCost * resolved.line.quantity;
    const paid = capability.template === "payment" ? (resolved.amount ?? 0) : 0;
    preview.total = total;
    preview.expect = {
      stock: resolved.line
        ? {
            [resolved.line.hostPartId]:
              capability.template === "stock_in" ? 1 : capability.template === "sale" ? -1 : 0,
          }
        : {},
      balance: capability.template === "payment" ? -paid : total !== null ? total - paid : null,
    };
    const execution = await executeAction({
      capability,
      action: {
        id: input.newId(),
        capabilityId: capability.id,
        request: { method: capability.httpMethod, path: capability.path, query: {}, body },
        preview,
        idempotencyKey: input.newId(),
        expiresAt: input.now().toISOString(),
      },
      host,
      actingUser: "Sandbox check",
      read,
      now: input.now,
    });
    checks.push({ name: "saved", ok: execution.status === "done", detail: execution.text });
    checks.push({
      name: "read_back_stock_and_balance",
      ok: execution.verifyStatus === "ok",
      detail: execution.verifyStatus,
    });
    if (capability.compensation && execution.status === "done") {
      const undo = await undoAction({
        capability,
        done: { response: execution.response, preview },
        host,
        actingUser: "Sandbox check",
        idempotencyKey: input.newId(),
      });
      const undone = undo?.status === "undone" && same(before, await snapshot(read, preview));
      checks.push({ name: "undo_puts_everything_back", ok: undone, detail: undo?.text });
      entries.push({
        name: capability.compensation.operation,
        schema_hash: hashOf.get(capability.compensation.operation) ?? "",
        result: undone ? "pass" : "fail",
        checks: [{ name: `undoes ${capability.name}`, ok: undone }],
      });
    }
    entries.push(entry(checks.every((check) => check.ok) ? "pass" : "fail"));
  }
  return {
    host: input.hostName,
    commit: input.commit,
    date: input.now().toISOString(),
    capabilities: entries,
  };
}
