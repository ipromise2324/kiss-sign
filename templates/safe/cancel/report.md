# safe/cancel

The Safe replaces a queued transaction it no longer wants by executing another one at the same nonce: 0 ETH to the Safe itself, no data, operation 0. Once it executes, the queued transaction at that nonce can never execute.

## Addresses and ABI

The only address is the Safe itself, which the template binds with the `safe` rule. A call with no data runs no function, so there is no ABI to prove. A Safe receiving 0 ETH with empty data runs its `receive` function and nothing else.

## Fields

| Field | Meaning | Rule |
| --- | --- | --- |
| `nonce` | Which queued transaction this replaces | the card's `nonce` |
| `to` | The Safe itself | `safe` |
| `value` | No ETH | 0 |
| `data` | Nothing | empty; any byte is `MISMATCH` |
| `operation` | Call, not delegatecall | the engine requires 0 |

Card: `nonce`, the nonce of the transaction to replace. The template binds the Safe transaction's own nonce to it, so a card made to cancel nonce 12 never matches a cancellation at nonce 13. The static floor already refuses a call to the Safe itself that carries data, which is how every owner, module, guard or threshold change would look. Effects: none, so any balance or allowance change is `MISMATCH`.

## Past transactions

`pnpm past-txs` anchors on an ERC-20 `Transfer` log, and a cancellation logs none, so it cannot search this operation. Instead, the full executed histories of three other Safes, listed from the Safe Transaction Service, give: 9 calls from a Safe to itself with no data, from 2 Safes, every one with value 0, operation 0 and all fee fields zero. The same Safes also made 24 calls to themselves with data (`addOwnerWithThreshold`, `removeOwner`, `swapOwner`, `changeThreshold`); those are settings changes, which the static floor refuses, not cancellations. Two cancellations are recorded as tests:

- `testdata/safe-tx/safe-cancel.json`: nonce 87 of a Safe 1.3.0.
- `testdata/safe-tx/safe-cancel-other-safe.json`: nonce 494 of another Safe 1.3.0.

The tests require `MATCH` for both with their implied cards, a mutation of each bound field (`nonce`, `to`, `value`) to give `MISMATCH`, and `MISMATCH` for a card naming another nonce, another target, a value of 1 wei, and data.

## ERC-7730

No descriptor applies: a call without data has no function to describe.

## Protocol health

Nothing to check beyond the Safe itself. The nonce on the card is the signer's statement of which queued transaction to drop; the program reads the Safe's current nonce on chain before it simulates, and refuses a transaction whose nonce is not the next one.
