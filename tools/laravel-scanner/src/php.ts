import { Engine } from "php-parser";
import type { RuleToken } from "./rules";

// Reading PHP source with php-parser (spec 16.2): a class's namespace, its use imports, its parent, its methods and
// their typed parameters, a FormRequest's rules() array, an inline validate call, and a model's $table.

type Node = { kind: string } & Record<string, unknown>;

const engine = new Engine({
  parser: { php8: true, suppressErrors: true, extractDoc: false },
  ast: { withPositions: false },
});

export interface MethodInfo {
  name: string;
  /** Each parameter's name and its type hint as written (StoreSaleRequest, Sale, int); null when untyped or a union. */
  params: { name: string; type: string | null }[];
  body: Node | null;
}

export interface ClassInfo {
  namespace: string;
  /** Imported classes by their short name: StoreSaleRequest → App\Http\Requests\StoreSaleRequest. */
  uses: Map<string, string>;
  name: string;
  /** The class it extends, in full. */
  parent: string | null;
  methods: Map<string, MethodInfo>;
  /** A string property's value: $table = 'sales'. */
  properties: Map<string, string>;
}

const nameOf = (node: unknown): string | null => {
  if (!node || typeof node !== "object") return null;
  const value = (node as Node).name;
  if (typeof value === "string") return value;
  return nameOf(value);
};

/** A class name as written, in full: through the use imports, else in the class's own namespace. */
export function fullName(info: Pick<ClassInfo, "namespace" | "uses">, written: string): string {
  if (written.startsWith("\\")) return written.slice(1);
  const [head, ...rest] = written.split("\\");
  const imported = info.uses.get(head!);
  if (imported) return [imported, ...rest].join("\\");
  return info.namespace ? `${info.namespace}\\${written}` : written;
}

/** A class file's first class, or null when the file has none (or does not parse). */
export function classOf(code: string, file: string): ClassInfo | null {
  let program: Node;
  try {
    program = engine.parseCode(code, file) as unknown as Node;
  } catch {
    return null;
  }
  const top = (program.children as Node[]) ?? [];
  const space = top.find((node) => node.kind === "namespace");
  const children = (space ? (space.children as Node[]) : top) ?? [];
  const uses = new Map<string, string>();
  for (const group of children.filter((node) => node.kind === "usegroup")) {
    const prefix = typeof group.name === "string" && group.name ? `${group.name}\\` : "";
    for (const item of (group.items as Node[]) ?? []) {
      const full = `${prefix}${String(item.name)}`.replace(/^\\/, "");
      uses.set(nameOf(item.alias) ?? full.split("\\").at(-1)!, full);
    }
  }
  const cls = children.find((node) => node.kind === "class");
  if (!cls) return null;
  const info: ClassInfo = {
    namespace: space ? String(space.name) : "",
    uses,
    name: nameOf(cls.name) ?? "",
    parent: null,
    methods: new Map(),
    properties: new Map(),
  };
  const parent = nameOf(cls.extends);
  if (parent) info.parent = fullName(info, parent);
  for (const member of (cls.body as Node[]) ?? []) {
    if (member.kind === "method") {
      const name = nameOf(member.name) ?? "";
      info.methods.set(name, {
        name,
        params: ((member.arguments as Node[]) ?? []).map((param) => {
          const type = param.type as Node | null;
          return {
            name: nameOf(param.name) ?? "",
            type: type?.kind === "name" ? fullName(info, String(type.name)) : type ? nameOf(type) : null,
          };
        }),
        body: (member.body as Node | null) ?? null,
      });
    }
    if (member.kind === "propertystatement") {
      for (const property of (member.properties as Node[]) ?? []) {
        const value = property.value as Node | null;
        if (value?.kind === "string") info.properties.set(nameOf(property.name) ?? "", String(value.value));
      }
    }
  }
  return info;
}

/** Every node of a tree, depth first. */
function* walk(node: unknown): Generator<Node> {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) yield* walk(item);
    return;
  }
  const value = node as Node;
  if (typeof value.kind === "string") yield value;
  for (const [key, child] of Object.entries(value)) if (key !== "kind") yield* walk(child);
}

const stringOf = (node: Node | undefined): string | null =>
  node?.kind === "string" || node?.kind === "number" ? String(node.value) : null;

