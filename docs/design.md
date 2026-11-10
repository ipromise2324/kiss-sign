# kiss-sign design

kiss-sign checks a Safe transaction against what the signer meant to do, before the signer signs it on a hardware wallet. The signer states an intent in plain words. An AI researches the operation and writes a reusable template for it. A fixed program runs that template against the proposed transaction and prints `MATCH`, `MISMATCH`, or `UNVERIFIABLE`. The hashes to compare on the hardware wallet print only on `MATCH`.

The rule the whole design keeps: **the AI writes templates, the program runs them.** The verdict is never the AI's judgment. `MATCH` means the transaction matches the template and the card the signer approved. If the AI is fooled during signing, the worst outcome must be `UNVERIFIABLE` or `MISMATCH`, never a wrong `MATCH`. A template that was wrong when the signer approved it is not caught by any check; that risk is carried by the review and its evidence.

## Who does what

| Actor | Does | Never does |
|---|---|---|
| Signer | States intents, reads reports, merges template pull requests, fills and confirms intent cards, confirms address-book entries, proposes on Safe, compares hashes on the hardware wallet | Pastes keys into the chat, runs an AI agent on the signing device |
| AI (any coding agent) | Researches addresses, ABIs and past transactions; writes the report; writes the template; opens the pull request | Merges, fills or seals a card, decides a verdict, runs on the signing device, handles API keys |
| Program (the engine) | Fetches and hashes the Safe transaction, decodes it, runs the template's checks, simulates, compares effects with the card | Reads web pages, follows instructions found in data |

### The standard setup

Two machines, joined only by `main` on GitHub.

| Step | Where | Who |
|---|---|---|
| 1. Research, write the template, open a pull request | A computer with an AI agent | The AI. It never merges. |
| 2. Read the report and the template, approve and merge | GitHub | The signer, through branch protection |
| 3. `git pull`, fill the card with `kiss-sign card new`, seal, verify | A signing device with no AI agent installed | The signer |
| 4. The first time a template or a vault is used, send a small amount first | Safe | The signers |
| 5. Sign, comparing the full hashes | Hardware wallet | The signer |

- With no AI on the signing device, nothing there can rewrite `verify`, the sealed cards, or the approved template hashes. The self-check guards against accidents; the separate device guards against an AI that means harm.
- Branch protection on `main` protects the bridge between the two machines, since the signing device pulls `main`. It requires a pull request approved by the code owner, the signer, and the AI pushes from a GitHub account that cannot approve or merge. Both are GitHub settings the signer makes. On a private repository GitHub offers branch protection only with a paid plan; until it is on, nothing in GitHub stops an AI that can push from merging.
- A small first transaction catches honest mistakes and crude attacks, such as a wrong vault or a template that sends funds elsewhere. It does not catch a contract that behaves differently for large amounts, or one that turns hostile later.
- A permission or parameter change, a call that moves no value, cannot be tested with a small amount. It relies on the program's checks and on the review of its template.

## The flow

![Detailed flow: who acts at each step, what it does, which services it uses, and what it trusts](architecture-detail.png)

