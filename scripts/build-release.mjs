import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const SUPPORTED_ARCHITECTURES = new Set(["arm64", "x64"]);
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIRECTORY, "..");

export function parseBuildArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument !== "--version" && argument !== "--output") {
      throw new Error(`Unknown argument: ${argument}`);
    }
    if (options[argument] !== undefined) {
      throw new Error(`Duplicate argument: ${argument}`);
    }
    const value = arguments_[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${argument}`);
    }
    options[argument] = value;
    index += 1;
  }
  if (!options["--version"]) {
    throw new Error("--version is required");
  }
  if (!options["--output"]) {
    throw new Error("--output is required");
  }
  return {
    version: validateVersion(options["--version"]),
    outputDirectory: options["--output"],
  };
}

export function validateVersion(version) {
  if (typeof version !== "string" || !SEMVER_PATTERN.test(version)) {
    throw new Error(`Invalid SemVer version: ${version}`);
  }
  return version;
}

export function validatePackageVersion(packageVersion, releaseVersion) {
  validateVersion(releaseVersion);
  if (packageVersion !== releaseVersion) {
    throw new Error(
      `package.json version ${packageVersion} does not match release version ${releaseVersion}`,
    );
  }
  return releaseVersion;
}

export function validateReleaseEnvironment(platform, architecture) {
  if (platform !== "darwin") {
    throw new Error(`Unsupported platform: ${platform}`);
  }
  if (!SUPPORTED_ARCHITECTURES.has(architecture)) {
    throw new Error(`Unsupported architecture: ${architecture}`);
  }
  return { platform, architecture };
}

export function archiveBaseName(version, platform, architecture) {
  validateVersion(version);
  validateReleaseEnvironment(platform, architecture);
  return `xchat-cli-${version}-${platform}-${architecture}`;
}

export function createBuildInfo({ version, platform, architecture, nodeVersion }) {
  return {
    schemaVersion: 1,
    name: "xchat-cli",
    version: validateVersion(version),
    platform: validateReleaseEnvironment(platform, architecture).platform,
    architecture,
    nodeVersion,
    archiveRoot: archiveBaseName(version, platform, architecture),
  };
}

export async function buildRelease({
  version,
  outputDirectory,
  platform = process.platform,
  architecture = process.arch,
  execPath = process.execPath,
  nodeVersion = process.version,
  projectRoot = PROJECT_ROOT,
}) {
  validateVersion(version);
  validateReleaseEnvironment(platform, architecture);
  validateNodeRuntime(execPath, platform, architecture, nodeVersion);
  const projectManifest = await readJson(join(projectRoot, "package.json"));
  validatePackageVersion(projectManifest.version, version);
  const rootName = archiveBaseName(version, platform, architecture);
  const outputPath = resolve(outputDirectory);
  const archiveName = `${rootName}.tar.gz`;
  const checksumName = `${archiveName}.sha256`;
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "xchat-cli-release-"));

  try {
    await chmod(temporaryDirectory, 0o700);
    const stagedRoot = join(temporaryDirectory, rootName);
    const appDirectory = join(stagedRoot, "app");
    await mkdir(join(stagedRoot, "bin"), { recursive: true });
    await mkdir(join(stagedRoot, "runtime"), { recursive: true });
    await mkdir(join(stagedRoot, "licenses"), { recursive: true });
    await mkdir(appDirectory, { recursive: true });

    await copyTree(join(projectRoot, "bin"), join(appDirectory, "bin"));
    await copyTree(join(projectRoot, "src"), join(appDirectory, "src"));
    await copyFileWithMode(join(projectRoot, "package.json"), join(appDirectory, "package.json"));
    await copyFileWithMode(join(projectRoot, "LICENSE"), join(stagedRoot, "LICENSE"));
    await copyFileWithMode(join(projectRoot, "README.md"), join(stagedRoot, "README.md"));
    await copyFileWithMode(
      join(projectRoot, "licenses", "juicebox-sdk-LICENSE"),
      join(stagedRoot, "licenses", "juicebox-sdk-LICENSE"),
    );
    await copyProductionDependencies(projectRoot, join(appDirectory, "node_modules"));

    const runtimePath = join(stagedRoot, "runtime", "node");
    await copyFileWithMode(execPath, runtimePath);
    const runtimeMode = (await stat(runtimePath)).mode & 0o777;
    await chmod(runtimePath, runtimeMode | 0o111);

    const nodeLicense = await locateNodeLicense(execPath);
    await copyFileWithMode(nodeLicense, join(stagedRoot, "licenses", "node-LICENSE"));

    const wrapper = [
      "#!/bin/sh",
      "script_path=$0",
      "while [ -L \"$script_path\" ]; do",
      "  link_path=$(readlink \"$script_path\") || exit 1",
      "  case \"$link_path\" in",
      "    /*) script_path=$link_path ;;",
      "    *) script_path=$(dirname \"$script_path\")/$link_path ;;",
      "  esac",
      "done",
      "root_dir=$(CDPATH= cd -P \"$(dirname \"$script_path\")/..\" && pwd) || exit 1",
      "unset NODE_OPTIONS NODE_PATH",
      "PATH=/usr/bin:/bin:/usr/sbin:/sbin",
      "export PATH",
      "exec \"$root_dir/runtime/node\" \"$root_dir/app/bin/xchat-cli.js\" \"$@\"",
      "",
    ].join("\n");
    const wrapperPath = join(stagedRoot, "bin", "xchat");
    await writeFile(wrapperPath, wrapper, { mode: 0o755 });
    await chmod(wrapperPath, 0o755);

    const buildInfo = createBuildInfo({
      version,
      platform,
      architecture,
      nodeVersion,
    });
    await writeFile(
      join(stagedRoot, "BUILD_INFO.json"),
      `${JSON.stringify(buildInfo, null, 2)}\n`,
      { mode: 0o644 },
    );
    await validatePortableTree(stagedRoot);

    const temporaryArchive = join(temporaryDirectory, archiveName);
    runCommand("/usr/bin/tar", [
      "-czf",
      temporaryArchive,
      "-C",
      temporaryDirectory,
      rootName,
    ]);
    const digest = await sha256(temporaryArchive);
    const temporaryChecksum = join(temporaryDirectory, checksumName);
    await writeFile(temporaryChecksum, `${digest}  ${archiveName}\n`, { mode: 0o644 });

    await mkdir(outputPath, { recursive: true });
    const finalArchive = join(outputPath, archiveName);
    const finalChecksum = join(outputPath, checksumName);
    await copyFileWithMode(temporaryArchive, finalArchive);
    await copyFileWithMode(temporaryChecksum, finalChecksum);
    return {
      archivePath: finalArchive,
      checksumPath: finalChecksum,
      digest,
      buildInfo,
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function copyProductionDependencies(projectRoot, destinationRoot) {
  const manifest = await readJson(join(projectRoot, "package.json"));
  const queue = dependencyEntries(manifest, projectRoot, true);
  const copied = new Set();
  const nodeModulesRoot = join(projectRoot, "node_modules");

  while (queue.length > 0) {
    const entry = queue.shift();
    const packageDirectory = await resolveInstalledPackage(entry.name, entry.fromDirectory, projectRoot);
    if (!packageDirectory) {
      if (entry.required) {
        throw new Error(`Production dependency is not installed: ${entry.name}`);
      }
      continue;
    }
    const canonicalDirectory = await realpath(packageDirectory);
    if (copied.has(canonicalDirectory)) {
      continue;
    }
    copied.add(canonicalDirectory);
    const packageRelativePath = relative(nodeModulesRoot, packageDirectory);
    if (
      packageRelativePath.startsWith(`..${sep}`)
      || packageRelativePath === ".."
      || packageRelativePath === ""
    ) {
      throw new Error(`Dependency resolved outside node_modules: ${entry.name}`);
    }
    await copyTree(packageDirectory, join(destinationRoot, packageRelativePath));
    const packageManifest = await readJson(join(packageDirectory, "package.json"));
    queue.push(...dependencyEntries(packageManifest, packageDirectory, false));
  }
}

function dependencyEntries(manifest, fromDirectory, direct) {
  const required = Object.keys(manifest.dependencies ?? {}).map((name) => ({
    name,
    fromDirectory,
    required: true,
  }));
  const optional = [
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ].map((name) => ({
    name,
    fromDirectory,
    required: direct && Object.hasOwn(manifest.dependencies ?? {}, name),
  }));
  return [...required, ...optional];
}

async function resolveInstalledPackage(name, fromDirectory, projectRoot) {
  const pathParts = packagePathParts(name);
  let directory = fromDirectory;
  while (true) {
    const candidate = join(directory, "node_modules", ...pathParts);
    try {
      const candidateStat = await stat(join(candidate, "package.json"));
      if (candidateStat.isFile()) {
        return candidate;
      }
    } catch {
    }
    if (directory === projectRoot) {
      return null;
    }
    const parent = dirname(directory);
    if (parent === directory || !isInside(projectRoot, parent)) {
      return null;
    }
    directory = parent;
  }
}

function packagePathParts(name) {
  if (typeof name !== "string" || name.length === 0 || name === "." || name === "..") {
    throw new Error(`Invalid package name: ${name}`);
  }
  const parts = name.split("/");
  if (
    (name.startsWith("@") && parts.length !== 2)
    || (!name.startsWith("@") && parts.length !== 1)
    || parts.some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Invalid package name: ${name}`);
  }
  return parts;
}

