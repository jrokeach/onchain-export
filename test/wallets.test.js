import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWalletInput, shortAddress, last4, displayName } from '../public/lib/wallets.js';
import { addDecimals } from '../public/lib/decimal.js';
import { EVM, EVM2, SOL } from './fixtures.js';

test('parses names in any position and common separators', () => {
  const { wallets, skipped } = parseWalletInput(
    [
      'account_name,wallet_address',
      '# comment',
      '',
      `Ledger Main, ${EVM}`,
      `${EVM2},"Cold, Storage"`,
      `Phantom\t${SOL}`,
      EVM.toUpperCase().replace('0X', '0x'),
    ].join('\n'),
  );
  assert.deepEqual(wallets, [
    { address: EVM, name: 'Ledger Main' },
    { address: EVM2, name: 'Cold Storage' },
    { address: SOL, name: 'Phantom' },
  ]);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].line, 1);
});

test('duplicate address fills in a missing name', () => {
  const { wallets } = parseWalletInput(`${EVM}\nMain ${EVM}`);
  assert.deepEqual(wallets, [{ address: EVM, name: 'Main' }]);
});

test('short names use significant characters', () => {
  assert.equal(shortAddress(EVM), '7f3a...c9d2');
  assert.equal(shortAddress(SOL), '7xKX...gAsU');
  assert.equal(last4(EVM), 'c9d2');
  assert.equal(displayName({ address: EVM, name: '' }), '7f3a...c9d2');
  assert.equal(displayName({ address: EVM, name: 'Main' }), 'Main');
});

test('exact decimal addition', () => {
  assert.equal(addDecimals('4.000000000000000001', '0.25'), '4.250000000000000001');
  assert.equal(addDecimals('0.1', '0.2'), '0.3');
  assert.equal(addDecimals('1', '-1.5'), '-0.5');
  assert.equal(addDecimals('1e-7', '0'), '0.0000001');
});
