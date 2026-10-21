import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { scannerSummarySchema } from "@dokaanbondhu/contracts";
import { afterAll, describe, expect, it, vi } from "vitest";
import { detect } from "../src/detect";
import { SourceReader } from "../src/files";
import { classOf, formRequestRules, inlineRules } from "../src/php";
import { parseRouteList } from "../src/routes";
import { paramOf, pathOf } from "../src/rules";
import { run, type RunIo } from "../src/run";
import { authOf, defaultTable, methodsOf, scan } from "../src/scan";
import { summaryText } from "../src/summary";
import { uploadUrl } from "../src/upload";

// The scanner against committed fixtures (spec 16.4): a saved route:list --json, controllers, FormRequests and models
// in fixtures/laravel/, checked against expected-summary.json. No PHP is needed.

const FIXTURE = resolve(import.meta.dirname, "../../../fixtures/laravel");
const ROUTES = join(FIXTURE, "route-list.json");
const expected = scannerSummarySchema.parse(
  JSON.parse(readFileSync(join(FIXTURE, "expected-summary.json"), "utf8")),
);
const temps: string[] = [];
afterAll(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function scanFixture() {
  const reader = new SourceReader(FIXTURE);
  const detection = detect(reader);
  if (detection.kind !== "laravel") throw new Error(detection.message);
  return { reader, summary: scan(reader, parseRouteList(readFileSync(ROUTES, "utf8")), detection.psr4) };
}

/** A project folder with these files, for detection. */
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "laravel-scan-"));
  temps.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

function io(answer: string, fetchImpl?: typeof fetch) {
  const printed: string[] = [];
  const asked: string[] = [];
  const value: RunIo = {
    print: (text) => printed.push(text),
    ask: async (question) => {
      asked.push(question);
      return answer;
    },
    readFile: async (path) => readFileSync(path, "utf8"),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  };
  return { io: value, printed, asked };
}

const php = (body: string) =>
  classOf(
    `<?php\nnamespace App\\Http\\Controllers;\nuse App\\Models\\Customer;\nuse Illuminate\\Validation\\Rule;\nclass X {\n${body}\n}`,
    "x.php",
  )!;

describe("the fixture app", () => {
  it("gives the expected summary", () => {
    expect(scanFixture().summary).toEqual(expected);
  });

  it("never opens .env, vendor/, node_modules/, storage/ or .git/, nor a file outside the folder", () => {
    const { reader } = scanFixture();
    const read = [...reader.read];
    expect(read.length).toBe(expected.scanned_files);
    expect(read.some((path) => /^(\.env|vendor\/|node_modules\/|storage\/|\.git\/)/.test(path))).toBe(false);
    for (const path of [
      ".env",
      ".env.example",
      "vendor/autoload.php",
      "node_modules/x/index.js",
      "storage/logs/laravel.log",
      ".git/config",
      "../outside.php",
    ])
      expect(() => reader.text(path), path).toThrow(/never opens/);
    // The decoy controller under vendor/ is not read: its route is a package's.
    expect(expected.skipped).toContain("GET /sanctum/csrf-cookie (a package's route)");
  });

  it("reads a FormRequest, a parent's rules(), a rules variable and inline validation", () => {
    const byPath = new Map(expected.routes.map((route) => [`${route.method} ${route.path}`, route]));
    expect(byPath.get("POST /sales")!.validation).toBe(
      "StoreSaleRequest: customer_id?, items[{part_id, quantity, unit_price?}], payment_method=cash|bkash|due, sold_on?, note?, tags[]?, buyer_phone?",
    );
    expect(byPath.get("POST /returns")!.validation).toMatch(/^StoreReturnRequest: sale_id, sale_item_id/);
    expect(byPath.get("PATCH /parts/{part}/price")!.validation).toBe(
      "UpdatePriceRequest: retail_price?, garage_price?",
    );
    expect(byPath.get("POST /sales/{sale}/void")!.validation).toBe("inline validate: reason");
    expect(byPath.get("POST /api/payments")!.validation).toBe(
      "inline validate: customer_id, amount, method=cash|bkash|nagad, trx_id?",
    );
    // A GET route's rules are query parameters; the others', the body.
    expect(byPath.get("GET /sales")!.params.map((param) => param.location)).toEqual([
      "query",
      "query",
      "query",
    ]);
  });

  it("reads route model binding, a model's $table and the auth of each route", () => {
    const part = expected.routes.find((route) => route.path === "/parts/{part}")!;
    expect(part.params[0]).toMatchObject({
      name: "part",
      location: "path",
      type: "integer",
      references: { table: "spare_parts", column: "id" },
    });
    const sale = expected.routes.find((route) => route.path === "/sales/{sale}")!;
    expect(sale.params[0]!.references).toEqual({ table: "sales", column: "id" });
    // An int parameter is no model.
    const payment = expected.routes.find((route) => route.path === "/api/payments/{payment}")!;
    expect(payment.params[0]).toMatchObject({ type: "integer", references: null });
    const auth = Object.fromEntries(
      expected.routes.map((route) => [`${route.method} ${route.path}`, route.auth]),
    );
    expect(auth["POST /sales"]).toBe("session");
    expect(auth["POST /api/payments"]).toBe("bearer");
    expect(auth["GET /api/payments/{payment}"]).toBe("bearer");
    expect(auth["POST /api/stock-in"]).toBe("none");
  });

  it("skips closures, packages' routes and missing controllers, and keeps PATCH for PUT|PATCH", () => {
    expect(expected.skipped).toEqual([
      ".env",
      "vendor/",
      "node_modules/",
      "storage/",
      ".git/",
      "GET /up (closure route)",
      "GET /sanctum/csrf-cookie (a package's route)",
      "POST /sales/{sale}/print (print not found in SaleController)",
      "GET /reports/{name?} (ReportController: file not found)",
    ]);
    expect(
      expected.routes.filter((route) => route.path === "/parts/{part}/price").map((route) => route.method),
    ).toEqual(["PATCH"]);
    expect(expected.routes.find((route) => route.path === "/api/stock-in")!.handler).toBe(
      "StockInController@__invoke",
    );
  });

  it("prints what the owner reads", () => {
    const text = summaryText(expected);
    expect(text).toContain("Never opened: .env, vendor/, node_modules/, storage/, .git/");
    expect(text).toContain("POST   /sales   [session sign-in]   SaleController@store");
    expect(text).toContain("path: part → spare_parts");
    expect(text).toContain("Routes not read:\n  GET /up (closure route)");
    expect(text).toContain("Only this summary is uploaded");
  });
});

