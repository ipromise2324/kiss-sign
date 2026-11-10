import type { Registry } from '../registry.ts';
import { SafeTxParseError, checksumAddress, parseAddress, parseHex } from '../safe/types.ts';
import type { Address, Hex } from '../safe/types.ts';
import { ResearchError } from './sources.ts';
import type { Ask } from './sources.ts';

const SENTENCE_FREE_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

export type ContractName = { readonly kind: 'verified'; readonly name: string } | { readonly kind: 'unverified' } | { readonly kind: 'refused' };

export type ContractOrigin = {
  readonly address: Address;
  readonly name: ContractName;
  /** The account that sent the creation transaction. */
  readonly creator: Address;
  /** The contract that ran CREATE or CREATE2, when Etherscan reports one. */
  readonly factory?: Address;
  readonly creationTx: Hex;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const READ_FIELDS = ['ContractName', 'contractAddress', 'contractCreator', 'contractFactory', 'txHash'];

export function trimEtherscanAnswer(answer: unknown): unknown {
  if (!isRecord(answer) || !Array.isArray(answer.result)) return answer;
  const result = answer.result.map((item) => (isRecord(item) ? Object.fromEntries(READ_FIELDS.filter((k) => k in item).map((k) => [k, item[k]])) : item));
  return { status: answer.status, message: answer.message, result };
}

function onlyResult(answer: unknown, what: string): Record<string, unknown> {
  if (!isRecord(answer) || answer.status !== '1' || !Array.isArray(answer.result) || answer.result.length !== 1 || !isRecord(answer.result[0])) {
    throw new ResearchError(`etherscan sent no ${what}`);
  }
  return answer.result[0];
}

function nameOf(raw: unknown): ContractName {
  if (raw === '') return { kind: 'unverified' };
  return typeof raw === 'string' && SENTENCE_FREE_NAME.test(raw) ? { kind: 'verified', name: raw } : { kind: 'refused' };
}

export async function readContractOrigin(address: Address, ask: Ask): Promise<ContractOrigin> {
  const source = onlyResult(await ask({ source: 'etherscan', query: { chainid: '1', module: 'contract', action: 'getsourcecode', address } }), 'source record');
  const creation = onlyResult(
    await ask({ source: 'etherscan', query: { chainid: '1', module: 'contract', action: 'getcontractcreation', contractaddresses: address } }),
    'creation record',
  );
  try {
    if (parseAddress('contractAddress', creation.contractAddress) !== address) throw new ResearchError('etherscan answered for another address');
    const factory = creation.contractFactory === undefined || creation.contractFactory === '' ? undefined : parseAddress('contractFactory', creation.contractFactory);
    return {
      address,
      name: nameOf(source.ContractName),
      creator: parseAddress('contractCreator', creation.contractCreator),
      ...(factory === undefined ? {} : { factory }),
      creationTx: parseHex('txHash', creation.txHash),
    };
  } catch (error) {
    if (error instanceof SafeTxParseError) throw new ResearchError(`etherscan sent a malformed creation record (${error.message})`);
    throw error;
  }
}

function labelled(address: Address, registry: Registry): string {
  const name = registry.byAddress.get(address)?.name;
  return `${checksumAddress(address)}${name === undefined ? '' : ` (registry ${name})`}`;
}

export function renderContractOrigins(origins: readonly ContractOrigin[], registry: Registry): string {
  const nameText = (name: ContractName): string => {
    switch (name.kind) {
      case 'verified':
        return name.name;
      case 'unverified':
        return 'none: the source is not verified on Etherscan';
      case 'refused':
        return 'refused: not an identifier of at most 64 characters, so not printed';
    }
  };
  const blocks = origins.map((o) =>
    [
      labelled(o.address, registry),
      `  name         ${nameText(o.name)}`,
      `  creator      ${labelled(o.creator, registry)}`,
      ...(o.factory === undefined ? [] : [`  factory      ${labelled(o.factory, registry)}`]),
      `  creation tx  ${o.creationTx}`,
    ].join('\n'),
  );
  return `${blocks.join('\n')}\n`;
}
