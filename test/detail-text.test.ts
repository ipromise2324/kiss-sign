import assert from 'node:assert/strict';
import test from 'node:test';
import { detailText } from '../src/verify/detail-text.ts';

const A = `0x${'a'.repeat(40)}`;
const B = `0x${'b'.repeat(40)}`;
const H = `0x${'c'.repeat(64)}`;
const P = `0x${'d'.repeat(64)}`;

const CASES: readonly (readonly [string, string])[] = [
  ['multiSend[0].approve value: expected 1000611448606, got 1000611448607', 'multiSend[0].approve value：應為 1000611448606，實際 1000611448607'],
  ['call.execute amountOutMinimum: expected at least 5, got 4', 'call.execute amountOutMinimum：應為 至少 5，實際 4'],
  [`multiSend[0].removeOwner prevOwner: expected the owner before alice ${A}, who is not an owner of the Safe, got ${B}`, `multiSend[0].removeOwner prevOwner：應為 alice ${A} 的前一位 owner，但它不是這個 Safe 的 owner，實際 ${B}`],
  ['multiSend[1] call: expected approve(address,uint256), got missing', 'multiSend[1] call：應為 approve(address,uint256)，實際 缺少'],
  ['safeTx operation: expected 0 (call), got 1 (delegatecall)', 'safeTx operation：應為 0（call），實際 1（delegatecall）'],
  ['fee-fields at safeTx: gasPrice is 7, must be zero', 'fee-fields 在 safeTx：gasPrice 是 7，必須是零'],
  [`unlimited-approval at multiSend[0]: approve(address,uint256) of token ${A} to spender ${B}, amount 115792`, `unlimited-approval 在 multiSend[0]：代幣 ${A} 給 spender ${B} 的 approve(address,uint256)，數量 115792`],
  [`safe-state at safe: threshold changed from 2 to 1, not to 3`, 'safe-state 在 safe：threshold 從 2 變成 1，而不是 3'],
  [`morpho/vault-deposit hashes to ${H}, the approved hash is ${P}`, `morpho/vault-deposit 的 hash 是 ${H}，你核准的是 ${P}`],
  ['morpho/vault-deposit was never approved; run pnpm kiss-sign template approve morpho/vault-deposit', 'morpho/vault-deposit 從未核准；執行 pnpm kiss-sign template approve morpho/vault-deposit'],
  [`usdc ${A} changed by -6, the card explains -5`, `usdc ${A} 變動了 -6，卡片說明的是 -5`],
  [`usdc ${A} changed by -1.5 (-1500000 base units), the card explains at least +1,000.25 (+1000250000 base units)`, `usdc ${A} 變動了 -1.5（-1500000 最小單位），卡片說明的是 至少 +1,000.25（+1000250000 最小單位）`],
  [`unregistered token ${A} still held 3 after the transaction, the card gives all of it`, `交易後 未登記的代幣 ${A} 還剩 3，但卡片要全部給出`],
  [`vault ${A} totalAssets() shares: 5 before, 4 after in a simulated block; the template needs it to increase`, `vault ${A} totalAssets() shares：交易前 5，交易後 4（在模擬的區塊中讀取）；模板要求它增加`],
  [`steakhouse ${A} holds ${B} by its asset() at block 9, the registry says usdc ${A}`, `steakhouse ${A} 在區塊 9 的 asset() 是 ${B}，登記表寫的是 usdc ${A}`],
  [`bundler3 ${A} has code hash ${H} at block 9, the registry pins ${P}`, `bundler3 ${A} 在區塊 9 的程式碼 hash 是 ${H}，登記表釘選的是 ${P}`],
  ['not run, because the fields did not match', '未執行，因為欄位不符'],
];

test('a detail of a known shape reads in Traditional Chinese, its paths, values, addresses and names unchanged', () => {
  for (const [english, chinese] of CASES) assert.equal(detailText(english, 'zh-TW'), chinese);
});

test('in English every detail is shown exactly as stored', () => {
  for (const [english] of CASES) assert.equal(detailText(english, 'en'), english);
});

test('a detail of no known shape, or with one part of no known shape, is shown as stored, never half translated', () => {
  for (const english of [
    'alchemy and drpc disagree on eth_call at block 9',
    'call.f x: expected a value the program never writes, got 1',
    `fee-fields at safeTx: something new happened to ${A}`,
    `usdc ${A} changed by about six, the card explains -5`,
  ]) {
    assert.equal(detailText(english, 'zh-TW'), english);
  }
});
