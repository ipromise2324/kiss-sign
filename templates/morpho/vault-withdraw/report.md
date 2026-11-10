# morpho/vault-withdraw

The Safe withdraws an amount of a Morpho vault's asset from that vault, the way the Morpho app builds it through Bundler3: one official MultiSend with two calls. The first approves GeneralAdapter1 to spend the Safe's vault shares. The second is `Bundler3.multicall` with one bundle item: GeneralAdapter1 calls `erc4626Withdraw`, which withdraws the amount from the vault for the Safe and pays it to the Safe.

The card is the vault and the amount of the asset. The design's "amount or all" is two templates: this one for an amount, `morpho/vault-withdraw-all` for all of the Safe's shares. The Morpho app builds them differently (`erc4626Withdraw` or `erc4626Redeem`), so a card names one of the two.

Withdrawing from several vaults at once is a card with one operation per vault. The app then makes every share approval first and one `multicall` with one item per vault last. The multicall is marked `merge`, so the operations of one card share it, with their items in card order.

## Warning: the effects refuse the Morpho app's withdrawals of an amount

The app approves GeneralAdapter1 for `assets × 1e27 / minSharePriceE27` shares, the most the withdrawal may burn at the price bound. The vault burns fewer, because the price at execution is above the bound. Part of the approval stays open after the transaction, and the effects check refuses any allowance that does not end where it started.

Every withdrawal of an amount that `pnpm simulate` ran gave `MISMATCH` for this reason alone, both from other Safes and every one in the signer's own history: the field checks match, and the balances match the card. The recorded case `morpho-withdraw-open-allowance` shows it: the allowance went from 4,850,840,670,525,793,065 to 40,963,643,267,656,996,464 shares.

The open allowance is small, and GeneralAdapter1 spends a Safe's shares only in a bundle the Safe itself starts (`require(owner == address(this) || owner == initiator())`). Accepting it would loosen a design rule, which is the signer's decision, not this template's. Until then, this template gives `MATCH` only when the approval is spent exactly, and `morpho/vault-withdraw-all` is the Morpho withdrawal that gives `MATCH`.

## Addresses and ABI

The template adds no contract. Bundler3, GeneralAdapter1, the factories and the vaults are proven in `templates/morpho/vault-deposit/report.md`. This pull request adds one vault for the tests:

| Name | Address | Kind | `pnpm prove-abi` | Etherscan | `pnpm prove-instance` |
| --- | --- | --- | --- | --- | --- |
| `usual-boosted-usdc` | `0xd63070114470f685b75B74D60EEc7c1113d33a3D` | vault, MetaMorpho V1.0 | `MetaMorpho`, solc 0.8.21, 32 immutable spans, code hash `0x962bef23…` | created through `metamorpho-factory-1.0` in transaction `0x7f13d5fbdab8cd902247c96287bfcfe2d4e025e7fe1c959c7741e5af5cb6f173`, block 20,377,233 | `isMetaMorpho` true from both providers |

Its name on chain is "Usual Boosted USDC" and its asset is USDC.

The proven GeneralAdapter1 ABI names both functions this route uses, and `test/abi-proof.test.ts` now checks them:

- `erc4626Withdraw(address vault, uint256 assets, uint256 minSharePriceE27, address receiver, address owner)`
- `erc4626Redeem(address vault, uint256 shares, uint256 minSharePriceE27, address receiver, address owner)`

The third argument is a lower bound, the fewest assets per share the owner accepts, not an upper bound as in `erc4626Deposit`. The proof caught a draft of this template that named it `maxSharePriceE27`.

## Fields

| Call | Field | Meaning | Rule |
| --- | --- | --- | --- |
| `multiSend[0]` | `to` | the vault, whose shares are approved | the card's `vault` |
| | `approve.spender` | who may spend the shares | `general-adapter1` |
| | `approve.value` | how many shares | free: the effects require the allowance to end where it started |
| `multiSend[1]` | `to` | Bundler3 | `bundler3` |
| bundle item | `to` | the adapter that runs it | `general-adapter1` |
| | `erc4626Withdraw.vault` | the vault | the card's `vault` |
| | `erc4626Withdraw.assets` | how much of the asset | the card's `amount` |
| | `erc4626Withdraw.minSharePriceE27` | slippage bound | free: the effects require exactly the amount in and some shares out |
| | `erc4626Withdraw.receiver` | who gets the asset | the Safe |
| | `erc4626Withdraw.owner` | whose shares are burned | the Safe |

Every call sends 0 ETH, the item has `skipRevert` false and a zero `callbackHash`, and both `approve` and `multicall` may carry the app's 8-byte trailer, as in `morpho/vault-deposit`. Effects: the Safe gets exactly `amount` of the vault's asset and gives a positive number of the vault's shares.

The price bound is free for the reason it is free in `morpho/vault-deposit`: the Safe's balance changes are checked instead. `positive` on what the Safe gives is new in this pull request. It means the Safe's balance falls; before, the engine read it as a rise.

