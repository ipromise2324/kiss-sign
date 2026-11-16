#!/usr/bin/env node
// Usage: change-tx.mjs <service tx.json> <out.json> (--uint <old> <new> | --address <old> <new> | --value <new>)...
//
// Writes the transaction as the Safe web app's JSON (the ten fields a signer sees under "Review details > JSON"),
// with each change applied, for the MISMATCH half of an acceptance journey. --uint replaces every 32-byte calldata word
// holding <old> (a decimal integer) with <new>; --address replaces every occurrence of an address, padded word or
// packed (as inside MultiSend), in `to` and in the calldata; --value sets the ETH value in wei. A change that matches
// nothing is refused, so a journey cannot pass on an unchanged transaction. The output has no safeTxHash or execution
// fields, so `verify` judges it as a pending transaction, simulated on the latest block.
import { readFileSync, writeFileSync } from 'node:fs';

const [input, output, ...changes] = process.argv.slice(2);
if (input === undefined || output === undefined || changes.length === 0) {
  console.error('usage: change-tx.mjs <service tx.json> <out.json> (--uint <old> <new> | --address <old> <new> | --value <new>)...');
  process.exit(2);
}
const service = JSON.parse(readFileSync(input, 'utf8'));
const tx = Object.fromEntries(
  ['to', 'value', 'data', 'operation', 'safeTxGas', 'baseGas', 'gasPrice', 'gasToken', 'refundReceiver', 'nonce'].map((key) => [key, service[key]]),
);
tx.data ??= '0x';
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const bare = (address) => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`${address} is not an address`);
  return address.slice(2).toLowerCase();
};
const replaceAll = (text, from, to) => {
  const parts = text.toLowerCase().split(from);
  return { text: parts.join(to), count: parts.length - 1 };
};

for (let i = 0; i < changes.length; ) {
  const flag = changes[i];
  if (flag !== '--value' && `${changes[i + 1]}`.toLowerCase() === `${changes[i + 2]}`.toLowerCase()) {
    console.error(`${flag} ${changes[i + 1]} ${changes[i + 2]} changes nothing; refusing`);
    process.exit(1);
  }
  let count = 0;
  if (flag === '--uint') {
    const [from, to] = [word(changes[i + 1]), word(changes[i + 2])];
    const body = tx.data.slice(2).toLowerCase();
    const r = replaceAll(body, from, to);
    tx.data = `0x${r.text}`;
    count = r.count;
    i += 3;
  } else if (flag === '--address') {
    const [from, to] = [bare(changes[i + 1]), bare(changes[i + 2])];
    const r = replaceAll(tx.data.slice(2), from, to);
    tx.data = `0x${r.text}`;
    count = r.count;
    if (tx.to.toLowerCase() === `0x${from}`) {
      tx.to = `0x${to}`;
      count += 1;
    }
    i += 3;
  } else if (flag === '--value') {
    if (!/^\d+$/.test(changes[i + 1] ?? '')) throw new Error('--value takes a decimal integer of wei');
    count = tx.value === changes[i + 1] ? 0 : 1;
    tx.value = changes[i + 1];
    i += 2;
  } else {
    throw new Error(`unknown change ${flag}`);
  }
  if (count === 0) {
    console.error(`${flag} ${changes.slice(i - (flag === '--value' ? 1 : 2), i).join(' ')} changed nothing; refusing`);
    process.exit(1);
  }
  console.error(`${flag}: ${count} place(s) changed`);
}
writeFileSync(output, `${JSON.stringify(tx, null, 2)}\n`);
