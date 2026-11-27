import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveCard } from '../src/card.ts';
import type { Card, ResolvedCard } from '../src/card.ts';
import { loadRegistry } from '../src/registry.ts';
import { parseServiceTx } from '../src/safe/parse.ts';
import type { Address, Hex, SafeTx } from '../src/safe/types.ts';
import { checkTemplateFields } from '../src/template/check.ts';
import type { FieldCheck } from '../src/template/check.ts';
import { checkMutations } from '../src/template/mutation.ts';
import type { Checker, MutationResult } from '../src/template/mutation.ts';
import { TemplateError, loadTemplate, parseTemplate } from '../src/template/template.ts';
import type { Template } from '../src/template/template.ts';
import { repoWithTestFixtures } from './repo-with-test-fixtures.ts';

const ROOT = repoWithTestFixtures();
const registry = loadRegistry(ROOT);
const ID = 'cctp/deposit-for-burn';
const template = loadTemplate(ROOT, ID, registry);
const templates = new Map<string, Template>([[ID, template]]);
const rawTemplate = JSON.parse(readFileSync(join(ROOT, 'templates', 'cctp', 'deposit-for-burn', 'template.json'), 'utf8'));
const fixture = JSON.parse(readFileSync(join(ROOT, 'testdata', 'safe-tx', 'cctp-deposit-for-burn.json'), 'utf8'));
const burn: SafeTx = parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });
const OTHER = '0x1111111111111111111111111111111111111111' as Address;
const BURN_PATH = 'multiSend[1].depositForBurn';

function resolved(recipient: string, tx: SafeTx = burn): ResolvedCard {
  const card: Card = { operations: [{ template: ID, values: { token: 'usdc', amount: '18637940000', recipient } }] };
  const result = resolveCard(card, { templates, registry, addressBook: new Map([['other', OTHER]]), safe: tx.safe });
  assert.equal(result.kind, 'resolved', JSON.stringify(result));
  return (result as Extract<typeof result, { kind: 'resolved' }>).card;
}

const check = (recipient: string, tx: SafeTx = burn): FieldCheck => checkTemplateFields(tx, resolved(recipient, tx), templates, registry);

/** The mintRecipient word of the burn, which holds the Safe left-padded: the second place the Safe's 20 bytes appear. */
const RECIPIENT = (() => {
  const data = burn.data.slice(2);
  const at = data.indexOf(burn.safe.slice(2), data.indexOf('8e0250ee')) / 2 - 12;
  return [at, at + 32] as const;
})();

function withWord(word: Uint8Array): SafeTx {
  const bytes = hexToBytes(burn.data.slice(2));
  bytes.set(word, RECIPIENT[0]);
  return { ...burn, data: `0x${bytesToHex(bytes)}` as Hex };
}

test('a CCTP burn of another Safe that mints to itself matches a card naming the Safe as recipient', () => {
  assert.equal(`0x${bytesToHex(hexToBytes(burn.data.slice(2)).subarray(...RECIPIENT))}`, `0x${'00'.repeat(12)}${burn.safe.slice(2)}`);
  assert.deepEqual(check('safe'), { kind: 'match' });
});

test('a card naming another recipient is a mismatch at mintRecipient, which names the padded word it expected', () => {
  assert.deepEqual(check('other'), {
    kind: 'mismatch',
    findings: [{ callPath: BURN_PATH, arg: 'mintRecipient', bytes: RECIPIENT, expected: `0x${'00'.repeat(12)}${OTHER.slice(2)}`, actual: `0x${'00'.repeat(12)}${burn.safe.slice(2)}` }],
  });
});

test('the Safe with a non-zero padding byte, or right-padded, is not the Safe', () => {
  const safe = hexToBytes(burn.safe.slice(2));
  const dirty = new Uint8Array(32);
  dirty.set(safe, 12);
  dirty[0] = 1;
  const right = new Uint8Array(32);
  right.set(safe, 0);
  for (const word of [dirty, right]) {
    const result = check('safe', withWord(word));
    assert.equal(result.kind, 'mismatch');
    assert.deepEqual(
      (result as Extract<FieldCheck, { kind: 'mismatch' }>).findings.map((f) => [f.arg, f.actual]),
      [['mintRecipient', `0x${bytesToHex(word)}`]],
    );
  }
});

