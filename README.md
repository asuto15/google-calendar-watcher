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

1. Node.js (>=18) と [Cloudflare Wrangler](https://developers.cloudflare.com/workers/wrangler/) をインストール。
2. `.env.example` を `.env` にコピーし、後述の各環境変数を設定。
3. `wrangler login` で Cloudflare にログインし、KV バインディング `OBS` を作成。
4. `.env.example`にある各種環境変数を`wrangler secret put GOOGLE_CLIENT_ID`というふうに本番環境へ注入
5. `wrangler deploy` でワーカーを起動。初回は `curl -X POST https://<worker>/subscribe` を叩いて watch を開始。

### `.env.example` の項目

| 変数名 | 役割 | 取得・設定方法 |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | Google Cloud で作成した OAuth クライアント ID（デスクトップ/外部アプリ） | [Google Cloud Console](https://console.cloud.google.com/) の「API とサービス > 認証情報」で OAuth クライアントを作成し、ID をコピー。|
| `GOOGLE_CLIENT_SECRET` | 同上クライアントのシークレット | 上記クライアント作成時に発行されるシークレット。|
| `GOOGLE_REFRESH_TOKEN` | 対象アカウントで Google Calendar API にアクセスするためのリフレッシュトークン | `npm run get-token` で実行される `scripts/get-refresh-token.ts` を使ってデバイスコードフローを走らせ、ブラウザで承認後に得られるトークンを設定。|
| `CALENDAR_ID` | 監視対象 Google カレンダーの ID | Google Calendar の「設定と共有 > カレンダーの統合 > カレンダー ID」からコピー。公開カレンダーの場合は `example@gmail.com` や `xxxx@group.calendar.google.com` 形式。|
| `DISCORD_WEBHOOK_URL` | 通知を送る Discord チャンネルの Webhook URL | Discord のチャンネル設定 > 連携サービス > Webhook で新規作成し、URL を貼り付け。|
| `PUBLIC_HOOK_URL` | Google から Push 通知が届く完全な HTTPS URL（`/hook` パス） | Cloudflare Worker をデプロイ後の公開 URL に `/hook` を付けたものを設定。例: `https://watching-obs.example.workers.dev/hook`。|

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
