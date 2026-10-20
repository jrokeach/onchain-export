// Turns raw Zerion positions + PnL into per-wallet holdings and liabilities,
// each aggregated by ticker. Shared by the server (scan) and the browser,
// which rebuilds results from the raw scan data when display options change.

import { addDecimals, normalizeDecimal } from './decimal.js';

export const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

function quantityOf(attrs) {
  const q = attrs.quantity || {};
  if (q.numeric != null) return normalizeDecimal(q.numeric);
  if (q.float != null) return normalizeDecimal(q.float);
  return '0';
}

/**
 * Remaining cost basis for one fungible from a PnL breakdown entry.
 * Under FIFO, what's still held cost total_invested minus the cost basis
 * already realized by sales. Falls back to value - unrealized_gain.
 */
export function costBasisFromPnl(entry, valueUsd) {
  if (!entry) return null;
  const totalInvested = num(entry.total_invested);
  const realizedCost = num(entry.realized_cost_basis);
  if (totalInvested !== null && realizedCost !== null) return totalInvested - realizedCost;
  const unrealized = num(entry.unrealized_gain);
  if (unrealized !== null && valueUsd !== null) return valueUsd - unrealized;
  return null;
}

const isZero = (q) => /^-?0(\.0*)?$/.test(q);
// Zerion hides some positions (displayable: false, e.g. receipt tokens it already
// counts elsewhere); those are always dropped. Spam is an option: see buildHoldings.
export const isVisible = (p) => p.attributes?.flags?.displayable !== false;
export const isSpam = (p) => Boolean(p.attributes?.flags?.is_trash);
export const isLoan = (p) => p.attributes?.position_type === 'loan';

/**
 * Group positions by fungible, summing chains and protocol positions, and
 * dropping hidden/zero balances. Callers split loans out first: quantities
 * and values here are magnitudes.
 */
export function groupPositions(positions) {
  const byFungible = new Map();
  for (const p of positions) {
    if (!isVisible(p)) continue;
    const a = p.attributes || {};
    const info = a.fungible_info || {};
    const fungibleId = p.relationships?.fungible?.data?.id || info.symbol || p.id;
    const chain = p.relationships?.chain?.data?.id;
    const quantity = quantityOf(a).replace(/^-/, '');
    if (isZero(quantity)) continue;

    let g = byFungible.get(fungibleId);
    if (!g) {
      // Unpriced positions come back as value: null, price: 0.
      g = { fungibleId, ticker: info.symbol || '?', name: info.name || '', quantity: '0', valueUsd: null, priceUsd: a.value == null ? null : num(a.price), chains: [], protocols: [], byChain: [] };
      byFungible.set(fungibleId, g);
    }
    g.quantity = addDecimals(g.quantity, quantity);
    const value = num(a.value);
    if (value !== null) g.valueUsd = (g.valueUsd ?? 0) + Math.abs(value);
    if (chain && !g.chains.includes(chain)) g.chains.push(chain);
    addToChain(g.byChain, { chain: chain || 'unknown', quantity, valueUsd: value === null ? null : Math.abs(value) });
    const protocol = a.protocol || a.application_metadata?.name;
    if (protocol && !g.protocols.includes(protocol)) g.protocols.push(protocol);
  }
  return [...byFungible.values()];
}

/** Add one chain's amount into a [{ chain, quantity, valueUsd }] list in place. */
function addToChain(byChain, part) {
  const c = byChain.find((x) => x.chain === part.chain);
  if (!c) return void byChain.push({ ...part });
  c.quantity = addDecimals(c.quantity, part.quantity);
  c.valueUsd = c.valueUsd === null && part.valueUsd === null ? null : (c.valueUsd ?? 0) + (part.valueUsd ?? 0);
}

const protocolOf = (p) => p.attributes?.protocol || p.attributes?.application_metadata?.name || '';

/**
 * Find protocol positions Zerion decodes from a token the wallet holds (an
 * aToken or vault share next to the deposit, or a liquid staking token like
 * mETH next to "staked ETH"), which would count the same funds twice.
 * Heuristic: same chain, different fungible, values within 2%, and the wallet
 * token's symbol contains the underlying's symbol or its name contains the
 * protocol's name.
 */
