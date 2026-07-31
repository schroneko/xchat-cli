# xchat-cli

X のログイン済み Web session を使い、XChat の内部 GraphQL API と E2E 暗号化プロトコルを操作する macOS 向け CLI。

公式 X API、OAuth client、`api.x.com/2` は使わない。

このツールは非公開の内部 API に依存する。query ID、Bearer、response schema は予告なく変わる可能性があり、X の Developer Guidelines や利用条件と衝突して account が制限されるリスクもある。各自の責任で使用すること。

## 機能

- Chrome のログイン済み X session を取り込む
- XChat の会話一覧を取得する
- XChat PIN で既存メッセージを復号する
- 既存の1対1会話または明示した group conversation に送信する
- Web bundle から Bearer と一部の GraphQL query ID を検出する
- credential、PIN、暗号 payload を出力から除外する
- dry-run と送信直前の確認で誤送信リスクを抑える

## 必要環境

- macOS
- Google Chrome の通常プロフィールで X にログイン済み
- `security`
- `sqlite3`
- XChat PIN
- X Web client で XChat PIN と公開鍵を設定済みであること
- 送信先との既存の XChat conversation があること

Homebrew package と release archive には Node runtime が含まれるため、Node.js と npm は不要。

この CLI は Chrome DevTools Protocol を使わない。`auth import` は local の Chrome Cookies database と macOS Keychain から必要な session cookie だけを読み取る。

## Installation

Homebrew:

```bash
brew install schroneko/tap/xchat-cli
```

直接 archive を使う場合は、[GitHub Releases](https://github.com/schroneko/xchat-cli/releases) から native architecture 用の `tar.gz` と `.sha256` を取得する。Apple Silicon は `arm64`、Intel Mac は `x64` を選ぶ。

```bash
shasum -a 256 -c xchat-cli-VERSION-darwin-ARCH.tar.gz.sha256
tar -xzf xchat-cli-VERSION-darwin-ARCH.tar.gz
./xchat-cli-VERSION-darwin-ARCH/bin/xchat --help
```

source から install する場合だけ Node.js 22 以降と npm が必要。

```bash
git clone https://github.com/schroneko/xchat-cli.git
cd xchat-cli
npm install
npm link
xchat auth import
xchat auth status
xchat doctor
xchat keys status
xchat keys unlock
xchat conversations
```

配布形式と release flow の詳細は [docs/distribution.md](docs/distribution.md) を参照。

メッセージを読む:

```bash
xchat read --to target_handle
```

送信前に対象だけを確認する:

```bash
xchat send --to target_handle --text "hello" --dry-run
```

`--dry-run` は target の存在を network で検証しない。

実送信では本文を prompt に入力し、対象と文字数を確認して `yes` と入力する:

```bash
xchat send --to target_handle
```

詳しい認証方法、全コマンド、JSON output、group conversation、非対話実行、トラブル対応は [docs/usage.md](docs/usage.md) を参照。

## 安全設計

- session は mode `700` の directory と mode `600` の file に atomic 保存する
- session 読み込み時は symlink、他ユーザー所有、group／other 権限を拒否する
- `--to` は既存の1対1会話だけに解決し、group は conversation ID の明示を必須にする
- mutation は応答喪失時の重複実行を避けるため1回だけ送信する
- response の conversation ID と message ID を request と照合する
- Juicebox realm は HTTPS の `x.com` 配下だけを許可し、redirect を拒否する
- `--dry-run` は session、PIN、network、crypto に触れない

## 制限

- 新規 conversation の作成には対応していない
- WebSocket listen、media upload、message request の承認には対応していない
- history read は最新1ページの最大200 events を返し、続きがある場合は `hasMore` を返す
- `read` と `send` の `--max-pages` は handle や conversation ID を探す inbox のページ数だけを指定する
- Chrome Cookie は macOS の `v10` 形式に対応する
- 内部 API の変更時は fallback catalog の更新が必要になる場合がある

## 開発

```bash
npm install
npm run verify
npm audit --audit-level=high
npm audit signatures
```

テストは credential handling、GraphQL request、retry、redaction、Thrift decode、実 SDK WASM fixture、send safety を network 無しで検証する。

プロトコル調査と operation catalog は [docs/research.md](docs/research.md) にまとめている。

## License

[MIT License](LICENSE)
