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
	lights: Record<string, "on" | "off">;
}

/** Port is only overridable so the test harness can point the plugin at a local fake printer. */
const PORT = Number(process.env.BAMBU_MQTT_PORT) || 8883;
const PUSHALL_EVERY = 5 * 60_000; // Bambu asks clients not to request full reports more often than this

const CANCEL_CODES = ["0300400C", "0500400E"];

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
	private lights: Record<string, "on" | "off"> = {};
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

	setLight(node: string, on: boolean): boolean {
		const ok = this.publish({
			system: {
				sequence_id: String(Date.now()),
				command: "ledctrl",
				led_node: node,
				led_mode: on ? "on" : "off",
				led_on_time: 500,
				led_off_time: 500,
				loop_times: 0,
				interval_time: 0,
			},
		});
		if (ok) {
			// Show the change immediately; the printer's next report confirms it.
			this.lights[node] = on ? "on" : "off";
			this.changed();
			setTimeout(() => this.pushAll(), 800);
		}
		return ok;
	}

	snapshot(): Snapshot {
		const r = this.report;
		const base = { percent: 0, remaining: 0, finishAt: 0, layer: 0, totalLayers: 0, reason: "", lights: { ...this.lights } };
		if (!this.online) {
			const hasEverConnected = Object.keys(r).length > 0;
			if (!this.offlineReason && !hasEverConnected) return { ...base, state: "CONNECTING" };
			return { ...base, state: "OFFLINE", reason: this.offlineReason || "NO CONNECTION" };
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
		this.report = { ...this.report, ...p };
		if (p.mc_remaining_time !== undefined && (p.mc_remaining_time !== prevRemaining || !this.finishAt)) {
			this.finishAt = Date.now() + (Number(p.mc_remaining_time) || 0) * 60_000;
		}
		const lights = p.lights_report;
		if (Array.isArray(lights)) {
			for (const l of lights) {
				const node = String(l?.node ?? "").toLowerCase();
				const mode = String(l?.mode ?? "").toLowerCase();
				if (node && (mode === "on" || mode === "off")) this.lights[node] = mode;
			}
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
