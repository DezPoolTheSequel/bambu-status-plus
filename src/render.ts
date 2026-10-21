import type { AmsUnit, PrintState, Snapshot } from "./printer.js";
import type { ActionSettings, Field } from "./settings.js";

const W = 144;
const FONT = "Arial, Helvetica, sans-serif";

interface Palette {
	bg1: string;
	bg2: string;
	accent: string;
	dim: string;
	track: string;
}

const PALETTES: Record<PrintState, Palette> = {
	PRINTING: { bg1: "#452321", bg2: "#160C0C", accent: "#F0857C", dim: "#E0AAA5", track: "#63332F" },
	PREPARING: { bg1: "#493019", bg2: "#21150C", accent: "#F1A764", dim: "#C8A989", track: "#5B3E2E" },
	PAUSED: { bg1: "#4D3D18", bg2: "#211A0C", accent: "#F2C762", dim: "#C9B683", track: "#655025" },
	DONE: { bg1: "#17372D", bg2: "#0C1915", accent: "#5BB895", dim: "#91A9A0", track: "#2C443B" },
	IDLE: { bg1: "#17372D", bg2: "#0C1915", accent: "#5BB895", dim: "#91A9A0", track: "#2C443B" },
	CANCELED: { bg1: "#33322D", bg2: "#171714", accent: "#B8B5A8", dim: "#98978F", track: "#484741" },
	ERROR: { bg1: "#4A1720", bg2: "#210B0F", accent: "#FF7180", dim: "#D5A2A9", track: "#672832" },
	OFFLINE: { bg1: "#303235", bg2: "#17191B", accent: "#B5B8B7", dim: "#9BA1A0", track: "#343A3D" },
	CONNECTING: { bg1: "#153747", bg2: "#0B1B22", accent: "#72D8F4", dim: "#9BB7C0", track: "#30474E" },
};

const STATE_LABEL: Record<PrintState, string> = {
	PRINTING: "PRINTING",
	PREPARING: "PREPARING",
	PAUSED: "PAUSED",
	DONE: "DONE",
	IDLE: "IDLE",
	CANCELED: "CANCELED",
	ERROR: "ERROR",
	OFFLINE: "OFFLINE",
	CONNECTING: "CONNECTING",
};

const esc = (s: string) =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export const toDataUrl = (svg: string) => `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`;

const svgDoc = (parts: string[]) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" viewBox="0 0 ${W} ${W}">${parts.join("")}</svg>`;

// ---------------------------------------------------------------- text

/** Arial Bold advance widths (em). Good enough to shrink text before it hits the border. */
const WIDE: Record<string, number> = { "%": 0.889, m: 0.889, M: 0.833, W: 0.944, w: 0.778, " ": 0.278, ":": 0.333, ".": 0.278, "/": 0.278, "-": 0.333, i: 0.278, l: 0.278, I: 0.278, "°": 0.4 };
function textWidth(str: string, size: number): number {
	let em = 0;
	for (const ch of str) em += WIDE[ch] ?? (/[0-9]/.test(ch) ? 0.556 : /[A-Z]/.test(ch) ? 0.722 : 0.611);
	return em * size * 1.1; // heavy weights render a little wider than Arial Bold
}
function fit(str: string, size: number, maxWidth: number, min = 9): number {
	const w = textWidth(str, size);
	return w <= maxWidth ? size : Math.max(min, Math.floor((size * maxWidth) / w));
}

function text(str: string, x: number, y: number, size: number, fill: string, weight = 800, anchor = "start"): string {
	if (!str) return "";
	const a = anchor === "start" ? "" : ` text-anchor="${anchor}"`;
	return `<text x="${x}" y="${y.toFixed(1)}" fill="${fill}" font-family="${FONT}" font-size="${size}" font-weight="${weight}"${a}>${esc(str)}</text>`;
}

// ---------------------------------------------------------------- values

export function formatDuration(min: number, style: ActionSettings["timeFormat"]): string {
	const m = Math.max(0, Math.round(min));
	const h = Math.floor(m / 60);
	if (style === "colon") return `${h}:${String(m % 60).padStart(2, "0")}`;
	return m < 60 ? `${m} min` : `${h}h ${m % 60}m`;
}

export function formatClock(at: number, clock: ActionSettings["clock"]): string {
	const d = new Date(at);
	const h = d.getHours();
	const mm = String(d.getMinutes()).padStart(2, "0");
	if (clock === "24") return `${String(h).padStart(2, "0")}:${mm}`;
	return `${h % 12 || 12}:${mm} ${h < 12 ? "AM" : "PM"}`;
}

