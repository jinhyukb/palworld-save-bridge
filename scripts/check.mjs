import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
for (const root of ["src", "tests", "scripts"]) {
  async function check(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (e.isDirectory()) await check(path);
      else if (/\.(?:cjs|mjs|js)$/.test(e.name))
        execFileSync(process.execPath, ["--check", path], { stdio: "inherit" });
    }
  }
  await check(root);
}
console.log("All application and test JavaScript syntax checks passed.");
