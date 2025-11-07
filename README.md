## google-calendar-watcher

Google カレンダーへの予定の追加・更新・削除を Google Calendar Watch APIを使用して、Cloudflare Workers でGoogle Calendarからの通知を常時受け付け、内容をKVに保存して前回との差分を Discord へ通知するためのワーカーです。GitHub Actions や外部サーバーに依存せず、Cloudflare Workers + KV + Discord Webhook だけで完結する構成になっています。

### 全体構成

- **Cloudflare Worker (`src/index.ts`)**
  - `POST /subscribe`: Google Calendar の `events.watch` を開始し、監視対象イベントのスナップショットと `syncToken` を KV に保存する初期化エンドポイント。
  - `POST /hook`: Google 側の Push 通知を受け取り、KV に保存したスナップショットと `syncToken` を使って差分を計算し、Discord へ通知するメイン処理。Google が送ってくる `X-Goog-*` ヘッダーでチャネル正当性を確認。
  - `scheduled`（6時間毎）: watch チャネルの期限を監視し、必要に応じて `events.watch` を再実行。
- **Cloudflare KV (`OBS` バインディング)**
  - `channel`: 現在アクティブな watch チャネル情報 (`channelId`, `resourceId`, `expiration`)。
  - `snapshot:{CALENDAR_ID}`: JST 今日0時〜+14日以内に終了する将来イベントのスナップショット。
  - `sync:{CALENDAR_ID}`: Google Calendar `events.list` の `nextSyncToken`。
- **Discord Webhook**: 追加/更新/削除差分を Embed 形式で受け取り、指定チャンネルに投稿。

### 主要な処理フロー

1. **初期化 (`/subscribe`)**
   1. Google OAuth2 でアクセストークンを取得。
   2. `events.watch` を呼び出し、Cloudflare KV に watch チャネルを保存。
   3. Google Calendar をフルスキャンしてスナップショットを作成し、`nextSyncToken` を保存。
2. **差分処理 (`/hook`)**
   1. Push 通知を受信したら即 200 応答し、`ctx.waitUntil` で非同期処理。
   2. 保存済みチャネルとヘッダーが一致するか検証し、`state=sync` は無視。
   3. `events.list?syncToken=...&showDeleted=true&singleEvents=true` で差分を取得。
   4. 追加/更新/削除を判定してスナップショットを更新し、Discord に通知。
   5. `syncToken` が失効した場合はスナップショットをフル再構築。
3. **定期処理 (`scheduled`)**
   - watch チャネルの有効期限を監視し、期限が近い場合は `events.watch` を再実行して自動延命。

### セットアップ手順