## Past transactions

```sh
pnpm past-txs morpho/vault-withdraw --token hyperithm-usdc-apex-7777 --anchor burn --from-block 23700000 --to-block 24200000 --max-txs 3000
pnpm past-txs morpho/vault-withdraw --token smokehouse-usdc --anchor burn --from-block 22900000 --to-block 23700000 --max-txs 3000
pnpm past-txs morpho/vault-withdraw --token steakhouse-prime-usdc --anchor burn --from-block 26200000 --to-block 26380000 --max-txs 3000
```

Alchemy and Etherscan found the same transactions in every run.

| Vault | Share burns | By a Safe | Fit | Misfits |
| --- | --- | --- | --- | --- |
| Hyperithm USDC Apex (V1.1) | 1,302 | 47 from 22 Safes | 10 from 5 Safes | 37 from 20 Safes |
| Smokehouse USDC (V1.0) | 2,688 | 69 from 41 Safes | 21 from 8 Safes | 48 from 37 Safes |
| Steakhouse Prime USDC (V2) | 788 | 47 from 19 Safes | 0 | 47 from 19 Safes |

In all 31 fitting transactions, each bound field held its rule: receiver and owner were the Safe, the spender and the item target were GeneralAdapter1, `assets` was the amount, and every value was 0. The approved share count and the price bound differed in each.

What the misfits taught:

- **Redeems.** 11 from 11 Safes (Apex) and 24 from 21 Safes (Smokehouse) call `erc4626Redeem` instead. That is the app's withdrawal of all, `morpho/vault-withdraw-all`.
- **Several vaults.** 9 from 9 Safes in the Smokehouse range approve two to five vaults, one of them also USDC, and make one `multicall`. Two of them, recorded as `morpho-withdraw-two-vaults` and `morpho-withdraw-two-vaults-all`, give `MATCH` with a two-operation card. That shape is why the multicall merges.
- **No approval.** 13 from 4 Safes (Apex) and 7 from 7 Safes (Smokehouse) call `multicall` alone and spend an approval given earlier. The effects refuse an allowance that changes, so this shape is left out.
- **VaultBundlesV1.** In the 2026 Steakhouse Prime range, 40 of 47 withdrawals call `vaultBundlesV1Withdraw` (`0x932084a8`) on VaultBundlesV1, 26 from 9 Safes after a share approval and 14 from 7 Safes alone. This is the app's current withdrawal route and needs its own template. Its approval also exceeds what the withdrawal spends: in two of these transactions the allowance to VaultBundlesV1 was left at 579,714,261,143,678,117 and 289,809,315,668,967,425,412 shares.
- **Sweeps.** 4 from 4 Safes (Apex) and 1 (Smokehouse) add two `erc20Transfer` items after the withdrawal.
- **Migrations**, a redeem paid to GeneralAdapter1 and then a deposit into another vault, are not withdrawals and belong to a later template.

The tests record withdrawals from two other Safes, `morpho-withdraw-apex` and `morpho-withdraw-apex-other-safe`. Each gives `MATCH` with its implied card, and a mutation of each of its 13 bound fields gives `MISMATCH`. A receiver or owner that is not the Safe, or another amount, is a `MISMATCH` at that field.

## ERC-7730

From [LedgerHQ/clear-signing-erc7730-registry](https://github.com/LedgerHQ/clear-signing-erc7730-registry) at commit `3bebbd05cbc2d2d2bf9c41a8edbf5e5cc88e4eb4`:

- Bundler3: `registry/morpho/calldata-MorphoBundlerV3.json`, git blob `16d7e9b178dde2d9b14d9fc74e99beb845a4b393`. It describes `multicall` and `reenter` but not the adapter calls inside a bundle item, so it says nothing about `erc4626Withdraw`'s fields.
- GeneralAdapter1: no descriptor found.
- Usual Boosted USDC: `registry/morpho/calldata-mev_capital-USUALUSDC+.json`, blob `772b0e68a29dc034585d30f528b2075850ae0e2f`, a descriptor of the vault's own calls.

No ERC-8176 attestation was checked; the program does not verify attestations yet.

## Protocol health

- [Morpho's audits page](https://docs.morpho.org/get-started/resources/audits/) lists the vault audits named in `templates/morpho/vault-deposit/report.md`.
- DefiLlama's hacks data (`https://api.llama.fi/hacks`), read again for this pull request, still names one Morpho entry: "LeadBlock's Morpho Blue Market", 2024-10-14, $250,000, oracle misconfiguration in one market.
- A withdrawal needs the vault to hold enough withdrawable liquidity. In a V1.1 vault after bad debt, "the last vault users will face the bad debt unless action is taken" ([Morpho docs](https://docs.morpho.org/curate/tutorials-v1/bad-debt/)). The template checks that the Safe gets exactly the amount it asked for, not what its remaining shares are worth.
