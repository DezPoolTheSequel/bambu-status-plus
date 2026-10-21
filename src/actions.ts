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
import { dialFeedback, renderAms, renderStatus, renderTemps, toDataUrl } from "./render.js";
import { pagesFor, printerKey, resolveSettings, type ActionSettings, type GlobalSettings, type Page } from "./settings.js";

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

// ---------------------------------------------------------------- action

interface Instance {
	action: KeyAction<JsonObject> | DialAction<JsonObject>;
	settings: ActionSettings;
	label: string;
	showLabel: boolean;
	printer?: Printer;
	listener?: (snap: Snapshot) => void;
	page: Page;
	amsIndex: number;
	lastImage?: string;
	lastFeedback?: string;
}

const NOT_SET_UP: Snapshot = {
	state: "OFFLINE",
	percent: 0,
	remaining: 0,
	finishAt: 0,
	layer: 0,
	totalLayers: 0,
	reason: "SETTINGS REQUIRED",
	temps: {},
	ams: [],
	activeTray: -1,
};

@action({ UUID: "com.dez.bambustatus.status" })
export class PrinterStatus extends SingletonAction<JsonObject> {
	private items = new Map<string, Instance>();
	private piActionId?: string;

	constructor() {
		super();
		credentialListeners.add(() => {
			for (const it of this.items.values()) this.attach(it);
		});
	}

	override async onWillAppear(ev: WillAppearEvent<JsonObject>): Promise<void> {
		const settings = resolveSettings(ev.payload.settings);
		const it: Instance = {
			action: ev.action as Instance["action"],
			settings,
			label: "BAMBU",
			showLabel: true,
			page: pagesFor(settings)[0],
			amsIndex: 0,
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
		const pages = pagesFor(it.settings);
		if (!pages.includes(it.page)) {
			it.page = pages[0];
			it.amsIndex = 0;
		}
		this.attach(it);
	}

	override async onTitleParametersDidChange(ev: TitleParametersDidChangeEvent<JsonObject>): Promise<void> {
		const it = this.items.get(ev.action.id);
		if (!it) return;
		// The title is drawn inside the image (top-left, in the state colour), so hide Stream Deck's own.
		it.label = String(ev.payload.title ?? "").trim() || "BAMBU";
		it.showLabel = ev.payload.titleParameters?.showTitle !== false;
		if (ev.action.isKey() && ev.payload.title) await ev.action.setTitle("");
		await this.redraw(it);
	}

	override async onKeyDown(ev: KeyDownEvent<JsonObject>): Promise<void> {
		const it = this.items.get(ev.action.id);
		if (it) await this.nextPage(it);
	}

	override async onDialDown(ev: DialDownEvent<JsonObject>): Promise<void> {
		const it = this.items.get(ev.action.id);
		if (it) await this.refresh(it);
	}

	override async onTouchTap(ev: TouchTapEvent<JsonObject>): Promise<void> {
		const it = this.items.get(ev.action.id);
		if (it) await this.refresh(it);
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

	// ------------------------------------------------------------------ pages

	/** Status → AMS 1 → AMS 2 → … → Temperature → Status, skipping pages that are switched off. */
	private async nextPage(it: Instance): Promise<void> {
		const pages = pagesFor(it.settings);
		const units = this.snapshot(it).ams.length;
		if (it.page === "ams" && it.amsIndex < units - 1) {
			it.amsIndex++;
		} else if (pages.length > 1) {
			it.page = pages[(pages.indexOf(it.page) + 1) % pages.length];
			it.amsIndex = 0;
		} else {
			// Only one screen and nothing to cycle: a press just asks the printer for fresh data.
			it.amsIndex = 0;
			await this.refresh(it);
		}
		await this.redraw(it);
	}

	private async refresh(it: Instance): Promise<void> {
		if (!it.printer?.pushAll()) await it.action.showAlert();
	}

	// ------------------------------------------------------------------ internals

	/** (Re)connect this key to the right printer for its current settings + credentials. */
	private attach(it: Instance): void {
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

	private snapshot(it: Instance): Snapshot {
		if (!it.printer) {
			const missing = !it.settings.ip || !it.settings.serial ? "SETTINGS REQUIRED" : "ACCESS CODE REQUIRED";
			return { ...NOT_SET_UP, reason: missing };
		}
		return it.printer.snapshot();
	}

	private redraw(it: Instance): Promise<void> {
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

	private async draw(it: Instance, snap: Snapshot): Promise<void> {
		const view = { label: it.label, showLabel: it.showLabel };
		if (it.action.isKey()) {
			if (it.amsIndex >= snap.ams.length) it.amsIndex = 0; // a unit went away
			const svg =
				it.page === "ams"
					? renderAms(snap, it.settings, view, it.amsIndex)
					: it.page === "temps"
						? renderTemps(snap, it.settings, view)
						: renderStatus(snap, it.settings, view);
			const img = toDataUrl(svg);
			if (img === it.lastImage) return;
			it.lastImage = img;
			await it.action.setImage(img);
		} else if (it.action.isDial()) {
			const fb = dialFeedback(snap, it.settings, it.label);
			const json = JSON.stringify(fb);
			if (json === it.lastFeedback) return;
			it.lastFeedback = json;
			await it.action.setFeedback(fb as Parameters<DialAction<JsonObject>["setFeedback"]>[0]);
		}
	}

	private async sendStatus(it: Instance, snap: Snapshot): Promise<void> {
		if (this.piActionId !== it.action.id) return;
		const ok = snap.state !== "OFFLINE" && snap.state !== "CONNECTING";
		let status: string;
		if (snap.state === "CONNECTING") status = `Connecting to ${it.settings.ip}…`;
		else if (!ok) status = `Not connected — ${snap.reason.toLowerCase()}`;
		else {
			const ams = snap.ams.length ? `, ${snap.ams.length} AMS unit${snap.ams.length > 1 ? "s" : ""}` : "";
			status = `Connected — ${snap.state.toLowerCase()}${snap.percent && snap.state !== "IDLE" ? ` ${Math.round(snap.percent)}%` : ""}${ams}`;
		}
		try {
			await streamDeck.ui.sendToPropertyInspector({ event: "status", ok, status });
		} catch {
			/* PI closed */
		}
	}
}
