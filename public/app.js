import { parseWalletInput, displayName } from './lib/wallets.js';
import { CHAIN_MODES, FORMATS, render, splitDropsCostBasis } from './lib/formats.js';
import { buildHoldings, DEFAULT_INDIVIDUAL, DEFAULT_REMAP, tickerPrices } from './lib/holdings.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

let parsed = { wallets: [], skipped: [] };
let results = [];
let controller = null;

// --- setup -----------------------------------------------------------------

for (const f of FORMATS) $('format').append(el('option', { value: f.id, textContent: f.label }));
for (const m of CHAIN_MODES) $('chain-mode').append(el('option', { value: m.id, textContent: m.label }));

fetch('api/config')
  .then((r) => r.json())
  .then(({ hasServerKey }) => {
    $('api-key-hint').textContent = hasServerKey
      ? 'Optional: the server has a key configured.'
      : 'Required: the server has no ZERION_API_KEY set.';
  })
  .catch(() => {});

// --- input -----------------------------------------------------------------

function updatePreview() {
  parsed = parseWalletInput($('input').value);
  const { wallets, skipped } = parsed;
  $('parse-status').textContent = wallets.length
    ? `${wallets.length} wallet${wallets.length === 1 ? '' : 's'} detected` + (skipped.length ? `, ${skipped.length} line(s) without an address skipped` : '')
    : skipped.length ? `No addresses found (${skipped.length} line(s) skipped)` : '';
  $('preview').replaceChildren();
  if (!wallets.length) return;
  const table = el('table');
  for (const w of wallets) {
    table.append(el('tr', {}, el('td', { textContent: displayName(w) }, w.name ? '' : el('span', { className: 'muted', textContent: ' (auto)' })), el('td', { textContent: w.address, className: 'muted' })));
  }
  $('preview').append(table);
}

$('input').addEventListener('input', updatePreview);
$('file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  const current = $('input').value.trim();
  $('input').value = current ? `${current}\n${text}` : text;
  e.target.value = '';
  updatePreview();
});

// --- scan ------------------------------------------------------------------

