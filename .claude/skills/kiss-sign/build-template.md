# Build a template: how

How to do each step of [Build a template](SKILL.md#build-a-template) except step 2 ([addresses.md](addresses.md)) and step 8 ([notes-and-reviews.md](notes-and-reviews.md)).
The design of each step is in [First time an operation is done](../../../docs/design/flow.md#first-time-an-operation-is-done-build-its-template), whose steps are numbered differently; find them by name.

## Decide from evidence

Never ask the signer about these before research.

- **Route.** Whether the Safe calls the protocol directly or through its bundler or router follows from the contracts, the protocol's own app, and what real Safes do in `pnpm past-txs`.
- **Card.** The card asks what the protocol's own app asks a user to enter for this operation, such as the market, the collateral amount and the borrow amount, and nothing the app does not ask, except what safety strictly needs, explained in the report.
  A value the app fills in by itself, such as a slippage floor, a share-price cap, a minimum amount out or a deadline, is never asked.
  When it is a limit the transaction's bound must carry, declare its card field as computed (`"computed": { "read", "bound", "default", "margin"? }`, see [Intent card](../../../docs/design/data-shapes.md#intent-card)), with the protocol's own default slippage and a pinned link to where the protocol sets it; otherwise bind it or leave it free with a reason.
  Add a `margin` only when the default alone would make the app's own transaction `MISMATCH`, and say why in its `why`.
- **Extra limits.** A protection the app lacks, such as a cap on loan-to-value after a borrow, is your card design; propose it in the report.
- **Chain facts.** Read prices and other chain facts on chain, such as the market's oracle; never guess them.
- **Questions.** Ask only what no evidence can settle, a genuine preference, once and briefly, at the end with the report.
  The one exception is which contract or market the signer means when their sentence fits several: ask that first, and ask for the protocol app's link to it, which names it exactly.
  Never ask what the sentence already says, such as a vault when they said a market.
- **Chain.** kiss-sign covers Ethereum mainnet only; say so if the signer names another chain, and never ask which chain.

## Program changes

When the program lacks a capability the operation needs, such as a borrow whose debt the effects check cannot see, research the operation anyway, then change the program, `docs/design.md` and `docs/design/` first.

- Prefer a generic capability a template declares as data, such as "read this view with these bound arguments before and after the transaction, and require this change", over code for one protocol, so a later operation needs only a template.
- A change to a file `docs/verdict-core.txt` lists, the code the signing commands run, goes in a pull request of its own: with its tests, no template or registry change and no change to the program gate.
  Merge it as [merge-a-program-change.md](merge-a-program-change.md) says before the template's pull request, which follows on a branch from the new `main`.
  `pnpm check-push`, CI and `--compare` refuse a branch that mixes them ([The verdict core](../../../docs/design/program-ownership.md#the-verdict-core)).
- Run `pnpm verdict-core` after the change, since `pnpm test` fails when that list is out of date.
- A change only to research code, such as a report section under `src/research/`, may share the template's pull request, unless `docs/verdict-core.txt` lists the file, as it does `src/research/report-words.ts`, which holds every word of the report, and `source-page.ts`, `api-source.ts` and `github-token.ts`.
  `scripts/report.ts`, which holds `--compare`, guards that rule and is a gate file, so a change to it goes in a pull request of its own, which the signer merges.
- Write the code the way the signer's own setup asks, such as their instructions or the development workflow they use; this skill prescribes none.
  Tell the signer you will follow their workflow, not which tool you run.

## State the intent

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
Start from the existing template nearest in shape, after checking it is still in `templates/`: a token transfer from `templates/erc20/transfer/`, an ERC-4626 deposit from `templates/morpho/vault-deposit/` or `templates/fluid/vault-deposit/`, a swap through a router from `templates/uniswap/swap/`, a signed order from `templates/cow/swap/`, a Safe owner or threshold change from `templates/safe/`, a curator's vault setting from `templates/morpho/vault-v2-cap-submit/` and its siblings.
Then follow [Data shapes](../../../docs/design/data-shapes.md#data-shapes); template load refuses anything else.

- Bind every argument, and every address to the Safe, a card value or a registry contract.
- Use `free` only with a reason, on a number, bool, fixed-size bytes or an array of numbers; free `bytes`, a `string` or another array only with a `proof` or `unread` claim; a number that picks one of the protocol's pools, such as a Uniswap pool's fee, only with a `route` claim, when the effects bound every token the Safe gets.
- Bind bytes a router takes as a command's input, ABI-encoded with no selector, with `encoded`.
- Put an allowance the operation leaves open in `effects.approves`; `unlimited` only to a registry contract that declares a `standingAllowance` of that route, with the reason from its code ([Standing allowances](../../../docs/design/data-shapes.md#standing-allowances)).
- Write every reason the signer reads (each `free` reason or its `proof`, `unread` or `route`, each trailer's, `max`'s and `margin`'s `why`, a `merge` and a fact's `reason`) only in the signer's `language` from the config, as `{ "zh-TW": "..." }` or `{ "en": "..." }`, the same language for every reason of the template.
  When you change a template that holds both languages, keep both and write the change in each.
- **A signed order read by its digest.** Fetch one real order from the `lookup` API first and see where its members sit.
  When the API does not serve the message as one top-level object with each member under its own name, declare `answer` ([Signed messages](../../../docs/design/data-shapes.md#signed-messages)): the `path` to the object that holds it, and per member a `path` or `"encoding": "hex"` only where the API differs.
  A wrong `answer` cannot pass a forged order, but it makes every order `UNVERIFIABLE`.
- **When the vocabulary falls short**, such as an amount that rounds by a few wei, a recipient packed inside a `bytes32`, a read a computed field cannot make, or a proxy `prove-abi` does not know: stop and propose a generic program change ([Program changes](#program-changes)).
  Never reach for `free`, `positive` or another looser rule to make the transaction pass.

## Study past transactions

Run `pnpm past-txs <protocol>/<operation>` with no block range, anchored on the transfer or event the operation itself makes, such as a vault's shares minted for a deposit, the token's transfer for a transfer, or, for an event each Safe logs about itself, `--anchor event --event 'AddedOwner(address)'` with no `--token`; `pnpm past-txs --help` lists the anchors.
The program picks its own search: the whole last year in up to 10 pages per source, studying first every transaction whose anchor party is a proven Safe, and when the year holds more, 12 windows across it; never pass `--from-block` or `--to-block`, which replace both with one range of your choosing.
To read again the blocks an earlier recording searched, such as to add what a read with no answer left out, pass `--same-windows-as <recording>`, which keeps that recording's head block and the search it made.

1. For each field, note how many transactions and senders held the template's rule, for Safes and for EOAs separately.
2. Read every misfit group.
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
   For a time, declare it `{"free": {"time": {"<language>": "<why>"}}}` first, so the spread counts from the block's time, then replace that with `{"withinSeconds": <seconds>}` ([Template](../../../docs/design/data-shapes.md#template)), a whole number from 1 to 31,536,000, at or above the largest value real Safes used (when that is above a year, stop and tell the signer), and cite the spread in the field's note in `notes.json`, such as "136 Safe orders: median 1,720 s, 99th percentile 10,478 s, largest 604,767 s; bound 7 days".
   For another number, when the spread shows a bound is needed and no rule in the vocabulary can hold it, stop and propose a generic program change.
   When no bound is needed, say why in that note.
6. Record the runs the report studies with `--record <name>` before you generate the report.
   The recording also keeps the call trace of each transaction exactly the template, which the report compares with your `flow` lines ([Notes and reviews](notes-and-reviews.md)).

## Check the protocol's health

Look for past hacks and incidents (DefiLlama's hack list, the protocol's post-mortems), audits, recent upgrades, admin or timelock changes, and paused or deprecated contracts.
Cite a URL for every claim; it goes into `protocols` in `notes.json`.

## Generate the report

1. Write `templates/<protocol>/<operation>/docs.json`: for each function the template calls, by canonical signature such as `approve(address,uint256)`, `{ "contract": "<registry name>", "url": "https://..." }` and nothing else, the URL an official page that names the function.
   - For a function called on the Safe itself, such as `addOwnerWithThreshold`, `contract` is the registry Safe singleton (`safe-1.4.1`) and the URL Safe's own reference page on docs.safe.global.
   - When the template binds the call's target, `contract` is that target or one of the entries a card field can name.
   - Look first in the protocol's docs and official GitHub organization, then search further, such as its SDK reference, audit reports or developer forum, for a page of the protocol's own site that names the function; a page elsewhere is a lead to such a page, never the URL.
   - A URL holds only RFC 3986 characters other than `[` and `]`; prefer the protocol's docs, and pin a GitHub page to a commit.
   - For a function a token standard defines, called on a registry token or vault, such as ERC-20's `approve`, `transfer` or `transferFrom`, write `{ "contract": "<registry name>", "standard": "erc-20" }` when the issuer publishes no page on its own site that names the function as code; the standards are `erc-20` (a token or a vault), `erc-4626` (a vault) and `weth9` (WETH alone).
2. Run `pnpm report <protocol>/<operation> --record`, with `--instance-of <instance>` for the instance the signer named when the template is reported per instance.
   It reads everything live, the past transactions studied again from the `pnpm past-txs` recordings, whose search, signed-message answers and traces it reuses, and records the answers in `testdata/report/` and any missing ABI case in `testdata/abi/`, and writes `report.generated.md`.
   Last it writes the HTML report from `notes.json`; that step refuses, naming the problem, until the notes review exactly the results the signer must look at.
   At this step the refusal is expected and comes after the recordings and `report.generated.md` are written: write the reviews ([notes-and-reviews.md](notes-and-reviews.md)) and run `--render`.
   Never edit the generated file; `pnpm test` fails if it differs from what the recordings give.

## Add the tests

1. Record two or more past transactions from different Safes with `pnpm record-safe-tx <name> <safe> <nonce>`; never record the configured Safe.
2. In `test/`, require `MATCH` for each with its implied card, and require the mutation check to catch every bound field; `test/canaries/template.canary.ts` and `test/canaries/mutation.canary.ts` show both.
3. For a template with a free field, record the perturbation test of every test transaction with `pnpm perturb <name> --card '<card json>' --record <name>`, one recording per transaction; `test/canaries/perturb.canary.ts` replays every recording.
   A failing field must be bound, not explained.
4. Run `pnpm report <protocol>/<operation> --render` again for every report of the template, each instance's with `--instance-of <instance>`: the report judges each perturbation recording and takes its example transaction from the first, so a recording added after the last render changes it, and `pnpm test` fails until you do.

## Open the pull request

Run `pnpm test`, `pnpm typecheck` and `pnpm check-push origin/main..HEAD`; all must pass.
Open the pull request to the signer's fork with the template, `docs.json`, `notes.json`, the generated reports (`report.generated.md` and each HTML file `--render` wrote), the recordings, the registry entries, the tests, and any research-code change with its design change.
A verdict core change went in its own pull request first.
Never paste generated output into the pull request description.

## Tell the signer

Keep the final message short and plain.

1. If you merged a program change, anything outside `templates/`, `registry/` and `testdata/`, say so first: what it does, what `verify` now checks differently when it changed the verdict core, the canaries that passed, and that the template's pull request follows on the new `main`.
2. Then the template, what the card will ask, what will be checked, the findings, and the pull request link.
3. Then the next steps:
   - Read the report in their language (`report.generated.en.html` or `report.generated.zh-TW.html`, or the one that exists).
   - Before merging, in a clone on `main`: `git pull`, `git fetch origin <branch>`, then `pnpm report <protocol>/<operation> --compare --data origin/<branch>`, once per report the branch adds or changes, with `--instance-of <instance>` for a per-instance report.
     It runs main's code on the branch's templates, registry and recordings, reads the facts live again, and prints each that differs from the committed report; it does not search for past transactions again, so it cannot show the search found every one, and it takes each signed message's answer from the recording.
     It also requires each HTML report to equal, byte for byte, what main's code writes from the recordings and notes.
     It refuses a branch that changes the verdict core beside a template, the registry or a gate file, and prints `PROGRAM CHANGE` for each program file the branch changes, `gate` among them for a file only the signer merges, and `AI TEXT` for each `notes.json` the branch changes, text no program checks for truth: read those files.
   - Merge only when it exits 0, printing no difference, and they are satisfied.
