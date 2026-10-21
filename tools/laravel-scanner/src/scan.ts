import type { ScannedParam, ScannedRoute, ScannerSummary } from "@dokaanbondhu/contracts";
import { SKIPPED, type SourceReader } from "./files";
import { classOf, formRequestRules, inlineRules, type ClassInfo, type MethodInfo } from "./php";
import type { RouteEntry } from "./routes";
import { paramOf, pathOf, type RuleToken } from "./rules";

// Routes to the summary (spec 16.2, steps 3 to 6): each route's controller method, its FormRequest's rules or its
// inline validation, route model binding, and the auth its middleware names.

export const SCANNER_VERSION = "0.1.0";

const MAX_SKIPPED_ROUTES = 40;
const SCALARS = new Set([
  "int",
  "integer",
  "string",
  "float",
  "bool",
  "array",
  "mixed",
  "object",
  "callable",
  "iterable",
]);
const MODEL_PARENTS = /(^|\\)(Model|Authenticatable|Pivot|User)$/;
const UNCOUNTABLE = new Set([
  "data",
  "equipment",
  "information",
  "money",
  "news",
  "series",
  "species",
  "staff",
]);
const IRREGULAR: Record<string, string> = { person: "people", man: "men", woman: "women", child: "children" };

/** English plural as Laravel's Str::plural gives it for the common cases. */
function plural(word: string): string {
  const lower = word.toLowerCase();
  if (UNCOUNTABLE.has(lower)) return word;
  const irregular = IRREGULAR[lower];
  const out = irregular
    ? irregular
    : /[^aeiou]y$/.test(lower)
      ? `${lower.slice(0, -1)}ies`
      : /(s|x|z|ch|sh)$/.test(lower)
        ? `${lower}es`
        : /([^f])fe$|([lr])f$/.test(lower)
          ? lower.replace(/fe?$/, "ves")
          : `${lower}s`;
  return word[0] === word[0]!.toUpperCase() ? out[0]!.toUpperCase() + out.slice(1) : out;
}

/** A model's default table: Str::snake(Str::pluralStudly(name)) — SaleItem → sale_items, Category → categories. */
export function defaultTable(model: string): string {
  const words = model.split(/(?=[A-Z])/);
  words.push(plural(words.pop() ?? model));
  return words
    .join("")
    .replace(/(.)(?=[A-Z])/g, "$1_")
    .toLowerCase();
}

/** HEAD and OPTIONS dropped; PUT with PATCH is one route, kept as PATCH. */
export function methodsOf(listed: string): ScannedRoute["method"][] {
  const methods = listed
    .toUpperCase()
    .split("|")
    .filter((method) =>
      ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method),
    ) as ScannedRoute["method"][];
  return methods.includes("PATCH") ? methods.filter((method) => method !== "PUT") : methods;
}

/** The auth adapter a route's middleware names (spec 16.2, step 5). */
export function authOf(middleware: string[]): ScannedRoute["auth"] {
  if (middleware.some((name) => /^(auth|.*\\Authenticate):(.+,)?(sanctum|api)(,|$)/.test(name)))
    return "bearer";
  if (
    middleware.some(
      (name) => name === "web" || /\\(StartSession|VerifyCsrfToken|ValidateCsrfToken)$/.test(name),
    )
  )
    return "session";
  return "none";
}

class Classes {
  private readonly cache = new Map<string, ClassInfo | null>();

  constructor(
    private readonly reader: SourceReader,
    private readonly psr4: [string, string][],
  ) {}

  /** Whether the class is the app's own (its namespace is in composer.json's PSR-4 map). */
  inApp(full: string): boolean {
    return this.psr4.some(([prefix]) => full.startsWith(prefix));
  }

  /** A class's file through the PSR-4 map; null for a class outside the app (a package's, or PHP's own). */
  load(full: string): ClassInfo | null {
    if (this.cache.has(full)) return this.cache.get(full)!;
    let info: ClassInfo | null = null;
    for (const [prefix, dir] of this.psr4) {
      if (!full.startsWith(prefix)) continue;
      const path = `${dir}${full.slice(prefix.length).replace(/\\/g, "/")}.php`;
      if (!this.reader.exists(path)) continue;
      info = classOf(this.reader.text(path)!, path);
      break;
    }
    this.cache.set(full, info);
    return info;
  }

  /** The class and its parents inside the app, nearest first (at most four). */
  lineage(full: string): { name: string; info: ClassInfo | null }[] {
    const chain: { name: string; info: ClassInfo | null }[] = [];
    let name: string | null = full;
    while (name && chain.length < 4) {
      const info = this.load(name);
      chain.push({ name, info });
      name = info?.parent ?? null;
    }
    return chain;
  }

  isModel(full: string): boolean {
    return (
      full.startsWith("App\\Models\\") ||
      this.lineage(full).some(({ name }, index) => index > 0 && MODEL_PARENTS.test(name))
    );
  }

  /** A model's table: its $table, else Laravel's plural snake_case of its name. */
  tableOf(full: string): string {
    for (const { info } of this.lineage(full)) {
      const table = info?.properties.get("table");
      if (table) return table;
    }
    return defaultTable(full.split("\\").at(-1)!);
  }

  keyType(full: string): "integer" | "string" {
    return this.lineage(full).some(({ info }) => info?.properties.get("keyType") === "string")
      ? "string"
      : "integer";
  }

