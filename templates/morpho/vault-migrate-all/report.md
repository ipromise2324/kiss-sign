# morpho/vault-migrate-all

The Safe moves all of its shares of one Morpho vault into another vault of the same asset, the way the Morpho app builds a migration through Bundler3: one official MultiSend with two calls. The first approves GeneralAdapter1 to spend the Safe's shares of the old vault. The second is `Bundler3.multicall` with three items, all run by GeneralAdapter1:

1. `erc20TransferFrom` moves the Safe's shares of the old vault to GeneralAdapter1.
2. `erc4626Redeem` redeems every share of the old vault GeneralAdapter1 holds (`shares = 2^256-1`), owner and receiver GeneralAdapter1.
3. `erc4626Deposit` deposits every unit of the new vault's asset GeneralAdapter1 holds (`assets = 2^256-1`) into the new vault, shares to the Safe.

The card is `from` and `to`, two vaults.

## Both vaults must hold the same asset

The template says `"same": ["from.asset", "to.asset"]`, and a card whose two vaults have different assets is refused before any check runs: `card seal` will not seal it and `verify` stops on it.

Without that, a wrong `MATCH` is possible. With different assets, the redeem leaves the old vault's asset in GeneralAdapter1, and the deposit of "all GeneralAdapter1 holds" of the new vault's asset finds only what someone else left there. GeneralAdapter1's `erc4626Deposit` reverts on zero (`require(assets != 0, ErrorsLib.ZeroAmount())`), but any dust of the new asset in the adapter makes it succeed. The Safe would then give all its old shares and get a positive number of new ones, which the effects accept, while the redeemed asset sits in the adapter for anyone to take. No field of the transaction names either asset, so only a rule on the card can stop it. `same` is new in this pull request (`docs/design.md`, Data shapes).

## How "all" is bound

As in `morpho/vault-withdraw-all`: the share count is free in `approve.value` and `erc20TransferFrom.amount`, and the effects require the Safe to hold no shares of `from` afterwards and the allowance not to end higher than it started. The redeem and the deposit are bound to the constant 2^256-1, GeneralAdapter1's "everything this adapter holds" (proven source of GeneralAdapter1, `erc4626Redeem` and `erc4626Deposit`), so no asset can stay in the adapter between them.

## Addresses and ABI

Bundler3, GeneralAdapter1, the factories and the other vaults are proven in `templates/morpho/vault-deposit/report.md`, and the proven GeneralAdapter1 ABI names all three functions. This pull request adds the vault the studied migrations went to:

| Name | Address | Kind | `pnpm prove-abi` | `pnpm prove-instance` |
| --- | --- | --- | --- | --- |
| `steakhouse-high-yield-usdc` | `0xbeeff2C5bF38f90e3482a8b19F12E5a6D2FCa757` | vault, Morpho Vault V2 | `VaultV2`, solc 0.8.28, no proxy, 12 immutable spans, code hash `0xb8726444…` | `isVaultV2` true on `vault-v2-factory` from Alchemy and drpc |

Its name on chain is "Steakhouse High Yield USDC" and `asset()` is USDC.

## Fields

| Call | Field | Meaning | Rule |
| --- | --- | --- | --- |
| `multiSend[0]` | `to` | the old vault, whose shares are approved | the card's `from` |
| | `approve.spender` | who may spend the shares | `general-adapter1` |
| | `approve.value` | how many shares | free: the effects require the allowance to end where it started and no shares left |
| `multiSend[1]` | `to` | Bundler3 | `bundler3` |
| item 0 | `erc20TransferFrom.token` | the old vault's shares | the card's `from` |
| | `erc20TransferFrom.receiver` | where they go | `general-adapter1` |
| | `erc20TransferFrom.amount` | how many | free: the effects require the Safe to hold none afterwards |
| item 1 | `erc4626Redeem.vault` | the old vault | the card's `from` |
| | `erc4626Redeem.shares` | how many | 2^256-1, all the adapter holds |
| | `erc4626Redeem.minSharePriceE27` | slippage bound | free |
| | `erc4626Redeem.receiver`, `owner` | who gets the asset, whose shares | `general-adapter1` |
| item 2 | `erc4626Deposit.vault` | the new vault | the card's `to` |
| | `erc4626Deposit.assets` | how much | 2^256-1, all the adapter holds |
| | `erc4626Deposit.maxSharePriceE27` | slippage bound | free |
| | `erc4626Deposit.receiver` | who gets the new shares | the Safe |

Every item targets GeneralAdapter1, sends 0 ETH, has `skipRevert` false and a zero `callbackHash`; `approve` and `multicall` may carry the app's 8-byte trailer. Effects: the Safe gives all of `from` and gets a positive number of `to` shares. Both price bounds are free, as in the deposit and withdrawal templates: the new shares are not on the card, so only "more than nothing" is checked.

## A leftover share allowance

A Safe that withdrew an amount from the old vault through the Morpho app before still holds the part of that approval the withdrawal did not burn (see `templates/morpho/vault-withdraw/report.md`). The migration's approval overwrites it with the share balance and spends it to 0, so the allowance ends lower than it started. The effects check accepts that: a lower allowance lets no one take more from the Safe than before (`docs/design.md`).

## Past transactions

Safe migrations through Bundler3 are rare, so the study anchors on the old vault's shares burned:

```sh
pnpm past-txs morpho/vault-migrate-all --token smokehouse-usdc --anchor burn --from-block 25000000 --to-block 25950000 --max-txs 3000
```

Alchemy and Etherscan both found the same 1,518 burns. 28 were executed by 21 Safes; **6 transactions from 6 Safes fit**, all from Smokehouse USDC into Steakhouse High Yield USDC. In all 6, every bound field held its rule: the approval and every item went to GeneralAdapter1, the redeem's owner and receiver were GeneralAdapter1, both the redeem's shares and the deposit's assets were 2^256-1, the deposit's receiver was the Safe, and every value was 0. The misfits are other operations: withdrawals through other GeneralAdapter1 functions (6 from 6 Safes, a different first item), direct vault calls, and other contracts.

The candidates were first found by listing, with Etherscan's `tokentx`, the vault shares GeneralAdapter1 burned and keeping the transactions that call `execTransaction`. That also found two migrations from Hyperithm USDC Apex into Hyperithm USDC Apex (V2) by two other Safes that make only the `multicall`, with no approval in the same transaction: they spend an approval given earlier. They do not fit this template, which keeps the approval in the transaction as the design asks.

`pnpm simulate` ran both recorded migrations, `morpho-migrate-all-smokehouse` and `morpho-migrate-all-smokehouse-other-safe`. Both left the Safe holding no Smokehouse shares and gave it Steakhouse High Yield shares. The second gives `MATCH`. The first gives `MISMATCH` only because its share allowance to GeneralAdapter1 went from 60,953,196,422,022,121 to 0: the leftover described above.

The tests require `MATCH` from the field checks for both, a mutation of each of the 26 bound fields to give `MISMATCH`, a new-shares receiver other than the Safe to give `MISMATCH` at that field, and a card with vaults of different assets to be refused.

## ERC-7730

As in `templates/morpho/vault-withdraw/report.md`: the Bundler3 descriptor does not describe the adapter's calls, and GeneralAdapter1 has none.

## Protocol health

See `templates/morpho/vault-withdraw/report.md`.
