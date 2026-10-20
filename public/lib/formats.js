// Output formats. Each format turns scan results into a table (for display)
// and a file body (for download). To add a format, append to FORMATS.
//
// Scan result shape (one per wallet, see lib/holdings.js):
//   { address, name, accountName, last4, status,
//     holdings:    [{ ticker, name, quantity, priceUsd, valueUsd, costBasisUsd, chains, protocols,
//                     byChain: [{ chain, quantity, valueUsd }] }],
//     liabilities: [same shape; quantity and valueUsd are amounts owed] }
//
// Formats see results after applyChainMode, so they don't handle chains themselves.

// How tokens held on several chains at one address are reported.
export const CHAIN_MODES = [
  { id: 'combine', label: 'Combine (sum across chains)' },
  { id: 'rows', label: 'Row per chain, same account' },
  { id: 'accounts', label: 'Account per chain' },
];

const CHAIN_NAMES = {
  'binance-smart-chain': 'BNB Chain',
  xdai: 'Gnosis',
  'zksync-era': 'zkSync Era',
  'polygon-zkevm': 'Polygon zkEVM',
};

/** Display name for a Zerion chain id: 'arbitrum' -> 'Arbitrum'. */
export function chainName(id) {
  return CHAIN_NAMES[id] || String(id).split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * Split one ticker row into one row per chain. Cost basis comes from Zerion
 * per token, not per chain, so it is kept only when the token is on one chain.
 */
function splitRow(h) {
  const parts = h.byChain?.length ? [...h.byChain].sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1)) : [{ chain: h.chains?.[0] || 'unknown', quantity: h.quantity, valueUsd: h.valueUsd }];
  if (parts.length === 1) return [{ ...h, chain: parts[0].chain }];
  return parts.map((c) => ({
    ...h,
    chain: c.chain,
    chains: [c.chain],
    quantity: c.quantity,
    valueUsd: c.valueUsd,
    priceUsd: c.valueUsd !== null && Number(c.quantity) ? c.valueUsd / Number(c.quantity) : h.priceUsd,
    costBasisUsd: null,
  }));
}

/** Rows whose cost basis splitRow has to drop (token on several chains). */
export const splitDropsCostBasis = (h) => h.costBasisUsd !== null && h.costBasisUsd !== undefined && (h.byChain?.length ?? 1) > 1;

/**
 * combine: as scanned. rows: each holding split per chain under the same
 * wallet. accounts: each wallet split into one wallet per chain, named
 * "<account> (<Chain>)".
 */
export function applyChainMode(results, mode = 'combine') {
  if (mode === 'combine') return results;
  return results.flatMap((wallet) => {
    if (wallet.status !== 'ok') return [wallet];
    const holdings = (wallet.holdings || []).flatMap(splitRow);
    const liabilities = (wallet.liabilities || []).flatMap(splitRow);
    if (mode === 'rows') return [{ ...wallet, holdings, liabilities }];
    const chains = [...new Set([...holdings, ...liabilities].map((h) => h.chain))];
    return chains.map((chain) => ({
      ...wallet,
      accountName: `${wallet.accountName} (${chainName(chain)})`,
      chain,
      holdings: holdings.filter((h) => h.chain === chain),
      liabilities: liabilities.filter((h) => h.chain === chain),
    }));
  });
}

export function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns, rows) {
  return [columns, ...rows].map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}

function usd(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '';
  return String(Math.round(n * 100) / 100);
}

// Token prices span many magnitudes; keep 8 significant digits, never exponent notation.
const priceFormat = new Intl.NumberFormat('en-US', { useGrouping: false, maximumSignificantDigits: 8 });
function price(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '';
  return priceFormat.format(n);
}

