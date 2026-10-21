# Bambu Status Plus

A Stream Deck plugin that shows the live status of your **Bambu Lab printers** over your local
network. A progress bar runs around the border of the key and fills as the print goes. **Press the
key to flip between pages:** Status, AMS (each unit in turn) and Temperature. On the Status page,
**you choose what's shown big in the middle and what's shown small underneath**.

It works like the [Bambu Status](https://marketplace.elgato.com/product/bambu-status-be7c7058-2453-4993-8b00-9d68f224e1bb)
plugin, which always puts the percentage in the middle and the time left below it. This one lets you
swap them, or pick something else.

## Features

- **Pages.** Tick which ones you want: **Status**, **AMS**, **Temperature**. Each press goes to
  the next page: Status → AMS 1 → AMS 2 → … → Temperature → Status. The progress border stays on
  every page.
- **Status page:** big (centre) and small (bottom) slots. Each one can show:
  - percent complete (`93%`)
  - time remaining (`3h 19m`, `11 min`, or `3:19`)
  - finish time (`7:45 PM` or `19:45`)
  - layer (`61/190`)
  - nothing

  There's a **swap** button in the settings and an option to hide the state line, which makes the
  big value bigger.
- **AMS page:** a 2×2 grid of numbered slots in the filament colour, labelled with the material.
  Or choose remaining %, and the colour fills each slot up to what's left. It also shows the slot
  that's feeding right now, plus humidity and temperature. Supports AMS, AMS 2 Pro, AMS HT and AMS
  lite, and the heading shows which unit you're on (`AMS 1/2`).
- **Temperature page:** nozzle, bed and chamber temperatures, with the target temperature in
  orange while heating. Shown in °C or °F. Works with H2-series printers, which report temperatures differently
  from older models.
- **Colours change with the state:** printing, preparing, paused, done, idle, cancelled, error,
  offline. When something is wrong, the bottom line says what (`CHECK ACCESS CODE`,
  `CODE 0300400D`, …).
- **Stream Deck +** dials show the Status page. Push or tap to refresh.
- One connection per printer, shared by every key that shows it.
- Access codes are stored in the plugin's global settings, not in the key, so they are never
  included in an exported profile.

## Setup

On the printer's screen, find these settings:

- **IP address** and **LAN access code**: Settings → Network (WLAN)
- **Serial number**: Settings → Device

Enter them in the key's settings, along with a **Printer name** (for example `H2S`) to show on the
key. Leave Stream Deck's own **Title** field blank, because the key draws the name itself.

## Requirements

- Stream Deck 6.6+
- Windows 10+ or macOS 12+
- A Bambu Lab printer on the same network as the PC (X1, P1, P2S, A1, H2D, H2S, …)
- [Node.js](https://nodejs.org/) 20+ (only for building from source)

## Install (prebuilt)

Download `com.dez.bambustatus.streamDeckPlugin` from the
[latest release](https://github.com/DezPoolTheSequel/bambu-status-plus/releases/latest) and
double-click it. The actions are listed under **Bambu Status Plus**.

It uses a different ID from the original Bambu Status plugin, so you can keep both installed while
you switch over.

## Build from source

```sh
git clone https://github.com/DezPoolTheSequel/bambu-status-plus.git
cd bambu-status-plus
npm install
npm run build
npx streamdeck dev
npx streamdeck link com.dez.bambustatus.sdPlugin
```

> If you already installed the packaged `.streamDeckPlugin`, uninstall it in Stream Deck first.
> The linked dev copy and the installed copy share the same UUID.

| Script | What it does |
| --- | --- |
| `npm run build` | Bundle `src/` into `com.dez.bambustatus.sdPlugin/bin/plugin.js` |
| `npm run watch` | Rebuild when a file is saved and restart the plugin |
| `npm run typecheck` | TypeScript check |
| `npm run pack` | Build and package `dist/com.dez.bambustatus.streamDeckPlugin` |
| `npm run icons` | Regenerate the PNG icons |
| `npm run test:render` | Run the plugin against a fake Stream Deck and fake printers, and render every key state to `tools/out/` |

## How it works

- `src/printer.ts`: the MQTT connection to each printer (`mqtts://<ip>:8883`, user `bblp`,
  password = access code). It subscribes to `device/<serial>/report` and merges the partial reports
  the printer sends into one state. It asks for a full report when it connects and then every
  5 minutes.
- `src/render.ts`: draws each page as a 144×144 SVG, including the progress border, the big and
  small slots, the AMS slots and the temperature rows. It also builds the Stream Deck + touch strip feedback.
- `src/actions.ts`: the key action, page cycling, the shared credentials and the settings-panel
  status line.
- `com.dez.bambustatus.sdPlugin/ui/printer.html`: the settings panel (plain HTML/JS).
- `com.dez.bambustatus.sdPlugin/layouts/status.json`: the Stream Deck + touch strip layout.

## Troubleshooting

- **`CHECK ACCESS CODE`**: the printer rejected the code. The code changes if you toggle LAN mode
  or reset the printer.
- **`NO CONNECTION`**: check the IP address. Give the printer a DHCP reservation so the address
  doesn't change. On recent firmware, LAN access may also need to be enabled in the printer's
  network settings.

## License

Do whatever you want with it.
