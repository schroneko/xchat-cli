import { scrubSecretText } from "./redaction.js";

const MAX_EVENT_COUNT = 1_000;
const MAX_EVENT_CHARACTERS = 2 * 1024 * 1024;
const MAX_EVENT_TOTAL_CHARACTERS = 16 * 1024 * 1024;
const MAX_THRIFT_OPERATIONS = 1_000_000;

export function normalizePublicKeys(payload) {
  const rows = payload?.data?.user_results_by_rest_ids;
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows.map((row) => {
    const publicKeys = row?.result?.get_public_keys;
    return {
      userId: String(row?.rest_id ?? ""),
      isManagedPinUser: Boolean(publicKeys?.is_managed_pin_user),
      keys: (publicKeys?.public_keys_with_token_map ?? []).map((entry) => {
        const metadata = entry?.public_key_with_metadata ?? {};
        const key = metadata?.public_key ?? {};
        return {
          version: String(metadata.version ?? ""),
          identityPublicKey: key.public_key,
          signingPublicKey: key.signing_public_key,
          identityPublicKeySignature: key.identity_public_key_signature,
          tokenMap: entry?.token_map,
        };
      }).filter((entry) => (
        entry.version
        && entry.identityPublicKey
        && entry.signingPublicKey
        && entry.identityPublicKeySignature
      )),
    };
  }).filter((row) => row.userId);
}

export function signingKeysFromPublicKeys(users) {
  return users.flatMap((user) => user.keys.map((key) => ({
    userId: user.userId,
    publicKeyVersion: key.version,
    publicKey: key.signingPublicKey,
    identityPublicKey: key.identityPublicKey,
    identityPublicKeySignature: key.identityPublicKeySignature,
  })));
}

export async function createUnlockedChat(options) {
  const users = Array.isArray(options.publicKeys)
    ? options.publicKeys
    : normalizePublicKeys(options.publicKeysResponse);
  const own = users.find((user) => user.userId === String(options.ownUserId));
  if (!own || own.keys.length === 0) {
    throw new Error("No registered XChat public key was found for this account");
  }

  const candidate = [...own.keys].sort((left, right) => (
    compareVersion(right.version, left.version)
  )).find((key) => key.tokenMap);
  if (!candidate) {
    throw new Error("XChat Juicebox configuration was not returned");
  }

  const tokenByRealm = new Map(
    (candidate.tokenMap?.token_map ?? []).map((entry) => [
      String(entry?.key ?? "").toLowerCase(),
      entry?.value?.token,
    ]),
  );
  const juicebox = prepareJuiceboxConfiguration(candidate.tokenMap);
  const createChatImpl = options.createChatImpl ?? await loadCreateChat();
  const chat = await createChatImpl({
    juiceboxConfig: JSON.stringify(juicebox.config),
    getAuthToken: async (realmId) => {
      const token = tokenByRealm.get(String(realmId).toLowerCase());
      if (!token) {
        throw new Error("Juicebox realm token was not found");
      }
      return token;
    },
    maxGuessCount: candidate.tokenMap?.max_guess_count,
  });

  try {
    await withRestrictedRealmFetch(juicebox.allowedOrigins, () => chat.unlock(options.pin));
    const registered = own.keys.find((key) => chat.matchesRegisteredKey(key.identityPublicKey));
    if (!registered) {
      throw new Error("Recovered XChat identity does not match a registered public key");
    }
    chat.setIdentity(own.userId, registered.version);
    chat.setCacheKeys(true);
    chat.setSigningKeys(signingKeysFromPublicKeys(users));
    return {
      chat,
      keyVersion: registered.version,
      ownUserId: own.userId,
      users,
    };
  } catch (error) {
    chat.free?.();
    throw error;
  }
}

export function decryptEventBatch(chat, encodedEvents) {
  if (!Array.isArray(encodedEvents) || encodedEvents.length > MAX_EVENT_COUNT) {
    throw new Error("XChat event batch exceeded the count limit");
  }
  let totalCharacters = 0;
  for (const event of encodedEvents) {
    validateEncodedEvent(event);
    totalCharacters += event.length;
    if (totalCharacters > MAX_EVENT_TOTAL_CHARACTERS) {
      throw new Error("XChat event batch exceeded the size limit");
    }
  }
  const uniqueEvents = [...new Set(encodedEvents)];
  const result = chat.decryptEvents(uniqueEvents);
  return {
    messages: result.messages.map((message) => normalizeDecryptedMessage(message)),
    errors: Object.fromEntries(Object.entries(result.errors ?? {}).map(([index, message]) => [
      index,
      scrubSecretText(String(message)),
    ])),
    conversationKeys: result.conversationKeys,
  };
}

