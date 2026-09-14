import assert from "node:assert/strict";
import test from "node:test";
import { createChat } from "@xdevplatform/chat-xdk";
import {
  createImportedUnlockedChat,
  createUnlockedChat,
  decryptEventBatch,
} from "../src/xchat.js";

const PRIVATE_KEYS = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAg==";
const IDENTITY_PUBLIC_KEY = "BGsX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT+NC4v4af5uO5+tKfA+eFivOM1drMV7Oy7ZAaDe/UfU=";
const SIGNING_PUBLIC_KEY = "BHzyexiNA09+ilI4AwS1GsPAiWnid/IbNaYLSPxHZpl4B3dVENuO0EApPZrGn3Qw27p9reY86YIpngS3nSJ4c9E=";
const IDENTITY_SIGNATURE = "lwqF3bFJN47NLoYzSyTTCaA+eGe3g2rbDzWc120eJYV3ClHqD1NI79WKL60ciN0fBjhmuAnIq/Beq/GhPUu52A==";
const KEY_CHANGE_EVENT = "CwABAAAAATELAAIAAAAIa2MtbXNnLTELAAMAAAAEMTExMQsABAAAAAkxMTExOjIyMjILAAYAAAANMTcwMDAwMDAwMDAwMAwABwwAAwsAAQAAAAQxMDAxDwACDAAAAAELAAEAAAAEMTExMQsAAgAAAJhCR0hGdmgzaUw3VitCbGZJRnpFM0E2VDBoRjNCbVM1RHhJaWp5R3Z0NEVVbVdKK2FFdWQweGZXSHNXcFJyOVBwU3hZSS9wNHNScGlkS3pkbXFXUmpZOFlVK3pQMFlIeFZidldMNWQ4MERtbEN2TmlBUFV1Ryszbldsdmx2Z3k2VFN5UnlaakZHb3JxUzArbitGVTd6cEU0PQsAAwAAAAExAAAADAAJCwABAAAAVmVpSkx2V1V0cDY1bkxVdWVEaUJDc01FSjJmQWY1c0d4T25aQ050ZHVEaUQxWWZ1UlQzSzhTTjFBcC9yN05YamZ6cEVWaXJCaTc5Q1N2WnE5a3dKaW1nCwACAAAAATELAAMAAAABNwAA";
const MESSAGE_EVENT = "CwABAAAAATELAAIAAAAkMmMyYTFkMzItOTg4Yi00YjBlLTllNjMtYzNiYWFiMzAwM2ZkCwADAAAABDExMTELAAQAAAAJMTExMToyMjIyCwAGAAAADTE3MDAwMDAwMDAwMDAMAAcMAAELAGQAAABNyju49fSvP23md4h8MxYDM7/yP5czAJioJV+XI7e3bBM4gzkCp4+5iBBX4Jyee/0tULcB8Tkkl6qNbcRN9lWROcUxPyPGVVRp7WSqgVoLAGUAAAAEMTAwMQIAZgEAAAwACQsAAQAAAFZ4Rkk3NnA2VzZLY09jN0JGL0NLSjg4Sk5ZYnRvSitaS1VqdFFsTTNzYTRFdUdJZ1F2eHlLSG1tUkxqa0tlRUdMZkNEbU1EZDZTdlFMSTdiZVg0SFhZQQsAAgAAAAExCwADAAAAATcAAA==";

class StubJuiceboxConfiguration {
  constructor(value) {
    this.value = value;
  }
}

class StubJuiceboxClient {
  async recover() {
    return Uint8Array.from(Buffer.from(PRIVATE_KEYS, "base64"));
  }
}

test("createUnlockedChat decrypts a real SDK fixture", async () => {
  const unlocked = await createUnlockedChat({
    ownUserId: "1111",
    pin: "2580",
    publicKeys: [{
      userId: "1111",
      keys: [{
        version: "1",
        identityPublicKey: IDENTITY_PUBLIC_KEY,
        signingPublicKey: SIGNING_PUBLIC_KEY,
        identityPublicKeySignature: IDENTITY_SIGNATURE,
        tokenMap: { token_map: [] },
      }],
    }],
    createChatImpl: (options) => createChat({
      ...options,
      juiceboxModule: {
        Client: StubJuiceboxClient,
        Configuration: StubJuiceboxConfiguration,
      },
    }),
  });

  try {
    const result = decryptEventBatch(unlocked.chat, [KEY_CHANGE_EVENT, MESSAGE_EVENT]);
    const message = result.messages.find((entry) => entry.text === "fixture event message");
    assert.ok(message);
    assert.equal(message.conversationId, "1111:2222");
    assert.equal(message.senderId, "1111");
    assert.equal(message.verified, true);
    assert.deepEqual(result.errors, {});
  } finally {
    unlocked.chat.free();
  }
});

test("createImportedUnlockedChat decrypts a real SDK fixture", async () => {
  const privateKeys = Buffer.from(PRIVATE_KEYS, "base64");
  const identityKey = Buffer.from(privateKeys.subarray(0, 32));
  const signingKey = Buffer.from(privateKeys.subarray(32));
  privateKeys.fill(0);
  const unlocked = await createImportedUnlockedChat({
    ownUserId: "1111",
    keyMaterial: {
      version: "1",
      identityKey,
      signingKey,
    },
    publicKeys: [{
      userId: "1111",
      keys: [{
        version: "1",
        identityPublicKey: IDENTITY_PUBLIC_KEY,
        signingPublicKey: SIGNING_PUBLIC_KEY,
        identityPublicKeySignature: IDENTITY_SIGNATURE,
      }],
    }],
  });

  try {
    const result = decryptEventBatch(unlocked.chat, [KEY_CHANGE_EVENT, MESSAGE_EVENT]);
    const message = result.messages.find((entry) => entry.text === "fixture event message");
    assert.ok(message);
    assert.equal(message.conversationId, "1111:2222");
    assert.equal(message.senderId, "1111");
    assert.equal(message.verified, true);
    assert.deepEqual(result.errors, {});
    assert.equal(identityKey.every((value) => value === 0), true);
    assert.equal(signingKey.every((value) => value === 0), true);
  } finally {
    unlocked.chat.free();
  }
});
