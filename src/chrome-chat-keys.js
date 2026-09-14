import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";

const SQLITE_PATH = "/usr/bin/sqlite3";
const MAX_SQLITE_OUTPUT_BYTES = 1024;
const KEY_BYTES = 32;
const KEY_HEX_BYTES = KEY_BYTES * 2;
const KEY_QUERY = `
WITH latest AS (
  SELECT version
  FROM dm_my_keypair_versions
  ORDER BY version DESC
  LIMIT 1
)
SELECT
  CAST(latest.version AS TEXT),
  hex(identity_key.bytes),
  hex(signing_key.bytes)
FROM latest
JOIN dm_key_material AS identity_key
  ON identity_key.tag = 'keypair-private-' || latest.version
JOIN dm_key_material AS signing_key
  ON signing_key.tag = 'signing_keypair-private-' || latest.version;
`.trim();

export async function validateChromeChatDb(path, dependencies = {}) {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("Chrome XChat database path is required");
  }
  const resolvedPath = resolve(path);
  let inputMetadata;
  let canonicalPath;
  let metadata;
  try {
    inputMetadata = await (dependencies.lstatImpl ?? lstat)(resolvedPath);
    canonicalPath = await (dependencies.realpathImpl ?? realpath)(resolvedPath);
    metadata = await (dependencies.lstatImpl ?? lstat)(canonicalPath);
  } catch {
    throw new Error("Chrome XChat database is not accessible");
  }
  if (
    inputMetadata.isSymbolicLink()
    || !inputMetadata.isFile()
    || metadata.isSymbolicLink()
    || !metadata.isFile()
    || inputMetadata.dev !== metadata.dev
    || inputMetadata.ino !== metadata.ino
  ) {
    throw new Error("Chrome XChat database must be a regular non-symlink file");
  }
  const currentUserId = (dependencies.getUserId ?? process.getuid)?.();
  if (!Number.isInteger(currentUserId) || metadata.uid !== currentUserId) {
    throw new Error("Chrome XChat database must be owned by the current user");
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error("Chrome XChat database must not grant group or other permissions");
  }
  return canonicalPath;
}

export async function loadChromeChatKeys(path, dependencies = {}) {
  const resolvedPath = await validateChromeChatDb(path, dependencies);
  const output = await (dependencies.runSqlite ?? runSqliteReadOnly)(resolvedPath);
  return parseChromeChatKeyOutput(output);
}

export function parseChromeChatKeyOutput(output) {
  if (!(output instanceof Uint8Array)) {
    throw new Error("Chrome XChat database returned an invalid key result");
  }
  const bytes = Buffer.isBuffer(output)
    ? output
    : Buffer.from(output.buffer, output.byteOffset, output.byteLength);
  let identityKey;
  let signingKey;
  try {
    const firstSeparator = bytes.indexOf(0x7c);
    const secondSeparator = bytes.indexOf(0x7c, firstSeparator + 1);
    const newline = bytes.indexOf(0x0a, secondSeparator + 1);
    const end = newline === -1 ? bytes.length : newline;
    if (
      firstSeparator <= 0
      || secondSeparator <= firstSeparator
      || (newline !== -1 && newline !== bytes.length - 1)
    ) {
      throw new Error("Chrome XChat database does not contain a complete key version");
    }
    const version = bytes.subarray(0, firstSeparator).toString("ascii");
    if (!/^-?(0|[1-9]\d*)$/.test(version)) {
      throw new Error("Chrome XChat database contains an invalid key version");
    }
    const identityStart = firstSeparator + 1;
    const signingStart = secondSeparator + 1;
    if (
      secondSeparator - identityStart !== KEY_HEX_BYTES
      || end - signingStart !== KEY_HEX_BYTES
    ) {
      throw new Error("Chrome XChat private keys must each be exactly 32 bytes");
    }
    identityKey = decodeHex(bytes, identityStart, secondSeparator);
    signingKey = decodeHex(bytes, signingStart, end);
    return {
      version,
      identityKey,
      signingKey,
    };
  } catch (error) {
    identityKey?.fill(0);
    signingKey?.fill(0);
    throw error;
  } finally {
    bytes.fill(0);
    if (bytes !== output) {
      output.fill(0);
    }
  }
}

function decodeHex(source, start, end) {
  const output = Buffer.alloc((end - start) / 2);
  try {
    for (let index = 0; index < output.length; index += 1) {
      const high = hexNibble(source[start + (index * 2)]);
      const low = hexNibble(source[start + (index * 2) + 1]);
      if (high === -1 || low === -1) {
        throw new Error("Chrome XChat database contains invalid private key material");
      }
      output[index] = (high << 4) | low;
    }
    return output;
  } catch (error) {
    output.fill(0);
    throw error;
  }
}

function hexNibble(value) {
  if (value >= 0x30 && value <= 0x39) {
    return value - 0x30;
  }
  if (value >= 0x41 && value <= 0x46) {
    return value - 0x41 + 10;
  }
  return -1;
}

async function runSqliteReadOnly(path) {
  return new Promise((resolveOutput, reject) => {
    const child = spawn(SQLITE_PATH, [
      "-batch",
      "-bail",
      "-readonly",
      "-nofollow",
      "-noheader",
      "-separator",
      "|",
      "--",
      path,
      KEY_QUERY,
    ], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const outputChunks = [];
    const errorChunks = [];
    let outputBytes = 0;
    let settled = false;

    const fail = () => {
      if (settled) {
        return;
      }
      settled = true;
      zeroBuffers(outputChunks);
      zeroBuffers(errorChunks);
      reject(new Error("Could not read Chrome XChat key database"));
    };

    child.stdout.on("data", (chunk) => {
      if (settled) {
        chunk.fill(0);
        return;
      }
      outputBytes += chunk.length;
      if (outputBytes > MAX_SQLITE_OUTPUT_BYTES) {
        chunk.fill(0);
        child.kill();
        fail();
        return;
      }
      outputChunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (settled) {
        chunk.fill(0);
        return;
      }
      errorChunks.push(chunk);
    });
    child.on("error", fail);
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      if (code !== 0) {
        fail();
        return;
      }
      settled = true;
      const output = Buffer.concat(outputChunks);
      zeroBuffers(outputChunks);
      zeroBuffers(errorChunks);
      resolveOutput(output);
    });
  });
}

function zeroBuffers(buffers) {
  for (const buffer of buffers) {
    buffer.fill(0);
  }
}
