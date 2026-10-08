import type { ToolDef } from "../providers";
import { leafOf } from "./request";
import type { WriteCapability } from "./types";

// A capability's tool (spec 9.6): built from its parameters' semantic slots, never from a host's names. Every argument
// is a string as the user said it; the resolvers and normalizers turn them into host values (D15).

const PART_QUERY = {
  type: "object",
  properties: {
    part_type: { type: "string", description: "the part as said, e.g. সামনের প্যাড, self, mobil filter" },
    vehicle: { type: "string", description: "the car model as said" },
    year: { type: "string", description: "the model year as said" },
    engine: { type: "string", description: "the engine code as said" },
    position: { type: "string", description: "front, rear, left or right, as said" },
    quality: { type: "string", description: "genuine, non-genuine, reconditioned, as said" },
    brand: { type: "string", description: "the brand as said" },
    part_number: { type: "string", description: "a part number, as said" },
  },
  additionalProperties: false,
} as const;

/** What each template's tool is for, when the host gives no description. */
const PURPOSE: Record<string, string> = {
  sale: "Record a sale of parts, to a customer (on credit or paid) or a walk-in buyer.",
  payment: "Receive money from a customer against their due.",
  stock_in: "Record parts bought from a supplier (stock in).",
  return: "Take back parts a customer returns from an earlier sale.",
  price_update: "Change a part's price.",
  add_fitment: "Record that a part fits a vehicle.",
};

const said = (description: string) => ({ type: "string", description });

export function writeTool(capability: WriteCapability): ToolDef {
  const slots = new Set(capability.params.map((param) => param.semanticSlot));
  const costInLines = capability.params.some(
    (param) => param.semanticSlot === "items" && /cost/.test(leafOf(param.path)),
  );
  const properties: Record<string, unknown> = {};
  if (slots.has("customer")) properties.customer = said("the customer as said, if one is named");
  if (slots.has("supplier")) properties.supplier = said("the supplier as said");
  if (slots.has("items")) {
    properties.items = {
      type: "array",
      description: "the parts, one entry per part as said",
      items: {
        type: "object",
        properties: {
          part: PART_QUERY,
          quantity: said("how many, as said, e.g. দুই সেট, 4 ta"),
          ...(costInLines ? { unit_cost: said("the buying price of one, as said") } : {}),
        },
        required: ["part"],
        additionalProperties: false,
      },
    };
  }
  if (slots.has("part")) properties.part = PART_QUERY;
  if (slots.has("payment")) {
    properties.payment = {
      type: "object",
      properties: {
        method_word: said("how it is paid, as said: বাকিতে, নগদে, বিকাশে, bakite, nogode"),
        amount: said("the amount paid, as said, if one is named"),
        trx_id: said("the transaction ID, as said"),
      },
      additionalProperties: false,
    };
  }
  if (slots.has("amount")) properties.amount = said("the amount of money, as said, e.g. ১০ হাজার, 10 hajar");
  if (slots.has("note")) properties.note = said("a note, as said");
  if (slots.has("reason")) properties.reason = said("the reason, as said");
  for (const param of capability.params) {
    if (param.required && !param.semanticSlot && param.location === "body")
      properties[`extra_${leafOf(param.path)}`] = said(`${leafOf(param.path).replaceAll("_", " ")}, as said`);
  }
  const description = [PURPOSE[capability.template] ?? null, capability.description]
    .filter(Boolean)
    .join(" ");
  return {
    type: "function",
    function: {
      name: capability.name,
      description: `${description} Pass what the user said; the system asks for anything missing and confirms.`,
      parameters: { type: "object", properties, additionalProperties: false },
    },
  };
}
