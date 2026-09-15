<p align="center">
  <img src="docs/design/openbot-readme-banner.png" alt="OpenBot" width="100%">
</p>

# OpenBot

**Desktop と Web から使える、セルフホスト型デジタルワーカーのワークスペース。**

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Português (Brasil)](README.pt-BR.md)

[![CI](https://github.com/Peerframe/openbot/actions/workflows/ci.yml/badge.svg)](https://github.com/Peerframe/openbot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-2563eb.svg)](LICENSE)

OpenBot は、自分で管理するコンピューター上で名前付きの AI 社員を運用するためのプラットフォームです。
チャンネル、会話、社員プロフィール、タスク、承認、結果を自分のワークスペースに保存します。
Desktop と Web は React UI を共有し、同じ OpenBot Server に接続します。

同じ Desktop アプリに Client、Server、Worker の役割を組み合わせる設計です。
Client は指示と監督、Worker と Provider は登録済みコンピューター上での実行を担当します。
Server だけが ID、ルーティング、認可、監査を管理します。画面表示は操作権限を与えません。

> [!WARNING]
> OpenBot は pre-alpha です。Desktop は未署名の開発用バンドルで、署名済みの公開インストーラーではありません。
> 現在の Provider は明示的な公開 URL を開いてスクリーンショットを返す読み取り専用実装です。
> 任意のデスクトップ操作、入力、無人フォーム送信は未実装です。決済手段、主要アカウント、本番認証情報を接続しないでください。

## Windows、macOS、Linux の Desktop

共通の Electron 44.2.0 とチャンネル UI を使用します。

| 対象 | Desktop | ローカル Server | ローカル Worker |
| --- | --- | --- | --- |
| macOS arm64 | 既存 Server への接続、ネイティブナビゲーション、共通 UI | PostgreSQL と Server を同梱。Docker 不要 | 同梱された macOS Worker companion によるペアリング |
| Windows x64 | 既存 Server への接続と共通 UI | 別途 Server をデプロイ | Windows Host はビルド・契約テスト段階。Desktop 統合インストールは計画中 |
| Linux x64 | 既存 Server への接続と共通 UI | 別途 Server をデプロイ | Node/サービスを別途デプロイ。Desktop 統合は計画中 |

CI はこの 3 対象をビルドしてパッケージ化します。これは開発用の証拠であり、実機のデスクトップ制御認証ではありません。
macOS Intel と他のアーキテクチャはこの CI マトリクスの対象外です。ローカルサービス起動は macOS arm64 で確認済みです。
Windows と Linux の初回起動はリモート接続を案内します。

### 開発用バンドルのダウンロード

**[Desktop のダウンロードとインストール手順（英語）](docs/DESKTOP_INSTALLATION.md)** に、
ファイル名、コマンドによるインストール、初回モデル設定をまとめています。DMG（macOS arm64）、
ユーザー単位 EXE（Windows x64）、AppImage/DEB（Linux x64）はネイティブ CI で作成します。
[Releases](https://github.com/Peerframe/openbot/releases) に `desktop-v...` の添付ファイルが公開
されるまでは、成功した CI のインストーラー成果物を使用してください（GitHub ログインが必要、
保存期間 14 日）。公開はまだ保留中です。

[GitHub Actions](https://github.com/Peerframe/openbot/actions/workflows/ci.yml) で対象コミットの成功した実行を開き、
`openbot-desktop-<platform>-<arch>-<commit>.tar.gz` をダウンロードしてください。
GitHub へのログインが必要で、保存期間は 7 日です。`tar -xzf <archive>` で実行権限とシンボリックリンクを保持して展開します。
macOS は `OpenBot.app`、Windows は `openbot.exe`、Linux は `openbot` を開きます。
未署名アプリに対する OS の要件は引き続き適用されます。

各対象のパッケージ検証に成功した場合だけアップロードします。tar はアプリのディレクトリで、
別の `openbot-installers-...` 成果物にはインストーラーとチェックサムを含みます。自動更新はありません。
古い `v0.1.0-alpha.1` Release はソースのみの基盤スナップショットです。

### ソースからビルド

[宣言された範囲](package.json) 内の Node.js 24 LTS と npm を使い、対象 OS 上で実行します。

```bash
git clone https://github.com/Peerframe/openbot.git
cd openbot
npm ci
npm run check
npm run package --workspace @openbot/desktop
```

出力は `apps/desktop/out/` です。macOS にはローカル Server と固定版 PostgreSQL が含まれます。
通常のソースビルドに Worker companion は含まれません。検証済みバンドルのパスを
`OPENBOT_DESKTOP_MACOS_WORKER_COMPANION` に設定した場合のみ同梱します。macOS CI は先に companion をビルドします。
macOS はローカルサービス作成または接続を選択でき、Windows/Linux は信頼できる HTTPS Server に Owner として接続します。
詳細は [Desktop setup](docs/DESKTOP_ONBOARDING.md) を参照してください。

## プロジェクトの状態

| 領域 | ソースに実装済み | 今後 |
| --- | --- | --- |
| Desktop / Web | チャンネル、Bot、承認、タスク表示、戻る/進む、ネイティブメニュー、下書き・スクロール復元、スキル一覧、設定保存 | 通知、ローカライズ、実機・アクセシビリティ検証 |
| macOS サービス | アプリ所有の PostgreSQL/Server、暗号化ブートストラップ、データ保持再起動、接続モード切替 | 他 OS、認証付きリモート共有、バックアップ、更新、ログインサービス |
| モデル / native Agent | Owner の明示的な有効化、暗号化設定、モデル・ツール・観察ループ、チャンネル・指定 URL の読み取り、Markdown レポート、停止・再送信、モデル使用量 | 実モデルの検証、追加ツール、外部 Agent アダプター |
| 自動タスク | PostgreSQL 永続化、一時停止/再開/削除、制限付き間隔、停止後の最大 1 回投入、既存認可ルート | 複数 Server 調整と追加のスケジュール形式 |
| 社員 | プロフィール、進化履歴、スキル審査、Owner 管理メモリ、タスクの知識提案と明示的なモデル共有、審査に紐付く移行、実験的 DSSE 署名 | 自律学習、実行可能スキル、選択的複製、公開信頼 |
| Worker | 外向き接続、単回ペアリング、失効、能力バージョン、進捗、画像、成果物 | 所有証明、完全な実機検証、署名配布 |
| コンピューター実行 | Docker/browser の URL スクリーンショット | 安全な入力、ネイティブ Provider、単回署名 lease、排他的引継ぎ |

[Native Agent](docs/NATIVE_AGENT.md) は明示的な有効化後に作成した `none` タスクを処理します。
Hermes/Pi/OpenClaw アダプター、プラグイン導入、任意デスクトップ制御は未実装です。
Cua、Lume、coder は拡張境界で、オフィス可視化は延期中です。
社員の進化・学習は [Hermes Agent の learning graph](https://github.com/NousResearch/hermes-agent/blob/63279301bcbdc185c1b07b98a9312eb0c862f26d/agent/learning_graph.py)
に着想を得ています。OpenBot 独自の発明とは主張しません。

## 開発と個別デプロイ

Desktop は必須ではありません。Server/PostgreSQL/Web を別々に実行できます。

```bash
cp .env.example .env
# OPENBOT_OWNER_PASSWORD に 15 文字以上のランダムパスワードを設定
npm ci
npm run db:up
npm run dev:server
# 別のターミナル:
npm run dev:web
```

<http://localhost:5173> で Bot とチャンネルを作り、Nodes から Worker をペアリングします。
`npm run node:enrollment-token -- local-development-node` でも単回トークンを発行できます。
[Node enrollment](docs/NODE_ENROLLMENT.md) に従い `npm run dev:node` を起動し、登録後はトークンを削除します。
Provider 未設定のタスクは待機状態です。`npm run db:stop` で PostgreSQL を停止します。

ブラウザー機能には Node の loopback 上で固定版
[agent-computer](https://github.com/CopilotKit/openbot/tree/257c1280d684089be9adb0b35cce262efc7064bf/agent-computer)
を起動し、`OPENBOT_DOCKER_COMPUTER_URL`、`OPENBOT_DOCKER_COMPUTER_TOKEN`、
`OPENBOT_DOCKER_ALLOW_PRIVATE_HOSTS=false` を設定して公開 URL を送信します。
[Server container](docs/SERVER_CONTAINER.md) と [Automations](docs/AUTOMATIONS.md) も参照してください。
自動タスクには稼働中の Server が必要で、権限や推論エンジンは追加されません。

## セキュリティと構成

Desktop/Web → Server → 認可された Worker → Provider。Server が唯一の正です。
レンダラー、モデル、Web ページ、スキル、Worker、Provider は信頼しません。
副作用は明示的なポリシーと承認に従います。Desktop はローカル資産、サンドボックス、型付き IPC、検証済み fuse を使用します。

リモート利用には HTTPS、`OPENBOT_SECURE_COOKIES=true`、制限した `OPENBOT_ALLOWED_ORIGINS` と信頼できる私設ネットワークが必要です。
DB と実行バックエンドを公開しないでください。Node は依然 bearer secret で、ペアリングは所有証明や mTLS を意味しません。
[Security](SECURITY.md)、[脅威モデル](docs/SECURITY.md)、[Provider conformance](docs/PROVIDER_CONFORMANCE.md) を参照してください。

## コントリビューションと文書

機能ブランチと PR を使い、動作変更前に上流を調査・固定し、ライセンス表示と翻訳を維持します。
`npm run check` と `npm audit` を実行してください。
[Contributing](CONTRIBUTING.md)、[再利用方針](docs/OPEN_SOURCE_REUSE.md) を参照してください。

| パス | 役割 |
| --- | --- |
| `apps/desktop`, `apps/web` | Electron と React UI |
| `apps/server`, `apps/node` | 制御面と実行 daemon |
| `apps/worker-host-macos`, `apps/worker-host-windows` | ネイティブサービス統合 |
| `packages/*`, `providers/*` | 共有モデル、プロトコル、保存、ポリシー、実行 |
| `deploy/`, `docs/` | デプロイ、契約、調査、検証 |

[Product](docs/PRODUCT.md)、[Architecture](docs/ARCHITECTURE.md)、[Roadmap](docs/ROADMAP.md)、
[API](docs/API.md)、[Cross-platform](docs/CROSS_PLATFORM.md)、[Database](docs/DATABASE.md)、
[Employee signing](docs/EMPLOYEE_SIGNING.md) が入口です。

## ライセンスと名称

[MIT](LICENSE)。上流表示は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) に保存します。
OpenBot は仮称で、CopilotKit/OpenBot など既存プロジェクトと重複するため、安定版前に区別できる名称を選びます。
xAI、Tencent、CopilotKit、OpenClaw、その他参照プロジェクトとは提携していません。
