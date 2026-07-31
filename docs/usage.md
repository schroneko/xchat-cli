# Usage

## 1. Install

```bash
git clone https://github.com/schroneko/xchat-cli.git
cd xchat-cli
npm install
npm link
```

`npm link` により `xchat` command が利用できる。

X Web client で XChat PIN と公開鍵を設定済みで、送信先との既存 conversation があることを前提とする。新規 conversation は作成しない。

## 2. Import an X Web session

Chrome の通常プロフィールで X にログインした状態で実行する:

```bash
xchat auth import
xchat auth status
```

`auth import` は Chrome の Cookies DB から SQLite backup で一貫した snapshot を作り、`.x.com` の `auth_token`、`ct0`、`twid` だけを復号する。

既定の保存先:

```text
~/Library/Application Support/xchat-cli/session.json
```

別の Chrome profile:

```bash
xchat auth import --profile "Profile 1"
```

Cookies DB を直接指定:

```bash
xchat auth import --chrome-cookie-db "/path/to/Cookies"
```

session file を変更する場合は各 command に `--session PATH` を付ける。

## 3. Check the environment and keys

```bash
xchat doctor
xchat operations
xchat keys status
xchat keys unlock
```

`keys status` は PIN を使わず、XChat public key の登録状態だけを確認する。

`keys unlock` は XChat PIN を TTY から非表示で読み、Juicebox から復旧した identity が登録済み public key と一致することを確認する。

PIN を command line option では受け取らない。非対話実行では、PIN を格納した既存 file descriptor の番号を `XCHAT_PIN_FD` で渡す。互換用の `XCHAT_PIN` は process environment から読まれ得るため推奨しない。

通常は TTY の非表示入力を使う。非対話実行では `3` 以上の file descriptor を指定し、読み取った PIN の末尾改行は除去される:

```bash
XCHAT_PIN_FD=3 xchat keys unlock 3<"/secure/path/xchat-pin"
```

PIN file を使う場合は repository や同期 directory の外に置き、所有者だけが読める mode `600` にする。

## 4. List conversations

```bash
xchat conversations
xchat conversations --max-pages 10
```

output は JSON。conversation ID、name、group 判定、mute 状態、participant を返す。暗号 event と token は返さない。

`--max-pages` は inbox を最大何ページ取得するかを指定し、範囲は `1` から `20`、既定値は `5`。

## 5. Read messages

既存の1対1会話を handle で指定:

```bash
xchat read --to target_handle
```

conversation ID を指定:

```bash
xchat read --conversation "123456789:987654321"
```

conversation ID は組み立てず、`xchat conversations` が返した `id` をそのまま指定する。

group は conversation ID で指定する:

```bash
xchat read --conversation "GROUP_CONVERSATION_ID"
```

本文を伏せて構造だけを確認:

```bash
xchat read --to target_handle --redact
```

取得範囲より古い event がある場合は `hasMore: true` を返す。

`read` は最新1ページの最大200 events を取得する。`--max-pages` は history のページ数ではなく、handle または conversation ID の解決に使う inbox のページ数。

## 6. Send safely

dry-run は指定形式と文字数だけを検証し、target の存在は検証しない。session、PIN、network、crypto にも触れない:

```bash
xchat send --to target_handle --text "hello" --dry-run
```

実送信:

```bash
xchat send --to target_handle
```

実送信の順序:

1. 本文を prompt に入力
2. 対象と文字数を確認
3. `yes` を完全一致で入力
4. XChat PIN を非表示で入力
5. 既存会話と署名済み event を検証
6. mutation を1回だけ実行
7. response の conversation ID と message ID を照合

`--text TEXT` でも本文を渡せるが、shell history と process argv に残り得る。

`--yes` は確認を省略する。外部で対象と本文を明示承認済みの自動実行だけに使う。

`--to` は1対1会話にしか解決しない。group 送信は conversation ID を明示する:

```bash
xchat send --conversation "GROUP_CONVERSATION_ID"
```

## 7. Output and exit codes

正常時は JSON を stdout へ出力する。error は credential を redaction した JSON として stderr へ出力する。

- `0`: 正常終了または送信確認の cancel
- `1`: authentication、network、protocol、crypto error
- `2`: command または option の使い方が不正

## 8. Troubleshooting

### Session file is missing or invalid

```bash
xchat auth import
xchat auth status
```

session file は current user 所有の regular file で、group／other 権限が付いていない必要がある。

### Unsupported Chrome cookie encryption format

macOS の通常 Chrome profile を使用しているか、`--profile` または `--chrome-cookie-db` が正しいか確認する。

### Stale operation or GraphQL error

```bash
xchat operations
```

内部 API の query ID や response schema が変わった可能性がある。`docs/research.md` と `src/x-api.js` の catalog を更新する。

### No one-to-one conversation was found

`--to` は group を選ばない。`xchat conversations` で conversation ID を確認し、group なら `--conversation` を使う。

### Juicebox recovery failed

PIN を繰り返し試さない。Juicebox には試行回数制限があるため、正しい XChat PIN を確認してから再実行する。