const ACTIVE: PrintState[] = ["PRINTING", "PREPARING", "PAUSED"];

/** Text for one field, or "" when it has nothing meaningful to say in this state. */
export function fieldText(field: Field, snap: Snapshot, s: ActionSettings, slot: "big" | "small"): string {
	const active = ACTIVE.includes(snap.state);
	const done = snap.state === "DONE";
	const small = slot === "small";
	switch (field) {
		case "percent":
			return active || done ? `${Math.round(snap.percent)}%` : "";
		case "remaining":
			if (done) return small ? "" : "0 min";
			return active && snap.remaining > 0 ? formatDuration(snap.remaining, s.timeFormat) : "";
		case "finish":
			if (!active || !snap.finishAt || snap.remaining <= 0) return "";
			// Paused prints keep slipping, so a clock time would lie.
			if (snap.state === "PAUSED") return small ? "ETA paused" : "--";
			return `${small ? "ETA " : ""}${formatClock(snap.finishAt, s.clock)}`;
		case "layer":
			if (!(active || done) || !snap.totalLayers) return "";
			return `${small ? "Layer " : ""}${snap.layer}/${snap.totalLayers}`;
		default:
			return "";
	}
}

/** Progress the border shows: 0 when nothing is running, full when done. */
export function progressFor(snap: Snapshot): number {
	if (snap.state === "DONE") return 100;
	return ACTIVE.includes(snap.state) ? snap.percent : 0;
}

// ---------------------------------------------------------------- frame (shared by every page)

/** Rounded square from 7..137 (r=22), traced clockwise from the top centre. */
const R = 22;
const BORDER = `M72 7 H${137 - R} A${R} ${R} 0 0 1 137 ${7 + R} V${137 - R} A${R} ${R} 0 0 1 ${137 - R} 137 H${7 + R} A${R} ${R} 0 0 1 7 ${137 - R} V${7 + R} A${R} ${R} 0 0 1 ${7 + R} 7 H72`;
const BORDER_LEN = 4 * (130 - 2 * R) + 2 * Math.PI * R;
const LEFT = 18;
const RIGHT = 126; // keep text clear of the border
const MAX_W = RIGHT - LEFT;

function frame(p: Palette, progress: number): string {
	const pct = Math.max(0, Math.min(100, progress));
	const fill =
		pct >= 100
			? `<path d="${BORDER}" fill="none" stroke="${p.accent}" stroke-width="7"/>`
			: pct > 0
				? `<path d="${BORDER}" fill="none" stroke="${p.accent}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${((pct / 100) * BORDER_LEN).toFixed(1)} ${BORDER_LEN.toFixed(1)}"/>`
				: "";
	return `<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${p.bg1}"/><stop offset="1" stop-color="${p.bg2}"/></linearGradient>
</defs>
<rect x="0" y="0" width="${W}" height="${W}" fill="#080B0A"/>
<rect x="7" y="7" width="130" height="130" rx="${R}" fill="url(#bg)" stroke="#FFFFFF" stroke-opacity=".08" stroke-width="2"/>
<path d="${BORDER}" fill="none" stroke="#18211F" stroke-width="7" opacity=".95"/>
${fill}`;
}

export interface View {
	label: string;
	showLabel: boolean;
}

/** Printer name top-left, optional page tag top-right. */
function header(p: Palette, view: View, tag = ""): string {
	const tagW = tag ? textWidth(tag, 12) + 6 : 0;
	const out = [tag ? text(tag, RIGHT, 30, 12, p.dim, 800, "end") : ""];
	if (view.showLabel && view.label) out.push(text(view.label, LEFT, 31, fit(view.label, 15, MAX_W - tagW), p.accent));
	return out.join("");
}

// ---------------------------------------------------------------- status page

export function renderStatus(snap: Snapshot, s: ActionSettings, view: View): string {
	const p = PALETTES[snap.state];
	const parts: string[] = [frame(p, progressFor(snap)), header(p, view)];

	const big = fieldText(s.big, snap, s, "big");
	let small = s.small === "none" ? "" : fieldText(s.small, snap, s, "small");
	// When there's nothing to measure, the bottom line explains why (bad code, error code, ...).
	if (!small && snap.reason && s.small !== "none") small = snap.reason;

	const state = STATE_LABEL[snap.state];
	if (s.showState) {
		parts.push(text(state, LEFT, 64, fit(state, state.length >= 8 ? 20 : 24, MAX_W), "#FFFFFF", 900));
		parts.push(text(big || "--", LEFT, 101, fit(big || "--", 34, MAX_W), "#FFFFFF", 900));
	} else {
		// No state line: the big value gets the room.
		const v = big || state;
		const size = big ? fit(v, 42, MAX_W) : fit(v, 24, MAX_W);
		parts.push(text(v, LEFT, big ? 92 : 84, size, "#FFFFFF", 900));
	}
	if (small) parts.push(text(small, LEFT + 1, 120, fit(small, 15, MAX_W), p.dim));

	return svgDoc(parts);
}

