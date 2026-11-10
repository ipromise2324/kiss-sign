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
- `ALCHEMY_API_KEY=... pnpm prove-instance <registry name>` asks the factory the entry's `factory` attribute names, through its registry `instanceCheck` (such as `isMetaMorpho(address)`), whether it created that contract, and prints the answer both providers gave.
- `pnpm fetch-psl` downloads the pinned Public Suffix List (`src/research/public-suffix.ts`) into `vendor/publicsuffix/` and refuses a file whose sha256 differs from its pin. `pnpm check-sources` needs it.
- `pnpm check-sources [<registry name>...] [--record <name>]` compares each registry entry's `source` with the protocol its `defillama` slug names on DefiLlama: the registrable domain, found with the Public Suffix List, against the protocol's website, or for a github.com source its org against the protocol's GitHub orgs. For each `token` and `vault` entry it checks that CoinGecko lists the coin its `coingecko` id names at its address. With no names it checks every entry. Each line prints what it compared; each disagreement, missing listing, or missing Public Suffix List prints as `FINDING` for Maxey to judge; nothing fails. `--record` writes `testdata/sources/<name>.json`.
- `ALCHEMY_API_KEY=... pnpm record-abi-case <name> <address>` records an ABI-proof fixture into `testdata/abi/`.
- `ALCHEMY_API_KEY=... pnpm simulate <safe-tx fixture> --card '<card json>' [--record <name>]` simulates an executed Safe transaction on its parent block, reads its receipt, and prints both effects with their verdicts. `--record` writes `testdata/simulate/<name>.json`. `<safe> <nonce>` in place of a fixture name runs locally only and records nothing.
- `pnpm past-txs <protocol>/<operation> --token <registry name | address> --anchor mint|burn|any [--from <registry name | address>] --from-block <n> --to-block <n> [--record <name>]` finds executed Safe transactions of one operation through an ERC-20 `Transfer` of `--token` (`mint` for a vault deposit, `burn` for a withdrawal, `any` for a transfer; `any` with `--from` for a reward the distributor pays out). Alchemy and Etherscan both search, and the report marks a transaction only one of them found. It decodes each with the template and prints, per field, how many transactions and Safes held the template's rule, plus the misfits grouped by reason. It prints numbers and addresses only; a byte or string value prints as its length. The configured Safe is left out of every count and recording. It needs `ALCHEMY_API_KEY` and `ETHERSCAN_API_KEY`, from the environment or `$KISS_SIGN_HOME/.env`. `--record` writes `testdata/research/<name>.json`.
- `pnpm research-parse <answer.json>` parses the `researcher` subagent's answer (`.claude/agents/researcher.md`) against `src/research/answer.schema.json` and prints it with addresses lowercased. An unknown key, a value the schema does not admit, or text that is not JSON exits 2 and names only the path that broke the schema.
- `pnpm contract-origin <registry name | address>... [--record <name>]` reads each contract's verified name, creator, factory and creation transaction from the Etherscan API. A name that is not an identifier of at most 64 characters is refused and not printed. It needs `ETHERSCAN_API_KEY`, from the environment or `$KISS_SIGN_HOME/.env`. `--record` writes `testdata/etherscan/<name>.json`.
- `bin/kiss-sign init --safe <address>` writes `$KISS_SIGN_HOME/config.json` (chain 1). It refuses a home already set up for another Safe.
- `bin/kiss-sign book add <name> <address>` adds an address-book entry after you confirm it at a terminal; `book list` prints the book.
- `bin/kiss-sign template approve <protocol>/<operation>` fetches origin and records the keccak256 of that template as it is at origin/main in `$KISS_SIGN_HOME/approved-templates.json`, after you confirm at a terminal.
- `bin/kiss-sign card seal <card.json>` resolves every name, prints the card with full addresses, and after you confirm at a terminal stores it under `$KISS_SIGN_HOME/cards/<hash>.json` and prints the hash.
- `ALCHEMY_API_KEY=... bin/kiss-sign verify --card <hash> (--tx <file> | --safe-tx-hash <hash>)` runs the self-check against origin/main, then every check, and prints `MATCH` with the domain hash, message hash and safeTxHash, or `MISMATCH`/`UNVERIFIABLE` with the checks that caused it. `--tx` takes Transaction Service JSON or the Safe web app's JSON. An executed transaction is judged by its receipt; any other is simulated on the latest block. It writes a verdict file to `$KISS_SIGN_HOME/verdicts/`.
- `bin/kiss-sign replay <verdict file>` recomputes the verdict offline from the file alone and says whether it equals the recorded one.
- `pnpm history fetch` downloads every multisig transaction of the configured Safe from the Safe Transaction Service into `$KISS_SIGN_HOME/history/txs.jsonl`.
- `ALCHEMY_API_KEY=... pnpm history [--out <file.md>] [--refresh]` runs each executed transaction in `$KISS_SIGN_HOME/history/` through the checks `verify` runs, with the card in `history/cards/<nonce>.json` and each template approved at its origin/main hash for the run, and prints one row per nonce with its verdict and, for each non-MATCH, its reason (`cow-next-phase` for a CoW order pre-signed or cancelled, `refused-by-design`, `no-card-yet`, or the verdict's causes), then a summary. Chain answers are cached per nonce in `history/cache/`, so a rerun is offline; `--refresh` reads them again. `--out` writes the same as Markdown, outside the repository. `history/registry.json` adds local registry entries, `history/address-book.json` local address-book entries, and `history/notes.json` a note per nonce. A note `{ "note": "...", "spentBy": <nonce> }` marks an approval that a later nonce spends; when the approval has no card, its row takes that nonce's reason. The spending nonce must be in the history and must not be an approval spent by another nonce.
- `pnpm attacks` replays real blind-signing attacks on Safes offline from `testdata/attacks/<case>/`: per case, what the signers believed as a card with names and full addresses, the transaction that ran, decoded, and each verdict with the checks that caught it. An Ethereum case runs verify as of the block before execution twice, simulated as a pending transaction and judged by its receipt. `ALCHEMY_API_KEY=... pnpm attacks --record <case>` reads the case's transaction from the Safe Transaction Service and its chain answers live into `recording.json`.
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
