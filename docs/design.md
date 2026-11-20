# kiss-sign design

kiss-sign checks a Safe transaction against what the signer meant to do, before the signer signs it on a hardware wallet.
The signer states an intent in plain words.
An AI researches the operation and writes a reusable template for it.
A fixed program runs that template against the proposed transaction and prints `MATCH`, `MISMATCH`, or `UNVERIFIABLE`.
The hashes to compare on the hardware wallet print only on `MATCH`.

The rule the whole design keeps: **the AI writes templates, the program runs them.**
The verdict is never the AI's judgment.
`MATCH` means the transaction matches the template and the card the signer approved.
If the AI is fooled during signing, the worst outcome must be `UNVERIFIABLE` or `MISMATCH`, never a wrong `MATCH`, as long as the program that runs is the one on the signer's `main`.
A program rewritten on the work computer can print any verdict; that is the basic tier's limit (see [Two tiers](#two-tiers)).
A template that was wrong when the signer approved it is not caught by any check; that risk is carried by the review and its evidence.

## Who does what

| Actor | Does | Never does |
|---|---|---|
| Signer | Owns their fork of kiss-sign; states intents, reads reports, merges template and registry pull requests and changes to the program gate, fills and confirms intent cards, confirms address-book entries, proposes on Safe, in the hardened tier runs the independent check, compares hashes on the hardware wallet | Pastes keys into the chat |
| AI (any coding agent) | Researches addresses, ABIs and past transactions; writes the report; writes the template, and changes the program when an operation needs it, a change to the verdict core in a pull request of its own; opens the pull request to the signer's fork; merges a program pull request itself once the [program gate](design/program-ownership.md#the-program-gate) passes and a fresh review finds no security regression | Merges a template, registry or program gate pull request, fills or seals a card, decides a verdict, asks for or prints an API key |
| Program (the engine) | Fetches and hashes the Safe transaction, decodes it, runs the template's checks, simulates, compares effects with the card | Reads web pages, follows instructions found in data |
| Independent check (hardened tier) | Fetches the transaction by nonce, computes its hashes, decodes each call | Reads kiss-sign, its templates or its registry; compares the transaction with the card |

### Who authorises what

Each action that lets a change or a signing through has one owner.
The last column is what must hold before the action, and who or what enforces it.

