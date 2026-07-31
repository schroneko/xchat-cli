import assert from "node:assert/strict";
import test from "node:test";
import {
  XApiError,
  XWebClient,
  buildCookieHeader,
  buildGraphqlGetUrl,
  buildGraphqlPostBody,
  parseOperationMetadata,
  readResponseText,
  requestJson,
} from "../src/x-api.js";

const session = {
  authToken: "auth-secret",
  ct0: "csrf-secret",
  twid: "u%3D123",
};

test("buildCookieHeader preserves encoded cookie values", () => {
  assert.equal(
    buildCookieHeader(session),
    "auth_token=auth-secret; ct0=csrf-secret; twid=u%3D123",
  );
});

test("parseOperationMetadata reads minified operation metadata", () => {
  const source = 'a={queryId:"wrong-id",operationName:"Other"},e.exports={queryId:"fixture-id",operationName:"GetPublicKeys",operationType:"query",metadata:{featureSwitches:["one","two"],fieldToggles:["field"]}}';
  const output = parseOperationMetadata(source, ["GetPublicKeys"]);

  assert.deepEqual(output.GetPublicKeys, {
    queryId: "fixture-id",
    operationName: "GetPublicKeys",
    operationType: "query",
    features: { one: true, two: true },
    fieldToggles: { field: true },
    source: "bundle",
  });
});

test("GraphQL builders preserve string IDs and Apollo payload shape", () => {
  const operation = {
    queryId: "fixture-query",
    operationName: "SendMessageMutation",
  };
  const getUrl = buildGraphqlGetUrl(operation, {
    conversation_id: "111:222",
    sequence_id: "9223372036854775807",
  });
  const variables = JSON.parse(getUrl.searchParams.get("variables"));

  assert.equal(getUrl.origin, "https://api.x.com");
  assert.equal(getUrl.pathname, "/graphql/fixture-query/SendMessageMutation");
  assert.equal(variables.sequence_id, "9223372036854775807");

  assert.deepEqual(buildGraphqlPostBody(operation, {
    conversation_id: "111:222",
  }), {
    operationName: "SendMessageMutation",
    variables: {
      conversation_id: "111:222",
    },
    extensions: {
      persistedQuery: {
        version: 1,
        sha256Hash: "fixture-query",
      },
      clientLibrary: {
        name: "apollo-kotlin",
        version: "4.3.3",
      },
    },
  });
});

test("requestJson retries 429 and honors retry-after", async () => {
  const waits = [];
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      return response(429, { errors: [{ message: "limited" }] }, { "retry-after": "2" });
    }
    return response(200, { data: { ok: true } });
  };

  const output = await requestJson("https://api.x.com/graphql/id/name", {
    fetchImpl,
    delay: async (milliseconds) => waits.push(milliseconds),
    maxAttempts: 2,
  });

  assert.equal(calls, 2);
  assert.deepEqual(waits, [2000]);
  assert.deepEqual(output, { data: { ok: true } });
});

test("requestJson rejects HTTP 200 GraphQL errors", async () => {
  await assert.rejects(
    requestJson("https://api.x.com/graphql/id/name", {
      fetchImpl: async () => response(200, {
        errors: [{ message: "operation failed" }],
      }),
    }),
    (error) => error instanceof XApiError && error.kind === "graphql",
  );
});

test("readResponseText enforces body size and timeout limits", async () => {
  await assert.rejects(
    readResponseText(new Response("12345"), { maxResponseBytes: 4 }),
    (error) => error instanceof XApiError && error.kind === "protocol",
  );
  await assert.rejects(
    readResponseText({
      status: 200,
      headers: { get: () => null },
      text: () => new Promise(() => {}),
    }, { timeoutMs: 1 }),
    (error) => error instanceof XApiError && error.kind === "timeout",
  );
});

test("XWebClient sends internal GraphQL requests without official API paths", async () => {
  let captured;
  const client = new XWebClient({
    session,
    metadata: {
      bearer: "Bearer fixture-bearer",
      operations: {
        GetConversationPageQuery: {
          queryId: "fixture-id",
          operationName: "GetConversationPageQuery",
        },
      },
    },
    fetchImpl: async (url, options) => {
      captured = { url: String(url), options };
      return response(200, { data: { ok: true } });
    },
  });

  await client.get("GetConversationPageQuery", {
    conversation_id: "111:222",
  });

  assert.match(captured.url, /^https:\/\/api\.x\.com\/graphql\//);
  assert.doesNotMatch(captured.url, /\/2\//);
  assert.equal(captured.options.method, "GET");
  assert.equal(captured.options.headers.authorization, "Bearer fixture-bearer");
});

test("XWebClient does not retry mutations after an uncertain response", async () => {
  let calls = 0;
  const client = new XWebClient({
    session,
    maxAttempts: 3,
    metadata: {
      bearer: "Bearer fixture-bearer",
      operations: {
        SendMessageMutation: {
          queryId: "fixture-id",
          operationName: "SendMessageMutation",
        },
      },
    },
    fetchImpl: async () => {
      calls += 1;
      return response(503, { errors: [{ message: "unavailable" }] });
    },
  });

  await assert.rejects(client.post("SendMessageMutation", {}, { maxAttempts: 3 }));
  assert.equal(calls, 1);
});

function response(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => headers[name.toLowerCase()],
    },
    text: async () => JSON.stringify(body),
  };
}