export function findDuplicatePositions(positions) {
  const visible = positions.filter(isVisible);
  const wallet = visible.filter((p) => p.attributes?.position_type === 'wallet');
  const protocol = visible.filter((p) => p.attributes?.position_type !== 'wallet' && !isLoan(p));
  const fungible = (p) => p.relationships?.fungible?.data?.id;
  const chain = (p) => p.relationships?.chain?.data?.id;
  const matches = [];
  const used = new Set();

  for (const pp of protocol) {
    const pv = num(pp.attributes.value);
    if (!pv) continue;
    const underlying = (pp.attributes.fungible_info?.symbol || '').toLowerCase();
    const proto = protocolOf(pp).toLowerCase();
    const hit = wallet.find((w) => {
      if (used.has(w) || chain(w) !== chain(pp) || fungible(w) === fungible(pp)) return false;
      const wv = num(w.attributes.value);
      if (!wv || Math.abs(wv - pv) / Math.max(wv, pv) > 0.02) return false;
      const info = w.attributes.fungible_info || {};
      return (underlying && (info.symbol || '').toLowerCase().includes(underlying)) || (proto && (info.name || '').toLowerCase().includes(proto));
    });
    if (hit) {
      used.add(hit);
      matches.push({ wallet: hit, protocol: pp });
    }
  }
  return matches;
}

/** Merge fungibles that share a ticker (e.g. two USDC variants) into one row. */
export function mergeByTicker(groups) {
  const byTicker = new Map();
  for (const g of groups) {
    const t = byTicker.get(g.ticker);
    if (!t) {
      byTicker.set(g.ticker, { ...g, fungibleIds: [g.fungibleId], chains: [...g.chains], protocols: [...g.protocols], byChain: g.byChain.map((c) => ({ ...c })) });
      continue;
    }
    t.quantity = addDecimals(t.quantity, g.quantity);
    t.valueUsd = t.valueUsd === null && g.valueUsd === null ? null : (t.valueUsd ?? 0) + (g.valueUsd ?? 0);
    t.costBasisUsd = t.costBasisUsd === null || g.costBasisUsd === null ? null : t.costBasisUsd + g.costBasisUsd;
    // Different tokens under one ticker can differ in price: use value / quantity.
    if (t.priceUsd !== g.priceUsd) t.priceUsd = t.valueUsd !== null && Number(t.quantity) ? t.valueUsd / Number(t.quantity) : t.priceUsd ?? g.priceUsd;
    t.fungibleIds.push(g.fungibleId);
    for (const c of g.chains) if (!t.chains.includes(c)) t.chains.push(c);
    for (const p of g.protocols) if (!t.protocols.includes(p)) t.protocols.push(p);
    for (const c of g.byChain) addToChain(t.byChain, c);
  }
  return [...byTicker.values()];
}

/** Only the position fields buildHoldings reads, to keep scan results small. */
export function slimPosition(p) {
  const a = p.attributes || {};
  return {
    id: p.id,
    attributes: {
      position_type: a.position_type,
      quantity: a.quantity ? { numeric: a.quantity.numeric, float: a.quantity.float } : undefined,
      value: a.value,
      price: a.price,
      protocol: a.protocol,
      application_metadata: a.application_metadata?.name ? { name: a.application_metadata.name } : undefined,
      fungible_info: { name: a.fungible_info?.name, symbol: a.fungible_info?.symbol },
      flags: a.flags ? { displayable: a.flags.displayable, is_trash: a.flags.is_trash } : undefined,
    },
    relationships: {
      chain: { data: { id: p.relationships?.chain?.data?.id } },
      fungible: { data: { id: p.relationships?.fungible?.data?.id } },
    },
  };
}