| Action | Who | What must hold first |
|---|---|---|
| Merge a template or registry pull request | The signer | The signer reads the report and runs `pnpm report <protocol>/<operation> --compare --data origin/<branch>` from `main`, with `--instance-of <instance>` for each per-instance report the branch changes. `pnpm check-push`, run by CI, refuses the branch if it also changes the verdict core. See [Who owns the program](design/program-ownership.md#who-owns-the-program). |
| Merge a program pull request | The AI, with a merge commit | `pnpm program-gate`, run from main's code, prints `ELIGIBLE`, and a fresh AI reviewer, given the diff and not the author's conclusions, finds no security regression. See [The program gate](design/program-ownership.md#the-program-gate). |
| Merge a program gate pull request | The signer | The signer reviews it as they do a template. `pnpm program-gate` stops at `NOT ELIGIBLE` and names the gate files. `pnpm check-push` refuses the branch if it also changes the verdict core. |
| Approve a template | The signer | `template approve` requires every `origin` URL to be the config's `repo`, fetches its `main`, prints the commit and the template's keccak256, and records that hash only after the signer's yes at a terminal. |
| Add an address-book entry | The signer | `book add` asks for the signer's yes at a terminal. The address comes from a source outside the chat and is checked character by character. |
| Fill and seal a card | The signer | `card new` refuses without a terminal. `card new` and `card seal` stop when the clone's templates or registry differ from GitHub's `main`. `card seal` stores the card only after the signer's yes. |
| Sign | The signer, on the hardware wallet | `verify` prints `MATCH` for the sealed card, its self-check having passed on the signer's `main`. The signer compares every character of the domain hash and the message hash with `verify`'s page and, in the hardened tier, checks the independent computer's page row by row. |

### Security invariants

The design states each of these in full where it links.

1. The verdict is never the AI's judgment: the AI writes templates and the program runs them ([Who does what](#who-does-what)).
2. `MATCH` needs every check to report its own pass or not to be needed for the card; any failed check gives `MISMATCH`, and otherwise any check that could not finish or did not run gives `UNVERIFIABLE` ([Every signing](design/flow.md#every-signing), step 12).
3. No address on a card is typed by the AI: each is a registry name, an address-book name or the Safe ([Intent card](design/data-shapes.md#intent-card)).
4. No template can loosen the floors ([Engine checks that every template gets](design/engine-and-chain.md#engine-checks-that-every-template-gets)).
5. Every registry contract the transaction or the card touches, and each entry these name in `dependsOn`, runs the code its registry pin names, and an executed transaction the pin whose span holds its block ([Engine checks that every template gets](design/engine-and-chain.md#engine-checks-that-every-template-gets)).
6. `verify` runs only the exact `main` of the signer's own fork, unless something on the work computer rewrites the clone and the self-check together, and a template counts only after its pull request is merged ([The program checks itself first](design/program-ownership.md#the-program-checks-itself-first)).
7. The AI never merges a template, registry or program gate pull request, and never fills or seals a card; the skill, the program gate and the terminal prompts keep an honest AI from these, not one that means harm ([Who does what](#who-does-what), [Two tiers](#two-tiers)).
8. A program pull request never changes a hand-written template or registry file, only re-renders an existing generated report, and one that changes the verdict core never changes the program gate ([Who owns the program](design/program-ownership.md#who-owns-the-program)).
9. A card naming an instance with no report for its template is refused ([No report, no signing](design/flow.md#first-time-an-operation-is-done-build-its-template), step 6).
10. The Safe's address and the API keys are never published ([The Safe's address is never published](design/engine-and-chain.md#the-safes-address-is-never-published)).

### The program offers checks, the AI picks them

The same split holds for a protocol no one has tested.
The program offers a generic vocabulary a template declares as data: field rules, effects, view reads, computed card fields, registry attributes and their factory checks, and the shapes under [Data shapes](design/data-shapes.md#data-shapes).
Each is protocol-free and enforced exactly as declared.
The AI's research picks which of them an operation needs and their parameters, such as which view to read and which slippage to apply, and gives each choice a cited reason, which the report prints and `pnpm past-txs` tests against real transactions.
The AI never writes code that becomes a check.
When the vocabulary cannot say what an operation needs, the program gains a new generic shape through a pull request with the design changed first; the template never uses a looser rule in its place.

No template can loosen the floors, whatever it declares (see [Engine checks that every template gets](design/engine-and-chain.md#engine-checks-that-every-template-gets)):

- No address is free, nor a tuple or an array that holds one, so a call's target and a payment's recipient are always bound.
- No `delegatecall` except to the official MultiSend.
- No change to the Safe's owners, threshold, modules, guard, fallback handler or implementation, except an owner or threshold change the card's `effects.safe` declares.
- No allowance from the Safe ends higher than it started, except one `effects.approves` declares, and none is unlimited except a registry entry's standing allowance.
- Every change to the Safe's balances is one the effects explain; no other token changes.
  The only slack is a `tolerance` the template declares on an effect or a registry token, in the direction it names and by at most 10 base units each (see `effects` under [Template](design/data-shapes.md#template)).
- The Safe's fee fields are zero, and every registry contract touched runs its pinned code.

### Two tiers

kiss-sign does not try to stop a prompt-injected AI.
The signer picks how much else to trust.

**Basic: kiss-sign only.**
Everything runs on one computer, the signer's work computer, and the AI may run there too.

| Step | Where | Who |
|---|---|---|
| 1. Research, write the template, open a pull request | The work computer | The AI. It never merges a template or the registry; a program change it needs goes first, in a pull request of its own, which the AI merges behind the [program gate](design/program-ownership.md#the-program-gate). |
| 2. Read the report and the template, run `pnpm report <protocol>/<operation> --compare --data origin/<branch>` from `main`, with `--instance-of <instance>` for each per-instance report the branch changes, approve and merge | GitHub, and the work computer | The signer |
| 3. `git pull`, approve the template, fill the card with `pnpm kiss-sign card new` (which stops when the clone is behind GitHub's `main`), seal, verify | The work computer, in the signer's own terminal | The signer |
| 4. The first time a template or a vault is used, send a small amount first | Safe | The signers |
| 5. Sign, comparing the full hashes | Hardware wallet | The signer |

As long as nothing on the work computer writes the clone, `$KISS_SIGN_HOME` or the git config, the basic tier stops attacks from outside kiss-sign: a tampered Safe web app that shows one transaction and sends another, as in the Bybit hack, provided the signer compares every character of the domain hash and the message hash on the hardware wallet with those on `verify`'s page, since a web app that proposes the intended transaction and then asks the wallet to sign another passes `verify`, which saw only the one proposed; a transaction that differs from the card; and balance or allowance changes the template's effects do not explain.
It does not stop kiss-sign itself being wrong or changed: a bug, an AI that edits the program, the clone or `$KISS_SIGN_HOME` on the same computer, a harmful template pull request the signer merged, or a harmful program pull request the AI merged that no canary catches (see [Who owns the program](design/program-ownership.md#who-owns-the-program)).
Anything that can write the clone can rewrite a check and the self-check together, and anything that can write `$KISS_SIGN_HOME` can change the config, the sealed cards and the approved template hashes.
An AI on the same computer can also reach the signer's API keys and, often, the signer's own GitHub credentials, which can merge.

**Hardened: add an independent computer.**
That computer runs no AI and no kiss-sign.
Before signing, the signer runs the [independent check](design/independent-check.md#the-independent-check-hardened-tier) there, with the command `verify`'s page prints, and compares its hashes with the hardware wallet, its page's [比對清單](design/independent-check.md#the-比對清單) row by row with the one on `verify`'s page, and its decoded calls with what they meant to do.
A change to kiss-sign cannot change what that computer decodes.

| Step | Where | Who |
|---|---|---|
| 1 to 4 | As in the basic tier | As in the basic tier |
| 5. `check.sh <nonce> [--hints '<hints>']`, as `verify` prints it; compare its hashes with the hardware wallet and its page's 比對清單 with the one on `verify`'s page | The independent computer | The signer |
| 6. Sign, comparing the full hashes | Hardware wallet | The signer |

- The work computer needs a clone of the signer's own fork, `pnpm install`, and `pnpm kiss-sign init --safe <address> [--language en|zh-TW]`, which records the repository the clone's `origin` names as the one to trust and the language the signer reads the HTML report, `verify`'s page, the 比對清單 included, whose words `check.sh`'s `LANGUAGE` must match, and the signing commands' terminal text in, English unless they choose Traditional Chinese (run again, `init` keeps the language unless `--language` changes it, and on a home already set up `pnpm kiss-sign init --language <language>` keeps the Safe and changes the language); every command runs from the clone as `pnpm kiss-sign <command>`.
  What `init`, `book add` and `book list`, `template approve`, `card new`, `card seal`, `verify`, `replay` and `pnpm history` print is in that language: the layout, the prompts and the refusals they write themselves.
  A command run before any config exists, or whose config cannot be read, prints English, or the language its `--language` names.
  Every command but `pnpm test` and `pnpm typecheck`, that is `pnpm kiss-sign <command>`, `node scripts/pin-packages.ts` and every other `pnpm` script, such as the research commands, `pnpm fetch-solc`, `pnpm report`, `pnpm check-push` and `pnpm program-gate`, prints its help in English on stdout and exits 0 when `--help` or `-h` follows the command's own words, such as `pnpm kiss-sign card seal --help` or `pnpm history fetch -h`, before it reads the config, a key, a file under `vendor/` or the network; the help names the design section that holds the command's full rules. A `--help` or `-h` later on the line, after `--` or a value, is not a request for help, since it may name a file. `pnpm kiss-sign` first checks the installed packages against their pins ([The installed packages](design/program-ownership.md#the-installed-packages)), and when they differ it refuses, `--help` included.
  Addresses, hashes, numbers, token symbols, registry names, commands and flags, the verdict words `MATCH`, `MISMATCH` and `UNVERIFIABLE`, and check keys such as `fields` stay as they are in every language, as does each prompt's ending, such as `(1-3): ` or `[y/N] `, so a script waiting on a prompt waits for the same text.
  Columns align by display width, a Chinese character taking two of the 100 columns, and a line breaks at a space or between Chinese characters, never inside an address or a hash.
  The details a check gives, such as `multiSend[0].approve value: expected 1000611448606, got 1000611448607`, are stored in the verdict file in English, as the check wrote them, so `replay` compares the same text whatever the language.
  The verdict box and `verify`'s page show each one in the configured language when it has one of the fixed shapes the program knows, such as `expected ..., got ...`, `expected at least ...`, `who is not an owner of the Safe` or `changed by ..., the card explains ...`, translating only those fixed words, so Traditional Chinese shows `multiSend[0].approve value：應為 1000611448606，實際 1000611448607`; a path, value, address, name or check key is never translated, and a detail of any other shape, such as a provider's error, or one with a part of no known shape, shows as stored, in English, never half translated.
  `pnpm history` writes `not run` for a transaction it did not run as 未執行 in Traditional Chinese.
  The language changes no verdict, no refusal, no stored file and no card hash.
  `key add`, `key list` and `key remove`, and the research scripts, print English.
  Every command runs from the clone, so the self-check checks that clone and `git pull` updates what runs.
  `init` also creates `$KISS_SIGN_HOME/.env` for the keys.
  The signing commands read no vendored download.
  The research scripts and `pnpm test` download the pinned solc builds, Public Suffix List and ERC-7730 archive they need on first use, each refused unless its sha256 is the pinned one.
- The AI does not fill or seal a card: `card new` refuses without a terminal, and `card seal` and `template approve` each ask for the signer's yes.
  These keep an honest AI from doing it.
  They do not stop an AI on the same computer that means harm; that is the basic tier's limit.
- Branch protection on `main` is still recommended, since `verify` trusts `main`: changes only through pull requests, with the CI jobs `test` and `verdict-core-apart` required.
  The `program-gate` job, which runs main's workflow and main's code, says whether the AI may merge a program pull request; it does not run on a pull request that changes only `templates/`, `registry/` and `testdata/`, and it passes, with the notice "The signer merges this pull request", on one `pnpm program-gate` answers with exit 3, so it is not a required check.
  The AI merges program pull requests itself, so it holds merge rights, and nothing in GitHub then tells a template pull request it may not merge from a program one; that rests on the skill, the gate's checks, and the signer's habit of merging templates alone.
  These are GitHub settings the signer makes.
  On a private repository GitHub offers branch protection only with a paid plan.
- A small first transaction catches honest mistakes and crude attacks, such as a wrong vault or a template that sends funds elsewhere.
  It does not catch a contract that behaves differently for large amounts, or one that turns hostile later.
- A permission or parameter change, a call that moves no value, cannot be tested with a small amount.
  It relies on the program's checks and on the review of its template.

## [The flow](design/flow.md#the-flow)

- [First time an operation is done: build its template](design/flow.md#first-time-an-operation-is-done-build-its-template)
- [Every signing](design/flow.md#every-signing)

## [Data shapes](design/data-shapes.md#data-shapes)

- [Template](design/data-shapes.md#template)
- [Standing allowances](design/data-shapes.md#standing-allowances)
- [Signed messages](design/data-shapes.md#signed-messages)
- [Markets](design/data-shapes.md#markets)
- [Registry attributes and instance checks](design/data-shapes.md#registry-attributes-and-instance-checks)
- [Intent card](design/data-shapes.md#intent-card)
- [Verdict file](design/data-shapes.md#verdict-file)

## [What goes on GitHub](design/engine-and-chain.md#what-goes-on-github)

- [The Safe's address is never published](design/engine-and-chain.md#the-safes-address-is-never-published)

## [Engine checks that every template gets](design/engine-and-chain.md#engine-checks-that-every-template-gets)

## [Chain access](design/engine-and-chain.md#chain-access)

- [Research services](design/engine-and-chain.md#research-services)

## [Who owns the program](design/program-ownership.md#who-owns-the-program)

- [The verdict core](design/program-ownership.md#the-verdict-core)
- [The program gate](design/program-ownership.md#the-program-gate)

## [The program checks itself first](design/program-ownership.md#the-program-checks-itself-first)

- [The installed packages](design/program-ownership.md#the-installed-packages)

## [The independent check (hardened tier)](design/independent-check.md#the-independent-check-hardened-tier)

- [Hints](design/independent-check.md#hints)
- [The 比對清單](design/independent-check.md#the-比對清單)

## [Known limits](design/known-limits.md#known-limits)

## [Later security upgrades](design/known-limits.md#later-security-upgrades)

## [Out of scope](design/known-limits.md#out-of-scope)

