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
  if (write.action === "rack_update") return `rack_update → \`${write.part_key}\` on ${slots.rack}`;
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
    "Items 201 to 212 of each channel are step 10's extras (D196, D201), added after the 400 with new IDs: reminders",
    "(reads of the parts running low and the old dues, D194) and rack changes (writes, D195). The mix above counts them.",
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
  const own = items.filter((item) => item.channel === "voice" && item.speaker === speaker);
  // The cards added after the 400 come last, so a speaker part-way through the first sheet keeps their place (D201).
  return [...mixed(own.filter((item) => !isAdded(item))), ...mixed(own.filter(isAdded))];
}

/** A card added after the 400 (step 10's extras, D196, D201): numbered from 201 in its channel. */
export const isAdded = (item: Pick<Item, "id">) => Number(item.id.slice(2)) > 200;

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
  const firstAdded = cards.findIndex(isAdded);
  const rows = cards
    .map(
      (item, index) => `${
        index === firstAdded
          ? `      <tr class="added"><td colspan="4">নতুন কার্ড (২৩ অক্টোবর যোগ হয়েছে): আগের কার্ডগুলোর পরে এগুলো রেকর্ড করুন</td></tr>\n`
          : ""
      }      <tr>
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
  .phones { border: 1px solid #999; border-radius: 3mm; padding: 2.5mm 4mm; margin: 0 0 4mm; break-inside: avoid; }
  .phones h2 { font-size: 12pt; margin: 0 0 1.5mm; }
  .phones h3 { font-size: 11pt; margin: 0 0 1mm; }
  .phones .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 5mm; }
  .phones ol { margin: 0; padding-left: 5mm; font-size: 10.5pt; }
  .phones li { margin: 0.5mm 0; }
  .phones p { margin: 2mm 0 0; font-size: 10.5pt; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #888; padding: 1.6mm 2mm; vertical-align: top; text-align: left; }
  th { background: #eee; font-size: 10pt; }
  tr { break-inside: avoid; }
  .n { width: 8mm; text-align: right; }
  .id { width: 15mm; font-family: Consolas, monospace; font-size: 10pt; }
  .box { width: 12mm; }
  .added td { background: #eee; font-weight: 700; }
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
      <li>ফোনের রেকর্ডারের মান সবচেয়ে বেশি রাখুন, আওয়াজ কমানোর কোনো সেটিং চালু রাখবেন না। নিচের বাক্সে আপনার ফোনের নিয়ম দেখুন।</li>
    </ol>
  </div>
  <div class="phones">
    <h2>ফোনে যেভাবে রেকর্ড করবেন</h2>
    <div class="cols">
      <div>
        <h3>Android</h3>
        <ol>
          <li>ফোনের নিজের রেকর্ডার অ্যাপ খুলুন: Samsung-এ <b>Voice Recorder</b>, Pixel-এ <b>Recorder</b>, Xiaomi বা Redmi-তে <b>Sound Recorder</b>, অন্য ফোনে <b>Recorder</b> বা <b>Voice Recorder</b>।</li>
          <li>অ্যাপের <b>Settings</b>-এ <b>Recording quality</b> (বা Audio quality) সবচেয়ে বেশি, যেমন <b>High</b>, রাখুন।</li>
          <li><b>Noise reduction</b>, <b>Noise cancellation</b> বা <b>Speech enhancement</b> থাকলে বন্ধ রাখুন। <b>Standard</b> বা <b>Normal</b> মোডে রেকর্ড করুন, <b>Interview</b> বা <b>Speech-to-text</b> মোডে নয়।</li>
          <li>রেকর্ড শেষে সেভ করার সময় নাম দিন কার্ডের কোড দিয়ে, যেমন <b>v-042</b>।</li>
        </ol>
      </div>
      <div>
        <h3>iPhone</h3>
        <ol>
          <li><b>Voice Memos</b> অ্যাপ দিয়ে রেকর্ড করুন।</li>
          <li>শুরুর আগে একবার: <b>Settings</b> → <b>Apps</b> → <b>Voice Memos</b> → <b>Audio Quality</b>: <b>Lossless</b> (পুরোনো iPhone-এ Settings → Voice Memos)।</li>
          <li>রেকর্ডিং খুলে <b>Enhance Recording</b> (জাদুর কাঠির চিহ্ন) চাপবেন না।</li>
          <li>রেকর্ডিংয়ের নামের ওপর ট্যাপ করে কার্ডের কোড লিখুন, যেমন <b>v-042</b>।</li>
        </ol>
      </div>
    </div>
    <p>দুই ফোনেই: WhatsApp বা Messenger-এর ভয়েস মেসেজ দিয়ে রেকর্ড করবেন না, তাতে আওয়াজের মান কমে যায়। ফোন স্বাভাবিকভাবে ধরুন, দোকানে কথা বলার সময় যেভাবে ধরেন।</p>
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
