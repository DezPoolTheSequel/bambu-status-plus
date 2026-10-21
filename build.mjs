// Bundles src/ into the .sdPlugin. `node build.mjs --watch` rebuilds on save and restarts the plugin.
import { context } from "esbuild";
import { exec } from "node:child_process";
import fs from "node:fs";

const UUID = "com.dez.bambustatus";
const watch = process.argv.includes("--watch");

const restart = {
  name: "restart-plugin",
  setup(build) {
    build.onEnd((r) => {
      if (!watch || r.errors.length) return;
      exec(`npx streamdeck restart ${UUID}`, (err) => console.log(err ? "restart failed (is Stream Deck running?)" : "plugin restarted"));
    });
  },
};

const ctx = await context({
  entryPoints: ["src/plugin.ts"],
  outfile: `${UUID}.sdPlugin/bin/plugin.js`,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  sourcemap: "linked",
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  plugins: [restart],
  logLevel: "info",
});
fs.mkdirSync(`${UUID}.sdPlugin/bin`, { recursive: true });
fs.writeFileSync(`${UUID}.sdPlugin/bin/package.json`, '{ "type": "module" }\n');

if (watch) await ctx.watch();
else {
  await ctx.rebuild();
  await ctx.dispose();
}