const rangeV01 = {
  id: 'range-v0.1-csv',
  label: 'Range v0.1 CSV',
  extension: 'csv',
  mimeType: 'text/csv',
  columns: ['account_name', 'ticker', 'quantity', 'price_usd', 'value_usd', 'cost_basis_usd', 'last4', 'wallet_address'],
  rows(results) {
    const rows = [];
    for (const wallet of results) {
      if (wallet.status !== 'ok') continue;
      for (const h of wallet.holdings) {
        rows.push([wallet.accountName, h.ticker, h.quantity, price(h.priceUsd), usd(h.valueUsd), usd(h.costBasisUsd), wallet.last4, wallet.address]);
      }
    }
    return rows;
  },
  serialize(columns, rows) {
    return toCsv(columns, rows);
  },
};

// Draft: Range's liability schema isn't defined yet; columns mirror the
// holdings file plus the USD balance owed and the lending protocol(s).
const rangeV01Liabilities = {
  id: 'range-v0.1-liabilities-csv',
  label: 'Range v0.1 Liabilities CSV (draft)',
  extension: 'csv',
  mimeType: 'text/csv',
  columns: ['account_name', 'ticker', 'quantity', 'price_usd', 'balance_usd', 'protocol', 'last4', 'wallet_address'],
  rows(results) {
    const rows = [];
    for (const wallet of results) {
      if (wallet.status !== 'ok') continue;
      for (const l of wallet.liabilities || []) {
        rows.push([wallet.accountName, l.ticker, l.quantity, price(l.priceUsd), usd(l.valueUsd), (l.protocols || []).join('; '), wallet.last4, wallet.address]);
      }
    }
    return rows;
  },
  serialize(columns, rows) {
    return toCsv(columns, rows);
  },
};

export const FORMATS = [rangeV01, rangeV01Liabilities];

export function getFormat(id) {
  const format = FORMATS.find((f) => f.id === id);
  if (!format) throw new Error(`Unknown format: ${id}`);
  return format;
}

/**
 * Move holdings marked individual (see buildHoldings) out of each wallet into
 * a wallet of their own named "<account>:<ticker>", flagged individual.
 */
export function applyIndividual(results) {
  return results.flatMap((wallet) => {
    const own = wallet.status === 'ok' ? (wallet.holdings || []).filter((h) => h.individual) : [];
    if (!own.length) return [wallet];
    const rest = { ...wallet, holdings: wallet.holdings.filter((h) => !h.individual) };
    const split = own.map((h) => ({ ...wallet, accountName: `${wallet.accountName}:${h.ticker}`, individual: true, holdings: [h], liabilities: [] }));
    return [rest, ...split];
  });
}

// Columns the user can leave out of any format that has them.
export const OPTIONAL_COLUMNS = { price: 'price_usd', value: 'value_usd' };

/**
 * options: { chainMode, price: bool, value: bool } — price/value false drop
 * those columns (both default to included). Individual-token accounts always
 * report price and value: if any are present, a hidden column stays, filled
 * only for their rows.
 */
export function render(formatId, results, { chainMode = 'combine', price = true, value = true } = {}) {
  const format = getFormat(formatId);
  const wallets = applyIndividual(applyChainMode(results, chainMode));
  const tagged = wallets.flatMap((w) => format.rows([w]).map((row) => ({ row, individual: Boolean(w.individual) })));
  const anyIndividual = tagged.some((t) => t.individual);
  const optional = [!price && OPTIONAL_COLUMNS.price, !value && OPTIONAL_COLUMNS.value].filter(Boolean);
  const hidden = new Set(anyIndividual ? [] : optional);
  const blank = new Set(anyIndividual ? optional : []);
  const keep = format.columns.map((c) => !hidden.has(c));
  const columns = format.columns.filter((_, i) => keep[i]);
  const rows = tagged.map(({ row, individual }) =>
    row.map((v, i) => (!individual && blank.has(format.columns[i]) ? '' : v)).filter((_, i) => keep[i]),
  );
  return { format, columns, rows, text: format.serialize(columns, rows) };
}
