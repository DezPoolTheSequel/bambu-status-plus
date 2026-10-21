// Fake Stream Deck app + fake Bambu printers (MQTT over TLS): launches the plugin, renders every scenario
// to tools/out/*.png and a contact sheet tools/out/sheet.png.
import { WebSocketServer } from "ws";
import { spawn } from "node:child_process";
import fs from "node:fs";
import tls from "node:tls";
import { Aedes } from "aedes";
import { generate } from "selfsigned";
import { Resvg } from "@resvg/resvg-js";

const SD_PORT = 28124;
const MQTT_PORT = 18883;
const CODE = "12345678";
const STATUS = "com.dez.bambustatus.status";
const STATUSLIGHT = "com.dez.bambustatus.statuslight";
const LIGHT = "com.dez.bambustatus.light";
const mins = (m) => m;

// ---------------------------------------------------------------- fake printers (one serial per scenario)
const printers = {
	P93: { gcode_state: "RUNNING", mc_percent: 93, mc_remaining_time: mins(11), layer_num: 220, total_layer_num: 236, stg_cur: 0 },
	P32: { gcode_state: "RUNNING", mc_percent: 32, mc_remaining_time: mins(199), layer_num: 61, total_layer_num: 190, stg_cur: 0 },
	PAUSE: { gcode_state: "PAUSE", mc_percent: 57, mc_remaining_time: 48, layer_num: 80, total_layer_num: 140 },
	DONE: { gcode_state: "FINISH", mc_percent: 100, mc_remaining_time: 0, layer_num: 140, total_layer_num: 140 },
	PREP: { gcode_state: "RUNNING", mc_percent: 0, mc_remaining_time: 95, stg_cur: 2 },
	FAIL: { gcode_state: "FAILED", mc_percent: 12, print_error: 50348044 + 1 }, // 0x0300400D
	IDLE: { gcode_state: "IDLE", mc_percent: 0, mc_remaining_time: 0, lights_report: [{ node: "chamber_light", mode: "off" }] },
	LIT: { gcode_state: "RUNNING", mc_percent: 64, mc_remaining_time: 75, lights_report: [{ node: "chamber_light", mode: "on" }] },
};

const scenarios = [
	// [name, action, serial, settings, title, controller]
	["01-percent-big", STATUS, "P93", {}, "H2S"],
	["02-time-big", STATUS, "P32", { big: "remaining", small: "percent" }, "H2S"],
	["03-finish-big", STATUS, "P32", { big: "finish", small: "percent" }, "P2S"],
	["04-layer-big", STATUS, "P32", { big: "layer", small: "finish" }, "P2S"],
	["05-no-state-time", STATUS, "P32", { big: "remaining", small: "percent", showState: false }, "H2S"],
	["06-colon-time", STATUS, "P32", { big: "remaining", small: "finish", timeFormat: "colon", clock: "24" }, "X1C"],
	["07-paused", STATUS, "PAUSE", { big: "remaining", small: "percent" }, "P1S"],
	["08-done", STATUS, "DONE", {}, "A1"],
	["09-preparing", STATUS, "PREP", { big: "remaining" }, "H2D"],
	["10-error", STATUS, "FAIL", {}, "X1C"],
	["11-idle", STATUS, "IDLE", {}, "H2S"],
	["12-status-light", STATUSLIGHT, "LIT", { big: "remaining", small: "percent" }, "H2S"],
	["13-light-toggle", LIGHT, "IDLE", {}, "H2S"],
	["14-bad-code", STATUS, "P93", { _badCode: true }, "H2S"],
	["15-no-settings", STATUS, "", {}, ""],
	["16-dial", STATUS, "P32", { big: "remaining", small: "percent" }, "H2S", "Encoder"],
];

const credentials = {};
for (const [, , serial, s] of scenarios) if (serial) credentials[`127.0.0.1|${serial}`] = CODE;
credentials["127.0.0.2|P93"] = "wrong";

const broker = await Aedes.createBroker({
	authenticate: (_c, user, pass, done) => {
		const ok = user === "bblp" && String(pass) === CODE;
		const err = ok ? null : Object.assign(new Error("Not authorized"), { returnCode: 5 });
		done(err, ok);
	},
});
const pub = (serial, print) =>
	broker.publish({ cmd: "publish", topic: `device/${serial}/report`, payload: Buffer.from(JSON.stringify({ print })), qos: 0, dup: false, retain: false }, () => {});
broker.on("publish", (packet, client) => {
	if (!client) return;
	const m = packet.topic.match(/^device\/(.+)\/request$/);
	if (!m) return;
	const serial = m[1];
	const msg = JSON.parse(packet.payload.toString());
	if (msg.pushing?.command === "pushall") pub(serial, printers[serial] ?? {});
	if (msg.system?.command === "ledctrl") {
		printers[serial].lights_report = [{ node: msg.system.led_node, mode: msg.system.led_mode }];
		ledCommands.push(`${serial}:${msg.system.led_node}=${msg.system.led_mode}`);
		pub(serial, { lights_report: printers[serial].lights_report });
	}
});
const ledCommands = [];
const pems = await generate([{ name: "commonName", value: "fake-bambu" }]);
const mqttServer = tls.createServer({ key: pems.private, cert: pems.cert }, broker.handle).listen(MQTT_PORT);

