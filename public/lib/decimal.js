// Exact decimal-string arithmetic for token quantities, so summing balances
// across chains never introduces float rounding.

function split(value) {
  let s = String(value).trim();
  if (/e/i.test(s)) s = Number(s).toFixed(18);
  const negative = s.startsWith('-');
  if (negative || s.startsWith('+')) s = s.slice(1);
  const [int = '0', frac = ''] = s.split('.');
  if (!/^\d*$/.test(int) || !/^\d*$/.test(frac)) throw new Error(`Not a decimal: ${value}`);
  return { negative, int: int || '0', frac };
}

export function addDecimals(a, b) {
  const x = split(a);
  const y = split(b);
  const scale = Math.max(x.frac.length, y.frac.length);
  const toBig = (p) => BigInt(p.int + p.frac.padEnd(scale, '0')) * (p.negative ? -1n : 1n);
  return fromBig(toBig(x) + toBig(y), scale);
}

function fromBig(n, scale) {
  const negative = n < 0n;
  let digits = (negative ? -n : n).toString().padStart(scale + 1, '0');
  const int = digits.slice(0, digits.length - scale);
  const frac = scale ? digits.slice(digits.length - scale).replace(/0+$/, '') : '';
  const out = frac ? `${int}.${frac}` : int;
  return negative && out !== '0' ? `-${out}` : out;
}

export function normalizeDecimal(value) {
  return addDecimals(value, '0');
}