describe("the rules table (spec 16.2)", () => {
  const one = (rules: string, name = "field") => paramOf(name, "body", [{ kind: "text", value: rules }]);

  it("required, nullable, sometimes", () => {
    expect(one("required")).toMatchObject({ required: true, nullable: false });
    expect(one("nullable")).toMatchObject({ required: false, nullable: true });
    expect(one("sometimes|required")).toMatchObject({ required: false });
    expect(one("required|sometimes")).toMatchObject({ required: false });
  });

  it("types", () => {
    for (const [rule, type] of [
      ["integer", "integer"],
      ["int", "integer"],
      ["numeric", "number"],
      ["decimal:0,2", "number"],
      ["string", "string"],
      ["boolean", "boolean"],
      ["bool", "boolean"],
      ["array", "array"],
    ] as const)
      expect(one(rule).type, rule).toBe(type);
  });

  it("in: is an enumeration; min, max and between a range", () => {
    expect(one("in:cash,bkash,due").enum).toEqual(["cash", "bkash", "due"]);
    expect(one("integer|min:1|max:999")).toMatchObject({ min: 1, max: 999 });
    expect(one("between:2,8")).toMatchObject({ min: 2, max: 8 });
    expect(one("min:abc").min).toBeNull();
  });

  it("exists: names the table, its column the leaf's name when left out", () => {
    expect(one("exists:customers,id", "customer_id").references).toEqual({
      table: "customers",
      column: "id",
    });
    expect(one("exists:parts", "items[].part_id").references).toEqual({ table: "parts", column: "part_id" });
  });

  it("date and email are formats; anything else is kept as text", () => {
    expect(one("date").format).toBe("date");
    expect(one("date_format:Y-m-d").format).toBe("date");
    expect(one("email:rfc").format).toBe("email");
    expect(one("required|regex:/^01[3-9]\\d{8}$/|uuid").rules).toBe("required|regex:/^01[3-9]\\d{8}$/|uuid");
    expect(paramOf("phone", "body", [{ kind: "other", text: "new BangladeshPhone()" }]).rules).toBe(
      "new BangladeshPhone()",
    );
  });

  it("a dotted name is a nested list", () => {
    expect(pathOf("items.*.part_id")).toBe("items[].part_id");
    expect(pathOf("tags.*")).toBe("tags[]");
    expect(pathOf("customer.name")).toBe("customer.name");
    expect(pathOf("rows.*.codes.*")).toBe("rows[].codes[]");
  });
});

