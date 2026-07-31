import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateVersion } from "./build-release.mjs";

const RELEASE_NAME_PATTERN = /^xchat-cli-(.+)-darwin-(arm64|x64)\.tar\.gz$/;

export function parseSmokeArguments(arguments_) {
  if (arguments_.length !== 1 || !arguments_[0]) {
    throw new Error("Exactly one release archive path is required");
  }
  return resolve(arguments_[0]);
}

export function parseArchiveName(path) {
  const filename = basename(path);
  const match = RELEASE_NAME_PATTERN.exec(filename);
  if (!match) {
    throw new Error(`Invalid release archive name: ${filename}`);
  }
  return {
    rootName: filename.slice(0, -".tar.gz".length),
    version: validateVersion(match[1]),
    architecture: match[2],
  };
}

export async function smokeRelease(archivePath) {
  const resolvedArchive = resolve(archivePath);
  const { architecture, rootName } = parseArchiveName(resolvedArchive);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "xchat-cli smoke-"));

  try {
    await chmod(temporaryDirectory, 0o700);
    await validateChecksum(resolvedArchive);
    const listing = runCommand("/usr/bin/tar", ["-tzf", resolvedArchive]).stdout;
    validateArchiveListing(listing, rootName);
    runCommand("/usr/bin/tar", [
      "-xzf",
      resolvedArchive,
      "-C",
      temporaryDirectory,
    ]);

    const extractedRoot = join(temporaryDirectory, rootName);
    const environment = { PATH: "/usr/bin:/bin" };
    const launcherPath = join(extractedRoot, "bin", "xchat");
    const help = runCommand(launcherPath, ["--help"], {
      env: environment,
    });
    if (
      !help.stdout.includes("xchat: local XChat CLI")
      || !help.stdout.includes("Usage:")
    ) {
      throw new Error("Archived CLI help output was not recognized");
    }

    const linkedLauncherPath = join(temporaryDirectory, "linked xchat");
    await symlink(launcherPath, linkedLauncherPath);
    const linkedHelp = runCommand(linkedLauncherPath, ["--help"], {
      env: environment,
    });
    if (!linkedHelp.stdout.includes("xchat: local XChat CLI")) {
      throw new Error("Archived CLI symlink output was not recognized");
    }

    const runtimePath = join(extractedRoot, "runtime", "node");
    const runtimeArchitecture = runCommand(runtimePath, ["-p", "process.arch"], {
      env: environment,
    }).stdout.trim();
    if (runtimeArchitecture !== architecture) {
      throw new Error(
        `Archived Node architecture is ${runtimeArchitecture}, expected ${architecture}`,
      );
    }

    const probePath = join(temporaryDirectory, "wasm-probe.mjs");
    await writeFile(probePath, wasmProbe(), { mode: 0o600 });
    const modulePath = join(
      extractedRoot,
      "app",
      "node_modules",
      "@xdevplatform",
      "chat-xdk",
      "index.js",
    );
    const probe = runCommand(
      runtimePath,
      [probePath, modulePath],
      { env: environment },
    );
    if (probe.stdout.trim() !== "WASM_OK") {
      throw new Error("Archived WASM probe output was not recognized");
    }
    return { rootName };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function validateChecksum(archivePath) {
  const checksumPath = `${archivePath}.sha256`;
  const expected = `${await sha256(archivePath)}  ${basename(archivePath)}\n`;
  const actual = await readFile(checksumPath, "utf8");
  if (actual !== expected) {
    throw new Error(`Checksum does not match: ${basename(archivePath)}`);
  }
}

async function sha256(path) {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function validateArchiveListing(listing, rootName) {
  const paths = listing.split("\n").filter(Boolean);
  if (paths.length === 0) {
    throw new Error("Release archive is empty");
  }
  for (const path of paths) {
    const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
    const parts = normalized.split("/");
    if (
      normalized.startsWith("/")
      || parts.some((part) => part === "..")
      || (parts[0] !== rootName)
    ) {
      throw new Error(`Unsafe archive entry: ${path}`);
    }
  }
}

function wasmProbe() {
  return [
    "import { pathToFileURL } from \"node:url\";",
    "globalThis.fetch = () => { throw new Error(\"Unexpected network request\"); };",
    "const { createChat } = await import(pathToFileURL(process.argv[2]).href);",
    "const config = {",
    "  realms: [{",
    "    address: \"https://example.com\",",
    "    id: \"0102030405060708090a0b0c0d0e0f10\",",
    "  }],",
    "  register_threshold: 1,",
    "  recover_threshold: 1,",
    "  pin_hashing_mode: \"Standard2019\",",
    "};",
    "const chat = await createChat({",
    "  juiceboxConfig: JSON.stringify(config),",
    "  getAuthToken: async () => { throw new Error(\"Unexpected auth token request\"); },",
    "});",
    "try {",
    "  if (typeof chat.free !== \"function\") {",
    "    throw new Error(\"Chat instance cannot be freed\");",
    "  }",
    "} finally {",
    "  chat.free();",
    "}",
    "process.stdout.write(\"WASM_OK\\n\");",
    "",
  ].join("\n");
}

function runCommand(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    encoding: "utf8",
    env: options.env,
    maxBuffer: 10 * 1024 * 1024,
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      throw new Error(`${basename(command)} timed out`);
    }
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(`${basename(command)} failed: ${detail}`);
  }
  return result;
}

function isMain() {
  return process.argv[1]
    && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isMain()) {
  const archivePath = parseSmokeArguments(process.argv.slice(2));
  smokeRelease(archivePath).then(({ rootName }) => {
    process.stdout.write(`Smoke test passed: ${rootName}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
