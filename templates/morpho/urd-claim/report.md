# morpho/urd-claim

The Safe claims rewards from Morpho's Universal Rewards Distributor (URD). The Morpho app sends one `multicall` to Bundler3 with one bundle item per reward token, each calling the URD's `claim(Safe, reward, claimable, proof)`, and appends its 8-byte trailer. The URD pays `account` whoever calls it, so Bundler3 can call it for the Safe.

## Addresses and ABI

| Name | Address | Kind | Etherscan | Creator |
| --- | --- | --- | --- | --- |
| `morpho-urd` | `0x330eefa8a787552DC5cAd3C3cA644844B1E61Ddb` | `distributor` | `UniversalRewardsDistributor`, solc 0.8.19, no proxy | `0x937Ce2d6c488b361825D2DB5e8A70e26d48afEd5`, transaction `0x091c1b2fb8ceaf652fe7fab281e49409d5c00e39c1ab9fcb9c883ab2a1f17ed2`, block 19,405,449 |

[Morpho's addresses page](https://docs.morpho.org/get-started/resources/addresses/) lists it as "Universal Rewards Distributor (used with the Market Rewards Program Registry)" with an Etherscan link. Bundler3, its trailer, and the MORPHO token are in `templates/morpho/vault-deposit/report.md` and `templates/merkl/claim/report.md`.

`pnpm prove-abi` first refused it: Sourcify holds a partial match, so the compiled code differed at byte 3,316, inside the IPFS metadata hash at the end of the code. This branch masks that hash when it is the only difference (engine change below). Then, with solc 0.8.19 pinned:

```
address        0x330eefa8a787552DC5cAd3C3cA644844B1E61Ddb
proxy          none
compiler       solc 0.8.19+commit.7dd6d404
contract       src/UniversalRewardsDistributor.sol:UniversalRewardsDistributor
functions      15
codeHash       0xbef9dc65dccc9a019287d0bf6604654d23cbfbac0880842cfe9eac3f856ea252
masked         0 immutable spans, 0 library spans, the metadata hash (Sourcify holds a partial match)
```

Fixture `testdata/abi/morpho-urd.json`.

## Engine change: partial matches

A Sourcify partial match compiles to every byte on chain except the 34-byte IPFS hash of the metadata, which hashes the source text, comments included. `prove.ts` now masks that hash only when both codes end in a solc IPFS trailer at the same place and the hashes differ, and reports `metadataHashMasked`. Every other byte is still compared, so a partial match proves the selectors and types, as a trailer without a hash already did, but not the parameter names. `docs/design.md` Known limits says so. Tests: the URD and the CCTP MessageTransmitter prove; a URD source with one changed comparison is refused; MessageTransmitter code with one changed byte just before the trailer is refused. Revert check: without the mask both proofs are refused again.

## Fields

| Field | Meaning | Rule |
| --- | --- | --- |
| `to`, `value` | Bundler3, no ETH | `bundler3`, 0 |
| `bundle[i].to` | the URD | `morpho-urd` |
| `bundle[i].data.claim.account` | who is paid | the Safe |
| `bundle[i].data.claim.reward` | which token | the card's `token` |
| `bundle[i].data.claim.claimable` | cumulative amount in the leaf | free |
| `bundle[i].data.claim.proof` | the proof | free |
| `bundle[i].value`, `skipRevert`, `callbackHash` | Bundler3 item settings | 0, false, zero |
| trailer | Morpho app tag | at most 8 bytes |

Card: `token`. Effects: the Safe gives nothing and gets a positive amount of `token`. The `multicall` merges, so several reward tokens are one card operation each, in bundle order.

Why the free fields are safe. The proven `claim` reverts unless the proof hashes `(account, reward, claimable)` into the root and `claimable` exceeds what was claimed, then transfers `claimable - claimed` of `reward` to `account`, nothing else. The effects check requires the Safe to get more of each card token and nothing else to change.

## Past transactions

```sh
pnpm past-txs morpho/urd-claim --token morpho --anchor any --from morpho-urd --from-block 22800000 --to-block 22820000 --max-txs 800
```

| Alchemy, Etherscan, both | Executed by a Safe | Fit | Unreadable |
| --- | --- | --- | --- |
| 137, 137, 137 | 5 from 5 Safes | 1 from 1 Safe | 4 |

The fit held every rule. Misfits: one Safe claimed two tokens in one bundle (two operations on one card); one did a Merkl claim then this `multicall` (the `merkl-and-morpho-urd-claim` test); two called other contracts (`0xac9650d8`, `0x224d8703`). One more Safe executed through `execTransaction` calldata that did not decode. Of the 137, 103 called Bundler3 or the URD directly from an EOA.

The sample is small. The Safe's own history has three URD claims of this shape (MORPHO, and FXN with MORPHO), all executed in the same Ethereum transaction as other Safe transactions, which kiss-sign does not judge from a receipt.

## ERC-7730

No descriptor in [LedgerHQ/clear-signing-erc7730-registry](https://github.com/LedgerHQ/clear-signing-erc7730-registry) names this URD.

## Protocol health

- The URD's owner and root updaters can set a new root (`setRoot`, `submitRoot`, `acceptRoot` behind a timelock). A wrong root can pay others, not take from the Safe.
- DefiLlama's hack list ([api.llama.fi/hacks](https://api.llama.fi/hacks)) has one Morpho entry, "LeadBlock's Morpho Blue Market" (October 2024, oracle misconfiguration in one market), unrelated to the URD.

## Tests

`test/claims.test.ts`: `morpho-urd-claim` gives `MATCH`, 8 bound fields each caught by the mutation check, another account is `MISMATCH`, another token is `MISMATCH` at `reward`. Simulated and from its receipt it gets +3,824.55 MORPHO and nothing else, `MATCH`.
