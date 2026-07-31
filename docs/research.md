# XChat internal protocol research

Date: 2026-07-31

## Scope

調査対象は X Web client が使う `https://api.x.com/graphql` と `wss://chat-ws.x.com/ws` の非公開 protocol。CLI runtime は同じ Cookie session で GraphQL だけを実行し、WebSocket には接続しない。公式 X API の `/2` endpoint は対象外。

## Observed operation catalog

| Operation | Method | Query ID |
| --- | --- | --- |
| `GenerateXChatTokenMutation` | POST | `Qh3fZRjPPtPoHYR_2sCZsA` |
| `SendMessageMutation` | POST | `LkAIEchf8AGj-WgeLoTVcw` |
| `DeleteMessageMutation` | POST | `4gsDQKEmYkOtvsSIpHXdQA` |
| `MuteConversation` | POST | `Dy7geJg7CL5dqhsl6QBteg` |
| `UnmuteConversation` | POST | `LnNSeGu4vnbwqXAvh7OlGQ` |
| `ConversationDeletion` | POST | `9nsAnKrQvpifR3UmdtIdOg` |
| `GetInitialXChatPageQuery` | GET | `Gl7r1aY59L7jLBjVC98lqg` |
| `GetInboxPageRequestQuery` | GET | `wmieJEOHm6twV06EXwRdiA` |
| `GetInboxPageConversationDataRequestQuery` | GET | `uQEDp5FgdqNiG2jT5q07Jw` |
| `GetUsersByIdsForXChat` | GET | `MnzVKPEXUx3X1VRCyjKlMA` |
| `GetConversationPageQuery` | GET | `IVlXls9JTnbgQ1gxsGAfJA` |
| `GetPublicKeys` | GET | `RQAjOoIX9dIsHoVjuVV0Iw` |
| `AddXChatPublicKey` | POST | `vjZCP0G28pIJ6CUC99rdAQ` |
| `InitializeXChatMediaUpload` | POST | `g2n9PB_uaRYv_SFvQokEFw` |
| `FinalizeXChatMediaUpload` | POST | `UK24H5vBa5MJspBmjZyFVQ` |

Query ID は Web bundle から再検出し、catalog は fallback として使う。

CLI runtime が API request に使う operation は `GetInitialXChatPageQuery`、`GetInboxPageRequestQuery`、`GetInboxPageConversationDataRequestQuery`、`GetConversationPageQuery`、`GetPublicKeys`、`SendMessageMutation`。`xchat operations` は catalog 内の operation metadata を検出するが、mutation は実行しない。

## Authentication

必要な Cookie:

- `auth_token`
- `ct0`
- `twid`

主な header:

- `Authorization: Bearer ...`
- `Cookie`
- `x-csrf-token`
- `x-twitter-auth-type: OAuth2Session`
- `x-twitter-active-user: yes`
- `x-twitter-client-language`
- `x-client-uuid`
- `Origin: https://x.com`
- `Referer: https://x.com/messages`

## Inbox and conversation history

初期 inbox:

```json
{
  "query_settings": {
    "inbox_conversation_event_limit": 5,
    "inbox_conversation_limit": 20,
    "conversation_event_limit": 200,
    "user_event_limit": 500
  },
  "message_pull_version": 1761251295
}
```

履歴:

```json
{
  "conversation_id": "CONVERSATION_ID",
  "min_local_sequence_id": "9223372036854775807",
  "min_conversation_key_version": "9223372036854775807",
  "query_settings": {
    "inbox_conversation_event_limit": 5,
    "inbox_conversation_limit": 20,
    "conversation_event_limit": 200,
    "user_event_limit": 500
  }
}
```

ID、sequence、key version は JavaScript `Number` に変換せず文字列で保持する。

## Encryption

`@xdevplatform/chat-xdk` 0.4.3 と `juicebox-sdk` 0.3.4 を使う。

処理順:

1. `GetPublicKeys` で public key、signing key、Juicebox token map を取得
2. XChat PIN で `unlock`
3. `matchesRegisteredKey` で自分の登録 key version を特定
4. `setIdentity`
5. `setCacheKeys`
6. 参加者の全 signing key version を `setSigningKeys`
7. key change event と message event をまとめて `decryptEvents`
8. `encryptMessage`
9. `SendMessageMutation` を 1 回だけ実行

`conversation_token` は SDK の JavaScript event に公開されない。raw base64 event の Thrift BinaryProtocol `MessageEvent` field 5 から抽出する。

## WebSocket

`GenerateXChatTokenMutation` の token は `wss://chat-ws.x.com/ws?token=...` 専用で、`SendMessageMutation` の `conversation_token` とは別物。

現時点の CLI は history read と mutation send を実装し、WebSocket listen は未実装。

## Message requests

未承認の message request は暗号化 XChat と別経路になる。現行 Web client には次の legacy internal endpoint が残っている。

- `/i/api/1.1/dm/inbox_initial_state.json`
- `/i/api/1.1/dm/user_updates.json`
- `/i/api/1.1/dm/inbox_timeline/trusted.json`
- `/i/api/1.1/dm/conversation/{id}/accept.json`
- `/i/api/1.1/dm/new2.json`

この CLI は未承認 request を送信対象にしない。

## Sources

- https://github.com/xdevplatform/chat-xdk
- https://github.com/xdevplatform/chat-xdk/blob/main/docs/API.md
- https://github.com/xdevplatform/chat-xdk/blob/main/docs/CRYPTO.md
- https://github.com/xdevplatform/xurl
- https://docs.x.com/xchat/getting-started
- https://help.x.com/en/using-x/about-chat
- https://github.com/mautrix/twitter
- https://docs.x.com/developer-guidelines

`mautrix/twitter` は AGPL-3.0。protocol の観測資料としてのみ参照し、source code はこの repository へ移植していない。
