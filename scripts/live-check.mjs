// Checks the live Zerion API still returns what the app relies on. Run by the
// weekly "Zerion live check" workflow; needs ZERION_API_KEY.
//
//   ZERION_API_KEY=zk_... node scripts/live-check.mjs
//
// Uses the public wallets already in test/fixtures/zerion-live.json. Checks
// shapes, not balances, since those change.

import { readFileSync } from 'node:fs';
import { createClient, createRateLimiter } from '../lib/zerion.js';
import { scanWallet } from '../lib/holdings.js';

const fixtures = JSON.parse(readFileSync(new URL('../test/fixtures/zerion-live.json', import.meta.url)));
const WALLETS = [
  // costBasis: this wallet had PnL breakdown entries when the fixtures were captured.
  { label: 'EVM with protocol positions (hayden.eth)', address: fixtures.evm.address, costBasis: true },
  { label: 'EVM large (vitalik.eth)', address: fixtures.defi.address, costBasis: false },
  { label: 'Solana (toly)', address: fixtures.solana.address, costBasis: false },
];

const apiKey = process.env.ZERION_API_KEY;
if (!apiKey) {
  console.error('ZERION_API_KEY is not set');
  process.exit(2);
}
const client = createClient({ apiKey, rateLimiter: createRateLimiter(Number(process.env.ZERION_RATE_LIMIT) || 1) });

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
  return ok;
};
const isNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

for (const w of WALLETS) {
  const where = `${w.label} (${w.address})`;
  let positions;
  try {
    positions = await client.positions(w.address);
  } catch (err) {
    check(false, `${where}: positions request failed: ${err.message}`);
    continue;
  }
  if (!check(positions.length > 0, `${where}: no positions returned`)) continue;

  // Every field lib/holdings.js reads from a position.
  for (const p of positions) {
    const a = p.attributes || {};
    const id = `${where} position ${p.id}`;
    check(isNum(a.quantity?.numeric) || isNum(a.quantity?.float), `${id}: no quantity.numeric/float`);
    check(typeof a.position_type === 'string', `${id}: no position_type`);
    check(typeof a.fungible_info?.symbol === 'string', `${id}: no fungible_info.symbol`);
    check(typeof p.relationships?.fungible?.data?.id === 'string', `${id}: no relationships.fungible.data.id`);
    check(typeof p.relationships?.chain?.data?.id === 'string', `${id}: no relationships.chain.data.id`);
    check(a.value === null || isNum(a.value), `${id}: value is neither null nor a number`);
    if (a.position_type !== 'wallet') check(typeof (a.protocol || a.application_metadata?.name) === 'string', `${id}: protocol position without protocol name`);
  }
  const types = [...new Set(positions.map((p) => p.attributes?.position_type))].sort();

  const result = await scanWallet(client, { address: w.address, name: '' }, { costBasis: w.costBasis });
  check(result.status === 'ok', `${where}: scan failed: ${result.error}`);
  check(result.holdings.length > 0, `${where}: scan produced no holdings`);
  for (const warning of result.warnings) {
    check(!warning.startsWith('Cost basis unavailable'), `${where}: ${warning}`);
  }
  if (w.costBasis) {
    check(result.holdings.some((h) => h.costBasisUsd !== null), `${where}: no holding got a cost basis (PnL breakdown.by_id shape changed?)`);
  }

  console.log(`${where}: ${positions.length} positions [${types.join(', ')}], ${result.holdings.length} holdings, ${result.liabilities.length} liabilities, ${result.warnings.length} warnings`);
}

if (failures.length) {
  console.error(`\n${failures.length} problem(s):`);
  for (const f of failures.slice(0, 50)) console.error(`- ${f}`);
  process.exit(1);
}
console.log('\nLive Zerion API matches what the app expects.');
