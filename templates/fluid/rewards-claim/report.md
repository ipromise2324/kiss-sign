# fluid/rewards-claim

The Safe claims the FLUID it earned on Fluid positions. The Fluid app sends one direct call to the FluidMerkleDistributor: `claim(Safe, cumulativeAmount, positionType, positionId, cycle, proof, metadata)`. Fluid publishes a Merkle root per cycle; the leaf is `(positionType, positionId, recipient, cycle, cumulativeAmount, metadata)`, and the distributor pays the recipient the cumulative amount minus what that position already claimed.

## Addresses and ABI

| Name | Address | Kind | Etherscan | Creator |
| --- | --- | --- | --- | --- |
| `fluid-rewards-distributor` | `0x7060FE0Dd3E31be01EFAc6B28C8D38018fD163B0` | `distributor` | `FluidMerkleDistributor`, solc 0.8.21, no proxy | `0x910e413DBF3F6276Fe8213fF656726bDc142E08E`, transaction `0x32f0b630520be8ad573e9f555b5784d181be58cf8bd8251147ff99eef0c632d6`, block 21,430,780 |
| `fluid` | `0x6f40d4A6237C257fff2dB00FA0510DeEECd303eb` | `token` | `InstaToken`, solc 0.7.3, no proxy | `0xf6839085f692bDe6A8062573E3DA35E7e947c21E`, transaction `0x10ee055693adad10a57a28b3512b7cca266851f46e40ed6909fd643c860f940e`, block 12,183,236 |

Sources:

