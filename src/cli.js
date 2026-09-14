import { createInterface } from "node:readline/promises";
import { readFileSync } from "node:fs";
import {
  defaultChromeCookieDb,
  defaultSessionPath,
  importChromeSession,
  loadSession,
  sessionStatus,
  userIdFromSession,
} from "./auth.js";
import { redact } from "./redaction.js";
import {
  checkKeys,
  fetchInbox,
  publicConversation,
  readConversation,
  sendMessage,
} from "./service.js";
import { OPERATION_CATALOG, XWebClient } from "./x-api.js";

const MAX_MESSAGE_CHARACTERS = 100_000;

export async function runCli(argv, dependencies = {}) {
  const output = dependencies.stdout ?? process.stdout;
  const env = dependencies.env ?? process.env;
  const [command, ...rest] = argv;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    output.write(helpText());
    return;
  }

  if (command === "doctor") {
    const { options, positionals } = parseArgs(rest);
    rejectPositionals(positionals);
    rejectUnknownOptions(options, ["session", "chrome-cookie-db"]);
    const sessionPath = stringOption(options, "session") ?? defaultSessionPath();
    writeJson(output, {
      ok: true,
      runtime: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
      },
      internalApi: {
        graphqlOrigin: "https://api.x.com",
        webOrigin: "https://x.com",
        officialApiUsed: false,
      },
      session: await sessionStatus(sessionPath),
      chromeCookieDb: stringOption(options, "chrome-cookie-db") ?? defaultChromeCookieDb(),
    });
    return;
  }

  if (command === "auth") {
    await runAuth(rest, { output, dependencies });
    return;
  }

  const { options, positionals } = parseArgs(rest);
  const sessionPath = stringOption(options, "session") ?? defaultSessionPath();

  if (command === "operations") {
    rejectUnknownOptions(options, ["session"]);
    const session = await resolveSession(sessionPath, dependencies);
    const client = createClient(session, dependencies);
    const names = positionals.length > 0 ? positionals : Object.keys(OPERATION_CATALOG);
    writeJson(output, {
      ok: true,
      ...(await client.discover(names)),
    });
    return;
  }

  if (command === "conversations") {
    rejectPositionals(positionals);
    rejectUnknownOptions(options, ["max-pages", "session"]);
    const session = await resolveSession(sessionPath, dependencies);
    const client = createClient(session, dependencies);
    const inbox = await fetchInbox(client, {
      maxPages: integerOption(options, "max-pages", 1, 20, 5),
    });
    writeJson(output, {
      ok: true,
      conversations: inbox.conversations.map(publicConversation),
      meta: {
        pageCount: inbox.pageCount,
        complete: inbox.complete,
        hasMessageRequests: inbox.hasMessageRequests,
      },
    });
    return;
  }

  if (command === "keys") {
    await runKeys(positionals, options, {
      output,
      env,
      sessionPath,
      dependencies,
    });
    return;
  }

  if (command === "read") {
    rejectPositionals(positionals);
    rejectUnknownOptions(options, [
      "conversation",
      "to",
      "redact",
      "session",
      "max-pages",
      "chrome-chat-db",
    ]);
    const target = parseTarget(options);
    const redactMessages = booleanOption(options, "redact");
    const chromeChatDb = stringOption(options, "chrome-chat-db");
    if (chromeChatDb !== undefined && chromeChatDb.length === 0) {
      throw usageError("--chrome-chat-db requires a non-empty path");
    }
    rejectChromeKeyPinAmbiguity(chromeChatDb, env);
    const session = await resolveSession(sessionPath, dependencies);
    const pin = chromeChatDb !== undefined
      ? undefined
      : await resolvePin({ env, dependencies });
    const result = await (dependencies.readConversationImpl ?? readConversation)({
      client: createClient(session, dependencies),
      ownUserId: userIdFromSession(session),
      pin,
      chromeChatDb,
      ...target,
      maxInboxPages: integerOption(options, "max-pages", 1, 20, 5),
      createChatImpl: dependencies.createChatImpl,
      createImportedChatImpl: dependencies.createImportedChatImpl,
      loadChromeChatKeysImpl: dependencies.loadChromeChatKeysImpl,
    });
    const safeResult = {
      ...result,
      messages: result.messages.map(({ originalB64, ...message }) => message),
    };
    writeJson(output, {
      ok: true,
      ...(redactMessages ? redact(safeResult, { messages: true }) : safeResult),
    });
    return;
  }

  if (command === "send") {
    rejectPositionals(positionals);
    rejectUnknownOptions(options, [
      "conversation",
      "to",
      "text",
      "dry-run",
      "yes",
      "session",
      "max-pages",
    ]);
    const target = parseTarget(options);
    const text = await resolveMessageText(options, dependencies);
    const dryRun = booleanOption(options, "dry-run");
    const yes = booleanOption(options, "yes");
    if (dryRun && yes) {
      throw usageError("--dry-run and --yes cannot be used together");
    }
    const intent = {
      command: "send",
      target: target.conversationId
        ? { conversationId: target.conversationId }
        : { handle: target.handle },
      textLength: [...text].length,
    };
    if (dryRun) {
      writeJson(output, {
        ok: true,
        dryRun: true,
        intent,
      });
      return;
    }
    if (!yes) {
      const confirmed = await confirmSend(intent, dependencies);
      if (!confirmed) {
        writeJson(output, {
          ok: false,
          sent: false,
          cancelled: true,
        });
        return;
      }
    }
    const session = await resolveSession(sessionPath, dependencies);
    const pin = await resolvePin({ env, dependencies });
    const result = await sendMessage({
      client: createClient(session, dependencies),
      ownUserId: userIdFromSession(session),
      pin,
      text,
      ...target,
      maxInboxPages: integerOption(options, "max-pages", 1, 20, 5),
      createChatImpl: dependencies.createChatImpl,
    });
    writeJson(output, result);
    return;
  }

  throw usageError(`Unknown command: ${command}`);
}

