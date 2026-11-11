Written by the AI.

# morpho/market-supply

The Safe lends a market's loan token into one Morpho Blue market through BlueBundlesV1, the Morpho app's current route for market actions. The transaction is one official MultiSend with two calls. The first approves BlueBundlesV1 for exactly the amount. The second calls `blueBundlesV1Supply`, which pulls the amount from the Safe and supplies it to Morpho Blue on behalf of the caller, the Safe. The function has no recipient argument, so the position can only go to the Safe.

The card asks what the Morpho app asks on a market page: the market and the amount. It has no slippage limit, because `blueBundlesV1Supply` takes none, and a Morpho Blue supply share price only rises with interest or falls with bad debt. No one can raise it within a block by a donation, as one can with a vault.

The first market is `usdc-cbbtc-86`, the one the signer named by its app link: id `0x64d65c9a2d91c36d56fbc42d69e979335320169b3df63bf92789e2c8883fcc64`, USDC lent against cbBTC, LLTV 86%.

## Program change

This template needs three things the program did not have. `docs/design.md` describes each one.

- **A market on the card.** A Morpho Blue market is five parameters, not a contract. `registry/markets.json` names each market. Every part of a market is a registry entry, and the parser refuses a market whose id is not the hash of those parts. The `market` card field lists the markets with every part's full address.
- **View effects.** A supply moves no token to the Safe. The Safe's position lives inside Morpho Blue, so no balance shows it. The template now asks the program to call `position(id, Safe)` on Morpho Blue before and after the transaction. `supplyShares` must increase, and `borrowShares` and `collateral` must stay the same.
- **`past-txs --to`.** It finds transfers into one address, here USDC into BlueBundlesV1.

Morpho Blue, the oracle and the interest rate model are now registry entries. So every signing checks their code against the pins, which it did not do before for any Morpho template.

## Addresses

| Name | Address | Kind | `pnpm prove-abi` |
| --- | --- | --- | --- |
| `morpho-blue` | `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` | lending | `src/Morpho.sol:Morpho`, solc 0.8.19, no proxy, code hash `0xfa259fa317198f88f5fa3c119f06c066295dbcd47d715e0a30e1bcf94c02ef8c` |
| `blue-bundles-v1` | `0x38B0C12AB81976e9417D4ebfe2A34DB6DF22e6AD` | router | `lib/bundles/src/blue/BlueBundlesV1.sol:BlueBundlesV1`, solc 0.8.34, no proxy, code hash `0x858c1bec7c0feacd5fc0430dec85c632be2c8dd20b7e94c87e1e53c438a88888` |
| `adaptive-curve-irm` | `0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC` | irm | `src/AdaptiveCurveIrm.sol:AdaptiveCurveIrm`, solc 0.8.19, no proxy, code hash `0x73b578a0cd95d0d6e77f85a3945a670a9b8679670f8fc190ca97e89a1f07f6cd` |
| `morpho-oracle-cbbtc-usdc-86` | `0xA6D6950c9F177F1De7f7757FB33539e3Ec60182a` | oracle | `MorphoChainlinkOracleV2`, solc 0.8.21, no proxy, code hash `0x2f02515e84336f19fede110d7b3fee0a087c629adb34a32c165559303675bf11` |
| `cbbtc` | `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` | token | refused: its source needs solc 0.6.12, which is not pinned. The same holds for USDC. Its code is pinned all the same. |

