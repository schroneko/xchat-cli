import assert from "node:assert/strict";
import test from "node:test";
import {
  applyMessageEdits,
  fetchInbox,
  publicConversation,
  resolveConversation,
  validateSendMutationResponse,
} from "../src/service.js";

test("applyMessageEdits uses the final verified edit without losing unresolved edits", () => {
  const messages = [
    {
      id: "message-id",
      sequenceId: "100",
      senderId: "111",
      contentType: "text",
      text: "108",
      createdAtMsec: "1",
      verified: true,
    },
    {
      id: "edit-one",
      sequenceId: "101",
      senderId: "111",
      contentType: "edit",
      targetMessageId: "100",
      newText: "1089",
      createdAtMsec: "2",
      verified: true,
    },
    {
      id: "edit-two",
      sequenceId: "102",
      senderId: "111",
      contentType: "edit",
      targetMessageId: "100",
      newText: "1089元\nGORO",
      createdAtMsec: "3",
      verified: true,
    },
    {
      id: "unresolved",
      sequenceId: "103",
      senderId: "111",
      contentType: "edit",
      targetMessageId: "missing",
      newText: "preserved",
      createdAtMsec: "4",
      verified: true,
    },
  ];

  const result = applyMessageEdits(messages);

  assert.equal(result.length, 2);
  assert.equal(result[0].text, "1089元\nGORO");
  assert.equal(result[0].editedAtMsec, "3");
  assert.equal(result[1].id, "unresolved");
  assert.equal(messages[0].text, "108");
});

test("fetchInbox normalizes internal response and paginates with cursor", async () => {
  const calls = [];
  const client = {
    get: async (operation, variables) => {
      calls.push({ operation, variables });
      if (operation === "GetInitialXChatPageQuery") {
        return {
          data: {
            get_initial_chat_page: {
              inboxCursor: {
                cursor_id: "cursor",
                graph_snapshot_id: "snapshot",
                pull_finished: false,
              },
              items: [conversationItem("111:222", "target")],
              has_message_requests: true,
            },
          },
        };
      }
      return {
        data: {
          get_inbox_page: {
            inboxCursor: {
              pull_finished: true,
            },
            items: [conversationItem("111:333", "other")],
          },
        },
      };
    },
  };

  const inbox = await fetchInbox(client, { maxPages: 2 });

  assert.equal(inbox.conversations.length, 2);
  assert.equal(inbox.complete, true);
  assert.equal(inbox.hasMessageRequests, true);
  assert.equal(calls[1].operation, "GetInboxPageRequestQuery");
  assert.equal(calls[1].variables.continue_cursor.cursor_id, "cursor");
});

test("fetchInbox rejects partial page errors", async () => {
  const client = {
    get: async () => ({
      data: {
        get_initial_chat_page: {
          inboxCursor: {
            pull_finished: true,
          },
          items: [],
          errors: [{ message: "partial" }],
        },
      },
    }),
  };

  await assert.rejects(fetchInbox(client), /partial errors/);
});

test("resolveConversation prefers a one-to-one match over groups", () => {
  const direct = {
    id: "111:222",
    isGroup: false,
    participants: [{ handle: "ExampleUser" }],
  };
  const group = {
    id: "g1",
    isGroup: true,
    participants: [{ handle: "ExampleUser" }],
  };
  const inbox = {
    conversations: [group, direct],
  };

  assert.equal(resolveConversation(inbox, { handle: "@exampleuser" }), direct);
});

test("resolveConversation never resolves a handle to a group", () => {
  const inbox = {
    conversations: [{
      id: "g1",
      isGroup: true,
      participants: [{ handle: "ExampleUser" }],
    }],
  };

  assert.throws(() => resolveConversation(inbox, {
    handle: "ExampleUser",
  }), /No one-to-one/);
});

test("publicConversation excludes encrypted event material", () => {
  const output = publicConversation({
    id: "111:222",
    name: "Target",
    isGroup: false,
    isMuted: false,
    participants: [],
    hasMore: true,
    encodedEvents: ["secret-ciphertext"],
  });

  assert.equal(output.id, "111:222");
  assert.equal("encodedEvents" in output, false);
  assert.doesNotMatch(JSON.stringify(output), /secret-ciphertext/);
});

test("validateSendMutationResponse verifies the echoed target and message ID", () => {
  const encoded = Buffer.concat([
    thriftStringField(2, "message-id"),
    thriftStringField(4, "111:222"),
    Buffer.from([0]),
  ]).toString("base64");
  const response = {
    data: {
      xchat_send_create_message_event: {
        encoded_message_event: encoded,
      },
    },
  };

  assert.equal(validateSendMutationResponse(response, {
    conversationId: "111:222",
    messageId: "message-id",
  }).messageId, "message-id");
  assert.throws(() => validateSendMutationResponse(response, {
    conversationId: "111:333",
    messageId: "message-id",
  }), /conversation does not match/);
  assert.throws(() => validateSendMutationResponse({}, {
    conversationId: "111:222",
    messageId: "message-id",
  }), /did not contain/);
});

function conversationItem(id, handle) {
  return {
    conversation_detail: {
      conversation_id: id,
      participants_results: [{
        rest_id: id.split(":").at(-1),
        result: {
          rest_id: id.split(":").at(-1),
          core: {
            screen_name: handle,
            name: handle,
          },
        },
      }],
    },
    latest_message_events: ["encoded-event"],
    has_more: true,
  };
}

function thriftStringField(id, value) {
  const text = Buffer.from(value);
  const header = Buffer.alloc(7);
  header.writeUInt8(11, 0);
  header.writeInt16BE(id, 1);
  header.writeInt32BE(text.length, 3);
  return Buffer.concat([header, text]);
}