/** An expression as short text, for a rule the table does not read: Rule::unique('parts')->ignore($this->part). */
function textOf(node: Node | undefined): string {
  if (!node) return "…";
  switch (node.kind) {
    case "string":
      return typeof node.raw === "string" ? node.raw : `'${String(node.value)}'`;
    case "number":
      return String(node.value);
    case "variable":
      return `$${String(node.name)}`;
    case "name":
    case "identifier":
      return nameOf(node) ?? "…";
    case "staticlookup":
      return `${textOf(node.what as Node)}::${nameOf(node.offset) ?? "…"}`;
    case "propertylookup":
    case "nullsafepropertylookup":
      return `${textOf(node.what as Node)}->${nameOf(node.offset) ?? "…"}`;
    case "call":
      return `${textOf(node.what as Node)}(${((node.arguments as Node[]) ?? []).map(textOf).join(", ")})`;
    case "new":
      return `new ${textOf(node.what as Node)}(${((node.arguments as Node[]) ?? []).map(textOf).join(", ")})`;
    case "array":
      return "[…]";
    default:
      return "…";
  }
}

/** A class constant's class (Customer::class), in full with a leading backslash; else the string's value. */
function classOrString(info: ClassInfo, node: Node | undefined): string | null {
  if (node?.kind === "staticlookup" && nameOf(node.offset) === "class") {
    const written = nameOf(node.what);
    return written ? `\\${fullName(info, written)}` : null;
  }
  return stringOf(node);
}

/** One rule expression to its tokens: a string, an array of them, Rule::in([...]), Rule::exists('t', 'c'). */
function tokensOf(info: ClassInfo, node: Node): RuleToken[] {
  if (node.kind === "string") return [{ kind: "text", value: String(node.value) }];
  if (node.kind === "array")
    return ((node.items as Node[]) ?? []).flatMap((entry) => tokensOf(info, entry.value as Node));
  if (node.kind === "call" && (node.what as Node)?.kind === "staticlookup") {
    const lookup = node.what as Node;
    const rule = `${nameOf(lookup.what)}::${nameOf(lookup.offset)}`;
    const args = (node.arguments as Node[]) ?? [];
    if (/(^|\\)Rule::in$/.test(rule) && args[0]?.kind === "array")
      return [
        {
          kind: "in",
          values: ((args[0].items as Node[]) ?? [])
            .map((entry) => stringOf(entry.value as Node))
            .filter((value): value is string => value !== null),
        },
      ];
    const table = classOrString(info, args[0]);
    if (/(^|\\)Rule::exists$/.test(rule) && table)
      return [{ kind: "exists", table, column: stringOf(args[1]) }];
  }
  return [{ kind: "other", text: textOf(node).slice(0, 200) }];
}

/** An array literal of rules ('field' => rules) to the fields and their tokens. */
function rulesOfArray(info: ClassInfo, array: Node): [string, RuleToken[]][] {
  return ((array.items as Node[]) ?? []).flatMap((entry) => {
    const key = stringOf(entry.key as Node);
    return key ? [[key, tokensOf(info, entry.value as Node)] as [string, RuleToken[]]] : [];
  });
}

/** The array an expression is: a literal, or a variable assigned one in the same body ($rules = [...]). */
function arrayOf(body: Node, expr: Node | undefined): Node | null {
  if (expr?.kind === "array") return expr;
  if (expr?.kind !== "variable") return null;
  for (const node of walk(body)) {
    if (node.kind !== "assign" || node.operator !== "=") continue;
    const left = node.left as Node;
    if (left.kind === "variable" && left.name === expr.name && (node.right as Node).kind === "array")
      return node.right as Node;
  }
  return null;
}

/** A FormRequest's rules(): the array its first return statement gives; null when the class has no rules(). */
export function formRequestRules(info: ClassInfo): [string, RuleToken[]][] | null {
  const rules = info.methods.get("rules");
  if (!rules?.body) return null;
  for (const node of walk(rules.body)) {
    if (node.kind !== "return") continue;
    const array = arrayOf(rules.body, node.expr as Node);
    if (array) return rulesOfArray(info, array);
  }
  return [];
}

/** An inline validation in a controller method: $request->validate([...]), $this->validate($request, [...]),
 *  request()->validate([...]) or Validator::make($data, [...]). */
export function inlineRules(info: ClassInfo, method: MethodInfo): [string, RuleToken[]][] | null {
  if (!method.body) return null;
  for (const node of walk(method.body)) {
    if (node.kind !== "call") continue;
    const what = node.what as Node;
    const args = (node.arguments as Node[]) ?? [];
    const validate =
      ((what?.kind === "propertylookup" || what?.kind === "nullsafepropertylookup") &&
        nameOf(what.offset) === "validate") ||
      (what?.kind === "staticlookup" &&
        /(^|\\)Validator$/.test(nameOf(what.what) ?? "") &&
        nameOf(what.offset) === "make");
    if (!validate) continue;
    const candidates = what.kind === "staticlookup" ? [args[1]] : args;
    for (const arg of candidates) {
      const array = arrayOf(method.body, arg);
      if (array) return rulesOfArray(info, array);
    }
  }
  return null;
}