- **Morpho docs.** [The addresses page](https://docs.morpho.org/developers/contracts/addresses/) lists Morpho Blue as "Morpho", BlueBundlesV1 as "BlueBundlesV1", and the IRM as "Adaptive Curve Irm" on Ethereum.
- **Morpho app route.** [The bundles page](https://docs.morpho.org/developers/contracts/bundles/) says the Morpho interface and the Morpho SDK (from v6) route every operation through Bundles. The SDK sends a Blue supply to `bundles.blueBundlesV1`, both as the approval's spender and as the call's target ([morpho-org/sdks, common.ts, lines 126 and 304](https://github.com/morpho-org/sdks/blob/d336594e9669ef405c964f507224617ce064cdb1/packages/morpho-sdk/src/actions/blue/common.ts)).
- **Morpho API.** Query to `https://api.morpho.org/graphql`: `markets(where: { uniqueKey_in: ["0x64d65c9a2d91c36d56fbc42d69e979335320169b3df63bf92789e2c8883fcc64"], chainId_in: [1] }) { items { marketId lltv morphoBlue { address } loanAsset { address } collateralAsset { address } oracle { address type } irmAddress creationBlockNumber listed warnings { type } badDebt { usd } realizedBadDebt { usd } } }`. The answer gave:
  - Morpho Blue `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb`
  - loan USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`
  - collateral cbBTC `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf`
  - oracle `0xA6D6950c9F177F1De7f7757FB33539e3Ec60182a`, type ChainlinkOracleV2
  - IRM `0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC`
  - lltv 860000000000000000, created at block 20679422, listed, no warnings, bad debt 0, realized bad debt 0

  The parser checks these five parameters against the market id.
- **The oracle's source.** No page served without scripts lists the oracle. Its `source` is the market's app page, which renders the address only with JavaScript, so `check-sources` prints a FINDING. The registry test names this one entry as the exception and requires that it stays a FINDING. The oracle is bound instead by:
  - **The market id.** The signer gave the market by its id in the app link, and the id is keccak256 of the five parameters, the oracle among them.
  - **Its creator.** It was created by the MorphoChainlinkOracleV2 factory `0x3A7bB36Ee3f3eE32A60e9f2b33c1e5f2E83ad766`, which the addresses page lists as "Morpho ChainlinkOracleV2 Factory".
- **cbBTC's source.** Its source is Coinbase's own `agentkit` repository, pinned to a commit on its default branch, where `ethereum-mainnet` lists CBBTC at this address. CoinGecko lists `coinbase-wrapped-btc` at this address. DefiLlama has no cbBTC protocol. Its `coinbase` entry names no GitHub organization, so the source check prints a FINDING for the comparison.
- **coinbase.com on this machine.** `www.coinbase.com` resolved to `182.173.0.181` and presented a self-signed certificate, so Coinbase's own cbBTC page could not be read. TLS checks stayed on and nothing was read from that host. The signer may want to check their network.

Creators, read from Blockscout's API (`eth.blockscout.com/api/v2`), because Etherscan blocks automated reads:

- `morpho-blue` and `adaptive-curve-irm`: verified as `Morpho` and `AdaptiveCurveIrm`. Both were created in block 18883124 through the CREATE2 deployer `0x4e59b44847b379578588920cA78FbF26c0B4956C`, sent by `0x937Ce2d6c488b361825D2DB5e8A70e26d48afEd5`, in transactions `0xba6a2e752ff5caee49cd4f69825ca00e47abc827ae51e7bda5c3ad56eae053b3` and `0xfb791de3516cb1091cc84f7d131333107ff236bff2012480d00dc889ac6ec22c`.
- `blue-bundles-v1`: verified as `BlueBundlesV1`. It was created at block 25832676 (2026-08-25) by `0x84aBfeC38AA800F86FF66599Ea508951b94C3BcC` in transaction `0xa9f20a7d1bea97c3eb0370e9ca0953b7bb0b4a291db382875253372c8cd1e0c4`, sent by `0x3448F8C366047d76b6b58bb4ef225E4454B1b5ff`. That is the same sender that deployed VaultBundlesV1.
- `morpho-oracle-cbbtc-usdc-86`: created by the factory above in transaction `0x11b31d6e2008ad4176f062480a9c4aa53dc4d74efe471aea92040bf4a2d62e71`, block 20678797.
- `cbbtc`: verified as `FiatTokenProxy`, with implementation `FiatTokenV2_1` at `0x7458bfDC30034EB860B265E6068121D18Fa5Aa72`. It was created at block 20570548 by `0x00000000001c3dC9A681A014e2732bF1419aFAec` in transaction `0x09001d384305288073faa8f5cf3051c6cc13d55b66114064be17e12f71469753`.

No official source names a deployer for Morpho Blue, the IRM, BlueBundlesV1 or cbBTC. For these, the creator check rests on the official pages naming the address.

## Fields

These meanings come from the proven source of `blueBundlesV1Supply` and its library `TokenLib`.

| Call | Field | Meaning | Rule |
| --- | --- | --- | --- |
| `multiSend[0]` | `to` | the loan token | the card market's `loanToken` |
| | `approve.spender` | who may pull it | `blue-bundles-v1` |
| | `approve.value` | how much | the card's `amount` |
| `multiSend[1]` | `to` | BlueBundlesV1 | `blue-bundles-v1` |
| | `marketParams` | the market: loan token, collateral token, oracle, IRM, LLTV | each part is the card market's part |
| | `assets` | how much it pulls from the Safe | the card's `amount` |
| | `loanTokenPermit.kind` | how it pulls: 0 `transferFrom`, 1 ERC-2612, 2 Permit2 | 0 |
| | `loanTokenPermit.data` | the permit signature | free, unread when kind is 0 |
| | `referralFeePct`, `referralFeeRecipient` | a fee taken from `assets` and sent elsewhere | 0 and the zero address |
| | `deadline` | the call reverts after this time | free |

The referral fee is bound because the effects would not see it. With a fee, the Safe still gives exactly `amount` and its supply shares still rise, only by less.

Effects:
- The Safe gives exactly `amount` of the loan token.
- No allowance from the Safe may end higher than it started, so the approval must be spent in full.
- The Safe's `supplyShares` in the market must rise, and its `borrowShares` and `collateral` must not change.

BlueBundlesV1 also gives Morpho Blue an unlimited allowance of the loan token. That is BlueBundlesV1's own allowance, not the Safe's.

## Vaults

None. The card names a market, not a vault. Morpho's API shows this market at about 349.6M USDC supplied and 304.3M borrowed (87% utilization), with no bad debt, and with supply from Steakhouse, Gauntlet, Spark and other curators' vaults. That is the largest of the nine USDC/cbBTC markets on mainnet.

## Past transactions

The recorded study (`pnpm past-txs morpho/market-supply --token usdc --anchor any --to blue-bundles-v1`) searched the standard 12 windows over the last year. BlueBundlesV1 has existed only since block 25832676, so only the two newest windows held transfers.

- **Sources.** Alchemy and Etherscan both found the same 528 transfers.
- **Studied.** 40 transactions: 2 from 2 proven Safes, 8 from 8 EOAs, and 30 that called another BlueBundlesV1 function (borrow, repay, withdraw).
- **The 2 Safes.** Both are misfits that called other BlueBundlesV1 functions.
- **The 8 EOAs.** All 8 called `blueBundlesV1Supply` with the template's call shape. In all 8, `referralFeePct` was 0, the recipient was the zero address, and the market's parts agreed with one another. 7 used a permit (kind 1 or 2) instead of an approval. An EOA can sign one in the same transaction, while a Safe approves instead. The markets were 7 distinct USDC markets.

The windows held no Safe supply that fit. To find test transactions, I also searched BlueBundlesV1's whole life in 12,000-block ranges. That search is exploration only and is not recorded. It found 13 Safe transactions from 7 Safes that fit the template's shape, 5 of them in this market. In the ranges, the misfits by Safes fell into these groups:

- **No approval.** Safes calling `blueBundlesV1Supply` alone, spending an approval given earlier. Like `morpho/vault-bundles-deposit`, the template requires the approval in the same transaction, so a standing allowance stays out of the signed shape. This shape is left out.
- **Other BlueBundlesV1 functions.** Borrow (`0xb1268765`), repay and withdraw (`0x827d6bd8`), migration (`0xc0229fe8`), sometimes with a Morpho `setAuthorization`.
- **A delegatecall to a contract that is not an official MultiSend.**

The tests record two supplies to this market from two other Safes.

- `morpho-market-supply`: Safe `0xeaeB0B27E39F1220cA6694edc282e634Fc154993`, nonce 155, 72,159.646110 USDC.
- `morpho-market-supply-other-safe`: Safe `0xbf87D9244CD8E4d9F49d3b6016F784493b199b36`, nonce 200, 20,000,000 USDC.

Each gives `MATCH` with its implied card, in the field check, in a simulation, and from its receipt. The mutation check changes each of the 15 bound fields and gets `MISMATCH`.

A third supply, `morpho-market-supply-unlimited-approval` (the second Safe's nonce 222), approved 2^256−1. It is a `MISMATCH` at the approval, and the effects refuse it as an approval raised and not spent.

The perturbation test changed `deadline`: one more and one less changed nothing, and 0 reverted. `loanTokenPermit.data` is empty in every studied Safe supply, so it has no byte to change (Known limits).

## ERC-7730

The pinned registry has a descriptor for BlueBundlesV1 by exact address, and no attestation for it. It has no descriptor for Morpho Blue, the oracle, the IRM or cbBTC.

For `blueBundlesV1Supply`, it shows `assets`, the collateral token, the LLTV, the fee, the fee recipient and the deadline. It hides `marketParams.oracle` (visible: never). It names no field for `marketParams.loanToken` or `marketParams.irm`, and hides the permit.

A wallet using it would not show which oracle prices the market. Two markets with the same tokens and LLTV and different oracles look the same there. The template binds all five parts, and the card shows each with its full address.

## Protocol health

- **Hacks.** The DefiLlama hacks API lists one Morpho entry: "LeadBlock's Morpho Blue Market", 2024-10-14, $250K, an oracle misconfiguration in another market ([api.llama.fi/hacks](https://api.llama.fi/hacks)).
- **App incident.** On 2025-04-10 a front-end SDK change sent approvals to Bundler3 instead of its adapters. A whitehat front-ran the exploit, no funds were lost, and Morpho says its contracts were not affected ([post-mortem](https://morpho.org/blog/morpho-app-incident-april-10-2025/)).
- **Audits.**
  - [Morpho Blue](https://github.com/morpho-org/morpho-blue/tree/430bd61d8ab9238c1bde327eec2bfcd3f494fe9d/audits)
  - [AdaptiveCurveIrm](https://github.com/morpho-org/morpho-blue-irm/tree/58ce91fd04840372443a7080a5b32067b17b3d60/audits)
  - [the oracles](https://github.com/morpho-org/morpho-blue-oracles/tree/f2f490cfd37f3feb06a5ccdc1b6ee2f789d561fa/audits)
  - [BlueBundlesV1](https://github.com/morpho-org/bundles/tree/3537d0039bdc3ce7af1bbd3c02eb96a04e6e2c6b/audits): Blackthorn and Trustsec, both dated 2026-08-25, the day of deployment. I did not read the PDFs, so their findings and the commit they cover are not checked.
- **BlueBundlesV1 is young.** It has been live about 2.5 months. Its code pin catches any change of its code.
- **Admin.** Morpho Blue is not upgradeable. Its owner can only enable IRMs and LLTVs and set fees and the fee recipient. Blockscout's event logs show:
  - The last `SetOwner` was at block 18949595, to the Safe `0xcBa28b38103307Ec8dA98377ffF9816C164f9AFa`, which is still the owner.
  - No `SetFee` or `SetFeeRecipient` ever ran.
  - The Morpho API gives this market a fee of 0.
- **The oracle.** It reads only Chainlink BTC/USD (`0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c`, 0.5% deviation, one-hour heartbeat, [Chainlink feed list](https://reference-data-directory.vercel.app/feeds-mainnet.json)). It prices cbBTC as BTC and USDC as one dollar. A cbBTC depeg from BTC, or a USDC depeg, would not show in the price, and that risk falls on lenders as bad debt. The market has had no bad debt.
- **cbBTC.** It is an upgradeable Coinbase token with a blacklist, like USDC. I found no reliable report of a depeg or incident.
