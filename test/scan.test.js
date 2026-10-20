import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, createRateLimiter } from '../lib/zerion.js';
import { buildHoldings, DEFAULT_INDIVIDUAL, MISC_TICKER, scanWallet, tickerPrices } from '../lib/holdings.js';
import { render, toCsv } from '../public/lib/formats.js';
import { createServer, rateLimitFromEnv } from '../server.js';
import { EVM, EVM2, fakeFetch } from './fixtures.js';

const client = (opts) => createClient({ apiKey: 'zk_test', fetchImpl: fakeFetch(opts), backoffMs: 1 });

test('aggregates chains, protocol positions and same-ticker fungibles; loans are liabilities', async () => {
  const calls = [];
  const r = await scanWallet(client({ calls }), { address: EVM, name: '' }, { minValueUsd: 1, costBasis: true });
  assert.equal(r.status, 'ok');
  assert.equal(r.accountName, '7f3a...c9d2');
  assert.deepEqual(
    r.holdings.map((h) => [h.ticker, h.quantity, h.costBasisUsd]),
    [
      ['ETH', '4.250000000000000001', 9800],
      ['aEthWETH', '1', null],
      ['USDT', '2500', null],
      ['USDC', '150.5', 150],
    ],
  );
  assert.deepEqual(
    r.liabilities.map((l) => [l.ticker, l.quantity, l.valueUsd, l.protocols]),
    [
      ['WBTC', '0.1', 6000, ['Aave V3']],
      ['USDC', '20', 20, ['Aave V3']],
    ],
  );
  const doubles = r.warnings.filter((w) => w.includes('double count'));
  assert.equal(doubles.length, 1);
  assert.match(doubles[0], /^Likely double count on ethereum: aEthWETH in wallet \(\$2500\) and Zerion's Aave V3 deposit position of ETH \(\$2500\) look like the same funds\. Kept aEthWETH; left out the Aave V3 deposit position of ETH\.$/);
  assert.match(calls[0].init.headers.authorization, /^Basic /);
  assert.equal(Buffer.from(calls[0].init.headers.authorization.slice(6), 'base64').toString(), 'zk_test:');
  const pnlCall = calls.find((c) => c.url.includes('/pnl?'));
  assert.equal(new URL(pnlCall.url).searchParams.get('filter[fungible_ids]'), 'eth,usdc-a,usdc-b,a-eth-weth,usdt,dust,mystery');
  assert.equal(new URL(calls[0].url).searchParams.get('filter[positions]'), 'no_filter');
  // The held aToken is kept; the decoded Aave deposit is left out.
  assert.deepEqual(r.holdings[0].protocols, []);
});

test('duplicate protocol positions can be kept', async () => {
  const r = await scanWallet(client(), { address: EVM, name: '' }, { minValueUsd: 1, excludeDuplicatePositions: false });
  assert.deepEqual(r.holdings.map((h) => h.ticker), ['ETH', 'aEthWETH', 'USDT', 'USDC']);
  assert.match(r.warnings.find((w) => w.includes('double count')), /^Likely double count .*Both are reported\.$/);
});

test('unpriced tokens are optional; cost basis is opt-in', async () => {
  const calls = [];
  const r = await scanWallet(client({ calls }), { address: EVM, name: 'X' }, { includeUnpriced: true });
  assert.ok(!calls.some((c) => c.url.includes('/pnl?')));
  const myst = r.holdings.find((h) => h.ticker === 'MYST');
  assert.equal(myst.quantity, '1000');
  assert.ok(r.holdings.every((h) => h.costBasisUsd === null));
  assert.ok(!r.holdings.some((h) => h.ticker === 'ZERO'));
});

test('wallet errors are captured, not thrown', async () => {
  const r = await scanWallet(client({ fail: { [EVM]: 400 } }), { address: EVM, name: '' });
  assert.equal(r.status, 'error');
  assert.match(r.error, /400: boom/);
});

test('retries 429 then succeeds', async () => {
  let n = 0;
  const base = fakeFetch();
  const fetchImpl = async (url, init) => (n++ === 0 ? new Response('{}', { status: 429 }) : base(url, init));
  const r = await scanWallet(createClient({ apiKey: 'k', fetchImpl, backoffMs: 1 }), { address: EVM }, { costBasis: false });
  assert.equal(r.status, 'ok');
});

test('Range v0.1 CSV output', async () => {
  const r = await scanWallet(client(), { address: EVM, name: 'Ledger, Main' }, { minValueUsd: 1, costBasis: true });
  const out = render('range-v0.1-csv', [r]);
  assert.equal(
    out.text,
    'account_name,ticker,quantity,price_usd,value_usd,cost_basis_usd,last4,wallet_address\n' +
      `"Ledger, Main",ETH,4.250000000000000001,2500,10625,9800,c9d2,${EVM}\n` +
      `"Ledger, Main",aEthWETH,1,2500,2500,,c9d2,${EVM}\n` +
      `"Ledger, Main",USDT,2500,1,2500,,c9d2,${EVM}\n` +
      `"Ledger, Main",USDC,150.5,1,150.5,150,c9d2,${EVM}\n`,
  );
  // Price and value columns are optional.
  const bare = render('range-v0.1-csv', [r], { price: false, value: false });
  assert.deepEqual(bare.columns, ['account_name', 'ticker', 'quantity', 'cost_basis_usd', 'last4', 'wallet_address']);
  assert.deepEqual(bare.rows[0], ['Ledger, Main', 'ETH', '4.250000000000000001', '9800', 'c9d2', EVM]);
  assert.deepEqual(render('range-v0.1-liabilities-csv', [r], { price: false, value: false }).columns, ['account_name', 'ticker', 'quantity', 'balance_usd', 'protocol', 'last4', 'wallet_address']);
  assert.equal(
    render('range-v0.1-liabilities-csv', [r]).text,
    'account_name,ticker,quantity,price_usd,balance_usd,protocol,last4,wallet_address\n' +
      `"Ledger, Main",WBTC,0.1,60000,6000,Aave V3,c9d2,${EVM}\n` +
      `"Ledger, Main",USDC,20,1,20,Aave V3,c9d2,${EVM}\n`,
  );
  assert.equal(
    render('range-v0.1-csv', [{ ...r, holdings: [{ ticker: 'SHIB', quantity: '1', priceUsd: 0.0000123456789 }] }]).rows[0][3],
    '0.000012345679',
  );
  assert.equal(toCsv(['a'], [['say "hi"']]), 'a\n"say ""hi"""\n');
});

test('display options rebuild from raw scan data like a fresh scan', async () => {
  const calls = [];
  const once = await scanWallet(client({ calls }), { address: EVM }, { costBasis: true });
  const requests = calls.length;
  for (const options of [
    { costBasis: true, minValueUsd: 200 },
    { costBasis: true, minValueUsd: 1, excludeDuplicatePositions: false },
    { costBasis: false, includeUnpriced: true },
  ]) {
    const fresh = await scanWallet(client(), { address: EVM }, options);
    const rebuilt = buildHoldings(JSON.parse(JSON.stringify(once.raw)), options);
    assert.deepEqual(rebuilt.holdings, fresh.holdings);
    assert.deepEqual(rebuilt.liabilities, fresh.liabilities);
    assert.deepEqual([...once.scanWarnings, ...rebuilt.warnings], fresh.warnings);
  }
  assert.equal(calls.length, requests);
});

test('spam is dropped by default; a scan that fetched it can toggle it without rescanning', async () => {
  const calls = [];
  const plain = await scanWallet(client({ calls }), { address: EVM }, { minValueUsd: 1 });
  assert.equal(new URL(calls[0].url).searchParams.get('filter[trash]'), 'only_non_trash');
  assert.ok(!plain.holdings.some((h) => h.ticker === 'FREE-AIRDROP'));
  assert.equal(plain.raw.includesSpam, false);

  calls.length = 0;
  const r = await scanWallet(client({ calls }), { address: EVM }, { minValueUsd: 1, includeSpam: true });
  assert.ok(calls.every((c) => !c.url.includes('/positions') && !c.url.includes('next-page') || new URL(c.url).searchParams.get('filter[trash]') === 'no_filter'));
  assert.equal(r.raw.includesSpam, true);
  assert.equal(r.holdings[1].ticker, 'FREE-AIRDROP');
  assert.ok(!buildHoldings(r.raw, { minValueUsd: 1 }).holdings.some((h) => h.ticker === 'FREE-AIRDROP'));
  assert.deepEqual(buildHoldings(r.raw, { minValueUsd: 1 }).holdings, plain.holdings);
});

test('remap renames tickers, merges rows, and prices unpriced tokens as the target', async () => {
  const r = await scanWallet(client(), { address: EVM }, {});
  const built = buildHoldings(r.raw, { minValueUsd: 1, remap: { myst: 'USDC', 'aEthWETH': 'ETH' }, referencePrices: tickerPrices([r.raw]) });
  const usdc = built.holdings.find((h) => h.ticker === 'USDC');
  assert.equal(usdc.quantity, '1150.5');
  assert.equal(usdc.valueUsd, 1150.5);
  assert.ok(!built.holdings.some((h) => h.ticker === 'MYST' || h.ticker === 'aEthWETH'));
  assert.equal(built.holdings.find((h) => h.ticker === 'ETH').quantity, '5.250000000000000001');
  // Loans are remapped too.
  assert.equal(buildHoldings(r.raw, { remap: { WBTC: 'BTC' } }).liabilities[0].ticker, 'BTC');
});

test('misc folds small and listed tokens into one row reported nowhere else', async () => {
  const r = await scanWallet(client(), { address: EVM, name: 'Main' }, {});
  const built = buildHoldings(r.raw, { misc: { belowUsd: 200, tickers: ['usdt'] } });
  assert.deepEqual(built.holdings.map((h) => h.ticker), ['ETH', 'aEthWETH', MISC_TICKER]);
  const misc = built.holdings.at(-1);
  assert.deepEqual(misc.miscTokens, ['USDT', 'USDC', 'DUST']);
  assert.equal(misc.quantity, '2650.51');
  assert.equal(misc.priceUsd, 1);
  assert.deepEqual(render('range-v0.1-csv', [{ ...r, holdings: built.holdings }]).rows.at(-1).slice(0, 5), ['Main', MISC_TICKER, '2650.51', '1', '2650.51']);
  // Split per chain, each chain's part keeps price 1.
  const perChain = render('range-v0.1-csv', [{ ...r, holdings: built.holdings }], { chainMode: 'rows' }).rows.filter((row) => row[1] === MISC_TICKER);
  assert.deepEqual(perChain.map((row) => [row[2], row[3]]), [['2600', '1'], ['50.5', '1'], ['0.01', '1']]);
  assert.equal(buildHoldings(r.raw, { misc: null }).holdings.length, 5);
});

test('individual tokens get their own account, always with price and value, and skip misc', async () => {
  const r = await scanWallet(client(), { address: EVM, name: 'Main' }, {});
  const built = buildHoldings(r.raw, { minValueUsd: 1, individual: ['usdt'], misc: { belowUsd: 5000, tickers: [] } });
  const wallet = { ...r, holdings: built.holdings };

  const out = render('range-v0.1-csv', [wallet], { price: false, value: false });
  // Hidden columns stay because an individual account needs them, blank elsewhere.
  assert.deepEqual(out.columns, ['account_name', 'ticker', 'quantity', 'price_usd', 'value_usd', 'cost_basis_usd', 'last4', 'wallet_address']);
  assert.deepEqual(out.rows.map((row) => row.slice(0, 5)), [
    ['Main', 'ETH', '4.250000000000000001', '', ''],
    ['Main', MISC_TICKER, '2650.5', '', ''],
    ['Main:USDT', 'USDT', '2500', '1', '2500'],
  ]);
  assert.equal(out.rows[2][7], EVM);

  // Without individual rows, hidden columns are dropped as before.
  const plain = render('range-v0.1-csv', [{ ...r, holdings: buildHoldings(r.raw, { minValueUsd: 1 }).holdings }], { price: false, value: false });
  assert.ok(!plain.columns.includes('price_usd'));
  // Combines with one account per chain.
  const perChain = render('range-v0.1-csv', [wallet], { chainMode: 'accounts' }).rows;
  assert.deepEqual(perChain.filter((row) => row[1] === 'USDT').map((row) => row[0]), ['Main (Ethereum):USDT']);
  assert.deepEqual(DEFAULT_INDIVIDUAL, ['TOBY', 'FTM', 'weETH']);
});

test('chain modes: combine, one row per chain, one account per chain', async () => {
  const r = await scanWallet(client(), { address: EVM, name: 'Main' }, { minValueUsd: 1, costBasis: true });
  const tickers = (mode) => render('range-v0.1-csv', [r], { chainMode: mode, value: false }).rows.map((row) => row.slice(0, 5).join(' '));
  assert.deepEqual(tickers('combine'), ['Main ETH 4.250000000000000001 2500 9800', 'Main aEthWETH 1 2500 ', 'Main USDT 2500 1 ', 'Main USDC 150.5 1 150']);
  // Split rows keep exact quantities; cost basis is per token, so it is blank once split.
  assert.deepEqual(tickers('rows'), [
    'Main ETH 4.000000000000000001 2500 ',
    'Main ETH 0.25 2500 ',
    'Main aEthWETH 1 2500 ',
    'Main USDT 2500 1 ',
    'Main USDC 100 1 ',
    'Main USDC 50.5 1 ',
  ]);
  assert.deepEqual(tickers('accounts'), [
    'Main (Ethereum) ETH 4.000000000000000001 2500 ',
    'Main (Ethereum) aEthWETH 1 2500 ',
    'Main (Ethereum) USDT 2500 1 ',
    'Main (Ethereum) USDC 100 1 ',
    'Main (Arbitrum) ETH 0.25 2500 ',
    'Main (Polygon) USDC 50.5 1 ',
  ]);
  assert.deepEqual(
    render('range-v0.1-liabilities-csv', [r], { chainMode: 'accounts' }).rows.map((row) => row[0]),
    ['Main (Ethereum)', 'Main (Ethereum)'],
  );
});

test('server streams NDJSON scan results', async () => {
  process.env.ZERION_API_KEY = 'zk_env';
  const server = createServer({ fetchImpl: fakeFetch({ fail: { [EVM2]: 401 } }), rateLimit: 0 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/scan`, {
      method: 'POST',
      body: JSON.stringify({ wallets: [{ address: EVM, name: 'Main' }, { address: EVM2 }], options: { minValueUsd: 1 } }),
    });
    assert.equal(res.status, 200);
    const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.at(-1).type, 'done');
    const byIndex = Object.fromEntries(lines.filter((l) => l.type === 'wallet').map((l) => [l.index, l.result]));
    assert.equal(byIndex[0].holdings.length, 4);
    assert.equal(byIndex[0].liabilities.length, 2);
    assert.equal(byIndex[1].status, 'error');

    const bad = await fetch(`${base}/api/scan`, { method: 'POST', body: JSON.stringify({ wallets: [{ address: 'nope' }] }) });
    assert.equal(bad.status, 400);

    const page = await fetch(`${base}/`);
    assert.match(await page.text(), /Zerion Wallet Exporter/);
    assert.equal((await fetch(`${base}/..%2fserver.js`)).status, 403);
  } finally {
    server.close();
    delete process.env.ZERION_API_KEY;
  }
});

const throttled = (headers) => new Response('{"errors":[{"detail":"Your request had been throttled"}]}', { status: 429, headers });

test('429 with a used-up daily quota fails fast without retrying', async () => {
  let n = 0;
  const seen = [];
  const fetchImpl = async () => {
    n++;
    return throttled({ 'RateLimit-Org-Day-Limit': '2000', 'RateLimit-Org-Day-Remaining': '0', 'RateLimit-Org-Day-Reset': '5400' });
  };
  const c = createClient({ apiKey: 'k', fetchImpl, backoffMs: 1, onThrottle: (i) => seen.push(i) });
  const r = await scanWallet(c, { address: EVM });
  assert.equal(n, 1);
  assert.equal(r.error, 'Zerion API 429: daily request quota (2000) is used up for this API key; it resets in 90 min');
  assert.equal(seen[0].day.remaining, 0);
});

test('429 waits for the per-second reset, and the limiter adopts the key limit', async () => {
  let n = 0;
  const base = fakeFetch();
  const fetchImpl = async (url, init) => {
    if (n++ === 0) return throttled({ 'RateLimit-Org-Second-Limit': '10', 'RateLimit-Org-Second-Remaining': '0', 'RateLimit-Org-Second-Reset': '0.05' });
    return base(url, init);
  };
  const limiter = createRateLimiter(100);
  const t = Date.now();
  const r = await scanWallet(createClient({ apiKey: 'k', fetchImpl, backoffMs: 1, rateLimiter: limiter }), { address: EVM });
  assert.equal(r.status, 'ok');
  assert.ok(Date.now() - t >= 45);
  assert.equal(limiter.perSecond(), 10);
});

test('advanced requests throttled with budget left: one retry, then wallet balances only', async () => {
  const urls = [];
  const base = fakeFetch();
  const fetchImpl = async (url, init) => {
    urls.push(url);
    if (url.includes('no_filter')) return throttled({ 'RateLimit-Org-Second-Limit': '1', 'RateLimit-Org-Second-Remaining': '1', 'RateLimit-Org-Day-Limit': '300', 'RateLimit-Org-Day-Remaining': '196' });
    return base(url, init);
  };
  const c = createClient({ apiKey: 'k', fetchImpl, backoffMs: 1, blockedRetryMs: 1 });
  const r = await scanWallet(c, { address: EVM });
  assert.equal(r.status, 'ok');
  assert.match(r.warnings[0], /^DeFi protocol positions .* are missing/);
  assert.equal(urls.filter((u) => u.includes('no_filter')).length, 2);
  assert.ok(urls.some((u) => u.includes('only_simple')));

  // Later wallets in the same scan skip the blocked request.
  urls.length = 0;
  const r2 = await scanWallet(c, { address: EVM2 });
  assert.equal(r2.status, 'ok');
  assert.ok(!urls.some((u) => u.includes('no_filter')));
});

test('rate limiter spaces requests across concurrent callers', async () => {
  const starts = [];
  const fetchImpl = async (url, init) => {
    starts.push(Date.now());
    return fakeFetch()(url, init);
  };
  const c = createClient({ apiKey: 'k', fetchImpl, rateLimiter: createRateLimiter(20) });
  await Promise.all([scanWallet(c, { address: EVM }), scanWallet(c, { address: EVM2 })]);
  assert.equal(starts.length, 4);
  const gaps = starts.slice(1).map((t, i) => t - starts[i]);
  assert.ok(gaps.every((g) => g >= 45), `gaps ${gaps}`);
});

test('ZERION_RATE_LIMIT parsing', () => {
  assert.equal(rateLimitFromEnv(undefined), 1);
  assert.equal(rateLimitFromEnv(''), 1);
  assert.equal(rateLimitFromEnv('2.5'), 2.5);
  assert.equal(rateLimitFromEnv('0'), 0);
  assert.throws(() => rateLimitFromEnv('fast'), /ZERION_RATE_LIMIT/);
  assert.throws(() => rateLimitFromEnv('-1'), /ZERION_RATE_LIMIT/);
});