export function encryptMessageVariables(options) {
  if (!options.conversationToken) {
    throw new Error("Conversation token was not found");
  }
  const payload = options.chat.encryptMessage({
    conversationId: options.conversationId,
    text: options.text,
  });
  return {
    messageId: payload.messageId,
    variables: {
      conversation_id: options.conversationId,
      message_id: payload.messageId,
      conversation_token: options.conversationToken,
      encoded_message_create_event: payload.encryptedContent,
      encoded_message_event_signature: payload.encodedEventSignature,
    },
  };
}

export function extractMessageEventFields(encodedEvent) {
  if (typeof encodedEvent !== "string" || encodedEvent.length === 0) {
    throw new Error("Encoded XChat event is required");
  }
  const reader = new ThriftReader(decodeEncodedEvent(encodedEvent));
  let messageId;
  let conversationId;
  let conversationToken;

  while (!reader.done()) {
    const type = reader.byte();
    if (type === 0) {
      break;
    }
    const fieldId = reader.int16();
    if ((fieldId === 2 || fieldId === 4 || fieldId === 5) && type === 11) {
      const value = reader.string();
      if (fieldId === 2) {
        messageId = value;
      } else if (fieldId === 4) {
        conversationId = value;
      } else {
        conversationToken = value;
      }
    } else {
      reader.skip(type, 0);
    }
  }

  return {
    messageId,
    conversationId,
    conversationToken,
  };
}

export function extractSendMessageResponseFields(encodedEvent) {
  const direct = extractMessageEventFields(encodedEvent);
  if (direct.messageId && direct.conversationId) {
    return direct;
  }

  const reader = new ThriftReader(decodeEncodedEvent(encodedEvent));
  while (!reader.done()) {
    const type = reader.byte();
    if (type === 0) {
      break;
    }
    const fieldId = reader.int16();
    if (fieldId === 1 && type === 11) {
      return extractMessageEventFields(reader.string());
    }
    reader.skip(type, 0);
  }
  throw new Error("XChat send response did not contain a message event");
}

export function collectConversationTokens(encodedEvents) {
  const tokens = new Map();
  for (const encodedEvent of encodedEvents) {
    let event;
    try {
      event = extractMessageEventFields(encodedEvent);
    } catch {
      continue;
    }
    if (event.conversationId && event.conversationToken) {
      const existing = tokens.get(event.conversationId);
      if (existing && existing !== event.conversationToken) {
        throw new Error("Conflicting XChat conversation tokens were returned");
      }
      tokens.set(event.conversationId, event.conversationToken);
    }
  }
  return tokens;
}

function normalizeDecryptedMessage(message) {
  const event = message.event ?? {};
  return {
    id: stringOrNull(event.messageId ?? event.id),
    sequenceId: stringOrNull(event.sequenceId),
    conversationId: stringOrNull(event.conversationId),
    senderId: stringOrNull(event.senderId),
    keyVersion: stringOrNull(event.keyVersion),
    type: event.type ?? "unknown",
    text: event.content?.text ?? null,
    createdAtMsec: stringOrNull(event.createdAtMsec),
    verified: event.verified !== false,
    originalB64: message.originalB64,
  };
}

async function loadCreateChat() {
  const module = await import("@xdevplatform/chat-xdk");
  return module.createChat;
}

function prepareJuiceboxConfiguration(tokenMap) {
  const config = JSON.parse(JSON.stringify(tokenMap));
  const allowedOrigins = new Set();
  const realmsById = new Map();

  if (config.key_store_token_map_json !== undefined) {
    let embedded;
    try {
      embedded = JSON.parse(config.key_store_token_map_json);
    } catch {
      throw new Error("XChat Juicebox configuration is invalid");
    }
    if (!embedded || typeof embedded !== "object" || Array.isArray(embedded)) {
      throw new Error("XChat Juicebox configuration is invalid");
    }
    for (const realm of embedded.realms ?? []) {
      const origin = validateRealmUrl(realm?.address);
      const id = String(realm?.id ?? "").toLowerCase();
      if (!id) {
        throw new Error("XChat Juicebox realm ID is invalid");
      }
      realmsById.set(id, origin);
      allowedOrigins.add(origin);
    }
  }

  if (!Array.isArray(config.token_map)) {
    throw new Error("XChat Juicebox token map is invalid");
  }
  for (const entry of config.token_map) {
    const id = String(entry?.key ?? "").toLowerCase();
    const origin = validateRealmUrl(entry?.value?.address);
    if (!id) {
      throw new Error("XChat Juicebox realm ID is invalid");
    }
    if (realmsById.has(id) && realmsById.get(id) !== origin) {
      throw new Error("XChat Juicebox realm address does not match its configuration");
    }
    allowedOrigins.add(origin);
    if (entry?.value && typeof entry.value === "object") {
      delete entry.value.token;
    }
  }

  return { config, allowedOrigins };
}

function validateRealmUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("XChat Juicebox realm URL is invalid");
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || (url.port && url.port !== "443")
    || (url.hostname !== "x.com" && !url.hostname.endsWith(".x.com"))
  ) {
    throw new Error("XChat Juicebox realm URL is not allowed");
  }
  return url.origin;
}

async function withRestrictedRealmFetch(allowedOrigins, operation) {
  const originalFetch = globalThis.fetch;
  if (typeof originalFetch !== "function") {
    throw new Error("Global fetch is unavailable for XChat Juicebox");
  }
  const restrictedFetch = (input, init = {}) => {
    const value = input instanceof Request ? input.url : input;
    const url = new URL(value);
    if (!allowedOrigins.has(url.origin)) {
      throw new Error("XChat Juicebox request target is not allowed");
    }
    if (input instanceof Request) {
      return originalFetch(new Request(input, {
        ...init,
        redirect: "error",
      }));
    }
    return originalFetch(input, {
      ...init,
      redirect: "error",
    });
  };
  globalThis.fetch = restrictedFetch;
  try {
    return await operation();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function compareVersion(left, right) {
  try {
    const leftValue = BigInt(left);
    const rightValue = BigInt(right);
    return leftValue === rightValue ? 0 : leftValue > rightValue ? 1 : -1;
  } catch {
    return String(left).localeCompare(String(right));
  }
}

function stringOrNull(value) {
  return value === undefined || value === null ? null : String(value);
}

class ThriftReader {
  constructor(buffer) {
    this.buffer = buffer;
    this.offset = 0;
    this.operations = 0;
  }

  done() {
    return this.offset >= this.buffer.length;
  }

  byte() {
    this.consumeOperation();
    this.require(1);
    const value = this.buffer.readUInt8(this.offset);
    this.offset += 1;
    return value;
  }

  int16() {
    this.consumeOperation();
    this.require(2);
    const value = this.buffer.readInt16BE(this.offset);
    this.offset += 2;
    return value;
  }

  int32() {
    this.consumeOperation();
    this.require(4);
    const value = this.buffer.readInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  string() {
    const length = this.containerLength();
    this.require(length);
    const value = this.buffer.subarray(this.offset, this.offset + length).toString("utf8");
    this.offset += length;
    return value;
  }

  skip(type, depth) {
    this.consumeOperation();
    if (depth > 32) {
      throw new Error("XChat event nesting is too deep");
    }

    if (type === 2 || type === 3) {
      this.advance(1);
      return;
    }
    if (type === 4 || type === 10) {
      this.advance(8);
      return;
    }
    if (type === 6) {
      this.advance(2);
      return;
    }
    if (type === 8) {
      this.advance(4);
      return;
    }
    if (type === 11 || type === 16 || type === 17) {
      this.advance(this.containerLength());
      return;
    }
    if (type === 12) {
      while (true) {
        const nestedType = this.byte();
        if (nestedType === 0) {
          return;
        }
        this.int16();
        this.skip(nestedType, depth + 1);
      }
    }
    if (type === 13) {
      const keyType = this.byte();
      const valueType = this.byte();
      const size = this.containerLength();
      for (let index = 0; index < size; index += 1) {
        this.skip(keyType, depth + 1);
        this.skip(valueType, depth + 1);
      }
      return;
    }
    if (type === 14 || type === 15) {
      const elementType = this.byte();
      const size = this.containerLength();
      for (let index = 0; index < size; index += 1) {
        this.skip(elementType, depth + 1);
      }
      return;
    }
    throw new Error(`Unsupported Thrift type: ${type}`);
  }

  containerLength() {
    const value = this.int32();
    if (value < 0 || value > 100_000) {
      throw new Error("Invalid XChat event container length");
    }
    return value;
  }

  advance(length) {
    this.require(length);
    this.offset += length;
  }

  require(length) {
    if (length < 0 || this.offset + length > this.buffer.length) {
      throw new Error("Truncated XChat event");
    }
  }

  consumeOperation() {
    this.operations += 1;
    if (this.operations > MAX_THRIFT_OPERATIONS) {
      throw new Error("XChat event exceeded the parsing limit");
    }
  }
}

function validateEncodedEvent(encodedEvent) {
  if (
    typeof encodedEvent !== "string"
    || encodedEvent.length === 0
    || encodedEvent.length > MAX_EVENT_CHARACTERS
    || encodedEvent.length % 4 === 1
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(encodedEvent)
  ) {
    throw new Error("Invalid encoded XChat event");
  }
}

function decodeEncodedEvent(encodedEvent) {
  validateEncodedEvent(encodedEvent);
  return Buffer.from(encodedEvent, "base64");
}
