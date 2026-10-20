// Fake Zerion API responses for tests.
export const EVM = '0x7f3a1b2c3d4e5f60718293a4b5c6d7e8f9a0c9d2';
export const EVM2 = '0x00000000219ab540356cbb839cbe05303d7705fa';
export const SOL = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

const pos = (fungible, chain, symbol, numeric, value, extra = {}) => ({
  type: 'positions',
  id: `${fungible}-${chain}`,
  attributes: {
    position_type: 'wallet',
    quantity: { numeric, float: Number(numeric) },
    value,
    price: value === null ? null : value / Number(numeric),
    fungible_info: { name: symbol, symbol },
    flags: { displayable: true, is_trash: false },
    ...extra,
  },
  relationships: { chain: { data: { id: chain } }, fungible: { data: { id: fungible } } },
});

export const positionsPage1 = {
  links: { next: 'https://api.zerion.io/v1/next-page' },
  data: [
    pos('eth', 'ethereum', 'ETH', '4.000000000000000001', 10000),
    pos('eth', 'arbitrum', 'ETH', '0.25', 625),
  ],
};
export const positionsPage2 = {
  links: {},
  data: [
    pos('usdc-a', 'ethereum', 'USDC', '100', 100),
    pos('usdc-b', 'polygon', 'USDC', '50.5', 50.5),
    pos('eth', 'ethereum', 'ETH', '1', 2500, { position_type: 'deposit', protocol: 'Aave V3' }),
    pos('usdc-a', 'ethereum', 'USDC', '20', 20, { position_type: 'loan', protocol: 'Aave V3' }),
    pos('wbtc', 'ethereum', 'WBTC', '0.1', 6000, { position_type: 'loan', protocol: 'Aave V3' }),
    // aToken for the Aave ETH deposit above, also reported as a wallet token.
    { ...pos('a-eth-weth', 'ethereum', 'aEthWETH', '1', 2500), attributes: { ...pos('x', 'x', 'aEthWETH', '1', 2500).attributes, fungible_info: { name: 'Aave Ethereum WETH', symbol: 'aEthWETH' } } },
    // Same value as the deposit but unrelated symbol/name: not flagged.
    pos('usdt', 'ethereum', 'USDT', '2500', 2500),
    pos('dust', 'base', 'DUST', '1', 0.01),
    pos('mystery', 'base', 'MYST', '1000', null),
    pos('zero', 'base', 'ZERO', '0', 0),
    // Spam: Zerion only returns it with filter[trash]=no_filter.
    pos('spam', 'ethereum', 'FREE-AIRDROP', '1000000', 5000, { flags: { displayable: true, is_trash: true } }),
  ],
};

export const pnl = {
  data: {
    type: 'pnl',
    attributes: {
      breakdown: {
        by_id: {
          eth: { total_invested: 12000, realized_cost_basis: 2200, unrealized_gain: 825 },
          'usdc-a': { total_invested: 100, realized_cost_basis: 0 },
          'usdc-b': { unrealized_gain: 0.5 },
        },
      },
    },
  },
};

export function fakeFetch({ fail = {}, calls = [] } = {}) {
  return async (url, init) => {
    calls.push({ url: String(url), init });
    const u = new URL(url);
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    for (const [addr, status] of Object.entries(fail)) if (u.pathname.includes(addr)) return json(status, { errors: [{ title: 'boom' }] });
    // Like Zerion, next links keep the query, and spam is filtered server-side.
    const withoutSpam = (page) => (u.searchParams.get('filter[trash]') === 'no_filter' ? page : { ...page, data: page.data.filter((p) => !p.attributes.flags?.is_trash) });
    if (u.pathname === '/v1/next-page') return json(200, withoutSpam(positionsPage2));
    if (u.pathname.endsWith('/positions/')) return json(200, { ...positionsPage1, links: { next: `${positionsPage1.links.next}${u.search}` } });
    if (u.pathname.endsWith('/pnl')) return json(200, pnl);
    return json(404, {});
  };
}
