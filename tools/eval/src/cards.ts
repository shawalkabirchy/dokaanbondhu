import type { Item, LookupExpected, MustNotExpected, ReadExpected, WriteExpected } from "./items";

// The test set's two views, both made from items.jsonl (spec 18.4, D184): task-cards.md, the table to check the
// items by, and one printable sheet per speaker with that speaker's voice cards in Bangla, mixed so every kind comes
// up throughout, with the recording rules on top.

export const SPEAKERS = ["S1", "S2", "S3", "S4", "S5"] as const;
/** The speakers who are the shop's staff and record in the shop during business hours: 80 of 200 clips (D184). */
export const IN_SHOP: readonly string[] = ["S1", "S2"];

const KIND_LABEL: Record<Item["kind"], string> = {
  part_lookup: "part lookup",
  other_read: "other read",
  write: "write",
  must_not_act: "must not act",
};

/** What the item should end in, in short. */
export function expectedText(item: Item): string {
  if (item.kind === "part_lookup")
    return `\`find_parts\` → \`${(item.expected as LookupExpected).part_key}\``;
  if (item.kind === "other_read") {
    const read = item.expected as ReadExpected;
    return read.answer === "see_in_app" ? '"see this in your app"' : `read \`${read.read}\``;
  }
  if (item.kind === "must_not_act")
    return `must not: ${(item.expected as MustNotExpected).must_not.join(", ")}`;
  const write = item.expected as WriteExpected;
  const slots = (write.slots ?? {}) as Record<string, unknown>;
  if (write.action === "payment")
    return `payment → customer ${slots.customer}, amount ${slots.amount}, method ${slots.method}`;
  if (write.action === "add_customer")
    return `add_customer → ${slots.name} (${slots.party_type}, ${slots.phone})`;
  if (write.action === "add_supplier") return `add_supplier → ${slots.name}`;
  const price = slots.unit_price !== undefined ? ` at ${slots.unit_price} each` : "";
  return `${write.action} → \`${write.part_key}\`${price}`;
}

/** The scripted answers to the questions the item should need. */
export function asksText(item: Item): string {
  return Object.entries(item.script)
    .filter(([slot]) => slot !== "confirm")
    .map(([slot, value]) => `${slot} → ${value}`)
    .join(", ");
}

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");
const row = (cells: string[]) => `| ${cells.map(cell).join(" | ")} |`;

/** task-cards.md: the mix, then every voice and chat item. Run Prettier on it afterwards to align the tables. */
export function cardsMarkdown(items: Item[], refreshed: string): string {
  const lines = [
    "# Test set: task cards and chat items",
    "",
    `> **Refreshed ${refreshed} against the current seed (D184).** Every expected answer was checked against a freshly`,
    "> seeded copy of GearGrid's demo data. Voice items: the speaker reads the Bangla card and says it in their own",
    "> words; each speaker's cards are on their sheet in `sheets/`. Chat items: the `text` is how staff type, half",
    "> Bangla script and half Banglish. The machine-readable file is `items.jsonl`; this page and the sheets are made",
    "> from it by `npm run eval -- cards`.",
    "",
    "## Mix",
    "",
    row([
      "Channel",
      "Split",
      "Part lookup",
      "Other reads",
      "Writes",
      "Must not act",
      "Needs a question",
      "Bangla / Banglish",
    ]),
    row([
      "-------",
      "-----",
      "-----------",
      "-----------",
      "------",
      "------------",
      "----------------",
      "-----------------",
    ]),
  ];
  for (const channel of ["chat", "voice"] as const)
    for (const split of ["held_out", "open"] as const) {
      const group = items.filter((item) => item.channel === channel && item.split === split);
      const count = (kind: Item["kind"]) => String(group.filter((item) => item.kind === kind).length);
      const questions = group.filter((item) => item.needs_question).length;
      const styles =
        channel === "voice"
          ? "spoken"
          : `${group.filter((item) => item.script_style === "bangla").length} / ${group.filter((item) => item.script_style === "banglish").length}`;
      lines.push(
        row([
          channel,
          split,
          count("part_lookup"),
          count("other_read"),
          count("write"),
          count("must_not_act"),
          `${questions} (${Math.round((questions / group.length) * 100)}%)`,
          styles,
        ]),
      );
    }
  lines.push(
    "",
    "Kinds follow the architecture's test set (11.2): part lookup 35%, other reads 20%, writes 30%, must not act 15%.",
    '"Needs a question" means the card leaves out one thing (year, quality, position, which Rahim, a new supplier\'s',
    "phone) and the assistant should ask; the scripted answer is in `items.jsonl`. Writes: sales (some at a price the",
    "owner names, D176), payments, stock-in, returns, price changes, fitments, new customers and suppliers (D173).",
    "",
    "## Voice items",
    "",
    row(["ID", "Split", "Speaker", "Kind", "As", "Card (Bangla)", "Expected", "Asks"]),
    row(["--", "-----", "-------", "----", "--", "-------------", "--------", "----"]),
  );
  for (const item of items.filter((entry) => entry.channel === "voice"))
    lines.push(
      row([
        item.id,
        item.split,
        item.speaker ?? "",
        KIND_LABEL[item.kind],
        item.as,
        item.task_card_bn ?? item.task_card,
        expectedText(item),
        asksText(item),
      ]),
    );
  lines.push(
    "",
    "## Chat items",
    "",
    row(["ID", "Split", "Kind", "As", "Card (Bangla)", "Chat text", "Expected", "Asks"]),
    row(["--", "-----", "----", "--", "-------------", "---------", "--------", "----"]),
  );
  for (const item of items.filter((entry) => entry.channel === "chat"))
    lines.push(
      row([
        item.id,
        item.split,
        KIND_LABEL[item.kind],
        item.as,
        item.task_card_bn ?? item.task_card,
        item.text ?? "",
        expectedText(item),
        asksText(item),
      ]),
    );
  return `${lines.join("\n")}\n`;
}

