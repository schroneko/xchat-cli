import assert from "node:assert/strict";
import test from "node:test";
import {
  collectConversationTokens,
  createUnlockedChat,
  encryptMessageVariables,
  extractMessageEventFields,
  extractSendMessageResponseFields,
  normalizePublicKeys,
} from "../src/xchat.js";

test("normalizePublicKeys maps X response fields to SDK fields", () => {
  const output = normalizePublicKeys(publicKeyResponse());

  assert.equal(output[0].userId, "111");
  assert.equal(output[0].keys[0].version, "7");
  assert.equal(output[0].keys[0].identityPublicKey, "identity-public");
  assert.equal(output[0].keys[0].signingPublicKey, "signing-public");
});

test("createUnlockedChat verifies identity and configures the SDK", async () => {
  const calls = [];
  const fakeChat = {
    unlock: async (pin) => calls.push(["unlock", pin]),
    matchesRegisteredKey: (key) => key === "identity-public",
    setIdentity: (...args) => calls.push(["identity", ...args]),
    setCacheKeys: (...args) => calls.push(["cache", ...args]),
    setSigningKeys: (...args) => calls.push(["signing", ...args]),
    free: () => calls.push(["free"]),
  };

  const result = await createUnlockedChat({
    publicKeysResponse: publicKeyResponse(),
    ownUserId: "111",
    pin: "2580",
    createChatImpl: async (options) => {
      assert.equal(await options.getAuthToken("REALM"), "realm-token");
      assert.doesNotMatch(options.juiceboxConfig, /realm-token/);
      return fakeChat;
    },
  });

  assert.equal(result.keyVersion, "7");
  assert.deepEqual(calls[0], ["unlock", "2580"]);
  assert.deepEqual(calls[1], ["identity", "111", "7"]);
  assert.deepEqual(calls[2], ["cache", true]);
  assert.equal(calls[3][0], "signing");
});

test("createUnlockedChat rejects non-X Juicebox realms", async () => {
  const response = publicKeyResponse();
  response.data.user_results_by_rest_ids[0]
    .result.get_public_keys.public_keys_with_token_map[0]
    .token_map.token_map[0].value.address = "https://127.0.0.1";

  await assert.rejects(createUnlockedChat({
    publicKeysResponse: response,
    ownUserId: "111",
    pin: "2580",
    createChatImpl: async () => {
      throw new Error("must not be called");
    },
  }), /not allowed/);
});

test("extractMessageEventFields reads conversation ID and token", () => {
  const encoded = Buffer.concat([
    thriftStringField(2, "message-id"),
    thriftStringField(4, "111:222"),
    thriftStringField(5, "conversation-token"),
    Buffer.from([0]),
  ]).toString("base64");

  assert.deepEqual(extractMessageEventFields(encoded), {
    messageId: "message-id",
    conversationId: "111:222",
    conversationToken: "conversation-token",
  });
  assert.equal(collectConversationTokens([encoded]).get("111:222"), "conversation-token");
});

test("collectConversationTokens rejects conflicting tokens", () => {
  const first = Buffer.concat([
    thriftStringField(4, "111:222"),
    thriftStringField(5, "token-one"),
    Buffer.from([0]),
  ]).toString("base64");
  const second = Buffer.concat([
    thriftStringField(4, "111:222"),
    thriftStringField(5, "token-two"),
    Buffer.from([0]),
  ]).toString("base64");

  assert.throws(() => collectConversationTokens([first, second]), /Conflicting/);
});

test("extractSendMessageResponseFields accepts direct and wrapped events", () => {
  const direct = Buffer.concat([
    thriftStringField(2, "message-id"),
    thriftStringField(4, "111:222"),
    Buffer.from([0]),
  ]).toString("base64");
  const wrapped = Buffer.concat([
    thriftStringField(1, direct),
    Buffer.from([0]),
  ]).toString("base64");

  assert.equal(extractSendMessageResponseFields(direct).messageId, "message-id");
  assert.equal(extractSendMessageResponseFields(wrapped).conversationId, "111:222");
});

test("Thrift decoder skips unrelated nested fields", () => {
  const nested = Buffer.concat([
    Buffer.from([12, 0, 9]),
    thriftStringField(1, "ignored"),
    Buffer.from([0]),
    thriftStringField(4, "111:222"),
    thriftStringField(5, "token"),
    Buffer.from([0]),
  ]).toString("base64");

  assert.equal(extractMessageEventFields(nested).conversationToken, "token");
});

test("Thrift decoder rejects invalid and oversized encoded events", () => {
  assert.throws(() => extractMessageEventFields("not base64!"), /Invalid encoded/);
  assert.throws(
    () => extractMessageEventFields("A".repeat((2 * 1024 * 1024) + 4)),
    /Invalid encoded/,
  );
});

test("encryptMessageVariables maps SDK output to internal mutation variables", () => {
  const output = encryptMessageVariables({
    chat: {
      encryptMessage: () => ({
        messageId: "message-id",
        encryptedContent: "encrypted-event",
        encodedEventSignature: "encoded-signature",
      }),
    },
    conversationId: "111:222",
    conversationToken: "token",
    text: "hello",
  });

  assert.deepEqual(output, {
    messageId: "message-id",
    variables: {
      conversation_id: "111:222",
      message_id: "message-id",
      conversation_token: "token",
      encoded_message_create_event: "encrypted-event",
      encoded_message_event_signature: "encoded-signature",
    },
  });
});

function thriftStringField(id, value) {
  const text = Buffer.from(value);
  const header = Buffer.alloc(7);
  header.writeUInt8(11, 0);
  header.writeInt16BE(id, 1);
  header.writeInt32BE(text.length, 3);
  return Buffer.concat([header, text]);
}

function publicKeyResponse() {
  return {
    data: {
      user_results_by_rest_ids: [{
        rest_id: "111",
        result: {
          get_public_keys: {
            is_managed_pin_user: true,
            public_keys_with_token_map: [{
              public_key_with_metadata: {
                version: "7",
                public_key: {
                  public_key: "identity-public",
                  signing_public_key: "signing-public",
                  identity_public_key_signature: "identity-signature",
                },
              },
              token_map: {
                key_store_token_map_json: "{}",
                max_guess_count: 20,
                token_map: [{
                  key: "realm",
                  value: {
                    token: "realm-token",
                    address: "https://realm-b.x.com",
                  },
                }],
              },
            }],
          },
        },
      }],
    },
  };
}
