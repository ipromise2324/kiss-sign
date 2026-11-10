# morpho/vault-withdraw-all

The Safe withdraws all of its shares of a Morpho vault, the way the Morpho app's "max" withdrawal builds it through Bundler3: one official MultiSend with two calls. The first approves GeneralAdapter1 to spend the Safe's shares. The second is `Bundler3.multicall` with one bundle item: GeneralAdapter1 calls `erc4626Redeem` for the Safe's whole share balance and pays the asset to the Safe.

The card is the vault alone. This template is the "all" of the design's "amount or all"; `morpho/vault-withdraw` is the amount. Like that template, the multicall is marked `merge`, so a card with a withdrawal from each of several vaults matches the app's single multicall.

## How "all" is bound

The share count is not on the card. The app reads the Safe's balance when it builds the transaction and writes it into both `approve.value` and `erc4626Redeem.shares`. The template leaves both free and binds "all" through the effects instead: the Safe gives `all` of the vault's shares, which means it holds none of them after the transaction, and the allowance may not end higher than it started.

That covers every way the two numbers can be wrong:

- fewer shares than the balance leave shares behind: `MISMATCH`, "still held … after the transaction";
- an approval larger than the shares redeemed leaves the allowance higher than it started: `MISMATCH`;
- more shares than the balance, or than the approval, revert: `UNVERIFIABLE`.

`all` is new in this pull request. The simulation reads the Safe's balance of each such token right after the transaction. For an executed transaction the program reads it at the parent block and at the end of the execution block, and the verdict is `UNVERIFIABLE` unless the two differ by exactly this transaction's change. Only an earlier transaction in that block that adds exactly what a later one removes goes unnoticed; see Known limits in `docs/design.md`. A card that names a token in `all` and again in another effect cannot be judged and is `UNVERIFIABLE`.

GeneralAdapter1 also takes `type(uint256).max` as "the owner's whole balance". The app does not use it, so binding `shares` to that constant would refuse every past withdrawal.

## Addresses and ABI

See `templates/morpho/vault-withdraw/report.md`. The proven GeneralAdapter1 ABI names `erc4626Redeem(address vault, uint256 shares, uint256 minSharePriceE27, address receiver, address owner)`.

## Fields

| Call | Field | Meaning | Rule |
| --- | --- | --- | --- |
| `multiSend[0]` | `to` | the vault, whose shares are approved | the card's `vault` |
| | `approve.spender` | who may spend the shares | `general-adapter1` |
| | `approve.value` | how many shares | free: the effects require the allowance to end no higher than it started and no shares left |
| `multiSend[1]` | `to` | Bundler3 | `bundler3` |
| bundle item | `to` | the adapter that runs it | `general-adapter1` |
| | `erc4626Redeem.vault` | the vault | the card's `vault` |
| | `erc4626Redeem.shares` | how many shares | free: the effects require the Safe to hold none afterwards |
| | `erc4626Redeem.minSharePriceE27` | slippage bound | free: the effects require a positive amount of the asset in |
| | `erc4626Redeem.receiver` | who gets the asset | the Safe |
| | `erc4626Redeem.owner` | whose shares are redeemed | the Safe |

Every call sends 0 ETH, the item has `skipRevert` false and a zero `callbackHash`, and both `approve` and `multicall` may carry the app's 8-byte trailer. Effects: the Safe gives all of the vault's shares and gets a positive amount of the vault's asset.

The price bound is free as in the deposit: the amount received is not on the card, so only "more than nothing" is checked. A redeem at a price far below the vault's is caught by neither the fields nor the effects. That is the risk `morpho/vault-deposit` accepts for its price bound: the vault is a registered contract the signer chose.

## Past transactions

```sh
pnpm past-txs morpho/vault-withdraw-all --token hyperithm-usdc-apex-7777 --anchor burn --from-block 23700000 --to-block 24200000 --max-txs 3000
pnpm past-txs morpho/vault-withdraw-all --token smokehouse-usdc --anchor burn --from-block 22900000 --to-block 23700000 --max-txs 3000
```

Alchemy and Etherscan found the same transactions in both runs. In the Smokehouse run, 4 transactions could not be read because drpc rate-limited the request.

| Vault | Share burns | By a Safe | Fit | Misfits |
| --- | --- | --- | --- | --- |
| Hyperithm USDC Apex (V1.1) | 1,302 | 47 from 22 Safes | 11 from 11 Safes | 36 from 15 Safes |
| Smokehouse USDC (V1.0) | 2,688 | 69 from 41 Safes | 24 from 21 Safes | 45 from 25 Safes |

In all 35 fitting transactions, each bound field held its rule: receiver and owner were the Safe, the spender and the item target were GeneralAdapter1, and every value was 0. The study checks the call shape, not that the shares were the Safe's whole balance; the effects check that at signing. The misfits are the shapes `morpho/vault-withdraw/report.md` lists: withdrawals of an amount, several vaults in one multicall, a multicall without an approval, sweeps, and other contracts.

`pnpm simulate` ran both recorded withdrawals and the two-vault one. In each, the approval equalled the shares redeemed, the allowance ended at 0, and the Safe held no shares afterwards, so the effects gave `MATCH` both simulated and from the receipt.

The tests record two withdrawals from other Safes, `morpho-withdraw-all-apex` and `morpho-withdraw-all-apex-other-safe`, and `morpho-withdraw-two-vaults-all`, which redeems all of Smokehouse USDC and Usual Boosted USDC in one multicall. Each gives `MATCH` with its implied card, and a mutation of each of its bound fields gives `MISMATCH`.

## ERC-7730

As in `templates/morpho/vault-withdraw/report.md`: the Bundler3 descriptor does not describe the adapter's calls, and GeneralAdapter1 has none.

## Protocol health

See `templates/morpho/vault-withdraw/report.md`.
