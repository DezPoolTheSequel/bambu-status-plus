import streamDeck, {
	action,
	type DialAction,
	type DialDownEvent,
	type DidReceiveSettingsEvent,
	type KeyAction,
	type KeyDownEvent,
	type PropertyInspectorDidAppearEvent,
	type SendToPluginEvent,
	SingletonAction,
	type TitleParametersDidChangeEvent,
	type TouchTapEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject, JsonValue } from "@elgato/utils";
import { hub, type Printer, type Snapshot } from "./printer.js";
import { dialFeedback, renderLight, renderStatus, toDataUrl } from "./render.js";
import { printerKey, resolveSettings, type ActionSettings, type GlobalSettings } from "./settings.js";

const log = () => streamDeck.logger.createScope("bambu");

// ---------------------------------------------------------------- shared credentials

let credentials: Record<string, string> = {};
const credentialListeners = new Set<() => void>();

export function setCredentials(g: Partial<GlobalSettings> | undefined): void {
	const next = g?.credentials && typeof g.credentials === "object" ? { ...g.credentials } : {};
	if (JSON.stringify(next) === JSON.stringify(credentials)) return;
	credentials = next;
	for (const fn of credentialListeners) fn();
}

const codeFor = (s: ActionSettings) => String(credentials[printerKey(s)] ?? "").trim();

// ---------------------------------------------------------------- base action

interface Instance {
	action: KeyAction<JsonObject> | DialAction<JsonObject>;
	settings: ActionSettings;
	label: string;
	showLabel: boolean;
	printer?: Printer;
	listener?: (snap: Snapshot) => void;
	lastImage?: string;
	lastFeedback?: string;
	lastLightPress?: number;
}

const NOT_SET_UP: Snapshot = { state: "OFFLINE", percent: 0, remaining: 0, finishAt: 0, layer: 0, totalLayers: 0, reason: "SETTINGS REQUIRED", lights: {} };

abstract class BambuAction extends SingletonAction<JsonObject> {
	protected items = new Map<string, Instance>();
	private piActionId?: string;
	protected abstract readonly fallbackLabel: string;

	constructor() {
		super();
		credentialListeners.add(() => {
			for (const it of this.items.values()) this.attach(it);
		});
	}

	protected abstract draw(it: Instance, snap: Snapshot): Promise<void>;
	protected abstract press(it: Instance): Promise<void>;

	override async onWillAppear(ev: WillAppearEvent<JsonObject>): Promise<void> {
		const it: Instance = {
			action: ev.action as Instance["action"],
			settings: resolveSettings(ev.payload.settings),
			label: this.fallbackLabel,
			showLabel: true,
		};
		this.items.set(ev.action.id, it);
		if (ev.action.isKey()) await ev.action.setTitle("");
		this.attach(it);
	}

	override onWillDisappear(ev: WillDisappearEvent<JsonObject>): void {
		const it = this.items.get(ev.action.id);
		if (!it) return;
		this.detach(it);
		hub.release(ev.action.id);
		this.items.delete(ev.action.id);
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<JsonObject>): void {
		const it = this.items.get(ev.action.id);
		if (!it) return;
		it.settings = resolveSettings(ev.payload.settings);
		this.attach(it);
	}

	override async onTitleParametersDidChange(ev: TitleParametersDidChangeEvent<JsonObject>): Promise<void> {
		const it = this.items.get(ev.action.id);
		if (!it) return;
		// The title is drawn inside the image (top-left, in the state colour), so hide Stream Deck's own.
		it.label = String(ev.payload.title ?? "").trim() || this.fallbackLabel;
		it.showLabel = ev.payload.titleParameters?.showTitle !== false;
		if (ev.action.isKey() && ev.payload.title) await ev.action.setTitle("");
		await this.redraw(it);
	}

	override async onKeyDown(ev: KeyDownEvent<JsonObject>): Promise<void> {
		const it = this.items.get(ev.action.id);
		if (it) await this.press(it);
	}

	override async onDialDown(ev: DialDownEvent<JsonObject>): Promise<void> {
		const it = this.items.get(ev.action.id);
		if (it) await this.press(it);
	}

	override async onTouchTap(ev: TouchTapEvent<JsonObject>): Promise<void> {
		const it = this.items.get(ev.action.id);
		if (it) await this.press(it);
	}

