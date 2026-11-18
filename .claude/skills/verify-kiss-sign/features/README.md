# kiss-sign verification map

This directory is the maintained source for verifying what a signer sees and does with kiss-sign. Read this index, then the matching feature file as the recipe. The harness is the helpers in `../bin/` (see `../SKILL.md`).

## Baseline preconditions

- A run made with `eval "$("$V/new-run.sh" <run> <safe> --clone)"`, where `<safe>` is the `safe` of the fixture the journey uses. `KISS_SIGN_HOME` points at the run's `home/`, never `~/.kiss-sign`.
- `bin/kiss-sign key list` in `$KSV_CHECKOUT` prints `alchemy ALCHEMY_API_KEY: set (file)`.
- `$KSV_CHECKOUT` is at origin/main with `git status --short` empty.
- Network to GitHub (origin fetch), Alchemy and drpc (chain reads), and on first `pnpm report` the solc and Public Suffix List downloads.
- Never drive a home or tmux server that this run did not create.

## Driving conventions

- Prompting commands (`card new`, `card seal`, `template approve`, `book add`) go through `term.sh` in the run's tmux; anything else runs directly with `KISS_SIGN_HOME` exported.
- Wait on the prompt strings, never on a fixed sleep. Chain reads take seconds; a whole `verify` about 10 s.
- Answer a list by its number or exact registry name, as the signer does. Never type an address the list did not print.
- Put every file you make (tx JSON, card JSON) in `$KSV_DIR`, never in the clone, or `verify`'s self-check fails.
- Copy side effects out of `home/` into `$KSV_EVIDENCE` before cleanup.

## Proof and skip reporting

- Terminal proof: the saved transcript (prompts, answers, result line) and the exit code.
- Page proof: the HTML file and a screenshot that was opened and looked at.
- Side-effect proof: the sealed card file, the verdict file, a `replay` that prints `Same verdict as recorded.`
- Report an unreachable path with the attempted command and the unmet precondition. Do not report a skipped entry point as verified through another one.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior, then exactly four H2 sections: `Sub-features`, `How to get to it (user POV)`, `Driving it with term.sh and screenshot.sh` (starting with `Preconditions:`), and `Gotchas`.

## Fixture for the journeys

`testdata/safe-tx/morpho-vault-deposit-v2.json`: Safe `0xdb6e9e7390e9ACC34619E56eFa48ade01cFF6F12`, nonce 1566, a `morpho/vault-deposit` of 1,000,611.448606 usdc into `hyperithm-usdc-apex-v2-9e2f`, executed. Write its Transaction Service JSON with:

```sh
"$V/fixture-tx.mjs" morpho-vault-deposit-v2 "$KSV_DIR/tx.json"
```

Another executed fixture works the same way when its template exists on `main` and, for a template reported per vault, its vault has a folder under `templates/<id>/instances/`.

## Features

- [Template approve](./template-approve.md): record a merged template's fingerprint after a `[y/N]`.
- [Card new](./card-new.md): fill and seal a card at the terminal; also `card seal` from a file.
- [Verify](./verify.md): judge a transaction against a sealed card, `MATCH`/`MISMATCH`/`UNVERIFIABLE`, and the verify page.
- [Replay](./replay.md): recompute a verdict offline from its file.
- [Template acceptance](./template-acceptance.md): the end-to-end journey each shipped template must pass, MATCH and MISMATCH.
- [HTML report](./html-report.md): render a template's HTML report from its recordings and screenshot it.
