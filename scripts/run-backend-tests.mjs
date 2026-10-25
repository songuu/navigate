import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directories = ["news-collector/__tests__", "scripts/content-api", "src/shared/llm"];
const files = directories.flatMap((directory) =>
  readdirSync(resolve(root, directory))
    .filter((file) => file.endsWith(".test.mts") || file.endsWith(".test.mjs"))
    .map((file) => `${directory}/${file}`),
);
const result = spawnSync(process.execPath, ["--experimental-transform-types", "--test", ...files], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, NODE_ENV: "test" },
});
if (result.error) throw new Error(`Cannot start backend tests: ${result.error.message}`);
process.exitCode = result.status ?? 1;
