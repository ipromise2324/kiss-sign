import { hashSafeTx } from './hash.ts';
import {
  SafeTxParseError,
  parseAddress,
  parseHex,
  parseOperation,
  parseSafeVersion,
  parseUint256,
} from './types.ts';
import type { SafeTx } from './types.ts';

export type SafeWebAppContext = { readonly chainId: bigint; readonly safe: string; readonly version: string };
export type ServiceContext = { readonly chainId: bigint; readonly version: string };

const WEB_APP_FIELDS = [
  'to',
  'value',
  'data',
  'operation',
  'safeTxGas',
  'baseGas',
  'gasPrice',
  'gasToken',
  'refundReceiver',
  'nonce',
] as const;

function asRecord(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SafeTxParseError('transaction', 'not a JSON object');
  }
  return raw as Record<string, unknown>;
}

function field(record: Record<string, unknown>, name: string): unknown {
  if (!Object.hasOwn(record, name)) throw new SafeTxParseError(name, 'missing');
  return record[name];
}

function parseFields(record: Record<string, unknown>, chainId: bigint, safe: unknown, version: unknown): SafeTx {
  return {
    chainId: parseUint256('chainId', chainId),
    safe: parseAddress('safe', safe),
    version: parseSafeVersion(version),
    to: parseAddress('to', field(record, 'to')),
    value: parseUint256('value', field(record, 'value')),
    data: parseHex('data', field(record, 'data')),
    operation: parseOperation(field(record, 'operation')),
    safeTxGas: parseUint256('safeTxGas', field(record, 'safeTxGas')),
    baseGas: parseUint256('baseGas', field(record, 'baseGas')),
    gasPrice: parseUint256('gasPrice', field(record, 'gasPrice')),
    gasToken: parseAddress('gasToken', field(record, 'gasToken')),
    refundReceiver: parseAddress('refundReceiver', field(record, 'refundReceiver')),
    nonce: parseUint256('nonce', field(record, 'nonce')),
  };
}

/** The JSON from the Safe web app's "Review details > JSON" tab. */
export function parseSafeWebAppTx(raw: unknown, context: SafeWebAppContext): SafeTx {
  const record = asRecord(raw);
  const unexpected = Object.keys(record).find((key) => !(WEB_APP_FIELDS as readonly string[]).includes(key));
  if (unexpected !== undefined) throw new SafeTxParseError(JSON.stringify(unexpected.slice(0, 32)), 'unexpected field');
  return parseFields(record, context.chainId, context.safe, context.version);
}

/** One multisig transaction from the Safe Transaction Service, refused unless its safeTxHash is the one we compute. */
export function parseServiceTx(raw: unknown, context: ServiceContext): SafeTx {
  const record = asRecord(raw);
  const reported = parseHex('safeTxHash', field(record, 'safeTxHash'));
  // The service stores empty calldata as null; the Safe hashes it as empty bytes.
  const data = field(record, 'data') === null ? '0x' : record.data;
  const tx = parseFields({ ...record, data }, context.chainId, field(record, 'safe'), context.version);
  if (hashSafeTx(tx).safeTxHash !== reported) {
    throw new SafeTxParseError('safeTxHash', 'differs from the hash computed from the transaction');
  }
  return tx;
}
