Part of [the kiss-sign design](../design.md).

## Who owns the program

Each signer owns their own kiss-sign: they fork the repository and clone their fork, and their fork's `main` is what `verify` trusts.
There is no maintainer.
No one upstream reviews or merges a change, and the signer is not expected to read the program's code; the upstream repository is only a source of updates the signer may pull.
Three kinds of pull request reach `main`, and different hands merge them:

- **Templates and the registry,** the hand-written files under `templates/` and `registry/`: the signer reads the report, runs `--compare` from main, and merges.
  Merging is the signer's confirmation.
  The AI never merges one.
- **The program,** every other file, the [verdict core](#the-verdict-core) included: the AI merges it itself, with a merge commit, once [`pnpm program-gate`](#the-program-gate), run from main's code, prints `ELIGIBLE` and a fresh AI reviewer, given the diff and not the author's conclusions, finds no security regression.
  The signer does not read it.
  A program pull request never changes a template or the registry, and one that changes the verdict core never changes the gate.
- **The program gate,** the canaries that test the verdict, their list and what they read, and the code that enforces these rules: the signer reviews and merges it, as they do a template, and the AI never does.

This is the signer's decision of 2026-11-17: they will not maintain the program and cannot be expected to read its code, so a review that waited for them would either never come or come without reading.
Signed commits, which would tie each merged commit to a key the AI does not hold, were considered (D14) and declined.

kiss-sign does not try to stop a prompt-injected AI.
The AI that writes templates reads the web, and no one yet knows how to stop such an AI from editing code it is allowed to edit. kiss-sign keeps these guards instead:

- **`verify` runs exactly what is on the signer's own `main`.**
  The self-check below refuses any other origin, commit or file, unless something on the work computer rewrites the clone and the self-check together.
- **The signer's review of every template and registry change,** with the generated report and `--compare`.
- **The program gate for every program change:** the canaries must still pass, and the change cannot touch them, run from main's code so the branch cannot change the gate that judges it.
- **The hardware wallet's hash comparison.**
  The signer compares the domain hash and the message hash on `verify`'s page with the device's screen, every character.
- **In the hardened tier, the independent computer.**
  It decodes the transaction the hash commits to without kiss-sign, so a kiss-sign that is wrong or changed cannot make the signer sign something other than what it decodes.

**What this leaves open.**
A program change is merged on the gate and an AI reviewer, not on a person.
The gate proves only what the canaries test.
A change that weakens a check no canary covers passes it.
For example, a branch that changes one comparison in `src/verify/assets.ts`, `if (actual !== asset.address)` to `if (actual !== actual)`, so a vault whose `asset()` is not the registry's token is never reported, and deletes the one test in `test/morpho-migrate.test.ts` that would catch it, printed `ELIGIBLE` with all 12 canaries and the other 1,186 tests passing (measured 2026-11-17).
The gate now refuses it twice: that test has since moved into a canary, and no branch the AI merges may drop a test main runs, so the gate names the deleted test (see [The program gate](#the-program-gate)).
A check no canary covers is still open in the ways the next sentence names.
It compares test titles, not what a test asserts, so the same branch that keeps the test and changes its expected answer, or empties it, still prints `ELIGIBLE`, as does one that hides the test from the title scan, such as by skipping it through a variable.
Merged, every card naming such a vault would `MATCH` on that check.
Only the reviewer stands between that branch and `main`, and an AI reviewer can be misled as the author was.
The same holds for a branch that changes no core file at all but, when the signer runs a research command, rewrites what the signing commands read and do not check, such as the git config (see [The program gate](#the-program-gate)); a package it rewrites in `node_modules`, with no tracked file, is refused at the next signing (see [The installed packages](#the-installed-packages)).
Nor can the gate tell a weakened check from one that detects the canary's own transaction and answers as the canary expects.
In the basic tier nothing else catches such a change.
In the hardened tier the independent computer still decodes the transaction the hash commits to, so the signer sees the calls they sign, the vault's address among them; it confirms that both computers see the same transaction, not that the transaction is the one the signer meant, so a weakened check the signer does not notice in the decoded calls still goes through.

The pre-push check stays too; it keeps the Safe's address and the API keys out of published commits, which protects privacy, not the program.

### The verdict core

Only a small part of the program decides a verdict: the Safe transaction's hash, decoding and encoding again, the floors, the simulation on both providers, the effects, the field checks, the self-check, the verdict and its replay.
The research tools, such as `pnpm report`, `check-sources`, `past-txs`, `erc7730` and `instance-evidence`, write what the signer reads but never run at signing.
A pull request that changes a template and, beside it, one comparison in the verdict code would change what `verify` checks for every signing while the signer reads the template's report; so the two never share a pull request.

- **The core is derived, not chosen.**
  It is every file the signing commands can run: `pnpm verdict-core` walks the imports from `bin/kiss-sign`, the one entry of `init`, `book`, `key`, `template approve`, `card new`, `card seal`, `verify` and `replay`, following every import that is not type-only and every script or JSON file a core file names by a relative path, such as one it spawns, and adds `package.json`, `pnpm-lock.yaml` and `pnpm-workspace.yaml` once a core file imports a package.
  A test runs `bin/kiss-sign` and requires the files Node loads to be exactly the list, so the walk cannot miss one.
  It writes the list to `docs/verdict-core.txt`, and `pnpm test` fails when the list differs from the walk.
  A type-only import is left out, since Node erases it and its file never runs.
  The research files the signing commands do import, such as `src/research/source-page.ts`, which the registry parser uses, and `src/research/api-source.ts`, which reads a CoW order, are core like any other.
- **The rule.**
  A branch may not change a core file and a hand-written file under `templates/` or `registry/` together.
  The diff is taken from where the branch left `origin/main` (`git diff origin/main...<branch>`), so merging `main` into a branch never trips it, and the core is walked at both ends, so a file the branch adds to the core or takes out of it counts.
  The check that enforces the rule counts as core too: `src/verdict-core.ts`, `scripts/check-push.ts`, `scripts/report.ts` (which holds `--compare`), the program gate's `src/canaries.ts`, `src/canary-reads.ts` and `scripts/program-gate.ts`, `.githooks/` and `.github/workflows/`, and so does `.gitignore`, which decides what the self-check lets lie beside the clone.
  A branch that git cannot compare with `origin/main`, such as one pushed when the clone has no `origin/main`, is refused, since the check cannot tell what it changes.
  A program change goes first, in its own pull request, merged behind the [program gate](#the-program-gate); the template that needs it follows in another.
- **What stays free.**
  Research code, docs and `test/` may change beside a template, since none of them runs at signing.
  `testdata/` is free on both sides, except what a canary reads (below): its recordings feed only the tests and the reports, never `verify`, and a core change needs its own fixtures.
  The reports `pnpm report` renders from recordings, `report.generated.md`, `report.generated.<language>.html` and `registry/reports/<vault>.generated.md`, which no command writes any more, are not hand-written, and `pnpm test` fails when one differs from what its recordings give, so a core change that alters a rendering may write the existing ones again.
  Adding or deleting one counts as data: a vault's `report.generated.md` is what lets `card seal` and `verify` accept that vault.
- **Where it is enforced.**
  `pnpm check-push` refuses such a branch before it is pushed, CI refuses it on every pull request and every push to `main`, and `pnpm report --compare`, which the signer runs with main's code, refuses it again, so a pull request that also weakens the check does not pass its own.
  A pull request can still rewrite its own CI job; `--compare` from main is the check it cannot change, and since `scripts/report.ts` is guarded, no template pull request can weaken it for the next one.
  The diff counts from `origin/main` as the clone last fetched it, so the signer fetches `main` before `--compare`; a stale one shows a core change already merged as the branch's own.
  A template branch stacked on an unmerged core branch is refused until the core branch merges.

### The program gate

The AI merges a program change without the signer, so what it must not be able to do is change the tests that judge it in the same branch.
The gate is that set of tests and the code that runs them, kept apart from the verdict core by the same diff the core is kept apart from templates by.

- **The canaries.**
  `docs/canaries.txt` lists, as data, the tests that prove the verdict still refuses known-bad transactions: each names one file under `test/canaries/`, what it guards, and every path under `testdata/` or `test/` it reads.
  They cover the recorded attacks (Bybit, WazirX, Radiant), the mutation of every bound field, the field check and the template rules that keep an address from being free, the floors, the card floors, the effects and their tolerances, a token or ETH that moves when no effect names it, a vault whose `asset()` is not the registry's token, allowances left raised, the perturbation recordings, the code pins, how checks become a verdict, `verify` and `replay` as the signer runs them, a Transaction Service record whose fields do not hash to its safeTxHash, `verify --safe-tx-hash` given another transaction than the one asked, and the self-check.
  A canary is a `*.canary.ts` file, so `node --test 'test/**/*.test.ts'` does not pick it up; `test/canaries.test.ts` runs each in a process of its own with a hook that records every path it reads through `node:fs`, and fails when one does not pass, reads a path under `testdata/` or `test/` its block does not name, or is a file in `test/canaries/` the list does not hold.
- **The gate.**
  Every canary and every file under `test/canaries/`; every file a canary imports that the verdict core does not hold, walked as the core is, such as `src/attacks/attacks.ts` and `test/repo-with-test-fixtures.ts`; every path the list says a canary reads; `docs/canaries.txt`; and the code that enforces the rules: the guards the core rule names, `src/canaries.ts`, `src/canary-reads.ts`, `scripts/program-gate.ts`, `test/canaries.test.ts`, the kiss-sign skill, which tells the AI what it may merge, and `package.json`, `pnpm-lock.yaml` and `pnpm-workspace.yaml`, since a new dependency or a changed script is code no canary reads.
- **The rule.**
  A branch that changes a verdict core file may not change a gate file.
  Like the core rule, it is counted from where the branch left `origin/main`, the gate is read at both ends, and `pnpm check-push`, CI and `pnpm report --compare` refuse the branch, naming both sets of files.
  A branch that changes a gate file is a gate change: the signer reviews and merges it, never the AI, and a verdict core change that needs it follows in another pull request.
  `--compare` prints such files under `PROGRAM CHANGE  gate:`.
- **Eligibility.**
  `pnpm program-gate <branch>` says whether the AI may merge a branch.
  It runs in a clone whose checkout is exactly `origin/main`, every tracked file hashed from disk, so the gate that judges the branch is main's and not the branch's own, and refuses to run anywhere else.
  It resolves the branch to one commit, judges only that commit and names it, and the AI merges only that commit (`gh pr merge --match-head-commit`).
  The branch must hold `origin/main`, merged in, so the canaries and tests it carries are main's latest and not those of where it left.
  It prints the verdict core files and the other program files the branch changes, then, without running any of the branch's code, stops at `NOT ELIGIBLE` when the branch changes a hand-written file under `templates/` or `registry/`, a gate file, or cannot be compared, and when the branch drops a test `origin/main` runs.
  For that it reads every `*.test.ts` file under `test/` at both commits from git as text, skipping comments, strings and regular expressions, and takes each call of `test`, `it`, `describe` or `suite` whose title is a string or template literal.
  A call does not run when it is `.skip` or `.todo`, names `skip` or `todo` as an option key (`{ skip: true }`), calls `t.skip()` or `t.todo()` in its own body, or sits inside a call that does not run.
  Each title main runs in a file must run in the same file on the branch as often, so a test deleted, renamed, moved to another file, commented out or skipped is named with its file.
  A branch that also changes a verdict core file is refused with exit 1; one that leaves the core alone is the signer's to merge, exit 3, so two pull requests, the first dropping the test and the second changing the core, cannot do what one may not.
  The check reads titles only: a test registered under a non-literal title, one skipped through a variable or a computed key, one wrapped in a condition that never holds, one whose `test` is not `node:test`'s, a case taken out of the table a loop of tests reads, and a test whose assertions change are not seen, and only the reviewer stands between such a branch and `main`.
  Otherwise it checks the branch out into a temporary worktree beside main's `node_modules` and `vendor/`, which the unchanged package files make the branch's own, fetches any pinned solc or Public Suffix List the branch needs, and runs the typecheck, each canary of main's list with main's runner and read hook, and every other test.
  It prints each canary with what it guards and its counts, then checks that the run left every tracked file of main's checkout and of the worktree as committed.
  It prints `ELIGIBLE` and exits 0 only when all of this passes; anything else is `NOT ELIGIBLE` with each reason, exit 3 when the reason is only that the branch changes a template, the registry or the gate, or drops a test while leaving the core alone, the signer's to merge, and exit 1 otherwise.
  CI runs the same command as the `program-gate` job on `pull_request_target`, which runs main's workflow file and main's code against the pull request's head, with no secret and read-only access, so the branch can change neither.
  The job fails on exit 1 and passes on exit 3 with the notice "The signer merges this pull request", so a red job means a check failed, not that the pull request is the signer's; the AI reads the `ELIGIBLE` line, never the job's color alone.
- **Paths.**
  The diff is read with git's paths unquoted, so a name with a non-ASCII character is classified like any other, and every rule compares paths without letter case, since the signer's macOS clone writes `.Githooks/x` into `.githooks/`.
  `tsconfig.json` and `.npmrc` are gate files too, since they decide what the typecheck and an install accept.
- **What it runs.**
  The branch's code runs in the canaries, the tests and the branch's own `scripts/fetch-vendored.ts` with the rights of whoever runs the gate, before and between the canaries, which run in parallel.
  Code written to defeat the gate can change a canary file or the read hook before a canary loads it and put it back before the after-run check, change files that check does not read, such as `node_modules`, or detect a canary and answer as it expects.
  That holds in CI too, where the runner gives the job root.
  The after-run check catches honest accidents, not an attack; against code written to defeat the gate, only the reviewer stands.
- **Code outside the core.**
  The core rule and the gate cover what `verify` runs from the clone.
  A research command such as `pnpm report --compare` or `pnpm history`, merged by the AI with no canary in play, runs with the signer's rights.
  A package it rewrites in `node_modules`, and nothing else, is refused by the next signing command, which checks every package it loads against its pin before it loads one (see [The installed packages](#the-installed-packages)).
  What else such code can change, such as the git config the fetch reads or `$KISS_SIGN_HOME`, is not checked (see [Known limits](known-limits.md#known-limits)); only the reviewer stands between such a change and the signer.

## The program checks itself first

kiss-sign runs from one clone of the signer's own fork.
`kiss-sign verify` starts with a self-check before anything else:

1. Every URL of `origin` must be the repository the signer's config names (their own fork): `repo` in `$KISS_SIGN_HOME/config.json`, such as `github.com/<owner>/kiss-sign`, in its https or ssh form.
   `init` records it from the clone's `origin`, read the same way, and refuses an origin that is not one GitHub https or ssh URL; a config without `repo` stops every signing command until `init` runs again.
   The URL is read with the same git config the fetch uses, after any `url.<base>.insteadOf` rewrite.
   An origin elsewhere is not fetched.
2. Fetch `main` from `origin` into `origin/main`, ignoring any configured fetch refspec, which could map another branch there.
3. Every object of that commit, the commit itself, its trees and its files, must hash to its name.
   Git does not check this when it reads an object, so a rewritten object file would otherwise change a template or the registry read from it.
4. The local checkout must be exactly `origin/main`: `HEAD` at that commit, every file of the commit on disk with the same bytes and mode, hashed from disk rather than asked of `git status`, and no other file that the commit's root `.gitignore` does not ignore.
   The index, `.git/info/exclude`, `core.excludesFile`, attributes, filters, stat settings and an untracked `.gitignore` take no part in this step.
5. If anything differs, stop and name the files.
   Nothing is verified.

Templates are read from that commit, so a template counts only after its pull request is merged.
`main` changes only through pull requests.

`card new` and `card seal` read the template and the registry from the clone, so a pull request merged on GitHub and not yet pulled would leave the signer picking from old lists.
Each runs steps 1 to 3 first, then requires every file under `templates/` and `registry/` on disk to have the bytes and mode origin/main gives it, hashed from disk as in step 4, and no other file there that the commit's `.gitignore` does not ignore.
On any difference it stops before asking anything, prints one plain line, `templates/ and registry/ here are not main of <repo> on GitHub; run git pull, then run this again.`, and names the files.
When GitHub cannot be reached or the origin is refused, it stops the same way, saying it could not check.
It does not require the rest of the checkout to be `main`, as `verify` does: this check is about the lists the signer picks from, not the program that judges.

### The installed packages

The self-check hashes the files git tracks.
The packages the program loads live in `node_modules/`, which `.gitignore` ignores, so every command of `bin/kiss-sign`, `verify` among them, first checks those packages against `pnpm-lock.yaml`, and does it before it loads any of them, since a package's code runs as it loads and could change what a later check sees:

1. Read `pnpm-lock.yaml` from the clone: each package the root importer's `dependencies` name, and each package those depend on, with the sha512 of its tarball (`integrity`).
   `devDependencies`, such as TypeScript, are not loaded by any signing command and are not checked.
2. Find each package's `integrity` in `src/verify/package-pins.ts`, which holds the sha256 of every file of that tarball.
   `node scripts/pin-packages.ts [<name>@<version>...]` writes a pin: it downloads the tarball from registry.npmjs.org, requires its sha512 to equal the lockfile's `integrity` (or, for a version the lockfile does not hold yet, npm's `dist.integrity`), and hashes each file in it.
   With no names it pins every package step 1 lists.
3. Find the folder Node loads each package from, as Node resolves it from `bin/kiss-sign`, or from the package that depends on it, with symlinks followed, and require its files, hashed from disk, to be exactly the pinned ones: none changed, missing or added, and nothing in it that is not a file or a folder.
   Node looks for a package first beside the file that imports it, so a `node_modules` folder anywhere under `bin/` or `src/`, where the program's code lives, is refused too, in any letter case, since macOS opens `NODE_MODULES` for it.
   An optional package pnpm installs only on other systems, such as another CPU's build, may be missing.

On any difference, a package with no pin, or a lockfile it cannot read, it names each problem, prints `the installed packages are not the ones pnpm-lock.yaml names, so nothing was run; remove node_modules, run pnpm install --frozen-lockfile, then run this again.`, and stops, so `verify` writes no verdict.
The pins are part of the verdict core, so the self-check holds them to `main` and only a program pull request changes them.
A dependency update pins the new tarball first, in a program pull request, and changes the lockfile after, in a gate pull request the signer merges; until both are merged and installed, the commands refuse.
`pnpm test` runs the check on the clone's own `node_modules`, so CI, where pnpm checks each tarball it downloads against the lockfile's sha512, confirms that the pins are those tarballs' files.

The lockfile's sha512 is of the tarball, which pnpm does not keep after it installs, so the files on disk cannot be checked against it offline; the pins carry that sha512 to the files once, through the network, and every check after reads no network.
Two other ways were not taken. pnpm's store keeps a hash of every file it installed, in pnpm 12 in a SQLite `index.db` of its own format, but it is a local file that a program on the same computer can rewrite as easily as `node_modules`; the pins are in the clone, held to `main`.
`pnpm install --frozen-lockfile --offline` checks the lockfile against `package.json` and, when `node_modules` looks current, does not hash what is installed; it would also put pnpm itself, which is not part of the core, in the path of every signing.

What the check does not catch: the lockfile and the pins are read from the clone as they are on disk.
`verify`'s self-check then holds them to `main`, but only after the program has loaded, as it holds every other tracked file, so code that rewrites a package together with the lockfile or the pins is caught by `verify` only if the loaded package does not defeat the self-check, and by the other commands not at all, as for any tracked file (see [Known limits](known-limits.md#known-limits)).
Nor does it catch Node itself; what changes the code Node runs without changing these files, such as `NODE_OPTIONS` with `--import` or `--require`, or a hook loaded by another; a change to the files after the check, while the program runs; and a package the program loads that the lockfile's `dependencies` do not name, such as a `devDependency` a core file imports.

This catches accidental edits and an AI that was tricked into changing a check or a template in the clone rather than through a pull request.
It cannot catch anything that deliberately rewrites both a check and the self-check itself, such as an AI on the same computer, because the self-check is part of the same program.
The hardened tier's independent check does not run kiss-sign, so such a change cannot alter what it decodes.
See Known limits and Later security upgrades.
