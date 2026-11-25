Part of [the kiss-sign design](../design.md).

## What goes on GitHub

Templates are reviewed once and reused, so they live in git, where every change is a diff someone reviewed.
The evidence behind each template goes with it.

| Published in the repository | Kept local, in `$KISS_SIGN_HOME` |
|---|---|
| Templates: what each operation checks | Config: the Safe address, the repository to trust, the language; API keys in `.env` |
| Reports: where every address and rule came from | Address book |
| Test transactions | Intent cards and verdict files |
| Contract registry and markets table | Approved template hashes |

- Each operation has a folder, for example `templates/morpho/vault-deposit/`, holding `template.json`, `notes.json` and `docs.json`, and, for a template reported once, `report.generated.md` and the HTML report in each language its notes hold; a template reported per instance keeps its reports in `instances/<instance>/`, each with that instance's `notes.json` and, when a function's page names the instance or its asset, its `docs.json`, while the template's `docs.json` holds the rest, `{}` when no page is shared.
  Its tests are in `test/` and `testdata/`.
- This repository ships twenty-two templates: `eth/transfer`, `erc20/transfer`, `morpho/vault-deposit`, `fluid/vault-deposit`, `compound/supply`, `cow/swap` (a CoW order pre-signed alone, its sell token already approved), `cow/swap-approve` (the same with its approval, through MultiSend), `uniswap/swap` (one USDC/USDT swap in Uniswap's StablePair hook pool, its Permit2 allowances already open), `uniswap/swap-no-hook` (the same in a pool with no hook), `uniswap/approve-permit2` and `uniswap/allow-router` (the two allowances a first swap needs, each on its own or before `uniswap/swap` in one MultiSend) and the Vault V2 admin templates `morpho/vault-v2-cap-submit`, `morpho/vault-v2-cap-accept`, `morpho/vault-v2-cap-decrease`, `morpho/vault-v2-revoke`, `morpho/vault-v2-adapter-cap-submit`, `morpho/vault-v2-adapter-cap-accept` and `morpho/vault-v2-collateral-cap-submit`, and the Safe settings templates `safe/add-owner`, `safe/remove-owner`, `safe/swap-owner` and `safe/change-threshold`.
  Other operations of the table in [Intent card](data-shapes.md#intent-card) whose checks no shipped template reaches, such as a Merkle claim's proof field, a market field or a withdrawal of all, keep a `template.json` under `test/fixtures/templates/`, with the registry entries and markets only they name under `test/fixtures/registry/`, or, for entries only one test file names, under a folder of their own that the file adds, such as `test/fixtures/vault-v2/registry/` for the Vault V2 vault whose curator's transactions only test the templates.
  Only tests read them, through a temporary copy of the repository with them added (`test/repo-with-test-fixtures.ts`); `card new`, `card seal`, `verify` and `pnpm report` never see them.
- The tests are real past transactions of the operation, each with the card values it implies.
  Every one must give `MATCH`, and every mutated copy must give `MISMATCH`.
  CI (`.github/workflows/test.yml`, GitHub Actions) runs `pnpm typecheck` and the whole offline test suite on every pull request and every push to `main` (a branch runs once, through its pull request), with every action pinned by commit, after fetching the pinned solc builds and Public Suffix List and checking each file's sha256.
  It holds no secrets: the tests replay recorded chain answers, including recorded simulations, so live simulation and every live read run locally.
  To keep a run short, CI caches the solc outputs the tests compile, each keyed by the sha256 of the pinned compiler build and of the exact standard-JSON input, and the tests take only an exact match; every ABI proof still compares the cached bytecode with the code on chain on every run, while the ABI in a cached output is trusted as CI's own earlier output.
  Only the test helper reads this cache: `pnpm prove-abi`, `pnpm report` and `pnpm record-abi-case` always compile, and `verify` compiles nothing.
- Git stores and records; it is not trusted.
  At signing, the program checks that the template's hash equals the hash recorded when the signer merged it.
  A template from someone else's repository is only a starting point: its report still has to be reviewed.

### The Safe's address is never published

Published files would otherwise tie the Safe, its balances, and its history to whoever owns the repository.

- Templates refer to "the Safe", never to an address.
- Test transactions come from other senders.
  The signer's own Safe is excluded when searching for past transactions.
  `record-safe-tx` refuses the configured Safe before it reads anything; `record-safe-tx`, `record-safe-proxy`, `instance-evidence --record` and `report --record` write nothing when the recording would mention it, and `past-txs --record` writes zeros for the Safe's address in its search answers, keeping the Safe's transactions by hash, drops every read that holds the address, and refuses a recording, or the summary it commits, that still holds it (see Study past transactions, step 4 of [the flow](flow.md#first-time-an-operation-is-done-build-its-template)).
- Reports count senders but list no Safe of the signer's.
- Before every push, a check greps the outgoing commits for the configured Safe address and for API keys, and must find nothing.

## Engine checks that every template gets

These are protocol-free and change rarely.

- The Safe transaction hashes, computed locally.
- Decode, then re-encode byte for byte, so nothing hides in the encoding.
  - One exception, declared per call in the template: a trailer of at most a stated number of bytes after the arguments, with a written reason.
    The Morpho app appends up to 12 bytes to `vaultBundlesV1Deposit` (a timestamp and one or two origin tags) that the contract never reads.
    A template may allow at most 19 bytes, so a whole 20-byte address never fits in a trailer.
    A contract that reads its caller from the last 20 bytes of calldata (ERC-2771) would still take the last argument byte plus a 19-byte trailer as an address, so a template for such a contract declares no trailer.
    A call to a registry contract whose entry declares `ignoresTrailer`, with the reason its code never reads calldata past a call's arguments, may allow up to 64 bytes: the Uniswap app appends a tag of up to 46 bytes to `execute`, and the Universal Router's verified source reads neither `msg.data` nor `calldatasize`.
    Without a declared trailer, any extra byte is `MISMATCH`.
- Floor rules:
  - no unlimited approval, except to a registry contract whose entry declares a standing allowance of that route (see [Standing allowances](data-shapes.md#standing-allowances)): an ERC-20 approval to Permit2, or a Permit2 allowance to Uniswap's Universal Router;
  - no `delegatecall` except to the official MultiSend, and the rules apply again to every call inside it; a call inside it must be a plain call, so a nested `delegatecall`, to a MultiSend or anything else, is refused and no deeper level is unwrapped; a call inside it whose `to` is the zero address is refused in every version, since MultiSend and MultiSendCallOnly 1.5.0 send it to the Safe itself;
  - no owner, module, guard, threshold, fallback handler or implementation change, except an owner or threshold change exactly as the card's one `effects.safe` says.
    A call from the Safe to itself with data is refused unless its function is `addOwnerWithThreshold(address,uint256)`, `removeOwner(address,address,uint256)`, `swapOwner(address,address,address)` or `changeThreshold(uint256)`, so `enableModule`, `setGuard`, `setFallbackHandler`, `setup` and every other call to itself never pass, whatever a template says; those four pass only for a card one of whose operations declares an owner or threshold change, and still change nothing unless a template binds the call.
    The settings are read before and after the transaction in the simulated block.
    For an executed transaction the receipt's events are read: none may name a module, guard, fallback handler or singleton change, and with no `effects.safe` none may name an owner or threshold either.
    With `effects.safe`, its `AddedOwner`, `RemovedOwner` and `ChangedThreshold` events must name only the card's owners and threshold, and the settings must change as declared in a simulation of the transaction alone on its parent block, read as for a transaction to sign;
  - the Safe's own fee fields are all zero: `safeTxGas`, `baseGas`, `gasPrice`, `gasToken`, `refundReceiver`.
    Otherwise a correctly hashed transaction can pay a refund to someone else.
- The mutation check: change each bound field and confirm the template gives `MISMATCH`.
  A share price bound changes to its loosest value, since a stricter one still matches, an `atLeast` bound changes to 0, and an `atMost` bound to the largest value of its type, a transaction's own `value` included.
  A `withinSeconds` time changes to one second past its bound, from the block time the field check used; when that block time was not read, or the value does not fit the field's type, the field changes by one instead, which a bound usually still allows, so the mutation check reports the template weak there.
  A member of a signed message changes in the message, with its digest written again into the transaction.
  Empty constant `bytes`, such as a Uniswap pool's `hookData`, have no byte to change in place and are not changed; any other value is longer, which the field check compares byte for byte.
- The perturbation test, at template build time (`pnpm perturb`, replayed by `pnpm test`): every free field of a recorded test transaction is changed to other values of its type, one at a time (a number to one more, one less and zero; a bool flipped; a fixed-size word with its first byte flipped, and zeroed when it is not zero; `bytes` or a `string` with its first and its last byte flipped; an array with the first byte of its first and of its last word flipped), and each copy is simulated through `execTransaction` on both providers.
  A copy must revert, be refused by the field or effects check, or emit the same logs (the Safe's `ExecutionSuccess`, which names the transaction's hash, aside) with the same balance and allowance changes and the same readings of the views the template reads.
  A field claimed as `proof` must make every copy revert or be refused; a field claimed `unread` must change nothing; a field claimed `route` may also change the logs and the Safe's token amounts, as long as the copy still passes the effects check and leaves the same allowances, ending balances and view readings.
  A copy may also change an allowance the card's template keeps open at any amount (`effects.approves` with `unlimited`), and the log that sets it, such as the expiration of the Universal Router's Permit2 allowance, since the template already allows any value of it.
  Any other outcome fails the template's tests and names the field and the value.
  This catches a free field that grants a Morpho `setAuthorization`, a Permit2 approval or a Safe `approveHash`, all of which show in the logs but not in the balances, and a field that moves value the effects allow, such as a deposit that leaves a wei in the adapter.

  It runs when the template is built, not inside `verify`.
  After the type lint, no free field can carry an address or a call except `bytes` claimed as a proof or unread, and what a free number does is a property of the contract and the template, which the test transactions show, not of one signing.
  Inside `verify` it would cost three or more simulations per free field on two providers at every signing, a dozen extra for a Fluid claim, and every recorded verdict would grow by as much.

  The replay (in `pnpm test` and the report's fixture judgement) trusts only block headers it can check offline.
  Before it simulates anything, every block a `testdata/perturb/` recording holds, as each provider answered it, must hash, as the keccak256 of its RLP-encoded header, to the hash it states, and a block at the height of the executed or parent block must be that block; the block the transaction ran in must name the recorded parent block's hash as its parent; and its number and timestamp must equal the `blockNumber` and `executionDate` the Safe Transaction Service gave for the transaction in its `testdata/safe-tx/` fixture, recorded by another script.
  Otherwise the replay fails, naming the file and the block.
  This ties the block time a `withinSeconds` bound counts from, and the time, gas limit and randomness each copy is simulated with, to the header hash, so a recording edited by hand to move the time fails even when the edit changes every place the time appears.
  `pnpm perturb --record` checks the same before it writes.
  The simulations' answers, the chain's state, cannot be checked offline and stay trusted as recorded.
- Every registry contract the transaction or the card touches must run the code its registry pin names: the Safe transaction's target (such as the MultiSend), each contract a template rule names, inside packed bytes and a signed message's members too, the `verifyingContract` of each message a template signs, such as CoW's settlement contract, each registry contract on the card, each entry a card reference's attribute names, such as a vault's asset, each entry a market on the card names (Morpho Blue, both tokens, the oracle and the interest rate model), the contract of each view the template reads, each token the effects name, each spender of a standing allowance the effects keep, and each entry any of these names in `dependsOn`.
  The program reads, from both providers at the block the transaction runs on (the same block as the vault `asset()` read below), the code at the address, finds a proxy's implementation the way `pnpm prove-abi` does (EIP-1167, the Safe proxy, EIP-1967 implementation or beacon, or the older ZeppelinOS slot USDC uses, or, for an entry that declares `implementationRead`, its views and the probe), and reads that implementation's code, and the code of the extension it hands a call it has no function for to, when it has one (see Establish the ABI, step 3 of [the flow](flow.md#first-time-an-operation-is-done-build-its-template)).
  Code or an implementation that `pnpm prove-abi` refuses as an unknown delegator, or as a fallback it cannot follow, is `MISMATCH`, so a card or transaction that touches the FLUID token is `MISMATCH` until the program can name the code it delegates to; an entry's own code is not refused so when the entry declares `routes`, whose pin names the code each routed selector runs.
  For an entry with `routes` it also reads the routes at that block as `pnpm pin-code` does (see Pin the routes, step 2 of [the flow](flow.md#first-time-an-operation-is-done-build-its-template)) and requires them to equal the pin's.
  Different code, a different implementation, or a contract that started or stopped delegating is `MISMATCH`, with the hash or address read and the one pinned; so are an extension at another address than the pin's, added or gone, or with another code hash, an extension that has no code or hands a call on again, an implementation the seeds reach that the pin does not name, a pinned implementation no seed reaches, another code hash of a routed implementation, a selector added to or gone from its list or the same selectors in another order, and a routes read refused for any other reason than the providers, such as a selector that routes elsewhere than the implementation that lists it.
  A transaction to sign is compared with the current pin only, so code that only an earlier pin names is `MISMATCH`.
  An executed transaction is compared with the pin whose span holds the block its code was read at; a block before the first span's `from` is `MISMATCH`.
  A pin with no `from`, written before ranges, holds from block 0.
  A read the providers do not agree on, and an entry with no pin, are `UNVERIFIABLE`.
  A legitimate upgrade therefore stops verification of new transactions until a pull request pins the new code, and leaves the transactions that ran before it verifiable.
- A vault's `asset` in the registry is written during research.
  For each vault on the card whose `asset` the template relies on, the program reads the vault's `asset()` from both providers at the block the transaction runs on: the latest block for a pending transaction, the block before its receipt's for an executed one.
  It must be the token the registry names, or the verdict is `MISMATCH`; a read the providers do not agree on is `UNVERIFIABLE`.
- Simulation through the Safe's own `execTransaction`, judged by the Safe's balance and allowance changes, not by protocol events.
  Every change to the Safe's balances must be one the template's effects explain, and no allowance from the Safe may end higher than it started, except one the card's template leaves open (`effects.approves`): at no more than its card amount, or at any amount when it keeps it `unlimited`; any other change is `MISMATCH`, whatever else the template says.
  An allowance may fall, as when a migration resets a leftover approval to zero, since a lower allowance lets no one take more than before.
  A transfer explains its payment by its card's recipient and amount; a deposit or a swap must also receive what its effects promise.
- Permit2 allowances are allowances too.
  For every token and spender that a Permit2 `Approval`, `Permit`, `Lockdown` or `NonceInvalidation` event of the Safe's names, the program reads Permit2's `allowance(Safe, token, spender)` (amount, expiration, nonce) before and after the transaction.
  It may fall or expire: one that ends with an amount must end with no larger amount and no later expiration than it started with, or the verdict is `MISMATCH`, unless the card's template keeps it through `permit2`.
  A raised nonce only voids signed permits, so it is shown and not judged.
  An allowance left at 2^160-1, which Permit2 never lowers when it is spent, is refused as unlimited by the floor rules, unless its spender declares a standing allowance through `permit2`.
- View effects.
  For each view a template's effects name, the program calls the view with its bound arguments just before and just after the transaction: for a transaction to sign, in the simulated block beside the balance reads; for an executed one, both at the parent block and at the execution block, and in a simulation of the transaction alone on its parent block, through both providers.
  Each named return value must change as the template says in every reading, or the verdict is `MISMATCH`.
  A view that reverts, that does not decode, or that the providers do not agree on is `UNVERIFIABLE`.
  In the simulated block a view shares state with the transaction, so the program reads it through a `STATICCALL`, from a forwarding contract it places at a fixed address by state override: a function that writes storage or emits a log reverts there, whatever its ABI says, and is `UNVERIFIABLE`.
  A view is read only when a template names one, so a card without views sends the same requests as before.
  The scan of calls that move no asset reads no view: the scan is the same for every template, and a view is template data.
- Calls that move no asset are marked.
  The program runs each call of the Safe transaction, MultiSend unwrapped, as a Safe transaction of its own through `execTransaction`, one after another in one simulated block, and reads the Safe's ETH, every token and every allowance any of them touched between each two.
  A call across which none of these changed moves no asset of the Safe, so whatever it does changes a setting or grants a permission somewhere, such as Morpho's `setAuthorization`.
  The program marks every such call, whatever the template says about it.
  `pnpm simulate` prints the marks when the template is reviewed, and `kiss-sign verify` prints them under the verdict at every signing; a scan that could not be read says so.
  The mark is information, not a check, and never changes the verdict: the call and its arguments are bound by the template's field rules like any other, and only the review can tell a permission the operation needs from one it does not.
  A call to the Safe itself without data is not marked: the floor refuses one with data, and the Safe's `receive` changes nothing.

## Chain access

Every on-chain read uses two providers from different companies.
Both must agree, or the result is `UNVERIFIABLE`.
This covers state reads, code, simulation and receipts.
Some research reads have one source, and none of them reaches a verdict:
- a past transaction's call trace, which only drpc serves free: it counts only when its top call is the transaction both providers give, with the same sender, target, selector and value, and its token transfers and approvals are checked against the receipt both providers agree on, a reverted call left out and a `transferFrom` or `permit` accepted for an `Approval` log;
- the search for past transactions, which takes every transaction either source finds and marks one found by one source only `only <source>`, and an event anchor, which only Etherscan searches;
- an instance's holder candidates, which only the Alchemy Transfers API lists, while each candidate's balance and the total supply are read through both providers.

| Role | Providers |
|---|---|
| State, code, receipts | Alchemy (free key) and drpc |
| Token decimals, during `card new` | Alchemy and drpc |
| Contract code, proxy implementation, and factory instance, during research | Alchemy and drpc |
| Simulation, latest and past blocks | Alchemy and drpc, `eth_simulateV1` |
| A signed message a template reads by its digest, during `verify` | The template's `lookup`, such as CoW's order API; one source is enough, since the program hashes the answer and requires the digest the transaction holds |
| Finding past transactions | Alchemy Transfers API and a second source (Etherscan with a free key), each transaction marked with the sources that found it; Etherscan alone for an event |
| A past transaction's call trace, during research | drpc alone (`debug_traceTransaction` with `callTracer`), its top call checked against the transaction and its token calls against the receipt Alchemy and drpc agree on |

When the system resolver fails, kiss-sign resolves provider hosts over DNS over HTTPS.
TLS certificate checks stay on, so a wrong address can only fail the connection.

Keys enter through `kiss-sign key add alchemy|etherscan|github` in a hidden prompt, or the signer fills in the `$KISS_SIGN_HOME/.env` that `kiss-sign init` creates, with an empty line per key and mode 0600; never through the chat.
`init` never overwrites an existing `.env`.

`GITHUB_TOKEN` is optional and for building templates only.
It is read like the other keys, from the command's environment or `$KISS_SIGN_HOME/.env`, and only by the research commands that ask GitHub's API: `pnpm check-sources`, `pnpm report`, `pnpm pin-solc` and `pnpm fetch-erc7730`, with `pnpm erc7730`, which fetches the ERC-7730 archive on demand.
When it is set, a request to `https://api.github.com` carries `Authorization: Bearer <token>`, which raises GitHub's limit from 60 requests an hour to 5,000; no other host gets it, github.com pages, `raw.githubusercontent.com` and `codeload.github.com` included, and no request to `api.github.com` follows a redirect, so the header cannot reach another host.
Without it every command reads exactly as before.
A token `api.github.com` refuses with HTTP 401, as it does once the token expires, is dropped for that read, which is asked again without it, and the command says once on stderr to replace or remove it.
The token changes how many reads GitHub allows, never what they answer, so a recording, a report and every check come out the same with it or without it, and none of them, nor any log line or error, holds its value.
`verify`, `card new`, `card seal`, `template approve`, `replay` and `pnpm history` never read it; the `git fetch` the self-check runs gets the signer's environment as it is, so a git credential helper that reads `GITHUB_TOKEN` still sees one the signer exported.
`init` writes an empty `GITHUB_TOKEN=` line under a comment saying so; `key add github` enters it in a hidden prompt; the pre-push check refuses its value as it does every key's.
The token to make is a fine-grained one with access to public repositories only, read-only, since every read it raises the limit for is of public data.

### Research services

Services used while building a template, besides the providers above.
None of them is read at signing.

| Service | What is checked with it | By |
|---|---|---|
| The protocol's official site and GitHub organization | Where each contract address is published (step 2) | AI |
| The protocol's own API, when it has one (such as `api.morpho.org`) | The contract's address and what the protocol says about it, such as a vault's curator and asset (step 2) | AI |
| DefiLlama protocol list (`api.llama.fi/protocols`) and parent protocols (`api.llama.fi/lite/protocols2`) | Each registry entry's source domain or GitHub organization against the protocol's listed website and organizations (step 2) | Program, `pnpm check-sources`; the signer judges findings |
| CoinGecko coin page (`api.coingecko.com/api/v3/coins/<id>`) | The protocol coin's homepages and GitHub repositories, as more of the protocol's sites (step 2) | Program, `pnpm check-sources` |
| Immunefi programs (`immunefi.com/public-api/bounties.json`) | The program's website and GitHub organization, and whether its scope holds the entry's address (step 2) | Program, `pnpm check-sources` |
| GitHub organization page (`github.com/<org>`) | The domains GitHub verified the organization controls (step 2) | Program, `pnpm check-sources` |
| npm registry (`registry.npmjs.org`) | An SDK package's tarball against its pinned sha256, its provenance repository, and the address next to its label in one file; the same for its `latest` version, which addresses the label binds there (step 2) | Program, `pnpm check-sources` |
| Etherscan contract-creation API, then Alchemy and drpc | Each entry's creation transaction, proved through both providers, and its sender (step 2) | Program, `pnpm check-sources` |
| DefiLlama protocols and hacks (`api.llama.fi/protocols`, `api.llama.fi/hacks`) | The protocol's TVL, the date it is listed from, and its hacks, shown in the report (step 6) | Program, `pnpm report`; the AI explains each hack |
| Public Suffix List (pinned in `vendor/publicsuffix/`) | Where a host's registrable domain begins, so two sites on one shared host such as `gitlab.io` differ (step 2) | Program, `pnpm check-sources` |
| Each registry entry's `source` page, raw from `raw.githubusercontent.com` for a pinned GitHub file, and that file at the tip of its default branch | The address stands next to the entry's `sourceLabel` on the page as served, and which addresses the label binds in the newest version (step 2) | Program, `pnpm check-sources`; the signer judges findings and the sites per protocol |
| Each registry entry's `apiSource`, such as Morpho's GraphQL API (`api.morpho.org`) | The address at the entry's path in the protocol API's JSON answer equals the entry's, and the API's site is the protocol's (step 2) | Program, `pnpm check-sources`; the AI reads the rest of an answer; the signer judges findings |
| GitHub API (`api.github.com`, with `GITHUB_TOKEN` when it is set) | A pinned GitHub source's commit is on the repository's default branch (step 2) | Program, `pnpm check-sources` |
| CoinGecko coin list (`api.coingecko.com`) | The coin listed at each token's and vault share's Ethereum address against the coin id the entry names (step 2) | Program, `pnpm check-sources`; the signer judges findings |
| Alchemy Transfers API, and Multicall3 through Alchemy and drpc | An instance's declared size, such as a vault's monthly `totalAssets()`, and, for a size that counts holders, its share holders and the ten largest holders' share (step 2) | Program, `pnpm instance-evidence`; the AI judges the history |
| Etherscan contract page | Verified contract name, creator, and creation transaction (step 2) | AI |
| ERC-7730 registry (`github.com/ethereum/clear-signing-erc7730-registry`, an archive pinned by commit and sha256 in `vendor/erc7730/`) | Whether a descriptor applies to each registry entry, by address or by factory, its hashes, its functions and field formats, and its ERC-8176 attestations (step 2) | Program, `pnpm erc7730`; the AI compares the field formats with its own |
| EAS contract on mainnet, through Alchemy and drpc | Each attestation's signer, by the `ecrecover` precompile, and whether the signer revoked it (step 2) | Program, `pnpm erc7730` |
| Etherscan API (`getsourcecode`) and a pinned `solc` | The verified source compiles to the code on chain, and its ABI holds every function the template uses (step 3) | Program, `pnpm prove-abi` |
| Alchemy Transfers API and Etherscan API | Past transactions of the operation (step 4) | Program, `pnpm past-txs`; the AI reads the counts |
| drpc `debug_traceTransaction`, and receipts through Alchemy and drpc | The calls inside each past transaction exactly the template, against the AI's `flow` lines (steps 4 and 6) | Program, `pnpm past-txs` and `pnpm report`; the AI reviews each finding |
| DefiLlama hacks list and post-mortems | Past hacks and incidents (step 5) | AI |
