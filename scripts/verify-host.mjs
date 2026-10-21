import { spawnSync } from "node:child_process";
for (const name of [
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-credentials",
  "@deepseek-ai/dsh-llm",
  "@deepseek-ai/schemastery",
]) {
  try {
    await import(name);
  } catch {
    console.error(
      "缺少真实宿主依赖 " +
        name +
        "；运行 node scripts/extract-host.mjs 后重试。",
    );
    process.exit(2);
  }
}
const result = spawnSync(
  process.execPath,
  ["--test", "tests/host.test.mjs", "tests/gemini-signature-host.test.mjs"],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
