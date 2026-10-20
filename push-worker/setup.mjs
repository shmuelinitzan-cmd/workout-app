// One-time setup for the rest-timer push worker.
//
//   1. npx wrangler login          (once, opens the browser; free Cloudflare account)
//   2. node setup.mjs              (from this folder)
//
// What it does: creates the VAPID key pair (first run only), deploys the worker, stores the private key as a
// Cloudflare secret, and writes the worker URL + public key into ../index.html (and bumps the cache version in
// ../sw.js so phones pick the change up). The private key never touches the repo.
// Re-running is safe: with a key already in index.html it only redeploys.

import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const indexPath = join(here, '..', 'index.html');
const swPath = join(here, '..', 'sw.js');

const URL_RE = /var PUSH_URL='([^']*)';/;
const KEY_RE = /var VAPID_PUB='([^']*)';/;

export function b64u(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function newVapidKeys() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return { privateJwk: JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d }), publicKey: b64u(pub) };
}

export function patchIndex(html, workerUrl, publicKey) {
  if (!URL_RE.test(html) || !KEY_RE.test(html)) throw new Error('PUSH_URL / VAPID_PUB lines not found in index.html');
  return html.replace(URL_RE, () => "var PUSH_URL='" + workerUrl + "';").replace(KEY_RE, () => "var VAPID_PUB='" + publicKey + "';");
}

export function bumpCache(sw) {
  return sw.replace(/var CACHE_VERSION = 'v(\d+)';/, (m, n) => "var CACHE_VERSION = 'v" + (Number(n) + 1) + "';");
}

// Runs a command, shows its output live, and also returns it (needed to read the deployed URL).
function run(args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn('npx', ['--yes', 'wrangler', ...args], {
      cwd: here, shell: process.platform === 'win32', stdio: [input === undefined ? 'inherit' : 'pipe', 'pipe', 'pipe'],
    });
    let out = '';
    const tee = (stream, sink) => stream.on('data', (d) => { out += d; sink.write(d); });
    tee(p.stdout, process.stdout);
    tee(p.stderr, process.stderr);
    if (input !== undefined) { p.stdin.write(input); p.stdin.end(); }
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error('wrangler ' + args.join(' ') + ' failed (exit ' + code + ')'))));
  });
}

async function main() {
  const html = readFileSync(indexPath, 'utf8');
  const existingKey = (html.match(KEY_RE) || [])[1];
  const keys = existingKey ? null : newVapidKeys();

  console.log('\n== Deploying worker ==');
  let out;
  try { out = await run(['deploy']); } catch (e) {
    throw new Error(e.message + '\nIf wrangler wanted to ask you something (e.g. choosing a workers.dev name), run "npx wrangler deploy" by hand once, then run this setup again.');
  }
  const m = out.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i);
  if (!m) throw new Error('Could not find the workers.dev URL in the deploy output. Put it in index.html (PUSH_URL) by hand.');
  const workerUrl = m[0];

  if (keys) {
    console.log('\n== Storing the private key as a secret ==');
    await run(['secret', 'put', 'VAPID_PRIVATE_JWK'], keys.privateJwk);
  }

  writeFileSync(indexPath, patchIndex(html, workerUrl, existingKey || keys.publicKey));
  writeFileSync(swPath, bumpCache(readFileSync(swPath, 'utf8')));
  console.log('\nDone.\n  worker: ' + workerUrl + '\nNow commit and push index.html + sw.js, open the app on the phone, and turn on the lock-screen notification in the settings tab.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error('\nSetup failed: ' + e.message); process.exit(1); });
}
