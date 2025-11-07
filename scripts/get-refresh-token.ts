// ループバック(127.0.0.1)で OAuth コードを受け取り、refresh_token を取得して表示する簡易スクリプト
// 使い方：
//   GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=yyy npm run get-token
import http from 'node:http'
import { URLSearchParams } from 'node:url'
import open from 'open'

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID!
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('ERROR: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET を環境変数で設定してください')
  process.exit(1)
}

// Google の Desktop クライアントに適したループバック URI
// Desktop app の場合は任意のローカルポートでOK（OOBは非推奨）
const PORT = 8787
const REDIRECT_URI = `http://127.0.0.1:${PORT}/oauth2/callback`
const SCOPE = [
  'https://www.googleapis.com/auth/calendar.readonly' // これで events.list/watch が使えます
].join(' ')

// 1) 認可URL生成（必ず offline & consent で refresh_token をもらう）
const authParams = new URLSearchParams({
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  response_type: 'code',
  scope: SCOPE,
  access_type: 'offline',
  prompt: 'consent'
})
const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${authParams.toString()}`

// 2) ローカルHTTPサーバで code を受け取り → トークン交換
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url!, `http://127.0.0.1:${PORT}`)
    if (url.pathname !== '/oauth2/callback') {
      res.writeHead(404); res.end('Not Found'); return
    }
    const code = url.searchParams.get('code')
    if (!code) {
      res.writeHead(400); res.end('Missing code'); return
    }

    // 3) トークン交換
    const tokenParams = new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code'
    })
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenParams
    })
    const json = await tokenRes.json() as any
    if (!tokenRes.ok) {
      res.writeHead(500); res.end(`Token error: ${JSON.stringify(json)}`); return
    }

    const { access_token, refresh_token, expires_in } = json
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(`OK! このウィンドウは閉じて構いません。\n\naccess_token: ${access_token}\nrefresh_token: ${refresh_token}\nexpires_in: ${expires_in}s\n`)

    console.log('==== 取得結果 ====')
    console.log('access_token :', access_token)
    console.log('refresh_token:', refresh_token)
    console.log('expires_in   :', expires_in, 'seconds')
    console.log('\n次のコマンドで Workers のシークレットに保存してください:\n')
    console.log('  wrangler secret put GOOGLE_REFRESH_TOKEN')
    console.log('  # → プロンプトで paste する')

  } catch (e) {
    res.writeHead(500); res.end(String(e))
  } finally {
    server.close()
  }
})

server.listen(PORT, '127.0.0.1', async () => {
  console.log('ブラウザが開きます。Google アカウントで同意してください。')
  await open(authUrl)
})
