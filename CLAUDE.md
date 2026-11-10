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
