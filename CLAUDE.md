# CLAUDE.md

kiss-sign checks a Safe transaction against the signer's stated intent before they sign. [docs/design.md](docs/design.md) is the source of truth. If the code and the design disagree, stop and ask.

## Working with Maxey

- Talk to Maxey in Traditional Chinese. Write code, comments, commit messages, and docs in English.
- Work through pstack (`/pstack:poteto-mode`). New behavior follows the Feature playbook.

## Commands

- `pnpm install` also sets `core.hooksPath` to `.githooks`, which turns on the pre-push check.
- `pnpm fetch-solc` downloads every pinned solc (`src/contracts/solc-pins.ts`) into `vendor/solc/` and refuses a file whose sha256 differs from its pin. Run it once before `pnpm test`.
- `pnpm test` runs `node --test`. Tests run offline against recorded fixtures and the compilers in `vendor/solc/`; a missing compiler fails the test.
- `ALCHEMY_API_KEY=... pnpm prove-abi <address>` proves a contract's ABI live and prints the proof.
- `ALCHEMY_API_KEY=... pnpm record-abi-case <name> <address>` records an ABI-proof fixture into `testdata/abi/`.
- `ALCHEMY_API_KEY=... pnpm simulate <safe-tx fixture> --card '<card json>' [--record <name>]` simulates an executed Safe transaction on its parent block, reads its receipt, and prints both effects with their verdicts. `--record` writes `testdata/simulate/<name>.json`. `<safe> <nonce>` in place of a fixture name runs locally only and records nothing.
- `bin/kiss-sign init --safe <address>` writes `$KISS_SIGN_HOME/config.json` (chain 1). It refuses a home already set up for another Safe.
- `bin/kiss-sign book add <name> <address>` adds an address-book entry after you confirm it at a terminal; `book list` prints the book.
- `bin/kiss-sign template approve <protocol>/<operation>` fetches origin and records the keccak256 of that template as it is at origin/main in `$KISS_SIGN_HOME/approved-templates.json`, after you confirm at a terminal.
- `bin/kiss-sign card seal <card.json>` resolves every name, prints the card with full addresses, and after you confirm at a terminal stores it under `$KISS_SIGN_HOME/cards/<hash>.json` and prints the hash.
- `ALCHEMY_API_KEY=... bin/kiss-sign verify --card <hash> (--tx <file> | --safe-tx-hash <hash>)` runs the self-check against origin/main, then every check, and prints `MATCH` with the domain hash, message hash and safeTxHash, or `MISMATCH`/`UNVERIFIABLE` with the checks that caused it. `--tx` takes Transaction Service JSON or the Safe web app's JSON. An executed transaction is judged by its receipt; any other is simulated on the latest block. It writes a verdict file to `$KISS_SIGN_HOME/verdicts/`.
- `bin/kiss-sign replay <verdict file>` recomputes the verdict offline from the file alone and says whether it equals the recorded one.
- `pnpm typecheck` runs `tsc --noEmit`.
- `pnpm check-push origin/main..HEAD` runs the pre-push check on a range by hand.

## Code

- TypeScript with `strict` on. Node runs the `.ts` files directly; there is no build step.
- Keep runtime dependencies few. Every dependency is part of what a reviewer must trust.
- Parse external data once at the boundary into types that cannot hold an invalid state.
- Tests assert what a signer or caller can observe: verdicts, hashes, error messages. They do not assert internals.

## Safety rules

- Never sign, never ask for a private key, and never send a transaction.
- No committed file or commit message may contain the configured Safe address or an API key. The pre-push hook (`scripts/check-push.ts`) refuses a push that does. It reads the Safe from `$KISS_SIGN_HOME/config.json`, key values from `$KISS_SIGN_HOME/.env`, and extra forbidden strings from `$KISS_SIGN_HOME/push-deny`, and always checks `~/.kiss-sign` too.
- Fixtures come from other Safes doing the same operation, recorded with this repo's own scripts.
- API keys enter only through the command's environment or `$KISS_SIGN_HOME/.env`, never through the chat or a committed file.
- Code you download is untrusted. Put it in `vendor/<name>/` and read its install scripts before you run them.
- Ask Maxey before you make this repo public, force-push anything, or install anything globally.
