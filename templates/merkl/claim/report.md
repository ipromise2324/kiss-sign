# merkl/claim

The Safe claims rewards that Merkl distributes. The Merkl app sends one direct call to Merkl's Distributor: `claim(users, tokens, amounts, proofs)`, four parallel arrays with one item per reward token. Each leaf is `(user, token, cumulativeAmount)` under the Distributor's current root.

## Addresses and ABI

| Name | Address | Kind | Etherscan | Creator |
| --- | --- | --- | --- | --- |
| `merkl-distributor` | `0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae` | `distributor` | EIP-1967 proxy to `Distributor` `0x33CC998Fd4AF3b6be42BaC9a67fe97e9e275d2aE`, solc 0.8.25 | `0x9f76a95AA7535bb0893cf88A146396e00ed21A12`, transaction `0xddec2da7cdde4214e3b98ad7114235239fe6232bc6b90a61f54985ef79f254df`, block 16,683,144 |
| `morpho` | `0x58D97B57BB95320F9a05dC918Aef65434969c2B2` | `token` | EIP-1967 proxy to `MorphoTokenEthereum` | named in [Morpho's addresses](https://docs.morpho.org/get-started/resources/addresses/) |

Sources: [`UPGRADE_DEPLOYMENT.md`](https://github.com/AngleProtocol/merkl-contracts/blob/main/UPGRADE_DEPLOYMENT.md) on the default branch of `AngleProtocol/merkl-contracts` names `0x3Ef3...d9Ae` as "Distributor Proxy" on Ethereum, and the same repository's `scripts/Distributor.s.sol`, `scripts/Disputer.s.sol` and `scripts/utils/ChainUtils.s.sol` use it as the distributor. Merkl's API (`api.merkl.xyz`) and docs pages are rendered by script, so they were not a readable second source.

`pnpm prove-abi` (solc 0.8.25, pinned in this branch):

```
address        0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae
proxy          eip1967
implementation 0x33CC998Fd4AF3b6be42BaC9a67fe97e9e275d2aE
proxyCodeHash  0x45a8f258094615c6b45b6fec0fab1bf25c6f28244b6c33a303d9ba952ec10d2d
contract       contracts/Distributor.sol:Distributor
functions      38
codeHash       0x86c9090609b4bbddb98864b0eeb866e73d740904d312c7655ab6101246f8f3ea
masked         5 immutable spans, 0 library spans
```

Fixture `testdata/abi/merkl-distributor.json`. MORPHO's proof is `testdata/abi/morpho-token-eip1967.json`.

## Fields

| Field | Meaning | Rule |
| --- | --- | --- |
| `to` | the Distributor | `merkl-distributor` |
| `value` | ETH sent | 0 |
| `claim.users[i]` | whose reward | the Safe |
| `claim.tokens[i]` | which reward token | the card's `token` |
| `claim.amounts[i]` | cumulative amount in the leaf | free |
| `claim.proofs[i]` | the proof | free |

Card: `token`. Effects: the Safe gives nothing and gets a positive amount of `token`.

The call `merge`s: a card with several `merkl/claim` operations expects one `claim` whose arrays hold one item per operation, in card order. That needed an engine change, below.

Why the free fields are safe. The proven `_claim` reverts unless every array has the same length, unless the caller is the user or an operator the user allowed, and unless each proof hashes `(user, token, amount)` into the root. It pays `amount - claimed` of `token`. With `claim` (not `claimWithRecipient`) it pays to `claimRecipient[user][token]` when the user set one, else to the user. So the amount and proof decide only how much, and a recipient the Safe set earlier would send the reward elsewhere. The effects check covers both: the Safe must get a positive amount of each card token, and nothing else of the Safe may change. A claim paid to a stored recipient, or one that pays nothing because it was already claimed, is `MISMATCH`.

## Past transactions

```sh
pnpm past-txs merkl/claim --token morpho --anchor any --from merkl-distributor --from-block 24020000 --to-block 24040000 --max-txs 800
```

| Alchemy, Etherscan, both | Executed by a Safe | Fit | Unreadable |
| --- | --- | --- | --- |
| 251, 251, 251 | 7 from 7 Safes | 5 from 5 Safes | 6 |

Over the 5 fits every rule held: target the Distributor, value 0, `users[0]` the Safe, `tokens[0]` MORPHO.

Misfits: the other 2 Safes claimed 2 and 3 tokens in one `claim` (USDC and MORPHO; MORPHO, aEthUSDe and FXN). That is normal app use, so the template merges, and both are tests (`merkl-claim-two-tokens`, `merkl-claim-three-tokens`). `testdata/research/merkl-claim.json` records blocks 24,020,000 to 24,030,000 of this search.

## Engine change: merged calls with parallel arrays

Before, a merged call had to take exactly one array argument (Bundler3's `bundle`). Now every argument of a merged call is bound by `items`, each with the same number of items, and each operation puts its items into every array at the same position. Item `i` of every array is checked with the card values of the operation that put it in. A template with an argument not bound by items, or arrays of different lengths, fails to load. Morpho's one-array merges are the same case with one argument, and their tests are unchanged.

Revert checks: passing operation contexts only to the first argument, as before, fails the two- and three-token tests (the tokens are checked against the first operation's token); dropping the equal-count rule lets a template with unequal arrays load, which its test refuses.

## ERC-7730

No descriptor in [LedgerHQ/clear-signing-erc7730-registry](https://github.com/LedgerHQ/clear-signing-erc7730-registry) names Merkl or this Distributor.

## Protocol health

- The Distributor is upgradeable (`upgradeTo`, `upgradeToAndCall`, `revokeUpgradeability` in the proven ABI). `prove-abi` reads the implementation at every proof; a new implementation needs a new proof before the template should be trusted.
- Roots go through a dispute period (`disputeTree`, `resolveDispute`, `revokeTree`), so a wrong root can be challenged before it applies.
- DefiLlama's hack list ([api.llama.fi/hacks](https://api.llama.fi/hacks)) has no Merkl or Angle Distributor entry.

## Tests

`test/claims.test.ts`: `merkl-claim` and `merkl-claim-other-safe` (one token), `merkl-claim-two-tokens`, `merkl-claim-three-tokens`, and `merkl-and-morpho-urd-claim` (a Merkl claim and a Morpho URD claim in one MultiSend). Each gives `MATCH` with its implied card, a mutation of every bound field gives `MISMATCH`, and so does another user. A card with the tokens in another order is `MISMATCH` at the tokens; a card that leaves one token out is `MISMATCH` at all four arrays. `merkl-claim` is simulated and read from its receipt: +100.95 MORPHO, `MATCH`; the same observation under a card for USDC is `MISMATCH` on both tokens.