/**
 * Holdings, liabilities and option-dependent warnings from a wallet's raw scan
 * data. Changing any of these options needs no new Zerion requests.
 * raw: { positions, pnlById (null if cost basis wasn't fetched), pnlError,
 *        includesSpam (whether the scan fetched spam tokens) }
 * options: { costBasis: bool, minValueUsd: number, includeUnpriced: bool,
 *            includeSpam: bool (default false; only has spam to add if the scan fetched it),
 *            excludeDuplicatePositions: bool (default true; keeps the held token),
 *            remap: { FROM: 'TO' } ticker renames (keys matched case-insensitively),
 *            referencePrices: { TICKER: usd } (uppercase keys) to price remapped
 *              tokens Zerion has no price for, e.g. from tickerPrices() over a whole scan,
 *            misc: { belowUsd: number|null, tickers: [] } or null — see groupMisc,
 *            individual: [tickers] reported as their own account (see
 *              applyIndividual in formats.js); never folded into misc }
 */
export function buildHoldings(raw, options = {}) {
  const { costBasis = false, minValueUsd = 0, includeUnpriced = false, includeSpam = false, excludeDuplicatePositions = true } = options;
  const remap = normalizeRemap(options.remap);
  const referencePrices = { ...tickerPrices([raw]), ...options.referencePrices };
  const warnings = [];
  const keep = (g) => (g.valueUsd === null ? includeUnpriced : Math.abs(g.valueUsd) >= minValueUsd);
  const byValue = (a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1);
  let positions = raw.positions || [];
  if (!includeSpam) positions = positions.filter((p) => !isSpam(p));

  const duplicates = findDuplicatePositions(positions);
  for (const { wallet: w, protocol: p } of duplicates) {
    const usd = (x) => `$${Math.round(num(x.attributes.value))}`;
    const held = w.attributes.fungible_info?.symbol;
    const decoded = `${protocolOf(p) || 'protocol'} ${p.attributes.position_type} position of ${p.attributes.fungible_info?.symbol}`;
    warnings.push(
      `Likely double count on ${p.relationships?.chain?.data?.id}: ${held} in wallet (${usd(w)}) and Zerion's ${decoded} (${usd(p)}) ` +
        'look like the same funds. ' +
        (excludeDuplicatePositions ? `Kept ${held}; left out the ${decoded}.` : 'Both are reported.'),
    );
  }
  if (excludeDuplicatePositions && duplicates.length) {
    const drop = new Set(duplicates.map((d) => d.protocol));
    positions = positions.filter((p) => !drop.has(p));
  }

  // Remap before filtering, so e.g. an unpriced ASV-USD becomes a priced USDC row.
  const prepare = (groups) => groups.map((g) => applyRemap(g, remap, referencePrices)).filter(keep);
  const liabilities = prepare(groupPositions(positions.filter(isLoan)));
  for (const g of liabilities) g.costBasisUsd = null;

  const groups = prepare(groupPositions(positions.filter((p) => !isLoan(p))));
  for (const g of groups) g.costBasisUsd = costBasis && raw.pnlById ? costBasisFromPnl(raw.pnlById[g.fungibleId], g.valueUsd) : null;
  if (costBasis && raw.pnlError) warnings.push(`Cost basis unavailable (${raw.pnlError})`);
  else if (costBasis && raw.pnlById) {
    const missing = groups.filter((g) => g.costBasisUsd === null).map((g) => g.ticker);
    if (missing.length) warnings.push(`No cost basis from Zerion for: ${missing.join(', ')}`);
  }

  const individual = new Set((options.individual || []).map((t) => String(t).trim().toUpperCase()).filter(Boolean));
  const merged = mergeByTicker(groups).sort(byValue).map((h) => (individual.has(h.ticker.toUpperCase()) ? { ...h, individual: true } : h));
  const holdings = groupMisc(merged, options.misc);
  return { holdings, liabilities: mergeByTicker(liabilities).sort(byValue), warnings };
}

// Sane defaults for remapping; editable in the UI. Bridged/wrapped variants
// of the same asset, and Aave's ASV-USD (a USD savings position) as USDC.
export const DEFAULT_REMAP = {
  'ASV-USD': 'USDC',
  'USDC.e': 'USDC',
  USDbC: 'USDC',
  USDT0: 'USDT',
  'USDT.e': 'USDT',
  'WBTC.e': 'WBTC',
  WETH: 'ETH',
};

