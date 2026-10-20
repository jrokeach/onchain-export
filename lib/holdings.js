// Scans one wallet through the Zerion client. Holdings are built by
// public/lib/holdings.js, which the browser also uses to rebuild results
// from the raw data returned here when display options change.

import { buildHoldings, groupPositions, isLoan, isVisible, slimPosition } from '../public/lib/holdings.js';
import { displayName, isEvmAddress, last4 } from '../public/lib/wallets.js';

export * from '../public/lib/holdings.js';

const PNL_BATCH = 100;

/**
 * Fetch and normalize one wallet.
 * options: { costBasis: bool (opt-in, see README), includeSpam: bool — the two
 *            that change what is fetched — plus the buildHoldings display options }
 * The result carries raw: { positions, pnlById, pnlError } so holdings can be
 * rebuilt with other display options, and scanWarnings, the warnings that
 * don't depend on them.
 */
export async function scanWallet(client, wallet, options = {}) {
  const result = {
    address: wallet.address,
    name: wallet.name || '',
    accountName: displayName(wallet),
    last4: last4(wallet.address),
    status: 'ok',
    scanWarnings: [],
    warnings: [],
    holdings: [],
    liabilities: [],
    raw: { positions: [], pnlById: null, pnlError: null, includesSpam: Boolean(options.includeSpam) },
  };

  try {
    let positions;
    // Once one wallet is blocked from DeFi positions, skip straight to balances
    // for the rest of the scan rather than spending two requests on each.
    if (isEvmAddress(wallet.address) && !client.advancedBlocked) {
      try {
        positions = await client.positions(wallet.address, { includeSpam: result.raw.includesSpam });
      } catch (err) {
        if (!err.blocked) throw err;
        client.advancedBlocked = true;
      }
    }
    if (!positions && isEvmAddress(wallet.address)) {
      positions = await client.positions(wallet.address, { simple: true, includeSpam: result.raw.includesSpam });
      result.scanWarnings.push(
        "DeFi protocol positions (deposits, staking, LP, loans) are missing: Zerion throttled them although the API key has requests left. Its sublimit for advanced requests is probably used up. Only wallet balances are included.",
      );
    }
    positions ??= await client.positions(wallet.address, { includeSpam: result.raw.includesSpam });
    if (!isEvmAddress(wallet.address)) {
      result.scanWarnings.push('Zerion does not report DeFi protocol positions for Solana wallets; only wallet balances (and SOL locked as rent) are included.');
    }

    positions = positions.filter(isVisible).map(slimPosition);
    result.raw.positions = positions;

    // Cost basis for every held token, so the min-value filter and duplicate
    // handling can change later without new requests.
    if (options.costBasis) {
      const ids = groupPositions(positions.filter((p) => !isLoan(p))).map((g) => g.fungibleId);
      result.raw.pnlById = {};
      try {
        for (let i = 0; i < ids.length; i += PNL_BATCH) {
          const batch = ids.slice(i, i + PNL_BATCH);
          const pnl = await client.pnl(wallet.address, batch);
          const byId = pnl?.attributes?.breakdown?.by_id || {};
          for (const id of batch) if (byId[id]) result.raw.pnlById[id] = byId[id];
        }
      } catch (err) {
        result.raw.pnlError = err.message;
      }
    }

    const built = buildHoldings(result.raw, options);
    result.holdings = built.holdings;
    result.liabilities = built.liabilities;
    result.warnings = [...result.scanWarnings, ...built.warnings];
  } catch (err) {
    result.status = 'error';
    result.error = err.message;
  }
  return result;
}