- [`deployments/deployments.md`](https://github.com/Instadapp/fluid-contracts-public/blob/main/deployments/deployments.md) in Instadapp's `fluid-contracts-public`, section "$FLUID MerkleDistributor (Fluid Rewards - Dec 2024)", names the distributor with the constructor name "Fluid Rewards - Dec 2024". The same file lists FLUID `0x6f40...03eb` as `token0` of several FLUID markets.
- The distributor's `TOKEN()` returns FLUID; every claim in the Safe's history and in the search below paid FLUID from this address.

The file lists other Fluid distributors (GHO vaults, cbBTC-wBTC, cbBTC, and one used only through `delegatecall`). The template names only the Dec 2024 one, the one the Fluid app claims from for lending positions. Another distributor needs its own registry entry and a template change.

`pnpm prove-abi` on `main` refused both: solc 0.8.21 and 0.7.3 were unpinned. This branch pins 0.7.3, 0.8.19 and 0.8.25 at the sha256 that soliditylang's `bin/list.json` and `emscripten-wasm32/list.json` both give, equal to the sha256 of each release's `soljson.js` on GitHub. Then:

```
address        0x7060FE0Dd3E31be01EFAc6B28C8D38018fD163B0
proxy          none
compiler       solc 0.8.21+commit.d9974bed
contract       contracts/protocols/lending/merkleDistributor/main.sol:FluidMerkleDistributor
functions      21
codeHash       0x38ca443932dc00bd0b5f550ef6a9773fd578d3c6ffc573485c22f0dc40e9a64b
masked         2 immutable spans, 0 library spans

address        0x6f40d4A6237C257fff2dB00FA0510DeEECd303eb
proxy          none
compiler       solc 0.7.3+commit.9bfce1f6
contract       contracts/TokenDelegator.sol:InstaToken
codeHash       0x8cf49f6749c84d0c4fad1cac5dcd25451e3714b0d0e2bda19610e97809ae017e
```

Both at block 26,385,263 by Alchemy and drpc; fixtures `testdata/abi/fluid-rewards-distributor.json` and `testdata/abi/fluid-token.json`. FLUID's `InstaToken` delegates to an implementation; no template calls the token, so only its address matters here.

## Fields

| Field | Meaning | Rule |
| --- | --- | --- |
| `to` | the distributor | `fluid-rewards-distributor` |
| `value` | ETH sent | 0 |
| `claim.recipient_` | who is paid | the Safe |
| `claim.cumulativeAmount_` | total earned by the position | free |
| `claim.positionType_`, `positionId_`, `metadata_` | which position earned it | free |
| `claim.cycle_` | which root the proof is against | free |
| `claim.merkleProof_` | the proof | free |

Card: `token` (a registry `token`). Effects: the Safe gives nothing and gets a positive amount of `token`.

Why the free fields are safe. The proven source (`claim` in `merkleDistributor/main.sol`) reverts unless `msg.sender == recipient_`, unless `cycle_` is the current or previous cycle, and unless the proof hashes the leaf into that cycle's root. It then sends only the distributor's `TOKEN`, and only to `recipient_`. So the free fields choose how much of the Safe's own reward is paid, never where it goes or what else happens. The effects check carries the rest: the Safe must end with more of the card's token, and every other balance and allowance of the Safe must be unchanged. A claim that pays nothing, or a call that moves anything else, is `MISMATCH`.

## Past transactions

```sh
pnpm past-txs fluid/rewards-claim --token fluid --anchor any --from fluid-rewards-distributor --from-block 22600000 --to-block 22660000 --max-txs 1500
pnpm past-txs fluid/rewards-claim --token fluid --anchor any --from fluid-rewards-distributor --from-block 23020000 --to-block 23040000 --max-txs 800
```

`--from` is new in this branch: it keeps only transfers out of the distributor, so the search sees claims and not FLUID trading.

| Blocks | Alchemy, Etherscan, both | Executed by a Safe | Fit | Unreadable |
| --- | --- | --- | --- | --- |
| 22,600,000 to 22,660,000 | 371, 371, 371 | 4 from 4 Safes | 3 from 3 Safes | 0 |
| 23,020,000 to 23,040,000 | 229, 229, 229 | 3 from 3 Safes | 1 from 1 Safe | 4 |

Unreadable transactions are ones drpc rate-limited. Over the 4 fits every rule held: target the distributor, value 0, `recipient_` the Safe. `positionType_` was 1 and `metadata_` empty in all 4. Most claims (561 of 600) are EOAs calling `claim` directly.

Misfits:

- Two `claim` calls in one MultiSend (1 Safe). A card with two `fluid/rewards-claim` operations matches it; it is the `fluid-claim-two` test.
- A call to another contract, selector `0x244b0f6a` (2 Safes), which is not this distributor.

## ERC-7730

No descriptor in [LedgerHQ/clear-signing-erc7730-registry](https://github.com/LedgerHQ/clear-signing-erc7730-registry) names a Fluid distributor or this address, and no Fluid folder exists there.

## Protocol health

- Incident: DefiLlama's hack list ([api.llama.fi/hacks](https://api.llama.fi/hacks), entry "Fluid Lending", 31 May 2026) records $215,000 taken after "operational keys used exclusively by Fluid's Merkle rewards distribution infrastructure" were compromised; the attacker approved fraudulent allocations and claimed about 125,109 FLUID. The same entry says core contracts, lending markets and deposits were not affected. That is this kind of contract. A fraudulent root can pay someone else the distributor's FLUID, but a claim by the Safe can only add to the Safe, which the effects check requires.
- The proven ABI has `spell(address[], bytes[])`, `proposeRoot`, `approveRoot`, `pause` and `transferOwnership`: the owner can run arbitrary calls from the distributor. None of these touch the Safe's own balances or approvals.
- Audits and the Liquidity layer's governance are in `templates/fluid/vault-deposit/report.md`.

## Tests

`test/claims.test.ts` records `fluid-claim`, `fluid-claim-other-safe` and `fluid-claim-two` from three Safes. Each gives `MATCH` with its implied card; a mutation of each bound field (3 per claim) gives `MISMATCH`; so does another recipient. A card with one claim where the transaction makes two is `MISMATCH` at the second call. `fluid-claim` is simulated on its parent block and read from its receipt: +58.04 FLUID, nothing else, `MATCH`.
