import { npm } from "./npm.mjs";
import assert from "node:assert/strict";
const result = npm(["pack", "--dry-run", "--json", "--ignore-scripts"], {
  encoding: "utf8",
});
if (result.status !== 0) {
  console.error(result.stderr);
  process.exit(1);
}
const pack = JSON.parse(result.stdout)[0];
const files = new Set(pack.files.map((f) => f.path));
for (const required of [
  "dist/index.js",
  "dist/client.js",
  "dist/ledger-worker.js",
  "dist/qoder-auth-wasm.wasm",
  "cordis.patch.yml",
  "LICENSE",
])
  assert.ok(files.has(required), "Missing " + required);
for (const file of files)
  assert.ok(
    !/node_modules|\.sqlite|connect-auth|session\.json/.test(file),
    "Unexpected private/runtime file " + file,
  );
for (const gone of ["NOTICE.md"])
  assert.ok(!files.has(gone), "Third-party notice must not ship: " + gone);
console.log(
  "Package verified: " +
    pack.files.length +
    " files, " +
    pack.size +
    " compressed bytes",
);