/** A stable mix of a speaker's cards: the same order every time, the kinds spread through the sheet. */
function mixed(items: Item[]): Item[] {
  const hash = (text: string) => {
    let value = 2166136261;
    for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619) >>> 0;
    return value;
  };
  return [...items].sort((a, b) => hash(a.id) - hash(b.id) || a.id.localeCompare(b.id));
}

/** A speaker's cards, in the order they are recorded. */
export function sheetCards(items: Item[], speaker: string): Item[] {
  return mixed(items.filter((item) => item.channel === "voice" && item.speaker === speaker));
}

const html = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const bnDigits = (value: number | string) =>
  String(value).replace(/[0-9]/g, (digit) => "০১২৩৪৫৬৭৮৯"[Number(digit)]!);

/** One speaker's printable sheet, in Bangla (A4; open it in a browser and print). */
export function speakerSheet(items: Item[], speaker: string): string {
  const cards = sheetCards(items, speaker);
  const where = IN_SHOP.includes(speaker)
    ? "দোকানের স্টাফ। <b>দোকানে, বেচাকেনার সময়ে</b> রেকর্ড করুন, দোকানের স্বাভাবিক আওয়াজসহ।"
    : "যেকোনো জায়গায় রেকর্ড করুন, যেখানে স্বাভাবিকভাবে কথা বলা যায়।";
  const rows = cards
    .map(
      (item, index) => `      <tr>
        <td class="n">${bnDigits(index + 1)}</td>
        <td class="id">${item.id}</td>
        <td>${html(item.task_card_bn ?? item.task_card)}</td>
        <td class="box"></td>
      </tr>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="bn">
<head>
<meta charset="utf-8">
<title>দোকানবন্ধু এআই: বক্তা ${speaker}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Bengali:wght@400;700&display=swap" rel="stylesheet">
<style>
  @page { size: A4; margin: 14mm 13mm; }
  body { font-family: "Noto Sans Bengali", "Nirmala UI", "Vrinda", sans-serif; font-size: 11.5pt; line-height: 1.45;
         color: #111; margin: 0; }
  h1 { font-size: 16pt; margin: 0 0 2mm; }
  .who { font-size: 12pt; margin: 0 0 3mm; }
  .rules { border: 1px solid #999; border-radius: 3mm; padding: 2.5mm 4mm; margin: 0 0 4mm; }
  .rules ol { margin: 0; padding-left: 5mm; }
  .rules li { margin: 0.6mm 0; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #888; padding: 1.6mm 2mm; vertical-align: top; text-align: left; }
  th { background: #eee; font-size: 10pt; }
  tr { break-inside: avoid; }
  .n { width: 8mm; text-align: right; }
  .id { width: 15mm; font-family: Consolas, monospace; font-size: 10pt; }
  .box { width: 12mm; }
</style>
</head>
<body>
  <h1>দোকানবন্ধু এআই: ভয়েস রেকর্ডিংয়ের কার্ড</h1>
  <p class="who">বক্তা <b>${speaker}</b> · মোট ${bnDigits(cards.length)}টি কার্ড · ${where}</p>
  <div class="rules">
    <ol>
      <li>প্রতিটি কার্ড পড়ুন, তারপর দোকানে যেভাবে বলেন সেভাবে <b>নিজের ভাষায়</b> বলুন। কার্ডটা হুবহু পড়বেন না।</li>
      <li>প্রতিটি কার্ডের জন্য একটি আলাদা রেকর্ডিং। রেকর্ডিংয়ে শুধু কাজের কথাটা বলুন, কার্ডের নম্বর বা কোড বলবেন না।</li>
      <li>রেকর্ডিংয়ের নাম দিন কার্ডের কোড দিয়ে, যেমন <b>v-042</b>। নাম দিতে না পারলে এই তালিকার ক্রমেই রেকর্ড করুন; কোনোটা বাদ পড়লে ✓ ঘরে দাগ দিন।</li>
      <li>ভুল হলে ওই কার্ড আবার রেকর্ড করুন; শেষেরটা রাখা হবে।</li>
      <li>বন্ধনীর ভেতরের কথা (যেমন "শুধু 'রহিম' বলবেন") নির্দেশনা, বলবেন না। "মালিক হিসেবে:" বা "স্টাফ হিসেবে:" কথাটা বলবেন না; ওই কার্ড মালিক বা স্টাফ যেভাবে বলেন সেভাবে বলুন।</li>
      <li>ফোনের রেকর্ডারের মান সবচেয়ে বেশি রাখুন, আওয়াজ কমানোর কোনো সেটিং চালু রাখবেন না (iPhone-এ Voice Memos, Audio Quality: Lossless)।</li>
    </ol>
  </div>
  <table>
    <thead>
      <tr><th class="n">ক্রম</th><th class="id">কোড</th><th>কাজ</th><th class="box">✓</th></tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
</body>
</html>
`;
}