// ---------------------------------------------------------------- fake Stream Deck
const wss = new WebSocketServer({ port: SD_PORT });
const images = {};
const feedback = {};
const toPI = [];
let sock;
const send = (o) => sock.send(JSON.stringify(o));

wss.on("connection", (ws) => {
	sock = ws;
	ws.on("message", (raw) => {
		const m = JSON.parse(raw);
		if (m.event === "registerPlugin") {
			setTimeout(start, 200);
		} else if (m.event === "getGlobalSettings") {
			send({ event: "didReceiveGlobalSettings", payload: { settings: { credentials } } });
		} else if (m.event === "setImage") {
			images[m.context] = m.payload.image;
		} else if (m.event === "setFeedback") {
			feedback[m.context] = { ...(feedback[m.context] ?? {}), ...m.payload };
		} else if (m.event === "sendToPropertyInspector") {
			toPI.push(m.payload);
		} else if (m.event === "setSettings") {
			const sc = scenarios.find(([n]) => n === m.context);
			if (sc) sc[3] = m.payload;
		}
	});
});

function start() {
	for (const [name, action, serial, settings, title, controller = "Keypad"] of scenarios) {
		const ip = settings._badCode ? "127.0.0.2" : serial ? "127.0.0.1" : "";
		const s = { ...settings, ip, serial };
		delete s._badCode;
		const payload = { controller, coordinates: { column: 0, row: 0 }, isInMultiAction: false, settings: s };
		send({ action, event: "willAppear", context: name, device: "dev1", payload });
		if (title)
			send({ action, event: "titleParametersDidChange", context: name, device: "dev1",
				payload: { ...payload, state: 0, title, titleParameters: { showTitle: true, fontFamily: "", fontSize: 12, fontStyle: "", fontUnderline: false, titleAlignment: "bottom", titleColor: "#ffffff" } } });
	}
	// press the light key (off -> on), then ask for PI status of the time-big key
	setTimeout(() => send({ action: LIGHT, event: "keyDown", context: "13-light-toggle", device: "dev1", payload: { settings: { ip: "127.0.0.1", serial: "IDLE" }, coordinates: { column: 0, row: 0 }, isInMultiAction: false } }), 2500);
	setTimeout(() => {
		send({ action: STATUS, event: "propertyInspectorDidAppear", context: "02-time-big", device: "dev1" });
		send({ action: STATUS, event: "sendToPlugin", context: "02-time-big", payload: { cmd: "status" } });
	}, 3000);
	setTimeout(finish, 4500);
}

const info = {
	application: { font: "x", language: "en", platform: "windows", platformVersion: "10", version: "6.9.0.0" },
	plugin: { uuid: "com.dez.bambustatus", version: "1.0.0.0" },
	devicePixelRatio: 2,
	colors: {},
	devices: [{ id: "dev1", name: "SD", size: { columns: 8, rows: 4 }, type: 7 }],
};
const child = spawn(process.execPath, ["bin/plugin.js", "-port", String(SD_PORT), "-pluginUUID", "u1", "-registerEvent", "registerPlugin", "-info", JSON.stringify(info)], {
	cwd: "com.dez.bambustatus.sdPlugin",
	stdio: "inherit",
	env: { ...process.env, BAMBU_MQTT_PORT: String(MQTT_PORT) },
});

function finish() {
	fs.mkdirSync("tools/out", { recursive: true });
	const cells = [];
	for (const [name] of scenarios) {
		const img = images[name];
		if (!img) continue;
		const svg = decodeURIComponent(img.replace(/^data:image\/svg\+xml;charset=utf8,/, ""));
		fs.writeFileSync(`tools/out/${name}.svg`, svg);
		fs.writeFileSync(`tools/out/${name}.png`, new Resvg(svg, { fitTo: { mode: "width", value: 144 }, font: { loadSystemFonts: true } }).render().asPng());
		cells.push([name, svg.replace(/id="bg"/g, `id="bg${cells.length}"`).replace(/url\(#bg\)/g, `url(#bg${cells.length})`)]);
	}
	const cols = 5;
	const rows = Math.ceil(cells.length / cols);
	const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * 160}" height="${rows * 172}"><rect width="100%" height="100%" fill="#222"/>${cells
		.map(([name, svg], i) => {
			const x = (i % cols) * 160 + 8;
			const y = Math.floor(i / cols) * 172 + 4;
			return `<svg x="${x}" y="${y}" width="144" height="144" viewBox="0 0 144 144">${svg.replace(/^<svg[^>]*>|<\/svg>$/g, "")}</svg><text x="${x + 72}" y="${y + 160}" fill="#bbb" font-family="Arial" font-size="11" text-anchor="middle">${name}</text>`;
		})
		.join("")}</svg>`;
	fs.writeFileSync("tools/out/sheet.png", new Resvg(sheet, { font: { loadSystemFonts: true } }).render().asPng());
	console.log("images:", cells.map(([n]) => n).join(", "));
	console.log("missing:", scenarios.map(([n]) => n).filter((n) => !images[n] && !feedback[n]).join(", ") || "none");
	console.log("dial feedback:", JSON.stringify(feedback["16-dial"]));
	console.log("LED commands:", ledCommands.join(", ") || "none");
	console.log("PI msgs:", JSON.stringify(toPI.slice(-2)));
	child.kill();
	wss.close();
	mqttServer.close();
	process.exit(0);
}