  /** The FormRequest a method takes: its first typed parameter whose class (or a parent) has rules(). */
  formRequest(method: MethodInfo): { label: string; rules: [string, RuleToken[]][]; info: ClassInfo } | null {
    for (const param of method.params) {
      if (!param.type || SCALARS.has(param.type.toLowerCase())) continue;
      for (const { info } of this.lineage(param.type)) {
        const rules = info ? formRequestRules(info) : null;
        if (info && rules) return { label: param.type.split("\\").at(-1)!, rules, info };
      }
    }
    return null;
  }
}

/** The text of a route's rules the owner reads: StoreSaleRequest: customer_id?, items[{part_id, quantity}], ... */
export function validationText(label: string, params: ScannedParam[]): string {
  type Field = {
    param: ScannedParam | null;
    item: ScannedParam | null;
    list: boolean;
    children: Map<string, Field>;
  };
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
      // codes.* holds the rules of each element; codes, the list's own.
      if (index === segments.length - 1) {
        if (segment.endsWith("[]")) child.item = param;
        else child.param = param;
      }
      node = child;
    });
  }
  const render = (name: string, field: Field): string => {
    const mark = field.param && !field.param.required ? "?" : "";
    const values = (field.item ?? field.param)?.enum?.length
      ? `=${(field.item ?? field.param)!.enum!.join("|")}`
      : "";
    if (!field.children.size) return `${name}${field.list ? "[]" : ""}${mark}${values}`;
    const inner = [...field.children].map(([key, value]) => render(key, value)).join(", ");
    return field.list ? `${name}${mark}[{${inner}}]` : `${name}${mark}{${inner}}`;
  };
  return `${label}: ${[...root.children].map(([name, field]) => render(name, field)).join(", ")}`.slice(
    0,
    4000,
  );
}

/** The path's parameters, read through route model binding. */
function pathParams(uri: string, method: MethodInfo, classes: Classes): ScannedParam[] {
  return [...uri.matchAll(/\{(\w+)(\?)?(?::(\w+))?\}/g)].map(([, name, optional, field]) => {
    const param = paramOf(name!, "path", []);
    param.required = !optional;
    const typed = method.params.find((candidate) => candidate.name === name)?.type ?? null;
    if (typed && !SCALARS.has(typed.toLowerCase()) && classes.isModel(typed)) {
      param.references = { table: classes.tableOf(typed), column: field ?? "id" };
      param.type = field ? null : classes.keyType(typed);
      param.rules = `route model binding: ${typed.split("\\").at(-1)!}`;
    } else if (typed === "int") param.type = "integer";
    else if (typed === "string") param.type = "string";
    return param;
  });
}

/** One route's entries in the summary, or the reason it is skipped. */
function scanRoute(route: RouteEntry, classes: Classes): ScannedRoute[] | string {
  const methods = methodsOf(route.method);
  const path = `/${route.uri.replace(/^\/+/, "")}`;
  const label = `${methods.join("|") || route.method} ${path}`;
  if (!methods.length) return `${label} (no method the scanner reads)`;
  if (!route.action || /^closure$/i.test(route.action)) return `${label} (closure route)`;
  const [className, methodName = "__invoke"] = route.action.replace(/^\\/, "").split("@") as [
    string,
    string?,
  ];
  if (route.vendor || !classes.inApp(className)) return `${label} (a package's route)`;
  const controller = classes.load(className);
  if (!controller) return `${label} (${className.split("\\").at(-1)!}: file not found)`;
  const method = controller.methods.get(methodName);
  if (!method) return `${label} (${methodName} not found in ${controller.name})`;

  const params = pathParams(route.uri, method, classes);
  const form = classes.formRequest(method);
  const inline = form ? null : inlineRules(controller, method);
  const rules = form?.rules ?? inline ?? [];
  const location = methods.every((one) => one === "GET") ? "query" : "body";
  const validated = rules.map(([field, tokens]) => {
    const param = paramOf(pathOf(field), location, tokens);
    // exists:App\Models\Customer or Rule::exists(Customer::class): the model's table.
    if (param.references && param.references.table.includes("\\"))
      param.references.table = classes.tableOf(param.references.table.replace(/^\\/, ""));
    return param;
  });
  const validation = rules.length ? validationText(form?.label ?? "inline validate", validated) : null;
  const handler = `${controller.name}@${methodName}`.slice(0, 300);
  return methods.map((one) => ({
    method: one,
    path: path.replace(/\{(\w+)\?(?::\w+)?\}|\{(\w+):\w+\}/g, "{$1$2}").slice(0, 300),
    name: route.name?.slice(0, 200) ?? null,
    handler,
    auth: authOf(route.middleware),
    validation,
    params: [...params, ...validated].slice(0, 200),
  }));
}

/** The whole summary; `reader` counts the files read. */
export function scan(reader: SourceReader, routes: RouteEntry[], psr4: [string, string][]): ScannerSummary {
  const classes = new Classes(reader, psr4);
  const scanned: ScannedRoute[] = [];
  const skippedRoutes: string[] = [];
  for (const route of routes) {
    const result = scanRoute(route, classes);
    if (typeof result === "string") skippedRoutes.push(result.slice(0, 200));
    else scanned.push(...result);
  }
  const skipped = [...SKIPPED, ...skippedRoutes.slice(0, MAX_SKIPPED_ROUTES)];
  if (skippedRoutes.length > MAX_SKIPPED_ROUTES)
    skipped.push(`and ${skippedRoutes.length - MAX_SKIPPED_ROUTES} more routes`);
  return {
    framework: "laravel",
    scanner_version: SCANNER_VERSION,
    scanned_files: reader.read.size,
    routes: scanned.slice(0, 500),
    skipped,
  };
}