Every service or step drawn in `docs/architecture.png` and `docs/architecture-detail.png` has a sentence in this document that says what is checked with it and who checks it, the program or the AI. The text is authoritative: where a picture and the text disagree, the picture is wrong and is redrawn. [Research services](#research-services) lists each service by step.

### First time an operation is done: build its template

1. **State the intent.** For example, "deposit USDC into the Morpho Apex vault." The AI turns it into a concrete operation.
2. **Research addresses.**
   - **Find:** the AI finds the protocol's contracts on its official site and GitHub and cross-checks them across sources.
   - **Protocol API:** when the protocol runs its own public API, such as Morpho's GraphQL API at `api.morpho.org`, the AI queries it as one more source: the contract's address and what the protocol says about it, such as a vault's curator and asset. The AI does this, not the program, because every protocol's API has its own shape; the report quotes the query and the answer. A protocol without an API has no entry here.
   - **Check the sources against public listings:** the program (`pnpm check-sources`) compares each registry entry with two listings. Each entry names its DefiLlama protocol by slug (`defillama`, such as `morpho-blue`). The registrable domain of the entry's `source`, found with a pinned copy of the Public Suffix List including its private section, must equal that of the website DefiLlama lists for the protocol, or, for a github.com source, its organization must be one DefiLlama lists. Each token and vault share names its CoinGecko coin id (`coingecko`, such as `usd-coin`), and CoinGecko must list exactly that coin at the entry's address. A disagreement, a missing listing, a slug DefiLlama lists twice, a protocol with no GitHub organization to compare, or a missing Public Suffix List prints as a finding. The program decides nothing: the AI pastes the output into the report, and the signer judges each finding.
   - **Check each source page:** the same command reads each entry's `source` page as served, without running its scripts, and requires the address next to the text that names the contract or its role on that page, which the entry records as `sourceLabel` (such as `Bundler3`). The address and the label must share one block of the page (a table row, a list item, a paragraph, a line of a text file, or one JSON object's own values with their keys), or the label may stand alone in the block just before, with nothing but punctuation beside it; they must be at most 100 characters apart with no other address between them; in a block that holds other addresses, a label binds to the address after it when the block opens with text (`Name: 0x…, Name: 0x…`) and to the address before it when the block opens with an address (`0x… (Name), 0x… (Name)`); and the address counts only in lowercase or in its EIP-55 checksum. The page counts as a browser shows it with scripts off: scripts, styles, the title, text areas, SVG, templates, comments, an element hidden by its own `hidden`, `aria-hidden="true"` or inline `display:none` or `visibility:hidden` with everything inside it, and every attribute value, even one holding `>`, are left out. An entry may also name `sourceHeading`, text the nearest heading above the address must hold, for a page whose rows name only a chain, such as Circle's `MessageTransmitter` table. An address found only in such hidden text, an attribute or a link target, a page that answers with a redirect, and an entry with no `sourceLabel` are findings. A `source` URL that itself holds the address is a finding and its page is not read, since a page such as `app.morpho.org/ethereum/vault/<address>/…` echoes its own URL. A github.com source must name a file at a commit, `github.com/<org>/<repo>/blob/<40-hex commit>/<path>`; the program reads that file raw at that commit and asks GitHub's compare API whether the commit is behind or identical to the default branch, since GitHub also serves a fork's commit under the official repository's path. An unpinned source, a commit off the default branch, and a GitHub rate limit are findings. The output ends with the sites each protocol's sources use, its registrable domains and GitHub organizations, for the signer to check each is the protocol's own.
   - **Prove on chain:** the program confirms that each address has code, which implementation a proxy points to, and which factory created an instance.
   - **Vault history:** a vault factory such as MetaMorpho's or VaultV2's lets anyone create a vault, and a CREATE2 salt can give it an address that looks like a known vault's. For each vault the program (`pnpm vault-evidence <vault>`) first asks the vault's registry factory, as `pnpm prove-instance` does, whether it created the vault, and reads nothing from a vault the factory does not admit, since the evidence comes from the vault's own code; a vault that names no factory, such as a Fluid fToken, is read with a note that no factory vouches for it. It reads `totalAssets()` every 216,000 blocks (about 30 days) over the last 12 months through both providers; a month they disagree on is `UNVERIFIABLE` and the rest still print. It also counts the share holders at the latest block: every address the Alchemy Transfers API shows receiving shares is a candidate, Multicall3 reads every candidate's `balanceOf` in batches through both providers, and the balances must add up to `totalSupply()`, or the count is `UNVERIFIABLE` because the list is incomplete. It prints the holder count and the share of the ten largest holders, never a holder's address. The program decides nothing: the AI judges whether the assets grew suddenly or were held long, and flags a young or concentrated vault in the report.
   - **Contract name and creator:** the AI reads each address's Etherscan page: the verified contract name, the creator, and the creation transaction. The creator must be the deployer or factory the official source names.
   - **Register:** each verified contract goes into the contract registry under a name.
   - **Pin the code:** the program (`pnpm pin-code`) reads, through both providers at one block they agree on, the code at each registry address and writes its keccak256 into the entry's `code`. Behind a proxy it also writes the implementation the proxy delegates to and that implementation's code hash. The proxy is found the way `pnpm prove-abi` finds it, so the pin names the same code the ABI proof compiled: its `hash` is the proof's `proxyCodeHash` for a proxy and its `codeHash` otherwise, and the implementation's `hash` is the proof's `codeHash`. Immutables are part of the deployed code, so two vaults from one factory can have different pins. The pin goes into the same pull request as the entry, and every signing compares it again (see Engine checks).
   - **ERC-7730:** the AI looks up each contract in the ERC-7730 clear-signing registry. Where a descriptor exists, the program checks who reviewed it: each auditor signs an ERC-8176 attestation for that exact descriptor, and the program verifies the signature offline and reads on chain whether it was revoked (for example with Sourcify's `@ethereum-sourcify/clear-signing` library). The AI renders the studied past transactions with the descriptor and compares its field meanings with its own.

   The descriptor is a second opinion on what each field means. It never becomes a rule by itself, and a field the descriptor hides does not become a free field.
3. **Establish the ABI.** A fixed method, not the AI: fetch the verified source from Sourcify, compile it locally with a pinned `solc`, and compare the result with the bytecode read from chain. For a proxy, compare the implementation. Matching bytecode proves the ABI belongs to the deployed contract.
4. **Study past transactions.** The AI looks at real transactions of the same operation to learn each field's role and the operation's normal shape. The program (`pnpm past-txs`) finds them through Alchemy's Transfers API and Etherscan, decodes each with the template, and counts, per field, the transactions and senders that held its rule; the AI reads the counts and every misfit. These teach the AI. They prove nothing about safety.
   - **Where it looks:** the program, not the AI, picks the blocks: 12 windows of up to 7,200 blocks (about a day), one every 219,000 blocks (a month) back from the head block. The newest window ends on a multiple of 7,200 blocks, so a rerun picks the same windows until the head passes the next multiple. A window holding more transfers than one page of either source is halved, keeping its newer half, until it fits, and the report names the blocks left out. It studies at most 240 transactions (`--max-txs`, at least 12), the same number from each window and spread evenly within it.
   - **Who sent it, by type:** a *proven Safe* is a contract whose whole code, at the block before the transaction, is the Safe proxy one of the official mainnet proxy factories (1.0.0, 1.1.1, 1.3.0, 1.4.1, 1.5.0) deploys, and whose slot 0 names an official Safe singleton (both lists from `safe-global/safe-deployments`). Accepting `execTransaction` and emitting `ExecutionSuccess` proves nothing, since any contract can. A contract called through `execTransaction` that fails either check counts as *a contract, not a proven Safe*, and is not studied further. An *EOA* makes each of the template's calls as its own transaction: a transaction calling the function of one template call, on the contract the call names when it names one, is checked against that call alone, with the sender in the Safe's place. Everything else, such as a call through a router, a 4337 bundle, or an EIP-7702 account batching calls through its own code, is counted with the function it called. The report gives counts per type and the field counts separately for Safes and for EOAs per call.
5. **Check the protocol's health.** The AI looks for anything that makes the protocol unsafe to use right now: past hacks and incidents (for example DefiLlama's hack list and the protocol's own post-mortems), audits, recent upgrades, admin or timelock changes, paused or deprecated contracts. Every claim cites its source.

   This informs the signer's decision; it does not change what the program checks. What the program can read on chain about the code, a changed contract or an upgraded implementation, it checks again at every signing through the registry's code pins. Whether a contract is paused is not read.
6. **Report.** It covers:
   - **Addresses and ABI:** where each address was verified, the protocol API's query and answer when there is one, the `pnpm check-sources` output with every finding, the `pnpm vault-evidence` output for each vault with the AI's reading of it, each contract's Etherscan name and creator, and where each ABI came from.
   - **Fields:** what each field means, which contracts the operation touches, and what the template will check.
   - **Past transactions:** how many were studied and from how many senders of each type, for example "42 past deposits from 31 proven Safes, 60 from 52 EOAs", and for each field what they held: "`receiver` (who gets the vault shares) was the depositing Safe in all 42". That is the evidence behind the rule "`receiver` equals the Safe".
   - **ERC-7730:** whether each contract has a descriptor, its hash, which auditors attested it, whether any attestation is revoked, and where its field meanings differ from the AI's.
   - **Protocol health:** the check from step 5.

   - **Calls that move no asset:** for each call the program marks as moving no asset of the Safe (see [Engine checks](#engine-checks-that-every-template-gets)), what it changes, explained by the AI from the protocol's official documentation with a link to the page. This section is labelled as written by the AI.

   The counts show the template matches normal use. They do not show it is safe, because fake transactions are cheap.
7. **Write the template.** The AI writes a declarative template (below) and its test transactions, and opens a pull request with the template, the report, and the tests. It never merges. For each test transaction with a free field, the program (`pnpm perturb`) runs the perturbation test below and records it, so CI replays it.
8. **Signer reviews the pull request.** The signer reads the report and the template's rules on GitHub and asks for changes. Approving and merging the pull request is the confirmation. On the signing device, `kiss-sign template approve` records the hash of the merged template locally.

### Every signing

Every signing runs on the signing device, with no AI involved.

9. **Fill the card.** The signer runs `git pull`, then `kiss-sign card new <protocol>/<operation>`, for example `morpho/vault-deposit` to deposit into Steakhouse USDC. For each card value the template needs, the prompt lists the registry entries of the right kind, the address-book entries, or the Safe by number, each with its name and full address, and the signer picks one; an amount or a limit is typed as a base-unit integer, and the prompt names the token it counts. A card with several operations names several templates.
10. **Seal it.** The program prints the card with every full address, and on the signer's yes hashes it and stores it in `$KISS_SIGN_HOME`, before the signer sees the Safe transaction. `kiss-sign card seal` does the same for a card written as a file. The template is not reviewed again; only the card's values are.
11. **Propose on Safe.** kiss-sign reads the transaction from the Safe Transaction Service, or the signer pastes it. kiss-sign recomputes every hash itself.
12. **Verify.** The program decodes the transaction with the template, checks every field, mutates the transaction to confirm the template catches changes, simulates it, and compares the Safe's net effects with the card. It also lists the calls that move no asset of the Safe, next to the verdict.
13. **Small amount first.** The first time a template or a vault is used, the card from step 9 names a small amount. The full amount gets a new card once the small transaction has settled as expected.
14. **Sign.** On `MATCH`, the signer compares the domain hash and message hash on the hardware wallet's screen, then signs. Any hardware wallet that shows both hashes for a Safe transaction works.

## Data shapes

### Template

A template describes one operation for one protocol, for example `morpho/vault-deposit`. It is data, not code.

- `contracts`. Each contract is named from the contract registry, which holds its address, the source that names it, and its code pin.
- `calls`. The call tree the Safe makes, with MultiSend unwrapped. Each call names its target contract and its function signature, or says its data is empty, as a plain ETH transfer or a cancellation sends. The last call may say, with a reason, that it `merge`s: the card's operations then share it, as the Morpho app puts several vaults' withdrawals into one `multicall`, or the Merkl app several reward tokens into one `claim`'s parallel arrays. Each merged call is made once, after every other call, with each operation's items in card order.
- `fields`. A rule for every argument. One of:
  - equals a card value (`amount`, `vault`);
  - equals the Safe;
  - equals a named contract;
  - equals a constant. A constant address is only the zero address, and constant `bytes` or a constant string is only empty, so no address-typed value or call is written into a template without a registry name. The lint goes by declared type: a free or constant `uint160`, `uint256` or `bytes32` that a contract reads as an address is not caught by type, and is left to review and the perturbation test;
  - equals the number the transaction holds at an earlier template path (`equals`), as a migration's share transfer must equal its approval;
  - a share price bound, at least as strict as the price a card amount per a card amount or an earlier field gives (`maxSharePrice`, `minSharePrice`; see Intent card);
  - free, with a written reason. The mutation check treats free fields as free.

  Template load walks every argument's whole type, through tuples, arrays and decoded calls, and refuses a template that breaks these rules:
  - An address, wherever it sits, is bound to the Safe, a card value or a registry contract, or is the zero address. It is never free, and neither is a tuple or an array that holds one; bind its parts with `fields` and `items`.
  - A tuple is never free as a whole.
  - A number, a bool or fixed-size bytes may be free with a reason: `{"free": "<why>"}`.
  - `bytes`, a string or an array of those leaves may be free only with a claim the template's tests check: `{"free": {"proof": "<why>"}}` when the contract reverts unless it verifies the value against what it already holds, such as a Merkle proof against a root or a CCTP message against Circle's attesters, or `{"free": {"unread": "<why>"}}` when the contract never reads it, such as the permit data of a VaultBundles deposit whose permit kind is bound to none. Free bytes could carry a whole call or an address, so they need one of these two claims, and the claim is what the perturbation test checks.
- `nonce`. Optional: a rule for the Safe transaction's own nonce, such as a cancellation's card nonce.
- `same`. Optional: card references that must name one address, such as the assets of the two vaults in a migration. A card where they differ is refused before any check runs.
- `effects`. What the Safe gives and gets, in tokens and amounts written as card values, `positive` (more than nothing, in the direction of the side), or, for what the Safe gives, `all` (the Safe holds none of the token afterwards). Native ETH is named `eth`, since no contract holds it, so `eth` and `safe` are never registry or address-book names. What the Safe gives may name its receiver; giving to the Safe itself changes nothing. Approvals must be exact and spent in the same transaction.

### Intent card

The operation id plus this signing's values. The template is reviewed once; the card is the only thing the signer confirms at every signing. So the card holds only what changes between signings, and every other value is bound once, somewhere the signer already reviewed.

Where each value comes from:

| Source | Confirmed | Examples |
|---|---|---|
| Template | Once, when the signer reviews the template | Target contracts, `receiver` and `owner` equal the Safe, the spender of an approval equals a named contract |
| Contract registry | Once per contract, during research (step 2) | Each Morpho vault, each Fluid fToken, routers |
| Address book | Once per address, by the signer | An external recipient of a transfer |
| Config | Once, at `init` | The Safe, the chain |
| The Safe, read on chain | By the program, every signing | The nonce |
| Card | By the signer, every signing | Amounts, which vault, swap limits, which address-book entry receives a transfer |

An address on the card is never typed by the AI. It is a name from the contract registry or the address book, or the Safe itself. The card shows the name and the full address, and the program resolves the name.

Card values per operation, covering the operations in the Safe's history:

| Operation | Card values | Bound by the template |
|---|---|---|
| Transfer ETH or a token | token, amount, recipient | none |
| Deposit into a vault (Morpho, Fluid) | vault, amount; for Morpho, the fewest shares to receive | the asset is the vault's asset; receiver is the Safe; the approval is exact and goes to the vault; Morpho's price bound guarantees at least the card's shares |
| Withdraw or redeem from a vault | vault, amount or `all` (two templates); for Morpho, the most shares to burn, or for `all` the fewest assets to receive | receiver and owner are the Safe; Morpho's price bound guarantees the card's limit |
| Move all of one Morpho vault into another | both vaults, the fewest assets to redeem, the fewest new shares to receive | the two vaults share one asset; each price bound guarantees its card limit |
| Claim rewards (Fluid, Merkl, Morpho) | reward token | recipient is the Safe; amount and proof are free; the Safe gives nothing and receives only the reward token |
| Receive USDC through CCTP | token, amount | the target is Circle's MessageTransmitter; the message and attestation are free; the Safe gives nothing and receives exactly the amount of the token |
| Swap through a router (Uniswap, Odos) | sell token, sell amount, buy token, minimum buy amount | recipient is the Safe; the router is a named contract |
| Cancel a queued transaction | the nonce to replace | 0 ETH to the Safe itself, no data |

- One Safe transaction can batch several operations, for example withdrawing from two vaults. The card then lists each operation with its values, and the MultiSend must contain exactly those calls. An approval belongs to the operation that spends it, not to its own line.
- Swap limits are stated as a minimum amount, not a slippage percentage, so the program never needs a price. The signer types the number.
- A vault's slippage limit is stated the same way, as an amount the signer can compare with the app's preview: the fewest shares a deposit gets (`min-shares`), the most shares a withdrawal of an amount burns (`max-shares`), or the fewest assets a withdrawal of all gets (`min-assets`). Slippage protection acts when the transaction runs, which no simulation before it can see, so the transaction's own bound must carry the card's limit. A Morpho adapter takes the bound as a price in assets per share scaled by 1e27; the template binds it with `maxSharePrice` or `minSharePrice`, and the field check requires it to be at least as strict as the price the card's amounts give. For a deposit of 1,800,000.000180 USDC with `min-shares` 1,741,863.305677219101283940, `maxSharePriceE27` must be at most 1800000000180 × 10^27 / 1741863305677219101283940. A stricter bound matches too; a looser one is `MISMATCH` at that field. Where the share count is the Safe's whole balance, as in a withdrawal of all, the bound is checked against the share count the transaction states, and a transaction that states 2^256-1 (the whole balance, read when it runs) is `MISMATCH`, since its bound then guarantees nothing.
- A recipient that is not the Safe must already be in the address book. Adding an entry is a separate step, done before signing, where the signer checks the full address against a source outside the chat.

Sealed means hashed and stored where the AI cannot write.

### Verdict file

Every input the verdict used, so `replay` can recompute it offline: the Safe transaction as given, the sealed card's text and hash, each template's text with its approved hash, the contract registry and the address-book entries the card names, all read at the origin/main commit the self-check passed on, and every request sent to the two providers with each one's answer. `replay` runs the same checks on these alone and reports whether the verdict, and the list of calls that move no asset, are the ones recorded. A verdict file from before that list was recorded has an older format and is refused.

## What goes on GitHub

Templates are reviewed once and reused, so they live in git, where every change is a diff someone reviewed. The evidence behind each template goes with it.

| Published in the repository | Kept local, in `$KISS_SIGN_HOME` |
|---|---|
| Templates: what each operation checks | Config: the Safe address, providers, API keys |
| Reports: where every address and rule came from | Address book |
| Test transactions | Intent cards and verdict files |
| Contract registry | Approved template hashes |

- Each operation has a folder, for example `templates/morpho/vault-deposit/`, holding `template.json`, `report.md`, and `tests/`.
- The tests are real past transactions of the operation, each with the card values it implies. Every one must give `MATCH`, and every mutated copy must give `MISMATCH`. CI (`.github/workflows/test.yml`, GitHub Actions) runs `pnpm typecheck` and the whole offline test suite on every push and pull request, with every action pinned by commit. It holds no secrets: the tests replay recorded chain answers, including recorded simulations, so live simulation and every live read run locally.
- `.github/CODEOWNERS` names the signer as owner of `src/`, `bin/`, `package.json` and `pnpm-lock.yaml`. It binds only once branch protection requires code-owner review and the AI pushes from an account other than the signer's; both are GitHub settings the signer makes.
- Git stores and records; it is not trusted. At signing, the program checks that the template's hash equals the hash recorded when the signer merged it. A template from someone else's repository is only a starting point: its report still has to be reviewed.

### The Safe's address is never published

Published files would otherwise tie the Safe, its balances, and its history to whoever owns the repository.

- Templates refer to "the Safe", never to an address.
- Test transactions come from other senders. The signer's own Safe is excluded when searching for past transactions.
- Reports count senders but list no Safe of the signer's.
- Before every push, a check greps the outgoing commits for the configured Safe address and for API keys, and must find nothing.

## Engine checks that every template gets

These are protocol-free and change rarely.

- The Safe transaction hashes, computed locally.
- Decode, then re-encode byte for byte, so nothing hides in the encoding.
  - One exception, declared per call in the template: a trailer of at most a stated number of bytes after the arguments, with a written reason. The Morpho app appends 8 bytes to `multicall` (a timestamp and an origin tag) that the contract never reads, and up to 12 to `vaultBundlesV1Deposit`. A template may allow at most 19 bytes, so a whole 20-byte address never fits in a trailer. A contract that reads its caller from the last 20 bytes of calldata (ERC-2771) would still take the last argument byte plus a 19-byte trailer as an address, so a template for such a contract declares no trailer. Without a declared trailer, any extra byte is `MISMATCH`.
- Floor rules:
  - no unlimited approval;
  - no `delegatecall` except to the official MultiSend, and the rules apply again to every call inside it, at every level;
  - no owner, module, guard, threshold, fallback handler or implementation change;
  - the Safe's own fee fields are all zero: `safeTxGas`, `baseGas`, `gasPrice`, `gasToken`, `refundReceiver`. Otherwise a correctly hashed transaction can pay a refund to someone else.
- The mutation check: change each bound field and confirm the template gives `MISMATCH`. A share price bound changes to its loosest value, since a stricter one still matches.
- The perturbation test, at template build time (`pnpm perturb`, replayed by `pnpm test`): every free field of a recorded test transaction is changed to other values of its type, one at a time (a number to one more, one less and zero; a bool flipped; bytes, a fixed-size word or an array item with its first or last byte flipped), and each copy is simulated through `execTransaction` on both providers. A copy must revert, be refused by the field or effects check, or emit the same logs (the Safe's `ExecutionSuccess`, which names the transaction's hash, aside) with the same balance and allowance changes. A field claimed as `proof` must make every copy revert or be refused; a field claimed `unread` must change nothing. Any other outcome fails the template's tests and names the field and the value. This catches a free field that grants a Morpho `setAuthorization`, a Permit2 approval or a Safe `approveHash`, all of which show in the logs but not in the balances, and a field that moves value the effects allow, such as a deposit that leaves a wei in the adapter.

  It runs when the template is built, not inside `verify`. After the type lint, no free field can carry an address or a call except `bytes` claimed as a proof or unread, and what a free number does is a property of the contract and the template, which the test transactions show, not of one signing. Inside `verify` it would cost three or more simulations per free field on two providers at every signing, a dozen extra for a Fluid claim, and every recorded verdict would grow by as much.
- Every registry contract the transaction or the card touches must run the code its registry pin names: the Safe transaction's target (such as the MultiSend), each contract a template rule names, each registry contract on the card, and each entry a card reference's attribute names, such as a vault's asset. The program reads, from both providers at the block the transaction runs on (the same block as the vault `asset()` read below), the code at the address, finds a proxy's implementation the way `pnpm prove-abi` does (EIP-1167, the Safe proxy, EIP-1967 implementation or beacon, or the older ZeppelinOS slot USDC uses), and reads that implementation's code. Different code, a different implementation, or a contract that started or stopped delegating is `MISMATCH`, with the hash or address read and the one pinned. A read the providers do not agree on, and an entry with no pin, are `UNVERIFIABLE`. A legitimate upgrade therefore stops verification until a pull request pins the new code.
- A vault's `asset` in the registry is written during research. For each vault on the card whose `asset` the template relies on, the program reads the vault's `asset()` from both providers at the block the transaction runs on: the latest block for a pending transaction, the block before its receipt's for an executed one. It must be the token the registry names, or the verdict is `MISMATCH`; a read the providers do not agree on is `UNVERIFIABLE`.
- Simulation through the Safe's own `execTransaction`, judged by the Safe's balance and allowance changes, not by protocol events. Every change to the Safe's balances must be one the template's effects explain, and no allowance from the Safe may end higher than it started; any other change is `MISMATCH`, whatever else the template says. An allowance may fall, as when a migration resets a leftover approval to zero, since a lower allowance lets no one take more than before. A transfer explains its payment by its card's recipient and amount; a deposit or a swap must also receive what its effects promise.
- Permit2 allowances are allowances too. For every token and spender that a Permit2 `Approval`, `Permit`, `Lockdown` or `NonceInvalidation` event of the Safe's names, the program reads Permit2's `allowance(Safe, token, spender)` (amount, expiration, nonce) before and after the transaction. It may fall or expire: one that ends with an amount must end with no larger amount and no later expiration than it started with, or the verdict is `MISMATCH`. A raised nonce only voids signed permits, so it is shown and not judged. An allowance left at 2^160-1, which Permit2 never lowers when it is spent, is refused as unlimited by the floor rules.
- Calls that move no asset are marked. The program runs each call of the Safe transaction, MultiSend unwrapped, as a Safe transaction of its own through `execTransaction`, one after another in one simulated block, and reads the Safe's ETH, every token and every allowance any of them touched between each two. A call across which none of these changed moves no asset of the Safe, so whatever it does changes a setting or grants a permission somewhere, such as Morpho's `setAuthorization`. The program marks every such call, whatever the template says about it. `pnpm simulate` prints the marks when the template is reviewed, and `kiss-sign verify` prints them under the verdict at every signing; a scan that could not be read says so. The mark is information, not a check, and never changes the verdict: the call and its arguments are bound by the template's field rules like any other, and only the review can tell a permission the operation needs from one it does not. A call to the Safe itself without data is not marked: the floor refuses one with data, and the Safe's `receive` changes nothing.

## Chain access

Every on-chain read uses two providers from different companies. Both must agree, or the result is `UNVERIFIABLE`. This covers state reads, code, simulation, receipts, and the search for past transactions.

| Role | Providers |
|---|---|
| State, code, receipts | Alchemy (free key) and drpc |
| Contract code, proxy implementation, and factory instance, during research | Alchemy and drpc |
| Simulation, latest and past blocks | Alchemy and drpc, `eth_simulateV1` |
| Finding past transactions | Alchemy Transfers API and a second source (Etherscan with a free key) |

When the system resolver fails, kiss-sign resolves provider hosts over DNS over HTTPS. TLS certificate checks stay on, so a wrong address can only fail the connection.

Keys enter through `kiss-sign key add <provider>` in a hidden prompt, never through the chat. They live in `$KISS_SIGN_HOME/.env` with mode 0600.

### Research services

Services used while building a template, besides the providers above. None of them is read at signing.

| Service | What is checked with it | By |
|---|---|---|
| The protocol's official site and GitHub organization | Where each contract address is published (step 2) | AI |
| The protocol's own API, when it has one (such as `api.morpho.org`) | The contract's address and what the protocol says about it, such as a vault's curator and asset (step 2) | AI |
| DefiLlama protocol list (`api.llama.fi/protocols`) | Each registry entry's source domain or GitHub organization against the protocol's listed website and organizations (step 2) | Program, `pnpm check-sources`; the signer judges findings |
| Public Suffix List (pinned in `vendor/publicsuffix/`) | Where a host's registrable domain begins, so two sites on one shared host such as `gitlab.io` differ (step 2) | Program, `pnpm check-sources` |
| Each registry entry's `source` page, raw from `raw.githubusercontent.com` for a pinned GitHub file | The address stands next to the entry's `sourceLabel` on the page as served (step 2) | Program, `pnpm check-sources`; the signer judges findings and the sites per protocol |
| GitHub API (`api.github.com`, no token) | A pinned GitHub source's commit is on the repository's default branch (step 2) | Program, `pnpm check-sources` |
| CoinGecko coin list (`api.coingecko.com`) | The coin listed at each token's and vault share's Ethereum address against the coin id the entry names (step 2) | Program, `pnpm check-sources`; the signer judges findings |
| Alchemy Transfers API, and Multicall3 through Alchemy and drpc | A vault's monthly `totalAssets()`, its share holders, and the ten largest holders' share (step 2) | Program, `pnpm vault-evidence`; the AI judges the history |
| Etherscan contract page | Verified contract name, creator, and creation transaction (step 2) | AI |
| ERC-7730 registry | Whether a descriptor exists and what it says each field means (step 2) | AI; the program checks its attestations |
| Sourcify and a pinned `solc` | The ABI compiles to the code on chain (step 3) | Program, `pnpm prove-abi` |
| Alchemy Transfers API and Etherscan API | Past transactions of the operation (step 4) | Program, `pnpm past-txs`; the AI reads the counts |
| DefiLlama hacks list and post-mortems | Past hacks and incidents (step 5) | AI |

## The program checks itself first

kiss-sign runs from one clone of this repository. `kiss-sign verify` starts with a self-check before anything else:

1. Every URL of `origin` must be the official repository, `github.com/ipromise2324/kiss-sign`, in its https or ssh form. The URL is read with the same git config the fetch uses, after any `url.<base>.insteadOf` rewrite. An origin elsewhere is not fetched.
2. Fetch `main` from `origin` into `origin/main`, ignoring any configured fetch refspec, which could map another branch there.
3. Every object of that commit, the commit itself, its trees and its files, must hash to its name. Git does not check this when it reads an object, so a rewritten object file would otherwise change a template or the registry read from it.
4. The local checkout must be exactly `origin/main`: `HEAD` at that commit, every file of the commit on disk with the same bytes and mode, hashed from disk rather than asked of `git status`, and no other file that the commit's root `.gitignore` does not ignore. The index, `.git/info/exclude`, `core.excludesFile`, attributes, filters, stat settings and an untracked `.gitignore` take no part in this step.
5. If anything differs, stop and name the files. Nothing is verified.

Templates are read from that commit, so a template counts only after its pull request is merged. `main` changes only through pull requests.

This catches accidental edits and an AI that was tricked into changing a check or a template. It cannot catch an AI that deliberately rewrites both a check and the self-check itself, because the self-check is part of the same program. See Known limits and Later security upgrades.

## Optional hardening: an AI on the signing device

The standard setup keeps every AI agent off the signing device. A signer who runs one there anyway needs `verify`, `card new`, `card seal` and `template approve` to run from a clone and a `$KISS_SIGN_HOME` that no AI session can write. The self-check runs inside the program it checks, so it cannot be that lock.

For Claude Code, `kiss-sign managed-settings` prints a managed-settings file as JSON, with the clone it runs from and the resolved `$KISS_SIGN_HOME` filled in, and prints on stderr the `sudo` commands that install it. The signer installs it once, from their own terminal. kiss-sign never installs it. Managed settings sit above every user, project and local setting, and a file owned by root cannot be edited without `sudo`. The file sets:

- `permissions.disableBypassPermissionsMode: "disable"`, so no session runs without permission checks;
- `permissions.deny` with `Edit(//<clone>/**)`, `Read(//<clone>/**)`, `Edit(//<home>/**)`, `Read(//<home>/**)` and `Read(~/.kiss-sign/.env)`, where `//` marks an absolute path;
- `sandbox.enabled`, `sandbox.failIfUnavailable` and `sandbox.allowUnsandboxedCommands: false`, so every shell command runs in the sandbox, which also enforces the deny rules on scripts, and Claude Code refuses to start when the sandbox cannot run.

With it installed, the AI works in a different clone and opens pull requests from there. The deny rules also keep the AI's scripts from reading the API keys in `$KISS_SIGN_HOME/.env`, so a research script that needs a key runs in the signer's own terminal. It covers Claude Code only; another agent needs its own equivalent. A separate OS account for signing, which the AI's account cannot read or write, is a stronger middle ground.

## Known limits

- Etherscan name tags (labels such as "Morpho: Bundler3") are not used. Etherscan offers no free API for them. The verified contract name and the creator, read from the contract's Etherscan page, are used instead.
- DefiLlama and CoinGecko are aggregators that take listing requests, so `pnpm check-sources` agreeing is supporting evidence, not proof. It finds the registrable domain with the Public Suffix List plus `medium.com`, `mirror.xyz` and `substack.com`; a shared host on neither still looks like one site. Every report line prints what it compared, or says that nothing was compared and why.
- `pnpm check-sources` reads a page the way a browser shows it with scripts off. A page that renders its addresses with JavaScript shows none of them, and its entries stay findings until a source that serves the text is found. It reads no stylesheet, so an address a stylesheet hides, such as with a class whose rule is `display:none`, still counts as shown. An element hidden by its own attributes whose end tag the page leaves out hides the rest of the page, which can only turn an agreement into a finding. Within a block, the label and the address only need to be close: a page that writes another contract's name next to the address, or an AI that picks a label from the wrong row of a block holding no other address, still agrees. The `sourceLabel` and `sourceHeading` are chosen by the AI and reviewed by the signer with the registry entry.
- The GitHub API allows 60 requests an hour without a token; each pinned repository and commit costs two. Past that, every GitHub line is a finding until the hour passes.
- No free API lists a token's holders: Etherscan's `tokenholderlist`, `tokenholdercount` and `topholders` are API Pro endpoints, and Alchemy has no holder list for ERC-20 tokens. `pnpm vault-evidence` takes its candidates from the Alchemy Transfers API alone; the sum against `totalSupply()` catches a missing holder but not a source that invents none. It counts addresses, not owners, so one owner's many wallets count as many, and a vault with more than 300,000 share transfers gets no holder count. `totalAssets()` is sampled once a month, so a deposit and withdrawal between two samples does not show. Linking holder wallets, such as by a common gas funder, is not built.
- drpc routes requests to third-party nodes, including public ones. Its independence from Alchemy is not proven.
- Two providers stop one lying provider, not two that collude or share a backend.
- Simulating an executed transaction on the parent block is not its exact pre-state, because earlier transactions in its block also changed state. For executed transactions, receipts read from two providers are the source of truth.
- The self-check runs inside the program it checks. An AI with shell access that deliberately rewrites both the program and its self-check is stopped by keeping every AI off the signing device, the standard setup. A signer who runs an AI there anyway relies on the managed-settings file, which covers only Claude Code.
- The hardware wallet shows only the two hashes, not the decoded transaction. ERC-7730 clear signing does not yet cover Safe MultiSend batches.
- A template is only as good as its review. The mutation check and the simulation are the backstops.
- The v1 templates were written and merged by the AI without human review. The signer reviews them during final testing.
- The perturbation test samples a few values per free field on recorded transactions. A contract that treats one rare value of a free number differently, chosen by an attacker at signing, is not found by it; the lint keeps such a field to a number, never an address or a call. Empty `bytes`, such as the VaultBundles permit data, has no byte to change in place, so its `unread` claim is not exercised. CCTP's message and attestation are claimed `proof` but have no recorded transaction to perturb, since no Safe received a CCTP message in a transaction of its own in the searched blocks.
- The perturbation test compares logs and the Safe's measured effects, so a changed free field that only writes storage without an event looks the same. A free field with nothing to change, such as empty bytes or an empty array, gets no run, and the report does not flag it.
- For an executed transaction, the Safe's ETH change is its balance at the execution block minus its balance at the parent block, since no log shows ETH sent as the value of `execTransaction` itself. Another transaction in the same block that moves the Safe's ETH changes that number too; the field checks still bind the value of every call the Safe makes.
- For an executed transaction, a card that gives `all` of a token reads the Safe's balance of it at the parent block and at the end of the execution block, and is `UNVERIFIABLE` unless the two differ by exactly this transaction's change. Two other transactions in that block whose changes to the token cancel out go unnoticed.
- For an executed transaction, the floor rules on the Safe's settings read the receipt's events. A storage write without an event shows only in a simulation. The static floor refuses a delegatecall from the Safe itself, but a call to an already enabled module can still make one through `execTransactionFromModule`.
- The static floor refuses an ERC-20 approval only at or above 2^255, and a Permit2 approval only at the uint160 maximum. A token-specific sentinel such as 2^96-1 (UNI, COMP) passes the floor; the effects check refuses any measured allowance, ERC-20 or Permit2, that ends above its value before the transaction.
- Not yet seen by effects: an NFT `setApprovalForAll`, ERC-1155 balances and approvals, Aave's `approveDelegation`, Compound Comet's `allow`, and allowances in the Safe AllowanceModule. A change to any of them moves no balance the program measures. Permit2 is read only at its canonical address. A transaction that lets the Safe accept EIP-1271 signatures moves no allowance now but enables a later `permit`; the floor rules already refuse the usual routes, a delegatecall to SignMessageLib and a fallback handler change. The static floor refuses `setApprovalForAll` when it is set, and a call that changes only one of them is marked as moving no asset.
- The mark on calls that move no asset is per call the Safe makes. A call that moves an asset and also grants a permission, such as a `multicall` that deposits and authorizes, is not marked. Each call runs as its own Safe transaction, so a contract that reads the Safe's nonce or the transaction's origin can act differently than in the real batch; a call that does not execute that way makes the scan unreadable, which `verify` prints. For an executed transaction the scan is a simulation on the parent block, not its exact pre-state.
- The official repository URL is a constant in the program, so an AI that repoints `origin` to a fork whose program accepts that fork passes the self-check. The self-check's git calls take no `GIT_*` variable from the caller, follow no git replace ref, run no hook and ask no fsmonitor; all but the fetch and the origin URL read only the clone's own git config. The fetch reads the system and global config too, since a private repository needs the signer's credential helper there. So git config, in the clone or global, that runs a program or reroutes the connection during the fetch, such as `core.sshCommand`, a credential helper, a proxy or a turned-off TLS check, can run code or serve another repository under the official URL; keeping the AI off the signing device, or else the managed-settings file, keeps it from writing the clone's git config; the managed-settings file does not name the global one. The self-check does not check code the root `.gitignore` ignores, such as the root `node_modules/`; an ignored directory counts only at the root, so `src/node_modules/` is named. It refuses a clone whose git directory is not its own `.git`, such as a linked worktree, so the signing clone is a plain `git clone`. It also refuses git replace refs. It checks the clone once, so code that rewrites the clone or its objects after the check, while the program runs, is not caught. `template approve` and `history` fetch through the same origin check and object check, and `history` falls back to the local `origin/main`, unchecked, when the fetch fails.
- `replay` trusts the verdict file it is given. It shows what a recorded verdict was based on; it is not permission to sign.
- When the code on chain ends in a metadata trailer without a source hash, as solc writes with `bytecodeHash: "none"`, matching bytecode proves the ABI's selectors and types but not its parameter names, since no byte on chain depends on them.
- When Sourcify holds only a partial match, the source compiles to the code on chain except the IPFS metadata hash, which hashes the source text. The proof masks that hash, so it too proves the ABI's selectors and types but not its parameter names.
- The simulation reads at most 50 modules. A Safe with more is `UNVERIFIABLE`.
- A code pin covers the code a call runs, not the contract's storage. A contract that changes its behavior by a storage switch in its own code keeps its pin: USDT forwards every call to another contract once its owner sets `deprecated`. Settings an admin can change, such as a vault's curator, fees or caps, are not pinned either.
- Only registry entries are code-checked. A contract the transaction reaches without being one is not: Morpho Blue and the oracles and interest rate models behind a vault, Fluid's Liquidity layer (a proxy that keeps its implementation in a slot of its own), the adapters of a Morpho Vault V2, and the Safe's own singleton, fallback handler and guard. For the Safe's settings the floor rules check only that the transaction does not change them.
- Each entry holds one pin, the code of the day it was pinned. `verify` and `pnpm history` read code at the block the transaction ran on, so a past transaction that ran before a legitimate upgrade is `MISMATCH` (contract-code). On the configured Safe's history this turns the Merkl claim rows into `MISMATCH`, since merkl-distributor's implementation has changed since. Whether to keep older pins, each for the block range its code ran in, is open for the signer to decide.
- A proxy is recognized only by EIP-1167, the Safe proxy, the EIP-1967 implementation and beacon slots, and the ZeppelinOS slot. A proxy that keeps its implementation anywhere else is pinned by its own code only, so an upgrade it makes is not seen.
- Local registry entries for `pnpm history` (`$KISS_SIGN_HOME/history/registry.json`) are pinned with `pnpm pin-code --history`. A history row that touches an unpinned local entry is `UNVERIFIABLE`.
- `pnpm prove-abi` does not prove the ABI of USDT or of USDC's implementation, since their sources need solc 0.4.18 and 0.6.12, which are not pinned. Their code is pinned all the same, so a change after the pin is caught even though the pinned code was not compiled from source.
- Safe 1.1.1 has no `getStorageAt`, so a simulation cannot read its settings, and a pending transaction of a 1.1.1 Safe is at best `UNVERIFIABLE`.

## Later security upgrades

Not built now. Listed so the path is clear.

- **Light client (Helios).** Verifies every read against the beacon chain, so one provider is enough. Needs `eth_getProof` (Alchemy has it) and a local EVM to simulate on proven state.
- **Local simulation (anvil).** Free and open source. Adds execution diversity. On its own it trusts the same RPC state.
- **A paid or third provider.** Removes rate and range limits and adds an independent source.
- **Clear signing on the wallet (ERC-7730).** Export templates as display descriptors so the device shows the decoded call. Wait until wallets decode Safe MultiSend batches; until then, hash comparison stays.

## Next phase: CoW orders

A CoW order is not a swap inside the Safe transaction. The transaction only pre-signs an order (`setPreSignature`) and sets an approval; a solver settles the order later. So the order's sell and buy limits, receiver, and expiry live in the order, not in the transaction's effects, and the approval is not spent in the same transaction. Supporting it needs its own rules: rebuild the order from its uid, check every order field against the card, and allow the approval to stay open until the order settles or expires.

## Out of scope

EOA signing, off-chain EIP-712 signatures, and chains other than Ethereum mainnet.
