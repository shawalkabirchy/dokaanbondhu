import type { ScannedParam } from "@dokaanbondhu/contracts";

// Laravel validation rules to a parameter's schema (spec 16.2's table). A rule is a string ("required|integer"), an
// array of strings, or a rule object read from the source (Rule::in, Rule::exists); anything the table does not know
// is kept as text for the owner to read.

/** One rule as the source has it: a string, or a rule object already read. */
export type RuleToken =
  | { kind: "text"; value: string }
  | { kind: "in"; values: string[] }
  | { kind: "exists"; table: string; column: string | null }
  | { kind: "other"; text: string };

const TYPES: Record<string, ScannedParam["type"]> = {
  integer: "integer",
  int: "integer",
  numeric: "number",
  decimal: "number",
  string: "string",
  boolean: "boolean",
  bool: "boolean",
  array: "array",
};

/** A field's rules to its schema; `leaf` is the field's last name, for an exists rule without its column. */
export function paramOf(name: string, location: ScannedParam["location"], tokens: RuleToken[]): ScannedParam {
  const param: ScannedParam = {
    name,
    location,
    type: null,
    required: false,
    nullable: false,
    enum: null,
    min: null,
    max: null,
    format: null,
    references: null,
    rules: "",
  };
  const written: string[] = [];
  let sometimes = false;
  const leaf = name.split(".").at(-1)!.replace(/\[\]$/, "");
  for (const token of tokens) {
    if (token.kind === "in") {
      param.enum = token.values;
      written.push(`in:${token.values.join(",")}`);
      continue;
    }
    if (token.kind === "exists") {
      param.references = { table: token.table, column: token.column ?? leaf };
      written.push(`exists:${token.table.replace(/^\\/, "")}${token.column ? `,${token.column}` : ""}`);
      continue;
    }
    if (token.kind === "other") {
      written.push(token.text);
      continue;
    }
    for (const rule of token.value
      .split("|")
      .map((part) => part.trim())
      .filter(Boolean)) {
      written.push(rule);
      const [head, args = ""] = rule.split(/:(.*)/s) as [string, string?];
      const list = args.split(",").map((part) => part.trim());
      if (head === "required") param.required = true;
      else if (head === "nullable") param.nullable = true;
      else if (head === "sometimes") sometimes = true;
      else if (TYPES[head]) param.type = TYPES[head]!;
      else if (head === "in") param.enum = list;
      else if (head === "min") param.min = Number(list[0]);
      else if (head === "max") param.max = Number(list[0]);
      else if (head === "between") [param.min, param.max] = [Number(list[0]), Number(list[1])];
      else if (head === "exists") param.references = { table: list[0]!, column: list[1] || leaf };
      else if (head === "date" || head === "date_format") param.format = "date";
      else if (head === "email") param.format = "email";
    }
  }
  if (param.min !== null && Number.isNaN(param.min)) param.min = null;
  if (param.max !== null && Number.isNaN(param.max)) param.max = null;
  // sometimes: checked only when sent, so never required, wherever it stands (sometimes|required).
  if (sometimes) param.required = false;
  param.rules = written.join("|");
  return param;
}

/** "items.*.part_id" → "items[].part_id", "codes.*" → "codes[]": the dotted name as a JSON path. */
export function pathOf(field: string): string {
  return field.replace(/\.\*(?=\.|$)/g, "[]");
}