	override onPropertyInspectorDidAppear(ev: PropertyInspectorDidAppearEvent<JsonObject>): void {
		this.piActionId = ev.action.id;
	}

	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, JsonObject>): Promise<void> {
		const msg = (ev.payload ?? {}) as { cmd?: string };
		if (msg.cmd === "status") {
			this.piActionId = ev.action.id;
			const it = this.items.get(ev.action.id);
			if (it) await this.sendStatus(it, this.snapshot(it));
		}
	}

	// ------------------------------------------------------------------ internals

	/** (Re)connect this key to the right printer for its current settings + credentials. */
	protected attach(it: Instance): void {
		const code = codeFor(it.settings);
		const ready = !!(printerKey(it.settings) && code);
		const p = ready ? hub.acquire(it.action.id, it.settings.ip, it.settings.serial, code) : undefined;
		if (p !== it.printer) {
			this.detach(it);
			if (!p) hub.release(it.action.id);
			it.printer = p;
			if (p) {
				it.listener = (snap) => void this.update(it, snap);
				p.on("update", it.listener);
				p.pushAll();
			}
		}
		void this.redraw(it);
	}

	private detach(it: Instance): void {
		if (it.printer && it.listener) it.printer.off("update", it.listener);
		it.printer = undefined;
		it.listener = undefined;
	}

	protected snapshot(it: Instance): Snapshot {
		if (!it.printer) {
			const missing = !it.settings.ip || !it.settings.serial ? "SETTINGS REQUIRED" : "ACCESS CODE REQUIRED";
			return { ...NOT_SET_UP, reason: missing };
		}
		return it.printer.snapshot();
	}

	protected redraw(it: Instance): Promise<void> {
		return this.update(it, this.snapshot(it));
	}

	private async update(it: Instance, snap: Snapshot): Promise<void> {
		if (!this.items.has(it.action.id)) return;
		try {
			await this.draw(it, snap);
		} catch (e) {
			log().warn(`draw failed: ${(e as Error).message}`);
		}
		await this.sendStatus(it, snap);
	}

	protected async setImage(it: Instance, svg: string): Promise<void> {
		if (!it.action.isKey()) return;
		const img = toDataUrl(svg);
		if (img === it.lastImage) return;
		it.lastImage = img;
		await it.action.setImage(img);
	}

	protected async setFeedback(it: Instance, fb: Record<string, unknown>): Promise<void> {
		if (!it.action.isDial()) return;
		const json = JSON.stringify(fb);
		if (json === it.lastFeedback) return;
		it.lastFeedback = json;
		await it.action.setFeedback(fb as Parameters<DialAction<JsonObject>["setFeedback"]>[0]);
	}

	protected lightMode(it: Instance, snap: Snapshot): "on" | "off" | "unknown" {
		return snap.lights[it.settings.ledNode.toLowerCase()] ?? "unknown";
	}

	protected async toggleLight(it: Instance): Promise<void> {
		const now = Date.now();
		if (now - (it.lastLightPress ?? 0) < 900) return; // ignore double taps while the printer catches up
		it.lastLightPress = now;
		const p = it.printer;
		if (!p?.connected) {
			await it.action.showAlert();
			return;
		}
		const on = this.lightMode(it, p.snapshot()) !== "on";
		if (!p.setLight(it.settings.ledNode, on)) await it.action.showAlert();
	}

	private async sendStatus(it: Instance, snap: Snapshot): Promise<void> {
		if (this.piActionId !== it.action.id) return;
		const ok = snap.state !== "OFFLINE" && snap.state !== "CONNECTING";
		let status: string;
		if (snap.state === "CONNECTING") status = `Connecting to ${it.settings.ip}…`;
		else if (!ok) status = `Not connected — ${snap.reason.toLowerCase()}`;
		else {
			const light = this.lightMode(it, snap);
			status = `Connected — ${snap.state.toLowerCase()}${snap.percent && snap.state !== "IDLE" ? ` ${Math.round(snap.percent)}%` : ""}${light !== "unknown" ? `, light ${light}` : ""}`;
		}
		try {
			await streamDeck.ui.sendToPropertyInspector({ event: "status", ok, status });
		} catch {
			/* PI closed */
		}
	}
}

// ---------------------------------------------------------------- the three actions

@action({ UUID: "com.dez.bambustatus.status" })
export class PrinterStatus extends BambuAction {
	protected readonly fallbackLabel = "BAMBU";

	protected async draw(it: Instance, snap: Snapshot): Promise<void> {
		await this.setImage(it, renderStatus(snap, it.settings, { label: it.label, showLabel: it.showLabel }));
		await this.setFeedback(it, dialFeedback(snap, it.settings, it.label));
	}

	protected async press(it: Instance): Promise<void> {
		if (it.settings.press === "swap" && it.settings.small !== "none") {
			const raw = { ...it.settings, big: it.settings.small, small: it.settings.big };
			it.settings = resolveSettings(raw);
			await it.action.setSettings(raw as JsonObject);
			await this.redraw(it);
			return;
		}
		if (!it.printer?.pushAll()) await it.action.showAlert();
	}
}

@action({ UUID: "com.dez.bambustatus.statuslight" })
export class PrinterStatusLight extends BambuAction {
	protected readonly fallbackLabel = "BAMBU";

	protected async draw(it: Instance, snap: Snapshot): Promise<void> {
		const light = this.lightMode(it, snap) === "on" ? "on" : "off";
		await this.setImage(it, renderStatus(snap, it.settings, { label: it.label, showLabel: it.showLabel, light }));
		await this.setFeedback(it, dialFeedback(snap, it.settings, it.label, light));
	}

	protected press(it: Instance): Promise<void> {
		return this.toggleLight(it);
	}
}

@action({ UUID: "com.dez.bambustatus.light" })
export class PrinterLight extends BambuAction {
	protected readonly fallbackLabel = "LIGHT";

	protected async draw(it: Instance, snap: Snapshot): Promise<void> {
		const offline = snap.state === "OFFLINE" || snap.state === "CONNECTING";
		await this.setImage(it, renderLight(this.lightMode(it, snap), it.label, it.showLabel, offline));
	}

	protected press(it: Instance): Promise<void> {
		return this.toggleLight(it);
	}
}
