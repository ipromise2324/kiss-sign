# eth/transfer

The Safe sends native ETH to one recipient: a call to the recipient with the amount as its value and no data.

## Addresses and ABI

No contract is involved. The recipient is a card value: `safe` or an address-book name the signer confirmed. A call with no data runs no function, so there is no ABI to prove.

## Fields

| Field | Meaning | Rule |
| --- | --- | --- |
| `to` | Who receives the ETH | the card's `recipient` |
| `value` | How much ETH, in wei | the card's `amount` |
| `data` | Nothing | empty; any byte is `MISMATCH` |
| `operation` | Call, not delegatecall | the engine requires 0 for every call |

Card: `amount` (wei, `of: eth`) and `recipient`. Effects: the Safe gives exactly `amount` ETH to `recipient`. When the recipient is `safe` the Safe pays itself, so its balance must not change at all.

ETH has no contract, so it cannot be a registry entry. Templates name it `eth`, the way they name the Safe `safe`, and both names are reserved, so no registry or address-book entry can take them. In a simulation the ETH change is read from the Safe's balance before and after `execTransaction`. For an executed transaction it is the Safe's balance at the execution block minus its balance at the parent block, read from both providers: no log shows ETH sent as the value of `execTransaction` itself, and with every fee field zero the Safe pays no gas. Another transaction in the same block that moves the Safe's ETH changes that number too (see Known limits in `docs/design.md`).

Several transfers in one transaction go through an official MultiSend, one card operation per call, in order. The engine already unwraps the MultiSend for every template, and checks that the outer transaction sends no ETH.

## Past transactions

`pnpm past-txs` anchors on an ERC-20 `Transfer` log, and a plain ETH transfer logs none, so it cannot search this operation. Instead, the full executed histories of three other Safes, listed from the Safe Transaction Service, give: 4 plain ETH transfers from 3 Safes, every one a direct call with empty data, value equal to the amount, operation 0 and all fee fields zero. Two are recorded as tests:

- `testdata/safe-tx/eth-transfer-null-data.json`: 4.988797943068499801 ETH, Safe 1.3.0. The Transaction Service reports its empty data as `null`.
- `testdata/safe-tx/eth-transfer-first-nonce.json`: 0.001 ETH, another Safe 1.3.0.

The tests require `MATCH` for both with their implied cards, a mutation of each bound field (`to`, `value`) to give `MISMATCH`, and `MISMATCH` for another recipient, another amount, and one byte of data. `testdata/simulate/eth-transfer-null-data.json` measures the ETH change both ways, by simulation and by the balance around the receipt, and both equal the card amount.

## ERC-7730

No descriptor applies: a call without data has no function to describe.

## Protocol health

Nothing to check. The risk is the recipient, which the signer confirms once in the address book against a source outside the chat.
