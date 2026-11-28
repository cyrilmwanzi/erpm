#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "..");
const changesetDir = resolve(repoRoot, ".changeset");
const sdkDir = resolve(repoRoot, "packages/sdk");
const sdkPkgPath = resolve(sdkDir, "package.json");
const NPM_REGISTRY_URL = "https://registry.npmjs.org/";

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

function runCommand(cmd, args, extraEnv = {}, cwd = repoRoot) {
  const res = spawnSync(cmd, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
}

function runCapture(cmd, args, env = process.env, cwd = repoRoot) {
  return spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env,
  });
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

function parseSemver(versionStr) {
  const match = String(versionStr || "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isVersionAtLeast(current, minimum) {
  const a = parseSemver(current);
  const b = parseSemver(minimum);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

function hasGithubOidcEnvironment() {
  return Boolean(
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL?.trim() &&
      process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN?.trim(),
  );
}

function resolveNpmToken() {
  const token =
    process.env.SCACE_NPM_TOKEN?.trim() ||
    process.env.NPM_TOKEN?.trim() ||
    process.env.NODE_AUTH_TOKEN?.trim() ||
    "";
  return token.length > 0 ? token : null;
}

function resolveSdkPublishAuthMode(flags) {
  const requested = flags.has("--oidc")
    ? "oidc"
    : flags.has("--token")
      ? "token"
      : (process.env.SDK_PUBLISH_AUTH_MODE || "auto").trim().toLowerCase();

  const oidcAvailable = hasGithubOidcEnvironment();
  const oidcPreference =
    (process.env.SDK_PUBLISH_OIDC ?? "true").trim().toLowerCase() !== "false";
  const token = resolveNpmToken();

  if (requested === "oidc") {
    return { mode: "oidc", oidcAvailable, token };
  }
  if (requested === "token") {
    return { mode: token ? "token" : "none", oidcAvailable, token };
  }

  // auto mode: prefer GitHub OIDC when OIDC request env is active and OIDC isn't disabled,
  // or when no NPM_TOKEN is configured.
  if (oidcAvailable && (oidcPreference || !token)) {
    return { mode: "oidc", oidcAvailable, token };
  }
  if (token) {
    return { mode: "token", oidcAvailable, token };
  }
  return { mode: "none", oidcAvailable, token: null };
}

function assertNpmSupportsOidc() {
  const res = runCapture("npm", ["--version"]);
  if (res.status !== 0) {
    console.error("[release] Unable to determine npm CLI version.");
    process.exit(1);
  }
  const npmVersion = res.stdout.trim();
  if (!isVersionAtLeast(npmVersion, "11.5.1")) {
    console.error(
      `[release] GitHub OIDC Trusted Publishing requires npm >= 11.5.1 (detected ${npmVersion}). Upgrade via "npm install -g npm@^11.5.1".`,
    );
    process.exit(1);
  }
  return npmVersion;
}

function isSdkVersionAlreadyPublished(pkgName, pkgVersion, npmConfigPath) {
  const env = {
    ...process.env,
    NPM_CONFIG_USERCONFIG: npmConfigPath,
  };
  delete env.NODE_AUTH_TOKEN;
  delete env.NPM_TOKEN;

  const res = runCapture(
    "npm",
    ["view", `${pkgName}@${pkgVersion}`, "version", "--registry", NPM_REGISTRY_URL],
    env,
    sdkDir,
  );
  if (res.status === 0 && res.stdout.trim() === pkgVersion) {
    return true;
  }
  return false;
}

function publishSdkPackage({ flags }) {
  const dryRun = flags.has("--dry-run");
  const { mode, oidcAvailable, token } = resolveSdkPublishAuthMode(flags);

  if (!dryRun && mode === "oidc" && !oidcAvailable) {
    console.error(
      "[release] GitHub OIDC auth mode was selected, but ACTIONS_ID_TOKEN_REQUEST_URL / ACTIONS_ID_TOKEN_REQUEST_TOKEN are not present. Ensure the GitHub Actions job sets `permissions: id-token: write`.",
    );
    process.exit(1);
  }

  if (!dryRun && mode === "none") {
    console.log(
      "[release] Neither GitHub OIDC credentials nor NPM_TOKEN were detected; skipping @scace/sdk npm publish.",
    );
    return { published: false, skipped: true, reason: "no-auth" };
  }

  const originalPkgRaw = readFileSync(sdkPkgPath, "utf8");
  const pkg = JSON.parse(originalPkgRaw);
  const pkgName = pkg.name;
  const pkgVersion = pkg.version;

  const tmpDir = mkdtempSync(join(tmpdir(), "scace-sdk-publish-"));
  const emptyNpmrcPath = join(tmpDir, ".npmrc");
  writeFileSync(emptyNpmrcPath, "", "utf8");

  if (!dryRun && isSdkVersionAlreadyPublished(pkgName, pkgVersion, emptyNpmrcPath)) {
    rmSync(tmpDir, { recursive: true, force: true });
    console.log(
      `[release] ${pkgName}@${pkgVersion} is already published on ${NPM_REGISTRY_URL}; skipping duplicate publish.`,
    );
    return { published: false, skipped: true, reason: "already-published" };
  }

  if (!dryRun && mode === "oidc") {
    const npmVer = assertNpmSupportsOidc();
    console.log(
      `[release] Publishing ${pkgName}@${pkgVersion} via GitHub OIDC Trusted Publishing (npm v${npmVer}, provenance enabled)...`,
    );
  } else if (!dryRun && mode === "token") {
    console.log(
      `[release] Publishing ${pkgName}@${pkgVersion} via NPM_TOKEN${oidcAvailable ? " with provenance" : ""}...`,
    );
  } else {
    console.log(
      `[release] Running dry-run pack/publish verification for ${pkgName}@${pkgVersion} (authMode=${mode})...`,
    );
  }

  try {
    runPnpm(["--filter", "@scace/sdk", "build"]);
    runCommand("node", ["scripts/verify-sdk.mjs"], {}, sdkDir);

    // Align repository URL in packed manifest with GitHub Actions repository claim for OIDC provenance
    const ghRepo = process.env.GITHUB_REPOSITORY?.trim();
    if (ghRepo) {
      const ghServer = (process.env.GITHUB_SERVER_URL || "https://github.com").replace(/\/+$/, "");
      const updatedPkg = {
        ...pkg,
        repository: {
          type: "git",
          url: `git+${ghServer}/${ghRepo}.git`,
          directory: "packages/sdk",
        },
      };
      writeFileSync(sdkPkgPath, `${JSON.stringify(updatedPkg, null, 2)}\n`, "utf8");
    }

    const packDir = join(tmpDir, "tarballs");
    runPnpm(["--filter", "@scace/sdk", "pack", "--pack-destination", packDir]);

    const tarballs = readdirSync(packDir).filter((f) => f.endsWith(".tgz"));
    if (tarballs.length !== 1) {
      console.error(
        `[release] Expected 1 SDK tarball in ${packDir}, found ${tarballs.length}.`,
      );
      process.exit(1);
    }
    const tarballPath = join(packDir, tarballs[0]);

    const publishEnv = { ...process.env };
    delete publishEnv.NODE_AUTH_TOKEN;
    delete publishEnv.NPM_TOKEN;
    delete publishEnv.SCACE_NPM_TOKEN;
    delete publishEnv.npm_config__authToken;
    delete publishEnv.NPM_CONFIG__AUTHTOKEN;

    const npmArgs = [
      "publish",
      tarballPath,
      "--access",
      "public",
      "--registry",
      NPM_REGISTRY_URL,
    ];

    if (dryRun) {
      npmArgs.push("--dry-run");
    }

    if (mode === "oidc") {
      publishEnv.NPM_CONFIG_USERCONFIG = emptyNpmrcPath;
      publishEnv.NPM_CONFIG_PROVENANCE = "true";
      npmArgs.push("--provenance");
    } else if (mode === "token" && token) {
      const tokenNpmrcPath = join(tmpDir, ".npmrc-token");
      writeFileSync(
        tokenNpmrcPath,
        `//registry.npmjs.org/:_authToken=${token}\n`,
        "utf8",
      );
      publishEnv.NPM_CONFIG_USERCONFIG = tokenNpmrcPath;
      if (oidcAvailable) {
        publishEnv.NPM_CONFIG_PROVENANCE = "true";
        npmArgs.push("--provenance");
      }
    } else {
      publishEnv.NPM_CONFIG_USERCONFIG = emptyNpmrcPath;
    }

    const res = spawnSync("npm", npmArgs, {
      cwd: sdkDir,
      stdio: "inherit",
      env: publishEnv,
    });
    if (res.status !== 0) {
      process.exit(res.status ?? 1);
    }

    return { published: !dryRun, skipped: false, version: pkgVersion, mode };
  } finally {
    // Always restore original packages/sdk/package.json so git working tree stays clean
    writeFileSync(sdkPkgPath, originalPkgRaw, "utf8");
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
    const forceRelease = flags.has("--force");
    const consumedInfo = githubCommitCheck
      ? detectConsumedChangesetsInHeadCommit()
      : { consumed: false, deletedChangesets: [] };
    const shouldRelease = hasChangesets || consumedInfo.consumed || forceRelease;

    if (hasChangesets) {
      console.log(
        `[release] Found ${pendingFiles.length} changeset file(s): ${pendingFiles.join(", ")}`,
      );
    } else if (consumedInfo.consumed) {
      console.log(
        `[release] HEAD commit consumed ${consumedInfo.deletedChangesets.length} changeset file(s) (${consumedInfo.deletedChangesets.join(", ")}); proceeding with post-version tag/publish.`,
      );
    } else if (forceRelease) {
      console.log(
        "[release] Force release requested; proceeding with SDK publish check.",
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
      publishSdkPackage({ flags });
    }
    if (!flags.has("--no-tag")) {
      runChangesetWithTagOutput(["tag"]);
    }
    break;
  }

  case "publish-sdk": {
    publishSdkPackage({ flags });
    break;
  }

  case "publish-ci": {
    const consumedInfo = detectConsumedChangesetsInHeadCommit();
    const forcePublish = flags.has("--force");
    if (!hasChangesets && !consumedInfo.consumed && !forcePublish) {
      console.log(
        "[release] Neither pending nor consumed changeset files were detected. Skipping publish/tag.",
      );
      process.exit(0);
    }

    const sdkPublishEnabled =
      (process.env.SDK_PUBLISH_ENABLED ?? "true").trim().toLowerCase() !== "false";

    if (sdkPublishEnabled) {
      publishSdkPackage({ flags });
    } else {
      console.log("[release] SDK_PUBLISH_ENABLED=false; skipping npm publish.");
    }

    if (!flags.has("--no-tag")) {
      runChangesetWithTagOutput(["tag"]);
    }
    break;
  }

  default: {
    console.error(
      `Unknown release command "${command}". Expected one of: check, version, run, publish-sdk, publish-ci`,
    );
    process.exit(1);
  }
}
