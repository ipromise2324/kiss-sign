Part of [the kiss-sign design](../design.md).

## Data shapes

### Template

A template describes one operation for one protocol, for example `morpho/vault-deposit`.
It is data, not code.

A template's keys are `id`, `card`, `calls` and `effects`, and, optionally, `nonce`, `same`, `facts` and `instanceField`; template load refuses any other.
A contract is never written as an address: a rule names it from the contract registry, which holds its address, the source that names it, and its code pin.

- `id`.
  `<protocol>/<operation>`, the template's folder under `templates/`.
- `card`.
  The card fields, by name, each `{"kind": ...}` of one kind: `contract` (with `registryKind`, and optionally `defillama` or `marketPart`; see [Intent card](#intent-card)), `amount` (with `of`, `eth` or the token field it counts, and optionally `computed` or `max`, never both), `percent`, `address`, `recipient`, `nonce`, `owner`, `threshold` or `market`.
- `calls`.
  The call tree the Safe makes, with MultiSend unwrapped.
  Each call is `{ "to", "value", "function", "args" }`, with an optional `trailer` (see [Engine checks that every template gets](engine-and-chain.md#engine-checks-that-every-template-gets)), or `{ "to", "value", "data": "empty" }`, as a plain ETH transfer or a cancellation sends; `to` and `value` take rules as arguments do.
  The last call may say, with a reason, that it `merge`s: the card's operations then share it, as the Morpho app puts several vaults' withdrawals into one `multicall`, or the Merkl app several reward tokens into one `claim`'s parallel arrays.
  Each merged call is made once, after every other call, with each operation's items in card order.
- Each call's `args`.
  A rule for every argument, by parameter name; a tuple's parts take theirs under `fields`, and an array's items under `items`.
  One of:
  - equals a card value (`amount`, `vault`), or a part of one, such as a vault's `asset` or a market's `loanToken`.
    A Morpho `MarketParams` tuple, exactly `(address,address,address,address,uint256)`, may be bound to a whole card market (`{"card": "market"}`): each of its five parts must equal the market's loan token, collateral token, oracle, interest rate model and lltv, and the mutation check changes each part.
    Template load refuses a whole market on any other type;
  - equals the Safe;
  - equals a named contract;
  - equals an address held as a 32-byte word (`addressWord`), on a `bytes32`: `{"addressWord": <rule>}`, where the rule is one that binds an address, `{"card": ...}`, `{"safe": true}` or `{"contract": ...}`.
    The word must be that address left-padded with 12 zero bytes, `bytes32(uint256(uint160(addr)))`, as bridges hold a recipient on another chain, such as CCTP's `depositForBurn` `mintRecipient` or a LayerZero OFT's `SendParam.to`; any other 32 bytes, a non-zero padding byte included, are `MISMATCH`.
    It binds a packed `bytes32` part and a signed message's `bytes32` member the same way.
    The mutation check changes the address inside the word;
  - equals the owner listed just before a card owner in the Safe's own owner list (`{"ownerBefore": "card.<owner field>"}`), the `prevOwner` that the Safe's `removeOwner` and `swapOwner` take.
    The program reads the Safe's `getOwners()` through both providers at the block the transaction runs on (the latest block for a transaction to sign, the parent block for an executed one) and requires the owner before the card's owner in that list, or the sentinel `0x0000000000000000000000000000000000000001` when the card's owner is listed first.
    A card owner who is not in the list is `MISMATCH`; a read the providers do not agree on is `UNVERIFIABLE`.
    The signer never types it, as the Safe web app never asks for it;
  - equals a constant.
    A constant address is only the zero address, a constant string outside a signed message is a tag of at most 32 printable ASCII characters, such as Vault V2's `this/marketParams`, too short to spell an address in hex, and constant `bytes` hold at most 19 bytes, such as a router's command list `0x0a10`, so no address-typed value or call is written into a template without a registry name.
    The lint goes by declared type: a free or constant `uint160`, `uint256` or `bytes32` that a contract reads as an address is not caught by type, and is left to review and the perturbation test (see [Engine checks that every template gets](engine-and-chain.md#engine-checks-that-every-template-gets)), except a `bytes32` named as a recipient (below);
  - equals the number the transaction holds at an earlier template path (`equals`), as a migration's share transfer must equal its approval;
  - a share price bound, at least as strict as the price a card amount per a card amount or an earlier field gives, scaled by a power of ten the template declares (`maxSharePrice`, `minSharePrice`; see [Intent card](#intent-card));
  - at least a card amount (`atLeast`), on a `uintN`, such as the fewest tokens a swap or an order may buy;
  - at most a card amount (`atMost`), on a `uintN`, such as the most tokens an exact-output swap may spend (`amountInMaximum`);
  - a time at most a number of seconds after the time of the block the transaction is judged on (`{"withinSeconds": <seconds>}`), on a `uintN` or `intN` that counts seconds since 1970 as a block's timestamp does, such as a CoW order's `validTo` or a swap's deadline.
    The block is the latest block `verify` reads for a transaction to sign, the one it simulates on, and the block an executed transaction ran in; its timestamp is read through both providers, so it is in the verdict file's exchanges and `replay` counts from the same time.
    A later value is `MISMATCH`, naming the field, its value, the block and its time, and the seconds; a block time the providers do not agree on is `UNVERIFIABLE`.
    The seconds are a whole number from 1 to 31,536,000 (365 days); a bound beyond a year bounds next to nothing.
    An earlier value, an order already expired, is left alone: it can only fail.
    It is a bound the program checks, like `atMost`, not a claim it takes on trust, so it carries no reason; the evidence for the number is the spread `pnpm past-txs` prints for it (see Free numbers under Study past transactions, step 4 of [the flow](flow.md#first-time-an-operation-is-done-build-its-template)), and the AI cites it in the field's note.
    It exists because a pre-signed order or approval that stays valid far longer than normal use needs keeps a door open after the signer stops watching, as in the Drift exploit of April 2026; a CoW order's `validTo` left free lets an order that expires in a year match.
    The mutation check sets it to one second past the bound, from the block time it read; when that time was not read or the value does not fit the type, it changes the value by one instead (see [Engine checks that every template gets](engine-and-chain.md#engine-checks-that-every-template-gets)).
    The perturbation test (`pnpm perturb`, replayed by `pnpm test` and the report) changes only free fields, so it never changes this one; it counts the bound, as the mutation check of a recorded test transaction does, from the time of the block the transaction ran in, read through both providers, so a recorded transaction later than its bound is not perturbed, since its fields give `MISMATCH`;
  - encoded parameters (`encoded`), on `bytes`: `{ "as": "<NAME>(<params>)", "args" }`, the bytes are those parameters ABI-encoded with no selector before them, as a command router takes each command's input, such as Uniswap's Universal Router in `execute(commands, inputs, deadline)`.
    The name is only the protocol's name for them, such as `V4_SWAP`.
    The bytes are decoded and must re-encode byte for byte, with nothing after them, and each parameter is bound like a call's argument.
    They are not a call: no selector is checked, the report names no function page for them, and `verify`'s 比對清單 shows the bytes as `check.sh` does, undecoded;
  - packed parts (`packed`), on `bytes`: the bytes are the concatenation of fixed-size parts with no padding, as Solidity's `abi.encodePacked` writes them, each `{ "name", "type", "rule" }` of an address, a `uintN`, an `intN`, a bool or a `bytesN`.
    The parts' sizes must add up to the bytes' length, or the field is `MISMATCH`, and each part is bound like an argument.
    A CoW order uid is one: the order's digest (`bytes32`), its owner (`address`) and its `validTo` (`uint32`);
  - the digest of a signed message (`eip712`), on a `bytes32`: see [Signed messages](#signed-messages);
  - free, with a written reason.
    The mutation check treats free fields as free.
  - for `bytes`, a call decoded from it (`call`, its function and a rule for each argument), or encoded parameters (`encoded`, above), such as the `idData` a Vault V2 cap is keyed by, `abi.encode("this/marketParams", adapter, marketParams)`, which a template writes as `capId(string kind, address adapter, (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams)`.
    Either must decode and re-encode byte for byte, and each of its arguments is a field like any other.

  Template load walks every argument's whole type, through tuples, arrays and decoded calls, and refuses a template that breaks these rules:
  - An address, wherever it sits, is bound to the Safe, a card value or a registry contract, or is the zero address.
    It is never free, and neither is a tuple or an array that holds one; bind its parts with `fields` and `items`.
  - A tuple is never free as a whole.
  - A `bytes32` whose parameter, struct member or packed part is named as a recipient, case-insensitively `to` or a name ending in `recipient`, `receiver` or `beneficiary`, such as `mintRecipient`, is never free and never a non-zero constant: it holds an address as a word, so it is bound with `addressWord`.
    The guard goes by the name the template's own signature gives, so it catches the common spellings, not a recipient a protocol names otherwise, a parameter the signature leaves unnamed, or a `bytes32[]` of recipients; those are left to review.
  - A number, a bool, fixed-size bytes or an array of numbers may be free with a reason: `{"free": "<why>"}`, such as the per-hop price floors (`minHopPriceX36`) a Uniswap swap may carry, which can only make it revert.
  - A free number that is a time, in seconds since 1970 as a block's timestamp counts, such as an order's expiry, may say so: `{"free": {"time": "<why>"}}`; `withinSeconds` (above) bounds such a time instead of freeing it.
    It is free exactly as a number with a reason is, at signing and in the perturbation test; only `pnpm past-txs` reads the declaration, to measure the value against the time of the block that set it (see Free numbers under Study past transactions, step 4 of [the flow](flow.md#first-time-an-operation-is-done-build-its-template)).
  - A number that picks one of a protocol's pools for the same tokens, such as a Uniswap pool's fee and tick spacing, may be free with a `route` claim: `{"free": {"route": "<why>"}}`.
    A changed value may send the swap through another pool, which changes the logs; the perturbation test then requires only that every copy reverts, is refused, or still passes the effects check, so the template's effects must bound every token the Safe gets with a card amount or `atLeast`, and template load refuses a `positive` or `any` one beside a route.
  - `bytes`, a string or an array of those leaves may be free only with a claim the template's tests check: `{"free": {"proof": "<why>"}}` when the contract reverts unless it verifies the value against what it already holds, such as a Merkle proof against a root or a CCTP message against Circle's attesters, or `{"free": {"unread": "<why>"}}` when the contract never reads it, such as the permit data of a VaultBundles deposit whose permit kind is bound to none.
    Free bytes could carry a whole call or an address, so they need one of these two claims, and the claim is what the perturbation test checks.
- Reasons.
  Every text the template's author writes for the signer, a free field's reason (`free`, or its `time`, `proof`, `unread` or `route`), a trailer's, a `max`'s, a computed field's `margin` `why` and an effect's `tolerance` `why`, a merged call's `merge` and a fact's `reason`, is an object keyed by language like the notes: `{ "en": ... }` or `{ "zh-TW": ... }` in the author's configured language, or `{ "en": ..., "zh-TW": ... }`.
  Every reason of one template holds the same languages, and the program refuses a template whose reasons differ.
  The reasons stay in `template.json`, since they are part of what the signer approves and what its fingerprint covers.
  `card new` and `verify`'s page show a reason in the configured language, and in the language the template holds when it lacks that one, refusing nothing; `report.generated.md` prints each reason in every language the template holds, so the signer reviews every text the program may show.
  In the rules above, `<why>` is such a reason.
  A plain string, as templates held before, reads as English, so a verdict file from before replays.
  The shipped templates hold both languages; adding the Traditional Chinese changed each one's fingerprint, so every signer approves each template once again before `verify` passes it.
- `nonce`.
  Optional: a rule for the Safe transaction's own nonce, such as a cancellation's card nonce.
- `same`.
  Optional: card references that must name one address, such as the assets of the two vaults in a migration.
  A card where they differ is refused before any check runs.
- `effects`.
  What the Safe gives and gets, in tokens and amounts written as card values, `positive` (more than nothing, in the direction of the side), or, for what the Safe gives, `all` (the Safe holds none of the token afterwards).
  A token is `eth`, a card value (`card.<field>`), or a registry token by name, such as `steth`, for a token the operation moves whatever the card names, as Lido's `submit` always mints stETH; template load requires a registry entry of kind `token` or `vault`, and the code pin check covers it like a contract a rule names.
  Native ETH is named `eth`, since no contract holds it, so `eth` and `safe` are never registry or address-book names.
  What the Safe gives may name its receiver; giving to the Safe itself changes nothing.
  What the Safe gives may be `{ "atMost": "card.<amount>" }`, no more than that amount and none of it gained, as an exact-output swap spends at most its `amountInMaximum` and the router returns the rest.
  What the Safe gets may be `{ "atLeast": "card.<amount>" }`, at least that amount, as a swap's fewest tokens out, or `any`, any amount, none included: a Vault V2 mints fee shares to its fee recipient whenever it accrues interest, as its `allocate` does, so a curator's Safe that is that recipient gets some of the vault's shares on a reallocation, and one that is not gets none.
  `any` lets only that token rise or stay; a loss of it is still `MISMATCH`.
  Approvals must be exact and spent in the same transaction, except those `effects.approves` names.

  An effect of an exact card amount of a token, not of `eth`, may carry a `tolerance`, `{ "less": <n>, "more": <n>, "why": <why> }` with at least one of `less` and `more`: the Safe's balance of the token may end up to `less` base units lower, or up to `more` higher, than the card amount explains, and only in a direction the template names.
  The default is exact: an effect with no tolerance allows no difference.
  It is for the rounding a protocol documents, and the template's past transactions are its evidence: `pnpm past-txs` measures how far each sender's balance ended from the stated amount (see Study past transactions, step 4 of [the flow](flow.md#first-time-an-operation-is-done-build-its-template)), and the AI declares the largest difference it observed, never more than 10, citing that distribution in `why`. stETH holds balances as shares and converts with integer division, so a stETH transfer or mint can arrive 1 or 2 wei short ([Lido docs, 1-2 wei corner case](https://docs.lido.fi/guides/lido-tokens-integration-guide/#1-2-wei-corner-case)), and an Aave aToken mints a scaled balance rounded to the nearest unit, so a supply can land 1 wei either side of its amount.
  Each of `less` and `more` is a whole number from 1 to 10, and template load refuses more.
  The cap is absolute, not a share of the amount: rounding loses a unit or two per conversion whatever the amount, while a share of the amount would grow with it and could hide a real loss on a large transaction.
  Ten units cover several conversions in one operation and are 0.00001 of a token of 6 decimals, such as USDC, and 10^-17 of a token of 18.
  A tolerance never widens an open amount: `positive`, `any`, `all`, `atLeast` and `atMost` take none, and a card on which a tolerance would reach such an amount of the same token from another operation is `UNVERIFIABLE`.
  Tolerances add up over the card's operations, as amounts do.
- `effects.touches`.
  Optional: registry tokens the operation touches without moving them on purpose, each `{ "token": <registry name>, "tolerance": { "less", "more", "why" } }` as above, such as stETH in an operation that unwraps wstETH and passes every stETH it got on, which can leave a wei of stETH behind.
  The Safe's balance of the token may then change within the tolerance and no further; every token no effect and no `touches` names must still not change by a single unit.
  A token is named here at most once, and not in the same template's `gives` or `gets`, whose own `tolerance` serves it; a card on which an effect names a touched token, by name or through a card field, is `UNVERIFIABLE`.
- `effects.approves`.
  Optional: allowances from the Safe the transaction may leave open, each `{ "token": "card.<field>", "spender": <registry name>, "amount", "via"? }`.
  `via` is `erc20` (an ERC-20 `approve`, the default) or `permit2` (an allowance inside Permit2, `allowance(Safe, token, spender)`).
  With `amount` a card amount, which must count that token, the allowance may end higher than it started, but at no more than that amount, summed over the card's operations that leave the same approval open, such as the approval a CoW order needs, which a solver spends after the Safe transaction.
  With `amount` `unlimited` it may end at any amount, unlimited included, and template load requires the spender's registry entry to declare a standing allowance through the same `via` (see [Standing allowances](#standing-allowances)).
  Every other allowance still may not rise.
- `effects.views`.
  Optional: view functions the program calls just before and just after the transaction, for a change no balance shows, such as a Morpho Blue supply, which adds to the Safe's position and moves no token to it.
  Each view names its contract (`to`): a registry contract, or a contract card field or one of its attributes, such as `{"card": "vault"}` for a Vault V2's own `absoluteCap(id)`.
  It names the function with its return values, such as `position(bytes32 id, address user) returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)`, a rule for every argument, and the change each named return value must show: `increases`, `decreases` or `same`, or `card.<field>`, an amount or percent field the value must equal after the transaction.
  A direction, not an amount: `increases` holds for a rise of 1.
  An argument is bound to a card value, the Safe, a registry contract or a constant, never free; a `bytes` argument may be a `call` or `encoded` parameters of such values, which the program encodes, and a `bytes32` argument may be `{"keccak": <call or encoded>}`, the keccak256 of one, such as a Vault V2 cap id, `keccak256(idData)`.
  `keccak` binds a view argument only.
  A return value the view does not name is not judged, and only a number can be named.
- `effects.safe`.
  Optional: the change an operation makes to the Safe's own owners and threshold, which the floor otherwise forbids (see the floor rules under [Engine checks that every template gets](engine-and-chain.md#engine-checks-that-every-template-gets)).
  `owners` names the card owner the Safe `add`s, the one it `remove`s, or both, for a replacement: `{ "add": "card.owner" }`, `{ "remove": "card.owner" }`, `{ "remove": "card.old-owner", "add": "card.new-owner" }`.
  `threshold` names a card threshold the Safe's threshold must end at, `"card.threshold"`.
  The program reads the Safe's settings just before and just after the transaction, as the floor already does, and requires the owners afterwards to be exactly those before, less the removed owner, who must have been one, plus the added owner, who must not have been; the threshold to be the card's, or unchanged when `threshold` is absent; and the singleton, modules, guard, module guard and fallback handler unchanged.
  Owners compare as a set: the Safe puts an added owner first and a replacement in the old owner's place, and the order decides nothing.
  A card may hold at most one operation with `effects.safe`, since one operation's prevOwner and threshold depend on the owners the Safe holds when it runs, which an earlier change in the same transaction would move; a card with two is refused.
  `effects.views` does not express this: a view names a registry contract and judges a number's direction, and the owners are a list on the Safe itself.
- `facts`.
  Optional: view functions the report reads once, to show the size of what a card field can name, such as a Morpho Blue market's `market(id)` totals.
  Each names a registry contract of a DefiLlama protocol one of the template's calls targets, under which the report shows the fact; the function with its return values; a rule for every argument as in `effects.views`, never the Safe, that names exactly one card field, a contract or a market field, the fact is read for; and for each named return value the token whose decimals it is counted in, `eth` or a token of that field.
  A fact may also name a `ratio` of two of its return values, such as `["totalBorrowAssets", "totalSupplyAssets"]`, which the report prints as a percentage; the template's reason for the fact names where the protocol defines that ratio, such as the contract that computes it.
  `pnpm report` reads each fact for every value the card field can name, through both providers at one block; `verify` never reads facts, and they decide nothing.
- `instanceField`.
  Optional: the contract card field the template is reported per (see One report, one operation, in [Report](flow.md#first-time-an-operation-is-done-build-its-template)), such as a pool field.
  Template load refuses a name that is not a contract card field.
  Without it, the card's one contract field of registry kind `vault` is the instance field.
  The program uses only the field's registry kind: a template whose card has two contract fields of that kind has no per-instance report yet, so every card for it is refused, the named field included.

### Standing allowances

The rule that an approval is spent in the transaction that gives it has one exception, written as data: a registry entry may declare `standingAllowance: { "via": "erc20" | "permit2", "why" }`, saying an allowance from the Safe to this contract may stay open, and why its code makes that safe.
The entry is reviewed with its source and code pin, and `verify` requires the contract to run its pinned code, as for any registry contract a template names.
Two entries declare one:

- **Permit2** (`0x000000000022D473030F116dDEE9F6B43aC78BA3`), through `erc20`: Permit2 has no owner and no proxy, and it moves an owner's tokens only for a spender the owner approved on Permit2 itself, by a call from the owner or by the owner's signature (`AllowanceTransfer`), or by a transfer the owner signed (`SignatureTransfer`).
  An ERC-20 allowance to Permit2 alone lets no one move the Safe's tokens.
  Uniswap's app asks for an unlimited one, once per token.
- **Uniswap's Universal Router**, through `permit2`: the router pulls tokens through Permit2 only from the address that called its `execute`, its locker (`msgSender()`), in every command that pulls: `Permit2Payments.permit2TransferFrom`, called with `msgSender()` as the owner for V2, V3 and V4 swaps with `payerIsUser`, `PERMIT2_TRANSFER_FROM`, and `PERMIT2_TRANSFER_FROM_BATCH`, which reverts when a transfer's `from` is not the locker; a V3 pool's callback pays only from a payer the router itself wrote, after checking the pool is the one the factory computes.
  The router has no owner and no proxy.
  So a Permit2 allowance from the Safe to it can be spent only by a later `execute` the Safe itself makes, which is another Safe transaction `verify` checks.
  Uniswap's app grants 2^160-1 for 30 days, signed or in a transaction, and leaves it open.

A template keeps such an allowance only by naming it in `effects.approves` with `amount` `unlimited`; any other allowance that ends higher than it started stays `MISMATCH`.
The floor rules let an unlimited approval to a declared spender through, of that route only (see [Engine checks](engine-and-chain.md#engine-checks-that-every-template-gets)), so a transaction whose template does not keep it still fails at the effects.
The report's 交易後 lists each kept allowance, the Markdown report with the entry's reason, and `verify`'s page lists each one the transaction left open with its amount and, through Permit2, its expiration.

### Signed messages

Some transactions hold only the hash of what the Safe agrees to.
A CoW order is one: `setPreSignature(orderUid, true)` stores the order's uid, whose first 32 bytes are the EIP-712 digest of the order, and a solver settles the order later.
The order's tokens, amounts, receiver and expiry are in the order, not in the transaction.
A template binds such a hash with an `eip712` rule:

- `domain`: `{ "name", "version", "verifyingContract" }`, the last a registry name.
  The chain is 1.
  The program computes the domain separator itself, as `keccak256(abi.encode(typeHash("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"), keccak256(name), keccak256(version), 1, verifyingContract))`.
  A contract that hashes with another domain can only fail to match.
- `type`: the struct's EIP-712 type string, such as `Order(address sellToken,address buyToken,…)`, one struct whose members are addresses, numbers, bools, `bytesN`, `string` or `bytes`, with no nested struct.
- `fields`: a rule for every member, as for a call's arguments.
  A constant string may be non-empty here, such as the order kind `sell`, since a message is hashed, never called; an address is never free, and a free member is a number, a bool or `bytesN` with a reason.
- `lookup`: an https URL where the message can be read, with `{arg}` standing for the hex of the call argument that holds the digest, such as `https://api.cow.fi/mainnet/api/v1/orders/{arg}`.
- `answer`, optional: where the message sits in the JSON the `lookup` answers, for an API that does not serve it as one top-level object with each member under its own name.
  `path` walks keys and array indexes, as an `apiSource`'s does, to the object that holds the message, such as `["order"]` or `["orders", 0]`.
  `members` names, for a member the API holds elsewhere or writes another way, its `path` from that object, such as `["amounts", "sell"]` for `sellAmount`, and, for a `uintN` the API writes as a `0x` hex string, `"encoding": "hex"`.
  A member `members` does not name is read from that object under its own name.
  Without `answer`, the message is the top-level object, as CoW's order API serves it.
  `answer` only says where to look: whatever it points at must still hash to the digest.

`verify` reads the message at `lookup` before it judges: one GET, asked again after a pause while it gets no answer, no header but `accept` and `user-agent`, no redirect followed, at most 1 MiB, a host that resolves only to public addresses, as for an `apiSource`.
The answer is data, never trusted.
The program takes each member where `answer` says, by default from the answer's top-level JSON object by its name (an address or `bytesN` as hex, a number as a decimal string or a JSON integer, or as `0x` hex where `answer` says so, a bool, a string, `bytes` as hex); an answer that holds no such member is not read, and the `not read` row says which member is missing where.
It computes `keccak256(0x1901 ‖ domainSeparator ‖ hashStruct(message))`, and requires it to equal the digest the transaction holds.
A message that hashes to it is exactly what the Safe signs, whoever served it; then each member is checked against its rule, and one that differs is `MISMATCH`.
With no answer, or no answer that hashes to the digest, the program cannot tell what the Safe would sign, and the field check is `UNVERIFIABLE`.
The verdict file keeps each message that hashed to its digest, cut to the struct's members under their own names, as a top-level object in the default encoding, so it holds no other text the server wrote (see [Verdict file](#verdict-file)) and `replay` reads nothing and needs no `answer`; why a read failed is printed for the signer and is not part of the verdict.

The mutation check changes each bound member of the message, computes the digest again, writes it into the transaction, and requires `MISMATCH`: a changed digest alone would only be `UNVERIFIABLE`.
The perturbation test does not change a free member, since another member value is another message with another digest, not another value of this transaction; what a free member allows is the template's reason and its review.
The HTML report says so on the member's row, in place of the perturbation's words.

### Markets

A Morpho Blue market is not a contract.
It is five parameters that one contract, the Morpho Blue singleton, holds under the market's id.
`registry/markets.json` names each market the signer may use (this repository ships the markets its shipped templates' tests and reports name):

- `lending`, `loanToken`, `collateralToken`, `oracle` and `irm`: registry names of kind `lending`, `token`, `token`, `oracle` and `irm`.
  Each is an ordinary registry entry, with its source, its DefiLlama slug and its code pin.
- `lltv`: a decimal integer below 2^256.
- `id`: the market's 32-byte id.
  Morpho computes it as keccak256 of the five parameters, ABI-encoded in the order loan token, collateral token, oracle, interest rate model, lltv.

The parser refuses a market whose `id` is not that hash of the addresses its names give, a name that is not a registry entry of the right kind, and a market name that is also a registry name, `safe` or `eth`.
A missing file holds no markets.
The market itself has no source page: its parts are checked as registry entries, and its id binds them together.

### Registry attributes and instance checks

`registry/attributes.json` declares every attribute a registry entry may carry and the kind of entry it must name, such as `{"asset": "token", "factory": "factory", "adapter": "adapter"}`.
An entry of any kind may carry any declared attribute, as `"attributes": {"asset": "usdc", "factory": "vault-v2-factory"}`, and registry load refuses an attribute the table does not declare and one that names no registry entry of its kind.
An attribute is a claim research makes about an entry, such as a vault's asset, a Vault V2's market adapter or a Uniswap pool's `token0`; a new protocol's attribute is a new line of the table, never code.
A card reference reads one (`vault.asset`); template load refuses it when no entry its field accepts carries it, and `card new`, `card seal` and `verify` refuse a card naming an entry that lacks it before any check (`the registry has no adapter for <vault>, which <template> reads as vault.adapter`).
A missing table, as in a verdict file from before it, declares the three attributes the program knew then: `asset` naming a `token`, `factory` a `factory` and `adapter` an `adapter`.

An entry whose `factory` attribute names a registry factory is an instance of that factory.
Every registry `factory` entry declares an `instanceCheck`, and registry load refuses one without it; it names the views that admit its instances: one view, or a list of views that must all pass.
Each view is one party vouching for the instance, written as:

- `ask`: the contract asked, `"factory"` (the default), `"instance"`, `{"attribute": <name>}` for the entry an attribute of the instance names, or `{"namedBy": <name>}` for each registry entry whose attribute of that name names the instance, each asked on its own.
- `function`: the view's signature.
- `args`: one per parameter, in order: a party, as above, which binds an `address` parameter to its address, or a constant of the parameter's type: `{"uint": "500"}` or `{"int": "-1"}`, a decimal integer in the type's range; `{"address": "0x…"}`; `{"bytes32": "0x…"}`; or `{"string": "fToken"}`, 1 to 32 letters, digits, `_`, `.` and `-`, so the stored `pnpm instance-evidence` line that quotes it holds nothing a report's text block or table reads as markup.
- `answers`: `true`, or a party whose address the answer must be.
  An object's default is `"instance"`.
- `word`: optional, the zero-based 32-byte word of the answer that is compared, for a view that answers a static struct; without it the answer must be one word.

A bare signature with one `address` parameter, such as MetaMorpho's `"isMetaMorpho(address)"`, is the view asked of the factory with the instance's address, answering `true`.
An object without `ask` and `answers` asks the factory to compute the address of its official contract, such as Fluid's LendingFactory, `{"function": "computeToken(address,string)", "args": [{"attribute": "asset"}, {"string": "fToken"}]}`, or Uniswap v3's factory for a 0.05% pool, `{"function": "getPool(address,address,uint24)", "args": [{"attribute": "token0"}, {"attribute": "token1"}, {"uint": "500"}]}`.
A Vault V2 market adapter's factory lists three: `"isMorphoMarketV1AdapterV2(address)"`; `{"ask": {"namedBy": "adapter"}, "function": "isAdapter(address)", "args": ["instance"], "answers": true}`, each registry vault naming the adapter answering that it allocates through it; and `{"ask": "instance", "function": "parentVault()", "args": [], "answers": {"namedBy": "adapter"}}`, the adapter answering the vault it was made for, which the factory passed at creation and its code keeps immutable.
An Aave v3 aToken's could be `{"ask": {"attribute": "pool"}, "function": "getReserveData(address)", "args": [{"attribute": "asset"}], "word": 8}`, the Pool naming the aToken of the reserve of the aToken's asset.

Registry load refuses an `instanceCheck` on an entry that is not a factory; one whose every view asks the instance itself, whose own word tells it from no lookalike; a view that names the instance by two attributes; a view whose parties and answer never name the instance, which answers the same for every contract; a view that answers the instance's address but binds no attribute, which computes the same address for every contract; a party on a parameter that is not an `address`, a constant of another type or outside its range, and an attribute the table does not declare.
The table refuses an attribute name JavaScript objects already carry, such as `constructor`.
Each view is read through both providers at one block.
A `true` view passes only on the word 1; the word 0, or another address than the party's, is the party saying no; anything else, a revert or an answer with no word `word` included, admits nothing, and a view expecting an attribute the instance lacks is not asked.
The asked call is written with the instance as `address`, every other party by its registry name and each constant as written, such as `isMetaMorpho(address)`, `computeToken(usdc,"fToken")` or `getPool(usdc,weth,500)`.
`pnpm prove-instance` prints every view's answer.

A factory, or an entry for itself, may also declare `size`, what `pnpm instance-evidence` reads of each instance: `{"function": "totalAssets()", "unit": {"function": "asset()", "attribute": "asset"}, "holders": true}`.
`function` is a view with no parameters the instance answers with one number.
`unit`, optional, is a view with no parameters the instance answers with the token the number counts, which must be the entry its `attribute` names; its `decimals()` scale the number.
`holders` says the instance is an ERC-20 share token whose holders are counted.
An entry's own `size` replaces its factory's.

### Intent card

The operation id plus this signing's values.
The template is reviewed once; the card is the only thing the signer confirms at every signing.
So the card holds only what changes between signings, and every other value is bound once, somewhere the signer already reviewed.
The AI designs the card: its values are what the protocol's own app asks for the operation, and any extra limit it adds for safety is proposed and explained in the report.

**The card asks only what the app asks.**
This holds for every protocol.
A value the protocol's own app fills in by itself, never asking its user, such as a slippage floor, a share-price cap, a minimum amount out or a deadline, is never asked at `card new`.
When it is a limit the transaction's own bound must carry, the template declares its card field as computed (below): `card new` reads it on chain through both providers and applies the protocol's own default, which the template cites, and prints it with its source for the signer to check.
It may instead be a limit no bound of the transaction carries, such as the fewest shares a plain `deposit(assets, receiver)` gives: the template then compares it with what the Safe gets (`atLeast` in the effects), so `verify` checks it on the simulated result before signing and on the receipt after, and nothing holds it when the transaction runs.
The report says so, since a price that moves between the two is not caught.
A value the program cannot compute that way is bound by the template or left free with a reason, as a deadline is, and is not asked either.
The sealed card still holds the computed number in base units, like a typed one, so `card seal`, `verify` and `replay` treat it exactly as before: what `verify` checks does not change.

Where each value comes from:

| Source | Confirmed | Examples |
|---|---|---|
| Template | Once, when the signer reviews the template | Target contracts, `receiver` and `owner` equal the Safe, the spender of an approval equals a named contract |
| Contract registry | Once per contract, during research (step 2) | Each Morpho vault, each Fluid fToken, routers |
| Markets table | Once per market, during research (step 2) | Each Morpho Blue market |
| Address book | Once per address, by the signer | An external recipient of a transfer, an owner the Safe adds, removes or replaces |
| Config | Once, at `init` | The Safe, the chain |
| The Safe, read on chain | By the program, every signing | The nonce |
| Card | By the signer, every signing | Amounts, which vault, swap limits, which address-book entry receives a transfer |

An address on the card is never typed by the AI.
It is a name from the contract registry or the address book, or the Safe itself.
The card shows the name and the full address, and the program resolves the name.
A market is a name from the markets table too.
A template's contract field may name its protocol, `{"kind": "contract", "registryKind": "vault", "defillama": "fluid"}`, so that it accepts only registry entries of that kind that belong to that protocol: a Fluid deposit cannot be handed a Morpho vault, and its report lists only Fluid's.
An entry with a `factory` attribute belongs to its factory's protocol, the factory entry's `defillama`, never its own: its own slug names the site that lists it, such as a curator's (`steakhouse-financial`), since `pnpm check-sources` compares its source page with that slug's website, while the factory, through its `instanceCheck` (`pnpm prove-instance`), shows on chain whose vault it is.
The factory's `instanceCheck` and the shapes it takes are under [Registry attributes and instance checks](#registry-attributes-and-instance-checks).
The HTML report shows an instance's admission, as `pnpm instance-evidence` stored it, as its result `<instance>/factory.admitted`, which passes only when the stored lines name the instance's own registry factory with every view answering as declared; `verify` does not ask the factory.
For an entry that names a `factory` and is not the report's own instance, whose admission comes only from its stored evidence, such as a Vault V2's market adapter, `pnpm report` asks every view of that factory's `instanceCheck` through both providers at its latest block, as `pnpm prove-instance` does, and shows the first view's answer as `<entry>/factory.admitted` and each other view's as `<entry>/factory.<function>`, or `<entry>/factory.<function>.<entry asked>` for a view asked or answered once per entry naming it (`namedBy`), which is not read when no registry entry names it.
Together these results are the entry's one `factory` place, which counts only when every one of them passes.
An entry with no `factory` belongs to the protocol its own `defillama` names.
A refusal names the protocol and the factory, such as `steakhouse-prime-usdc-v2-0f51 is a vault of morpho-blue (its factory vault-v2-factory), not of fluid-lending`.
Template load refuses a slug no registry entry of that kind belongs to, by the same rule.
`card new` lists only those entries, `pnpm report` checks only those, and `card seal` and `verify` refuse a card naming any other.
A contract field may also name a part of the markets table, `{"kind": "contract", "registryKind": "token", "marketPart": "collateralToken"}`, so that it accepts only registry entries of its kind that are that part of some market in `registry/markets.json`: a Vault V2 collateral's cap names a token a registered market takes as collateral, never a token such as MORPHO that no market of the table lends against.
Template load refuses a part that is not a contract part of a market (`lending`, `loanToken`, `collateralToken`, `oracle`, `irm`), a part whose entries are of another kind than `registryKind`, and a scope no registry entry fills.
`card new` lists only those entries, `pnpm report` states the rule and lists only those, and `card seal` and `verify` refuse a card naming any other (`morpho is not the collateralToken of any market in registry/markets.json`).
An instance field of a template reported per instance narrows further, to the instances with a report for that template, and so does every other field that can name an entry of the instance field's kind, an `address` field included (see [Report](flow.md#first-time-an-operation-is-done-build-its-template), step 6): `card new` lists only those, and `card seal` and `verify` refuse any other.

Card values per operation, covering the operations in the Safe's history:

| Operation | Card values | Bound by the template |
|---|---|---|
| Transfer ETH or a token | token, amount, recipient | none |
| Deposit into a vault (Morpho, Fluid) | vault, amount; for Morpho, the fewest shares to receive, computed | the asset is the vault's asset; receiver is the Safe; the approval is exact and goes to the vault; Morpho's price bound guarantees at least the card's shares |
| Withdraw or redeem from a vault | vault, amount or `all` (two templates); for Morpho, the most shares to burn, or for `all` the fewest assets to receive, computed | receiver and owner are the Safe; Morpho's price bound guarantees the card's limit |
| Move all of one Morpho vault into another | both vaults; the fewest assets to redeem and the fewest new shares to receive, computed | the two vaults share one asset; each price bound guarantees its card limit |
| Supply to a Morpho market | market, amount | the market's params are the registry market's; the Safe gives exactly the amount; its supply shares in the market increase and its debt and collateral do not change, read before and after |
| Claim rewards (Fluid, Merkl) | reward token | recipient is the Safe; amount and proof are free; the Safe gives nothing and receives only the reward token |
| Receive USDC through CCTP | token, amount | the target is Circle's MessageTransmitter; the message and attestation are free; the Safe gives nothing and receives exactly the amount of the token |
| Swap through a router (Uniswap, Odos) | sell token, buy token, sell amount, minimum buy amount | recipient is the Safe; the router is a named contract; for Uniswap, one Universal Router `execute` with one `V4_SWAP`, exact in: `uniswap/swap` in the USDC/USDT pool of the `uniswap-stable-pair-hook` entry, then a `SWEEP` to the Safe; `uniswap/swap-no-hook` in a USDC/USDT pool with no hook and tick spacing 1, its fee free; the Safe gives exactly the sell amount and gets at least the minimum |
| Let Uniswap use a token (`uniswap/approve-permit2`, `uniswap/allow-router`) | token | an unlimited ERC-20 approval to Permit2, or a Permit2 allowance of 2^160-1 to the Universal Router, each kept open as its registry entry allows (see [Standing allowances](#standing-allowances)); the app sends them before a first swap, alone or with it in one MultiSend, which a card of several operations covers |
| Place a CoW Swap order from a Safe | sell token, buy token, sell amount, minimum buy amount | the transaction pre-signs one order, read by its digest (see [Signed messages](#signed-messages)): a sell order of exactly the sell amount, for at least the minimum, to the Safe, filled once, with ERC-20 balances and no fee; with an approval, it is exactly the sell amount to CoW's vault relayer, left open until an order spends it |
| Cancel a queued transaction | the nonce to replace | 0 ETH to the Safe itself, no data |
| Add an owner (Safe settings) | owner, threshold | the Safe calls itself, 0 ETH, `addOwnerWithThreshold`; its owners gain exactly the card's owner and its threshold ends at the card's |
| Remove an owner | owner, threshold | the Safe calls itself, `removeOwner`; prevOwner is read from the Safe's owner list; its owners lose exactly the card's owner and its threshold ends at the card's |
| Replace an owner | old owner, new owner | the Safe calls itself, `swapOwner`; prevOwner as above; the old owner is replaced by the new one and the threshold does not change |
| Change the threshold | threshold | the Safe calls itself, `changeThreshold`; the owners do not change and the threshold ends at the card's |
| Submit, accept, decrease or revoke a pending increase of a Morpho Vault V2 market's caps (curator; a sentinel may decrease or revoke) | vault, market, absolute cap (an amount of the vault's asset, or `max`), relative cap (a percent) | the call goes to the vault through its `multicall`; the cap id is the vault's market adapter (its registry `adapter`) and the market; the market's loan token is the vault's asset; the vault's views show the pending change, its cancellation (`executableAt` falls), or each cap equal to the card's after the transaction; no asset of the Safe moves |
| Submit or accept an increase of a Morpho Vault V2 adapter's caps (`morpho/vault-v2-adapter-cap-submit`, `morpho/vault-v2-adapter-cap-accept`) | vault, absolute cap, relative cap | as a market's caps, with the cap id `abi.encode("this", adapter)`, the vault's registry `adapter`, the row for the whole adapter in the curator app |
| Submit an increase of a Morpho Vault V2 collateral's caps (`morpho/vault-v2-collateral-cap-submit`) | vault, collateral (a registry token that is the collateral token of a market in the markets table), absolute cap, relative cap | as a market's caps, with the cap id `abi.encode("collateralToken", collateral)`, which caps every market of that collateral the vault allocates to together |
| Reallocate a Morpho Vault V2 between two markets (allocator) | vault, the market to take from, the market to put into, amount | both calls go through the vault's `multicall` to its market adapter with the same amount; the adapter's Morpho Blue supply shares fall in the first market and rise in the second; no asset of the Safe moves |

- One Safe transaction can batch several operations, for example withdrawing from two vaults.
  The card then lists each operation with its values, and the MultiSend must contain exactly those calls.
  An approval belongs to the operation that spends it, not to its own line.
- Swap limits are stated as a minimum amount, not a slippage percentage, so the program never needs a price.
  The signer types the number.
  The CoW Swap app asks no minimum, but shows it as the least the order receives: its slippage is set per quote (`smartSlippage` in the order's app data), not a fixed default a computed field could apply, and the price is CoW's off-chain quote, which no view on chain gives.
  So a CoW card's minimum is typed, from what the app shows.
  The Uniswap app is the same: its slippage is set per quote by Uniswap's trading API (auto slippage, from 0.5% to 5.5%), and its price is that API's route over many pools, which no single view on chain gives, so a Uniswap card's minimum is typed, from the minimum the app shows; the transaction's own minimum must be at least it (`atLeast`).
- A vault's slippage limit is stated the same way, as an amount: the fewest shares a deposit gets (`min-shares`), the most shares a withdrawal of an amount burns (`max-shares`), or the fewest assets a withdrawal of all gets (`min-assets`).
  Slippage protection acts when the transaction runs, which no simulation before it can see, so the transaction's own bound must carry the card's limit.
  A Morpho adapter takes the bound as a price in assets per share scaled by 1e27; the template binds it with `maxSharePrice` or `minSharePrice`, `{ "assets", "shares", "scale"? }`, and the field check requires it to be at least as strict as the price the card's amounts give.
  `scale` is the power of ten the protocol scales the price by, a whole number from 1 to 36, and 27, as Morpho's adapters take it, when absent; a protocol that takes the price scaled by 1e18 declares `"scale": 18`.
  Template load refuses any other scale, so a typo such as `"scale": 270` cannot make every bound pass or fail.
  For a deposit of 1,800,000.000180 USDC with `min-shares` 1,741,863.305677219101283940, `maxSharePriceE27` must be at most 1800000000180 × 10^27 / 1741863305677219101283940.
  A stricter bound matches too; a looser one is `MISMATCH` at that field.
  Where the share count is the Safe's whole balance, as in a withdrawal of all, the bound is checked against the share count the transaction states, and a transaction that states 2^256-1 (the whole balance, read when it runs) is `MISMATCH`, since its bound then guarantees nothing.
- The Morpho app asks for none of these limits: it fills the bound itself, from its own preview and the SDK's default slippage tolerance of 0.03% (`DEFAULT_SLIPPAGE_TOLERANCE`, `3_00000000000000n` in WAD, in `morpho-org/sdks` `packages/blue-sdk/src/constants.ts`, applied in `packages/morpho-sdk/src/helpers/slippage.ts` at commit `56f1ed62827a7aab39d979c0143d1fbf970c37ca` on the default branch).
  So each is a computed field.
  An amount card field declares it as `"computed": { "read", "bound", "default", "margin"? }`:
  - `read`: one view call, `{ "to", "function": "<name>(<params>) returns (<returns>)", "args": { "<param>": <arg> }, "output"? }`.
    `to` is a registry contract, `{ "contract": "<name>" }`, or a contract or market field or one of its parts, such as `{ "card": "vault" }`, resolved from the registry exactly as `card seal` resolves it.
    Each argument is bound as a view's argument is under `effects.views`: a card value, the Safe, a registry contract or a constant of any ABI type, or a tuple, array, call or hash of these, with a card number passed only to a `uint256`, since a narrower parameter would cut or refuse it; or `{ "read": <read> }`, another read, for an unsigned parameter at least as wide as the number that read picks, such as `balanceOf(safe)` inside `previewRedeem`.
    A card field it names must be declared before it when that field is itself computed.
    `output` is the dotted path of names, through `returns` and a tuple's components, to the number the read gives, such as `"supplyShares"` of `position(bytes32 id, address user) returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)`; it may be left out when the function returns one value.
    Template load refuses any other argument, a field that refers to itself or to a computed field declared after it, and an output that is not an unsigned integer.
    A template written before reads took rules may still hold the older form, which load reads as exactly the newer one and nothing else: `"card.<field>"` as `{ "card": "<field>" }`, `"safe"` as `{ "safe": true }`, and a read with no `read` around it as `{ "read": ... }`.
    `replay` relies on it, since a verdict file holds the template's text as it was when `verify` ran.
    Morpho's deposit reads `{ "to": { "card": "vault" }, "function": "previewDeposit(uint256 assets) returns (uint256 shares)", "args": { "assets": { "card": "amount" } } }`; a Curve pool's quote reads `get_dy(int128 i, int128 j, uint256 dx) returns (uint256 dy)` with `{ "const": "0" }`, `{ "const": "1" }` and `{ "card": "amount" }`; and wstETH's wrap reads `getWstETHByStETH(uint256 stETHAmount) returns (uint256)` on `{ "contract": "<its registry name>" }`.
  - `bound`: `floor`, for a fewest (`min-shares`, `min-assets`): the read less the slippage, rounded down; or `ceiling`, for a most (`max-shares`): the read plus the slippage, rounded up.
  - `default`: `{ "bps", "source" }`, the protocol's own default slippage in basis points and the https URL that shows it, such as the SDK constant at a pinned commit.
  - `margin`: optional, `{ "bps", "why" }`, more slippage on top of the default, with the reason.
    The app reads its preview when it builds the transaction, the Morpho SDK accruing interest two hours ahead, while the card is filled earlier, and the share price moves in between.
    With the default alone, the card's floor of a deposit is always a little stricter than the bound the app computes later from a rising price, so the app's own transaction would be `MISMATCH`; the margin is the room for that move, and the template's reason says how long it lasts.
    Each of `default.bps` and `margin.bps` is a whole number from 0 to 1,000; the slippage is their sum.

  `card new` makes every read at the one block both providers agree on, the block it reads `decimals()` at, inner reads first, and refuses the card when the providers disagree, a call reverts, or an answer is not the canonical encoding of the function's returns, and when the value comes to 0, which as a floor bounds nothing, or to 2^256 or more.
  A margin's reason may hold no control or bidirectional character, since `card new` prints it at the signer's terminal; the tests hold a committed template's margin and `max` reasons to at most 200 characters in each language, and the parser does not, so a verdict recorded with a longer one still replays.
  Every read of a card is made at that one block, before any of its operations runs, so a computed field of a later operation does not see an earlier operation's effect, such as a deposit before a withdrawal of all; its limit then differs from the app's: a stricter one makes the app's transaction `MISMATCH`, and a looser one protects less, so such a card is best split into one card per transaction.
  It prints each read with its answer, the slippage as a percentage with the default's source and the margin's reason, and the value in whole tokens; the card before the seal step's question lists it with the typed amounts in whole tokens and base units, with the block of every read.
  For a deposit of 1,000,000 USDC whose `previewDeposit` answers 935,000 shares, the floor at 0.03% plus a margin of 0.07% is 935,000 × 0.999 = 934,065 shares.
  A card file sealed with `card seal` may still hold any number there but 0; the field's computation belongs to `card new`, and the card holds only its result.
  `card seal` and `verify` refuse a card that holds 0 in a computed field, or in an amount field a share price bound or an `atLeast` compares with, since 0 there bounds nothing or nothing can meet it: with `min-shares` 0, any `maxSharePriceE27` is at most the price the card's amounts give.
  `card new` refuses a typed 0 in such a field at its prompt by the same rule, says why in the signer's language, and asks again, so the signer does not learn it only at the seal step: a `min-buy` of 0 for `cow/swap` is asked again.
- A card `market` field takes a market's name.
  `card new` lists every market by number with its name, its id, its lltv, and each part's registry name and full address.
  A template names the whole market or one part: `market.lending`, `market.loanToken`, `market.collateralToken`, `market.oracle` and `market.irm` are registry addresses, `market.lltv` is a number, and `market.id` is a bytes32.
  An amount of `market.loanToken` is typed in that token's decimals, as for any registry token.
- A card `percent` field takes a percent in plain digits with at most 16 decimals, such as `100` or `35.5`, at most 100, and the card holds it in WAD base units, 100% being 10^18, as Vault V2 counts a relative cap.
- An amount field may declare `"max": { "value": "<base units>", "why" }`: the signer may type `max` for that number, which `card new` prints with the reason, such as a Vault V2 absolute cap of 2^128-1, which the curator app sets for no limit and which no one types in whole tokens; a computed field is never typed, so template load refuses one with a `max`.
- An `owner` card field takes an address-book name, never `safe` or a registry contract, and a `threshold` field a whole number from 1, typed as it is.
  An owner to remove or replace must be in the address book too, although the chain lists the Safe's owners: a card holds names the signer confirmed, never an address read at signing.
  `card new` lists the book; picking someone who is not an owner gives `MISMATCH` at `verify`.
- A recipient that is not the Safe must already be in the address book.
  Adding an entry is a separate step, done before signing, where the signer checks the full address against a source outside the chat.

Sealed means hashed and stored in `$KISS_SIGN_HOME` after the signer's yes, before the signer sees the Safe transaction.
In the basic tier an AI on the same computer can write there; see [Two tiers](../design.md#two-tiers).

### Verdict file

Every input the verdict used, so `replay` can recompute it offline: the Safe transaction as given, the sealed card's text and hash, each template's text with its approved hash, the contract registry, the markets table and the attributes table when the commit has them, and the address-book entries the card names, the templates and the tables read at the origin/main commit the self-check passed on and the card and the address book from `$KISS_SIGN_HOME`, and every request sent to the two providers with each one's answer, each code answer by its keccak256 in the file's `bytecode` table (see Recordings), and each signed message's `lookup` answer (see [Signed messages](#signed-messages)).
A file without the markets table, such as one from before markets, has no markets, and one without the attributes table has the three attributes the program knew before it.
`replay` runs the same checks on these alone and reports whether the verdict, and the list of calls that move no asset, are the ones recorded.
It exits 0 when they are, whatever the verdict, and 1 when they differ or the file cannot be replayed.
A verdict file from before that list was recorded has an older format and is refused.
