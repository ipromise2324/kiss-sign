# Notes and reviews

How to do step 8 of [Build a template](SKILL.md#build-a-template) and step 5 of [Add an instance's report](SKILL.md#add-an-instances-report): write `notes.json`, the AI's text beside the program's results.
The exact shape and every limit are in step 6 of [First time an operation is done](../../../docs/design/flow.md#first-time-an-operation-is-done-build-its-template), the bold item Written by the AI, as data; `--render` refuses any other key or length.

## Write and render

1. Write `templates/<protocol>/<operation>/notes.json`.
   Its `entries.<name>.sources` already hold what you saw at each address before any check ([addresses.md](addresses.md)); complete the rest around them, and write `reviews` only after `--record`, against the printed results.
2. Run `pnpm report <protocol>/<operation> --render`, with `--instance-of <instance>` for a per-instance report.
   It writes the signer's report from the recordings and your notes, `report.generated.en.html`, `report.generated.zh-TW.html` or both, one for each language the notes hold.

## Language and length

- Write every text in the signer's `language` from the config, `{ "zh-TW": "..." }` or `{ "en": "..." }`, or in both, `{ "en": "...", "zh-TW": "..." }`, in plain Traditional Chinese or plain English; every text of one file holds the same languages, and `--render` refuses a file whose texts differ.
- Each limit counts Traditional Chinese characters; English may use three times as many.
- Sources, statuses, names and URLs are written once.
- Write a function or argument name between backticks, such as "Calls `erc20TransferFrom`, then `erc4626Deposit`" or "依序呼叫 `erc20TransferFrom` 和 `erc4626Deposit`"; only one identifier, with or without `()`, may stand between two backticks.

## The keys

- `title`, at most 100 characters, and `summary`.
- `verdict`: `{ "status": "safe" | "caution", "text" }`, one line of at most 100: your research advice on the operation's risk, despite the key's name.
  It is not a transaction's verdict, which only `verify` gives, and it never moves a program result; the Advice (建議) line's icon is the program's worst result, not your status.
- `flow`: at most four lines of what happens inside a call, each `{ "after": <call number>, "from": <registry name>, "to": <registry name>, "function": <canonical signature>, "text", "sources" }`, between two contracts the calls or the effects' views target, the entries those name in `dependsOn`, or the tokens the effects move.
  `function` is the function `from` calls on `to`, canonical, such as `deposit(uint256,address)`; the program compares each line with the call traces `pnpm past-txs --record` keeps, in the traced transactions that make the template call it follows (`after`), and draws it solid only when every one of them shows it; with no such trace the line is not compared and gives no result.
  Before you write a line, find that call in a past transaction's internal calls (Etherscan's trace of one transaction `pnpm past-txs` found) and in the contract's source; `sources` holds both, the source pinned to a commit first, since a confirmed line links the first source, then the transaction's Etherscan page; the program checks only that `sources` is a list of https URLs, not empty.
  Name no call the template binds itself, such as a Bundler3 bundle item: the diagram draws those from the template, and the program refuses the line.
  Spend the four lines on the steps that move money inside the call: every `transfer`, `transferFrom`, `approve` or ETH transfer that is not a call the template binds or a line names, nor made directly by one, is a result for the signer that you review.
- `protocols`, by DefiLlama slug, one for every protocol the generated report's protocol facts cover: `intro`, one line; `audits`, a note citing the audit reports; `incidents`, one note per DefiLlama hack in date order, its cause with the post-mortem as a source, exactly as many as the facts list.
- `judgments`: at most four, each with a `recommendation`.
- `reviews`: below.
- `pastTxsConclusion`, optional: one line of at most 200 on what the past transactions with other shapes teach.
- `entries`, by registry name: `role`, one line, and `sources`, each source you checked by hand as `{ "text", "url", "result": "pass" | "attention" | "fail" }`.
- `fields`: a text for every argument, tuple part, array item, nested call's argument, packed part and signed-message member, by the HTML report's field key, such as `1.approve.spender` or `2.blueBundlesV1Supply.marketParams.oracle`.
- A note is `{ "text", "sources"? }` with https URLs.

## What to write

Write no claim the program already checks: the page prints the facts, values and results itself, and your text sits beside them with an AI tag.

- **Addresses.** Where you found each address, the protocol API's query and answer when there is one, and the Etherscan verified contract name and creator, as `entries.<name>.sources`, written before any check ([addresses.md](addresses.md)); a review only answers a result.
- **Fields.** What each argument does, from the contract's source and documentation, and for a free field what values past transactions held, such as "`receiver` equalled the sender in all 42".
  The rules themselves are in the generated report.
- **Instances.** Your judgment of each instance's evidence, read as the size it declares: whether it grew suddenly or was held long, and any young, sudden or concentrated instance, as a judgment.
- **Past transactions.** The page prints the sender counts by type, both sources and their agreement, and every misfit group with examples; do not repeat them.
  Say what the misfits teach in `pastTxsConclusion`, and write a judgment only when they leave the signer something to decide that `verify` does not, never for a shape `verify` already refuses.
- **ERC-7730.** Where the generated report's ERC-7730 fields differ from yours: a parameter it gives no field, a field it hides, or a format that does not fit your meaning, such as `addressName` on an amount.
  Say loudly, in a judgment, when a descriptor applies by factory.
- **Protocol health.** The audits and each hack's cause, with citations, in `protocols`.
- **Calls that move no asset.** Only when `pnpm simulate` marks a call of a test transaction as moving no asset of the Safe: what that call changes, such as an authorization, from the protocol's official documentation with a link, in a judgment.
  When no call is marked, write nothing about the mark; a call to the Safe itself without data is never marked.
- **Nothing to show.** The page leaves out or states in one line what does not apply, such as addresses for a template that touches no registry contract; never write a judgment that explains a zero or an empty section.

## Reviews

The HTML page lists every red or amber program result under To review (待確認); the generated Markdown keeps every result with its raw output but the call traces' `flow.<n>` and `trace.*`, which come from your `flow` lines and are on the HTML page only.
`--render` refuses notes that leave one of those without a review or review any other result.
Your own observations went into `entries` before the checks ([addresses.md](addresses.md)); write each review after them, against the program's result as it printed it.
The result stays as it is, your review sits under it, and a `FINDING` stays visible even when you confirmed the source another way.

- Key: `reviews["<registry name>/<check key>"]`, or `reviews["fixture.<name>"]`; a documentation page's key names its function by selector, such as `doc.0x095ea7b3.page`.
- The call traces give `flow.<n>`, a line not seen in every traced transaction that makes the template call it follows, `<n>` counting the template's lines first and then the instance's, from 1, and `trace.<call>.<from>.<to>.<kind>`, a money call no line covers, where `<from>` and `<to>` are `safe`, a registry name or `other` for an address outside the registry, and `<kind>` is `transfer`, `transferFrom`, `approve` or `eth`; in a per-instance report they go in the instance's `notes.json`. Review an uncovered money call by naming each address outside the registry the page lists and what it is, from its source or Etherscan, or add the line that explains it.
- Value: `{ "status": "confirmed" | "concern", "text", "recommendation" }`.
- `text`, at most 300 characters, says only what you actually checked and what you saw, with full addresses, such as "Opened the page in a browser; the oracle address is 0x… (in full)." or "用瀏覽器打開頁面，oracle 地址就是 0x…（完整地址）。".
  If you could not check the thing the result names, say so and name the other evidence you have.
- `confirmed` means you checked the exact thing the result names, such as the address on that very page, and it agrees; evidence about anything else, however strong, is `concern`.
- `recommendation` is one short line on what the signer should look at, such as "Open the page and compare the address yourself." or "自己打開頁面比對地址。"; never a word that reads as approving the transaction.
- An address confirmed in fewer than two places, or a site no listing ties to the protocol, has its own steps in [addresses.md](addresses.md#when-the-program-confirms-fewer-than-two-places).

## An instance's notes

A per-instance report reads two files.

- The template's `notes.json` holds what every instance's report shares: `title`, `summary`, `protocols`, `fields`, the `flow` lines that name no entry the instance owns (the instance, the entries its attributes name and those it depends on), and the shared contracts' `entries`, `judgments` and `reviews`, among them every entry each instance with a report depends on or names as the same attribute, such as Fluid's Liquidity and LendingFactory, written once.
- The instance's own `notes.json`, in `templates/<protocol>/<operation>/instances/<instance>/`, holds only `verdict`, `flow`, `judgments`, `reviews`, `entries` and `pastTxsConclusion` about that instance, the entries only it names as attributes or depends on included, such as its asset.
  A `flow` line that names the instance, an entry its attributes name, such as its asset or its factory, or one it depends on, such as Fluid's Liquidity, goes here, since another instance's report cannot name it; the program refuses such a line in the template's file, even for an entry such as Liquidity whose `entries` and `reviews` are shared and written once in the template's file.
- Its `docs.json` sits beside it, written before `--record`, when a function's page is specific to this report, such as one that names the instance, its asset or another contract only this report covers.
- The program refuses a `reviews` key or `entries` name for any other contract, or for a test transaction, and a key or name both files define; the `flow` lines and the judgments of both each count toward four.
- Write the instance's notes in the signer's language even when the template's hold both, and leave every existing text as it is; the report is written in the languages both files hold, and `--render` refuses an instance's notes that share no language with the template's.
- Never write about another instance in an instance's notes.
