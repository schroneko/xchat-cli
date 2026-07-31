import assert from "node:assert/strict";
import test from "node:test";
import { redact, redactError, scrubSecretText } from "../src/redaction.js";

test("redact removes nested credentials without mutating input", () => {
  const input = {
    authToken: "secret-auth",
    nested: {
      ct0: "secret-csrf",
      safe: "visible",
      token_map: [{ value: { token: "secret-realm" } }],
    },
  };

  const output = redact(input);

  assert.equal(output.authToken, "[redacted]");
  assert.equal(output.nested.ct0, "[redacted]");
  assert.equal(output.nested.safe, "visible");
  assert.equal(output.nested.token_map, "[redacted]");
  assert.equal(input.authToken, "secret-auth");
});

test("redact optionally removes message text by code point count", () => {
  const output = redact({
    text: "ねこ",
    new_text: "a",
    nested: [{ messageText: "x" }],
  }, { messages: true });

  assert.deepEqual(output, {
    text: "[redacted:2]",
    new_text: "[redacted:1]",
    nested: [{ messageText: "[redacted:1]" }],
  });
});

test("scrubSecretText removes common header and cookie forms", () => {
  const value = "authorization: Bearer abc cookie=auth_token=one; ct0=two auth_token=three";
  const output = scrubSecretText(value);

  assert.doesNotMatch(output, /abc|one|two|three/);
});

test("scrubSecretText removes PIN, password, token, and standalone Bearer values", () => {
  const output = scrubSecretText(
    "PIN=2580 token=abc conversation_token=xyz password=h Bearer public-but-sensitive",
  );

  assert.doesNotMatch(output, /2580|abc|xyz|password=h|public-but-sensitive/);
});

test("redactError exposes classification but not secrets", () => {
  const error = new Error("request failed auth_token=secret");
  error.status = 401;
  error.kind = "authentication";
  error.details = {
    cookie: "auth_token=secret",
    endpoint: "https://api.x.com/graphql/id/name",
  };

  const output = redactError(error);

  assert.equal(output.status, 401);
  assert.equal(output.kind, "authentication");
  assert.equal(output.details.cookie, "[redacted]");
  assert.doesNotMatch(JSON.stringify(output), /secret/);
});