describe("reading PHP", () => {
  it("finds $request->validate, $this->validate, request()->validate and Validator::make", () => {
    for (const call of [
      "$request->validate(['amount' => 'required|integer']);",
      "$this->validate($request, ['amount' => 'required|integer']);",
      "request()->validate(['amount' => 'required|integer']);",
      "$v = \\Illuminate\\Support\\Facades\\Validator::make($request->all(), ['amount' => 'required|integer']);",
      "$rules = ['amount' => 'required|integer']; $request->validate($rules);",
    ]) {
      const info = php(`public function store(Request $request) { ${call} }`);
      expect(inlineRules(info, info.methods.get("store")!), call).toEqual([
        ["amount", [{ kind: "text", value: "required|integer" }]],
      ]);
    }
  });

  it("reads Rule::in, Rule::exists with a model class, and keeps other rule objects as text", () => {
    const info = php(`public function rules(): array { return [
      'method' => ['required', Rule::in(['cash', 'bkash'])],
      'customer_id' => [Rule::exists(Customer::class, 'id')],
      'code' => [Rule::unique('parts')->ignore($this->part)],
    ]; }`);
    expect(formRequestRules(info)).toEqual([
      [
        "method",
        [
          { kind: "text", value: "required" },
          { kind: "in", values: ["cash", "bkash"] },
        ],
      ],
      ["customer_id", [{ kind: "exists", table: "\\App\\Models\\Customer", column: "id" }]],
      ["code", [{ kind: "other", text: "Rule::unique('parts')->ignore($this->part)" }]],
    ]);
  });

  it("resolves a parameter's class through the use imports and the namespace", () => {
    const info = classOf(
      "<?php namespace App\\Http\\Controllers; use App\\Http\\Requests\\{StoreSaleRequest as Store}; class C { public function a(Store $r, Sale $s, \\App\\Models\\Part $p, int $n, int|string $u) {} }",
      "c.php",
    )!;
    expect(info.methods.get("a")!.params.map((param) => param.type)).toEqual([
      "App\\Http\\Requests\\StoreSaleRequest",
      "App\\Http\\Controllers\\Sale",
      "App\\Models\\Part",
      "int",
      null,
    ]);
  });
});

describe("routes, middleware and names", () => {
  it("passes over PHP notices before the list, and reads Laravel's no-routes message as none", () => {
    expect(
      parseRouteList(
        'PHP Deprecated:  x in y on line 3\n[{"method":"GET|HEAD","uri":"a","name":null,"action":"Closure","middleware":"web\\nauth"}]',
      ),
    ).toEqual([
      {
        method: "GET|HEAD",
        uri: "a",
        name: null,
        action: "Closure",
        middleware: ["web", "auth"],
        vendor: false,
      },
    ]);
    expect(
      parseRouteList("ERROR  Your application doesn't have any routes matching the given criteria."),
    ).toEqual([]);
  });

  it("names the auth from short or resolved middleware", () => {
    expect(authOf(["api", "auth:sanctum"])).toBe("bearer");
    expect(authOf(["Illuminate\\Auth\\Middleware\\Authenticate:api"])).toBe("bearer");
    expect(authOf(["web", "auth"])).toBe("session");
    expect(authOf(["Illuminate\\Session\\Middleware\\StartSession"])).toBe("session");
    expect(authOf(["App\\Http\\Middleware\\VerifyCsrfToken"])).toBe("session");
    expect(authOf(["api", "throttle:60,1"])).toBe("none");
  });

  it("keeps the methods it reads", () => {
    expect(methodsOf("GET|HEAD")).toEqual(["GET"]);
    expect(methodsOf("PUT|PATCH")).toEqual(["PATCH"]);
    expect(methodsOf("OPTIONS")).toEqual([]);
  });

  it("gives a model's default table as Laravel does", () => {
    expect(
      [
        "Sale",
        "SaleItem",
        "Category",
        "Box",
        "Batch",
        "Person",
        "Shelf",
        "Party",
        "Equipment",
        "StockMovement",
      ].map(defaultTable),
    ).toEqual([
      "sales",
      "sale_items",
      "categories",
      "boxes",
      "batches",
      "people",
      "shelves",
      "parties",
      "equipment",
      "stock_movements",
    ]);
  });
});

