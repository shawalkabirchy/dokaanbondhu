import type { ToolDef } from "../providers";
import { leafOf, writeSlots } from "./request";
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
  add_fitment:
    "Record that a part also fits another car, when the user says so (ei pad ta premio teo lage): part is the part as known, with its own car; vehicle is the other car.",
  add_customer:
    "Add a new customer (a garage or a buyer) to the shop's list, when the user asks to add one (notun customer jog koro).",
  add_supplier:
    "Add a new supplier to the shop's list, when the user asks to add one (notun supplier jog koro).",
};

const said = (description: string) => ({ type: "string", description });

export function writeTool(capability: WriteCapability): ToolDef {
  const slots = writeSlots(capability);
  const costInLines = capability.params.some(
    (param) => param.semanticSlot === "items" && /cost/.test(leafOf(param.path)),
  );
  const properties: Record<string, unknown> = {};
  if (slots.has("customer")) properties.customer = said("the customer as said, if one is named");
  if (slots.has("supplier")) properties.supplier = said("the supplier as said");
  // A return's sale is found from who bought the part and when (D169); the part itself is in items.
  if (slots.has("sale_ref")) {
    properties.customer ??= said("the customer who bought it, as said, if one is named");
    properties.when = said("when it was bought, as said, e.g. গতকাল, ৩ দিন আগে, gotokal");
  }
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
  // A fitment: the part as known (its own car, quality or number) and the car it also fits (D172).
  if (slots.has("vehicle"))
    properties.vehicle = {
      type: "object",
      description: "the car the part also fits, as said; never the part's own car",
      properties: {
        model: said("the car model as said, e.g. প্রিমিও, premio"),
        year: said("its model year, as said, if one is named"),
        engine: said("its engine code, as said, if one is named"),
      },
      additionalProperties: false,
    };
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
  // A price change: the new price as said, of the kind it names; the owner's two kinds (D145, D171).
  if (slots.has("prices")) {
    properties.prices = {
      type: "object",
      properties: {
        retail: said("the new normal (খুচরা) price, as said, e.g. ৮৫০০ টাকা, 8500"),
        paikari: said("the new paikari (garage, wholesale) price, as said, when the request says paikari"),
      },
      additionalProperties: false,
    };
  }
  // A new customer or supplier (D173): the name exactly as said, and only what the user says of the rest.
  if (slots.has("name"))
    properties.name = said("the new name exactly as said, e.g. রহিম গ্যারেজ, Rahim Garage");
  if (slots.has("party_type"))
    properties.type = said("খুচরা (retail) or পাইকারি (paikari), only if the user says which");
  if (slots.has("phone")) properties.phone = said("the phone number as said, if one is said");
  if (slots.has("address")) properties.address = said("the address as said, if one is said");
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
