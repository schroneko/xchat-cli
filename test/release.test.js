import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
  archiveBaseName,
  createBuildInfo,
  parseBuildArguments,
  validatePackageVersion,
  validateReleaseEnvironment,
  validateVersion,
} from "../scripts/build-release.mjs";
import {
  parseArchiveName,
  parseSmokeArguments,
} from "../scripts/smoke-release.mjs";

test("parseBuildArguments requires version and output values", () => {
  assert.deepEqual(
    parseBuildArguments(["--version", "1.2.3", "--output", "release files"]),
    {
      version: "1.2.3",
      outputDirectory: "release files",
    },
  );
  assert.throws(() => parseBuildArguments(["--version", "1.2.3"]), /--output is required/);
  assert.throws(
    () => parseBuildArguments(["--version", "1.2.3", "--output"]),
    /Missing value for --output/,
  );
  assert.throws(
    () => parseBuildArguments(["--version", "1.2.3", "--output", "dist", "--extra", "x"]),
    /Unknown argument/,
  );
});

test("release archive naming and build information are stable", () => {
  assert.equal(
    archiveBaseName("1.2.3", "darwin", "arm64"),
    "xchat-cli-1.2.3-darwin-arm64",
  );
  assert.deepEqual(
    createBuildInfo({
      version: "1.2.3",
      platform: "darwin",
      architecture: "x64",
      nodeVersion: "v24.18.1",
    }),
    {
      schemaVersion: 1,
      name: "xchat-cli",
      version: "1.2.3",
      platform: "darwin",
      architecture: "x64",
      nodeVersion: "v24.18.1",
      archiveRoot: "xchat-cli-1.2.3-darwin-x64",
    },
  );
  assert.deepEqual(
    parseArchiveName("/tmp/xchat-cli-1.2.3-darwin-x64.tar.gz"),
    {
      rootName: "xchat-cli-1.2.3-darwin-x64",
      version: "1.2.3",
      architecture: "x64",
    },
  );
});

test("invalid versions are rejected", () => {
  for (const version of ["v1.2.3", "1.2", "01.2.3", "1.2.3/", "1.2.3 beta"]) {
    assert.throws(() => validateVersion(version), /Invalid SemVer version/);
  }
  assert.equal(validateVersion("1.2.3-beta.1+build.5"), "1.2.3-beta.1+build.5");
});

test("release version must match package.json", () => {
  assert.equal(validatePackageVersion("1.2.3", "1.2.3"), "1.2.3");
  assert.throws(
    () => validatePackageVersion("1.2.2", "1.2.3"),
    /does not match release version/,
  );
});

test("invalid release platforms and architectures are rejected", () => {
  assert.deepEqual(
    validateReleaseEnvironment("darwin", "arm64"),
    { platform: "darwin", architecture: "arm64" },
  );
  assert.deepEqual(
    validateReleaseEnvironment("darwin", "x64"),
    { platform: "darwin", architecture: "x64" },
  );
  assert.throws(
    () => validateReleaseEnvironment("linux", "arm64"),
    /Unsupported platform: linux/,
  );
  assert.throws(
    () => validateReleaseEnvironment("darwin", "ia32"),
    /Unsupported architecture: ia32/,
  );
});

test("smoke arguments require exactly one archive", () => {
  assert.equal(
    parseSmokeArguments(["relative/archive.tar.gz"]),
    resolve("relative/archive.tar.gz"),
  );
  assert.throws(() => parseSmokeArguments([]), /Exactly one/);
  assert.throws(() => parseSmokeArguments(["one", "two"]), /Exactly one/);
});
