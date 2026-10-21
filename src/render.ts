import type { PrintState, Snapshot } from "./printer.js";
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

const PALETTES: Record<PrintState | "LIGHT_ON" | "LIGHT_OFF", Palette> = {
	PRINTING: { bg1: "#452321", bg2: "#160C0C", accent: "#F0857C", dim: "#E0AAA5", track: "#63332F" },
	PREPARING: { bg1: "#493019", bg2: "#21150C", accent: "#F1A764", dim: "#C8A989", track: "#5B3E2E" },
	PAUSED: { bg1: "#4D3D18", bg2: "#211A0C", accent: "#F2C762", dim: "#C9B683", track: "#655025" },
	DONE: { bg1: "#17372D", bg2: "#0C1915", accent: "#5BB895", dim: "#91A9A0", track: "#2C443B" },
	IDLE: { bg1: "#17372D", bg2: "#0C1915", accent: "#5BB895", dim: "#91A9A0", track: "#2C443B" },
	CANCELED: { bg1: "#33322D", bg2: "#171714", accent: "#B8B5A8", dim: "#98978F", track: "#484741" },
	ERROR: { bg1: "#4A1720", bg2: "#210B0F", accent: "#FF7180", dim: "#D5A2A9", track: "#672832" },
	OFFLINE: { bg1: "#303235", bg2: "#17191B", accent: "#B5B8B7", dim: "#9BA1A0", track: "#343A3D" },
	CONNECTING: { bg1: "#153747", bg2: "#0B1B22", accent: "#72D8F4", dim: "#9BB7C0", track: "#30474E" },
	LIGHT_ON: { bg1: "#423B16", bg2: "#171407", accent: "#FFD34D", dim: "#E6D59A", track: "#5F541E" },
	LIGHT_OFF: { bg1: "#252A2D", bg2: "#111416", accent: "#9AA3A0", dim: "#8D9493", track: "#343A3D" },
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

// ---------------------------------------------------------------- text

/** Arial Bold advance widths (em). Good enough to shrink text before it hits the border. */
const WIDE: Record<string, number> = { "%": 0.889, m: 0.889, M: 0.833, W: 0.944, w: 0.778, " ": 0.278, ":": 0.333, ".": 0.278, "/": 0.278, "-": 0.333, i: 0.278, l: 0.278, I: 0.278 };
function textWidth(str: string, size: number): number {
	let em = 0;
	for (const ch of str) em += WIDE[ch] ?? (/[0-9]/.test(ch) ? 0.556 : /[A-Z]/.test(ch) ? 0.722 : 0.611);
	return em * size * 1.1; // heavy weights render a little wider than Arial Bold
}
function fit(str: string, size: number, maxWidth: number, min = 9): number {
	const w = textWidth(str, size);
	return w <= maxWidth ? size : Math.max(min, Math.floor((size * maxWidth) / w));
}

function text(str: string, x: number, y: number, size: number, fill: string, weight = 800): string {
	if (!str) return "";
	return `<text x="${x}" y="${y.toFixed(1)}" fill="${fill}" font-family="${FONT}" font-size="${size}" font-weight="${weight}">${esc(str)}</text>`;
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

// ---------------------------------------------------------------- key image

/** Rounded square from 7..137 (r=22), traced clockwise from the top centre. */
const R = 22;
const BORDER = `M72 7 H${137 - R} A${R} ${R} 0 0 1 137 ${7 + R} V${137 - R} A${R} ${R} 0 0 1 ${137 - R} 137 H${7 + R} A${R} ${R} 0 0 1 7 ${137 - R} V${7 + R} A${R} ${R} 0 0 1 ${7 + R} 7 H72`;
const BORDER_LEN = 4 * (130 - 2 * R) + 2 * Math.PI * R;

function bulb(on: boolean, x: number, y: number, scale = 1): string {
	return `<g transform="translate(${x} ${y}) scale(${scale})">
<circle cx="10" cy="9" r="7" fill="${on ? "#FFD34D" : "#6E7575"}" stroke="${on ? "#FFF1A6" : "#B4B9B8"}" stroke-width="2"/>
<path d="M6 15 H14 L12 20 H8 Z" fill="${on ? "#E6A92D" : "#555B5B"}"/>
<path d="M7 22 H13" stroke="${on ? "#FFD34D" : "#89908F"}" stroke-width="2" stroke-linecap="round"/>
${on ? "" : '<path d="M3 20 L17 2" stroke="#FF6672" stroke-width="2.8" stroke-linecap="round"/>'}
</g>`;
}

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

export interface StatusView {
	label: string;
	showLabel: boolean;
	light?: "on" | "off"; // set for the Status + Light action
}

export function renderStatus(snap: Snapshot, s: ActionSettings, view: StatusView): string {
	const p = PALETTES[snap.state];
	const left = 18;
	const maxW = 137 - 11 - left;
	const parts: string[] = [frame(p, progressFor(snap))];

	if (view.light) parts.push(bulb(view.light === "on", 108, 14));
	if (view.showLabel && view.label) {
		const lw = view.light ? 86 : maxW;
		parts.push(text(view.label, left, 31, fit(view.label, 15, lw), p.accent));
	}

	const big = fieldText(s.big, snap, s, "big");
	let small = s.small === "none" ? "" : fieldText(s.small, snap, s, "small");
	// When there's nothing to measure, the bottom line explains why (bad code, error code, ...).
	if (!small && snap.reason && s.small !== "none") small = snap.reason;

	const state = STATE_LABEL[snap.state];
	if (s.showState) {
		parts.push(text(state, left, 64, fit(state, state.length >= 8 ? 20 : 24, maxW), "#FFFFFF", 900));
		parts.push(text(big || "--", left, 101, fit(big || "--", 34, maxW), "#FFFFFF", 900));
	} else {
		// No state line: the big value gets the room.
		const v = big || state;
		const size = big ? fit(v, 42, maxW) : fit(v, 24, maxW);
		parts.push(text(v, left, big ? 92 : 84, size, "#FFFFFF", 900));
	}
	if (small) parts.push(text(small, left + 1, 120, fit(small, 15, maxW), p.dim));

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" viewBox="0 0 ${W} ${W}">${parts.join("")}</svg>`;
}

export function renderLight(mode: "on" | "off" | "unknown", label: string, showLabel: boolean, offline: boolean): string {
	const on = mode === "on";
	const p = offline ? PALETTES.OFFLINE : on ? PALETTES.LIGHT_ON : PALETTES.LIGHT_OFF;
	const parts = [frame(p, on && !offline ? 100 : 0), bulb(on && !offline, 44, 30, 2.8)];
	if (showLabel && label) parts.push(text(label, 72 - textWidth(label, fit(label, 15, 100)) / 2, 31, fit(label, 15, 100), p.accent));
	const status = offline ? "OFFLINE" : on ? "ON" : mode === "off" ? "OFF" : "?";
	parts.push(text(status, 72 - textWidth(status, 20) / 2, 124, 20, offline ? p.dim : "#FFFFFF", 900));
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" viewBox="0 0 ${W} ${W}">${parts.join("")}</svg>`;
}

// ---------------------------------------------------------------- Stream Deck + dial

export function dialFeedback(snap: Snapshot, s: ActionSettings, label: string, light?: "on" | "off") {
	const p = PALETTES[snap.state];
	const big = fieldText(s.big, snap, s, "big") || "--";
	const small = (s.small === "none" ? "" : fieldText(s.small, snap, s, "small")) || snap.reason;
	return {
		background: { value: "", background: `0:${p.bg1},1:${p.bg2}` },
		status: { value: `${label || "BAMBU"} - ${STATE_LABEL[snap.state]}`, color: p.accent },
		big: { value: big, color: "#FFFFFF" },
		small: { value: small, color: p.dim },
		progress: { value: progressFor(snap), bar_fill_c: p.accent, bar_bg_c: p.track },
		light: light ? toDataUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="27" viewBox="0 0 20 24">${bulb(light === "on", 0, 0)}</svg>`) : "",
	};
}
