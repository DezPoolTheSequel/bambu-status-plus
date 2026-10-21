/** What can be shown in the big centre slot or the small bottom slot. */
export type Field = "percent" | "remaining" | "finish" | "layer" | "none";

/** The screens a key can cycle through on press. */
export type Page = "status" | "ams" | "temps";

export interface ActionSettings {
	[key: string]: string | number | boolean | undefined;
	// --- printer (the access code lives in global settings, never here)
	name: string; // shown on the key; falls back to the Stream Deck title
	ip: string;
	serial: string;
	// --- pages
	pageStatus: boolean;
	pageAms: boolean;
	pageTemps: boolean;
	// --- status page layout
	big: Field;
	small: Field;
	showState: boolean;
	timeFormat: "hm" | "colon"; // "3h 19m" or "3:19"
	clock: "12" | "24";
	// --- AMS / temperature pages
	amsView: "material" | "remain";
	tempUnit: "C" | "F";
}

export const DEFAULTS: ActionSettings = {
	name: "",
	ip: "",
	serial: "",
	pageStatus: true,
	pageAms: true,
	pageTemps: true,
	big: "percent",
	small: "remaining",
	showState: true,
	timeFormat: "hm",
	clock: "12",
	amsView: "material",
	tempUnit: "C",
};

const FIELDS: Field[] = ["percent", "remaining", "finish", "layer", "none"];
const BOOLEAN: (keyof ActionSettings)[] = ["showState", "pageStatus", "pageAms", "pageTemps"];

/** Merge stored settings over defaults and coerce types (the PI stores some values as strings). */
export function resolveSettings(raw: Partial<Record<string, unknown>> | undefined): ActionSettings {
	const s: ActionSettings = { ...DEFAULTS };
	for (const [k, v] of Object.entries(raw ?? {})) {
		if (v === undefined || v === null || k === "accessCode") continue;
		(s as any)[k] = v;
	}
	for (const k of BOOLEAN) {
		const v = s[k];
		(s as any)[k] = v === true || v === "true" || v === 1 || v === "1" || v === "on";
	}
	s.name = String(s.name).trim();
	s.ip = String(s.ip).trim();
	s.serial = String(s.serial).trim().toUpperCase();
	if (!FIELDS.includes(s.big)) s.big = DEFAULTS.big;
	if (!FIELDS.includes(s.small)) s.small = DEFAULTS.small;
	if (s.tempUnit !== "F") s.tempUnit = "C";
	if (s.amsView !== "remain") s.amsView = "material";
	return s;
}

/** Enabled pages in display order; never empty. */
export function pagesFor(s: ActionSettings): Page[] {
	const pages: Page[] = [];
	if (s.pageStatus) pages.push("status");
	if (s.pageAms) pages.push("ams");
	if (s.pageTemps) pages.push("temps");
	return pages.length ? pages : ["status"];
}

/** Credentials are keyed by printer so several keys for one printer share one code (and one connection). */
export const printerKey = (s: Pick<ActionSettings, "ip" | "serial">) => (s.ip && s.serial ? `${s.ip}|${s.serial}` : "");

export type GlobalSettings = {
	credentials: Record<string, string>;
};
