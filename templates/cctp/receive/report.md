# cctp/receive

The Safe completes a USDC transfer that Circle's CCTP V1 burned on another chain: it calls the MessageTransmitter's `receiveMessage(message, attestation)`, which checks Circle's attestation and has the TokenMessenger mint USDC to the message's `mintRecipient`. The Safe's history has two, both from Aptos (source domain 9), both minting to the Safe.

## Addresses and ABI

| Name | Address | Kind | Etherscan | Creator |
| --- | --- | --- | --- | --- |
| `cctp-message-transmitter` | `0x0a992d191DEeC32aFe36203Ad87D7d289a738F81` | `bridge` | `MessageTransmitter`, solc 0.7.6 | `0x6Bf89579FF3Fc3F2b57C0231e93eE78d35fBDdac`, transaction `0x18e036994de58a61854569cdf1202947f5fb64bb1e6a2da113c0eec5c6161b67`, block 16,730,025 |

[Circle's CCTP V1 EVM contracts page](https://developers.circle.com/cctp/v1/evm-smart-contracts) lists it for Ethereum, domain 0. The messages in the Safe's history name the V1 TokenMessenger `0xBd3fa81B58Ba92a82136038B25aDec7066af3155` as recipient, and the mint comes from USDC (`usdc`, already in the registry). Etherscan marks the address as a proxy, but the code has no EIP-1967 slot set and `prove-abi` finds no proxy, so the code proven is the code that runs.

`pnpm prove-abi`, a Sourcify partial match like the Morpho URD (see `templates/morpho/urd-claim/report.md` for the engine change):

```
address        0x0a992d191DEeC32aFe36203Ad87D7d289a738F81
proxy          none
compiler       solc 0.7.6+commit.7338295f
contract       MessageTransmitter.sol:MessageTransmitter
functions      31
codeHash       0xb361aef8f4fefcde94ca68db3301fe0d35aec649573daa8048a10b7dac6c9e1d
masked         7 immutable spans, 5 library spans, the metadata hash (Sourcify holds a partial match)
```

Fixture `testdata/abi/cctp-message-transmitter.json`.

## Fields

| Field | Meaning | Rule |
| --- | --- | --- |
| `to` | the MessageTransmitter | `cctp-message-transmitter` |
| `value` | ETH sent | 0 |
| `receiveMessage.message` | the packed CCTP message | free |
| `receiveMessage.attestation` | Circle's signatures over it | free |

Card: `token` and `amount` (of `token`). Effects: the Safe gives nothing and gets exactly `amount` of `token`.

Why the message is free. The message is `abi.encodePacked`, not ABI-encoded: a 116-byte header (version, source and destination domain, nonce, sender, recipient, destination caller) and a 132-byte burn body (version, burn token, `mintRecipient`, amount, message sender). The engine decodes only ABI-encoded calls, so it cannot bind `mintRecipient` or `amount` as fields; that would need a packed-layout rule, which this change does not add. The effects check carries the binding instead:

- The attestation must be Circle's attesters' signatures over the exact message, or `receiveMessage` reverts, so no field of the message can be edited after Circle signed it.
- The Safe must get exactly the card amount of USDC and nothing else of the Safe may change. A message that mints to another address, as the `cctp-receive-then-call` fixture's message does, leaves the Safe's USDC unchanged: `MISMATCH`. A message for another amount: `MISMATCH`.
- The Safe's call carries no value and no approval, and the MessageTransmitter calls the message's `recipient` contract, not the Safe, so the Safe's own permissions are not used beyond being the caller. The floor rules still check the Safe's settings.

## Past transactions

```sh
pnpm past-txs cctp/receive --token usdc --anchor mint --from-block <b> --to-block <b+1500> --max-txs 900
```

for `b` = 23,500,000, 24,200,000, 24,800,000, 25,400,000, plus 25,987,000 to 25,988,000:

| Blocks | USDC mints (both sources) | Executed by a Safe | Fit |
| --- | --- | --- | --- |
| 25,987,000 to 25,988,000 | 345 | 10 from 1 Safe | 0 |
| 23,500,000 to 23,501,500 | 313 | 4 from 1 Safe | 0 |
| 24,200,000 to 24,201,500 | 328 | 10 from 1 Safe | 0 |
| 24,800,000 to 24,801,500 | 524 | 17 from 2 Safes | 1 from 1 Safe |
| 25,400,000 to 25,401,500 | 421 | 5 from 1 Safe | 0 |

Almost every receive is an EOA relayer calling `receiveMessage` directly. The Safe receives found come from one Safe that receives a message and then calls other contracts in the same MultiSend; its message mints to another address. The one fit called a different `receiveMessage` target, CCTP V2's MessageTransmitter (message version 1), so its `to` misfit. The template's shape is therefore not shown by other Safes; it rests on the two receives in the Safe's own history and on the proven source. CCTP V2 needs its own registry entry and template.

## ERC-7730

The registry's `registry/circle/` has `calldata-TokenMessengerV2.json` and USDC's EIP-712 descriptors, none for the V1 MessageTransmitter.

## Protocol health

- DefiLlama's hack list ([api.llama.fi/hacks](https://api.llama.fi/hacks)) has no CCTP entry.
- Circle runs the attesters; a compromised attester set could mint USDC to anyone, but cannot move the Safe's tokens through this call.

## Tests

`test/claims.test.ts`: the `cctp-receive-then-call` fixture with a `cctp/receive` card is `MISMATCH` only at its second call, so its receive matches; its receive alone as a direct call gives `MATCH` with both bound fields caught by the mutation check. With the card amount from the message, a Safe that gets exactly that amount is `MATCH`, and one that gets none, one less or one more is `MISMATCH`.
