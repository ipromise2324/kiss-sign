# morpho/vault-deposit

The Safe deposits an amount of a Morpho vault's asset into that vault, the way the Morpho app builds it: one official MultiSend with two calls. The first approves GeneralAdapter1 for exactly the amount. The second is `Bundler3.multicall` with two bundle items: GeneralAdapter1 pulls the amount from the Safe (`erc20TransferFrom`), then deposits it into the vault with the shares going to the Safe (`erc4626Deposit`).

## Addresses and ABI

Every address below is on [Morpho's addresses page](https://docs.morpho.org/get-started/resources/addresses/) or, for a vault, on its page in the Morpho app, and every ABI is proven with `pnpm prove-abi`: Sourcify's source, compiled with a pinned solc, gives the code both providers read, apart from immutables.

| Name | Address | Kind | `pnpm prove-abi` | Deployed |
| --- | --- | --- | --- | --- |
| `bundler3` | `0x6566194141eefa99Af43Bb5Aa71460Ca2Dc90245` | router | `Bundler3`, solc 0.8.28 | |
| `general-adapter1` | `0x4A6c312ec70E8747a587EE860a0353cd42Be0aE0` | adapter | `EthereumGeneralAdapter1`, solc 0.8.28, 58 immutable spans | |
| `metamorpho-factory-1.0` | `0xA9c3D3a366466Fa809d1Ae982Fb2c46E5fC41101` | factory | `MetaMorphoFactory`, solc 0.8.21, code hash `0x948cb0a2…` | transaction `0x05504ab1f9d86603298083de89f7a07e3be7633e354c78a626a11f06ad71efca`, block 18,925,584 |
| `metamorpho-factory-1.1` | `0x1897A8997241C1cD4bD0698647e4EB7213535c24` | factory | `MetaMorphoV1_1Factory`, solc 0.8.26, code hash `0xc96dffc1…` | block 21,439,510 |
| `vault-v2-factory` | `0xA1D94F746dEfa1928926b84fB2596c06926C0405` | factory | `VaultV2Factory`, solc 0.8.28 | |
| `steakhouse-prime-usdc` | `0xbeef088055857739C12CD3765F20b7679Def0f51` | vault, Vault V2 | `VaultV2`, solc 0.8.28, 12 immutable spans, code hash `0xb8726444…` | transaction `0x2ef63f2d9490f3c264cf5c4b0f0040a6a4c56866e026ac45f9fef835298a70cf`, block 23,671,611 |
| `hyperithm-usdc-apex-0932` | `0x093272C07700d3cA5301C3Bf9B3A392624179E2F` | vault, Vault V2 | `VaultV2`, solc 0.8.28, 12 immutable spans, code hash `0xb8726444…`, the same code as Steakhouse Prime USDC | transaction `0xc686b128ceefbc78ba7dda6200bb2cad696709c9b7a54d1d753a5956b456f3ce`, block 23,666,454 |
| `hyperithm-usdc-apex-7777` | `0x777791C4d6DC2CE140D00D2828a7C93503c67777` | vault, MetaMorpho V1.1 | `MetaMorphoV1_1`, solc 0.8.26, 32 immutable spans | transaction `0x6dcd3af9b7c89074587992c87228a6abf41285693eae23144d5ac758ae55fae5`, block 21,922,190 |
| `smokehouse-usdc` | `0xBEeFFF209270748ddd194831b3fa287a5386f5bC` | vault, MetaMorpho V1.0 | `MetaMorpho`, solc 0.8.21, 32 immutable spans | transaction `0x0dde7ee342df098f10ad1c69410c32bd73047ec2b28907a51908e9145f7137f7`, block 21,337,719 |

The addresses page lists MetaMorpho Factory V1.1, VaultV2Factory, and the V1.0 factory as "MetaMorpho Factory [OLD]". Each factory's proven source keeps a `mapping(address => bool)` (`isMetaMorpho`, or `isVaultV2`) that it sets in one place, right after it deploys a vault. Each vault names its factory in the registry, and `pnpm prove-instance <vault>` read that flag as true from both providers for all four vaults.

Two Morpho vaults are called Hyperithm USDC Apex: a MetaMorpho V1.1 vault and a Vault V2 vault. Their registry names end in the first or last four characters of their addresses, so a card names one of them, never "Apex" alone.

Hyperithm USDC Apex (V2) was refused by `prove-abi` until this pull request. Sourcify's record was submitted with `bytecodeHash: "ipfs"`, which adds a 41-byte IPFS entry to the metadata trailer, while the code on chain ends in the 12-byte trailer `bytecodeHash: "none"` writes. `prove-abi` now compiles without the hash when the code on chain carries none, and compares every byte. With no hash on chain, the bytecode proves the ABI's selectors and types, not its parameter names (see Known limits in `docs/design.md`).

## Fields

| Call | Field | Meaning | Rule |
| --- | --- | --- | --- |
| `multiSend[0]` | `to` | the asset token | the card vault's `asset` |
| | `approve.spender` | who may pull the asset | `general-adapter1` |
| | `approve.value` | how much | the card's `amount` |
| `multiSend[1]` | `to` | Bundler3 | `bundler3` |
| bundle[0] | `to` | the adapter that runs it | `general-adapter1` |
| | `erc20TransferFrom.token`, `.receiver`, `.amount` | pull the asset from the Safe into the adapter | the vault's `asset`, `general-adapter1`, the card's `amount` |
| bundle[1] | `to` | the adapter | `general-adapter1` |
| | `erc4626Deposit.vault` | the vault | the card's `vault` |
| | `erc4626Deposit.assets` | how much | the card's `amount` |
| | `erc4626Deposit.maxSharePriceE27` | slippage bound | free: the simulation checks the shares the Safe receives |
| | `erc4626Deposit.receiver` | who gets the shares | the Safe |

Every call sends 0 ETH, and every bundle item has `skipRevert` false and a zero `callbackHash`. Effects: the Safe gives exactly `amount` of the asset and gets a positive amount of the vault's shares; the allowance may not end higher than it started, so the approval is spent in full.

Both `approve` and `multicall` may carry a trailer of up to 8 bytes. The Morpho app appends a 4-byte timestamp and the 4-byte origin tag `25afea44` (morpho-org/sdks, `addTransactionMetadata`). Neither function reads past its arguments. The app added it to `approve` too by late 2025: the fitting deposits into the V1.1 Apex vault below carry it.

## Past transactions

```sh
pnpm past-txs morpho/vault-deposit --token smokehouse-usdc --anchor mint --from-block 22900000 --to-block 23100000 --max-txs 3000
pnpm past-txs morpho/vault-deposit --token hyperithm-usdc-apex-7777 --anchor mint --from-block 23700000 --to-block 24200000 --max-txs 3000
pnpm past-txs morpho/vault-deposit --token steakhouse-prime-usdc --anchor mint --from-block 26200000 --to-block 26380000 --max-txs 3000
pnpm past-txs morpho/vault-deposit --token hyperithm-usdc-apex-0932 --anchor mint --from-block 25500000 --to-block 26380000 --max-txs 3000
```

Alchemy and Etherscan found the same transactions in every run, and none was unreadable.

| Vault | Share mints | By a Safe | Fit | Misfits |
| --- | --- | --- | --- | --- |
| Smokehouse USDC (V1.0) | 555 | 17 from 14 Safes | 14 from 11 Safes | 3 from 3 Safes |
| Hyperithm USDC Apex (V1.1) | 1,980 | 56 from 25 Safes | 4 from 4 Safes | 52 from 24 Safes |
| Steakhouse Prime USDC (V2) | 893 | 46 from 14 Safes | 0 | 46 from 14 Safes |
| Hyperithm USDC Apex (V2) | 2,779 | 3 from 2 Safes | 0 | 3 from 2 Safes |

In every fitting transaction, each bound field held its rule: the receiver was the Safe, the spender and both bundle targets were GeneralAdapter1, the amount was the same in its four places, and every value was 0. `maxSharePriceE27` held a different value in each.

What the misfits taught:

- **VaultBundlesV1.** In the recent Steakhouse Prime range, 34 deposits from 12 Safes call `vaultBundlesV1Deposit` (`0x6bbba4e0`) on Morpho's VaultBundlesV1 (`0x02912516d49dE997db75B9D7858faAE59209650B`), alone or after a USDC `approve`. That is the Morpho app's current deposit route, a different call tree, which `morpho/vault-bundles-deposit` covers. This template does not accept it.
- **One bundle item.** 21 from 13 Safes into Apex V1.1 run Bundler3 with a single item, such as `erc4626Redeem`: other operations, not deposits.
- **Three items.** 4 from 4 Safes run `erc4626Redeem` and then two `erc20Transfer` items: withdrawals that sweep leftovers back to the Safe.
- **Four items.** 1 from 1 Safe deposits and then sweeps, with `erc20Transfer(asset, Safe, 2^256-1)` and `erc20Transfer(vault, Safe, 2^256-1)` after the deposit. The template stays at exactly two items. One Safe in 56 is not normal use, and accepting optional items would change the template language.
- **Nine items.** 1 Safe deposits into eight vaults in one bundle.
- **No MultiSend.** 3 from 3 Safes into Smokehouse USDC, and 2 from 2 Safes into Apex V2, call `Bundler3.multicall` directly, with the approval given earlier. The approval is then not spent in the same transaction, which the effects rule refuses, so this shape is left out.
- Apex V2 is mostly reached through its own `multicall` (`0xac9650d8`, 2,307 of 2,779 mints), from EOAs and contracts. Only 3 deposits in that range came from Safes, none through a MultiSend.

The tests record four deposits from four other Safes: two into Smokehouse USDC (V1.0, `morpho-deposit-metamorpho-1-0` and `-other-safe`), and two into Hyperithm USDC Apex V1.1 with the `approve` trailer (`morpho-deposit-approve-trailer` and `-other-safe`). With `morpho-vault-deposit` (Steakhouse Prime USDC, Vault V2), each gives `MATCH` with its implied card, and a mutation of each of its 20 bound fields gives `MISMATCH`. Without the `approve` trailer allowance, both trailer fixtures fail at `canonical approve(address,uint256)`.

## ERC-7730

From [LedgerHQ/clear-signing-erc7730-registry](https://github.com/LedgerHQ/clear-signing-erc7730-registry) at commit `8e484f1dee742fa93e5a680c362c6693d0cf7e01`:

- Hyperithm USDC Apex V2: `registry/morpho/calldata-hyperithm-hyperUSDCa-v2-1.json`, git blob `7c9ff07233e8bb0c094f0c939c956e9c558c843f`, which includes `common-VaultV2.json` (blob `4e89e9c7d81d90a39f91885636fa5dea033bbed1`). It shows the vault's own `deposit(uint256 assets, address receiver)` as "Deposit asset" and "Send shares to", which agrees with `erc4626Deposit.assets` and `.receiver` here.
- Smokehouse USDC: `registry/morpho/calldata-steakhouse_financial-bbqUSDC.json`, blob `d2242761c419a83de14b1dc9d4531f195cdd44f0`, which includes the generic ERC-4626 descriptor.
- Steakhouse Prime USDC: `registry/morpho/calldata-steakhouse_financial-steakUSDC-v2-1.json`, blob `90ba906aba1c66f11c619d8e20bc1f7a30566c91`.
- Hyperithm USDC Apex V1.1, the factories, Bundler3 and GeneralAdapter1: no descriptor found. The registry describes `VaultBundlesV1`, not this route.

The descriptors describe a direct call to the vault, while this template's deposit goes through GeneralAdapter1, so they are a second opinion on what `assets` and `receiver` mean, not on this call tree. No ERC-8176 attestation was checked; the program does not verify attestations yet.

## Protocol health

- [Morpho's audits page](https://docs.morpho.org/get-started/resources/audits/) lists, for MetaMorpho V1.0, a Cantina contest and Spearbit and OpenZeppelin reviews (2023); for V1.1, Spearbit and OpenZeppelin (2024); for Vault V2, Spearbit, ChainSecurity, Blackthorn, Zellic and a Cantina contest (2025).
- DefiLlama's hacks data (`https://api.llama.fi/hacks`) names one Morpho entry: "LeadBlock's Morpho Blue Market", 2024-10-14, $250,000, oracle misconfiguration in one market.
- Losses in Morpho vaults come from the markets a curator allocates to, not from the vault contracts. In March 2026, Morpho's co-founder said about 15 of some 500 vaults had material exposure to the Resolv incident, all of them high-risk vaults with long-tail collateral ([KuCoin News](https://www.kucoin.com/news/flash/morpho-co-founder-15-vaults-affected-by-resolv-security-incident)).
- Bad debt behaves differently by version ([Morpho docs](https://docs.morpho.org/curate/tutorials-v1/bad-debt/)): a V1.0 vault realizes a loss on all depositors at once, while in a V1.1 vault the share price does not fall and "the last vault users will face the bad debt unless action is taken".

What a vault holds and who curates it changes over time. The template checks the shares the Safe receives, not what the vault is worth.