async function scan() {
  if (!parsed.wallets.length) {
    $('scan-status').textContent = 'Add at least one wallet address.';
    return;
  }
  controller = new AbortController();
  results = [];
  setBusy(true);
  const total = parsed.wallets.length;
  let done = 0;
  $('progress').max = total;
  $('progress').value = 0;
  $('scan-status').textContent = `Scanning 0 / ${total}…`;

  try {
    const res = await fetch('api/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        wallets: parsed.wallets,
        apiKey: $('api-key').value.trim() || undefined,
        options: displayOptions(),
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Server error ${res.status}`);
    }

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      buffer += value;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.type === 'wallet') {
          results[msg.index] = msg.result;
          done++;
          $('progress').value = done;
          $('scan-status').textContent = `Scanning ${done} / ${total}…`;
          showResults();
        }
      }
    }
    const failed = results.filter((r) => r && r.status !== 'ok').length;
    $('scan-status').textContent = `Done: ${done} wallet${done === 1 ? '' : 's'} scanned` + (failed ? `, ${failed} failed` : '') + '.';
  } catch (err) {
    $('scan-status').textContent = err.name === 'AbortError' ? `Cancelled after ${done} / ${total}.` : `Error: ${err.message}`;
  } finally {
    setBusy(false);
    controller = null;
  }
}

function setBusy(busy) {
  $('scan').disabled = busy;
  $('cancel').hidden = !busy;
  $('progress').hidden = !busy;
}

$('scan').addEventListener('click', scan);
const syncCostBasisWarning = () => ($('cost-basis-warning').hidden = !$('cost-basis').checked);
$('cost-basis').addEventListener('change', syncCostBasisWarning);
// Rebuilt from the scan's raw data: no rescan needed (cost basis only needs
// one if the scan didn't fetch it).
$('min-value').addEventListener('input', showResults);
for (const id of ['cost-basis', 'include-unpriced', 'drop-spam', 'exclude-duplicates', 'show-price', 'show-value']) $(id).addEventListener('change', showResults);
syncCostBasisWarning();
$('cancel').addEventListener('click', () => controller?.abort());

// --- output ----------------------------------------------------------------

const NUMERIC = new Set(['quantity', 'price_usd', 'value_usd', 'cost_basis_usd', 'balance_usd']);
// Clicked column and direction; applies to the table, raw view, copy and download.
let sort = null;

function sortRows(columns, rows) {
  const i = sort ? columns.indexOf(sort.column) : -1;
  if (i < 0) return rows;
  const numeric = NUMERIC.has(sort.column);
  const blank = (v) => v === null || v === undefined || v === '';
  return [...rows].sort((a, b) => {
    // Blanks go last in either direction.
    if (blank(a[i]) || blank(b[i])) return blank(a[i]) - blank(b[i]);
    const cmp = numeric ? Number(a[i]) - Number(b[i]) : String(a[i]).localeCompare(String(b[i]), undefined, { numeric: true, sensitivity: 'base' });
    return sort.dir * cmp;
  });
}

function displayOptions() {
  return {
    costBasis: $('cost-basis').checked,
    minValueUsd: Number($('min-value').value) || 0,
    includeUnpriced: $('include-unpriced').checked,
    includeSpam: !$('drop-spam').checked,
    excludeDuplicatePositions: $('exclude-duplicates').checked,
    remap: remapFromTable(),
    individual: splitTickers($('individual').value),
    misc: $('misc-on').checked ? { belowUsd: $('misc-below').value === '' ? null : Number($('misc-below').value), tickers: splitTickers($('misc-tickers').value) } : null,
  };
}

// --- post-scan adjustments (remap, misc) -------------------------------------

const POST_KEY = 'zerion-exporter:post-scan';
const splitTickers = (s) => s.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean);

function remapFromTable() {
  const map = {};
  for (const tr of $('remap-rows').children) {
    const [from, to] = tr.querySelectorAll('input');
    if (from.value.trim() && to.value.trim()) map[from.value.trim()] = to.value.trim();
  }
  return map;
}

function remapRow(from = '', to = '') {
  const input = (value, placeholder) => el('input', { type: 'text', value, placeholder, spellcheck: false, oninput: changed });
  const remove = el('button', { type: 'button', className: 'icon', title: 'Remove', textContent: '×', onclick: () => (tr.remove(), changed()) });
  const tr = el('tr', {}, el('td', {}, input(from, 'ASV-USD')), el('td', { className: 'muted', textContent: '→' }), el('td', {}, input(to, 'USDC')), el('td', {}, remove));
  return tr;
}

function setRemapTable(map) {
  $('remap-rows').replaceChildren(...Object.entries(map).map(([from, to]) => remapRow(from, to)));
}

// Browser storage is a convenience: it may be unavailable, so defaults apply.
function savePostScan() {
  try {
    localStorage.setItem(POST_KEY, JSON.stringify({ remap: remapFromTable(), individual: $('individual').value, misc: { on: $('misc-on').checked, below: $('misc-below').value, tickers: $('misc-tickers').value } }));
  } catch {}
}

function loadPostScan() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(POST_KEY));
  } catch {}
  setRemapTable(saved?.remap ?? DEFAULT_REMAP);
  $('individual').value = saved?.individual ?? DEFAULT_INDIVIDUAL.join(', ');
  if (saved?.misc) {
    $('misc-on').checked = Boolean(saved.misc.on);
    $('misc-below').value = saved.misc.below ?? '50';
    $('misc-tickers').value = saved.misc.tickers ?? '';
  }
}

function changed() {
  savePostScan();
  showResults();
}

$('remap-add').addEventListener('click', () => {
  const tr = remapRow();
  $('remap-rows').append(tr);
  tr.querySelector('input').focus();
});
$('remap-reset').addEventListener('click', () => {
  setRemapTable(DEFAULT_REMAP);
  changed();
});
$('individual').addEventListener('input', changed);
$('individual-reset').addEventListener('click', () => {
  $('individual').value = DEFAULT_INDIVIDUAL.join(', ');
  changed();
});
$('misc-on').addEventListener('change', changed);
$('misc-below').addEventListener('input', changed);
$('misc-tickers').addEventListener('input', changed);
loadPostScan();

/** Scan results rebuilt with the current options. */
function currentResults() {
  const options = displayOptions();
  // Prices from every wallet in the scan, for remapped tokens Zerion didn't price.
  options.referencePrices = tickerPrices(results.filter((r) => r?.raw).map((r) => r.raw));
  return results.filter(Boolean).map((r) => {
    if (r.status !== 'ok' || !r.raw) return r;
    const built = buildHoldings(r.raw, options);
    return { ...r, holdings: built.holdings, liabilities: built.liabilities, warnings: [...(r.scanWarnings || []), ...built.warnings] };
  });
}

function currentOutput(done = currentResults()) {
  const { format, columns, rows } = render($('format').value, done, { chainMode: $('chain-mode').value, price: $('show-price').checked, value: $('show-value').checked });
  const sorted = sortRows(columns, rows);
  return { format, columns, rows: sorted, text: format.serialize(columns, sorted) };
}

function sortBy(column) {
  sort = sort?.column === column ? { column, dir: -sort.dir } : { column, dir: NUMERIC.has(column) ? -1 : 1 };
  showResults();
}

function showResults() {
  const done = currentResults();
  $('results').hidden = done.length === 0;
  if (!done.length) return;

  const issues = [];
  for (const r of done) {
    if (r.status !== 'ok') issues.push({ kind: 'err', message: r.error, account: r.accountName });
    for (const w of r.warnings || []) issues.push({ kind: 'warn', message: w, account: r.accountName });
  }
  if ($('cost-basis').checked && done.some((r) => r.status === 'ok' && r.raw && !r.raw.pnlById)) {
    issues.push({ kind: 'warn', message: 'Cost basis was not fetched in this scan. Scan again to include it.' });
  }
  if (!$('drop-spam').checked && done.some((r) => r.status === 'ok' && r.raw && !r.raw.includesSpam)) {
    issues.push({ kind: 'warn', message: 'Spam tokens were not fetched in this scan. Scan again to include them.' });
  }
  if ($('chain-mode').value !== 'combine') {
    const dropped = done.flatMap((r) => (r.holdings || []).filter(splitDropsCostBasis).map((h) => `${h.ticker} (${r.accountName})`));
    if (dropped.length) issues.push({ kind: 'warn', message: `Cost basis is per token, not per chain, so it is left blank for tokens on several chains: ${dropped.join(', ')}` });
  }
  showIssues(issues);

  const { columns, rows, text } = currentOutput(done);
  const table = el('table');
  const header = (c) => {
    const dir = sort?.column === c ? sort.dir : 0;
    const button = el('button', { type: 'button', className: 'sort', onclick: () => sortBy(c) }, c, el('span', { className: 'arrow', textContent: dir > 0 ? ' ▲' : dir < 0 ? ' ▼' : '' }));
    return el('th', { className: NUMERIC.has(c) ? 'num' : '', ariaSort: dir > 0 ? 'ascending' : dir < 0 ? 'descending' : 'none' }, button);
  };
  table.append(el('thead', {}, el('tr', {}, ...columns.map(header))));
  const tbody = el('tbody');
  for (const row of rows) {
    tbody.append(el('tr', {}, ...row.map((v, i) => el('td', { textContent: v ?? '', className: NUMERIC.has(columns[i]) ? 'num' : '' }))));
  }
  if (!rows.length) tbody.append(el('tr', {}, el('td', { colSpan: columns.length, className: 'muted', textContent: 'No rows.' })));
  table.append(tbody);
  $('table-view').replaceChildren(table);
  $('raw-view').textContent = text;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Errors and warnings in one collapsible section: a count summary, then each
 * distinct message once with the accounts it applies to. Opens by itself
 * only when there are errors.
 */
function showIssues(issues) {
  const box = $('issues');
  if (!issues.length) return box.replaceChildren();
  const groups = new Map();
  for (const i of issues) {
    const key = `${i.kind}\n${i.message}`;
    if (!groups.has(key)) groups.set(key, { ...i, accounts: [] });
    if (i.account) groups.get(key).accounts.push(i.account);
  }
  const errors = issues.filter((i) => i.kind === 'err').length;
  const warnings = issues.length - errors;
  const wasOpen = box.querySelector('details')?.open;
  const details = el('details', { open: wasOpen ?? errors > 0 });
  details.append(el('summary', { className: errors ? 'err' : 'warn', textContent: [errors && plural(errors, 'error'), warnings && plural(warnings, 'warning')].filter(Boolean).join(', ') }));
  const sorted = [...groups.values()].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'err' ? -1 : 1));
  for (const g of sorted) {
    const who = g.accounts.length ? (g.accounts.length > 1 ? `${g.accounts.length} accounts: ` : '') + g.accounts.join(', ') : '';
    details.append(el('div', { className: `issue ${g.kind}` }, g.message, who ? el('div', { className: 'accounts muted', textContent: who }) : ''));
  }
  box.replaceChildren(details);
}

function setView() {
  const raw = document.querySelector('input[name=view]:checked').value === 'raw';
  $('raw-view').hidden = !raw;
  $('table-view').hidden = raw;
}

document.querySelectorAll('input[name=view]').forEach((r) => r.addEventListener('change', setView));
$('format').addEventListener('change', showResults);
$('chain-mode').addEventListener('change', showResults);

$('copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(currentOutput().text);
  $('copy').textContent = 'Copied';
  setTimeout(() => ($('copy').textContent = 'Copy'), 1200);
});

$('download').addEventListener('click', () => {
  const { format, text } = currentOutput();
  const date = new Date().toISOString().slice(0, 10);
  const url = URL.createObjectURL(new Blob([text], { type: format.mimeType }));
  el('a', { href: url, download: `zerion-${format.id}-${date}.${format.extension}` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

updatePreview();
