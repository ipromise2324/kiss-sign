import type { Reader } from '../chain/reader.ts';
import type { BlockRef } from '../chain/types.ts';
import { MissingKeyError } from '../chain/providers.ts';
import { abiCaseDeclaration, abiCaseEtherscan, replayAbiCase } from '../contracts/abi-case.ts';
import type { AbiCase } from '../contracts/abi-case.ts';
import type { EtherscanGet } from '../contracts/etherscan.ts';
import { describeRefusal, proveAbi } from '../contracts/prove.ts';
import type { AbiEntry, ProveDeps } from '../contracts/prove.ts';
import type { Registry } from '../registry.ts';
import type { Address } from '../safe/types.ts';

/** The ABI proven for an address and where the proof came from, or why there is none. */
export type ProvenAbi = { readonly kind: 'proven'; readonly abi: readonly AbiEntry[]; readonly from: string } | { readonly kind: 'none'; readonly why: string };

export type ProvenAbiDeps = {
  readonly cases: ReadonlyMap<Address, AbiCase>;
  readonly registry: Pick<Registry, 'byAddress'>;
  readonly compilers: ProveDeps['compilers'];
  readonly reader: Reader;
  /** Throws `MissingKeyError` when no Etherscan key is set. */
  readonly etherscan: () => EtherscanGet;
  /** The block a live proof reads the code at; undefined when there is none yet, such as for a pending transaction. */
  readonly block: bigint | undefined;
};

/**
 * Each address's ABI, proven once: from the ABI proof recorded in testdata/abi/, compiled again offline, or for a registry
 * entry with none, proven live from Etherscan's verified source at `block`, as `pnpm prove-abi` proves it.
 */
export function provenAbis(deps: ProvenAbiDeps): (address: Address) => Promise<ProvenAbi> {
  const known = new Map<Address, Promise<ProvenAbi>>();
  const prove = async (address: Address): Promise<ProvenAbi> => {
    const recorded = deps.cases.get(address);
    const entry = deps.registry.byAddress.get(address);
    if (recorded !== undefined) {
      const proof = await replayAbiCase(recorded, deps.compilers, entry ?? abiCaseDeclaration(recorded));
      if (proof.kind === 'refused') return { kind: 'none', why: `its ABI proof is refused: ${describeRefusal(proof.refusal)}` };
      return { kind: 'proven', abi: proof.abi, from: `the ABI proof recorded in testdata/abi/ at block ${recorded.block.number}` };
    }
    if (entry === undefined) return { kind: 'none', why: 'not a registry entry and testdata/abi holds no ABI proof of it; pnpm prove-abi proves one' };
    if (deps.block === undefined) return { kind: 'none', why: 'the transaction has no block yet' };
    let etherscan: EtherscanGet;
    try {
      etherscan = deps.etherscan();
    } catch (error) {
      if (error instanceof MissingKeyError) return { kind: 'none', why: error.message };
      throw error;
    }
    const block = await deps.reader.block(deps.block);
    if (block.kind === 'unverifiable') return { kind: 'none', why: `its block: ${block.reason}` };
    const proof = await proveAbi(deps.reader, address, block.value, { etherscan, compilers: deps.compilers }, entry);
    if (proof.kind === 'refused') return { kind: 'none', why: `its ABI proof is refused: ${describeRefusal(proof.refusal)}` };
    return { kind: 'proven', abi: proof.abi, from: `proven live from Etherscan at block ${deps.block}` };
  };
  return (address) => {
    const seen = known.get(address) ?? prove(address);
    known.set(address, seen);
    return seen;
  };
}

/**
 * The ABI the proof recorded in testdata/abi/ gives at `block`: proven again from the code there and the Etherscan source the
 * proof recorded, so code that changed since, such as a proxy's new implementation, is refused rather than decoded by.
 */
export async function recordedAbiAt(recorded: AbiCase, deps: Pick<ProvenAbiDeps, 'registry' | 'compilers' | 'reader'>, block: BlockRef): Promise<ProvenAbi> {
  const at = `the ABI proof recorded in testdata/abi/ at block ${recorded.block.number}`;
  const declared = deps.registry.byAddress.get(recorded.address) ?? abiCaseDeclaration(recorded);
  const unrecorded: Address[] = [];
  const etherscan: EtherscanGet = (address) => {
    if (recorded.etherscan[address] === undefined) unrecorded.push(address);
    return abiCaseEtherscan(recorded.etherscan)(address);
  };
  const proof = await proveAbi(deps.reader, recorded.address, block, { etherscan, compilers: deps.compilers }, declared);
  if (proof.kind === 'refused') {
    const why = unrecorded.length > 0 ? `the code there runs ${unrecorded.join(' and ')}, whose source the proof did not record` : describeRefusal(proof.refusal);
    return { kind: 'none', why: `${at} is not proven again at block ${block.number}: ${why}; pnpm record-abi-case records it at a later block` };
  }
  return { kind: 'proven', abi: proof.abi, from: `${at}, proven again at block ${block.number} from the code there and the source it recorded` };
}
