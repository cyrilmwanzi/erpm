import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distRoot = resolve(__dirname, "../dist");
mkdirSync(resolve(distRoot, "esm"), { recursive: true });
mkdirSync(resolve(distRoot, "cjs"), { recursive: true });

writeFileSync(
  resolve(distRoot, "esm/package.json"),
  JSON.stringify({ type: "module" }, null, 2) + "\n",
);
writeFileSync(
  resolve(distRoot, "cjs/package.json"),
  JSON.stringify({ type: "commonjs" }, null, 2) + "\n",
);
