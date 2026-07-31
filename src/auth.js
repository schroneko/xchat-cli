import { execFile as execFileCallback } from "node:child_process";
import { createDecipheriv, createHash, pbkdf2Sync, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const COOKIE_NAMES = ["auth_token", "ct0", "twid"];

export function defaultChromeCookieDb(options = {}) {
  return join(
    options.home ?? homedir(),
    "Library",
    "Application Support",
    "Google",
    "Chrome",
    options.profile ?? "Default",
    "Cookies",
  );
}

export function defaultSessionPath(options = {}) {
  return join(
    options.home ?? homedir(),
    "Library",
    "Application Support",
    "xchat-cli",
    "session.json",
  );
}

export function decryptChromeCookie({ encryptedHex, password, hostKey = ".x.com" }) {
  if (typeof encryptedHex !== "string" || !/^[0-9a-f]+$/i.test(encryptedHex) || encryptedHex.length % 2 !== 0) {
    throw new Error("Invalid Chrome cookie ciphertext");
  }

  const encrypted = Buffer.from(encryptedHex, "hex");
  if (encrypted.length < 19 || !encrypted.subarray(0, 3).equals(Buffer.from("v10"))) {
    throw new Error("Unsupported Chrome cookie encryption format");
  }

  try {
    const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
    const plaintext = Buffer.concat([
      decipher.update(encrypted.subarray(3)),
      decipher.final(),
    ]);
    const expectedHostDigest = createHash("sha256").update(hostKey).digest();

    if (plaintext.length <= expectedHostDigest.length) {
      throw new Error("Chrome cookie plaintext is incomplete");
    }
    if (!timingSafeEqual(plaintext.subarray(0, expectedHostDigest.length), expectedHostDigest)) {
      throw new Error("Chrome cookie host digest does not match");
    }

    return plaintext.subarray(expectedHostDigest.length).toString("utf8");
  } catch (error) {
    if (error.message.startsWith("Chrome cookie")) {
      throw error;
    }
    throw new Error("Chrome cookie decryption failed");
  }
}

export async function readChromeXCookies(options = {}) {
  const cookieDb = options.cookieDb ?? defaultChromeCookieDb(options);
  const runner = options.runner ?? runCommand;
  const fs = {
    mkdtemp: options.fs?.mkdtemp ?? mkdtemp,
    rm: options.fs?.rm ?? rm,
  };
  const tempDir = await fs.mkdtemp(join(options.tempRoot ?? tmpdir(), "xchat-cli-cookies-"));
  const tempDb = join(tempDir, "Cookies");

  try {
    const escapedTempDb = tempDb.replaceAll("'", "''");
    await runner("sqlite3", [
      "-readonly",
      cookieDb,
      `VACUUM INTO '${escapedTempDb}'`,
    ]);
    const sql = "select host_key,name,hex(encrypted_value) as encrypted from cookies where host_key='.x.com' and name in ('auth_token','ct0','twid')";
    const sqliteResult = await runner("sqlite3", ["-json", tempDb, sql]);
    const rows = parseRows(sqliteResult.stdout);
    const passwordResult = await runner("security", [
      "find-generic-password",
      "-w",
      "-s",
      "Chrome Safe Storage",
    ]);
    const password = String(passwordResult.stdout ?? "").trim();

    if (!password) {
      throw new Error("Chrome Safe Storage password was unavailable");
    }

    return Object.fromEntries(rows.map((row) => [
      row.name,
      decryptChromeCookie({
        encryptedHex: row.encrypted,
        password,
        hostKey: row.host_key,
      }),
    ]));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function importChromeSession(options = {}) {
  const sessionPath = options.sessionPath ?? defaultSessionPath(options);
  const cookies = await readChromeXCookies(options);
  const missing = COOKIE_NAMES.filter((name) => !cookies[name]);

  if (missing.length > 0) {
    throw new Error(`Required X cookies were not found: ${missing.join(", ")}`);
  }

  const session = {
    authToken: cookies.auth_token,
    ct0: cookies.ct0,
    twid: cookies.twid,
  };
  const fs = {
    chmod: options.fs?.chmod ?? chmod,
    lstat: options.fs?.lstat ?? lstat,
    mkdir: options.fs?.mkdir ?? mkdir,
    open: options.fs?.open ?? open,
    rename: options.fs?.rename ?? rename,
    rm: options.fs?.rm ?? rm,
    writeFile: options.fs?.writeFile ?? writeFile,
  };

  const sessionDirectory = dirname(sessionPath);
  await fs.mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
  const directoryInfo = await fs.lstat(sessionDirectory);
  const currentUid = process.getuid?.();
  if (
    !directoryInfo.isDirectory?.()
    || (currentUid !== undefined && directoryInfo.uid !== currentUid)
    || (directoryInfo.mode & 0o077) !== 0
  ) {
    throw new Error("XChat session directory must be owned by the current user with mode 0700");
  }

  const tempSessionPath = join(
    sessionDirectory,
    `.${randomUUID()}.session.tmp`,
  );
  try {
    await fs.writeFile(tempSessionPath, `${JSON.stringify(session, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    const tempHandle = await fs.open(tempSessionPath, "r+");
    try {
      await tempHandle.sync();
    } finally {
      await tempHandle.close();
    }
    await fs.rename(tempSessionPath, sessionPath);
    await fs.chmod(sessionPath, 0o600);
  } finally {
    await fs.rm(tempSessionPath, { force: true });
  }

  return {
    path: sessionPath,
    imported: {
      authToken: true,
      ct0: true,
      twid: true,
    },
  };
}

export async function loadSession(sessionPath = defaultSessionPath(), options = {}) {
  const content = options.readFile
    ? await options.readFile(sessionPath, "utf8")
    : await secureReadFile(sessionPath);
  const session = JSON.parse(content);

  if (!session.authToken || !session.ct0 || !session.twid) {
    throw new Error("X session file is missing required cookies");
  }

  return {
    authToken: String(session.authToken),
    ct0: String(session.ct0),
    twid: String(session.twid),
  };
}

async function secureReadFile(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const file = await handle.stat();
    const currentUid = process.getuid?.();
    if (
      !file.isFile()
      || (currentUid !== undefined && file.uid !== currentUid)
      || (file.mode & 0o077) !== 0
    ) {
      throw new Error("X session file must be owned by the current user with mode 0600 or stricter");
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

export async function sessionStatus(sessionPath = defaultSessionPath(), options = {}) {
  try {
    const [session, file] = await Promise.all([
      loadSession(sessionPath, options),
      (options.stat ?? stat)(sessionPath),
    ]);
    return {
      path: sessionPath,
      exists: true,
      valid: true,
      mode: (file.mode & 0o777).toString(8).padStart(3, "0"),
      cookies: {
        authToken: Boolean(session.authToken),
        ct0: Boolean(session.ct0),
        twid: Boolean(session.twid),
      },
      userId: userIdFromSession(session),
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        path: sessionPath,
        exists: false,
        valid: false,
      };
    }
    return {
      path: sessionPath,
      exists: true,
      valid: false,
      error: "Session file could not be validated",
    };
  }
}

export function userIdFromSession(session) {
  const decoded = decodeURIComponent(String(session.twid ?? ""));
  const match = decoded.match(/^u=(\d+)$/);
  if (!match) {
    throw new Error("X session twid cookie does not contain a user ID");
  }
  return match[1];
}

async function runCommand(command, args) {
  return execFile(command, args, { maxBuffer: 8 * 1024 * 1024 });
}

function parseRows(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) {
    return [];
  }
  const rows = JSON.parse(text);
  if (!Array.isArray(rows)) {
    throw new Error("Unexpected Chrome cookie query result");
  }
  return rows.filter((row) => (
    row.host_key === ".x.com"
    && COOKIE_NAMES.includes(row.name)
    && typeof row.encrypted === "string"
  ));
}
