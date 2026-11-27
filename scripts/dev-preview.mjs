import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const pnpmBin = path.join(rootDir, "node_modules/.bin/pnpm");

const apiPort = process.env.SCACE_API_PORT || "3001";
const docsPort = process.env.PORT || "3000";
const apiHost = process.env.SCACE_API_HOST || "127.0.0.1";
const apiUrl = `http://${apiHost}:${apiPort}`;

if (!fs.existsSync(path.join(rootDir, "apps/docs/src/generated/api-catalog.json"))) {
  const gen = spawn(pnpmBin, ["--filter", "@scace/docs", "docs:generate"], {
    cwd: rootDir,
    stdio: "inherit",
    env: process.env,
  });
  await new Promise((resolve, reject) => {
    gen.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`docs:generate exited with code ${code}`));
    });
  });
}

const apiProc = spawn(pnpmBin, ["--filter", "@scace/api", "dev"], {
  cwd: rootDir,
  stdio: "inherit",
  env: {
    ...process.env,
    PORT: apiPort,
    HOST: apiHost,
  },
});

const docsProc = spawn(
  pnpmBin,
  ["--filter", "@scace/docs", "exec", "vite", "dev", "--port", docsPort, "--host", "0.0.0.0"],
  {
    cwd: rootDir,
    stdio: "inherit",
    env: {
      ...process.env,
      PORT: docsPort,
      SCACE_API_URL: apiUrl,
    },
  },
);

let shuttingDown = false;
function shutdown(signal = "SIGTERM") {
  if (shuttingDown) return;
  shuttingDown = true;
  if (!apiProc.killed) apiProc.kill(signal);
  if (!docsProc.killed) docsProc.kill(signal);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

apiProc.on("exit", (code) => {
  if (!shuttingDown) {
    console.error(`[dev-preview] @scace/api exited with code ${code}`);
    shutdown("SIGTERM");
    process.exit(code ?? 1);
  }
});

docsProc.on("exit", (code) => {
  if (!shuttingDown) {
    console.error(`[dev-preview] @scace/docs exited with code ${code}`);
    shutdown("SIGTERM");
    process.exit(code ?? 1);
  }
});
