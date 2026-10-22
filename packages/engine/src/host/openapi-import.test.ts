import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { importOpenApi, OpenApiImportError, snakeCase, type ImportedCapability } from "./openapi-import";

// The OpenAPI importer (spec 11.8, 11.13) on the test host's document (tools/fixtures/openapi, refreshed from the live
// document in CI) and on a small OpenAPI 3.0 document shaped unlike it: every proposal comes from names, formats and
// enumerations, never from a host's name (D122).

const fixture = JSON.parse(
  readFileSync(new URL("../../../../tools/fixtures/openapi/geargrid-openapi.json", import.meta.url), "utf8"),
) as unknown;

const byName = (capabilities: ImportedCapability[], name: string) =>
  capabilities.find((item) => item.name === name)!;
const slots = (capability: ImportedCapability) =>
  Object.fromEntries(capability.params.map((param) => [param.path, param.semanticSlot]));

describe("OpenAPI importer", () => {
  const imported = importOpenApi(fixture);

  it("makes every operation a capability, named by its operationId in snake_case, reads and writes apart", () => {
    expect(snakeCase("recordSale")).toBe("record_sale");
    expect(snakeCase("getHealth")).toBe("get_health");
    expect(imported.capabilities).toHaveLength(24);
    const writes = imported.capabilities.filter((item) => item.kind === "write").map((item) => item.name);
    expect(writes.sort()).toEqual(
      [
        "record_sale",
        "void_sale",
        "receive_payment",
        "reverse_payment",
        "stock_in",
        "reverse_purchase",
        "record_return",
        "update_price",
        "update_rack",
        "add_fitment",
        "update_fitment",
        "add_customer",
        "update_customer",
        "add_supplier",
        "update_supplier",
      ].sort(),
    );
  });

  it("proposes the feature list from the root hint", () => {
    expect(imported.features).toEqual({
      openapi: "/api/openapi.json",
      dry_run: "?dry_run=true",
      idempotency_header: "Idempotency-Key",
      bangla_errors: "error.message_bn",
      acting_user_header: "X-Acting-User",
    });
  });

  it("reads a sale's leaves with their entities, slots and the spoken words of its payment methods", () => {
    const sale = byName(imported.capabilities, "record_sale");
    expect(sale).toMatchObject({
      httpMethod: "POST",
      path: "/api/v1/sales",
      supportsDryRun: true,
      template: "sale",
      requiredRole: "staff",
      compensation: { operation: "void_sale", idFrom: "sale.id", body: { reason: "{undo_reason}" } },
      readBack: { operation: "get_sale", idFrom: "sale.id" },
    });
    expect(slots(sale)).toMatchObject({
      customer_id: "customer",
      "items[].part_id": "items",
      "items[].quantity": "items",
      "items[].unit_price_taka": "items",
      "payments[].method": "payment",
      "payments[].amount_taka": "payment",
      "payments[].cheque.bank": "payment",
      note: "note",
      sale_time: null,
    });
    const customer = sale.params.find((param) => param.path === "customer_id")!;
    expect(customer).toMatchObject({
      entityConcept: "Customer",
      required: false,
      type: "string:uuid",
      location: "body",
    });
    expect(sale.params.find((param) => param.path === "items[].part_id")).toMatchObject({
      entityConcept: "Part",
      required: true,
      safetyCritical: true,
    });
    const method = sale.params.find((param) => param.path === "payments[].method")!;
    expect(method.enumValues).toEqual(["cash", "bkash", "nagad", "rocket", "bank", "cheque"]);
    expect(method.spokenMap).toMatchObject({ নগদে: "cash", nogode: "cash", বিকাশ: "bkash", bkash: "bkash" });
    // the dry-run switch and the headers are features, not parameters
    expect(sale.params.map((param) => param.path)).not.toContain("dry_run");
  });

  it("proposes the template and the slots of a payment, a stock-in, a return, a price change and a fitment", () => {
    expect(byName(imported.capabilities, "receive_payment")).toMatchObject({
      template: "payment",
      compensation: { operation: "reverse_payment" },
    });
    expect(slots(byName(imported.capabilities, "receive_payment"))).toMatchObject({
      customer_id: "customer",
      amount_taka: "amount",
      method: "payment",
    });
    expect(byName(imported.capabilities, "stock_in")).toMatchObject({
      template: "stock_in",
      compensation: { operation: "reverse_purchase" },
    });
    expect(slots(byName(imported.capabilities, "stock_in"))).toMatchObject({
      supplier_id: "supplier",
      "items[].unit_cost_taka": "items",
    });
    const returned = byName(imported.capabilities, "record_return");
    expect(returned).toMatchObject({ template: "return", compensation: null });
    expect(slots(returned)).toMatchObject({
      sale_id: "sale_ref",
      "items[].sale_item_id": "sale_ref",
      "items[].quantity": "items",
      refund_due_taka: "refund",
    });
    const price = byName(imported.capabilities, "update_price");
    expect(price).toMatchObject({
      httpMethod: "PATCH",
      template: "price_update",
      requiredRole: "owner",
      compensation: {
        operation: "update_price",
        body: { retail_price_taka: "{previous.retail_price_taka}" },
      },
    });
    expect(price.params.find((param) => param.path === "id")).toMatchObject({
      location: "path",
      semanticSlot: null,
    });
    // A rack change (D195): the part in the path, the rack in the body; staff may, and its undo puts the old rack back.
    const rack = byName(imported.capabilities, "update_rack");
    expect(rack).toMatchObject({
      httpMethod: "PATCH",
      template: "rack_update",
      requiredRole: "staff",
      compensation: { operation: "update_rack", body: { rack_location: "{previous.rack_location}" } },
    });
    expect(slots(rack)).toMatchObject({ rack_location: "rack" });
    expect(byName(imported.capabilities, "add_fitment")).toMatchObject({
      template: "add_fitment",
      compensation: { operation: "update_fitment", body: { deleted: true } },
    });
  });

  it("proposes a new customer's and supplier's slots and kinds, and not for their edit (D173)", () => {
    const customer = byName(imported.capabilities, "add_customer");
    expect(customer).toMatchObject({
      template: "add_customer",
      requiredRole: "staff",
      supportsDryRun: true,
      compensation: { operation: "update_customer", body: { deleted: true } },
      readBack: { operation: "get_customer", idFrom: "customer.id" },
    });
    expect(slots(customer)).toEqual({
      name: "name",
      type: "party_type",
      phone: "phone",
      address: "address",
      credit_limit_taka: null,
    });
    expect(customer.params.find((param) => param.path === "type")?.enumValues).toEqual(["retail", "garage"]);
    const supplier = byName(imported.capabilities, "add_supplier");
    expect(supplier).toMatchObject({
      template: "add_supplier",
      compensation: { operation: "update_supplier" },
    });
    expect(slots(supplier)).toEqual({ name: "name", phone: "phone", address: "address" });
    expect(byName(imported.capabilities, "update_customer").template).toBe("generic");
  });

  it("finds a new customer and supplier in another app's words: clients, vendors, its own kinds (D173)", () => {
    const body = (properties: Record<string, unknown>) => ({
      required: true,
      content: { "application/json": { schema: { type: "object", required: ["fullName"], properties } } },
    });
    const ok = {
      "201": { description: "ok", content: { "application/json": { schema: { type: "object" } } } },
    };
    const other = {
      openapi: "3.0.3",
      paths: {
        "/clients": {
          post: {
            operationId: "createClient",
            requestBody: body({
              fullName: { type: "string" },
              mobileNo: { type: "string" },
              category: { type: "string", enum: ["Walk-in", "Mechanic"] },
            }),
            responses: ok,
          },
        },
        "/clients/{clientId}": {
          patch: {
            operationId: "editClient",
            parameters: [{ name: "clientId", in: "path", required: true, schema: { type: "integer" } }],
            requestBody: body({ fullName: { type: "string" } }),
            responses: ok,
          },
        },
        "/vendors": {
          post: {
            operationId: "newVendor",
            requestBody: body({
              fullName: { type: "string" },
              contactNumber: { type: "string" },
              kind: { type: "string" },
            }),
            responses: ok,
          },
        },
      },
    };
    const { capabilities } = importOpenApi(other);
    expect(byName(capabilities, "create_client")).toMatchObject({ template: "add_customer" });
    expect(slots(byName(capabilities, "create_client"))).toEqual({
      fullName: "name",
      mobileNo: "phone",
      category: "party_type",
    });
    expect(byName(capabilities, "edit_client").template).toBe("generic");
    expect(byName(capabilities, "new_vendor")).toMatchObject({ template: "add_supplier" });
    // A kind without values to choose from is no slot.
    expect(slots(byName(capabilities, "new_vendor"))).toEqual({
      fullName: "name",
      contactNumber: "phone",
      kind: null,
    });
  });

  it("hashes method, path and request schema, so a changed request changes the hash", () => {
    const sale = byName(imported.capabilities, "record_sale");
    expect(sale.schemaHash).toMatch(/^[0-9a-f]{64}$/);
    expect(byName(importOpenApi(fixture).capabilities, "record_sale").schemaHash).toBe(sale.schemaHash);
    const changed = structuredClone(fixture) as {
      components: { schemas: { SaleInput: { properties: Record<string, unknown> } } };
    };
    changed.components.schemas.SaleInput.properties.extra = { type: "string" };
    expect(byName(importOpenApi(changed).capabilities, "record_sale").schemaHash).not.toBe(sale.schemaHash);
  });

  it("reads an OpenAPI 3.0 document of another shape: nullable fields, a shared parameter, other names", () => {
    const other = {
      openapi: "3.0.3",
      paths: {
        "/orders": {
          post: {
            operationId: "createOrder",
            requestBody: {
              required: true,
              content: { "application/json": { schema: { $ref: "#/components/schemas/Order" } } },
            },
            responses: {
              "201": { description: "ok", content: { "application/json": { schema: { type: "object" } } } },
            },
            "x-supports-dry-run": true,
          },
        },
      },
      components: {
        schemas: {
          Order: {
            type: "object",
            required: ["customerId", "lines"],
            properties: {
              customerId: { type: "string", format: "uuid" },
              lines: {
                type: "array",
                items: {
                  type: "object",
                  required: ["partId", "qty"],
                  properties: { partId: { type: "integer" }, qty: { type: "number" } },
                },
              },
              paymentMethod: { type: "string", nullable: true, enum: ["cash", "bkash", null] },
            },
          },
        },
      },
    };
    const { capabilities, features } = importOpenApi(other);
    expect(features).toEqual({ openapi: "/api/openapi.json", dry_run: "?dry_run=true" });
    expect(capabilities[0]).toMatchObject({ name: "create_order", template: "sale" });
    expect(slots(capabilities[0]!)).toEqual({
      customerId: "customer",
      "lines[].partId": "items",
      "lines[].qty": "items",
      paymentMethod: "payment",
    });
    expect(capabilities[0]!.params.find((param) => param.path === "paymentMethod")).toMatchObject({
      enumValues: ["cash", "bkash"],
      spokenMap: { বিকাশ: "bkash", ক্যাশ: "cash" },
    });
  });

  it("refuses what is not an OpenAPI 3.0 or 3.1 document", () => {
    expect(() => importOpenApi({ swagger: "2.0" })).toThrow(OpenApiImportError);
    expect(() => importOpenApi("text")).toThrow(OpenApiImportError);
  });
});
