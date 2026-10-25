/*
 * 時差ほどき 通知サーバー（Cloudflare Workers + D1）
 * - POST /subscribe   { id?, sub:{endpoint,keys:{p256dh,auth}}, events:[{at,title,body,tag}] } → { id, count }
 * - POST /unsubscribe { id }
 * - 毎分の cron：時刻が来た通知を Web Push（RFC 8291 aes128gcm + VAPID）で送る
 * 保存するのは通知先と通知の時刻・文面だけ。名前やメールは受け取らない。
 */
import { webPush } from './push.js';

const MAX_EVENTS = 200;
const MAX_TEXT = 160;
const DAY = 864e5;

function cors(env, req) {
  const origin = req.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : (allowed[0] || ''),
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin'
  };
}
const json = (obj, status, headers) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function cleanEvents(list, now) {
  if (!Array.isArray(list)) return [];
  return list
    .filter(e => e && Number.isFinite(e.at) && e.at > now - 36e5 && e.at < now + 60 * DAY)
    .slice(0, MAX_EVENTS)
    .map(e => ({
      at: Math.round(e.at),
      title: String(e.title || '時差ほどき').slice(0, MAX_TEXT),
      body: String(e.body || '').slice(0, MAX_TEXT),
      tag: String(e.tag || '').slice(0, 40)
    }));
}

async function subscribe(req, env, h) {
  let b;
  try { b = await req.json(); } catch { return json({ error: 'JSONが読めません' }, 400, h); }
  const sub = b && b.sub;
  if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth)
    return json({ error: '通知先の情報が足りません' }, 400, h);
  const now = Date.now();
  const id = typeof b.id === 'string' && /^[0-9a-f-]{36}$/.test(b.id) ? b.id : crypto.randomUUID();
  const events = cleanEvents(b.events, now);
  const stmts = [
    env.DB.prepare(`INSERT INTO subs (id, endpoint, p256dh, auth, created, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
      ON CONFLICT(id) DO UPDATE SET endpoint=?2, p256dh=?3, auth=?4, updated=?5`)
      .bind(id, sub.endpoint, sub.keys.p256dh, sub.keys.auth, now),
    env.DB.prepare('DELETE FROM notif WHERE sub_id = ?1 AND sent = 0').bind(id)
  ];
  for (const e of events)
    stmts.push(env.DB.prepare('INSERT INTO notif (sub_id, at, title, body, tag, sent) VALUES (?1, ?2, ?3, ?4, ?5, 0)')
      .bind(id, e.at, e.title, e.body, e.tag));
  await env.DB.batch(stmts);
  return json({ id, count: events.length }, 200, h);
}

async function unsubscribe(req, env, h) {
  let b;
  try { b = await req.json(); } catch { return json({ error: 'JSONが読めません' }, 400, h); }
  if (!b || typeof b.id !== 'string') return json({ error: 'id がありません' }, 400, h);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM notif WHERE sub_id = ?1').bind(b.id),
    env.DB.prepare('DELETE FROM subs WHERE id = ?1').bind(b.id)
  ]);
  return json({ ok: true }, 200, h);
}

async function sendDue(env) {
  const now = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT n.id, n.sub_id, n.title, n.body, n.tag, s.endpoint, s.p256dh, s.auth
       FROM notif n JOIN subs s ON s.id = n.sub_id
      WHERE n.sent = 0 AND n.at <= ?1 AND n.at > ?2
      ORDER BY n.at LIMIT 300`).bind(now, now - 30 * 60e3).all();
  const vapid = { publicKey: env.VAPID_PUBLIC, privateJwk: JSON.parse(env.VAPID_PRIVATE_JWK), subject: env.VAPID_SUBJECT };
  const done = [], gone = new Set();
  for (const r of results) {
    if (gone.has(r.sub_id)) continue;
    try {
      const res = await webPush({ endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth },
        JSON.stringify({ title: r.title, body: r.body, tag: r.tag || undefined }), vapid);
      if (res.status === 404 || res.status === 410) gone.add(r.sub_id);
      done.push(r.id);
    } catch (err) {
      console.log('push error', r.id, String(err));
      done.push(r.id);
    }
  }
  const stmts = done.map(id => env.DB.prepare('UPDATE notif SET sent = 1 WHERE id = ?1').bind(id));
  for (const id of gone) {
    stmts.push(env.DB.prepare('DELETE FROM notif WHERE sub_id = ?1').bind(id));
    stmts.push(env.DB.prepare('DELETE FROM subs WHERE id = ?1').bind(id));
  }
  // 古い通知と、もう予定のない通知先を片付ける
  stmts.push(env.DB.prepare('DELETE FROM notif WHERE at < ?1').bind(now - 2 * DAY));
  stmts.push(env.DB.prepare(`DELETE FROM subs WHERE updated < ?1 AND id NOT IN (SELECT sub_id FROM notif)`).bind(now - 7 * DAY));
  await env.DB.batch(stmts);
}

export default {
  async fetch(req, env) {
    const h = cors(env, req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    const { pathname } = new URL(req.url);
    if (req.method === 'POST' && pathname === '/subscribe') return subscribe(req, env, h);
    if (req.method === 'POST' && pathname === '/unsubscribe') return unsubscribe(req, env, h);
    if (req.method === 'GET' && pathname === '/') return new Response('jisa-hodoki push', { headers: h });
    return json({ error: 'not found' }, 404, h);
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(sendDue(env));
  }
};