// ---------------------------------------------------------------- AMS page

const kind = (unit: AmsUnit) => (unit.trays.length === 1 ? "AMS HT" : "AMS");

/** Black or white text, whichever reads better on the filament colour. */
function inkOn(hex: string): string {
	const n = parseInt(hex.slice(1), 16);
	const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
	return lum > 0.6 ? "#111111" : "#FFFFFF";
}

const drop = (x: number, y: number, fill: string) =>
	`<path d="M${x} ${y - 6} C${x + 4} ${y - 1} ${x + 5} ${y + 1} ${x + 5} ${y + 3} A5 5 0 0 1 ${x - 5} ${y + 3} C${x - 5} ${y + 1} ${x - 4} ${y - 1} ${x} ${y - 6} Z" fill="${fill}"/>`;

/** Printer name centred on top with the page heading under it (AMS + temperature pages). */
function pageHeader(p: Palette, view: View, heading: string): string {
	const out: string[] = [];
	if (view.showLabel && view.label) out.push(text(view.label, 72, 29, fit(view.label, 13, MAX_W), "#FFFFFF", 800, "middle"));
	out.push(text(heading, 72, 47, fit(heading, 15, MAX_W), p.accent, 900, "middle"));
	return out.join("");
}

/** Text with a dark halo so it reads on any filament colour (or on a half-filled slot). */
function haloText(str: string, x: number, y: number, size: number): string {
	const common = `x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="${FONT}" font-size="${size}" font-weight="900" text-anchor="middle"`;
	return `<text ${common} fill="#000000" stroke="#000000" stroke-width="3" stroke-linejoin="round" stroke-opacity=".75">${esc(str)}</text><text ${common} fill="#FFFFFF">${esc(str)}</text>`;
}

export function renderAms(snap: Snapshot, s: ActionSettings, view: View, unitIndex: number): string {
	const p = PALETTES[snap.state];
	const parts: string[] = [frame(p, progressFor(snap))];
	const unit = snap.ams[unitIndex];
	if (!unit) {
		parts.push(pageHeader(p, view, "AMS"));
		const msg = snap.state === "OFFLINE" || snap.state === "CONNECTING" ? STATE_LABEL[snap.state] : "NO AMS";
		parts.push(text(msg, 72, 92, fit(msg, 20, MAX_W), p.dim, 900, "middle"));
		return svgDoc(parts);
	}
	parts.push(pageHeader(p, view, snap.ams.length > 1 ? `${kind(unit)} ${unitIndex + 1}/${snap.ams.length}` : kind(unit)));

	// 2×2 grid of slots (one wide slot for an AMS HT), each with its number badge and material / %.
	const n = unit.trays.length;
	const gap = 4;
	const top = 53;
	const cellW = n === 1 ? MAX_W : (MAX_W - gap) / 2;
	const cellH = n === 1 ? 56 : 26;
	const unitBase = unit.id * 4; // tray_now numbers slots across units: AMS 0 = 0-3, AMS 1 = 4-7, ...
	unit.trays.forEach((t, i) => {
		const x = LEFT + (i % 2) * (cellW + gap);
		const y = top + Math.floor(i / 2) * (cellH + gap);
		const active = snap.activeTray === unitBase + i || (n === 1 && snap.activeTray === unit.id);
		const box = `x="${x.toFixed(1)}" y="${y}" width="${cellW.toFixed(1)}" height="${cellH}" rx="5"`;
		const remainView = s.amsView === "remain" && t.remain >= 0;

		if (t.empty) {
			parts.push(`<rect ${box} fill="#000000" fill-opacity=".3" stroke="#FFFFFF" stroke-opacity=".35" stroke-width="1.5" stroke-dasharray="3 3"/>`);
		} else if (remainView) {
			// Colour fills the slot from the left up to the remaining amount.
			const fw = Math.max(4, (cellW * Math.min(100, t.remain)) / 100);
			parts.push(`<rect ${box} fill="#000000" fill-opacity=".35"/>`);
			parts.push(`<rect x="${x.toFixed(1)}" y="${y}" width="${fw.toFixed(1)}" height="${cellH}" rx="5" fill="${t.color}"/>`);
		} else {
			parts.push(`<rect ${box} fill="${t.color}"/>`);
		}
		if (!t.empty) parts.push(`<rect ${box} fill="none" stroke="${active ? p.accent : "#FFFFFF"}" stroke-opacity="${active ? 1 : 0.35}" stroke-width="${active ? 3 : 1.5}"/>`);

		// Slot number badge
		const bh = Math.min(18, cellH - 8);
		const by = y + (cellH - bh) / 2;
		parts.push(`<rect x="${(x + 4).toFixed(1)}" y="${by.toFixed(1)}" width="14" height="${bh}" rx="3" fill="#FFFFFF" fill-opacity=".9" stroke="#000000" stroke-opacity=".3"/>`);
		parts.push(text(String(i + 1), x + 11, by + bh / 2 + 4, 12, "#111111", 900, "middle"));

		const label = t.empty ? "EMPTY" : remainView ? `${t.remain}%` : s.amsView === "remain" ? "--" : t.material;
		const lx = x + 20 + (cellW - 22) / 2;
		const ly = y + cellH / 2 + 4.5;
		const size = fit(label, n === 1 ? 18 : 13, cellW - 24, 8);
		if (t.empty) parts.push(text(label, lx, ly, size, p.dim, 900, "middle"));
		else if (remainView) parts.push(haloText(label, lx, ly, size));
		else parts.push(text(label, lx, ly, size, inkOn(t.color), 900, "middle"));
	});

	// Humidity + temperature, centred along the bottom.
	const hum = unit.humidity !== undefined ? `${Math.round(unit.humidity)}%` : unit.humidityLevel !== undefined ? `Lvl ${unit.humidityLevel}` : "";
	const tmp = unit.temp !== undefined ? `${temp(unit.temp, s.tempUnit)}${s.tempUnit}` : "";
	if (hum && tmp) {
		parts.push(drop(72 - 8 - textWidth(hum, 14) - 9, 121, "#6EC1FF"));
		parts.push(text(hum, 64, 126, 14, "#FFFFFF", 900, "end"));
		parts.push(text(tmp, 80, 126, 14, "#FFFFFF", 900));
	} else if (hum) {
		parts.push(drop(72 - textWidth(hum, 14) / 2 - 5, 121, "#6EC1FF"));
		parts.push(text(hum, 72 + 6, 126, 14, "#FFFFFF", 900, "middle"));
	} else if (tmp) parts.push(text(tmp, 72, 126, 14, "#FFFFFF", 900, "middle"));
	return svgDoc(parts);
}