async function runAuth(argv, context) {
  const [subcommand, ...rest] = argv;
  const { options, positionals } = parseArgs(rest);
  rejectPositionals(positionals);
  const sessionPath = stringOption(options, "session") ?? defaultSessionPath();

  if (subcommand === "import") {
    rejectUnknownOptions(options, ["session", "profile", "chrome-cookie-db"]);
    const result = await (context.dependencies.importChromeSession ?? importChromeSession)({
      sessionPath,
      cookieDb: stringOption(options, "chrome-cookie-db") ?? defaultChromeCookieDb({
        profile: stringOption(options, "profile") ?? "Default",
      }),
    });
    writeJson(context.output, {
      ok: true,
      ...result,
    });
    return;
  }

  if (subcommand === "status") {
    rejectUnknownOptions(options, ["session"]);
    writeJson(context.output, {
      ok: true,
      session: await sessionStatus(sessionPath),
    });
    return;
  }

  throw usageError(`Unknown auth command: ${subcommand ?? ""}`);
}

async function runKeys(positionals, options, context) {
  const subcommand = positionals.shift() ?? "status";
  rejectPositionals(positionals);
  if (subcommand !== "status" && subcommand !== "unlock") {
    throw usageError(`Unknown keys command: ${subcommand}`);
  }
  rejectUnknownOptions(options, ["session"]);
  const session = await resolveSession(context.sessionPath, context.dependencies);
  const pin = subcommand === "unlock"
    ? await resolvePin({ env: context.env, dependencies: context.dependencies })
    : undefined;
  const result = await checkKeys({
    client: createClient(session, context.dependencies),
    ownUserId: userIdFromSession(session),
    pin,
    createChatImpl: context.dependencies.createChatImpl,
  });
  writeJson(context.output, {
    ok: true,
    ...result,
  });
}

function createClient(session, dependencies) {
  return dependencies.clientFactory?.(session) ?? new XWebClient({
    session,
    fetchImpl: dependencies.fetchImpl,
    delay: dependencies.delay,
  });
}

async function resolveSession(path, dependencies) {
  return (dependencies.loadSession ?? loadSession)(path);
}

async function resolvePin({ env, dependencies }) {
  if (env.XCHAT_PIN_FD && env.XCHAT_PIN) {
    throw usageError("Set only one of XCHAT_PIN_FD or XCHAT_PIN");
  }
  if (env.XCHAT_PIN_FD) {
    const descriptor = Number(env.XCHAT_PIN_FD);
    delete env.XCHAT_PIN_FD;
    if (!Number.isInteger(descriptor) || descriptor < 3) {
      throw usageError("XCHAT_PIN_FD must be an open file descriptor of 3 or greater");
    }
    const pin = readFileSync(descriptor, "utf8").replace(/[\r\n]+$/, "");
    if (!pin) {
      throw usageError("XCHAT_PIN_FD did not contain a PIN");
    }
    return pin;
  }
  if (env.XCHAT_PIN) {
    const pin = env.XCHAT_PIN;
    delete env.XCHAT_PIN;
    return pin;
  }
  if (dependencies.pinProvider) {
    return dependencies.pinProvider();
  }
  return readHidden("XChat PIN: ");
}

function rejectChromeKeyPinAmbiguity(chromeChatDb, env) {
  if (
    chromeChatDb !== undefined
    && (env.XCHAT_PIN !== undefined || env.XCHAT_PIN_FD !== undefined)
  ) {
    throw usageError("--chrome-chat-db cannot be combined with XCHAT_PIN or XCHAT_PIN_FD");
  }
}

