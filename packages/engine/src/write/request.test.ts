import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { importOpenApi } from "../host/openapi-import";
import { fillBody, UNDO_REASON } from "./execute";
import { answerFacts, buildBody, dryRunQuery, readPath, refusalOf, setPath } from "./request";
import { writeTool } from "./tool";
import type { WriteCapability } from "./types";

// The write path's requests and answers (spec 9.6, 11.9; D136): a body built from slots by the host's own paths, and
// answers read by field names, on the test host's document and on another host's answer shape.

const fixture = JSON.parse(
  readFileSync(new URL("../../../../tools/fixtures/openapi/geargrid-openapi.json", import.meta.url), "utf8"),
) as unknown;

function capability(name: string): WriteCapability {
  const found = importOpenApi(fixture).capabilities.find((item) => item.name === name)!;
  return {
    id: name,
    name,
    description: found.description,
    template: found.template as WriteCapability["template"],
    requiredRole: found.requiredRole,
    httpMethod: found.httpMethod,
    path: found.path,
    dryRun: found.supportsDryRun,
    params: found.params,
    compensation: null,
    readBack: found.readBack,
  };
}

describe("host requests", () => {
  it("writes and reads JSON paths, lists included", () => {
    const body: Record<string, unknown> = {};
    setPath(body, "items[].part_id", "p1");
    setPath(body, "items[].quantity", 2);
    setPath(body, "payments[].method", "cash", 1);
    setPath(body, "customer_id", "c1");
    expect(body).toEqual({
      items: [{ part_id: "p1", quantity: 2 }],
      payments: [undefined, { method: "cash" }],
      customer_id: "c1",
    });
    expect(readPath({ sale: { id: "s1" } }, "sale.id")).toBe("s1");
    expect(readPath({ items: [{ id: "i1" }] }, "items.0.id")).toBe("i1");
    expect(readPath({ sale: null }, "sale.id")).toBeUndefined();
  });

  it("builds a credit sale and a cash sale from slots, by the host's own paths", () => {
    const sale = capability("record_sale");
    const line = { hostPartId: "part-1", quantity: 2 };
    expect(
      buildBody(sale, { customer: { hostId: "cust-1", name: "Rahim Motors" }, line, payments: [] }),
    ).toEqual({
      body: { customer_id: "cust-1", items: [{ part_id: "part-1", quantity: 2 }] },
      missing: [],
    });
    expect(
      buildBody(sale, { line, payments: [{ method: "cash", amount: 3200, trxId: null }], note: "পরে নেবে" })
        .body,
    ).toEqual({
      items: [{ part_id: "part-1", quantity: 2 }],
      payments: [{ method: "cash", amount_taka: 3200 }],
      note: "পরে নেবে",
    });
    // a required part line not understood yet is missing
    expect(buildBody(sale, { payments: [] }).missing).toEqual(["items[].part_id", "items[].quantity"]);
  });

  it("builds a payment, its method and amount from their own slots", () => {
    expect(
      buildBody(capability("receive_payment"), {
        customer: { hostId: "cust-1", name: "Rahim Motors" },
        payments: [{ method: "bkash", amount: null, trxId: "TRX1" }],
        amount: 10_000,
      }),
    ).toEqual({
      body: { method: "bkash", amount_taka: 10_000, trx_id: "TRX1", customer_id: "cust-1" },
      missing: [],
    });
  });

  it("reads the dry-run switch of the feature list", () => {
    expect(dryRunQuery({ dry_run: "?dry_run=true" })).toEqual({ dry_run: "true" });
    expect(dryRunQuery({})).toBeNull();
  });
});

describe("host answers", () => {
  it("reads the test host's total, the customer's due and its Bangla warnings", () => {
    expect(
      answerFacts({
        sale: { id: "s1", total_taka: 3200, due_taka: 3200 },
        customer: { id: "c1", due_balance_taka: 22_400 },
        warnings: [{ code: "LOW_STOCK", message_en: "Low stock", message_bn: "স্টক কম।" }],
      }),
    ).toEqual({ total: 3200, customerDue: 22_400, supplierPayable: null, warnings: ["স্টক কম।"] });
  });

  it("reads another host's flat answer, and a supplier's payable", () => {
    expect(answerFacts({ id: 9812, total: 4200, customer_due: 23_400 })).toMatchObject({
      total: 4200,
      customerDue: 23_400,
    });
    expect(
      answerFacts({ purchase: { totalAmount: 4800 }, supplier: { payableBalance: 9000 } }),
    ).toMatchObject({
      total: 4800,
      supplierPayable: 9000,
    });
  });

  it("says a refusal in the host's Bangla where the feature list names it, else by its status", () => {
    const refused = {
      status: 422,
      headers: new Headers(),
      body: { error: { message_bn: "স্টকে যথেষ্ট নেই" } },
    };
    expect(refusalOf(refused, { bangla_errors: "error.message_bn" })).toBe("স্টকে যথেষ্ট নেই।");
    expect(refusalOf(refused, {})).toBe("অ্যাপ তথ্যগুলো নেয়নি।");
  });

  it("fills an undo's placeholders", () => {
    expect(
      fillBody(
        { reason: "{undo_reason}", retail_price_taka: "{previous.retail_price_taka}", keep: "x" },
        { retail_price_taka: 4200 },
      ),
    ).toEqual({ reason: UNDO_REASON, retail_price_taka: 4200, keep: "x" });
  });
});

describe("capability tools (spec 9.6)", () => {
  it("offers semantic arguments as said, never host IDs", () => {
    const tool = writeTool(capability("stock_in")).function;
    expect(tool.name).toBe("stock_in");
    const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(properties).sort()).toEqual(["items", "payment", "supplier"]);
    const line = (properties.items as { items: { properties: Record<string, unknown> } }).items.properties;
    expect(Object.keys(line).sort()).toEqual(["part", "quantity", "unit_cost"]);
    expect(JSON.stringify(tool.parameters)).not.toMatch(/supplier_id|part_id|customer_id/);
  });
});
