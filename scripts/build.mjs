import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  sourcemap: process.env.CHANNEL_HUB_SOURCEMAPS === "1",
});
await build({
  entryPoints: ["src/storage/worker.ts"],
  outfile: "dist/ledger-worker.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  sourcemap: process.env.CHANNEL_HUB_SOURCEMAPS === "1",
});
await build({
  entryPoints: ["src/client.ts"],
  outfile: "dist/client.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
});

await copyFile(
  "vendor/ofm/src/qoder-auth-wasm.wasm",
  "dist/qoder-auth-wasm.wasm",
);
