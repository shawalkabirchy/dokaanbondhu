// The app icon's PNGs from assets/images/icon.svg (spec 15.1, D166): the launcher icon (full square: the phone rounds
// it), the adaptive icon's foreground (the bubble alone, inside Android's safe circle; app.config.ts sets the green
// behind it) and the splash image (the rounded icon). Run again only when icon.svg changes:
// npm run icons -w apps/mobile
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import process from "node:process";
import sharp from "sharp";

const svg = readFileSync("assets/images/icon.svg", "utf8");
const art = svg.match(/<g id="art">[\s\S]*?<\/g>/)?.[0];
if (!art) throw new Error('icon.svg has no <g id="art">');

const page = (inner) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96">${inner}</svg>`;

const outputs = [
  ["icon.png", 1024, page(`<rect width="96" height="96" fill="#1f7a4d"/>${art}`)],
  // Android shows the middle two thirds of the foreground and may cut it to a circle: the bubble is shrunk to fit.
  [
    "adaptive-icon.png",
    1024,
    page(`<g transform="translate(48 48) scale(0.8) translate(-48 -47)">${art}</g>`),
  ],
  ["splash-icon.png", 512, svg],
];

for (const [name, size, source] of outputs) {
  await sharp(Buffer.from(source), { density: (72 * size) / 96 })
    .resize(size, size)
    .png()
    .toFile(`assets/images/${name}`);
  process.stdout.write(`assets/images/${name} (${size} px)\n`);
}
