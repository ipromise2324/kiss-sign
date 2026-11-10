# fluid/vault-withdraw

The Safe withdraws an exact amount of a Fluid fToken's asset, and the fToken burns as many of the Safe's shares as that costs. The Fluid app sends one direct call to the fToken: ERC-4626 `withdraw(amount, Safe, Safe)`.

The addresses, the ABI proof, ERC-7730 and protocol health are in `templates/fluid/vault-deposit/report.md`; they are the same two fTokens.

## Fields

| Field | Meaning | Rule |
| --- | --- | --- |
| `to` | the fToken | the card's `vault` |
| `value` | ETH sent | 0 |
| `withdraw.assets` | the asset amount the Safe receives | the card's `amount` |
| `withdraw.receiver` | who receives the asset | the Safe |
| `withdraw.owner` | whose shares are burned | the Safe |

Card: `vault` (a registry `vault`) and `amount` (`of: vault.asset`). Effects: the Safe gets exactly `amount` of the asset and gives a positive amount of the fToken. The number of shares is the fToken's to compute, so the card does not state it; the engine requires the Safe's share balance to fall and nothing else to change.

"Withdraw all" is not a card value. The Fluid app sends a full withdrawal as `redeem` of the Safe's whole share balance, which `fluid/vault-redeem` checks with the share amount on the card.

`owner` bound to the Safe matters even though the Safe calls the fToken itself: with another owner, the fToken would spend that owner's allowance to the Safe and burn their shares, a different operation.

## Past transactions

```sh
pnpm past-txs fluid/vault-withdraw --token fluid-fusdt --anchor burn --from-block 26234000 --to-block 26384000 --max-txs 3000
pnpm past-txs fluid/vault-withdraw --token fluid-fusdc --anchor burn --from-block 26234000 --to-block 26384000 --max-txs 3000
```

| Anchor | Alchemy, Etherscan, both | Executed by a Safe | Fit | Unreadable |
| --- | --- | --- | --- | --- |
| fUSDT burned | 417, 417, 417 | 7 from 5 Safes | 5 from 4 Safes | 128 |
| fUSDC burned | 1,210, 1,210, 1,210 | 6 from 6 Safes | 3 from 3 Safes | 331 |

Unreadable transactions are ones drpc's public endpoint rate-limited, so the Safe counts are lower bounds. Over the 8 fitting transactions every rule held in 8 of 8: the target was the card's vault, the value 0, and both `receiver` and `owner` were the Safe. Two fUSDC fits withdraw from another ERC-4626 vault that holds fUSDC.

Misfits, and what they taught:

- `redeem` instead of `withdraw` (1 fUSDT, 2 fUSDC, one of them on another vault). The Fluid app uses `redeem` for a full withdrawal; it is `fluid/vault-redeem`.
- One Safe redeemed fUSDT and deposited the USDT into another vault in one MultiSend. That is two operations on one card.
- One Safe delegatecalled a contract that is not an official MultiSend; the floor refuses it.

The search shows no other withdrawal shape, so the template stays as drafted. One of the two tested Safes withdrew this way from fUSDT six times (nonces 24 to 38), five of them with the Fluid app as origin.

The tests record two withdrawals from two Safes: `fluid-withdraw-usdc` and `fluid-withdraw-usdt-other-safe`. Each gives `MATCH` with its implied card, and a mutation of each of its 5 bound fields gives `MISMATCH`. So do another receiver, another owner and another amount. The USDT withdrawal is simulated on its parent block and read from its receipt: the Safe gets exactly the card amount of USDT and its fUSDT balance falls; the same observation with the fUSDT balance unchanged is `MISMATCH`.
