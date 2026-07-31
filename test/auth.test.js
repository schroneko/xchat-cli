import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decryptChromeCookie,
  importChromeSession,
  loadSession,
  sessionStatus,
  userIdFromSession,
} from "../src/auth.js";

const ENCRYPTED_FIXTURE = "76313041e6df1f72b7c14d1be8086982be0bb6c6711ad662bf2e982974a0c29083695d4d65f52b7c1e22b48e89e525443bf1f0e3cb105002309c299d065a90d0061774";

test("decryptChromeCookie validates and strips the host digest", () => {
  const value = decryptChromeCookie({
    encryptedHex: ENCRYPTED_FIXTURE,
    password: "fixture-password",
    hostKey: ".x.com",
  });

  assert.equal(value, "fixture-cookie-value");
  assert.throws(() => decryptChromeCookie({
    encryptedHex: ENCRYPTED_FIXTURE,
    password: "fixture-password",
    hostKey: ".twitter.com",
  }), /host digest/);
});

test("decryptChromeCookie rejects unsupported ciphertext", () => {
  assert.throws(() => decryptChromeCookie({
    encryptedHex: "76323000",
    password: "fixture-password",
  }), /Unsupported/);
});

test("importChromeSession writes only required cookies with mode 0600", async () => {
  const calls = [];
  let written;
  const rows = ["auth_token", "ct0", "twid"].map((name) => ({
    host_key: ".x.com",
    name,
    encrypted: ENCRYPTED_FIXTURE,
  }));
  const runner = async (command) => {
    if (command === "sqlite3") {
      return { stdout: JSON.stringify(rows) };
    }
    return { stdout: "fixture-password\n" };
  };
  const fs = {
    mkdtemp: async () => "/tmp/xchat-cli-fixture",
    rm: async () => {},
    mkdir: async () => {},
    open: async () => ({
      sync: async () => {},
      close: async () => {},
    }),
    rename: async (...args) => {
      calls.push(["rename", ...args]);
    },
    lstat: async () => ({
      mode: 0o40700,
      uid: process.getuid(),
      isDirectory: () => true,
    }),
    writeFile: async (path, value, options) => {
      written = { path, value, options };
    },
    chmod: async (...args) => {
      calls.push(args);
    },
  };

  const result = await importChromeSession({
    cookieDb: "/fixture/Cookies",
    sessionPath: "/fixture/session.json",
    runner,
    fs,
  });

  assert.equal(result.path, "/fixture/session.json");
  assert.deepEqual(Object.keys(JSON.parse(written.value)).sort(), ["authToken", "ct0", "twid"]);
  assert.equal(written.options.mode, 0o600);
  assert.equal(written.options.flag, "wx");
  assert.equal(calls[0][0], "rename");
  assert.equal(calls[0][2], "/fixture/session.json");
  assert.deepEqual(calls[1], ["/fixture/session.json", 0o600]);
  assert.doesNotMatch(JSON.stringify(result), /fixture-cookie-value/);
});

test("sessionStatus reports presence without cookie values", async () => {
  const value = JSON.stringify({
    authToken: "auth-secret",
    ct0: "csrf-secret",
    twid: "u%3D123456",
  });
  const status = await sessionStatus("/fixture/session.json", {
    readFile: async () => value,
    stat: async () => ({ mode: 0o100600 }),
  });

  assert.equal(status.valid, true);
  assert.equal(status.mode, "600");
  assert.equal(status.userId, "123456");
  assert.doesNotMatch(JSON.stringify(status), /auth-secret|csrf-secret/);
});

test("loadSession rejects broad permissions and symbolic links", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xchat-cli-session-test-"));
  const sessionPath = join(directory, "session.json");
  const linkPath = join(directory, "linked.json");
  const value = JSON.stringify({
    authToken: "auth-secret",
    ct0: "csrf-secret",
    twid: "u%3D123456",
  });
  try {
    await writeFile(sessionPath, value, { mode: 0o644 });
    await assert.rejects(loadSession(sessionPath), /mode 0600/);
    await chmod(sessionPath, 0o600);
    assert.equal((await loadSession(sessionPath)).authToken, "auth-secret");
    await symlink(sessionPath, linkPath);
    await assert.rejects(loadSession(linkPath));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("userIdFromSession parses the encoded twid cookie", () => {
  assert.equal(userIdFromSession({ twid: "u%3D123456" }), "123456");
  assert.throws(() => userIdFromSession({ twid: "invalid" }), /user ID/);
});
