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
  // 样式以**字符串**内联（见 src/assets.d.ts 的说明）：若交给 esbuild 默认
  // 的 CSS 处理，`import css from "./client.css"` 会被抽成独立样式资源、
  // 默认导出一个空对象，页面就变成无样式。`text` loader 保证拿到原文。
  loader: { ".css": "text" },
});

await copyFile(
  "vendor/ofm/src/qoder-auth-wasm.wasm",
  "dist/qoder-auth-wasm.wasm",
);
