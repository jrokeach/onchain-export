// Wallet list parsing and address helpers. Shared by the browser and the server.

const EVM_RE = /\b0x[0-9a-fA-F]{40}\b/;
// Solana / other base58 addresses (no 0, O, I, l).
const BASE58_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;

export function findAddress(text) {
  const evm = text.match(EVM_RE);
  if (evm) return { address: evm[0], index: evm.index };
  const b58 = text.match(BASE58_RE);
  if (b58) return { address: b58[0], index: b58.index };
  return null;
}

export function isEvmAddress(address) {
  return /^0x[0-9a-fA-F]{40}$/.test(address);
}

// Strip the "0x" prefix on EVM addresses; everything else is already significant.
function significant(address) {
  return isEvmAddress(address) ? address.slice(2) : address;
}

// "0x7f3a1b...c9d2" -> "7f3a...c9d2"
export function shortAddress(address) {
  const s = significant(address);
  if (s.length <= 8) return s;
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}

export function last4(address) {
  return significant(address).slice(-4);
}

export function addressKey(address) {
  return isEvmAddress(address) ? address.toLowerCase() : address;
}

/**
 * Parse free-form wallet input. One wallet per line; the address can appear
 * anywhere on the line and whatever remains (minus separators) is the name:
 *
 *   0xabc...
 *   Ledger Main, 0xabc...
 *   0xabc...,Ledger Main
 *   Ledger Main<TAB>0xabc...
 *
 * Blank lines and lines starting with "#" are skipped. Lines without an
 * address (e.g. a CSV header) are reported in `skipped`. Duplicate addresses
 * keep the first occurrence, but a later name fills in a missing one.
 */
export function parseWalletInput(text) {
  const wallets = [];
  const skipped = [];
  const seen = new Map();

  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;

    const found = findAddress(line);
    if (!found) {
      skipped.push({ line: i + 1, text: line });
      return;
    }

    const rest = line.slice(0, found.index) + ' ' + line.slice(found.index + found.address.length);
    const name = rest
      .split(/[,;\t|]/)
      .map((part) => part.trim().replace(/^["']|["']$/g, '').trim())
      .filter(Boolean)
      .join(' ');

    const key = addressKey(found.address);
    if (seen.has(key)) {
      const existing = seen.get(key);
      if (!existing.name && name) existing.name = name;
      return;
    }
    const wallet = { address: found.address, name };
    seen.set(key, wallet);
    wallets.push(wallet);
  });

  return { wallets, skipped };
}

export function displayName(wallet) {
  return wallet.name || shortAddress(wallet.address);
}
