# Zerion Wallet Exporter

Web app that scans a list of wallets through the [Zerion API](https://zerion.io/api) and exports
their current holdings. No dependencies; needs Node.js 22+.

```sh
ZERION_API_KEY=zk_... npm start     # http://127.0.0.1:3000
```

If `ZERION_API_KEY` is not set, the UI asks for a key and sends it to this server for the scan
(it is not stored). Other env vars: `PORT` (3000), `HOST` (127.0.0.1), `SCAN_CONCURRENCY` (2),
`ZERION_RATE_LIMIT` (1).

`ZERION_RATE_LIMIT` is the most Zerion requests per second the server starts, shared by all
wallets and all concurrent scans (retries included). Set it to your API key's limit; `0` turns
it off. If Zerion reports a lower per-second limit for the key (`RateLimit-Org-Second-Limit`), the
server slows down to that. A 429 is retried after Zerion's per-second reset (or with backoff),
except when the key's daily or monthly quota is used up: those wallets fail at once with the
reset time. Each 429 is logged to the server console with Zerion's remaining-request counters.

DeFi positions (`filter[positions]=no_filter`) and PnL count toward Zerion's separate
[advanced-request sublimit](https://developers.zerion.io/rate-limits.md) (25% of the plan's quota),
which returns 429 even while the key has requests left; Zerion also throttles one address
requested too often. When a 429 comes back with budget left, the scan retries once, then falls
back to wallet balances only (`only_simple`) for that wallet and the rest of the scan, with a
warning that DeFi positions are missing.

## Docker

Only Docker is needed; the image is `node:22-alpine` plus this app (no npm packages). It is
published to `ghcr.io/jrokeach/onchain-export` for `linux/amd64` and `linux/arm64`: `:latest`
tracks `main`, and each release tag `vX.Y.Z` is published as `:X.Y.Z` for pinning.

```sh
echo 'ZERION_API_KEY=zk_...' > .env     # optional; without it the UI asks for a key
docker compose up -d                    # http://127.0.0.1:3000
docker compose pull && docker compose up -d   # update to the newest :latest
docker compose up -d --build            # build from this checkout instead
docker compose down
```

To pin a version, change `:latest` in `compose.yaml` to a release, e.g. `:1.2.3`. Releases are
cut by pushing a tag: `git tag v1.2.3 && git push origin v1.2.3`.

`compose.yaml` passes `ZERION_API_KEY`, `ZERION_RATE_LIMIT`, `SCAN_CONCURRENCY` and `PORT` (the
host port) from your shell or `.env`. It publishes the port on `127.0.0.1` only, because anyone
who can reach it can run scans with the server's key.

Without Compose:

```sh
docker run --rm --init -p 127.0.0.1:3000:3000 -e ZERION_API_KEY=zk_... ghcr.io/jrokeach/onchain-export:latest
```

## Input

Paste wallets or load a `.txt`/`.csv` file. One wallet per line; an optional name can come
before or after the address, separated by comma, tab, `;` or `|`:

```
Ledger Main, 0x7f3a...
0x9b1c...,Cold Storage
7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU
```

EVM (`0x…`) and base58 (Solana) addresses are detected. Lines without an address (e.g. a CSV
header) and lines starting with `#` are skipped. Duplicate addresses are scanned once.

Wallets without a name are reported as the first 4 and last 4 significant characters of the
address (the `0x` prefix is not significant): `0x7f3a…c9d2` → `7f3a...c9d2`.

## Output formats

Results can be viewed as a table or raw text, copied, or downloaded. Click a column header to
sort by it (click again to reverse); the raw view, copy and download use the same order.

The output format, price and value columns, chain handling, min value, unpriced tokens, spam and
duplicate-position options apply to the last scan immediately, without new Zerion requests: the
scan keeps each wallet's raw positions and the browser rebuilds the holdings. Cost basis and spam
are the exceptions: they are only fetched when asked for at scan time, so ticking cost basis or
unticking **Drop spam tokens** after a scan that didn't fetch them needs a rescan (the reverse
doesn't). Prices and values are always fetched; the price and value options only show or hide
the columns.

Warnings and errors are collapsed under a count ("2 errors, 11 warnings"); each distinct message
is listed once with the accounts it applies to. The section opens by itself only when there are
errors.

### Post-scan adjustments

Applied to the last scan instantly and saved in the browser:

- **Remap tickers:** report a token under another ticker, e.g. `ASV-USD` as `USDC`. Matching is
  case-insensitive; rows that end up with the same ticker are merged. A token Zerion has no price
  for takes the new ticker's price from the same scan, so it gets a value (and isn't dropped as
  unpriced). Remapping applies to loans too. Defaults, editable or resettable in the UI:
  `ASV-USD`, `USDC.e`, `USDbC` → `USDC`; `USDT0`, `USDT.e` → `USDT`; `WBTC.e` → `WBTC`;
  `WETH` → `ETH`.
- **Report as individual wallet:** tokens Range can't handle in a normal account (defaults:
  `TOBY`, `FTM`, `weETH`; matched case-insensitively) are each reported as their own account,
  `<account>:<ticker>` (e.g. `Ledger Main:weETH`). These rows always carry `price_usd` and
  `value_usd`: if those columns are hidden, they stay in the output while such rows exist, filled
  only for them. Never folded into Miscellaneous Tokens; applied after remapping and the min-value
  filter, to holdings only.
