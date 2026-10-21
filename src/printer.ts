import { EventEmitter } from "node:events";
import mqtt, { type MqttClient } from "mqtt";

export type PrintState = "CONNECTING" | "OFFLINE" | "IDLE" | "PREPARING" | "PRINTING" | "PAUSED" | "DONE" | "CANCELED" | "ERROR";

export interface Snapshot {
	state: PrintState;
	/** 0-100 */
	percent: number;
	/** minutes left, as reported by the printer */
	remaining: number;
	/** epoch ms the print should finish (now + remaining at the time of the last report) */
	finishAt: number;
	layer: number;
	totalLayers: number;
	/** set for ERROR ("CODE 0300400C") and OFFLINE ("NO CONNECTION", "CHECK ACCESS CODE") */
	reason: string;
	temps: Temps;
	ams: AmsUnit[];
	/** global index of the slot feeding the nozzle (unit * 4 + slot), -1 for none */
	activeTray: number;
}

export interface Temps {
	nozzle?: number;
	nozzleTarget?: number;
	bed?: number;
	bedTarget?: number;
	chamber?: number;
}

export interface AmsTray {
	empty: boolean;
	/** "#RRGGBB" */
	color: string;
	material: string;
	/** 0-100, or -1 when the AMS doesn't know (non-Bambu spool) */
	remain: number;
}

export interface AmsUnit {
	id: number;
	/** AMS HT has one slot, AMS / AMS 2 Pro / AMS lite have four */
	trays: AmsTray[];
	humidity?: number; // %
	humidityLevel?: number; // 1 (dry) - 5 (wet), older firmware only reports this
	temp?: number;
}

/** Port is only overridable so the test harness can point the plugin at a local fake printer. */
const PORT = Number(process.env.BAMBU_MQTT_PORT) || 8883;
const PUSHALL_EVERY = 5 * 60_000; // Bambu asks clients not to request full reports more often than this

const CANCEL_CODES = ["0300400C", "0500400E"];

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

/** Reports are partial: merge objects, replace arrays (except AMS units/trays, merged by id). */
function merge(base: Record<string, any>, patch: Record<string, any>): Record<string, any> {
	const out = { ...base };
	for (const [k, v] of Object.entries(patch)) {
		if (isObj(v) && isObj(out[k])) out[k] = merge(out[k], v);
		else if (Array.isArray(v) && Array.isArray(out[k]) && (k === "ams" || k === "tray") && v.every((x) => isObj(x) && x.id !== undefined)) {
			const byId = new Map(out[k].filter(isObj).map((x: any) => [String(x.id), x]));
			for (const x of v) byId.set(String(x.id), merge(byId.get(String(x.id)) ?? {}, x));
			out[k] = [...byId.values()];
		} else out[k] = v;
	}
	return out;
}

const num = (v: unknown): number | undefined => {
	const n = Number(v);
	return v === undefined || v === null || v === "" || !Number.isFinite(n) ? undefined : n;
};

/** H2-series pack current + target into one int: low 16 bits = current, high 16 = target. */
const unpack = (v: unknown): [number | undefined, number | undefined] => {
	const n = num(v);
	if (n === undefined) return [undefined, undefined];
	return n > 0xffff ? [n & 0xffff, n >>> 16] : [n, undefined];
};

function readTemps(r: Record<string, any>): Temps {
	const t: Temps = { nozzle: num(r.nozzle_temper), nozzleTarget: num(r.nozzle_target_temper), bed: num(r.bed_temper), bedTarget: num(r.bed_target_temper), chamber: num(r.chamber_temper) };
	const ext = r.device?.extruder;
	if (Array.isArray(ext?.info) && ext.info.length) {
		// Dual-nozzle printers: show the nozzle that's heating (if any), else the first one.
		const cur = ext.info.find((e: any) => (unpack(e?.temp)[1] ?? 0) > 0) ?? ext.info[0];
		const [c, tg] = unpack(cur?.temp);
		t.nozzle ??= c;
		t.nozzleTarget ??= tg;
	}
	if (t.chamber === undefined) t.chamber = unpack(r.device?.ctc?.info?.temp)[0];
	if (r.device?.bed?.info?.temp !== undefined && t.bed === undefined) [t.bed, t.bedTarget] = unpack(r.device.bed.info.temp);
	return t;
}

