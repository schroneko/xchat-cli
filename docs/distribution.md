# Distribution

xchat-cli の release は、macOS arm64 と x64 向けの standalone archive を [GitHub Releases](https://github.com/schroneko/xchat-cli/releases) で配布する。

配布 archive には Node runtime と production dependency が含まれる。利用者側の Node.js と npm は不要。

xchat-cli 自体は Chrome DevTools Protocol を使わない。`auth import` は local の Chrome Cookies database と macOS Keychain を読み取る。

## Archive layout

各 archive は `xchat-cli-VERSION-darwin-ARCH` という単一の root directory を持つ。

```text
xchat-cli-VERSION-darwin-ARCH/
├── bin/xchat
├── runtime/node
├── app/
│   ├── bin/
│   ├── src/
│   ├── node_modules/
│   └── package.json
├── licenses/
│   ├── juicebox-sdk-LICENSE
│   └── node-LICENSE
├── BUILD_INFO.json
├── LICENSE
└── README.md
```

`bin/xchat` は archive 内の `runtime/node` で `app/bin/xchat-cli.js` を実行する。archive を空白を含む path に展開しても引数と path は保持される。

各 `tar.gz` には、同名に `.sha256` を加えた checksum file が付属する。

## Installation channels

Homebrew:

```bash
brew install schroneko/tap/xchat-cli
```

GitHub Releases から直接取得した archive は、展開後の `bin/xchat` をそのまま実行できる。

source から導入する場合だけ Node.js 22 以降と npm が必要になる。

## Release flow

1. `package.json` の version を release version に更新する。
2. `vVERSION` 形式の tag を push する。
3. workflow が tag と `package.json` の version が一致することを確認する。
4. macOS arm64 と x64 の native runner がそれぞれ archive を build し、standalone smoke test を実行する。
5. 両 architecture の archive と checksum file を含む GitHub Release を作成する。
6. `schroneko/homebrew-tap` の両 architecture の URL と SHA-256 を更新して push する。
7. `brew install schroneko/tap/xchat-cli` で実際に install して動作を確認する。

tag version と `package.json` の version が異なる場合、release は作成されない。
