// Zerion wallet exporter: static UI + a small API that proxies Zerion so the
// API key never has to live in the browser.
//
//   ZERION_API_KEY=zk_... node server.js
//
// Env: ZERION_API_KEY, PORT (default 3000), HOST (default 127.0.0.1),
//      SCAN_CONCURRENCY (default 2), ZERION_RATE_LIMIT (requests per second
//      across all scans, default 1; 0 for no limit).

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, createRateLimiter } from './lib/zerion.js';
import { scanWallet } from './lib/holdings.js';
import { findAddress } from './public/lib/wallets.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MAX_BODY = 1024 * 1024;
const MAX_WALLETS = 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

async function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'Forbidden' });
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

// One line per 429, with Zerion's per-org counters, to show which limit was hit.
function logThrottle({ url, attempt, tier, second, day, month }) {
  const w = (x) => (x.limit === null ? '?' : `${x.remaining ?? '?'}/${x.limit} left, reset ${x.reset ?? '?'}s`);
  const path = new URL(url).pathname.replace(/\/wallets\/[^/]+/, '/wallets/…');
  console.warn(`429 ${path} attempt ${attempt + 1} tier=${tier ?? '?'} second: ${w(second)}; day: ${w(day)}; month: ${w(month)}`);
}

// Streams NDJSON: one {type:"wallet", index, result} line per wallet as it
// finishes, then {type:"done"}. Lets the UI show progress on long lists.
async function handleScan(req, res, { fetchImpl, concurrency, rateLimiter }) {
  const body = await readJson(req);
  const apiKey = (body.apiKey || '').trim() || process.env.ZERION_API_KEY;
  if (!apiKey) return sendJson(res, 400, { error: 'No Zerion API key: set ZERION_API_KEY on the server or enter one in the form.' });

  const wallets = Array.isArray(body.wallets) ? body.wallets : [];
  if (!wallets.length) return sendJson(res, 400, { error: 'No wallets supplied' });
  if (wallets.length > MAX_WALLETS) return sendJson(res, 400, { error: `At most ${MAX_WALLETS} wallets per scan` });
  for (const w of wallets) {
    if (typeof w?.address !== 'string' || findAddress(w.address)?.address !== w.address) {
      return sendJson(res, 400, { error: `Invalid address: ${w?.address}` });
    }
  }

  const options = {
    costBasis: body.options?.costBasis === true,
    minValueUsd: Number(body.options?.minValueUsd) || 0,
    includeUnpriced: Boolean(body.options?.includeUnpriced),
    includeSpam: body.options?.includeSpam === true,
    excludeDuplicatePositions: body.options?.excludeDuplicatePositions !== false,
  };
  const client = createClient({ apiKey, fetchImpl, rateLimiter, onThrottle: logThrottle });

  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
  let aborted = false;
  res.on('close', () => (aborted = !res.writableFinished));

  let next = 0;
  async function worker() {
    while (!aborted && next < wallets.length) {
      const index = next++;
      const w = wallets[index];
      const result = await scanWallet(client, { address: w.address, name: String(w.name || '').trim() }, options);
      if (!aborted) res.write(JSON.stringify({ type: 'wallet', index, result }) + '\n');
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, wallets.length) }, worker));
  if (!aborted) res.end(JSON.stringify({ type: 'done' }) + '\n');
}

export function rateLimitFromEnv(value = process.env.ZERION_RATE_LIMIT) {
  if (value === undefined || value.trim() === '') return 1;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`ZERION_RATE_LIMIT must be a number >= 0 (requests per second), got "${value}"`);
  return n;
}

export function createServer({ fetchImpl = globalThis.fetch, concurrency = Number(process.env.SCAN_CONCURRENCY) || 2, rateLimit = rateLimitFromEnv() } = {}) {
  // One limiter for the whole server, so concurrent scans share the key's budget.
  const rateLimiter = createRateLimiter(rateLimit);
  return http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://x');
      if (pathname === '/api/config' && req.method === 'GET') {
        return sendJson(res, 200, { hasServerKey: Boolean(process.env.ZERION_API_KEY) });
      }
      if (pathname === '/api/scan' && req.method === 'POST') {
        return await handleScan(req, res, { fetchImpl, concurrency, rateLimiter });
      }
      if (req.method === 'GET') return await serveStatic(req, res);
      sendJson(res, 405, { error: 'Method not allowed' });
    } catch (err) {
      if (res.headersSent) return res.end();
      sendJson(res, err.status || 500, { error: err.message });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '127.0.0.1';
  createServer().listen(port, host, () => {
    console.log(`Zerion exporter on http://${host}:${port}`);
    if (!process.env.ZERION_API_KEY) console.log('ZERION_API_KEY not set; the UI will ask for a key.');
  });
}