function isInside(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

async function locateNodeLicense(execPath) {
  let directory = dirname(await realpath(execPath));
  for (let depth = 0; depth < 5; depth += 1) {
    for (const name of ["LICENSE", "LICENSE.txt", "LICENSE.md"]) {
      const candidate = join(directory, name);
      if (await isNodeLicense(candidate)) {
        return candidate;
      }
    }
    const documentationLicense = join(directory, "share", "doc", "node", "LICENSE");
    if (await isNodeLicense(documentationLicense)) {
      return documentationLicense;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  throw new Error(`Node license was not found for ${execPath}`);
}

async function isNodeLicense(path) {
  try {
    if (!(await stat(path)).isFile()) {
      return false;
    }
    return (await readFile(path, "utf8")).startsWith("Node.js is licensed for use as follows:");
  } catch {
    return false;
  }
}

async function validatePortableTree(root) {
  const pending = [root];
  while (pending.length > 0) {
    const path = pending.pop();
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Release payload contains a symbolic link: ${relative(root, path)}`);
    }
    if (metadata.isDirectory()) {
      for (const name of await readdir(path)) {
        pending.push(join(path, name));
      }
      continue;
    }
    if (!metadata.isFile()) {
      throw new Error(`Release payload contains a special file: ${relative(root, path)}`);
    }
  }
}

async function copyTree(source, destination) {
  await cp(source, destination, {
    recursive: true,
    preserveTimestamps: true,
  });
}

async function copyFileWithMode(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  await chmod(destination, (await stat(source)).mode & 0o777);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function sha256(path) {
  const hash = createHash("sha256");
  const file = createReadStream(path);
  for await (const chunk of file) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function runCommand(command, arguments_) {
  const result = spawnSync(command, arguments_, {
    encoding: "utf8",
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
    throw new Error(`${basename(command)} failed: ${result.stderr.trim()}`);
  }
}

function validateNodeRuntime(execPath, platform, architecture, nodeVersion) {
  const result = spawnSync(execPath, [
    "-p",
    "JSON.stringify({ platform: process.platform, architecture: process.arch, nodeVersion: process.version })",
  ], {
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Bundled Node inspection failed: ${result.stderr.trim()}`);
  }
  let actual;
  try {
    actual = JSON.parse(result.stdout);
  } catch {
    throw new Error("Bundled Node inspection returned invalid output");
  }
  if (!actual || typeof actual !== "object") {
    throw new Error("Bundled Node inspection returned invalid output");
  }
  if (
    actual.platform !== platform
    || actual.architecture !== architecture
    || actual.nodeVersion !== nodeVersion
  ) {
    throw new Error(
      `Bundled Node is ${actual.platform}-${actual.architecture} ${actual.nodeVersion}, expected ${platform}-${architecture} ${nodeVersion}`,
    );
  }
}

function isMain() {
  return process.argv[1]
    && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isMain()) {
  buildRelease({
    ...parseBuildArguments(process.argv.slice(2)),
  }).then((result) => {
    process.stdout.write(`${result.archivePath}\n${result.checksumPath}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
