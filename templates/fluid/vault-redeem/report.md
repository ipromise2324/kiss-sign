# fluid/vault-redeem

The Safe redeems an exact number of Fluid fToken shares for the asset they are worth. The Fluid app sends one direct call to the fToken, ERC-4626 `redeem(shares, Safe, Safe)`, and uses it for "withdraw all", with the Safe's whole share balance.

The addresses, the ABI proof, ERC-7730 and protocol health are in `templates/fluid/vault-deposit/report.md`; they are the same two fTokens.

## Fields

| Field | Meaning | Rule |
| --- | --- | --- |
| `to` | the fToken | the card's `vault` |
| `value` | ETH sent | 0 |
| `redeem.shares` | the shares burned | the card's `shares` |
| `redeem.receiver` | who receives the asset | the Safe |
| `redeem.owner` | whose shares are burned | the Safe |

Card: `vault` (a registry `vault`) and `shares` (`of: vault`, the fToken's own base units, 6 decimals for fUSDC and fUSDT). Effects: the Safe gives exactly `shares` of the fToken and gets a positive amount of the asset.

The design's "amount or `all`" is met with the share amount: to withdraw everything, the card names the Safe's whole fToken balance. A card value `all`, resolved from the balance at signing, is not built; it would need the engine to read a balance while resolving the card, and the share amount already lets the signer see exactly what leaves the Safe.

## Past transactions

```sh
pnpm past-txs fluid/vault-redeem --token fluid-fusdt --anchor burn --from-block 26234000 --to-block 26384000 --max-txs 3000
pnpm past-txs fluid/vault-redeem --token fluid-fusdc --anchor burn --from-block 26234000 --to-block 26384000 --max-txs 3000
```

| Anchor | Alchemy, Etherscan, both | Executed by a Safe | Fit | Unreadable |
| --- | --- | --- | --- | --- |
| fUSDT burned | 417, 417, 417 | 7 from 5 Safes | 1 from 1 Safe | 110 |
| fUSDC burned | 1,210, 1,210, 1,210 | 8 from 8 Safes | 3 from 3 Safes | 189 |

The search shares its anchor with `fluid/vault-withdraw`, so most misfits are withdrawals (`0xb460af94`). Unreadable transactions are ones drpc's public endpoint rate-limited, so the counts are lower bounds and differ slightly from the withdrawal run over the same blocks. Over the 4 fitting transactions every rule held in 4 of 4: the target was the card's vault, the value 0, and `receiver` and `owner` the Safe. One fUSDC fit redeems from another ERC-4626 vault that holds fUSDC.

Other misfits: one Safe redeemed fUSDT and deposited the USDT into another vault in one MultiSend, two operations on one card; two Safes delegatecalled a contract that is not an official MultiSend, which the floor refuses.

The Safes' histories add more of the same shape with the Fluid app as origin: the two tested Safes redeemed this way five times between them, from fUSDT and fUSDC.

The tests record two redemptions from two Safes: `fluid-redeem-usdt` and `fluid-redeem-usdt-other-safe`. Each gives `MATCH` with its implied card, and a mutation of each of its 5 bound fields gives `MISMATCH`. So do another receiver and another share amount. One is simulated on its parent block and read from its receipt: the Safe gives exactly the card's shares and gets USDT.
