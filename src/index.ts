export interface Env {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REFRESH_TOKEN: string;
  CALENDAR_ID: string;
  PUBLIC_WORKER_BASE_URL: string;
  DISCORD_WEBHOOK_URL: string;
  OBS: KVNamespace; // KV
}

const LOG_PREFIX = "[watching-obs]";
const log = (...args: unknown[]) => console.log(LOG_PREFIX, ...args);
const logError = (...args: unknown[]) => console.error(LOG_PREFIX, ...args);

// ===== JST ユーティリティ =====
function toJstDate(date = new Date()) {
  const JST_OFFSET_MIN = 9 * 60;
  return new Date(date.getTime() + JST_OFFSET_MIN * 60_000);
}

function jstTodayStartISO(nowUtc = new Date()): string {
  const j = toJstDate(nowUtc);
  const y = j.getUTCFullYear();
  const m = j.getUTCMonth();
  const d = j.getUTCDate();
  const jstMidnightUtc = new Date(Date.UTC(y, m, d, -9, 0, 0));
  return jstMidnightUtc.toISOString();
}

function plusDaysISO(baseIso: string, days: number): string {
  const t = new Date(baseIso);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString();
}

// ===== Google API =====
async function getAccessToken(env: Env): Promise<string> {
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: env.GOOGLE_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body });
  if (!res.ok) throw new Error(`token refresh failed: ${res.status} ${await res.text()}`);
  const js = (await res.json()) as { access_token: string };
  return js.access_token;
}

async function gcalList(env: Env, accessToken: string, params: Record<string, string>) {
  const sp = new URLSearchParams(params);
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.CALENDAR_ID)}/events?${sp}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`events.list failed: ${res.status} ${await res.text()}`);
  return res.json();
}

function buildWorkerUrl(env: Env, path: string) {
  const base = env.PUBLIC_WORKER_BASE_URL;
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  return new URL(path, normalizedBase).toString();
}

async function gcalWatch(env: Env, accessToken: string, channelId: string) {
  const hookUrl = buildWorkerUrl(env, "/hook");
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.CALENDAR_ID)}/events/watch`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: channelId, type: "web_hook", address: hookUrl }),
    }
  );
  if (!res.ok) throw new Error(`events.watch failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<{ id: string; resourceId: string; expiration?: string }>;
}

// ===== スナップショット / 差分 =====
type NormEvent = { id: string; summary: string; start: string; end: string };
type Snapshot = { events: Record<string, NormEvent>; updatedAt: string };
type ChannelOBS = { channelId: string; resourceId: string; expiration?: number };
type ChangeKind = "created" | "updated" | "deleted";
type ChangeEntry = {
  kind: ChangeKind;
  current: NormEvent;
  previous?: NormEvent;
  parsedStart: Date;
  parsedEnd: Date;
};

const CHANNEL_KEY = "channel";
const SNAPSHOT_KEY = (calId: string) => `snapshot:${calId}`;
const SYNC_KEY = (calId: string) => `sync:${calId}`;

function normalizeItem(ev: any): NormEvent | null {
  const id = ev.id as string;
  if (!id) return null;
  const summary = (ev.summary ?? "(無題)") as string;
  const start = ev.start?.dateTime ?? ev.start?.date;
  const end = ev.end?.dateTime ?? ev.end?.date;
  if (!start || !end) return null;
  return { id, summary, start, end };
}

function isFutureByEnd(ev: NormEvent, nowIso: string): boolean {
  return new Date(ev.end).getTime() > new Date(nowIso).getTime();
}

function shallowChanged(a: NormEvent, b: NormEvent): boolean {
  return a.summary !== b.summary || a.start !== b.start || a.end !== b.end;
}