function normalizeRemap(remap = {}) {
  const out = {};
  for (const [from, to] of Object.entries(remap || {})) {
    const f = String(from).trim().toUpperCase();
    const t = String(to).trim();
    if (f && t) out[f] = t;
  }
  return out;
}

/** Ticker (uppercase) -> USD price, from priced positions across the given raw scans. */
export function tickerPrices(raws) {
  const prices = {};
  for (const raw of raws) {
    for (const p of raw?.positions || []) {
      const a = p.attributes || {};
      const symbol = (a.fungible_info?.symbol || '').toUpperCase();
      const price = num(a.price);
      if (symbol && a.value != null && price && !(symbol in prices)) prices[symbol] = price;
    }
  }
  return prices;
}

/**
 * Rename a group's ticker per remap. If Zerion had no price for it, price it
 * as the target (e.g. ASV-USD at USDC's price) when the scan has one.
 */
function applyRemap(g, remap, referencePrices) {
  const to = remap[g.ticker.toUpperCase()];
  if (!to) return g;
  const out = { ...g, ticker: to, remappedFrom: g.ticker };
  const ref = referencePrices[to.toUpperCase()];
  if (out.valueUsd === null && ref) {
    out.priceUsd = ref;
    out.valueUsd = Number(out.quantity) * ref;
    out.byChain = out.byChain.map((c) => ({ ...c, valueUsd: Number(c.quantity) * ref }));
  }
  return out;
}

export const MISC_TICKER = 'Miscellaneous Tokens';

// Tokens Range can't handle in a normal account; each is reported as its own
// account "<account>:<ticker>", always with price and value. Editable in the UI.
export const DEFAULT_INDIVIDUAL = ['TOBY', 'FTM', 'weETH'];

/**
 * Fold holdings worth less than misc.belowUsd, or whose ticker is in
 * misc.tickers, into one "Miscellaneous Tokens" row whose quantity is their
 * total USD value (price 1). Unpriced tokens are never folded by value; a
 * listed unpriced token is folded at $0. Folded tokens appear nowhere else.
 */
export function groupMisc(holdings, misc) {
  if (!misc) return holdings;
  const listed = new Set((misc.tickers || []).map((t) => String(t).trim().toUpperCase()).filter(Boolean));
  const below = Number(misc.belowUsd);
  const fold = (h) => !h.individual && (listed.has(h.ticker.toUpperCase()) || (misc.belowUsd != null && misc.belowUsd !== '' && h.valueUsd !== null && h.valueUsd < below));
  const folded = holdings.filter(fold);
  if (!folded.length) return holdings;

  const value = folded.reduce((sum, h) => sum + (h.valueUsd ?? 0), 0);
  const byChain = [];
  for (const h of folded) {
    for (const c of h.byChain || []) {
      const v = c.valueUsd ?? 0;
      const x = byChain.find((y) => y.chain === c.chain);
      if (x) x.valueUsd += v;
      else byChain.push({ chain: c.chain, valueUsd: v });
    }
  }
  const asQuantity = (v) => normalizeDecimal((Math.round(v * 100) / 100).toFixed(2));
  const costs = folded.map((h) => h.costBasisUsd);
  const row = {
    fungibleId: 'misc',
    ticker: MISC_TICKER,
    name: MISC_TICKER,
    quantity: asQuantity(value),
    priceUsd: 1,
    valueUsd: value,
    costBasisUsd: costs.every((c) => c !== null && c !== undefined) ? costs.reduce((a, b) => a + b, 0) : null,
    chains: byChain.map((c) => c.chain),
    protocols: [],
    byChain: byChain.map((c) => ({ chain: c.chain, quantity: asQuantity(c.valueUsd), valueUsd: c.valueUsd })),
    miscTokens: folded.map((h) => h.ticker),
  };
  return [...holdings.filter((h) => !fold(h)), row];
}
