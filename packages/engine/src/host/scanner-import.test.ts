import { readFileSync } from "node:fs";
import { scannerSummarySchema, type ScannerSummary } from "@dokaanbondhu/contracts";
import { describe, expect, it } from "vitest";
import { importOpenApi, type ImportedCapability } from "./openapi-import";
import { importScannerSummary, scannerDocument } from "./scanner-import";

// A Laravel scanner summary imported as capabilities (spec 11.8 step 6, D183): the scanner's fixture summary
// (fixtures/laravel/expected-summary.json, checked against the fixture app by the scanner's own tests) goes through the
// OpenAPI importer, so its proposals are the same as for any app's own document.

const summary = scannerSummarySchema.parse(
  JSON.parse(
    readFileSync(new URL("../../../../fixtures/laravel/expected-summary.json", import.meta.url), "utf8"),
  ),
);
const imported = importScannerSummary(summary);
const byName = (name: string) => imported.capabilities.find((item) => item.name === name)!;
const param = (capability: ImportedCapability, path: string) =>
  capability.params.find((item) => item.path === path)!;

describe("scanner summary import", () => {
  it("makes each route a capability, named by its Laravel route name, else its handler", () => {
    expect(
      imported.capabilities.map((item) => `${item.httpMethod} ${item.path} ${item.name} ${item.kind}`),
    ).toEqual([
      "GET /sales sales_index read",
      "POST /sales sales_store write",
      "GET /sales/{sale} sales_show read",
      "POST /sales/{sale}/void sales_void write",
      "POST /returns returns_store write",
      "PATCH /parts/{part}/price parts_price write",
      "DELETE /parts/{part} parts_destroy write",
      "POST /api/payments payments_store write",
      "GET /api/payments/{payment} payment_show read",
      "POST /api/stock-in stock_in write",
    ]);
    // The features list names no document to fetch again.
    expect(imported.features).toEqual({});
  });

  it("proposes a sale's slots, entity and spoken words from the rules", () => {
    const sale = byName("sales_store");
    expect(sale.template).toBe("sale");
    expect(sale.requiredRole).toBe("staff");
    expect(param(sale, "customer_id")).toMatchObject({
      semanticSlot: "customer",
      entityConcept: "Customer",
      required: false,
      type: "integer",
    });
    expect(param(sale, "items[].part_id")).toMatchObject({
      semanticSlot: "items",
      entityConcept: "Part",
      required: true,
    });
    expect(param(sale, "items[].quantity")).toMatchObject({
      semanticSlot: "items",
      required: true,
      type: "integer",
    });
    expect(param(sale, "items[].unit_price")).toMatchObject({
      semanticSlot: "items",
      required: false,
      type: "number",
    });
    const method = param(sale, "payment_method");
    expect(method).toMatchObject({
      semanticSlot: "payment",
      required: true,
      enumValues: ["cash", "bkash", "due"],
    });
    expect(method.spokenMap).toMatchObject({ nogode: "cash", bikash: "bkash" });
    expect(param(sale, "tags")).toMatchObject({ type: "array<string>", required: false });
    expect(param(sale, "sold_on")).toMatchObject({ type: "string:date", required: false });
    // The rules travel with the schema, for the owner to read.
    expect(sale.description).toMatch(
      /^POST \/sales \(SaleController@store\)\. StoreSaleRequest: customer_id\?, /,
    );
    expect(JSON.stringify(sale.requestSchema)).toContain("required|integer|min:1|max:999");
  });

  it("names the entity from an exists rule's table, whatever the field is called", () => {
    const stockIn = byName("stock_in");
    expect(param(stockIn, "vendor_id")).toMatchObject({
      entityConcept: "Supplier",
      semanticSlot: "supplier",
    });
    expect(param(stockIn, "lines[].product_id")).toMatchObject({
      entityConcept: "Part",
      semanticSlot: "items",
    });
    expect(param(stockIn, "lines[].qty").semanticSlot).toBe("items");
    expect(stockIn.template).toBe("stock_in");
    // A table that is no concept leaves the name's proposal.
    expect(param(byName("returns_store"), "sale_item_id").entityConcept).toBe("SaleItem");
    expect(param(byName("parts_price"), "part")).toMatchObject({ location: "path", entityConcept: null });
    expect(param(byName("sales_void"), "sale")).toMatchObject({
      location: "path",
      entityConcept: "Sale",
      required: true,
    });
  });

  it("proposes payments, price changes (owner only) and query parameters", () => {
    const payment = byName("payments_store");
    expect(payment.template).toBe("payment");
    expect(param(payment, "amount")).toMatchObject({ semanticSlot: "amount", required: true });
    const price = byName("parts_price");
    expect(price.template).toBe("price_update");
    expect(price.requiredRole).toBe("owner");
    expect(param(byName("sales_index"), "status")).toMatchObject({
      location: "query",
      enumValues: ["posted", "void"],
    });
  });

  it("uses the LLM's description when there is one", () => {
    const described = importScannerSummary(
      summary,
      new Map([["POST /sales", "Records a sale with its lines and payment"]]),
    );
    expect(described.capabilities.find((item) => item.name === "sales_store")!.description).toBe(
      "Records a sale with its lines and payment. StoreSaleRequest: customer_id?, items[{part_id, quantity, unit_price?}], payment_method=cash|bkash|due, sold_on?, note?, tags[]?, buyer_phone?",
    );
  });

  it("keeps a route's hash while its rules stay, and changes it when they change", () => {
    const again = importScannerSummary(structuredClone(summary));
    expect(again.capabilities.map((item) => item.schemaHash)).toEqual(
      imported.capabilities.map((item) => item.schemaHash),
    );
    const changed: ScannerSummary = structuredClone(summary);
    const quantity = changed.routes
      .find((route) => route.method === "POST" && route.path === "/sales")!
      .params.find((item) => item.name === "items[].quantity")!;
    quantity.max = 50;
    quantity.rules = "required|integer|min:1|max:50";
    const after = importScannerSummary(changed);
    const hash = (doc: typeof imported, name: string) =>
      doc.capabilities.find((item) => item.name === name)!.schemaHash;
    expect(hash(after, "sales_store")).not.toBe(hash(imported, "sales_store"));
    expect(hash(after, "stock_in")).toBe(hash(imported, "stock_in"));
  });

  it("writes a valid OpenAPI 3.0 document that the importer reads like any other", () => {
    const document = scannerDocument(summary);
    expect(document.openapi).toBe("3.0.3");
    expect(importOpenApi(document).capabilities).toHaveLength(summary.routes.length);
  });
});
