import { loadChromeChatKeys } from "./chrome-chat-keys.js";
import {
  collectConversationTokens,
  createImportedUnlockedChat,
  createUnlockedChat,
  decryptEventBatch,
  encryptMessageVariables,
  extractSendMessageResponseFields,
  normalizePublicKeys,
} from "./xchat.js";

export const DEFAULT_QUERY_SETTINGS = Object.freeze({
  inbox_conversation_event_limit: 5,
  inbox_conversation_limit: 20,
  conversation_event_limit: 200,
  user_event_limit: 500,
});

export const DEFAULT_MESSAGE_PULL_VERSION = 1761251295;

export async function fetchInbox(client, options = {}) {
  const initialVariables = {
    query_settings: DEFAULT_QUERY_SETTINGS,
    message_pull_version: options.messagePullVersion ?? DEFAULT_MESSAGE_PULL_VERSION,
  };
  if (options.maxLocalSequenceId) {
    initialVariables.max_local_sequence_id = String(options.maxLocalSequenceId);
  }

  const initial = await client.get("GetInitialXChatPageQuery", initialVariables);
  const pages = [requireInboxPage(initial, ["data", "get_initial_chat_page"])];
  const maxPages = options.maxPages ?? 5;

  while (pages.length < maxPages) {
    const previous = pages.at(-1);
    const cursor = previous?.inboxCursor;
    if (!cursor || cursor.pull_finished || !cursor.cursor_id || !cursor.graph_snapshot_id) {
      break;
    }
    const response = await client.get("GetInboxPageRequestQuery", {
      continue_cursor: {
        cursor_id: cursor.cursor_id,
        graph_snapshot_id: cursor.graph_snapshot_id,
      },
      query_settings: DEFAULT_QUERY_SETTINGS,
    });
    pages.push(requireInboxPage(response, ["data", "get_inbox_page"]));
  }

  const conversations = [];
  const seen = new Set();
  for (const page of pages) {
    for (const item of page.items ?? []) {
      const conversation = normalizeConversation(item);
      if (!conversation.id || seen.has(conversation.id)) {
        continue;
      }
      seen.add(conversation.id);
      conversations.push(conversation);
    }
  }

  return {
    conversations,
    hasMessageRequests: pages.some((page) => page.has_message_requests),
    pageCount: pages.length,
    complete: Boolean(pages.at(-1)?.inboxCursor?.pull_finished),
    messagePullVersion: pages.at(-1)?.message_pull_version ?? initialVariables.message_pull_version,
    maxUserSequenceId: pages.at(-1)?.max_user_sequence_id ?? null,
  };
}

export async function readConversation(options) {
  const context = await loadConversationContext(options);
  try {
    const decrypted = decryptEventBatch(context.unlocked.chat, context.encodedEvents);
    const messages = applyMessageEdits(decrypted.messages
      .filter((message) => message.conversationId === context.conversation.id)
      .sort(compareMessages));
    return {
      conversation: publicConversation(context.conversation),
      messages,
      errors: decrypted.errors,
      hasMore: context.hasMore,
    };
  } finally {
    context.unlocked.chat.free?.();
  }
}

export function applyMessageEdits(messages) {
  const materialized = messages.map((message) => ({ ...message }));
  const targets = new Map();
  for (const message of materialized) {
    if (message.contentType === "edit") {
      continue;
    }
    if (message.id) {
      targets.set(message.id, message);
    }
    if (message.sequenceId) {
      targets.set(message.sequenceId, message);
    }
  }

  const resolved = new Set();
  for (const message of materialized) {
    if (
      message.contentType !== "edit"
      || !message.verified
      || !message.targetMessageId
      || typeof message.newText !== "string"
    ) {
      continue;
    }
    const target = targets.get(message.targetMessageId);
    if (!target || target.senderId !== message.senderId) {
      continue;
    }
    target.text = message.newText;
    target.editedAtMsec = message.createdAtMsec;
    resolved.add(message);
  }

  return materialized.filter((message) => !resolved.has(message));
}

