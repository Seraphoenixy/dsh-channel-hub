/**
 * Development loop: rebuild `dist/` when sources change.
 *
 * The running plugin watches `dist/index.js` and `dist/ledger-worker.js` (see
 * src/reload.ts), so a successful build is swapped in without restarting DSH.
 * This script only produces the build; it never touches the profile install.
 *
 * Usage: npm run dev
 */

import { watch } from "node:fs";
import { spawn } from "node:child_process";

const roots = ["src", "vendor"];
let timer;
let building = false;
let pending = false;

function build() {
  if (building) {
    pending = true;
    return;
  }
  building = true;
  const child = spawn(process.execPath, ["scripts/build.mjs"], {
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code, signal) => {
    building = false;
    if (code === 0) {
      console.log(`[dev] built at ${new Date().toLocaleTimeString("zh-CN")}`);
    } else {
      console.error(`[dev] build failed (code ${code ?? signal})`);
    }
    if (pending) {
      pending = false;
      schedule();
    }
  });
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(build, 200);
}

for (const root of roots) {
  try {
    const watcher = watch(root, { recursive: true }, (_event, file) => {
      if (file === null || file.endsWith(".map")) return;
      schedule();
    });
    watcher.on("error", (error) => {
      console.error(`[dev] watcher error on ${root}: ${error.message}`);
    });
  } catch (error) {
    console.error(`[dev] cannot watch ${root}: ${error.message}`);
  }
}

console.log("[dev] watching src/ and vendor/; the plugin will hot-reload dist/");
build();
