// Minimal Zerion API client: auth, pagination, and retry on rate limits /
// "not ready yet" responses.

import { isEvmAddress } from '../public/lib/wallets.js';

const BASE_URL = 'https://api.zerion.io/v1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class ZerionError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * Spaces request starts at least 1/perSecond seconds apart, across every
 * caller sharing it. perSecond <= 0 (or not a number) means no limit.
 * wait.limitTo(n) lowers the rate to n/s if that is stricter (e.g. once
 * Zerion reports the key's per-second limit).
 */
export function createRateLimiter(perSecond) {
  let interval = perSecond > 0 ? 1000 / perSecond : 0;
  let nextStart = 0;
  async function wait() {
    if (!interval) return;
    const now = Date.now();
    const start = Math.max(now, nextStart);
    nextStart = start + interval;
    if (start > now) await sleep(start - now);
  }
  wait.limitTo = (n) => {
    if (n > 0 && 1000 / n > interval) interval = 1000 / n;
  };
  wait.perSecond = () => (interval ? 1000 / interval : 0);
  return wait;
}

/**
 * Zerion's per-org rate-limit headers, e.g. RateLimit-Org-Second-Limit,
 * -Remaining and -Reset, for the Second, Day and Month windows. Missing
 * values are null. Reset is in seconds.
 */
export function rateLimitInfo(headers) {
  const n = (name) => {
    const v = headers.get(name);
    return v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
  };
  const info = { tier: headers.get('ratelimit-org-tier') };
  for (const w of ['second', 'day', 'month']) {
    info[w] = { limit: n(`ratelimit-org-${w}-limit`), remaining: n(`ratelimit-org-${w}-remaining`), reset: n(`ratelimit-org-${w}-reset`) };
  }
  return info;
}

function formatWait(seconds) {
  if (seconds === null) return 'later';
  if (seconds < 120) return `in ${Math.ceil(seconds)}s`;
  if (seconds < 7200) return `in ${Math.ceil(seconds / 60)} min`;
  return `in ${Math.round(seconds / 3600)} h`;
}

export function createClient({ apiKey, fetchImpl = globalThis.fetch, baseUrl = BASE_URL, maxRetries = 5, backoffMs = 1000, rateLimiter = createRateLimiter(0), onThrottle = () => {}, blockedRetryMs = 3000 }) {
  if (!apiKey) throw new ZerionError('A Zerion API key is required', 401);
  const auth = 'Basic ' + Buffer.from(`${apiKey}:`).toString('base64');

  async function request(url) {
    for (let attempt = 0; ; attempt++) {
      await rateLimiter();
      const res = await fetchImpl(url, { headers: { accept: 'application/json', authorization: auth } });
      const limits = rateLimitInfo(res.headers);
      if (limits.second.limit && rateLimiter.limitTo) rateLimiter.limitTo(limits.second.limit);
      if (res.ok) return res.json();

      if (res.status === 429) {
        onThrottle({ url, attempt, ...limits });
        // A used-up daily or monthly quota won't clear by retrying.
        for (const [window, label] of [['month', 'monthly'], ['day', 'daily']]) {
          const w = limits[window];
          if (w.remaining === 0) {
            throw new ZerionError(`Zerion API 429: ${label} request quota${w.limit ? ` (${w.limit})` : ''} is used up for this API key; it resets ${formatWait(w.reset)}`, 429);
          }
        }
        // Throttled with org budget left: Zerion's advanced-request sublimit
        // (no_filter positions, PnL) is used up, or this wallet was requested
        // too often. Neither clears in seconds, so retry once, then give up.
        const reported = limits.second.limit !== null || limits.day.limit !== null;
        if (reported && limits.second.remaining !== 0) {
          if (attempt < 1) {
            await sleep(blockedRetryMs);
            continue;
          }
          const err = new ZerionError(
            "Zerion API 429: throttled although this key has requests left. Zerion's sublimit for advanced requests (DeFi positions, PnL) is probably used up, or this wallet was requested too often",
            429,
          );
          err.blocked = true;
          throw err;
        }
      }

      // 429: rate limited. 503 (and 202 on some endpoints): data is still being
      // prepared for a wallet Zerion hasn't indexed yet.
      const retryable = res.status === 429 || res.status === 503 || res.status === 502 || res.status === 504;
      if (retryable && attempt < maxRetries) {
        // Prefer the server's own reset time over blind backoff.
        const reset = res.status === 429 ? limits.second.reset : null;
        const retryAfter = Number(res.headers.get('retry-after'));
        const backoff = backoffMs * 2 ** attempt;
        await sleep(reset > 0 ? Math.max(reset * 1000, backoffMs) : retryAfter > 0 ? retryAfter * 1000 : backoff);
        continue;
      }

      let detail = '';
      try {
        const body = await res.json();
        detail = body?.errors?.map((e) => e.detail || e.title).filter(Boolean).join('; ') || '';
      } catch {}
      throw new ZerionError(`Zerion API ${res.status}${detail ? `: ${detail}` : ''}`, res.status);
    }
  }

  async function getAll(url) {
    const data = [];
    let next = url;
    while (next) {
      const page = await request(next);
      data.push(...(page.data || []));
      next = page.links?.next || null;
    }
    return data;
  }

  return {
    // All fungible positions (wallet balances and DeFi protocol positions such
    // as deposits, staking, LP and loans), spam filtered out, valued in USD.
    // Zerion rejects no_filter for Solana addresses ("currently not supported"),
    // so those get only_simple: wallet balances plus SOL locked as rent.
    // simple: true asks for wallet balances only (only_simple), which doesn't
    // count toward Zerion's advanced-request sublimit. includeSpam: true also
    // returns tokens Zerion flags as spam (flags.is_trash).
    positions(address, { simple = false, includeSpam = false } = {}) {
      const params = new URLSearchParams({
        'filter[positions]': isEvmAddress(address) && !simple ? 'no_filter' : 'only_simple',
        'filter[trash]': includeSpam ? 'no_filter' : 'only_non_trash',
        currency: 'usd',
        sort: 'value',
        'page[size]': '100',
      });
      return getAll(`${baseUrl}/wallets/${encodeURIComponent(address)}/positions/?${params}`);
    },

    // FIFO PnL restricted to the given fungibles; includes a per-fungible breakdown.
    async pnl(address, fungibleIds) {
      const params = new URLSearchParams({ currency: 'usd', 'filter[fungible_ids]': fungibleIds.join(',') });
      // No trailing slash: /pnl/ answers 301 to /pnl, costing a request.
      const body = await request(`${baseUrl}/wallets/${encodeURIComponent(address)}/pnl?${params}`);
      return body.data;
    },
  };
}
