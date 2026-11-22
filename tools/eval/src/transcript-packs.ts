import { spawn } from "node:child_process";
import { z } from "zod";
import type { Item } from "./items";
import { withTranscript } from "./recordings";

// Transcript packs (spec D244): the clips not typed yet, split into equal parts, each part a single HTML file with its
// clips inside, which the owner shares on Google Drive with the person who types that part. The page needs no server
// and no internet: it plays each clip, keeps what is typed in that browser, and gives the work back as a small JSON
// file of text only ("Download my work"). `npm run eval -- transcripts-import` writes it into items.jsonl.

export interface PackClip {
  id: string;
  speaker: string;
  card: string;
}

export interface Pack {
  /** The pack's name, also the browser's storage key and the returned file's name ("18nov-part-1"). */
  name: string;
  part: number;
  of: number;
  clips: PackClip[];
}

/** Rows cut into `parts` runs in order, as equal as they can be (126 in 3 is 42 each; 86 in 3 is 28, 29, 29). */
export function splitParts<T>(rows: T[], parts: number): T[][] {
  if (!Number.isInteger(parts) || parts < 1) throw new Error("--parts must be a whole number from 1");
  return Array.from({ length: parts }, (_, i) =>
    rows.slice(Math.floor((i * rows.length) / parts), Math.floor(((i + 1) * rows.length) / parts)),
  ).filter((part) => part.length > 0);
}

/** A recording as a small MP3 every browser plays (mono, 24 kHz, 64 kbit/s), read by its path (D236). */
export function mp3Of(path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      path,
      "-ac",
      "1",
      "-ar",
      "24000",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "64k",
      "-f",
      "mp3",
      "pipe:1",
    ]);
    const out: Buffer[] = [];
    ffmpeg.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => {
      const mp3 = Buffer.concat(out);
      if (code !== 0) reject(new Error(`ffmpeg ${code} on ${path}`));
      else if (mp3.byteLength < 2_000) reject(new Error(`${path} came out empty`));
      else resolve(mp3);
    });
  });
}

/** One pack as a page that works opened straight from the disk: its clips are inside it, as MP3 data. */
export function packPage(pack: Pack, audio: Map<string, Buffer>): string {
  const data = {
    name: pack.name,
    part: pack.part,
    of: pack.of,
    clips: pack.clips.map((clip) => {
      const mp3 = audio.get(clip.id);
      if (!mp3) throw new Error(`no audio for ${clip.id}`);
      return { ...clip, audio: `data:audio/mpeg;base64,${mp3.toString("base64")}` };
    }),
  };
  // `<` written as <, so nothing in the data can close the script element it sits in.
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return PAGE.replace("__TITLE__", `Transcripts, part ${pack.part} of ${pack.of}`).replace(
    "__DATA__",
    () => json,
  );
}

const returned = z.object({
  pack: z.string(),
  transcripts: z.array(z.object({ id: z.string(), text: z.string() })),
});

export interface Imported {
  /** items.jsonl with the transcripts set. */
  next: string;
  pack: string;
  saved: string[];
  /** Saved over a different transcript already there. */
  changed: string[];
  /** Left empty in the returned file, so not typed yet. */
  empty: string[];
}

