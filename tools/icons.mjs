import { Resvg } from "@resvg/resvg-js";
import fs from "node:fs";
const out = "com.dez.bambustatus.sdPlugin/imgs";
const png = (svg, w, file) => fs.writeFileSync(file, new Resvg(svg, { fitTo: { mode: "width", value: w }, font: { loadSystemFonts: true } }).render().asPng());
const both = (svg, w, base) => (png(svg, w, `${base}.png`), png(svg, w * 2, `${base}@2x.png`));

// Monochrome glyphs (category + action list icons)
const printer = (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">
 <rect x="5" y="5" width="30" height="30" rx="4" fill="none" stroke="${c}" stroke-width="2.6"/>
 <path d="M 10 11 H 30" stroke="${c}" stroke-width="2.6" stroke-linecap="round"/>
 <path d="M 16 11 V 15 H 24 V 11 M 18 15 L 20 19 L 22 15" fill="none" stroke="${c}" stroke-width="2.2" stroke-linejoin="round"/>
 <rect x="14" y="24" width="12" height="4" rx="1" fill="${c}"/>
 <path d="M 9 30 H 31" stroke="${c}" stroke-width="2.6" stroke-linecap="round"/>
</svg>`;
const bulbGlyph = (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">
 <circle cx="20" cy="16" r="9" fill="none" stroke="${c}" stroke-width="2.6"/>
 <path d="M 15 27 H 25 M 16 32 H 24" stroke="${c}" stroke-width="2.6" stroke-linecap="round"/>
</svg>`;
const both2 = (svg, base) => (png(svg, 20, `${base}.png`), png(svg, 40, `${base}@2x.png`));
png(printer("#FFFFFF"), 28, `${out}/plugin/category-icon.png`);
png(printer("#FFFFFF"), 56, `${out}/plugin/category-icon@2x.png`);
both2(printer("#FFFFFF"), `${out}/actions/status/icon`);
both2(bulbGlyph("#FFFFFF"), `${out}/actions/light/icon`);
both2(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><g transform="translate(0 8) scale(.78)">${printer("#FFFFFF").replace(/<\/?svg[^>]*>/g, "")}</g><g transform="translate(24 -1) scale(.42)">${bulbGlyph("#FFFFFF").replace(/<\/?svg[^>]*>/g, "")}</g></svg>`, `${out}/actions/statuslight/icon`);

// Colour key images: a printer with the progress border, like the live key
const R = 22;
const BORDER = `M72 7 H${137 - R} A${R} ${R} 0 0 1 137 ${7 + R} V${137 - R} A${R} ${R} 0 0 1 ${137 - R} 137 H${7 + R} A${R} ${R} 0 0 1 7 ${137 - R} V${7 + R} A${R} ${R} 0 0 1 ${7 + R} 7 H72`;
const LEN = 4 * (130 - 2 * R) + 2 * Math.PI * R;
const key = (inner, accent = "#F0857C", pct = 65, bg1 = "#452321", bg2 = "#160C0C") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
 <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bg1}"/><stop offset="1" stop-color="${bg2}"/></linearGradient></defs>
 <rect x="7" y="7" width="130" height="130" rx="${R}" fill="url(#g)"/>
 <path d="${BORDER}" fill="none" stroke="#18211F" stroke-width="7"/>
 <path d="${BORDER}" fill="none" stroke="${accent}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${((pct / 100) * LEN).toFixed(1)} ${LEN.toFixed(1)}"/>
 ${inner}
</svg>`;
const printerArt = `<g transform="translate(32 30) scale(2)">${printer("#FFFFFF").replace(/<\/?svg[^>]*>/g, "")}</g>`;
const bulbArt = (on) => `<g transform="translate(28 22) scale(2.2)">
 <circle cx="20" cy="16" r="9" fill="${on ? "#FFD34D" : "#6E7575"}" stroke="${on ? "#FFF1A6" : "#B4B9B8"}" stroke-width="2"/>
 <path d="M 15.5 26 H 24.5 L 23 31 H 17 Z" fill="${on ? "#E6A92D" : "#555B5B"}"/>
 <path d="M 17 34 H 23" stroke="${on ? "#FFD34D" : "#89908F"}" stroke-width="2" stroke-linecap="round"/></g>`;
const pctText = `<text x="72" y="122" fill="#FFFFFF" font-family="Arial" font-weight="900" font-size="20" text-anchor="middle">65%</text>`;

const statusKey = key(`<g transform="translate(0 -8)">${printerArt}</g>${pctText}`);
both(statusKey, 72, `${out}/actions/status/key`);
both(key(`<g transform="translate(-4 -8)">${printerArt}</g><g transform="translate(96 16) scale(.8)">${bulbArt(true).replace("translate(28 22) scale(2.2)", "scale(1)")}</g>${pctText}`), 72, `${out}/actions/statuslight/key`);
both(key(bulbArt(true), "#FFD34D", 100, "#423B16", "#171407"), 72, `${out}/actions/light/key`);

// Marketplace / plugin icon
both(statusKey, 288, `${out}/plugin/marketplace`);
console.log("icons ok");