describe("detection", () => {
  it("stops when it is no Laravel app", () => {
    expect(detect(new SourceReader(project({ "composer.json": "{}" }))).kind).toBe("not-laravel");
    expect(
      detect(
        new SourceReader(project({ artisan: "", "composer.json": '{"require":{"symfony/console":"^7"}}' })),
      ).kind,
    ).toBe("not-laravel");
  });

  it("points to the app's own OpenAPI document when it publishes one", async () => {
    for (const name of ["darkaonline/l5-swagger", "knuckleswtf/scribe"]) {
      const dir = project({
        artisan: "",
        "composer.json": JSON.stringify({
          require: { "laravel/framework": "^12.0" },
          "require-dev": { [name]: "^1" },
        }),
      });
      const { io: io_, printed } = io("y");
      expect((await run({ dir, routes: ROUTES }, io_)).code).toBe(2);
      expect(printed.join("\n")).toMatch(/already publishes an OpenAPI document .*Import that document/s);
    }
  });
});

describe("consent and upload (spec 16.3)", () => {
  const summaryFetch = () =>
    vi.fn<typeof fetch>(async () =>
      Response.json({ connection_id: "c1", added: ["sales_store"], changed: [], kept: [], removed: [] }),
    );

  it("asks nothing without a server, and uploads nothing", async () => {
    const { io: io_, asked } = io("y");
    const result = await run({ dir: FIXTURE, routes: ROUTES }, io_);
    expect(result.code).toBe(0);
    expect(asked).toEqual([]);
  });

  it("uploads only after a yes", async () => {
    for (const answer of ["", "n", "no", "maybe"]) {
      const fetchImpl = summaryFetch();
      const { io: io_, asked, printed } = io(answer, fetchImpl);
      await run({ dir: FIXTURE, routes: ROUTES, server: "https://dokaan.example", token: "t0k" }, io_);
      expect(asked).toEqual(["\nUpload this summary? [y/N] "]);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(printed.at(-1)).toBe("Not uploaded.");
    }
    for (const answer of ["y", "Y", "yes"]) {
      const fetchImpl = summaryFetch();
      const { io: io_, printed } = io(answer, fetchImpl);
      await run({ dir: FIXTURE, routes: ROUTES, server: "https://dokaan.example/", token: "t0k" }, io_);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0]!;
      expect(url).toBe("https://dokaan.example/api/v1/setup/scanner-upload");
      expect((init!.headers as Record<string, string>)["x-setup-token"]).toBe("t0k");
      // Only the summary goes: nothing else from the folder.
      expect(JSON.parse(String(init!.body))).toEqual(expected);
      expect(printed.at(-1)).toMatch(/^Uploaded: 1 new/);
    }
  });

  it("needs both --server and --token, and https except on this computer", async () => {
    expect(
      (await run({ dir: FIXTURE, routes: ROUTES, server: "https://dokaan.example" }, io("y").io)).code,
    ).toBe(1);
    expect(() => uploadUrl("http://dokaan.example")).toThrow(/https/);
    expect(uploadUrl("http://localhost:3000")).toBe("http://localhost:3000/api/v1/setup/scanner-upload");
    expect(uploadUrl("http://host.docker.internal:3000/api/v1")).toBe(
      "http://host.docker.internal:3000/api/v1/setup/scanner-upload",
    );
  });

  it("says why the server refused", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json(
        { error: { code: "SETUP_TOKEN_USED", message_en: "This setup token was used already." } },
        { status: 401 },
      ),
    );
    await expect(
      run(
        { dir: FIXTURE, routes: ROUTES, server: "https://dokaan.example", token: "t" },
        io("y", fetchImpl).io,
      ),
    ).rejects.toThrow("the upload was refused (SETUP_TOKEN_USED: This setup token was used already.)");
  });
});

describe("the bundled file (spec 16.1)", () => {
  it("is one file that scans the fixture the same way", async () => {
    const cwd = resolve(import.meta.dirname, "..");
    await promisify(execFile)(process.execPath, ["scripts/bundle.mjs"], { cwd });
    const out = join(mkdtempSync(join(tmpdir(), "laravel-scan-")), "summary.json");
    temps.push(resolve(out, ".."));
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["dist/dokaanbondhu-laravel-scan.mjs", "--dir", FIXTURE, "--routes", ROUTES, "--out", out],
      { cwd },
    );
    expect(stdout).toContain("Routes found (10):");
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(expected);
  }, 60_000);
});