- **Miscellaneous Tokens:** fold tokens worth less than a set amount (default $50), plus any
  listed tickers, into one `Miscellaneous Tokens` row per account. Its quantity is the folded
  tokens' total USD value and its price is 1, so Range can carry tokens Zerion prices but Range
  can't. Folded tokens appear nowhere else. Unpriced tokens are only folded if listed (at $0).
  Cost basis is the sum of theirs, or blank if any is unknown. Runs after the min-value filter
  and remapping.

### Range v0.1 CSV

```
account_name,ticker,quantity,price_usd,value_usd,cost_basis_usd,last4,wallet_address
Ledger Main,ETH,4.25,2500,10625,9800,c9d2,0x7f3a...c9d2
```

- One row per ticker per wallet. Balances of the same token on multiple chains (unless split by
  the chain option below), and different tokens sharing a ticker, are summed. Quantities are
  exact decimals (no float rounding).
- `cost_basis_usd` is blank unless **Include cost basis** is ticked. When ticked, it is the FIFO
  cost basis of the tokens still held, from Zerion's PnL endpoint: `total_invested -
  realized_cost_basis` for that token (falling back to `value - unrealized_gain`).
  **It will be wrong** unless funds landed on-chain in USD terms (e.g. as USDC) and were swapped
  into each token inside the scanned wallet: Zerion prices every incoming transfer (from your
  other wallets, an exchange, a bridge, a wrapper or a DeFi protocol) at the market rate on
  arrival.
- **Same token on several chains** (option; switching it re-renders without rescanning):
  - **Combine** (default): one row per ticker per wallet, summed across chains.
  - **Row per chain, same account**: a row per ticker per chain under the wallet's name.
    Rows look repeated in Range, since the CSV has no chain column.
  - **Account per chain**: each wallet becomes one account per chain it has funds on,
    named `<account> (<Chain>)`, e.g. `Ledger Main (Arbitrum)`.

  Zerion's cost basis is per token, not per chain, so in the per-chain modes it is left blank for a token
  held on more than one chain (the UI lists which).
- `price_usd` is Zerion's current price, to 8 significant digits. A row that merges different
  tokens sharing a ticker uses their value-weighted price. Blank for unpriced tokens.
- `value_usd` is the row's USD value (quantity × price, as Zerion reports it), rounded to cents.
- `price_usd` and `value_usd` can each be left out with **Include price** / **Include value**
  (both on by default). The liabilities file drops `price_usd` the same way; its `balance_usd`
  is always included.
- `last4` is the last 4 characters of the address.
- Wallet balances and DeFi protocol positions (deposits, staking, LP, rewards, …) are both
  included, valued with Zerion's prices, and listed under the underlying token's ticker. Loans
  are not netted here; they go to the liabilities file below.
- **Double counts:** some tokens in a wallet are claims on a protocol position that Zerion also
  decodes and reports: an aToken or vault share next to the deposit, or a liquid staking token
  like mETH next to a "staked ETH" position. When the two look like the same funds, the scan
  keeps the token the wallet actually holds (mETH, not ETH) and leaves out Zerion's protocol
  position, with a "Likely double count" warning naming both. Match rule: same chain, different
  token, USD values within 2%, and the wallet token's symbol contains the underlying's symbol or
  its name contains the protocol's name. Untick **Skip protocol positions that duplicate a held
  token** to keep both rows.
- **Solana:** Zerion rejects `filter[positions]=no_filter` for Solana addresses, so Solana wallets
  are scanned with `only_simple`: wallet balances plus SOL locked as account rent (listed under
  SOL, as Zerion's portfolio total does). DeFi positions on Solana are not reported, and the
  scan says so in a warning.
- **Drop spam tokens** (on by default) leaves out tokens Zerion flags as spam; the scan asks
  Zerion not to return them at all. Scanning with it unticked fetches spam too (spam-heavy
  wallets can cost extra pages of requests); after such a scan it can be toggled either way
  without rescanning. Tokens Zerion marks as not displayable are always left out.
- **Min. holding value** (default $1) drops dust, compared on absolute value; unpriced tokens
  are excluded unless enabled.

### Range v0.1 Liabilities CSV (draft)

```
account_name,ticker,quantity,price_usd,balance_usd,protocol,last4,wallet_address
Ledger Main,USDC,20,1,20,Aave V3,c9d2,0x7f3a...c9d2
```

Borrowed tokens (Zerion `loan` positions), one row per ticker per wallet, as positive amounts
owed. The columns are provisional until Range's liability schema is defined.

### Adding a format

Append an entry to `FORMATS` in `public/lib/formats.js` with `id`, `label`, `extension`,
`mimeType`, `columns`, `rows(results)` and `serialize(columns, rows)`. It appears in the
format picker automatically and works for display, copy and download.

## Layout

- `server.js` – static file server + `POST /api/scan` (streams one NDJSON line per wallet)
- `lib/zerion.js` – Zerion client: Basic auth, pagination, retry on 429/503
- `lib/holdings.js` – positions + PnL → per-wallet holdings
- `public/` – UI; `public/lib/` modules are shared with the server

## Tests

```sh
npm test
```

Tests run against a mocked Zerion API. `test/fixtures/zerion-live.json` holds trimmed real
responses from public wallets (hayden.eth, toly, vitalik.eth; captured 2026-10-20) that
`test/live.test.js` scans, so the field names the code
relies on are checked against what Zerion actually returns.

CI (`.github/workflows/`):

- **Tests** runs `npm test` on Node 22 and 24 for every pull request and push to `main`.
- **Zerion live check** runs `scripts/live-check.mjs` weekly (and on demand) against the live
  API, checking that the fields the app reads are still there. It needs a `ZERION_API_KEY`
  repository secret and skips with a warning without one. Run it locally with
  `ZERION_API_KEY=zk_... node scripts/live-check.mjs`.
