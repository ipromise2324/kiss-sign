# morpho/vault-bundles-deposit

The Safe deposits an amount of a Morpho vault's asset into that vault through VaultBundlesV1, the Morpho app's current deposit route: one official MultiSend with two calls. The first approves VaultBundlesV1 for exactly the amount. The second calls `vaultBundlesV1Deposit`, which pulls the amount from the Safe, deposits it into the vault, and has the vault mint the shares to the caller, the Safe.

The card is the same as `morpho/vault-deposit`'s: the vault, the amount, and `min-shares`, the fewest shares the deposit may get. The two templates are two routes to one operation, and a card names the one the app built.

## Addresses and ABI

| Name | Address | Kind | `pnpm prove-abi` |
| --- | --- | --- | --- |
| `vault-bundles-v1` | `0x02912516d49dE997db75B9D7858faAE59209650B` | router | `lib/bundles/src/vault/VaultBundlesV1.sol:VaultBundlesV1`, solc 0.8.34, no proxy, 0 immutable spans, code hash `0xa8ec5960…`, 4 functions |

- [Morpho's addresses page](https://docs.morpho.org/get-started/resources/addresses/) lists VaultBundlesV1 on Ethereum at this address and links its source in [morpho-org/bundles](https://github.com/morpho-org/bundles/blob/main/src/vault/VaultBundlesV1.sol).
- [morpho-org/sdks](https://github.com/morpho-org/sdks/blob/main/packages/morpho-ts/src/addresses.ts), the app's SDK, names the same address as `bundles.vaultBundlesV1` for mainnet.
- Etherscan: verified as `VaultBundlesV1`, compiler v0.8.34. Created in transaction `0xf026c771c62ada6173df2a20cc46bcfa86b60a4b7a75dc9174dfed59c67188fd`, block 25,720,857, by `0x3448F8C366047d76b6b58bb4ef225E4454B1b5ff` through the contract `0x19f57e4080fc40812f806054fa79052e6050b9b6`. Neither source names that deployer, so the creator check rests on the two sources naming the address.
- solc 0.8.34 is pinned in this pull request. Its sha256, `c8649f8d…11d8`, is the one both soliditylang lists give and the one the GitHub release asset `soljson.js` of v0.8.34 hashes to.
- The code on chain ends in the metadata trailer of `bytecodeHash: "none"`, so the matching bytecode proves the ABI's selectors and types but not its parameter names (Known limits, `docs/design.md`). The names below come from the verified source.

`testdata/abi/vault-bundles-v1.json` records the proof, and `test/abi-proof.test.ts` checks `vaultBundlesV1Deposit(address vault, uint256 assets, uint256 maxSharePriceE27, (uint8 kind, bytes data) assetPermit, uint256 referralFeePct, address referralFeeRecipient, uint256 deadline)`.

## Fields

From the proven source of `vaultBundlesV1Deposit` and its library `TokenLib`:

| Call | Field | Meaning | Rule |
| --- | --- | --- | --- |
| `multiSend[0]` | `to` | the asset token | the card vault's `asset` |
| | `approve.spender` | who may pull the asset | `vault-bundles-v1` |
| | `approve.value` | how much | the card's `amount` |
| `multiSend[1]` | `to` | VaultBundlesV1 | `vault-bundles-v1` |
| | `value` | ETH sent, which the contract would wrap instead of pulling the asset | 0 |
| | `vault` | the vault | the card's `vault` |
| | `assets` | how much it pulls from the Safe | the card's `amount` |
| | `maxSharePriceE27` | slippage bound, the most assets per share | `maxSharePrice`: at most the card's `amount` × 1e27 / `min-shares`; with no referral fee, `vaultBundlesV1Deposit` deposits the whole `assets` and requires `assets × 1e27 / shares`, rounded up, to be at most the bound |
| | `assetPermit.kind` | how it pulls the asset: 0 `transferFrom` after an approval, 1 an ERC-2612 permit, 2 a Permit2 signature | 0 |
| | `assetPermit.data` | the permit for kind 1 or 2 | free: `pullToken` reads it only for kind 1 or 2 |
| | `referralFeePct` | the share of `assets` sent to `referralFeeRecipient` instead of deposited, in WAD | 0 |
| | `referralFeeRecipient` | who gets the fee | the zero address |
| | `deadline` | the time after which the call reverts | free: it limits when the deposit can run, not what it does |

The shares go to `msg.sender`, the Safe; the function has no receiver argument. Effects: the Safe gives exactly `amount` of the asset and gets a positive number of the vault's shares; the allowance may not end higher than it started, so the approval is spent in full.

The referral fee is why the fee fields are bound. A fee is deducted from the amount, sent elsewhere, and the rest deposited, so the Safe still gives exactly `amount` and still gets some shares: the effects would not see it. Every studied deposit had a zero fee and a zero recipient.

`assetPermit.data` is empty in every studied deposit. It is free because the mutation check cannot change empty bytes in place, and with `kind` bound to 0 no byte of it is read. A non-empty value still decodes and still gives `MATCH`, but does nothing.

`vaultBundlesV1Deposit` may carry a trailer of up to 12 bytes. The app appends a 4-byte timestamp and a 4-byte origin tag (morpho-org/sdks, `addTransactionMetadata`); 18 of the 46 deposits below carry a second origin tag, `25afea44` and then `2222da44`. The function's arguments are decoded from their offsets and the bytes after them are never read. The approval carries no trailer.

## Past transactions

```sh
pnpm past-txs morpho/vault-bundles-deposit --token steakhouse-prime-usdc --anchor mint --from-block 26200000 --to-block 26380000 --max-txs 3000
```

Alchemy and Etherscan both found the same 893 share mints. 46 came from 14 Safes through `execTransaction`. Three other transactions could not be read, because drpc rate-limited the request.

With the trailer at 12 bytes, 21 deposits from 8 Safes fit the call shape: 3 with the 8-byte trailer and 18 with the 12-byte one. In 20 of them every bound field held its rule: the spender was VaultBundlesV1, the approval and `assets` were equal, the permit kind, the fee and the fee recipient were zero, and every value was 0. In the other, the approval was 2^256−1. The floor refuses that as an unlimited approval, and the template as not the amount.

Misfits:

- **No approval.** 13 from 4 Safes call `vaultBundlesV1Deposit` alone, spending an approval given earlier. The effects refuse a changed allowance, so this shape is left out.
- **Another MultiSend.** 6 from 2 Safes delegatecall a contract that is not an official MultiSend.
- **Other routes.** 6 transactions deposit through other contracts, or directly into the vault after another call.

The tests record two deposits from other Safes: `morpho-bundles-deposit` with the 8-byte trailer and `morpho-bundles-deposit-two-tags` with the 12-byte one. Each gives `MATCH` with its implied card, and a mutation of each of its 12 bound fields gives `MISMATCH`. A 10% referral fee, another vault, or another amount is a `MISMATCH` at that field.

## ERC-7730

From [LedgerHQ/clear-signing-erc7730-registry](https://github.com/LedgerHQ/clear-signing-erc7730-registry) at commit `3bebbd05cbc2d2d2bf9c41a8edbf5e5cc88e4eb4`: `registry/morpho/calldata-VaultBundlesV1.json`, git blob `edbe8251a86ce05a147babc47cbe03652a895280`, lists this address for chain 1.

It shows `vaultBundlesV1Deposit` as "Deposit to vault" with the vault, `assets` as "Base units, with fee", the referral fee, the fee recipient when it is not zero, and the deadline. It hides `maxSharePriceE27` and `assetPermit`. Its field meanings agree with the ones above. Like this template, it treats the fee as part of the amount, which is why the template binds the fee to zero rather than trusting a display of it. No ERC-8176 attestation was checked.

## Protocol health

- Losses, audits and hacks for the vaults are in `templates/morpho/vault-deposit/report.md`. DefiLlama's hacks data (`https://api.llama.fi/hacks`), read again for this pull request, names no incident for VaultBundlesV1 or the bundles.
- [morpho-org/bundles](https://github.com/morpho-org/bundles) keeps its audits in [`audits/`](https://github.com/morpho-org/bundles/tree/main/audits). The one that names vault bundles is `2026-08-07-blue-vaults-bundles-blackthorn.pdf`; the README adds that the bundles are formally verified with the Certora Prover.
- VaultBundlesV1 is not upgradeable: it has no proxy and no owner. Its NatSpec says it is "designed and audited for Vault V1 (MetaMorpho V1 or V1.1) and Vault V2".
- The README warns that tokens left in a bundle contract are lost. A deposit leaves nothing in it: the effects check that the Safe gives exactly the amount.