export async function sendMessage(options) {
  const context = await loadConversationContext(options);
  try {
    const decrypted = decryptEventBatch(context.unlocked.chat, context.encodedEvents);
    let conversationToken = collectConversationTokens(
      decrypted.messages
        .filter((message) => message.verified)
        .map((message) => message.originalB64),
    ).get(context.conversation.id);

    if (!conversationToken) {
      const response = await options.client.get("GetInboxPageConversationDataRequestQuery", {
        conversation_id: context.conversation.id,
        include_user_public_keys: false,
      });
      const item = requirePath(response, [
        "data",
        "get_inbox_page_conversation_data",
        "data",
      ]);
      const supplemental = encodedEventsFromItem(item);
      const supplementalDecrypted = decryptEventBatch(context.unlocked.chat, supplemental);
      conversationToken = collectConversationTokens(
        supplementalDecrypted.messages
          .filter((message) => message.verified)
          .map((message) => message.originalB64),
      ).get(context.conversation.id);
    }

    const encrypted = encryptMessageVariables({
      chat: context.unlocked.chat,
      conversationId: context.conversation.id,
      conversationToken,
      text: options.text,
    });
    const response = await options.client.post("SendMessageMutation", encrypted.variables);
    validateSendMutationResponse(response, {
      conversationId: context.conversation.id,
      messageId: encrypted.messageId,
    });
    return {
      ok: true,
      conversationId: context.conversation.id,
      messageId: encrypted.messageId,
    };
  } finally {
    context.unlocked.chat.free?.();
  }
}

export function validateSendMutationResponse(response, expected) {
  const encodedEvent = response?.data?.xchat_send_create_message_event?.encoded_message_event;
  if (!encodedEvent) {
    throw new Error("XChat send response did not contain an encoded message event");
  }
  const event = extractSendMessageResponseFields(encodedEvent);
  if (event.conversationId !== expected.conversationId) {
    throw new Error("XChat send response conversation does not match the request");
  }
  if (event.messageId !== expected.messageId) {
    throw new Error("XChat send response message ID does not match the request");
  }
  return event;
}

export async function checkKeys(options) {
  const response = await fetchPublicKeys(
    options.client,
    [options.ownUserId],
    { includeJuiceboxTokens: Boolean(options.pin) },
  );
  const publicKeys = normalizePublicKeys(response);
  const own = publicKeys.find((user) => user.userId === String(options.ownUserId));
  if (!options.pin) {
    return {
      registered: Boolean(own?.keys.length),
      managedPin: Boolean(own?.isManagedPinUser),
      versions: own?.keys.map((key) => key.version) ?? [],
    };
  }

  const unlocked = await createUnlockedChat({
    publicKeys,
    ownUserId: options.ownUserId,
    pin: options.pin,
    createChatImpl: options.createChatImpl,
  });
  try {
    return {
      registered: true,
      managedPin: Boolean(own?.isManagedPinUser),
      unlocked: true,
      keyVersion: unlocked.keyVersion,
      fingerprint: unlocked.chat.getPublicKeyFingerprint?.() ?? null,
    };
  } finally {
    unlocked.chat.free?.();
  }
}

export function resolveConversation(inbox, options) {
  if (options.conversationId) {
    const match = inbox.conversations.find((conversation) => conversation.id === options.conversationId);
    if (!match) {
      throw new Error(`Conversation was not found: ${options.conversationId}`);
    }
    return match;
  }

  const handle = normalizeHandle(options.handle);
  if (!handle) {
    throw new Error("A conversation ID or handle is required");
  }
  const matches = inbox.conversations.filter((conversation) => (
    conversation.participants.some((participant) => (
      participant.handle?.toLowerCase() === handle
    ))
  ));
  if (matches.length === 0) {
    throw new Error(`No existing XChat conversation was found for @${handle}`);
  }
  const directMatches = matches.filter((conversation) => !conversation.isGroup);
  if (directMatches.length === 1) {
    return directMatches[0];
  }
  if (directMatches.length > 1) {
    throw new Error(`Multiple one-to-one XChat conversations matched @${handle}; use a conversation ID`);
  }
  throw new Error(`No one-to-one XChat conversation was found for @${handle}; use a conversation ID for a group`);
}

export function publicConversation(conversation) {
  return {
    id: conversation.id,
    name: conversation.name,
    isGroup: conversation.isGroup,
    isMuted: conversation.isMuted,
    participants: conversation.participants,
    hasMore: conversation.hasMore,
  };
}