async function resolveMessageText(options, dependencies) {
  const supplied = stringOption(options, "text");
  if (supplied !== undefined) {
    return validateMessageText(supplied);
  }
  if (dependencies.textProvider) {
    return validateMessageText(await dependencies.textProvider());
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw usageError("--text is required in non-interactive mode");
  }
  const reader = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return validateMessageText(await reader.question("Message: "));
  } finally {
    reader.close();
  }
}

function validateMessageText(value) {
  const text = String(value ?? "");
  const length = [...text].length;
  if (length === 0) {
    throw usageError("Message text cannot be empty");
  }
  if (length > MAX_MESSAGE_CHARACTERS) {
    throw usageError(`Message text exceeds ${MAX_MESSAGE_CHARACTERS} characters`);
  }
  return text;
}

async function confirmSend(intent, dependencies) {
  if (dependencies.confirm) {
    return dependencies.confirm(intent);
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw usageError("send requires interactive confirmation or --yes");
  }
  const target = intent.target.conversationId
    ? `conversation ${intent.target.conversationId}`
    : `@${intent.target.handle}`;
  const prompt = `Send ${intent.textLength} characters to ${target}? Type yes: `;
  const reader = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return (await reader.question(prompt)).trim() === "yes";
  } finally {
    reader.close();
  }
}

function readHidden(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    throw usageError("XCHAT_PIN_FD is required in non-interactive mode");
  }
  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk) => {
      const input = chunk.toString("utf8");
      for (const character of input) {
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (character === "\u0003") {
          cleanup();
          reject(new Error("PIN entry cancelled"));
          return;
        }
        if (character === "\u007f") {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    };
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

export function parseArgs(argv) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const equalIndex = token.indexOf("=");
    if (equalIndex !== -1) {
      assignOption(options, token.slice(2, equalIndex), token.slice(equalIndex + 1));
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      assignOption(options, key, true);
      continue;
    }
    assignOption(options, key, next);
    index += 1;
  }
  return { options, positionals };
}

function assignOption(options, key, value) {
  if (!key) {
    throw usageError("Empty option name");
  }
  if (options[key] === undefined) {
    options[key] = value;
    return;
  }
  options[key] = Array.isArray(options[key])
    ? [...options[key], value]
    : [options[key], value];
}

function parseTarget(options) {
  const conversationId = stringOption(options, "conversation");
  const handle = stringOption(options, "to");
  if (Boolean(conversationId) === Boolean(handle)) {
    throw usageError("Specify exactly one of --conversation or --to");
  }
  return {
    conversationId,
    handle,
  };
}

function integerOption(options, name, minimum, maximum, fallback) {
  if (options[name] === undefined) {
    return fallback;
  }
  const value = Number(stringOption(options, name));
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw usageError(`--${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function booleanOption(options, name) {
  if (options[name] === undefined) {
    return false;
  }
  if (options[name] !== true) {
    throw usageError(`--${name} does not take a value`);
  }
  return true;
}

function stringOption(options, name) {
  const value = options[name];
  if (value === undefined) {
    return undefined;
  }
  if (value === true || Array.isArray(value)) {
    throw usageError(`--${name} requires exactly one value`);
  }
  return String(value);
}

function rejectPositionals(positionals) {
  if (positionals.length > 0) {
    throw usageError(`Unexpected argument: ${positionals[0]}`);
  }
}

function rejectUnknownOptions(options, allowed) {
  const accepted = new Set(allowed);
  const unknown = Object.keys(options).find((name) => !accepted.has(name));
  if (unknown) {
    throw usageError(`Unknown option: --${unknown}`);
  }
}

function usageError(message) {
  const error = new Error(message);
  error.exitCode = 2;
  error.kind = "usage";
  return error;
}

function writeJson(output, value) {
  output.write(`${JSON.stringify(value, null, 2)}\n`);
}

function helpText() {
  return `xchat: local XChat CLI using the X web internal API

Usage:
  xchat doctor [--session PATH] [--chrome-cookie-db PATH]
  xchat auth import [--profile NAME] [--chrome-cookie-db PATH] [--session PATH]
  xchat auth status [--session PATH]
  xchat operations [OPERATION_NAME ...] [--session PATH]
  xchat conversations [--max-pages N] [--session PATH]
  xchat keys status [--session PATH]
  xchat keys unlock [--session PATH]
  xchat read (--conversation ID | --to HANDLE) [--chrome-chat-db PATH] [--redact] [--max-pages N] [--session PATH]
  xchat send (--conversation ID | --to HANDLE) [--text TEXT] [--dry-run | --yes] [--max-pages N] [--session PATH]

Authentication:
  auth import reads auth_token, ct0, and twid from a consistent Chrome database snapshot.
  XChat PIN is read without echo. XCHAT_PIN_FD is preferred for non-interactive use.
  --chrome-chat-db is a read-only local key source for read; messages still come from api.x.com GraphQL.

Safety:
  send asks for exact confirmation unless --yes is supplied.
  --dry-run performs no session read, network request, PIN recovery, or send.
  This tool does not use the official X API.
`;
}
