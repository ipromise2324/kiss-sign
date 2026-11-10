# Attack replays

Real attacks in which a Safe's signers were shown one transaction and signed another. `pnpm attacks` replays each one offline and prints what the signers believed, as a card, the transaction that ran, decoded, and the verdict with the checks that caught it. `test/attacks.test.ts` requires every run to be something other than `MATCH` and names the checks that catch it.

Each case is a folder:

- `case.json`, written by hand from the sources: the Safe, the nonce, what the signers believed, the card for it, an address book of names only this case uses, and the function signature the sources give for the call, shown only when its selector is the call's.
- `recording.json`, written by `pnpm attacks --record <case>`: the transaction as the Safe Transaction Service returns it, and every JSON-RPC request verify made with each provider's answer.

On Ethereum, verify runs twice as of the block before execution, with templates and the registry from this checkout, each template approved at its own hash. The first run gives only the transaction's fields, so verify simulates it as a pending transaction on that block, as it would have before the signers signed. The second gives the Transaction Service record, so verify judges it by its receipt. kiss-sign reads Ethereum only, so a case on another chain runs no simulation.

| Case | Safe | Nonce | Transaction | Believed | Ran | Caught by |
| --- | --- | --- | --- | --- | --- | --- |
| `bybit` | `0x1Db92e2EeBC8E0c075a02BeA49a2935BcD2dFCF4`, Safe 1.1.1 | 71 | `0x46deef0f52e3a983b67abf4714448a41dd7ffd6d32d32da69d62081c68ad7882`, block 21,895,238 | ETH from the cold wallet to the warm wallet `0xf89d7b9c864f589bbF53a82105107622B35EaA40` | `delegatecall` to `0x96221423681A6d52E184D440a8eFCEbB105C7242`, `transfer(0xbDd077f651EBe7f7b3cE16fe5F2b025BE2969516, 0)`, which wrote the attacker's contract into the singleton slot; `safeTxGas` 45746 | static floor `delegatecall` and `fee-fields`, fields; effects by the receipt |
| `wazirx` | `0x27fD43BABfbe83a81d14665b1a6fB8030A60C9b4`, Safe 1.3.0 | 1718 | `0x48164d3adbab78c2cb9876f6e17f88e321097fcd14cadd57556866e4ef3e185d`, block 20,331,565 | 500,000 USDT to WazirX's withdrawal wallet `0x618fFD1cDAbeE36CE5992a857Cc7463f21272bD7` | `delegatecall` to `0xfbfFEF83b1C172fE3BC86C1CCB036AB9F3efCAF2` with selector `0x804e1f0a` and `0xef279c2ab14960aa319008cbea384b9f8ac35fc6`, which replaced the singleton | static floor `delegatecall`, fields; effects by the receipt |
| `radiant` | `0x111CEEee040739fD91D29C34C33E6B3E112F2177` on Arbitrum | 230 | `0x7856552db409fe51e17339ab1e0e1ce9c85d68bf0f4de4c110fc4e372ea02fb1`, block 264,477,049 | a routine admin transaction | `transferOwnership(0x57ba8957ed2ff2e7AE38F4935451E81Ce1eEFbf5)` on the LendingPoolAddressesProvider `0x091d52CacE1edc5527C99cDCFA6937C1635330E4` | the card: kiss-sign has no template for it. The floor alone passes this plain call |

Where the cards come from:

- `bybit`: no source gives the amount or the recipient. The recipient is the wallet the cold wallet paid at nonces 68 to 70, which Etherscan labels "Bybit: Hot Wallet". The amount, 30,000 ETH, is what most of the cold wallet's earlier transfers sent.
- `wazirx`: the Transaction Service holds an unexecuted proposal at the same nonce, safeTxHash `0xfe1d20734698cb8f8fc21e70a797db518063bc5d059cba41d1f220cec1e4529a`, with two confirmations: USDT `transfer` of 500,000 USDT to `0x618fFD1c…`, the wallet nonces 1716 and 1717 also paid. WazirX's report says the signers saw the expected token and a whitelisted destination. The card is that proposal.
- `radiant`: no source gives the decoy's contents. The card names `radiant/admin`, a template kiss-sign does not have, so verify stops at the card.

The address book of `radiant` names the LendingPoolAddressesProvider only so the output can name it. Its identity is inferred: on Arbitrum it answers `getMarketId()` with "Radiant" and `getLendingPool()` with the pool Rekt names.

## Sources

| Case | Sources |
| --- | --- |
| `bybit` | https://www.certik.com/resources/blog/bybit-incident-technical-analysis, https://www.sygnia.co/blog/sygnia-investigation-bybit-hack/, https://etherscan.io/tx/0x46deef0f52e3a983b67abf4714448a41dd7ffd6d32d32da69d62081c68ad7882 |
| `wazirx` | https://wazirx.com/blog/preliminary-report-cyber-attack-on-wazirx-multisig-wallet/, https://wazirx.com/blog/wazirx-cyber-attack-key-insights-and-learnings/, https://etherscan.io/tx/0x48164d3adbab78c2cb9876f6e17f88e321097fcd14cadd57556866e4ef3e185d |
| `radiant` | https://rekt.news/radiant-capital-rekt2, https://cointelegraph.com/news/radiant-capital-attacker-compromised-multiple-developers-devices-post-mortem, https://medium.com/@RadiantCapital/radiant-post-mortem-fecd6cd38081, https://arbiscan.io/tx/0x7856552db409fe51e17339ab1e0e1ce9c85d68bf0f4de4c110fc4e372ea02fb1 |

## Not replayed

- No other Ethereum Safe incident with a public post-mortem shows signers a benign transaction while they signed another. UPCX, Infini, Humanity Protocol and SuperFortune were a leaked key, kept admin rights, keys on one laptop, and a lookalike address.
- Drift Protocol (2026) and Step Finance (2026) used Solana multisigs, not Safe.
- Ronin (2022) and Harmony Horizon (2022) lost validator or multisig keys; nobody signed a disguised transaction.

## What the replays show besides the verdict

- A simulation of a Safe 1.1.1 transaction cannot read the Safe's settings, so `bybit` simulated is also unverifiable; the floor and the fields still give `MISMATCH`.
- After `wazirx` replaced the singleton, the Safe's own views are gone, so the simulation cannot read the settings after it and is unverifiable rather than naming the changed singleton.
- Judged by its receipt, neither singleton change shows as a settings change: neither transaction logged `ChangedMasterCopy`. Only the static floor, the fields and the effects catch them there.

## Recording again

```sh
export ALCHEMY_API_KEY=$(sed -n 's/^ALCHEMY_API_KEY=//p' ~/.kiss-sign/.env)
pnpm attacks --record bybit
pnpm attacks --record wazirx
pnpm attacks --record radiant
```

drpc's public endpoint rate-limits; a run it refuses records that refusal, so record that case again.
