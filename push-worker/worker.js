// Rest-timer push relay for the workout app (Cloudflare Worker + Durable Object).
//
// The app calls POST /schedule {sub:{endpoint}, delay:<seconds>} when a rest starts and POST /cancel {endpoint}
// when it is paused / skipped. One Durable Object per push endpoint holds a single alarm; when it fires, the
// object sends an EMPTY Web Push (VAPID-signed, no payload, so no encryption is needed) and the service worker
// in the app turns it into a notification.

const TTL = 120;                // push services drop the message if it cannot be delivered within this many seconds
const MAX_DELAY = 1800;         // seconds
const MIN_DELAY = 1;
const PUSH_HOSTS = ['push.apple.com', 'fcm.googleapis.com', 'push.services.mozilla.com', 'notify.windows.com'];

const enc = new TextEncoder();

function b64u(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function corsHeaders(req, env) {
  const origin = req.headers.get('Origin');
  const h = { 'Vary': 'Origin' };
  if (origin && (!env.ALLOWED_ORIGIN || origin === env.ALLOWED_ORIGIN)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

function reply(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, cors),
  });
}

function allowedEndpoint(endpoint, env) {
  let u;
  try { u = new URL(endpoint); } catch (e) { return false; }
  const hosts = env.PUSH_HOSTS ? String(env.PUSH_HOSTS).split(',') : PUSH_HOSTS;
  const hostOk = hosts.some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
  if (!hostOk) return false;
  if (u.protocol === 'https:') return true;
  return env.ALLOW_INSECURE_LOCAL === '1' && u.protocol === 'http:'; // local tests only
}

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method !== 'POST') return reply({ ok: false, error: 'method' }, 405, cors);

    const origin = req.headers.get('Origin');
    if (env.ALLOWED_ORIGIN && origin !== env.ALLOWED_ORIGIN) return reply({ ok: false, error: 'origin' }, 403, cors);

    const path = new URL(req.url).pathname;
    if (path !== '/schedule' && path !== '/cancel') return reply({ ok: false, error: 'path' }, 404, cors);

    let body;
    try { body = JSON.parse(await req.text()); } catch (e) { return reply({ ok: false, error: 'json' }, 400, cors); }
    const endpoint = body && ((body.sub && body.sub.endpoint) || body.endpoint);
    if (typeof endpoint !== 'string' || endpoint.length > 1000 || !allowedEndpoint(endpoint, env)) {
      return reply({ ok: false, error: 'endpoint' }, 400, cors);
    }

    let delay = 0;
    if (path === '/schedule') {
      delay = Number(body.delay);
      if (!(delay >= MIN_DELAY && delay <= MAX_DELAY)) return reply({ ok: false, error: 'delay' }, 400, cors);
    }

    const stub = env.PUSH.get(env.PUSH.idFromName(endpoint));
    const res = await stub.fetch('https://do' + path, { method: 'POST', body: JSON.stringify({ endpoint, delay }) });
    return reply(await res.json(), res.status, cors);
  },
};

export class PushTimer {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req) {
    const path = new URL(req.url).pathname;
    const { endpoint, delay } = await req.json();
    const st = this.state.storage;
    if (path === '/cancel') {
      await st.deleteAlarm();
      await st.delete('endpoint');
      return Response.json({ ok: true, cancelled: true });
    }
    // A new schedule replaces any pending one for this device.
    await st.put('endpoint', endpoint);
    await st.setAlarm(Date.now() + Math.round(delay * 1000));
    return Response.json({ ok: true });
  }

  async alarm() {
    const st = this.state.storage;
    const endpoint = await st.get('endpoint');
    if (!endpoint) return;
    await st.delete('endpoint');
    let res;
    try { res = await sendPush(endpoint, this.env); } catch (e) { res = null; }
    if (!res || res.status >= 500) { // one quick retry on transient failures
      try { await sendPush(endpoint, this.env); } catch (e) { /* give up; TTL would have expired anyway */ }
    }
  }
}

async function vapidJwt(audience, env) {
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || 'https://example.com/',
  })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(head + '.' + claims)));
  return head + '.' + claims + '.' + b64u(sig);
}

// Public key (uncompressed P-256 point) derived from the private JWK, so only one secret has to be configured.
function vapidPublicKey(env) {
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  const pad = (s) => s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const raw = (s) => Uint8Array.from(atob(pad(s)), (c) => c.charCodeAt(0));
  const out = new Uint8Array(65);
  out[0] = 4;
  out.set(raw(jwk.x), 1);
  out.set(raw(jwk.y), 33);
  return b64u(out);
}

async function sendPush(endpoint, env) {
  const audience = new URL(endpoint).origin;
  const jwt = await vapidJwt(audience, env);
  return fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: 'vapid t=' + jwt + ', k=' + vapidPublicKey(env),
      TTL: String(TTL),
      Urgency: 'high',
    },
  });
}