const mutations = (checker?: Checker): MutationResult => checkMutations(burn, resolved('safe'), templates, registry, [], {}, checker);

test('every bound field of the burn, the recipient word included, changed alone, gives a mismatch', () => {
  assert.deepEqual(mutations(), { kind: 'pass', bound: 13, free: 0 });
});

test('a checker that ignores the recipient word makes the template weak, naming mintRecipient', () => {
  const original = hexToBytes(burn.data.slice(2)).slice(...RECIPIENT);
  const blind: Checker = (tx, ...rest) => {
    const bytes = hexToBytes(tx.data.slice(2));
    bytes.set(original, RECIPIENT[0]);
    return checkTemplateFields({ ...tx, data: `0x${bytesToHex(bytes)}` as Hex }, ...rest);
  };
  const result = mutations(blind);
  assert.equal(result.kind, 'weak-template');
  assert.deepEqual(
    (result as Extract<MutationResult, { kind: 'weak-template' }>).uncaught.map(({ leaf, mutated }) => [leaf.callPath, leaf.arg, leaf.rule.kind, mutated]),
    [[BURN_PATH, 'mintRecipient', 'address-word', 'match']],
  );
});

function refused(change: (raw: typeof rawTemplate) => void): TemplateError {
  const broken = structuredClone(rawTemplate);
  change(broken);
  try {
    parseTemplate(broken, registry, 'committed');
  } catch (error) {
    if (error instanceof TemplateError) return error;
    throw error;
  }
  return assert.fail('the template loaded');
}

const burnArgs = (raw: typeof rawTemplate) => raw.calls[1].args;
const REASON = { en: 'test' };

test('a bytes32 named as a recipient is never free, nor a constant other than zero, and the refusal says to bind it with addressWord', () => {
  const free = refused((raw) => (burnArgs(raw).mintRecipient = { free: REASON }));
  assert.equal(free.path, `calls[1].args.mintRecipient`);
  assert.match(free.message, /mintRecipient names a recipient, whose address a bytes32 holds as a word; bind it with \{"addressWord": \{"card": \.\.\.\}\}/);
  const constant = refused((raw) => (burnArgs(raw).mintRecipient = { const: `0x${'00'.repeat(12)}${OTHER.slice(2)}` }));
  assert.equal(constant.path, `calls[1].args.mintRecipient`);
  for (const name of ['to', 'recipient', 'receiver', 'beneficiary', '_to', 'refundRecipient', 'feeReceiver']) {
    const renamed = refused((raw) => {
      raw.calls[1].function = raw.calls[1].function.replace('mintRecipient', name);
      const { mintRecipient: _, ...rest } = burnArgs(raw);
      raw.calls[1].args = { ...rest, [name]: { free: REASON } };
    });
    assert.equal(renamed.path, `calls[1].args.${name}`, name);
  }
});

test('a bytes32 named otherwise may be free, and a recipient word may be the zero constant', () => {
  const zero = structuredClone(rawTemplate);
  burnArgs(zero).mintRecipient = { const: `0x${'00'.repeat(32)}` };
  assert.doesNotThrow(() => parseTemplate(zero, registry, 'committed'));
  const caller = structuredClone(rawTemplate);
  burnArgs(caller).destinationCaller = { free: REASON };
  assert.doesNotThrow(() => parseTemplate(caller, registry, 'committed'));
});

test('addressWord binds only a bytes32, and only through a card, safe or contract rule', () => {
  assert.match(refused((raw) => (raw.calls[1].args.burnToken = { addressWord: { card: 'token' } })).message, /addressWord rule cannot bind a address/);
  assert.match(refused((raw) => (burnArgs(raw).mintRecipient = { addressWord: { const: `0x${'00'.repeat(20)}` } })).message, /holds one card, safe or contract rule/);
  assert.match(refused((raw) => (burnArgs(raw).mintRecipient = { addressWord: { card: 'amount' } })).message, /a card rule cannot bind a address/);
  for (const inner of [{ safe: true }, { contract: 'cctp-token-messenger-v2' }]) {
    const other = structuredClone(rawTemplate);
    burnArgs(other).mintRecipient = { addressWord: inner };
    assert.doesNotThrow(() => parseTemplate(other, registry, 'committed'), JSON.stringify(inner));
  }
});
