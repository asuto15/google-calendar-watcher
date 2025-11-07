// Cloudflare Workers: Google Calendar Push を受けて Discord へ通知
// - POST /subscribe : watch 開始（手動トリガ用）
// - POST /hook      : Google からの push 受信
// - scheduled       : 有効期限の前に再購読

export interface Env {
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  GOOGLE_REFRESH_TOKEN: string
  CALENDAR_ID: string
  PUBLIC_HOOK_URL: string
  DISCORD_WEBHOOK_URL: string
  OBS: KVNamespace
}

type ChannelOBS = {
  channelId: string
  resourceId: string
  expiration?: number // epoch ms
  syncToken?: string
}

async function getAccessToken(env: Env): Promise<string> {
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: env.GOOGLE_REFRESH_TOKEN,
    grant_type: 'refresh_token'
  })
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body
  })
  if (!res.ok) throw new Error(`token refresh failed: ${res.status} ${await res.text()}`)
  const json = (await res.json()) as { access_token: string }
  return json.access_token
}

async function eventsList(env: Env, accessToken: string, params: Record<string, string>) {
  const sp = new URLSearchParams(params)
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.CALENDAR_ID)}/events?${sp}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  if (!res.ok) throw new Error(`events.list failed: ${res.status} ${await res.text()}`)
  return res.json()
}

async function postDiscord(env: Env, content: string) {
  const res = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [
        {
          title: "Google Calendar 更新",
          description: content.substring(0, 4096),
          color: 0x00AAFF
        }
      ]
    })
  })

  if (!res.ok) {
    throw new Error(`discord webhook failed: ${res.status} ${await res.text()}`)
  }
}


function buildDiffMessage(items: any[]): string {
  if (!items.length) return ''
  const fmt = (s: string) => s.replace('T', ' ').replace(/:00([+-]\d{2}:\d{2})$/, '$1')
  const lines = items.map(ev => {
    const start = ev.start?.dateTime ?? ev.start?.date
    const end   = ev.end?.dateTime   ?? ev.end?.date
    const kind = ev.status === 'cancelled' ? '🗑️' : '🔔'
    return `${kind} ${ev.summary ?? '(無題)'} : ${fmt(start)} → ${fmt(end)}`
  })
  return lines.join('\n')
}

function generateId(length = 21) {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => alphabet[b % alphabet.length]).join('');
}

async function ensureSubscribe(env: Env, accessToken: string): Promise<ChannelOBS> {
  const saved: ChannelOBS | null = await env.OBS.get('channel', 'json')
  const now = Date.now()
  // 有効期限が 5 分以上先なら再利用
  if (saved?.expiration && saved.expiration - now > 5 * 60 * 1000) return saved

  // 新規（または再購読）
  const channelId = generateId()
  const watchBody = {
    id: channelId,
    type: 'web_hook',
    address: env.PUBLIC_HOOK_URL
    // token: 'optional-any-string'
  }
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.CALENDAR_ID)}/events/watch`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(watchBody)
    }
  )
  if (!res.ok) throw new Error(`events.watch failed: ${res.status} ${await res.text()}`)
  const js = (await res.json()) as { id: string; resourceId: string; expiration?: string }

  const OBS: ChannelOBS = {
    channelId: js.id,
    resourceId: js.resourceId,
    expiration: js.expiration ? Number(js.expiration) : undefined
  }

  // 初回：直近 2 週間を取得して syncToken を作る
  const nowIso = new Date().toISOString()
  const twoWeeksLater = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()
  const list = await eventsList(env, accessToken, {
    timeMin: nowIso,
    timeMax: twoWeeksLater,
    singleEvents: 'true',
    maxResults: '2500',
    orderBy: 'startTime'
  })
  if (list.nextSyncToken) OBS.syncToken = list.nextSyncToken
  await env.OBS.put('channel', JSON.stringify(OBS))
  return OBS
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url)

    // /subscribe ハンドラの分岐内
    if (url.pathname === '/subscribe' && req.method === 'POST') {
      try {
        const required = [
          'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN',
          'CALENDAR_ID', 'DISCORD_WEBHOOK_URL', 'PUBLIC_HOOK_URL'
        ] as const;
        for (const k of required) {
          if (!(env as any)[k]) {
            return new Response(`Missing secret: ${k}`, { status: 400 });
          }
        }

        const token = await getAccessToken(env);     // ← ここで 400/401 になっていないか
        const meta  = await ensureSubscribe(env, token); // ← PUBLIC_HOOK_URL が空でも落ちる
        return new Response(JSON.stringify({ ok: true, meta }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (e: any) {
        // ログに出す
        console.error('subscribe failed:', e);
        return new Response(`subscribe failed: ${String(e)}`, { status: 500 });
      }
    }

    if (url.pathname === '/hook' && req.method === 'POST') {
      // すぐ 200 を返し、裏で処理（再送抑止）
      const ack = new Response('OK', { status: 200 })

      const state = req.headers.get('X-Goog-Resource-State') // sync / exists / not_exists / update / deleted
      const channelId = req.headers.get('X-Goog-Channel-ID') || ''
      const resourceId = req.headers.get('X-Goog-Resource-ID') || ''

      const work = (async () => {
        const saved: ChannelOBS | null = await env.OBS.get('channel', 'json')
        if (!saved || saved.channelId !== channelId || saved.resourceId !== resourceId) {
          // 自分のチャネルでなければ無視
          return
        }
        if (state === 'sync') {
          // 初期 sync 通知は無視（仕様）
          return
        }
        try {
          const access = await getAccessToken(env)

          // 差分同期
          let items: any[] = []
          let nextSyncToken: string | undefined = saved.syncToken

          const paramsBase: Record<string, string> = {
            singleEvents: 'true',
            showDeleted: 'true',
            maxResults: '2500'
          }

          let params: Record<string, string> = { ...paramsBase }
          if (saved.syncToken) {
            params.syncToken = saved.syncToken
          } else {
            // 念のため fallback（通常ここには来ない）
            const nowIso = new Date().toISOString()
            const twoWeeksLater = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()
            params = { ...paramsBase, timeMin: nowIso, timeMax: twoWeeksLater, orderBy: 'startTime' }
          }

          let pageToken: string | undefined
          do {
            const resp = await eventsList(env, access, { ...params, ...(pageToken ? { pageToken } : {}) })
            if (resp.items?.length) items.push(...resp.items)
            pageToken = resp.nextPageToken
            nextSyncToken = resp.nextSyncToken ?? nextSyncToken
          } while (pageToken)

          if (nextSyncToken) {
            saved.syncToken = nextSyncToken
            await env.OBS.put('channel', JSON.stringify(saved))
          }

          const msg = buildDiffMessage(items)
          if (msg.trim().length) {
            await postDiscord(env, `**更新がありました**\n${msg}`)
          }
        } catch (e: any) {
          // 410 Gone (Invalid sync token) 等のときは再購読が必要
          // ここでは通知だけ。必要なら ensureSubscribe を呼び直す運用も可
          await postDiscord(env, `（通知エラー）${String(e)}`)
        }
      })()

      ctx.waitUntil(work)
      return ack
    }

    return new Response('Not Found', { status: 404 })
  },

  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    const token = await getAccessToken(env)
    await ensureSubscribe(env, token)
  }
}
