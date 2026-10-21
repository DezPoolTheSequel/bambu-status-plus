/** What can be shown in the big centre slot or the small bottom slot. */
export type Field = "percent" | "remaining" | "finish" | "layer" | "none";

export interface ActionSettings {
	[key: string]: string | number | boolean | undefined;
	// --- printer (the access code lives in global settings, never here)
	ip: string;
	serial: string;
	// --- layout (status keys)
	big: Field;
	small: Field;
	showState: boolean;
	timeFormat: "hm" | "colon"; // "3h 19m" or "3:19"
	clock: "12" | "24";
	press: "refresh" | "swap";
	// --- light keys
	ledNode: string;
}

export const DEFAULTS: ActionSettings = {
	ip: "",
	serial: "",
	big: "percent",
	small: "remaining",
	showState: true,
	timeFormat: "hm",
	clock: "12",
	press: "refresh",
	ledNode: "chamber_light",
};

const FIELDS: Field[] = ["percent", "remaining", "finish", "layer", "none"];
const BOOLEAN: (keyof ActionSettings)[] = ["showState"];

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
	s.ip = String(s.ip).trim();
	s.serial = String(s.serial).trim().toUpperCase();
	if (!FIELDS.includes(s.big)) s.big = DEFAULTS.big;
	if (!FIELDS.includes(s.small)) s.small = DEFAULTS.small;
	s.ledNode = String(s.ledNode || DEFAULTS.ledNode).trim();
	return s;
}

/** Credentials are keyed by printer so several keys for one printer share one code (and one connection). */
export const printerKey = (s: Pick<ActionSettings, "ip" | "serial">) => (s.ip && s.serial ? `${s.ip}|${s.serial}` : "");

export type GlobalSettings = {
	credentials: Record<string, string>;
};