// フルスキャン（初期化/リセット用）
async function buildCurrentSnapshot(env: Env, accessToken: string): Promise<{ snap: Snapshot; nextSyncToken?: string }> {
  const windowStart = jstTodayStartISO();
  const windowEnd = plusDaysISO(windowStart, 14);
  const windowEndMs = new Date(windowEnd).getTime();
  const base: Record<string, string> = {
    singleEvents: "true",
    showDeleted: "true",
    maxResults: "2500",
  };
  const events: any[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;

  do {
    const resp = await gcalList(env, accessToken, { ...base, ...(pageToken ? { pageToken } : {}) });
    if (resp.items?.length) events.push(...resp.items);
    pageToken = resp.nextPageToken;
    nextSyncToken = resp.nextSyncToken ?? nextSyncToken;
  } while (pageToken);

  const nowIso = new Date().toISOString();
  const map: Record<string, NormEvent> = {};
  for (const ev of events) {
    const n = normalizeItem(ev);
    if (!n) continue;
    if (!isFutureByEnd(n, nowIso)) continue;
    if (new Date(n.start).getTime() >= windowEndMs) continue;
    map[n.id] = n;
  }
  return { snap: { events: map, updatedAt: nowIso }, nextSyncToken };
}

// 増分適用（showDeleted + syncToken）
async function applyIncremental(
  env: Env,
  accessToken: string,
  prev: Snapshot
): Promise<{ next: Snapshot; created: NormEvent[]; updated: { old: NormEvent; now: NormEvent }[]; deleted: NormEvent[]; nextSyncToken?: string }> {
  const params: Record<string, string> = {
    syncToken: (await env.OBS.get(SYNC_KEY(env.CALENDAR_ID))) ?? "",
    showDeleted: "true",
    maxResults: "2500",
    singleEvents: "true",
  };
  if (!params.syncToken) throw new Error("no syncToken");

  const nowIso = new Date().toISOString();
  const nextEvents: Record<string, NormEvent> = { ...prev.events };
  const created: NormEvent[] = [];
  const updated: { old: NormEvent; now: NormEvent }[] = [];
  const deleted: NormEvent[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;

  try {
    do {
      const resp = await gcalList(env, accessToken, { ...params, ...(pageToken ? { pageToken } : {}) });
      const items = resp.items ?? [];
      for (const it of items) {
        if (it.status === "cancelled") {
          // 削除
          const id = it.id as string;
          const existed = nextEvents[id];
          if (existed) {
            // 削除された予約が未来のものなら通知対象にする
            if (isFutureByEnd(existed, nowIso)) deleted.push(existed);
            delete nextEvents[id];
          }
          continue;
        }
        // 作成/更新（インスタンス含む）
        const n = normalizeItem(it);
        if (!n) continue;

        const existed = nextEvents[n.id];
        // 未来でないものはスナップショットから落とす
        if (!isFutureByEnd(n, nowIso)) {
          if (existed) delete nextEvents[n.id];
          continue;
        }

        if (!existed) {
          nextEvents[n.id] = n;
          // 追加された予約を通知対象にする
          // created.push(n);
        } else {
          if (shallowChanged(existed, n)) {
            // 更新された予約を通知対象にする
            updated.push({ old: existed, now: n });
            nextEvents[n.id] = n;
          }
        }
      }
      pageToken = resp.nextPageToken;
      nextSyncToken = resp.nextSyncToken ?? nextSyncToken;
    } while (pageToken);
  } catch (e: any) {
    // 410 Gone 等で syncToken 失効
    if (String(e).includes("410") || String(e).includes("syncToken")) {
      throw new Error("syncGone");
    }
    throw e;
  }

  const next: Snapshot = { events: nextEvents, updatedAt: nowIso };
  return { next, created, updated, deleted, nextSyncToken };
}

// ===== Discord =====
function buildChangeEntries(created: NormEvent[], updated: { old: NormEvent; now: NormEvent }[], deleted: NormEvent[]): ChangeEntry[] {
  const rows: ChangeEntry[] = [];
  for (const item of created) {
    rows.push({
      kind: "created",
      current: item,
      parsedStart: new Date(item.start),
      parsedEnd: new Date(item.end),
    });
  }
  for (const item of updated) {
    rows.push({
      kind: "updated",
      current: item.now,
      previous: item.old,
      parsedStart: new Date(item.now.start),
      parsedEnd: new Date(item.now.end),
    });
  }
  for (const item of deleted) {
    rows.push({
      kind: "deleted",
      current: item,
      parsedStart: new Date(item.start),
      parsedEnd: new Date(item.end),
    });
  }
  return rows;
}

function formatDatetime(iso: string) {
  // "2025-11-07T10:00:00+09:00" → "2025/11/07 10:00"
  const datetime = new Date(iso);
  const jst = toJstDate(datetime);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(jst.getUTCDate()).padStart(2, "0");
  const h = String(jst.getUTCHours()).padStart(2, "0");
  const min = String(jst.getUTCMinutes()).padStart(2, "0");
  const datetimeStr = `${y}/${m}/${d} ${h}:${min}`;
  return datetimeStr;
}

function formatTime(iso: string) {
  // "2025-11-07T10:00:00+09:00" → "10:00"
  const datetime = new Date(iso);
  const jst = toJstDate(datetime);
  const h = String(jst.getUTCHours()).padStart(2, "0");
  const min = String(jst.getUTCMinutes()).padStart(2, "0");
  const timeStr = `${h}:${min}`;
  return timeStr;
}

function formatLine(entry: ChangeEntry) {
  const emoji = entry.kind === "created" ? "🆕" : entry.kind === "updated" ? "🔔" : "🗑️";
  const label = entry.kind === "created" ? "追加" : entry.kind === "updated" ? "更新" : "削除";
  if (entry.kind === "updated" && entry.previous) {
    const beforeStart = formatDatetime(entry.previous.start);
    const beforeEnd = formatTime(entry.previous.end);
    const afterStart = formatDatetime(entry.current.start);
    const afterEnd = formatTime(entry.current.end);
    return `- ${entry.current.summary} ${emoji} (${label})\n  - 変更前: ${beforeStart} ~ ${beforeEnd}\n  - 変更後: ${afterStart} ~ ${afterEnd}`;
  }
  return `- ${entry.current.summary} ${emoji} (${label})\n  - ${formatDatetime(entry.current.start)} ~ ${formatTime(entry.current.end)}`;
}

function formatChangeEntries(entries: ChangeEntry[]) {
  if (!entries.length) return "";
  return entries.map(formatLine).join("\n");
}

function renderDiscordMessage(entries: ChangeEntry[]) {
  if (entries.length === 0) {
    return { title: "Error: No entries to report", body: "" };
  }
  switch (entries[0].kind) {
    case "created":
      const titleCrt = "カワイ部屋の予約が追加されました";
      const bodyCrt = formatChangeEntries(entries);
      return { title: titleCrt, body: bodyCrt };
    case "updated":
      const titleUpd = "カワイ部屋の予約が更新されました";
      const bodyUpd = formatChangeEntries(entries);
      return { title: titleUpd, body: bodyUpd };
    case "deleted":
      const titleDel = "カワイ部屋の予約が削除されました";
      const bodyDel = formatChangeEntries(entries);
      return { title: titleDel, body: bodyDel };
  }

  return { title: "Error: Unknown entry kinds", body: "" };
}
function splitEmbeds(desc: string) {
  const out: any[] = [];
  const LIMIT = 4096;
  for (let i = 0; i < desc.length; i += LIMIT) out.push({ description: desc.slice(i, i + LIMIT), color: 0x00aaFF });
  return out;
}
async function postDiscord(env: Env, title: string, body: string) {
  if (!body.trim()) {
    log("postDiscord", "skip empty body");
    return;
  }
  const embeds = splitEmbeds(body);
  embeds[0].title = title;
  log("postDiscord", { title, chunks: embeds.length, textLength: body.length });
  const res = await fetch(env.DISCORD_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ embeds }) });
  if (!res.ok) {
    const text = await res.text();
    logError("discord webhook failed", { status: res.status, text });
    throw new Error(`discord webhook failed: ${res.status} ${text}`);
  }
}

