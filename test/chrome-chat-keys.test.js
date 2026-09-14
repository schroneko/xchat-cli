import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadChromeChatKeys,
  parseChromeChatKeyOutput,
  validateChromeChatDb,
} from "../src/chrome-chat-keys.js";

test("validateChromeChatDb accepts only a private current-user regular file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xchat-cli-db-validation-"));
  const databasePath = join(directory, "chat.db");
  const symlinkPath = join(directory, "chat-link.db");
  try {
    await writeFile(databasePath, "");
    await chmod(databasePath, 0o600);
    assert.equal(await validateChromeChatDb(databasePath), await realpath(databasePath));

    await chmod(databasePath, 0o640);
    await assert.rejects(
      validateChromeChatDb(databasePath),
      /must not grant group or other permissions/,
    );

    await chmod(databasePath, 0o600);
    await symlink(databasePath, symlinkPath);
    await assert.rejects(
      validateChromeChatDb(symlinkPath),
      /regular non-symlink file/,
    );

    await assert.rejects(validateChromeChatDb(databasePath, {
      lstatImpl: async () => ({
        isSymbolicLink: () => false,
        isFile: () => true,
        uid: process.getuid() + 1,
        mode: 0o100600,
        dev: 1,
        ino: 1,
      }),
      realpathImpl: async () => databasePath,
    }), /owned by the current user/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("loadChromeChatKeys selects the newest complete key version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xchat-cli-db-selection-"));
  const databasePath = join(directory, "chat.db");
  let keyMaterial;
  try {
    createDatabase(databasePath, [
      [1, Buffer.alloc(32, 0x11), Buffer.alloc(32, 0x12)],
      [7, Buffer.alloc(32, 0x71), Buffer.alloc(32, 0x72)],
    ]);
    await chmod(databasePath, 0o600);

    keyMaterial = await loadChromeChatKeys(databasePath);

    assert.equal(keyMaterial.version, "7");
    assert.deepEqual(keyMaterial.identityKey, Buffer.alloc(32, 0x71));
    assert.deepEqual(keyMaterial.signingKey, Buffer.alloc(32, 0x72));
  } finally {
    keyMaterial?.identityKey.fill(0);
    keyMaterial?.signingKey.fill(0);
    await rm(directory, { recursive: true, force: true });
  }
});

test("loadChromeChatKeys rejects private keys that are not exactly 32 bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xchat-cli-db-length-"));
  const databasePath = join(directory, "chat.db");
  try {
    createDatabase(databasePath, [
      [3, Buffer.alloc(31, 0x31), Buffer.alloc(32, 0x32)],
    ]);
    await chmod(databasePath, 0o600);

    await assert.rejects(
      loadChromeChatKeys(databasePath),
      /exactly 32 bytes/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("parseChromeChatKeyOutput zeroes captured SQLite output", () => {
  const output = Buffer.from(`4|${"41".repeat(32)}|${"42".repeat(32)}\n`);
  const keyMaterial = parseChromeChatKeyOutput(output);
  try {
    assert.equal(output.every((value) => value === 0), true);
  } finally {
    keyMaterial.identityKey.fill(0);
    keyMaterial.signingKey.fill(0);
  }
});

function createDatabase(path, versions) {
  const statements = [
    "CREATE TABLE dm_my_keypair_versions(version INTEGER PRIMARY KEY)",
    "CREATE TABLE dm_key_material(tag TEXT PRIMARY KEY, bytes BLOB)",
  ];
  for (const [version, identityKey, signingKey] of versions) {
    statements.push(`INSERT INTO dm_my_keypair_versions(version) VALUES(${version})`);
    statements.push(
      `INSERT INTO dm_key_material(tag, bytes) VALUES('keypair-private-${version}', X'${identityKey.toString("hex")}')`,
    );
    statements.push(
      `INSERT INTO dm_key_material(tag, bytes) VALUES('signing_keypair-private-${version}', X'${signingKey.toString("hex")}')`,
    );
    identityKey.fill(0);
    signingKey.fill(0);
  }
  const result = spawnSync("/usr/bin/sqlite3", [path, statements.join(";")], {
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error("Could not create SQLite test fixture");
  }
}