function readAms(r: Record<string, any>): AmsUnit[] {
	const units = r.ams?.ams;
	if (!Array.isArray(units)) return [];
	return units
		.filter(isObj)
		.map((u) => {
			const trays: AmsTray[] = (Array.isArray(u.tray) ? u.tray : [])
				.filter(isObj)
				.sort((a: any, b: any) => Number(a.id) - Number(b.id))
				.map((t: any) => {
					const empty = !t.tray_type;
					const hex = String(t.tray_color ?? "").replace(/^#/, "").slice(0, 6);
					return {
						empty,
						color: /^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toUpperCase()}` : "#555555",
						material: empty ? "" : String(t.tray_type), // "PLA", "PETG" - sub-brands are too long for a slot
						remain: num(t.remain) ?? -1,
					};
				});
			const humidityRaw = num(u.humidity_raw);
			const level = num(u.humidity);
			const temp = num(u.temp);
			return {
				id: Number(u.id) || 0,
				trays,
				humidity: humidityRaw,
				humidityLevel: humidityRaw === undefined ? level : undefined,
				temp: temp && temp > 0 ? temp : undefined,
			};
		})
		.filter((u) => u.trays.length > 0)
		.sort((a, b) => a.id - b.id);
}

/**
 * The slot feeding the nozzle, numbered like tray_now: AMS n slot k = n*4 + k, AMS HT = its unit id (128+).
 * H2-series (and other new) printers report it per extruder in device.extruder.info[].snow as
 * (ams id << 8 | slot); older models use ams.tray_now (255 = nothing loaded, 254 = external spool).
 */
function readActiveTray(r: Record<string, any>): number {
	const info = r.device?.extruder?.info;
	if (Array.isArray(info)) {
		const loaded = info.filter((e: any) => num(e?.snow) !== undefined && (Number(e.snow) >> 8) !== 0xff);
		// Dual nozzle: prefer the one that's heating, i.e. the one printing.
		const cur = loaded.find((e: any) => (unpack(e?.temp)[1] ?? 0) > 0) ?? loaded[0];
		if (cur) {
			const ams = Number(cur.snow) >> 8;
			const slot = Number(cur.snow) & 0xff;
			if (ams >= 128) return ams;
			if (ams < 16) return ams * 4 + slot;
		}
	}
	const tray = num(r.ams?.tray_now);
	return tray !== undefined && tray >= 0 && tray < 254 ? tray : -1;
}

/** print_error arrives as a decimal number; Bambu documents the codes in hex. */
function hexCode(v: unknown): string {
	const s = String(v ?? "").trim();
	if (!s || s === "0") return "";
	if (/^\d+$/.test(s)) return Number(s).toString(16).toUpperCase().padStart(8, "0");
	return s.replace(/^0x/i, "").toUpperCase().padStart(8, "0").slice(-8);
}

/**
 * One MQTT connection per printer, shared by every key that shows it.
 * Emits "update" with a fresh Snapshot whenever anything changes.
 */
export class Printer extends EventEmitter {
	readonly key: string;
	private client?: MqttClient;
	private report: Record<string, any> = {};
	private online = false;
	private offlineReason = "";
	private finishAt = 0;
	private pushTimer?: NodeJS.Timeout;

	constructor(
		readonly ip: string,
		readonly serial: string,
		readonly accessCode: string,
	) {
		super();
		this.key = `${ip}|${serial}`;
		this.setMaxListeners(100);
	}

	connect(): void {
		const client = mqtt.connect(`mqtts://${this.ip}:${PORT}`, {
			username: "bblp",
			password: this.accessCode,
			rejectUnauthorized: false, // printers use a self-signed certificate
			connectTimeout: 7000,
			reconnectPeriod: 10_000,
			keepalive: 30,
			clientId: `sd_${this.serial}_${Math.random().toString(16).slice(2, 8)}`,
		});
		this.client = client;

		client.on("connect", () => {
			this.online = true;
			this.offlineReason = "";
			client.subscribe(`device/${this.serial}/report`, (err) => {
				if (!err) this.pushAll();
			});
			clearInterval(this.pushTimer);
			this.pushTimer = setInterval(() => this.pushAll(), PUSHALL_EVERY);
			this.changed();
		});
		client.on("message", (_topic, buf) => {
			try {
				this.ingest(JSON.parse(buf.toString("utf8")));
			} catch {
				/* not JSON - ignore */
			}
		});
		client.on("error", (err: Error & { code?: number }) => {
			// MQTT CONNACK 4/5 = bad username/password / not authorised => wrong access code
			const auth = err.code === 4 || err.code === 5 || /not authori[sz]ed|bad user/i.test(err.message);
			this.offlineReason = auth ? "CHECK ACCESS CODE" : "CONNECTION ERROR";
			this.online = false;
			this.changed();
		});
		client.on("offline", () => {
			this.online = false;
			this.offlineReason ||= "NO CONNECTION";
			this.changed();
		});
		client.on("close", () => clearInterval(this.pushTimer));
	}

	close(): void {
		clearInterval(this.pushTimer);
		this.client?.end(true);
		this.client = undefined;
		this.removeAllListeners();
	}

	get connected(): boolean {
		return !!this.client?.connected;
	}

	pushAll(): boolean {
		return this.publish({ pushing: { sequence_id: String(Date.now()), command: "pushall" } });
	}

	snapshot(): Snapshot {
		const r = this.report;
		const base = {
			percent: 0,
			remaining: 0,
			finishAt: 0,
			layer: 0,
			totalLayers: 0,
			reason: "",
			temps: readTemps(r),
			ams: readAms(r),
			activeTray: readActiveTray(r),
		};
		if (!this.online) {
			const hasEverConnected = Object.keys(r).length > 0;
			const blank = { ...base, temps: {}, activeTray: -1 }; // keep the AMS colours, drop live values
			if (!this.offlineReason && !hasEverConnected) return { ...blank, state: "CONNECTING" };
			return { ...blank, state: "OFFLINE", reason: this.offlineReason || "NO CONNECTION" };
		}
		if (!r.gcode_state) return { ...base, state: "CONNECTING" };

		const percent = Math.max(0, Math.min(100, Number(r.mc_percent) || 0));
		const remaining = Math.max(0, Number(r.mc_remaining_time) || 0);
		const job = {
			...base,
			percent,
			remaining,
			finishAt: this.finishAt,
			layer: Number(r.layer_num) || 0,
			totalLayers: Number(r.total_layer_num) || 0,
		};
		const code = hexCode(r.print_error);
		const stage = Number(r.stg_cur ?? r.mc_print_sub_stage ?? 0);

		switch (String(r.gcode_state).toUpperCase()) {
			case "RUNNING":
				// Bed levelling, heating, etc. report RUNNING with 0% and a non-zero stage.
				return { ...job, state: percent <= 0 && stage > 0 && stage !== 255 ? "PREPARING" : "PRINTING" };
			case "PREPARE":
			case "SLICING":
			case "INIT":
				return { ...job, state: "PREPARING" };
			case "PAUSE":
			case "PAUSED":
			case "PAUSING":
				return { ...job, state: "PAUSED", reason: code ? `CODE ${code}` : "" };
			case "FINISH":
				return { ...job, state: "DONE", percent: 100, remaining: 0 };
			case "FAILED":
				if (CANCEL_CODES.includes(code)) return { ...base, state: "CANCELED" };
				return { ...job, state: "ERROR", reason: code ? `CODE ${code}` : "PRINT FAILED" };
			case "CANCEL":
			case "CANCELED":
			case "CANCELLED":
			case "ABORTED":
				return { ...base, state: "CANCELED" };
			default:
				return { ...base, state: "IDLE" };
		}
	}

	// ------------------------------------------------------------------ internals

	private publish(msg: object): boolean {
		if (!this.client?.connected) return false;
		this.client.publish(`device/${this.serial}/request`, JSON.stringify(msg));
		return true;
	}

	private ingest(msg: any): void {
		const p = msg?.print;
		if (!p || typeof p !== "object") return;
		// Most models only send what changed, so merge into a running copy.
		const prevRemaining = this.report.mc_remaining_time;
		this.report = merge(this.report, p);
		if (p.mc_remaining_time !== undefined && (p.mc_remaining_time !== prevRemaining || !this.finishAt)) {
			this.finishAt = Date.now() + (Number(p.mc_remaining_time) || 0) * 60_000;
		}
		this.changed();
	}

	private changed(): void {
		this.emit("update", this.snapshot());
	}
}

/** Keeps one Printer per ip|serial|code and closes it when no key uses it anymore. */
export class PrinterHub {
	private printers = new Map<string, Printer>();
	private users = new Map<string, string>(); // action id -> printer map key

	acquire(actionId: string, ip: string, serial: string, accessCode: string): Printer {
		const mapKey = `${ip}|${serial}|${accessCode}`;
		const prev = this.users.get(actionId);
		if (prev !== mapKey) {
			this.users.set(actionId, mapKey);
			if (prev) this.gc(prev);
		}
		let p = this.printers.get(mapKey);
		if (!p) {
			p = new Printer(ip, serial, accessCode);
			this.printers.set(mapKey, p);
			p.connect();
		}
		return p;
	}

	release(actionId: string): void {
		const prev = this.users.get(actionId);
		this.users.delete(actionId);
		if (prev) this.gc(prev);
	}

	closeAll(): void {
		for (const p of this.printers.values()) p.close();
		this.printers.clear();
		this.users.clear();
	}

	private gc(mapKey: string): void {
		if ([...this.users.values()].includes(mapKey)) return;
		this.printers.get(mapKey)?.close();
		this.printers.delete(mapKey);
	}
}

export const hub = new PrinterHub();