// ---------------------------------------------------------------- temperature page

const temp = (c: number | undefined, unit: ActionSettings["tempUnit"]) =>
	c === undefined ? "--" : `${Math.round(unit === "F" ? (c * 9) / 5 + 32 : c)}°`;

const TARGET = "#FFA53A";

export function renderTemps(snap: Snapshot, s: ActionSettings, view: View): string {
	const p = PALETTES[snap.state];
	const parts: string[] = [frame(p, progressFor(snap)), pageHeader(p, view, "TEMPERATURE")];
	const t = snap.temps;
	const rows: [string, number | undefined, number | undefined][] = [
		["Noz", t.nozzle, t.nozzleTarget],
		["Bed", t.bed, t.bedTarget],
		["Chm", t.chamber, undefined],
	];
	rows.forEach(([label, cur, target], i) => {
		const y = 73 + i * 23; // text baseline
		parts.push(text(label, LEFT, y, 13, "#FFFFFF", 800));
		const v = temp(cur, s.tempUnit);
		// Reading right-aligned in the middle column, target in orange on the right while heating.
		parts.push(text(v, 92, y, fit(v, 18, 40), "#FFFFFF", 900, "end"));
		if ((target ?? 0) > 0) {
			const tg = temp(target, s.tempUnit);
			parts.push(text(tg, RIGHT + 1, y, fit(tg, 14, 30), TARGET, 900, "end"));
		}
	});
	return svgDoc(parts);
}

// ---------------------------------------------------------------- Stream Deck + dial

export function dialFeedback(snap: Snapshot, s: ActionSettings, label: string) {
	const p = PALETTES[snap.state];
	const big = fieldText(s.big, snap, s, "big") || "--";
	const small = (s.small === "none" ? "" : fieldText(s.small, snap, s, "small")) || snap.reason;
	return {
		background: { value: "", background: `0:${p.bg1},1:${p.bg2}` },
		status: { value: `${label || "BAMBU"} - ${STATE_LABEL[snap.state]}`, color: p.accent },
		big: { value: big, color: "#FFFFFF" },
		small: { value: small, color: p.dim },
		progress: { value: progressFor(snap), bar_fill_c: p.accent, bar_bg_c: p.track },
	};
}