/** A returned pack's transcripts written into items.jsonl; an id that is not a voice card stops it before any write. */
export function importTranscripts(itemsText: string, items: Item[], returnedJson: string): Imported {
  const file = returned.parse(JSON.parse(returnedJson));
  const voice = new Map(items.filter((item) => item.channel === "voice").map((item) => [item.id, item]));
  const unknown = file.transcripts.filter((row) => !voice.has(row.id)).map((row) => row.id);
  if (unknown.length) throw new Error(`not voice cards of the test set: ${unknown.join(", ")}`);
  let next = itemsText;
  const result: Imported = { next, pack: file.pack, saved: [], changed: [], empty: [] };
  for (const row of file.transcripts) {
    const text = row.text.normalize("NFC").replace(/\s+/g, " ").trim();
    if (!text) {
      result.empty.push(row.id);
      continue;
    }
    const before = voice.get(row.id)?.reference_transcript ?? "";
    if (before && before !== text) result.changed.push(row.id);
    next = withTranscript(next, row.id, text);
    result.saved.push(row.id);
  }
  result.next = next;
  return result;
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__</title>
<link rel="icon" href="data:,">
<style>
  :root { --bg: #f6f7f5; --card: #fff; --ink: #1d2420; --muted: #66706a; --line: #dfe3df; --green: #1f7a4d;
    --green-soft: #e3f2ea; --amber: #a86400; --amber-soft: #fbf0dc; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 "Segoe UI", system-ui, sans-serif; }
  header { position: sticky; top: 0; z-index: 2; background: var(--card); border-bottom: 1px solid var(--line); }
  .bar { max-width: 920px; margin: 0 auto; padding: 12px 16px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  h1 { font-size: 18px; margin: 0 12px 0 0; }
  .count { color: var(--muted); }
  .meter { flex: 1; min-width: 120px; height: 6px; background: var(--line); border-radius: 3px; overflow: hidden; }
  .meter span { display: block; height: 100%; background: var(--green); width: 0; transition: width .2s; }
  label.opt { font: inherit; }
  main { max-width: 920px; margin: 0 auto; padding: 16px; }
  .box { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 10px 14px; margin-bottom: 16px; }
  details.box summary { cursor: pointer; font-weight: 600; }
  .box li { margin: 4px 0; }
  .box.send { border-color: var(--green); background: var(--green-soft); }
  .box.alert { border-color: var(--amber); background: var(--amber-soft); display: none; }
  .box.alert.show { display: block; }
  .clip { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; margin-bottom: 10px; }
  .clip.active { border-color: var(--green); box-shadow: 0 0 0 2px var(--green-soft); }
  .head { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 6px; }
  .code { font: 600 14px Consolas, monospace; }
  .tag { font-size: 12px; padding: 1px 8px; border-radius: 10px; background: var(--bg); color: var(--muted); }
  .state { margin-left: auto; font-size: 13px; color: var(--muted); }
  .state.saved { color: var(--green); }
  .state.unsaved { color: var(--amber); }
  .card { font-size: 13px; color: var(--muted); margin: 0 0 8px; }
  .row { display: flex; gap: 8px; align-items: stretch; }
  button { font: inherit; border: 1px solid var(--line); background: var(--card); border-radius: 6px; padding: 6px 12px; cursor: pointer; }
  button.play { min-width: 76px; }
  button.primary { background: var(--green); border-color: var(--green); color: #fff; }
  input.text { flex: 1; min-width: 0; font: 18px/1.4 "Nirmala UI", "Vrinda", "Segoe UI", sans-serif; padding: 6px 10px;
    border: 1px solid var(--line); border-radius: 6px; }
  input.text:focus { outline: 2px solid var(--green); border-color: var(--green); }
  .warn { font-size: 13px; color: var(--amber); background: var(--amber-soft); border-radius: 6px; padding: 2px 8px; margin-top: 6px; display: none; }
  .warn.show { display: inline-block; }
  @media (max-width: 560px) { .row { flex-wrap: wrap; } input.text { flex-basis: 100%; order: -1; } }
</style>
</head>
<body>
<header><div class="bar">
  <h1 id="title"></h1>
  <span class="count" id="count">…</span>
  <div class="meter"><span id="meter"></span></div>
  <label class="opt"><input type="checkbox" id="slow"> Slower (0.8×)</label>
  <button class="primary" id="download">Download my work</button>
</div></header>
<main>
  <div class="box alert" id="nostore"><b>This browser can't keep your work.</b> Click <b>Download my work</b> before you
    close this page, or what you typed is lost. Next time, click <b>Load my work</b> and pick that file.</div>
  <div class="box send">
    <b>When you finish</b> (or stop for the day): click <b>Download my work</b> and send the file it gives you
    (<span id="outname"></span>) back to the person who gave you this page. That file has only your typing, no voices.
    Your typing is also kept in this browser as you go, so you can close the page and open this same file again later.
    On another computer or browser, click <button id="load">Load my work</button> and pick the file you downloaded.
    <input type="file" id="loadfile" accept=".json,application/json" hidden>
  </div>
  <details class="box" open>
    <summary>How to type a transcript</summary>
    <ul>
      <li>Type <b>exactly what the speaker said</b>, not what the card says: every word, in the order said, even a wrong
        or repeated one. Leave out "um" and coughs.</li>
      <li><b>Bangla script for every word</b>, English words too (ব্রেক প্যাড, এক্সিও). Avro or Windows' Bangla
        keyboard both work.</li>
      <li><b>Numbers in digits</b>: years, prices, counts (২০১৪, ৩০০০ টাকা, ২ সেট). Part numbers and racks as written
        (04465-10010, B-3).</li>
      <li><b>Enter</b> saves and plays the next clip. <b>F2</b> plays this clip again. A saved transcript can be changed any
        time: edit it and press Enter.</li>
      <li>These are people's voices: don't share this page, and delete it (and its download) once your work is sent.</li>
    </ul>
  </details>
  <div id="list"></div>
</main>
<script type="application/json" id="data">__DATA__</script>
<script>
const pack = JSON.parse(document.getElementById("data").textContent);
const key = "transcripts:" + pack.name;
const list = document.getElementById("list");
const slowBox = document.getElementById("slow");
const audio = new Audio();
const typed = {};
let active = null;
let canStore = true;

function readStore() {
  try { return JSON.parse(localStorage.getItem(key) || "{}"); } catch (e) { canStore = false; return {}; }
}
function writeStore() {
  try { localStorage.setItem(key, JSON.stringify(typed)); } catch (e) { canStore = false; }
  document.getElementById("nostore").classList.toggle("show", !canStore);
}
function tidy(text) { return text.split(/\\s+/).filter(Boolean).join(" "); }
function progress() {
  const done = pack.clips.filter((c) => typed[c.id]).length;
  document.getElementById("count").textContent = done + " of " + pack.clips.length + " typed";
  document.getElementById("meter").style.width = (100 * done) / pack.clips.length + "%";
}
function latinWarning(text) {
  return (text.match(/[A-Za-z]+/g) || []).filter((w) => w.length > 1);
}
function render() {
  list.textContent = "";
  for (const c of pack.clips) {
    const el = document.createElement("section");
    el.className = "clip";
    el.dataset.id = c.id;
    el.innerHTML =
      '<div class="head"><span class="code"></span><span class="tag spk"></span><span class="state"></span></div>' +
      '<p class="card"></p><div class="row"><button class="play">▶ Play</button><input class="text" lang="bn" ' +
      'spellcheck="false" placeholder="What was said, in Bangla"><button class="primary save">Save</button></div>' +
      '<span class="warn"></span>';
    el.querySelector(".code").textContent = c.id;
    el.querySelector(".spk").textContent = c.speaker;
    el.querySelector(".card").textContent = "Card: " + c.card;
    const input = el.querySelector(".text");
    input.value = typed[c.id] || "";
    const state = el.querySelector(".state");
    const setState = () => {
      const saved = typed[c.id] || "";
      const changed = tidy(input.value) !== saved;
      state.className = "state " + (changed ? "unsaved" : saved ? "saved" : "");
      state.textContent = changed ? "not saved" : saved ? "saved ✓" : "not typed";
      const latin = latinWarning(input.value);
      const warn = el.querySelector(".warn");
      warn.textContent = latin.length ? "Latin letters: " + latin.join(", ") + " (fine only for a part number or rack)" : "";
      warn.classList.toggle("show", latin.length > 0);
    };
    setState();
    input.addEventListener("input", setState);
    input.addEventListener("focus", () => select(c.id, false));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); save(c, input, setState); next(c.id); }
      if (e.key === "F2") { e.preventDefault(); play(c.id); }
    });
    el.querySelector(".play").addEventListener("click", () => { select(c.id, false); play(c.id); });
    el.querySelector(".save").addEventListener("click", () => save(c, input, setState));
    list.appendChild(el);
  }
  if (active) markActive(active);
}
function markActive(id) {
  for (const el of list.querySelectorAll(".clip")) el.classList.toggle("active", el.dataset.id === id);
}
function select(id, focus) {
  active = id;
  markActive(id);
  const el = list.querySelector('.clip[data-id="' + id + '"]');
  if (el && focus) { el.querySelector(".text").focus(); el.scrollIntoView({ block: "center", behavior: "smooth" }); }
}
function play(id) {
  const clip = pack.clips.find((c) => c.id === id);
  if (audio.dataset.id !== id) { audio.src = clip.audio; audio.dataset.id = id; }
  audio.currentTime = 0;
  audio.playbackRate = slowBox.checked ? 0.8 : 1;
  audio.play().catch(() => {});
  for (const b of list.querySelectorAll(".play")) b.textContent = "▶ Play";
  const btn = list.querySelector('.clip[data-id="' + id + '"] .play');
  if (btn) btn.textContent = "♪ Playing";
}
audio.addEventListener("ended", () => { for (const b of list.querySelectorAll(".play")) b.textContent = "▶ Play"; });
function save(c, input, setState) {
  const text = tidy(input.value);
  if (text) typed[c.id] = text; else delete typed[c.id];
  input.value = text;
  writeStore();
  setState();
  progress();
}
function next(id) {
  const i = pack.clips.findIndex((c) => c.id === id);
  const rest = pack.clips.slice(i + 1);
  const after = rest.find((c) => !typed[c.id]) || rest[0];
  if (after) { select(after.id, true); play(after.id); }
}
const outName = "transcripts-" + pack.name + "-done.json";
document.getElementById("outname").textContent = outName;
document.getElementById("title").textContent = "Transcripts, part " + pack.part + " of " + pack.of;
document.getElementById("download").addEventListener("click", () => {
  const body = { pack: pack.name, transcripts: pack.clips.map((c) => ({ id: c.id, text: typed[c.id] || "" })) };
  const url = URL.createObjectURL(new Blob([JSON.stringify(body, null, 1)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = outName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
document.getElementById("load").addEventListener("click", () => document.getElementById("loadfile").click());
document.getElementById("loadfile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const body = JSON.parse(await file.text());
    if (body.pack !== pack.name) { alert("That file is for another part (" + body.pack + "), not this one."); return; }
    const ids = new Set(pack.clips.map((c) => c.id));
    for (const row of body.transcripts) if (ids.has(row.id) && tidy(row.text)) typed[row.id] = tidy(row.text);
    writeStore();
    render();
    progress();
  } catch (err) { alert("Could not read that file."); }
  e.target.value = "";
});
window.addEventListener("beforeunload", (e) => {
  if (!canStore && Object.keys(typed).length) { e.preventDefault(); e.returnValue = ""; }
});
Object.assign(typed, readStore());
writeStore();
progress();
render();
const first = pack.clips.find((c) => !typed[c.id]);
if (first) select(first.id, true);
</script>
</body>
</html>
`;
