import { spawn } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { loadItems } from "./items";
import { localClips, withTranscript } from "./recordings";

// The transcript page (spec D236): on the laptop only, at 127.0.0.1. It plays each recording under the recordings
// folder and saves what was said, typed by the owner, into its item's reference_transcript in items.jsonl, which the
// report uses for the speech model's word error rate (D64). Nothing leaves the laptop.

export interface ClipRow {
  id: string;
  speaker: string;
  split: string;
  card: string;
  transcript: string;
}

export function clipRows(itemsFile: string, dir: string): ClipRow[] {
  const items = loadItems(itemsFile);
  const { found } = localClips(dir, items);
  return items
    .filter((item) => found.has(item.id))
    .map((item) => ({
      id: item.id,
      speaker: item.speaker ?? "",
      split: item.split,
      card: item.task_card_bn ?? item.task_card,
      transcript: item.reference_transcript ?? "",
    }))
    .sort((a, b) => a.speaker.localeCompare(b.speaker) || a.id.localeCompare(b.id));
}

/** A recording as a WAV the browser can play (phones write ALAC, AAC, MP3 …), mono at 24 kHz. */
function playable(path: string): Promise<Buffer> {
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
      "-f",
      "wav",
      "pipe:1",
    ]);
    const out: Buffer[] = [];
    ffmpeg.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) =>
      code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg ${code}`)),
    );
  });
}

export function serveTranscripts(itemsFile: string, dir: string, port: number): Server {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (status: number, type: string, body: string | Buffer) => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
    void (async () => {
      try {
        if (req.method === "GET" && url.pathname === "/") return send(200, "text/html; charset=utf-8", PAGE);
        if (req.method === "GET" && url.pathname === "/clips")
          return send(200, "application/json", JSON.stringify(clipRows(itemsFile, dir)));
        const audio = url.pathname.match(/^\/audio\/(v-\d{3})$/);
        if (req.method === "GET" && audio) {
          const path = localClips(dir, loadItems(itemsFile)).found.get(audio[1]!);
          if (!path) return send(404, "text/plain", "no recording");
          return send(200, "audio/wav", await playable(path));
        }
        if (req.method === "POST" && url.pathname === "/transcript") {
          // Bytes first, decoded once: a Bangla letter's bytes may arrive split across two chunks.
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = Buffer.concat(chunks).toString("utf8");
          const { id, text } = JSON.parse(body) as { id: string; text: string };
          if (!/^v-\d{3}$/.test(id) || typeof text !== "string")
            return send(400, "text/plain", "bad request");
          const next = withTranscript(readFileSync(itemsFile, "utf8"), id, text);
          writeFileSync(`${itemsFile}.tmp`, next);
          renameSync(`${itemsFile}.tmp`, itemsFile);
          return send(200, "application/json", JSON.stringify({ ok: true }));
        }
        send(404, "text/plain", "not found");
      } catch (error) {
        send(500, "text/plain", error instanceof Error ? error.message : String(error));
      }
    })();
  });
  server.listen(port, "127.0.0.1");
  return server;
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Clip Transcripts</title>
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
  select, label.opt { font: inherit; }
  select { padding: 4px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--card); }
  main { max-width: 920px; margin: 0 auto; padding: 16px; }
  details.rules { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 10px 14px; margin-bottom: 16px; }
  details.rules summary { cursor: pointer; font-weight: 600; }
  details.rules li { margin: 4px 0; }
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
  .empty { color: var(--muted); text-align: center; padding: 40px; }
</style>
</head>
<body>
<header><div class="bar">
  <h1>Clip transcripts</h1>
  <span class="count" id="count">…</span>
  <div class="meter"><span id="meter"></span></div>
  <select id="speaker"><option value="">All speakers</option></select>
  <label class="opt"><input type="checkbox" id="todo"> Only not typed</label>
  <label class="opt"><input type="checkbox" id="slow"> Slower (0.8×)</label>
</div></header>
<main>
  <details class="rules" open>
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
    </ul>
  </details>
  <div id="list"></div>
</main>
<script>
const list = document.getElementById("list");
const speakerSel = document.getElementById("speaker");
const todoBox = document.getElementById("todo");
const slowBox = document.getElementById("slow");
const audio = new Audio();
let clips = [];
let active = null;

function shown() {
  return clips.filter((c) => (!speakerSel.value || c.speaker === speakerSel.value) && (!todoBox.checked || !c.transcript));
}
function progress() {
  const done = clips.filter((c) => c.transcript).length;
  document.getElementById("count").textContent = done + " of " + clips.length + " typed";
  document.getElementById("meter").style.width = (clips.length ? (100 * done) / clips.length : 0) + "%";
}
function latinWarning(text) {
  const words = text.match(/[A-Za-z]+/g) || [];
  return words.filter((w) => !/^[A-Za-z]$/.test(w));
}
function render() {
  list.textContent = "";
  const rows = shown();
  if (!rows.length) { list.innerHTML = '<p class="empty">Nothing to show.</p>'; return; }
  for (const c of rows) {
    const el = document.createElement("section");
    el.className = "clip";
    el.dataset.id = c.id;
    el.innerHTML =
      '<div class="head"><span class="code"></span><span class="tag spk"></span><span class="tag split"></span>' +
      '<span class="state"></span></div><p class="card"></p>' +
      '<div class="row"><button class="play">▶ Play</button><input class="text" lang="bn" spellcheck="false" ' +
      'placeholder="What was said, in Bangla"><button class="primary save">Save</button></div><span class="warn"></span>';
    el.querySelector(".code").textContent = c.id;
    el.querySelector(".spk").textContent = c.speaker;
    el.querySelector(".split").textContent = c.split === "open" ? "open half" : "held-out half";
    el.querySelector(".card").textContent = "Card: " + c.card;
    const input = el.querySelector(".text");
    input.value = c.transcript;
    const state = el.querySelector(".state");
    const setState = () => {
      const changed = input.value.trim() !== c.transcript;
      state.className = "state " + (changed ? "unsaved" : c.transcript ? "saved" : "");
      state.textContent = changed ? "not saved" : c.transcript ? "saved ✓" : "not typed";
      const latin = latinWarning(input.value);
      const warn = el.querySelector(".warn");
      warn.textContent = latin.length ? "Latin letters: " + latin.join(", ") + " (fine only for a part number or rack)" : "";
      warn.classList.toggle("show", latin.length > 0);
    };
    setState();
    input.addEventListener("input", setState);
    input.addEventListener("focus", () => select(c.id, false));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); save(c, input, setState).then((ok) => ok && next(c.id)); }
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
  const src = "/audio/" + id;
  if (!audio.src.endsWith(src)) audio.src = src;
  audio.currentTime = 0;
  audio.playbackRate = slowBox.checked ? 0.8 : 1;
  audio.play().catch(() => {});
  for (const b of list.querySelectorAll(".play")) b.textContent = "▶ Play";
  const btn = list.querySelector('.clip[data-id="' + id + '"] .play');
  if (btn) btn.textContent = "♪ Playing";
}
audio.addEventListener("ended", () => { for (const b of list.querySelectorAll(".play")) b.textContent = "▶ Play"; });
async function save(c, input, setState) {
  const text = input.value.replace(/\\s+/g, " ").trim();
  if (text === c.transcript) return true;
  const res = await fetch("/transcript", { method: "POST", body: JSON.stringify({ id: c.id, text }) });
  if (!res.ok) { alert("Not saved: " + (await res.text())); return false; }
  c.transcript = text;
  input.value = text;
  setState();
  progress();
  return true;
}
function next(id) {
  const rows = shown();
  const i = rows.findIndex((c) => c.id === id);
  const after = rows.slice(i + 1).find((c) => !c.transcript) || rows[i + 1];
  if (after) { select(after.id, true); play(after.id); }
}
speakerSel.addEventListener("change", render);
todoBox.addEventListener("change", render);
fetch("/clips").then((r) => r.json()).then((rows) => {
  clips = rows;
  for (const s of [...new Set(rows.map((c) => c.speaker))]) {
    const o = document.createElement("option"); o.value = s; o.textContent = s; speakerSel.appendChild(o);
  }
  progress();
  render();
  const first = clips.find((c) => !c.transcript);
  if (first) select(first.id, true);
});
</script>
</body>
</html>
`;
