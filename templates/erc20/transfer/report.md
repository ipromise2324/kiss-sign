# erc20/transfer

The Safe sends an amount of one registered ERC-20 token to one recipient: a direct call to the token's `transfer(address,uint256)`.

## Addresses and ABI

| Name | Address | Source | Etherscan | Creator |
| --- | --- | --- | --- | --- |
| `usdc` | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | [Circle: USDC contract addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses) | `FiatTokenProxy`, solc 0.4.24, implementation `0x43506849D7C04F9138D1A2050bbF3A0c054402dd` | `0x95Ba4cF87D6723ad9C0Db21737D862bE80e93911`, creation transaction `0xe7e0fe390354509cd08c9a0168536938600ddc552b3f7cb96030ebef62e75895`, block 6,082,465 |
| `usdt` | `0xdAC17F958D2ee523a2206206994597C13D831ec7` | [Tether: supported protocols](https://tether.to/en/supported-protocols/) | `TetherToken`, solc 0.4.18, no proxy | `0x36928500Bc1dCd7af6a2B4008875CC336b927D57`, creation transaction `0x2f1c5c2b44f771e942a8506148e256f94f1a464babc938ae0690c6e34cd79190`, block 4,634,748 |

Both issuers' pages name these addresses, and the ERC-7730 registry's Tether descriptor names the same USDT address.

`pnpm prove-abi` refused both when this template was written; USDC now proves:

- USDC: `REFUSED 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 at block 26384474: solc 0.4.24+commit.e67f0147 is not pinned in src/contracts/solc-pins.ts`. The proxy keeps its implementation in the ZeppelinOS slot (`keccak256("org.zeppelinos.proxy.implementation")`), which `prove-abi` did not follow then. It follows that slot now, and with solc 0.6.12 pinned it proves the implementation `FiatTokenV2_2` at `0x43506849D7C04F9138D1A2050bbF3A0c054402dd` (block 26392598), a Sourcify partial match with the metadata hash masked.
- USDT: `REFUSED 0xdAC17F958D2ee523a2206206994597C13D831ec7 at block 26384587: solc 0.4.18+commit.9cf6e910 is not pinned in src/contracts/solc-pins.ts`. There is no proxy.

So the one function this template calls, `transfer(address,uint256)` with selector `0xa9059cbb`, is taken from EIP-20 rather than from a proven ABI. Both verified sources on Etherscan declare it, and the decoder refuses any other selector. Proving these ABIs needs 0.4 compilers pinned and loaded, and the ZeppelinOS slot followed, which belong in their own pull request.

## Fields

| Field | Meaning | Rule |
| --- | --- | --- |
| `to` | The token contract | the card's `token`, a registry entry of kind `token` |
| `value` | ETH sent with the call | 0 |
| `transfer.to` | Who receives the tokens | the card's `recipient` |
| `transfer.value` | How many, in base units | the card's `amount` |

Card: `token`, `amount` (`of: token`) and `recipient` (`safe` or an address-book name). Effects: the Safe gives exactly `amount` of `token` to `recipient`, and gets nothing. When the recipient is `safe`, the Safe's balance must not change at all. The engine reads the token's balance change from the receipt's `Transfer` logs or from the simulation, so a token that takes a fee from the sender, or moves more than `amount`, gives `MISMATCH`.

Several transfers in one transaction go through an official MultiSend, one card operation per call, in card order. The engine unwraps an official MultiSend for every template, so a single transfer wrapped in a MultiSend also matches a one-operation card. Batches of transfers are in normal use: the search below found one Safe sending two `transfer` calls in one MultiSend, and the Safe of `testdata/safe-tx/eth-transfer-null-data.json` once sent 66 in one (its nonce 17).

## Past transactions

USDC and USDT move tens of transfers per block, almost all from other contracts and EOAs, so a search anchored on them studies thousands of transactions for a few Safes (one trial over 30 blocks of USDC found 1,514 transactions). The template's shape does not depend on the token, so the search is anchored on the SAFE token (`0x5aFE3855358E112B5647B952709E6165e1c1eEEe`), which Safes move often:

```sh
pnpm past-txs erc20/transfer --token 0x5aFE3855358E112B5647B952709E6165e1c1eEEe --anchor any \
  --from-block 26330000 --to-block 26380000 --max-txs 3500
```

- Sources: Alchemy and Etherscan each found 3,123 transactions, the same 3,123.
- Executed by a Safe through `execTransaction`: 213, from 130 Safes. 1,810 were not Safe transactions. 1,100 were unreadable, because drpc's public endpoint rate-limited the run, so the Safe counts are a lower bound.
- Fit the template's shape: 80 transactions from 79 Safes.
- Fields over the 80: the call target equalled the card's token (the anchor token) in 80 of 80; the ETH value was 0 in 80 of 80 (79 Safes); `transfer.to` was another address in 80, 20 distinct; `transfer.value` held 80 distinct amounts. No transfer went to the Safe itself.
- Misfits: 133 from 126 Safes. Almost all are other operations that also move the token, such as 76 from 75 Safes calling `0x166bbd3b` twice, and 39 from 39 Safes calling `0x1d7d4ebc`, `approve`, then `0xadc9772e`. One Safe sent two `transfer` calls in one MultiSend, which a two-operation card matches. Three, from 2 Safes, delegatecall a contract that is not an official MultiSend; the floor refuses those.

None of the misfits is a plain transfer in another shape, so the template stays as drafted.

The tests record three transfers from two Safes that are not in this search: `erc20-transfer-usdc` and `erc20-transfer-usdt` from one Safe 1.4.1, and `erc20-transfer-usdc-other-safe` from a Safe 1.3.0. Each gives `MATCH` with its implied card, a mutation of each of its 4 bound fields gives `MISMATCH`, and so do another recipient, another amount and another token than the card names.

## ERC-7730

- USDT: `registry/tether/calldata-usdt.json` in [LedgerHQ/clear-signing-erc7730-registry](https://github.com/LedgerHQ/clear-signing-erc7730-registry/blob/8e484f1dee742fa93e5a680c362c6693d0cf7e01/registry/tether/calldata-usdt.json), git blob `2753fcdee6c3459cb6afd62add5ff550c14b469c` at commit `8e484f1d`. It describes `transfer(address _to, uint256 _value)` as "Send": `_value` is the amount of the called token, `_to` the recipient. That agrees with this template.
- USDC: no Circle descriptor for the token itself. The generic [`ercs/calldata-erc20-tokens.json`](https://github.com/LedgerHQ/clear-signing-erc7730-registry/blob/8e484f1dee742fa93e5a680c362c6693d0cf7e01/ercs/calldata-erc20-tokens.json) (blob `ba93f5d423f04c9a2a230cb0ff96c3dad4bd0e5a`) describes `transfer` the same way for any token.

No ERC-8176 attestation was checked for either descriptor; this report predates `pnpm erc7730`, which now checks them; run it for their status.

## Protocol health

Both tokens are run by their issuers, and both issuers can stop a transfer. That cannot make a wrong `MATCH`: a transfer that does not move exactly the card amount out of the Safe is `MISMATCH` or does not execute.

- USDT. The verified `TetherToken` source on [Etherscan](https://etherscan.io/address/0xdac17f958d2ee523a2206206994597c13d831ec7#code) lets the owner pause transfers, blacklist an address and destroy its balance, charge a transfer fee (`basisPointsRate`, `maximumFee`), and `deprecate` the contract so that `transfer` forwards to another one. Read from Alchemy and drpc at block 26,384,584: `basisPointsRate` 0, `maximumFee` 0, `deprecated` false, `paused` false. A fee switched on later makes the recipient get less than `amount` while the Safe still gives exactly `amount`; the effects check sees only the Safe's side.
- USDC. `FiatTokenProxy` is upgradeable by its admin. Its implementation slot held `0x43506849D7C04F9138D1A2050bbF3A0c054402dd` at block 26,384,584, read from both providers, the address Etherscan reports, and `version()` returned "2". The FiatToken source lets Circle pause the token and blacklist addresses. On 10 March 2023 Circle said $3.3 billion of USDC's reserves were held at the failed Silicon Valley Bank, and USDC traded below its $1 peg until Circle said the deposits would be made whole ([CoinDesk](https://www.coindesk.com/business/2023/03/11/circle-confirms-33b-of-usdcs-cash-reserves-stuck-at-failed-silicon-valley-bank)).