// ===== watch チャネル =====
function randomId(): string {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a).map(b => b.toString(16).padStart(2, "0")).join("");
}
async function ensureWatch(env: Env, accessToken: string): Promise<ChannelOBS> {
  const saved = (await env.OBS.get(CHANNEL_KEY, "json")) as ChannelOBS | null;
  const now = Date.now();
  if (saved?.expiration && saved.expiration - now > 5 * 60 * 1000) {
    log("ensureWatch", "reuse", { channelId: saved.channelId, expiresInMs: saved.expiration - now });
    return saved;
  }
  log("ensureWatch", "renewal required");
  const chId = randomId();
  const js = await gcalWatch(env, accessToken, chId);
  const OBS: ChannelOBS = { channelId: js.id, resourceId: js.resourceId, expiration: js.expiration ? Number(js.expiration) : undefined };
  await env.OBS.put(CHANNEL_KEY, JSON.stringify(OBS));
  log("ensureWatch", "new channel", { channelId: OBS.channelId, resourceId: OBS.resourceId, expiration: OBS.expiration });
  return OBS;
}

// ===== Handlers =====
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // 初期購読 & 初期化
    if (url.pathname === "/subscribe" && req.method === "POST") {
      try {
        log("/subscribe invoked");
        const token = await getAccessToken(env);
        const OBS = await ensureWatch(env, token);
        const { snap, nextSyncToken } = await buildCurrentSnapshot(env, token);
        await env.OBS.put(SNAPSHOT_KEY(env.CALENDAR_ID), JSON.stringify(snap));
        if (nextSyncToken) await env.OBS.put(SYNC_KEY(env.CALENDAR_ID), nextSyncToken);
        log("/subscribe success", { events: Object.keys(snap.events).length, hasSyncToken: Boolean(nextSyncToken) });
        return new Response(JSON.stringify({ ok: true, OBS }), { status: 200 });
      } catch (e: any) {
        logError("/subscribe failed", String(e));
        return new Response(`subscribe failed: ${String(e)}`, { status: 500 });
      }
    }

    // Push 受信
    if (url.pathname === "/hook" && req.method === "POST") {
      const ack = new Response("OK", { status: 200 });

      const state = req.headers.get("X-Goog-Resource-State");
      const channelId = req.headers.get("X-Goog-Channel-ID") || "";
      const resourceId = req.headers.get("X-Goog-Resource-ID") || "";

      log("/hook invoked", { state, channelId, resourceId });

      ctx.waitUntil((async () => {
        try {
          const saved = (await env.OBS.get(CHANNEL_KEY, "json")) as ChannelOBS | null;
          if (!saved) {
            log("/hook", "no channel stored; ignoring");
            return;
          }
          if (saved.channelId !== channelId || saved.resourceId !== resourceId) {
            log("/hook", "channel mismatch; ignoring", { savedChannelId: saved.channelId, savedResourceId: saved.resourceId });
            return;
          }
          if (state === "sync") {
            log("/hook", "state sync; nothing to do");
            return;
          }

          const token = await getAccessToken(env);
          const prev = (await env.OBS.get(SNAPSHOT_KEY(env.CALENDAR_ID), "json")) as Snapshot | null;

          // まず増分
          try {
            if (!prev) throw new Error("noPrev");
            const { next, created, updated, deleted, nextSyncToken } = await applyIncremental(env, token, prev);
            const entries = buildChangeEntries(created, updated, deleted);
            const { title, body } = renderDiscordMessage(entries);
            await postDiscord(env, title, body);
            await env.OBS.put(SNAPSHOT_KEY(env.CALENDAR_ID), JSON.stringify(next));
            if (nextSyncToken) await env.OBS.put(SYNC_KEY(env.CALENDAR_ID), nextSyncToken);
            log("/hook", "incremental success", {
              created: created.length,
              updated: updated.length,
              deleted: deleted.length,
              snapshotSize: Object.keys(next.events).length,
              nextSyncToken: Boolean(nextSyncToken),
            });
            return;
          } catch (incErr: any) {
            // syncToken失効・初回など → フル再同期
            log("/hook", "incremental failed; rebuilding", String(incErr));
            const { snap, nextSyncToken } = await buildCurrentSnapshot(env, token);
            await env.OBS.put(SNAPSHOT_KEY(env.CALENDAR_ID), JSON.stringify(snap));
            if (nextSyncToken) await env.OBS.put(SYNC_KEY(env.CALENDAR_ID), nextSyncToken);
            log("/hook", "rebuild done", { events: Object.keys(snap.events).length, hasSyncToken: Boolean(nextSyncToken) });
          }
        } catch (e: any) {
          // 失敗はDiscordに軽くログ（失敗しても ack は返している）
          logError("/hook", "processing error", String(e));
          await fetch(env.DISCORD_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: `（通知エラー）${String(e)}` }),
          }).catch(() => {});
        }
      })());

      return ack;
    }

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env) {
    // 有効期限延長だけ。必要ならここで "フル再同期" の健診を定期に行っても良い。
    const token = await getAccessToken(env);
    log("scheduled", "ensure watch");
    await ensureWatch(env, token);
  }
};
