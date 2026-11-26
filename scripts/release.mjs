#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "..");
const changesetDir = resolve(repoRoot, ".changeset");

function findChangesetFiles() {
  if (!existsSync(changesetDir)) {
    return [];
  }
  return readdirSync(changesetDir, { withFileTypes: true })
    .filter((entry) => {
      if (!entry.isFile()) return false;
      const lower = entry.name.toLowerCase();
      return lower.endsWith(".md") && lower !== "readme.md";
    })
    .map((entry) => entry.name)
    .sort();
}

function detectConsumedChangesetsInHeadCommit() {
  const res = spawnSync(
    "git",
    ["diff-tree", "--no-commit-id", "--name-status", "-r", "HEAD"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (res.status !== 0 || !res.stdout) {
    return { consumed: false, deletedChangesets: [] };
  }

  let touchedPackageJson = false;
  const deletedChangesets = [];

  for (const rawLine of res.stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const [status, ...pathParts] = line.split(/\s+/);
    const filePath = pathParts.join(" ");
    if (
      status?.startsWith("D") &&
      filePath.startsWith(".changeset/") &&
      filePath.toLowerCase().endsWith(".md") &&
      filePath.toLowerCase() !== ".changeset/readme.md"
    ) {
      deletedChangesets.push(filePath.replace(/^\.changeset\//, ""));
    }
    if (
      status?.startsWith("M") &&
      (filePath === "package.json" || filePath.endsWith("/package.json"))
    ) {
      touchedPackageJson = true;
    }
  }

  return {
    consumed: deletedChangesets.length > 0 && touchedPackageJson,
    deletedChangesets,
  };
}

function writeGithubOutputs(outputs) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  const lines = Object.entries(outputs).map(([k, v]) => `${k}=${v}`);
  appendFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
}

function runCommand(cmd, args, extraEnv = {}) {
  const res = spawnSync(cmd, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
}

function runPnpm(args, extraEnv = {}) {
  const localPnpm = resolve(repoRoot, "node_modules/.bin/pnpm");
  const pnpmBin = existsSync(localPnpm) ? localPnpm : "pnpm";
  runCommand(pnpmBin, args, extraEnv);
}

function runChangesetWithTagOutput(changesetArgs) {
  const tmpDir = mkdtempSync(join(tmpdir(), "scace-changeset-"));
  const outputFile = join(tmpDir, "events.jsonl");

  try {
    runPnpm(["exec", "changeset", ...changesetArgs, "--output", outputFile]);

    if (existsSync(outputFile)) {
      const lines = readFileSync(outputFile, "utf8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);

      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event?.type === "git-tag" && typeof event.tag === "string") {
            // Standard format expected by changesets/action for creating GitHub Releases
            console.log(`New tag: ${event.tag}`);
          }
        } catch {
          // Ignore non-JSON lines if any
        }
      }
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith("-") ? args[0] : "check";
const flags = new Set(args.filter((a) => a.startsWith("-")));

const pendingFiles = findChangesetFiles();
const hasChangesets = pendingFiles.length > 0;

switch (command) {
  case "check": {
    const githubCommitCheck = flags.has("--github-commit");
    const requireChangesets = flags.has("--require");
    const consumedInfo = githubCommitCheck
      ? detectConsumedChangesetsInHeadCommit()
      : { consumed: false, deletedChangesets: [] };
    const shouldRelease = hasChangesets || consumedInfo.consumed;

    if (hasChangesets) {
      console.log(
        `[release] Found ${pendingFiles.length} changeset file(s): ${pendingFiles.join(", ")}`,
      );
    } else if (consumedInfo.consumed) {
      console.log(
        `[release] HEAD commit consumed ${consumedInfo.deletedChangesets.length} changeset file(s) (${consumedInfo.deletedChangesets.join(", ")}); proceeding with post-version tag/publish.`,
      );
    } else {
      console.log("[release] No changeset files found in .changeset/.");
    }

    writeGithubOutputs({
      has_changesets: String(hasChangesets),
      consumed_changesets: String(consumedInfo.consumed),
      should_release: String(shouldRelease),
      changeset_count: String(pendingFiles.length),
      changeset_files: pendingFiles.join(","),
    });

    if (requireChangesets && !hasChangesets) {
      console.error("[release] Aborting: at least one changeset file is required.");
      process.exit(1);
    }
    break;
  }

  case "version": {
    if (!hasChangesets) {
      console.log(
        "[release] No changeset files found in .changeset/. Skipping version bump.",
      );
      process.exit(0);
    }
    console.log(
      `[release] Versioning packages from ${pendingFiles.length} changeset file(s): ${pendingFiles.join(", ")}`,
    );
    runPnpm(["exec", "changeset", "version"]);
    break;
  }

  case "run": {
    if (!hasChangesets) {
      console.log(
        "[release] No changeset files found in .changeset/. Skipping release.",
      );
      process.exit(0);
    }

    console.log(
      `[release] Starting release for ${pendingFiles.length} changeset file(s): ${pendingFiles.join(", ")}`,
    );

    if (!flags.has("--skip-verify")) {
      runPnpm(["db:generate"]);
      runPnpm(["lint"]);
      runPnpm(["typecheck"]);
      runPnpm(["test"]);
      runPnpm(["build"]);
      runPnpm(["--filter", "@scace/sdk", "build"]);
      runPnpm(["--filter", "@scace/sdk", "test"]);
    }

    runPnpm(["exec", "changeset", "version"]);

    if (flags.has("--publish")) {
      runChangesetWithTagOutput(["publish"]);
    } else if (!flags.has("--no-tag")) {
      runChangesetWithTagOutput(["tag"]);
    }
    break;
  }

  case "publish-ci": {
    const consumedInfo = detectConsumedChangesetsInHeadCommit();
    if (!hasChangesets && !consumedInfo.consumed && !flags.has("--force")) {
      console.log(
        "[release] Neither pending nor consumed changeset files were detected. Skipping publish/tag.",
      );
      process.exit(0);
    }

    if (process.env.NPM_TOKEN && process.env.NPM_TOKEN.trim().length > 0) {
      console.log("[release] NPM_TOKEN detected; publishing public packages and creating tags...");
      runChangesetWithTagOutput(["publish"]);
    } else {
      console.log(
        "[release] NPM_TOKEN is not set; skipping npm registry publish and creating release git tags only.",
      );
      runChangesetWithTagOutput(["tag"]);
    }
    break;
  }

  default: {
    console.error(
      `Unknown release command "${command}". Expected one of: check, version, run, publish-ci`,
    );
    process.exit(1);
  }
}
