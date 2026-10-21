import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
export function npm(args, options = {}) {
  const cli =
    process.env.npm_execpath ??
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  return spawnSync(process.execPath, [cli, ...args], options);
}
