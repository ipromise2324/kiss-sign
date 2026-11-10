# fluid/vault-deposit

The Safe deposits an amount of a Fluid fToken's asset into that fToken and gets fToken shares. The Fluid app sends it as a `delegatecall` to MultiSendCallOnly 1.4.1 with two calls: the asset's `approve(fToken, amount)`, then the fToken's ERC-4626 `deposit(amount, Safe)`.

This report also holds the research that `fluid/vault-withdraw` and `fluid/vault-redeem` share: the addresses, the ABI, ERC-7730, and protocol health.

## Addresses and ABI

| Name | Address | Asset | Etherscan | Created |
| --- | --- | --- | --- | --- |
| `fluid-fusdc` | `0x9Fb7b4477576Fe5B32be4C1843aFB1e55F251B33` | `usdc` | `fToken`, solc 0.8.21, no proxy | from `0x8e7fB4D4FAbC504a4AD73D44e09080CB68960098` through the CREATE3 deployer `0x6387a549cA11E6783d39978D409d2C7f4F437ea5`, transaction `0x3771681407c5f5d10c779a2bc685470c559652d83eb69d86b3af68ae7c6e0494`, block 19,247,609 |
| `fluid-fusdt` | `0x5C20B550819128074FD538Edf79791733ccEdd18` | `usdt` | `fToken`, solc 0.8.21, no proxy | from `0x5D0E457DF85d9F1042C4b884e3d6Ca9e89494E3B` through the CREATE3 deployer `0xF7e3B06f43Ca9AEC2962Ead512e46ff643329656`, transaction `0xb7a604f9de0d2c3aee3912cb4b46bee5e5a59744a2f80e3c670431e6bf8ab5cf`, block 19,247,666 |

Two official sources name both fTokens with these assets:

- [`deployments/deployments.md`](https://github.com/Instadapp/fluid-contracts-public/blob/main/deployments/deployments.md) on the default branch of Instadapp's `fluid-contracts-public` (commit `404d73f9`), sections `fToken_fUSDC` and `fToken_fUSDT`. Each row's constructor arguments are the Liquidity layer `0x52Aa899454998Be5b000Ad077a46Bbe360F4e497`, the LendingFactory `0x54B91A0D94cb471F37f949c60F7Fa7935b551D03`, and the asset.
- Fluid's API, `https://api.fluid.instadapp.io/v2/lending/1/tokens`, which the Fluid app reads, lists the same two addresses with the same assets.

On chain, read from Alchemy and drpc at block 26,384,745: the LendingFactory's `allTokens()` lists both, and each fToken's `asset()` returns USDC and USDT. Each creation transaction is a call from a Fluid deployer account to `0x46978CD477A496028A18c02F07ab7F35EDBa5A54`, and the contract that created each fToken is a per-token CREATE3 deployer, so Etherscan's creator is not the LendingFactory itself. `allTokens()` is the factory's own record that it made them.

`pnpm prove-abi` refuses both on `main` today: `solc 0.8.21+commit.d9974bed is not pinned in src/contracts/solc-pins.ts`. With that version pinned locally, at the sha256 `45bea352b41d04039e19439962ddef1d3e10cf2bc9526feba39f2cc79e3c5a17` that soliditylang's `bin/list.json` gives, both prove:

```
address        0x5C20B550819128074FD538Edf79791733ccEdd18
block          26384732
providers      alchemy, drpc
proxy          none
compiler       solc 0.8.21+commit.d9974bed
contract       contracts/protocols/lending/fToken/main.sol:fToken
functions      48
codeHash       0x662b760b02d5258965404cd8daca2c1ce5ef5567417cedec5a0acf895b775195
masked         38 immutable spans, 0 library spans

address        0x9Fb7b4477576Fe5B32be4C1843aFB1e55F251B33
block          26384736
providers      alchemy, drpc
proxy          none
compiler       solc 0.8.21+commit.d9974bed
contract       contracts/protocols/lending/fToken/main.sol:fToken
functions      48
codeHash       0x131b2014b67d86e5a1fcd6be7b6817b76ae9ac1663266f88366e526666297828
masked         38 immutable spans, 0 library spans
```

The proven ABI holds `deposit(uint256 assets_, address receiver_)`, `withdraw(uint256 assets_, address receiver_, address owner_)` and `redeem(uint256 shares_, address receiver_, address owner_)`, the three functions these templates call, next to overloads with a slippage argument that the Fluid app does not send. The pin itself, and the `record-abi-case` fixtures that need it, come with the 0.8.21 pin another pull request adds to `src/contracts/solc-pins.ts`.

`approve(address,uint256)` on USDC and USDT is taken from EIP-20, as in `templates/erc20/transfer/report.md`, since neither token's ABI proves today. USDT's `approve` returns no value. The calldata is the same, the template checks only calldata, and the effects check reads the allowance with `allowance(address,address)`, which USDT does return.

## Fields

| Call | Field | Meaning | Rule |
| --- | --- | --- | --- |
| `multiSend[0]` | `to` | the asset token | the card vault's `asset` |
| | `value` | ETH sent | 0 |
| | `approve.spender` | who may pull the asset | the card's `vault` |
| | `approve.value` | how much | the card's `amount` |
| `multiSend[1]` | `to` | the fToken | the card's `vault` |
| | `value` | ETH sent | 0 |
| | `deposit.assets` | the asset amount deposited | the card's `amount` |
| | `deposit.receiver` | who gets the shares | the Safe |

Card: `vault` (a registry `vault`) and `amount` (`of: vault.asset`). Effects: the Safe gives exactly `amount` of the asset and gets a positive amount of the fToken. The allowance may not end higher than it started, so the approval is exact and spent in full. USDT's own `approve` refuses to change a non-zero allowance to another non-zero one, and an exact approval spent in full leaves it at 0, so the next deposit can approve again.

The template accepts any registry entry of kind `vault`. Its shape is the plain ERC-4626 deposit, so a card that names a Morpho vault with this template checks a direct deposit into that vault, which the Morpho app does not send. The registry, not the template, limits which vaults a card can name.

## Past transactions

```sh
pnpm past-txs fluid/vault-deposit --token fluid-fusdt --anchor mint --from-block 26234000 --to-block 26384000 --max-txs 3000
pnpm past-txs fluid/vault-deposit --token fluid-fusdc --anchor mint --from-block 26234000 --to-block 26384000 --max-txs 3000
```

| Anchor | Alchemy, Etherscan, both | Executed by a Safe | Fit | Unreadable |
| --- | --- | --- | --- | --- |
| fUSDT minted | 307, 307, 307 | 1 from 1 Safe | 1 from 1 Safe | 94 |
| fUSDC minted | 791, 791, 791 | 4 from 3 Safes | 3 from 2 Safes | 447 |

Almost every fToken deposit comes from an EOA calling `deposit` directly (170 of fUSDT's, 227 of fUSDC's) or from a smart account (`0xe9ae5c53`). A transaction is unreadable when drpc's public endpoint rate-limited the read, so every Safe count is a lower bound. Ten Safes did not fit in this range; widening it made drpc refuse more reads rather than find more Safes.

Over the 4 fitting transactions every rule held in 4 of 4: the approval's token was the vault's asset, the spender and the deposit target were the same vault, the two amounts were equal, and the receiver was the Safe. Two of the fUSDC fits deposit into another ERC-4626 vault that itself holds fUSDC. That shows the shape is generic and the card's vault is what decides. The one misfit, from 1 Safe, calls `deposit` on another contract after the approval.

The Safes' own histories, read from the Safe Transaction Service, add more of the same shape, all with the Fluid app as origin: the Safe of `fluid-deposit-usdt` made this two-call deposit five times (USDT and USDC, nonces 87 to 152), and the Safe of `fluid-deposit-usdt-other-safe` twice.

The tests record three deposits from two Safes: `fluid-deposit-usdt` and `fluid-deposit-usdc` from one Safe, `fluid-deposit-usdt-other-safe` from another. Each gives `MATCH` with its implied card, and a mutation of each of its 8 bound fields gives `MISMATCH`. So do another receiver, another amount, a card naming the other fToken, and an approval left open. The USDT deposit is simulated on its parent block and read from its receipt: the Safe gives exactly the card amount of USDT, gets fUSDT, and its USDT allowance to fUSDT is 0 before and after.

## ERC-7730

- No Fluid descriptor exists in [LedgerHQ/clear-signing-erc7730-registry](https://github.com/LedgerHQ/clear-signing-erc7730-registry/tree/8e484f1dee742fa93e5a680c362c6693d0cf7e01) at commit `8e484f1d`, and neither fToken address appears in it.
- The generic [`ercs/calldata-erc4626-vaults.json`](https://github.com/LedgerHQ/clear-signing-erc7730-registry/blob/8e484f1dee742fa93e5a680c362c6693d0cf7e01/ercs/calldata-erc4626-vaults.json) (blob `4e115826c9aa4513d3b7381eb5c19aee66b626a0`) shows `deposit(uint256 assets, address receiver)` as "Deposit", with `assets` an amount of the underlying token and `receiver` "Send shares to". It shows `withdraw` (`assets` "Withdraw exactly", `receiver` "To", `owner` "Owner") and `redeem` (`shares` "Shares to redeem", `receiver`, `owner`) the same way. These agree with the three templates.
- `approve(_spender, _value)` is "Approve" with spender and amount in `registry/tether/calldata-usdt.json` (blob `2753fcdee6c3459cb6afd62add5ff550c14b469c`) and in `ercs/calldata-erc20-tokens.json` (blob `ba93f5d423f04c9a2a230cb0ff96c3dad4bd0e5a`).

No ERC-8176 attestation was checked; the program does not verify attestations yet.

## Protocol health

- fTokens are not proxies (`prove-abi`: proxy none). They keep their funds in the Liquidity layer `0x52Aa899454998Be5b000Ad077a46Bbe360F4e497`, an upgradeable proxy. Yearn's curation report (latest version 29 September 2026) says a Timelock with a 1-day delay, administered by GovernorBravo, upgrades the Liquidity layer, and that the LendingFactory's owner is that Timelock ([Yearn curation: Fluid](https://curation.yearn.fi/report/fluid/)).
- Audits: Fluid lists MixBytes and Statemind audits of the Liquidity layer ([Fluid: audits and security](https://docs.fluid.instadapp.io/audits-and-security.html)). Yearn's report lists PeckShield (November 2023) and StateMind (October to December 2023) audits of the Lending protocol.
- Incidents: DefiLlama's hack list ([api.llama.fi/hacks](https://api.llama.fi/hacks), entry "Fluid Lending", 31 May 2026) records $215,000 taken after operational keys of Fluid's Merkle rewards distribution were compromised, and says core contracts, lending markets and deposits were not affected. Yearn's report says the Resolv USR exploit in 2026 left an estimated $10 to 17.5M of bad debt in Fluid lending markets, covered in full, with "no direct loss to fToken holders", and that Fluid froze its rsETH markets after the KelpDAO incident although "Fluid contracts were not exploited".
- Deposits and withdrawals do not touch the Merkle rewards distributor. Claiming Fluid rewards needs its own template.

None of this changes a verdict. A deposit that does not give exactly the card amount, gets no shares, or leaves the approval open is `MISMATCH`.
