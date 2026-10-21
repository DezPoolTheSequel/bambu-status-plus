import streamDeck from "@elgato/streamdeck";
import { PrinterStatus, setCredentials } from "./actions.js";
import { hub } from "./printer.js";
import type { GlobalSettings } from "./settings.js";

streamDeck.logger.setLevel("info");
// Works on Stream Deck 6.x and 7.x.
streamDeck.settings.useLegacySettingsBehavior = true;
streamDeck.actions.registerAction(new PrinterStatus());

// Access codes live in global settings (keyed by ip|serial) so they never end up in exported profiles.
streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((ev) => setCredentials(ev.settings));
await streamDeck.connect();
setCredentials(await streamDeck.settings.getGlobalSettings<GlobalSettings>());

for (const sig of ["SIGINT", "SIGTERM", "exit"] as const) process.on(sig, () => hub.closeAll());
