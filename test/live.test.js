// Scans against trimmed real Zerion responses (test/fixtures/zerion-live.json)
// so the field names and shapes the code relies on are checked against what
// the API actually returns, not just hand-written mocks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createClient } from '../lib/zerion.js';
import { scanWallet } from '../lib/holdings.js';

const live = JSON.parse(readFileSync(new URL('./fixtures/zerion-live.json', import.meta.url)));

// Mimics the live API: Solana rejects filter[positions]=no_filter, /pnl/
// redirects, and PnL for native ETH can come back without a breakdown.
function liveFetch(calls = []) {
  return async (url) => {
    calls.push(String(url));
    const u = new URL(url);
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const wallet = Object.values(live).find((w) => w.address && u.pathname.includes(`/wallets/${w.address}/`));
    if (!wallet) return json(404, {});
    if (u.pathname.endsWith('/positions/')) {
      if (wallet === live.solana && u.searchParams.get('filter[positions]') !== 'only_simple') return json(400, live.solana.noFilterError);
      return json(200, wallet.positions);
    }
    if (u.pathname.endsWith('/pnl/')) return new Response('', { status: 301, headers: { location: u.pathname.slice(0, -1) + u.search } });
    if (u.pathname.endsWith('/pnl')) {
      const ids = u.searchParams.get('filter[fungible_ids]').split(',');
      const pnl = ids.length === 1 && ids[0] === 'eth' && wallet.nativeEthPnl ? wallet.nativeEthPnl : wallet.pnl;
      return pnl ? json(200, pnl) : json(404, {});
    }
    return json(404, {});
  };
}

const client = (calls) => createClient({ apiKey: 'k', fetchImpl: liveFetch(calls), backoffMs: 1 });

test('live shapes: EVM wallet balances and protocol deposits aggregate by ticker', async () => {
  const r = await scanWallet(client(), { address: live.evm.address, name: 'hayden' });
  assert.equal(r.status, 'ok');
  const byTicker = Object.fromEntries(r.holdings.map((h) => [h.ticker, h]));
  assert.deepEqual(Object.keys(byTicker), ['UNI', 'ETH', 'USDC']);
  assert.equal(byTicker.UNI.quantity, '10003.1001');
  // Wallet ETH on Base and Arbitrum plus the Aztec deposit on Ethereum.
  assert.equal(byTicker.ETH.quantity, '4.627108906667100695');
  assert.deepEqual(byTicker.ETH.chains, ['ethereum', 'base', 'arbitrum']);
  assert.deepEqual(byTicker.ETH.protocols, ['Aztec']);
  // Uniswap V3 LP deposit of USDC, with no wallet USDC.
  assert.equal(byTicker.USDC.quantity, '555.455456');
  assert.deepEqual(byTicker.USDC.protocols, ['Uniswap V3']);
  assert.deepEqual(r.liabilities, []);
  assert.deepEqual(r.warnings, []);
});

test('live shapes: unpriced positions (value null, price 0) have no price', async () => {
  const r = await scanWallet(client(), { address: live.evm.address }, { includeUnpriced: true });
  const hay = r.holdings.find((h) => h.ticker === 'HAY');
  assert.equal(hay.valueUsd, null);
  assert.equal(hay.priceUsd, null);
  assert.deepEqual(hay.protocols, ['Uniswap V4']);
  assert.equal(r.holdings.find((h) => h.ticker === 'UNI').priceUsd, 7.198030588799999);
});

test('live shapes: cost basis from breakdown.by_id; /pnl without trailing slash', async () => {
  const calls = [];
  const r = await scanWallet(client(calls), { address: live.evm.address }, { costBasis: true });
  const pnlCalls = calls.filter((c) => c.includes('/pnl'));
  assert.equal(pnlCalls.length, 1);
  assert.match(pnlCalls[0], /\/pnl\?/);
  const cb = Object.fromEntries(r.holdings.map((h) => [h.ticker, h.costBasisUsd]));
  const byId = live.evm.pnl.data.attributes.breakdown.by_id;
  for (const [ticker, id] of [['UNI', '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984'], ['ETH', 'eth'], ['USDC', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48']]) {
    assert.equal(cb[ticker], byId[id].total_invested - byId[id].realized_cost_basis, ticker);
    assert.equal(cb[ticker], byId[id].net_invested, ticker);
  }
  assert.deepEqual(r.warnings, []);
});

test('live shapes: PnL without a breakdown yields no cost basis', async () => {
  const c = client();
  const pnl = await c.pnl(live.defi.address, ['eth']);
  assert.equal(pnl.attributes.breakdown, undefined);
  const eth = live.evm.positions.data.filter((p) => p.relationships.fungible.data.id === 'eth');
  const r = await scanWallet({ ...c, positions: async () => eth }, { address: live.defi.address }, { costBasis: true });
  assert.equal(r.holdings[0].costBasisUsd, null);
  assert.deepEqual(r.warnings, ['No cost basis from Zerion for: ETH']);
});

test('live shapes: Solana uses only_simple and counts rent-locked SOL', async () => {
  const calls = [];
  const r = await scanWallet(client(calls), { address: live.solana.address, name: '' });
  assert.equal(r.status, 'ok', r.error);
  assert.equal(new URL(calls[0]).searchParams.get('filter[positions]'), 'only_simple');
  const sol = r.holdings.find((h) => h.ticker === 'SOL');
  assert.equal(sol.quantity, '1330.985333554');
  assert.deepEqual(sol.protocols, ['Solana']);
  assert.match(r.warnings[0], /does not report DeFi protocol positions for Solana/);

  const evmCalls = [];
  await scanWallet(client(evmCalls), { address: live.evm.address });
  assert.equal(new URL(evmCalls[0]).searchParams.get('filter[positions]'), 'no_filter');
});

test('live shapes: hidden receipt tokens are dropped and unrelated tokens are not flagged', async () => {
  const r = await scanWallet(client(), { address: live.defi.address, name: '' });
  assert.ok(!r.holdings.some((h) => h.ticker === 'aUSDC'));
  assert.ok(!r.warnings.some((w) => w.includes('double count')));
  const usdc = r.holdings.find((h) => h.ticker === 'USDC');
  assert.deepEqual(usdc.protocols, ['Yearn V3']);
  assert.ok(r.holdings.some((h) => h.ticker === 'RELICS'));
});
