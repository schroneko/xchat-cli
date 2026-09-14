import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs, runCli } from "../src/cli.js";

test("parseArgs supports positional operation names and valued options", () => {
  assert.deepEqual(parseArgs([
    "GetPublicKeys",
    "SendMessageMutation",
    "--session",
    "/fixture/session.json",
    "--redact",
  ]), {
    options: {
      session: "/fixture/session.json",
      redact: true,
    },
    positionals: ["GetPublicKeys", "SendMessageMutation"],
  });
});

test("send dry-run performs no authentication, PIN, confirmation, or network work", async () => {
  const output = memoryOutput();
  const calls = [];

  await runCli([
    "send",
    "--to",
    "ExampleUser",
    "--text",
    "fixture",
    "--dry-run",
  ], {
    stdout: output,
    loadSession: async () => {
      calls.push("session");
    },
    clientFactory: () => {
      calls.push("client");
    },
    pinProvider: async () => {
      calls.push("pin");
    },
    confirm: async () => {
      calls.push("confirm");
    },
  });

  assert.deepEqual(calls, []);
  assert.deepEqual(JSON.parse(output.value), {
    ok: true,
    dryRun: true,
    intent: {
      command: "send",
      target: {
        handle: "ExampleUser",
      },
      textLength: 7,
    },
  });
});

test("declined send stops before session access", async () => {
  const output = memoryOutput();
  let sessionCalls = 0;

  await runCli([
    "send",
    "--conversation",
    "111:222",
    "--text",
    "fixture",
  ], {
    stdout: output,
    confirm: async () => false,
    loadSession: async () => {
      sessionCalls += 1;
    },
  });

  assert.equal(sessionCalls, 0);
  assert.deepEqual(JSON.parse(output.value), {
    ok: false,
    sent: false,
    cancelled: true,
  });
});

test("send requires exactly one target and rejects ambiguous safety flags", async () => {
  await assert.rejects(
    runCli(["send", "--text", "fixture"], { stdout: memoryOutput() }),
    /exactly one/,
  );
  await assert.rejects(
    runCli([
      "send",
      "--to",
      "fixture",
      "--text",
      "fixture",
      "--yes",
      "--dry-run",
    ], { stdout: memoryOutput() }),
    /cannot be used together/,
  );
});

test("send rejects values attached to boolean safety flags", async () => {
  await assert.rejects(runCli([
    "send",
    "--to",
    "target",
    "--text",
    "hello",
    "--yes=false",
  ], {
    stdout: memoryOutput(),
  }), /does not take a value/);
  await assert.rejects(runCli([
    "send",
    "--to",
    "target",
    "--text",
    "hello",
    "--dry-run=0",
  ], {
    stdout: memoryOutput(),
  }), /does not take a value/);
});

test("send rejects unknown options", async () => {
  await assert.rejects(runCli([
    "send",
    "--to",
    "target",
    "--text",
    "hello",
    "--yess",
  ], {
    stdout: memoryOutput(),
  }), /Unknown option/);
});

test("auth import routes explicit paths without exposing cookies", async () => {
  const output = memoryOutput();
  let captured;

  await runCli([
    "auth",
    "import",
    "--session",
    "/fixture/session.json",
    "--chrome-cookie-db",
    "/fixture/Cookies",
  ], {
    stdout: output,
    importChromeSession: async (options) => {
      captured = options;
      return {
        path: options.sessionPath,
        imported: {
          authToken: true,
          ct0: true,
          twid: true,
        },
      };
    },
  });

  assert.equal(captured.sessionPath, "/fixture/session.json");
  assert.equal(captured.cookieDb, "/fixture/Cookies");
  assert.doesNotMatch(output.value, /secret|cookie-value/);
});

test("read routes --chrome-chat-db without requesting a PIN", async () => {
  const output = memoryOutput();
  const calls = [];
  let captured;

  await runCli([
    "read",
    "--conversation",
    "111:222",
    "--chrome-chat-db",
    "/fixture/chat.db",
  ], {
    stdout: output,
    env: {},
    loadSession: async () => ({ twid: "u=111" }),
    clientFactory: () => ({ fixture: true }),
    pinProvider: async () => {
      calls.push("pin");
      return "2580";
    },
    readConversationImpl: async (options) => {
      captured = options;
      return {
        conversation: { id: "111:222" },
        messages: [],
        errors: {},
        hasMore: false,
      };
    },
  });

  assert.deepEqual(calls, []);
  assert.equal(captured.chromeChatDb, "/fixture/chat.db");
  assert.equal(captured.pin, undefined);
  assert.deepEqual(JSON.parse(output.value).messages, []);
});

test("read rejects --chrome-chat-db with either PIN environment variable", async () => {
  for (const env of [
    { XCHAT_PIN: "2580" },
    { XCHAT_PIN_FD: "3" },
  ]) {
    let sessionCalls = 0;
    await assert.rejects(runCli([
      "read",
      "--conversation",
      "111:222",
      "--chrome-chat-db",
      "/fixture/chat.db",
    ], {
      stdout: memoryOutput(),
      env,
      loadSession: async () => {
        sessionCalls += 1;
      },
    }), /cannot be combined/);
    assert.equal(sessionCalls, 0);
  }
});

test("read rejects an empty --chrome-chat-db path", async () => {
  await assert.rejects(runCli([
    "read",
    "--conversation",
    "111:222",
    "--chrome-chat-db=",
  ], {
    stdout: memoryOutput(),
    env: {},
  }), /non-empty path/);
});

test("read keeps PIN routing when --chrome-chat-db is absent", async () => {
  let captured;
  await runCli([
    "read",
    "--conversation",
    "111:222",
  ], {
    stdout: memoryOutput(),
    env: {},
    loadSession: async () => ({ twid: "u=111" }),
    clientFactory: () => ({}),
    pinProvider: async () => "2580",
    readConversationImpl: async (options) => {
      captured = options;
      return {
        conversation: { id: "111:222" },
        messages: [],
        errors: {},
        hasMore: false,
      };
    },
  });

  assert.equal(captured.pin, "2580");
  assert.equal(captured.chromeChatDb, undefined);
});

function memoryOutput() {
  return {
    value: "",
    write(chunk) {
      this.value += chunk;
    },
  };
}
