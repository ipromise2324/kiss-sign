import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { marketLines, percentText } from '../card.ts';
import type { ResolvedValue } from '../card.ts';
import { paramName } from '../decode/abi.ts';
import { checkFloor } from '../floor/floor.ts';
import { decodeCall, wholeRegion } from '../decode/codec.ts';
import type { AbiValue } from '../decode/codec.ts';
import { checksumAddress } from '../safe/types.ts';
import type { Address } from '../safe/types.ts';
import { hashSafeTx } from '../safe/hash.ts';
import type { CaseResult } from './attacks.ts';
import { CHAINS } from './case.ts';

const ETH_DECIMALS = 18n;

function ether(wei: bigint): string {
  const unit = 10n ** ETH_DECIMALS;
  const fraction = (wei % unit).toString().padStart(Number(ETH_DECIMALS), '0').replace(/0+$/, '');
  return `${wei / unit}${fraction === '' ? '' : `.${fraction}`} ETH`;
}

function nameOf(result: CaseResult, address: Address): string {
  const full = checksumAddress(address);
  if (address === result.attack.safe) return `${full} (the Safe)`;
  const contract = result.registry.byAddress.get(address);
  if (contract !== undefined) return `${full} (${contract.name}, registry)`;
  const booked = [...result.attack.addressBook].find(([, a]) => a === address);
  if (booked !== undefined) return `${full} (${booked[0]}, the case's address book)`;
  return `${full} (in neither the registry nor the case's address book)`;
}

function cardValue(value: ResolvedValue, template: string): string {
  switch (value.kind) {
    case 'amount':
      return template === 'eth/transfer' ? `${value.value} wei (${ether(value.value)})` : `${value.value} base units`;
    case 'nonce':
      return String(value.value);
    case 'percent':
      return `${percentText(value.value)} (${value.value} base units)`;
    case 'contract':
      return `${value.name} ${checksumAddress(value.entry.address)} (registry)`;
    case 'address': {
      const from = value.from === 'address-book' ? "the case's address book" : value.from === 'safe' ? 'the Safe' : 'registry';
      return `${value.name} ${checksumAddress(value.address)} (${from})`;
    }
    case 'market':
      return `${marketLines(value.market).join('; ')} (markets table)`;
  }
}

function cardLines(result: CaseResult): string[] {
  const lines: string[] = [];
  for (const [i, op] of result.attack.card.operations.entries()) {
    lines.push(`    ${op.template}`);
    const resolved = result.card?.operations[i]?.values;
    for (const [name, raw] of Object.entries(op.values)) {
      const value = resolved?.get(name);
      lines.push(`      ${name.padEnd(10)} ${value === undefined ? `${raw} (not resolved)` : cardValue(value, op.template)}`);
    }
  }
  return lines;
}

function argText(result: CaseResult, value: AbiValue): string {
  switch (value.kind) {
    case 'address':
      return nameOf(result, value.value);
    case 'uint':
    case 'int':
    case 'bool':
    case 'fixed-bytes':
      return String(value.value);
    case 'bytes':
    case 'string':
      return `0x${bytesToHex(value.value)}`;
    default:
      return `${value.kind} at bytes ${value.span[0]} to ${value.span[1]}`;
  }
}

/** The call's data decoded by the case's signature when its selector matches, else its selector and words. */
function callLines(result: CaseResult): string[] {
  const { tx, attack } = result;
  const data = hexToBytes(tx.data.slice(2));
  if (data.length === 0) return ['  data        empty'];
  const selector = `0x${bytesToHex(data.subarray(0, 4))}`;
  const decoded = attack.call !== undefined && attack.call.selector === selector ? decodeCall(attack.call, wholeRegion(data)) : undefined;
  if (decoded?.kind === 'decoded') {
    return [
      `  call        ${attack.call?.signature} (selector ${selector})`,
      ...decoded.args.map((arg, i) => `    ${paramName(decoded.fn.params[i]!, i).padEnd(10)}${argText(result, arg)}`),
    ];
  }
  const words = Array.from({ length: Math.ceil((data.length - 4) / 32) }, (_, i) => `0x${bytesToHex(data.subarray(4 + i * 32, 36 + i * 32))}`);
  return [`  call        selector ${selector}, no published signature`, ...words.map((word, i) => `    word ${i}    ${word}`)];
}

function txLines(result: CaseResult): string[] {
  const { tx } = result;
  const fees = (
    [
      ['safeTxGas', tx.safeTxGas, 0n],
      ['baseGas', tx.baseGas, 0n],
      ['gasPrice', tx.gasPrice, 0n],
    ] as const
  ).filter(([, value, zero]) => value !== zero);
  return [
    `  to          ${nameOf(result, tx.to)}`,
    `  value       ${tx.value} wei`,
    `  operation   ${tx.operation === 1 ? '1, delegatecall: the target runs as the Safe, with the Safe\'s storage' : '0, call'}`,
    ...callLines(result),
    ...fees.map(([name, value]) => `  ${name.padEnd(12)}${value}`),
  ];
}

/** The floor needs no card and no chain, so it shows even where verify stops before a verdict. */
function floorLine(result: CaseResult): string {
  const floor = checkFloor(result.tx);
  return floor.kind === 'pass' ? 'Floor rules alone: pass' : `Floor rules alone: refused by ${[...new Set(floor.findings.map((f) => f.rule))].join(', ')}`;
}

function judgementLines(result: CaseResult): string[] {
  const lines: string[] = [floorLine(result)];
  for (const { label, outcome } of result.judgements) {
    if (outcome.kind === 'refused') {
      lines.push(`Verdict ${label}: no verdict, verify stopped: ${outcome.reason}`);
      continue;
    }
    const { verdict } = outcome;
    lines.push(`Verdict ${label}: ${verdict.kind}`);
    if (verdict.kind === 'MATCH') continue;
    for (const cause of verdict.causes) for (const detail of cause.details) lines.push(`  ${cause.check.padEnd(16)}${detail}`);
  }
  return lines;
}

export function renderCase(result: CaseResult): string {
  const { attack, tx, service } = result;
  return `${[
    `== ${attack.title}, ${attack.date}, ${CHAINS[attack.chain].name} ==`,
    `Safe ${checksumAddress(attack.safe)}, nonce ${tx.nonce}, executed in transaction ${String(service.transactionHash)} at block ${String(service.blockNumber)}`,
    `safeTxHash ${hashSafeTx(tx).safeTxHash}`,
    'Sources:',
    ...attack.sources.map((url) => `  ${url}`),
    '',
    'What the signers believed',
    `  ${attack.believed}`,
    '  The card for it:',
    ...cardLines(result),
    '',
    'What ran',
    ...txLines(result),
    '',
    ...judgementLines(result),
  ].join('\n')}\n`;
}