1. **ツール準備**: Node.js 18 以上と [Cloudflare Wrangler](https://developers.cloudflare.com/workers/wrangler/) をインストールし、`wrangler login` と `wrangler kv namespace create OBS`（まだなければ）でアカウント連携と KV を用意する。
2. **依存関係インストール**: リポジトリ直下で `npm i` を実行し、`wrangler` や `tsx` などのローカル依存をまとめて入れる。
3. **環境ファイル作成**: `cp .env.example .env` を実行し、後述のとおりに`.env` を記述する。
4. **refresh_token 取得 (`npm run get-token`)**:
   1. `.env` に `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` を入れた状態で `npm run get-token` を実行。
   2. ローカルでポート `8787` が開き、ブラウザが自動起動するので対象アカウントで Google の同意画面を完了させる。
   3. ターミナルに表示された `refresh_token` を `.env` の `GOOGLE_REFRESH_TOKEN` に貼り付ける。
5. **Worker へのシークレット反映 (`npm run put-envvar`)**: `.env` に全ての値が入ったら `npm run put-envvar` を実行すると、各キーが順番に `wrangler secret put <KEY>` され、本番 Worker にまとめて登録される。
6. **デプロイ**: `wrangler deploy` を実行して Cloudflare Worker を公開する。`wrangler tail` でログ監視できる。
7. **watch 初期化 (`npm run subscribe`)**: デプロイ後、`npm run subscribe` を実行すると `.env` の `PUBLIC_WORKER_BASE_URL` に対して `/subscribe` が叩かれ、Google Calendar の watch 開始とスナップショット構築が行われる。以後は Google からの Push で自動的に `/hook` が呼ばれ、Discord 通知まで動線が完成する。

この 1〜7 を順番に実施すれば、README を書いた当時に比べて追加された npm スクリプトを使いながら、最初の watch 開始まで一気に到達できる。

### npm scripts 一覧

| スクリプト | 実行コマンド | 主な用途 | 実行前に必要なもの |
| --- | --- | --- | --- |
| `get-token` | `npm run get-token` | Google OAuth の `refresh_token` をローカルで取得。ループバックサーバ（ポート8787）を立て、ブラウザで同意してトークンを表示する。 | `.env` に `GOOGLE_CLIENT_ID` と `GOOGLE_CLIENT_SECRET` |
| `put-envvar` | `npm run put-envvar` | `.env` 内のキーを Cloudflare Worker のシークレットへ一括 `wrangler secret put`。 | `.env` に必要な値がすべて揃っていること、`wrangler login` 済み |
| `subscribe` | `npm run subscribe` | デプロイ済み Worker の `/subscribe` を叩いて watch を開始し、KV にスナップショット/SyncToken を保存。 | `.env` の `PUBLIC_WORKER_BASE_URL` と Cloudflare 側のシークレット群 |

> これらのスクリプトは全て `package.json` の `scripts` に登録されており、`npm run <name>` で実行できる。`node_modules/.bin` にインストールされた `wrangler` や `tsx` を前提にしているため、必ず `npm ci` 実行後に使用すること。

### `.env.example` の項目

| 変数名 | 役割 | 取得・設定方法 |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | Google Cloud で作成した OAuth クライアント ID（デスクトップ/外部アプリ） | [Google Cloud Console](https://console.cloud.google.com/) の「API とサービス > 認証情報」で OAuth クライアントを作成し、ID をコピー。|
| `GOOGLE_CLIENT_SECRET` | 同上クライアントのシークレット | 上記クライアント作成時に発行されるシークレット。|
| `GOOGLE_REFRESH_TOKEN` | 対象アカウントで Google Calendar API にアクセスするためのリフレッシュトークン | `npm run get-token` で実行される `scripts/get-refresh-token.ts` を使ってデバイスコードフローを走らせ、ブラウザで承認後に得られるトークンを設定。|
| `CALENDAR_ID` | 監視対象 Google カレンダーの ID | Google Calendar の「設定と共有 > カレンダーの統合 > カレンダー ID」からコピー。公開カレンダーの場合は `example@gmail.com` や `xxxx@group.calendar.google.com` 形式。|
| `DISCORD_WEBHOOK_URL` | 通知を送る Discord チャンネルの Webhook URL | Discord のチャンネル設定 > 連携サービス > Webhook で新規作成し、URL を貼り付け。|
| `PUBLIC_WORKER_BASE_URL` | Cloudflare Worker が公開されているベース URL（末尾にパスを付けない） | 例: `https://watching-obs.example.workers.dev`。コード側で `/hook` や `/subscribe` を連結して利用するため、スクリプトからも同じ値を参照できる。|

> `.env` はローカル開発時のみ参照され、Cloudflare へデプロイする際は `wrangler secret put` でこれらの値をシークレットとして登録してください。

### デバッグのヒント

- `wrangler tail` でリアルタイムログを確認できます。`[watching-obs]` プレフィックス付きのログには `/hook` のチャネル一致可否、差分件数、Discord 投稿状態などが出力されます。
- `created`/`updated`/`deleted` の件数は `/hook` ログにまとまって出るため、期待する差分が届いているか素早く確認できます。同期トークンの問題が起きた際は `incremental failed; rebuilding` ログが発生します。

### ディレクトリ構成

```
├── src/index.ts        # Worker 本体
├── scripts/get-refresh-token.ts  # OAuth2 デバイスフローで refresh_token を取得
├── wrangler.jsonc      # Wrangler 設定（KV バインディング `OBS` 等）
├── .env.example        # 必要な環境変数のテンプレート
└── README.md           # 本ドキュメント
```

この README を起点に、必要な環境変数を揃えて `wrangler` でデプロイすれば、Google カレンダーの追加/更新/削除イベントが Discord に流れる仕組みをすぐに構築できます。
