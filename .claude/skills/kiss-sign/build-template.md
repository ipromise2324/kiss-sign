# Build a template: how

How to do each step of [Build a template](SKILL.md#build-a-template) except step 2 ([addresses.md](addresses.md)) and step 8 ([notes-and-reviews.md](notes-and-reviews.md)).
After each step, and before each command that usually takes over a minute, run `pnpm progress <protocol>/<operation>` and tell the signer one line, as [Set up](SKILL.md#set-up) step 5 says.
While a long command runs in the background, do the next steps that do not need its output, as [Build a template](SKILL.md#build-a-template) lists them, and wait only when nothing else is left.
The design of each step is in [First time an operation is done](../../../docs/design/flow.md#first-time-an-operation-is-done-build-its-template), whose steps are numbered differently; find them by name.

## Decide from evidence

Never ask the signer about these before research, except which contract or market the sentence means when it fits several (Questions below).

- **Route.** Whether the Safe calls the protocol directly or through its bundler or router follows from the contracts, the protocol's own app, and what real Safes do in `pnpm past-txs`.
  One sentence of the signer's may reach the protocol by more than one route, each a different call shape, such as a swap through a hook pool or a plain pool, or one router action against another (`SWAP_EXACT_IN` against settle and take).
  Find which one the protocol's own app is expected to send for this sentence, with evidence: the app's or its SDK's default, pinned to a commit ([Pinned source links](notes-and-reviews.md#pinned-source-links)), and which route recent transactions of the app took (`pnpm past-txs`, `pnpm decode-tx`).
  When the evidence leaves several routes the app may send, ask the signer which, with your recommendation, before building the parts that depend on it (Questions below).
  Build that route first, and another only when `verify` gives `MISMATCH` on a real transaction of the signer's because it took that other route.
  Tell the signer in plain words what the routes are, which one the template covers and why, and that a transaction by another route gets `MISMATCH`, so they ask for the next template then; say the same in a `judgments` note of `notes.json` and in [Tell the signer](#tell-the-signer)'s next steps.
- **Steps it needs first.** An operation may need one-time steps before it, such as approving a token or allowing a router.
  The app sends them in the same MultiSend or as transactions of their own.
  Before you draft any template, find these steps in the app's code or docs, or in the past transactions you decode anyway.
  Then read the configured Safe's state to see which steps it has done.
  Take the Safe from `$KISS_SIGN_HOME/config.json` and read each step's result, such as `pnpm read <token> 'allowance(address owner, address spender) returns (uint256)' <the Safe> <spender>`.
  A revert or no value counts as unknown.
  Never write the Safe's address in a committed file.
  Build one template for what the signer needs now: the steps their Safe has not done, then the operation, in one MultiSend, whether the app bundles them or not, so the signer reads one report and fills one card.
  Bind an approval's amount to the card value the operation spends, or to the most it may spend when that is a computed bound, and never approve more.
  The exception is a spender whose registry entry declares a standing allowance the route needs ([Standing allowances](../../../docs/design/data-shapes.md#standing-allowances)); say so in the notes.
  An allowance counts as done only when no card amount could exceed it, such as an unlimited one; a smaller nonzero one counts as not done, and the template's approval replaces it.
  For a token that refuses a nonzero approval over a nonzero allowance, such as USDT, the template sets the allowance to 0 first, in the same MultiSend, when the Safe's allowance is nonzero.
  Leave out each step the Safe has done; when it has done every step, the template holds the operation alone.
  When the signer later needs another shape, such as the operation alone after the approval is done, that is a new template with its own report.
  When `pnpm read` cannot answer, or no Safe is configured, count every step as missing and say so to the signer; do not ask.
  Say which steps the template holds, which you left out because the Safe has done them, and what you read to know, and ask only as Questions below says.
  The past-transactions study (step 5) corroborates or revises this, so run no search of its own for it.
  A step the app bundles shows there as an extra call in a misfit group; another sequence of steps is another template's shape, not a reason to change this one.
  A step it sends apart leaves no trace there, so settle that case from the app's code or docs.
- **Card.** The card asks what the protocol's own app asks a user to enter for this operation, such as the market, the collateral amount and the borrow amount, and nothing the app does not ask, except what safety strictly needs, explained in the report.
  Each contract field but one of the instance kind, such as a vault, lists the registry names it accepts as `"names"`, at first only the tokens the signer's request names: a swap's pair, an approval's token ([Intent card](../../../docs/design/data-shapes.md#intent-card)).
  A value the app fills in by itself, such as a slippage floor, a share-price cap, a minimum amount out or a deadline, is never asked.
  When it is a limit the transaction's bound must carry, or one only the simulated result can be held to, because the function the app's route calls has no bound, such as the fewest shares a plain `deposit` gives (an `atLeast` in the effects), declare its card field as computed (`"computed": { "read", "bound", "default", "margin"? }`, see [Intent card](../../../docs/design/data-shapes.md#intent-card)), with the protocol's own default slippage and a pinned link to where the protocol sets it as `default` ([Pinned source links](notes-and-reviews.md#pinned-source-links)) (template load requires both, `bps` a whole number from 0 to 1,000 and `source` an https URL); when the protocol publishes no default for that function, `default` is `{ "bps": 0, "source": <a pinned https link to the protocol's own page or code for the function the field bounds, which shows it sets none> }`, all the room goes in `margin` with its `why`, and the notes say the protocol sets no default ([Intent card](../../../docs/design/data-shapes.md#intent-card), `default`); `card new` reads it only after every entry the read names, with each one's `dependsOn`, runs its pinned code; otherwise bind it or leave it free with a reason.
  A share price bound (`maxSharePrice`, `minSharePrice`) states `scale`, the whole power of ten from 1 to 36 the protocol scales the price by (27 for Morpho's adapters), and its review cites the protocol's source for it; template load refuses a bound without it ([Intent card](../../../docs/design/data-shapes.md#intent-card)).
  Follow the route the protocol's app sends (Route above): bind the bound its function has; when it has none, use the computed field and the effect that checks it (`atLeast` for the fewest received, `atMost` for the most spent) without asking, even when the protocol offers a bounded function the app does not use, and name that function in the report ([Intent card](../../../docs/design/data-shapes.md#intent-card)).
  When the limit is an effect's alone, write a `judgments` note ([notes-and-reviews.md](notes-and-reviews.md#what-to-write)) that `verify` checks it on the simulated result before signing and nothing holds it when the transaction runs, so a price that moves before execution can breach it, and the receipt check only shows that afterwards.
  A swap's minimum to receive is a `floor`, never a `computed` field: `"floor": { "sells": "<the card field of the amount sold>" }`, whose rule the program holds; give each token that has a feed its `price`, each feed its facts and the pair's pool its `twap` in the registry, with the publisher's own list as the source, and `minLiquidity` at or just below the lowest of the calm and stressed measures `pnpm pool-depth <pool> --auto` prints over every window a route reads the pool at (both, unless every pair it prices is of one kind; `--blocks <calm>,<stressed>` for blocks you found yourself, such as a depeg), never far under; tell the signer that on a day the pool is thinner `card new` holds its price in doubt and they type the minimum twice, and how many sampled days that was (`--min <value>`) ([Prices](../../../docs/design/data-shapes.md#prices)); each feed and pool is a registry entry of its own, researched as any other ([addresses.md](addresses.md#contracts-that-need-more)).
  A token no feed prices gets none, and its floor is typed.
  Add a `margin` only when the default alone would make the app's own transaction `MISMATCH`, and say why in its `why`.
- **Extra limits.** A protection the app lacks, such as a cap on loan-to-value after a borrow, is your card design; propose it in the report.
- **Chain facts.** Read prices and other chain facts on chain, such as the market's oracle, through the repository's commands with the signer's keys, never a public RPC endpoint or a script of your own ([Build a template](SKILL.md#build-a-template)); never guess them.
- **Questions.** Ask only what no evidence can settle, once and briefly, each question with your recommended answer and its reason.
  Ask as soon as you meet one whose answer changes what you build, such as which contract or market the signer means when their sentence fits several (ask for the protocol app's link to it, which names it exactly), or which of several routes the app may send when the evidence does not settle it (recommend one); meanwhile do the steps that do not depend on the answer.
  A name that several contracts share fits several, even when one is larger or newer, such as a vault's older and newer version under one name: never pick one yourself.
  List each one with its address, version, size and age, and what the protocol or the curator says about which to use, with its link, or that you found nothing; then recommend one.
  A preference that changes nothing you build waits for the report.
  Never ask what the sentence already says, such as a vault when they said a market.
- **Chain.** kiss-sign covers Ethereum mainnet only; say so if the signer names another chain, and never ask which chain.

## Program changes

When the program lacks a capability the operation needs, such as a borrow whose debt the effects check cannot see, research the operation anyway, then change the program, `docs/design.md` and `docs/design/` first.

- Prefer a generic capability a template declares as data, such as "read this view with these bound arguments before and after the transaction, and require this change", over code for one protocol, so a later operation needs only a template.
- A change to a file `docs/verdict-core.txt` lists, the code the signing commands run, goes in a pull request of its own: with its tests, no template or registry change and no change to the program gate.
  Merge it as [merge-a-program-change.md](merge-a-program-change.md) says before the template's pull request, which follows on a branch from the new `main`.
  `pnpm check-push` and CI refuse a branch that mixes them ([The verdict core](../../../docs/design/program-ownership.md#the-verdict-core)).
- Run `pnpm verdict-core` after the change, since `pnpm test` fails when that list is out of date.
- A change only to research code, such as a report section under `src/research/`, may share the template's pull request, unless `docs/verdict-core.txt` lists the file, as it does `src/research/report-words.ts`, which holds every word of the report, and `source-page.ts`, `api-source.ts` and `github-token.ts`.
  `scripts/report.ts` is a gate file, so a change to it goes in a pull request of its own, which the signer merges.
- Write the code the way the signer's own setup asks, such as their instructions or the development workflow they use; this skill prescribes none.
  Tell the signer you will follow their workflow, not which tool you run.

## State the intent

Record the signer's request word for word in the template's `notes.json` `request`, with each answer they gave to your questions after it.
Never paraphrase or translate it.
Write `<your Safe>` for the configured Safe's address and leave out any key, since `pnpm check-push` refuses both.
Keep its line breaks, at most 2,000 characters; when the answers would pass that, keep the request and the answers that changed what you built.
A later request that only adds an instance's report goes in that instance's `instanceRequest` the same way.
The report shows it at the top as theirs.
Restate the signer's sentence as one operation with an id `<protocol>/<operation>`, such as `erc20/transfer` or `morpho/vault-deposit`, and start researching.
The card values of the operations the design covers are in [Intent card](../../../docs/design/data-shapes.md#intent-card).
For a new operation, open the protocol's own app and note what it asks a user to enter and which contract its transaction calls.

## Establish the ABI

`pnpm prove-abi <address>` compiles the source verified on Etherscan with a pinned solc and compares it with the code on chain.
Take function signatures only from a proven ABI.
Record the proof as a fixture with `pnpm record-abi-case <name> <address>`.
When `prove-abi` refuses because the compiler is not pinned, run `pnpm pin-solc <version>` with the version it names, keep the change to `src/contracts/solc-pins.ts` in the same pull request, and tell the signer in the final message that the pull request adds a compiler pin, a program change they must review.

## Draft the template

Write `templates/<protocol>/<operation>/template.json`.
Start from an existing template of a similar shape in `templates/`.
For example, take `erc20/transfer` for a token transfer, `morpho/vault-deposit` or `fluid/vault-deposit` for an ERC-4626 deposit, `cow/swap` for a signed order, one under `safe/` for an owner or threshold change, and `morpho/vault-v2-cap-submit` or `morpho/vault-v2-cap-accept` for a curator's vault setting.
When none of these is there, take the nearest one that is.
Then follow [Data shapes](../../../docs/design/data-shapes.md#data-shapes); template load refuses anything else.
Run `pnpm template check <protocol>/<operation>` after each edit: it parses the draft as `verify` does and names the path and problem of anything refused, so import no program file in a script of your own to check it.

- Bind every argument, and every address to the Safe, a card value or a registry contract.
- Use `free` only with a reason, on a number, bool, fixed-size bytes or an array of numbers; free `bytes`, a `string` or another array only with a `proof` or `unread` claim; a number that picks one of the protocol's pools, such as a Uniswap pool's fee, only with a `route` claim, when the effects bound every token the Safe gets.
- Bind bytes a router takes as a command's input, ABI-encoded with no selector, with `encoded`.
  Write `as` the way the contract decodes the bytes: when it decodes one struct, such as `abi.decode(params, (ExactInputSingleParams))`, the struct is one tuple parameter, `NAME((address a, ...) params)`, not its parts as separate parameters, which encode differently once any part is dynamic.
- Put an allowance the operation leaves open in `effects.approves`; `unlimited` only to a registry contract that declares a `standingAllowance` of that route, with the reason from its code ([Standing allowances](../../../docs/design/data-shapes.md#standing-allowances)).
- Write every reason the signer reads (each `free` reason or its `proof`, `unread` or `route`, each trailer's, `max`'s, `margin`'s and an effect's `tolerance` `why`, a `merge` and a fact's `reason`) in both languages, `{ "en": "...", "zh-TW": "..." }`, the same meaning in each.
  Template load accepts one language, the same for every reason, but every template committed in `templates/` holds both ([Data shapes](../../../docs/design/data-shapes.md#template), "Reasons"), and `pnpm test` refuses one that does not; when you change a template, write the change in each.
- Give every number you choose yourself, rather than take from the protocol, its app or the signer, a reason the signer can judge.
  It goes in the computed field's `margin` `why`, the `max` `why`, the trailer's `why`, the effect's `tolerance` `why`, and for a `withinSeconds` in the field's `fields` note ([The keys](notes-and-reviews.md#the-keys)).
  The report shows each as the AI's choice with its reason.
- Keep a `why` that `card new` prints, `max`'s and `margin`'s, to at most 200 characters: the conclusion the signer needs, in plain words, such as "the app prices the deposit again, so the default alone can make it a MISMATCH". Leave out function names, file paths and commits.
- **A signed order read by its digest.** Fetch one real order from the `lookup` API first and see where its members sit.
  When the API does not serve the message as one top-level object with each member under its own name, declare `answer` ([Signed messages](../../../docs/design/data-shapes.md#signed-messages)): the `path` to the object that holds it, and per member a `path` or `"encoding": "hex"` only where the API differs.
  A wrong `answer` cannot pass a forged order, but it makes every order `UNVERIFIABLE`.
- **When the vocabulary falls short**, such as an amount that rounds by a few wei, a recipient packed inside a `bytes32`, a read a computed field cannot make, or a proxy `prove-abi` does not know: stop and propose a generic program change ([Program changes](#program-changes)).
  Never reach for `free`, `positive` or another looser rule to make the transaction pass.

## Study past transactions

Run `pnpm past-txs <protocol>/<operation> --record <name>` with no block range, anchored on the transfer or event the operation itself makes, such as a vault's shares minted for a deposit, the token's transfer for a transfer, or, for an event each Safe logs about itself, `--anchor event --event 'AddedOwner(address)'` with no `--token`; `pnpm past-txs --help` lists the anchors.
To anchor a token approval to one spender, mark the event's indexed arguments and name the spender's place: `--token <token> --anchor event --event 'Approval(address indexed owner, address indexed spender, uint256 value)' --event-arg 2=<spender>`; Etherscan then lists that spender's approvals alone, so the page cap reaches back further than over every approval of a busy token.
For an event a busy contract logs, such as a pool manager's `Swap`, filter it the same way on the first run: `--event-arg <n>=<address | bytes32>` on an indexed argument, such as `--event-arg 1=<pool id>` for one Uniswap v4 pool, whose `PoolId` is keccak256 of its `PoolKey`: `pnpm abi hash '(address,address,uint24,int24,address)' '["<currency0>","<currency1>","<fee>","<tickSpacing>","<hooks>"]'` prints it, to compare with the id the protocol's app or the PoolManager's `Initialize` event (`pnpm events`) shows (one `--event-arg` per search; a second is refused); past-txs then checks the Safe each transaction's `execTransaction` was sent to and studies those first, EOAs' transactions in the rest.
The program picks its own search: every transaction from the newest block back, through the whole last year or as far as 50 pages per source reach, studying first every transaction whose anchor party is a proven Safe; the report says which blocks it read. Never pass `--from-block` or `--to-block`, which replace it with one range of your choosing.
To read again the blocks an earlier recording searched, such as to add what a read with no answer left out, pass `--same-windows-as <name>`, which takes the head block and the search from the summary `testdata/research/<name>.json`.

1. For each field, note how many transactions and senders held the template's rule, for Safes and for EOAs separately.
2. Read every misfit group; `pnpm past-txs --show <name>` lists a recorded run's transactions, each Safe's first, and `--tx <start of a hash>` one with every value and call, so read no recording by a script of your own.
   A misfit shows a shape the template does not accept, such as an extra call or a longer trailer.
   Change the template only when the misfit is normal use, and say why in the report.
3. Read `amounts against balances`: for each effect of an exact card amount, how far each sender's and receiver's balance ended from the amount the transaction states.
   An effect with no `tolerance` allows 0, so a sender's other difference in a registry token prints as `FINDING`.
4. Declare a `tolerance` on an effect only from that distribution: `less` and `more` the largest difference observed in each direction, never more than 10, and the distribution cited in `why`, such as "in 28 stETH transfers studied, the sender's balance ended 1 wei higher than stated in 21 and exact in 7".
   Never declare one where every difference is 0.
   Share-based or rebasing tokens, fee-on-transfer tokens and vault share conversions are only hints of where to look; the distribution decides.
   A difference beyond 10, or one that grows with the amount, such as a fee, is not rounding: stop and tell the signer.
5. Read the spread `pnpm past-txs` prints for every `uint` or `int` the template leaves free or bounds with `withinSeconds`, over the transactions that fit, a value the signer does not choose, such as an order's `validTo` less the block's time, a deadline or a fee.
   Ask what the largest normal value is, and what a far larger one would let happen after the signer stops watching, such as an order or approval still valid in a year.
   For a time, declare it `{"free": {"time": {"<language>": "<why>"}}}` first, so the spread counts from the block's time, then replace that with `{"withinSeconds": <seconds>}` ([Template](../../../docs/design/data-shapes.md#template)), a whole number from 1 to 31,536,000, at or above the largest value real Safes used (when that is above a year, stop and tell the signer).
   The report's Past transactions section shows the spread beside the limit, so do not repeat it in `notes.json`.
   For another number, when the spread shows a bound is needed and no rule in the vocabulary can hold it, stop and propose a generic program change.
   When no bound is needed, say why in the field's text in `notes.json`.
6. Pass `--record <name>` on the first full run of each search the report studies, so no search runs twice; never run a search again only to add `--record`.
   After you change the template or the registry, run `pnpm past-txs --restudy <name>`, which studies the recording again, reading live with the Alchemy and dRPC keys only what it lacks, such as the trace, run alone or signed message of a transaction that fits only now, instead of searching again; never the search or its party checks, so when the search, `--max-txs` or the sampling must change, such as another anchor, token or `--event-arg`, run `--record` again.
   Settle the addresses below before you write a `flow` line or generate the report.
   `--record` writes the full recording to `.cache/past-txs/<name>.json`, which git ignores and you never commit, and a summary of what the study found to `testdata/research/<name>.json`, which the report reads.
   The summary also keeps the call trace of each transaction exactly the template, which the report compares with your `flow` lines ([Notes and reviews](notes-and-reviews.md)).
   Before any note, settle every address the run prints that moves the sender's money and whose code verify does not check:
   - a fixed contract of the operation, such as a pool manager that holds every pool: register it and list it in the reaching entry's `dependsOn` ([addresses.md](addresses.md#contracts-that-need-more)), then `--restudy` the summary;
   - one that differs per transaction or is no fixed part of the operation, such as an aggregator's pools: judge it `not-fixed`;
   - one the program cannot express: judge it `known-limit`, and stop and propose the change ([Program changes](#program-changes)) when it affects what `verify` binds.
   Write a judgement in `trace-addresses.json` beside the report's files, in the instance's folder for a per-instance report: `{ "<address in full>": { "judgement": "not-fixed" | "known-limit", "reason", "sources": ["https://..."] } }`, with `"needs": "<the program change>"` for a `known-limit`; `reason` and `needs` hold at most 600 characters each.
   `pnpm report --record` refuses while one is neither, naming all of them, and refuses a judgement of an address no recorded trace names; so do `--render`, `--offline` and `pnpm test` for a report recorded on 2026-11-26 or later, or that has the file.
   When the run says nothing was found over 0 traced, it shows nothing: look for a search that traces the operation, and only when there is none say why beside the judgements, as `"untraced": { "reason" }`, without which `--record` refuses a template that moves money.
   When the run prints a token a swap's card can choose in none of the traces, such as one direction of the swap, look for a search that traces it, and say in `pastTxsConclusion` what no trace covers.
   When `pnpm test` says a summary changed since it was studied, run `pnpm past-txs --restudy <name>` where `.cache/past-txs/<name>.json` exists, or run the summary's printed command again with `--same-windows-as <name>`; settle any new address it prints.

## Check the protocol's health

Look for past hacks and incidents (the `hacks` lines `pnpm find-sources` prints with each protocol, never DefiLlama's hack list fetched yourself, and the protocol's post-mortems), audits, recent upgrades, admin or timelock changes, and paused or deprecated contracts.
Cite a URL for every claim; it goes into `protocols` in `notes.json`.
When every call reaches a token, no protocol facts cover the template: leave `protocols` out, or `{}`; the program refuses any protocol in it.
A risk of the token itself, such as an upgradeable or pausable token, goes in a judgment.
When a call reaches a contract that is not a token and that DefiLlama does not list, check its health all the same and write the findings, with their URLs, in a judgment; `pnpm progress` keeps step 6 open until `notes.json` holds one.

## Generate the report

1. Write `templates/<protocol>/<operation>/docs.json`: for each function the template calls, by canonical signature such as `approve(address,uint256)`, `{ "contract": "<registry name>", "url": "https://..." }` and nothing else, the URL an official page that names the function.
   - For a function called on the Safe itself, such as `addOwnerWithThreshold`, `contract` is a registry entry of kind `singleton`, such as `safe-1.4.1` (the report covers every one), and the URL Safe's own reference page on docs.safe.global.
   - When the template binds the call's target, `contract` is that target or one of the entries a card field can name.
   - Look first in the protocol's docs and official GitHub organization, then search further, such as its SDK reference, audit reports or developer forum, for a page of the protocol's own site that names the function; a page elsewhere is a lead to such a page, never the URL.
   - A URL holds only RFC 3986 characters other than `[` and `]`; prefer the protocol's docs, and pin a GitHub page to a commit.
   - For a function a token standard defines, called on a registry token or vault, such as ERC-20's `approve`, `transfer` or `transferFrom`, write `{ "contract": "<registry name>", "standard": "erc-20" }` when the issuer publishes no page on its own site that names the function as code; the standards are `erc-20` (a token or a vault), `erc-4626` (a vault) and `weth9` (WETH alone).
2. Run `pnpm report <protocol>/<operation> --record`, with `--instance-of <instance>` for the instance the signer named when the template is reported per instance.
   It reads everything live but the past transactions, which it prints from the `pnpm past-txs` summaries in `testdata/research/`, and records the answers in `testdata/report/` and any missing ABI case in `testdata/abi/`, and writes `report.generated.md`.
   Last it writes the HTML report from `notes.json`; that step refuses, naming the problem, until the notes review exactly the results the signer must look at.
   At this step a refusal that names `notes.json` is expected and comes after the recordings and `report.generated.md` are written: write the reviews ([notes-and-reviews.md](notes-and-reviews.md)), all the texts `pnpm notes-needed` lists in one pass, and run `--render`.
   Read each page `--render` wrote as the signer will with `pnpm report <protocol>/<operation> --text <en | zh-TW>` (with `--instance-of <instance>`), never by stripping the HTML with a script of your own.
   Never edit the generated file; `pnpm test` fails if it differs from what the recordings give.

## Add the tests

1. Choose two or more past transactions from different Safes, as `pnpm past-txs --show <name>` lists them, and record each with `pnpm record-safe-tx <name> <safe> <safeTxHash>`, taking the safeTxHash and nonce that `past-txs --show <name> --tx <hash>` or `pnpm decode-tx <hash>` prints; never record the configured Safe.
   When the search finds fewer than two Safes whose transactions fit, test with those it found, even none, without asking the signer, and say in a `judgments` note how many there are and why, such as a pool so busy the search reaches back only days.
   With none, test with EOAs' transactions that fit instead, from different EOAs, never the configured Safe and never a transaction an owner of the configured Safe sent: record each with `pnpm record-eoa-tx <name> <transaction hash>`, taking the hash `past-txs --show <name>` lists, and use the fixture as a Safe's below; the report names it as an EOA's transaction.
   It works only for a template whose transaction is one call an EOA can send itself, with no nonce rule; say in the `judgments` note why no Safe's transaction is a test.
2. When a fixture fits, add the template to `SHIPPED` in `test/shipped-templates.test.ts`, with its fixtures, and list under `bounded` each field for which `implied-card` prints a `boundary` line.
   That test covers a template sent as its own transaction; one only ever batched with another operation stays out, as its comment says.
   That test runs `pnpm template implied-card <protocol>/<operation> <fixture>...` on this checkout and requires `MATCH` and each bound at its boundary.
   `implied-card` prints each fixture's implied card, with a `book` line for an address-book name; copy its values into your tests, never decode amounts or compute a bound by hand.
3. In a test file named for the operation, such as `test/<protocol>-<operation>.test.ts`, require the mutation check to catch every bound field.
   Read the template, registry and fixtures from `liveRepo()` of `test/repo-with-test-fixtures.ts`.
   `baseRepo()` and `repoWithTestFixtures()` hold a frozen copy for the program's own tests, and never your template; `runOffline` reads this checkout unless given another `repoFrom`.
   ```ts
   const ROOT = liveRepo();
   const registry = loadRegistry(ROOT);
   const templates = new Map<string, Template>([[ID, loadTemplate(ROOT, ID, registry)]]);
   assert.equal(checkMutations(tx, card, templates, registry).kind, 'pass');
   ```
   `test/morpho-vault-deposit.test.ts` shows how to read a fixture's `tx` and resolve its `card`, with `repoWithBundler3Deposit()` where yours takes `liveRepo()`.
   For a signed order or a `withinSeconds` rule, pass the fixture's `messages` and `{ blockTime }` as `scripts/template.ts` does.
   A Safe owner or threshold change differs in three ways.
   `implied-card` reads no owners, so a rule that reads them, such as `ownerBefore`, prints `UNVERIFIABLE the Safe's owners: not read`; give its `SHIPPED` entry `verdict: OWNERS_NOT_READ`.
   Record each fixture's simulation with `pnpm simulate <name> --record <name>`, read the owners from that recording with `readOwners`, and pass them to `checkTemplateFields` and `checkMutations`.
   Judge the change with `checkObservation` and require `effects` `match` and `floor` `pass`: the floor (`checkSimulatedFloor`), not `judgeEffects`, judges the owners and threshold.
   For the receipt, wrap `observeExecuted` in `withSimulatedSafeState`.
   `fixtureOf` in `test/safe-admin.test.ts` and the test after it do all of this, with `baseRepo()` where yours takes `liveRepo()`.
4. For a template with a free field, record the perturbation test of every test transaction with `pnpm perturb <name> --card '<card json>' --record <name>`, one recording per transaction; `test/canaries/perturb.canary.ts` replays every recording.
   A failing field must be bound, not explained.
5. Run `pnpm report <protocol>/<operation> --render` again for every report of the template, each instance's with `--instance-of <instance>`: the report judges each perturbation recording and takes its example transaction from the first, so a recording added after the last render changes it, and `pnpm test` fails until you do.

## Open the pull request

Run `pnpm test`, `pnpm typecheck` and `pnpm check-push origin/main..HEAD`; all must pass.
When a test unrelated to your operation fails because of what you added, keep the addition, open the pull request as a draft that is not ready to merge, and tell the signer as step 10 of [Build a template](SKILL.md#build-a-template) says.
Open the pull request to the signer's fork with the template, `docs.json`, `notes.json`, `trace-addresses.json` when there is one, the generated reports (`report.generated.md` and each HTML file `--render` wrote), the recordings, the `pnpm past-txs` summaries in `testdata/research/` (never the full recordings in `.cache/past-txs/`), the registry entries, the tests, and any research-code change with its design change.
A verdict core change went in its own pull request first.
Never paste generated output into the pull request description.

The signer reads the report, not the diff, and merging is their yes.
Write the description for them, in their language, in this order:

1. One sentence: the operation, and that they need not read the diff.
2. **Read the report**: the path of the report in their language on the branch.
3. **Check before you merge**: one line per result the report lists under To review, in your own words, with each address in full, then one line per registry entry the branch adds or changes: open the sources the report lists for it and check that each page is the protocol's own and lists this address; then one line per judgement in `trace-addresses.json`, which no page shows.
4. **What the card will ask**: one line per card field.
5. **The files**: how many files you wrote by hand (template, notes, `docs.json`, registry, tests) and how many the scripts recorded or generated, and why any other file changed, such as every past-transactions summary taking a new registry hash.
6. **Merge when you are satisfied.**

Put the engineering details (scope, blast radius, the commands that passed) last, inside a `<details>` block titled for the reviewer of the code.

## Tell the signer

Keep the final message short and plain.

1. If you merged a program change, anything outside `templates/`, `registry/` and `testdata/`, say so first: what it does, what `verify` now checks differently when it changed the verdict core, the canaries that passed, and that the template's pull request follows on the new `main`.
2. Then the template, what the card will ask, what will be checked, the findings, and the pull request link, whose description holds the same checklist.
3. Then the next steps:
   - Read the report in their language (`report.generated.en.html` or `report.generated.zh-TW.html`, or the one that exists).
   - For each registry entry the branch adds or changes, open each source the report lists for it, and check that its domain is the protocol's own and that the page lists this address.
     The recordings were made on your computer and no program reads them again ([Known limits](../../../docs/design/known-limits.md#known-limits)).
   - Check that its CI jobs pass. A template or registry branch that also changes the verdict core makes the `program-gate` job, which runs main's code, fail; do not merge it.
   - When the operation has more than one route ([Route](#decide-from-evidence)), which route the template covers, and that a `MISMATCH` because the app took another one is the time to ask for that route's template.
   - Merge when they are satisfied.