async function loadConversationContext(options) {
  const inbox = options.inbox ?? await fetchInbox(options.client, {
    maxPages: options.maxInboxPages,
  });
  const conversation = options.conversation ?? resolveConversation(inbox, {
    conversationId: options.conversationId,
    handle: options.handle,
  });
  const response = await options.client.get("GetConversationPageQuery", {
    conversation_id: conversation.id,
    min_local_sequence_id: "9223372036854775807",
    min_conversation_key_version: "9223372036854775807",
    query_settings: DEFAULT_QUERY_SETTINGS,
  });
  const page = requirePath(response, ["data", "get_conversation_page"]);
  const participantIds = [...new Set([
    String(options.ownUserId),
    ...conversation.participants.map((participant) => participant.id),
  ].filter(Boolean))];
  const publicKeysResponse = await fetchPublicKeys(options.client, participantIds, {
    includeJuiceboxTokens: !options.chromeChatDb,
  });
  const unlocked = options.chromeChatDb
    ? await createImportedUnlockedChat({
      publicKeysResponse,
      ownUserId: options.ownUserId,
      keyMaterial: await (options.loadChromeChatKeysImpl ?? loadChromeChatKeys)(
        options.chromeChatDb,
      ),
      createChatImpl: options.createImportedChatImpl,
    })
    : await createUnlockedChat({
      publicKeysResponse,
      ownUserId: options.ownUserId,
      pin: options.pin,
      createChatImpl: options.createChatImpl,
    });
  const encodedEvents = [...new Set([
    ...conversation.encodedEvents,
    ...(page.missing_conversation_key_change_events ?? []),
    ...(page.encoded_message_events ?? []),
  ].filter(Boolean))];

  return {
    conversation,
    encodedEvents,
    hasMore: Boolean(page.has_more),
    unlocked,
  };
}

async function fetchPublicKeys(client, userIds, options = {}) {
  const chunks = [];
  for (let index = 0; index < userIds.length; index += 50) {
    chunks.push(userIds.slice(index, index + 50));
  }
  const responses = [];
  for (const ids of chunks) {
    responses.push(await client.get("GetPublicKeys", {
      ids,
      include_juicebox_tokens: options.includeJuiceboxTokens ?? true,
    }));
  }
  return {
    data: {
      user_results_by_rest_ids: responses.flatMap((response) => (
        response?.data?.user_results_by_rest_ids ?? []
      )),
    },
  };
}

function normalizeConversation(item) {
  const detail = item?.conversation_detail ?? {};
  const participants = (detail.participants_results ?? []).map(normalizeParticipant).filter(Boolean);
  const group = detail.group_metadata;
  return {
    id: String(detail.conversation_id ?? ""),
    name: group?.group_name || participants.map((participant) => participant.name || `@${participant.handle}`).filter(Boolean).join(", "),
    isGroup: Boolean(group),
    isMuted: Boolean(detail.is_muted),
    participants,
    hasMore: Boolean(item?.has_more),
    encodedEvents: encodedEventsFromItem(item),
  };
}

function normalizeParticipant(entry) {
  const result = entry?.result ?? entry;
  const id = result?.rest_id ?? entry?.rest_id;
  if (!id) {
    return null;
  }
  return {
    id: String(id),
    handle: result?.core?.screen_name ?? null,
    name: result?.core?.name ?? null,
    avatarUrl: result?.avatar?.image_url ?? null,
  };
}

function encodedEventsFromItem(item) {
  return [
    ...(item?.latest_conversation_key_change_events ?? []),
    ...(item?.latest_message_events ?? []),
    ...(item?.encoded_message_events ?? []),
    item?.latest_notifiable_message_create_event,
    item?.conversation_detail?.latest_group_title_change_message_event,
    ...(item?.latest_read_events_per_participant ?? []).map((event) => (
      event?.latest_mark_conversation_read_event
    )),
  ].filter(Boolean);
}

function normalizeHandle(value) {
  if (!value) {
    return "";
  }
  return String(value).trim().replace(/^@/, "").toLowerCase();
}

function requirePath(value, path) {
  let current = value;
  for (const key of path) {
    current = current?.[key];
  }
  if (!current) {
    throw new Error(`X internal API response is missing ${path.join(".")}`);
  }
  return current;
}

function requireInboxPage(value, path) {
  const page = requirePath(value, path);
  if (Array.isArray(page.errors) && page.errors.length > 0) {
    throw new Error("X internal inbox page returned partial errors");
  }
  return page;
}

function compareMessages(left, right) {
  try {
    return Number(BigInt(left.sequenceId ?? "0") - BigInt(right.sequenceId ?? "0"));
  } catch {
    return String(left.sequenceId ?? "").localeCompare(String(right.sequenceId ?? ""));
  }
}
