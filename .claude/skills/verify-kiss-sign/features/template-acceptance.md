# Template acceptance

A shipped template works end to end when a signer, in a fresh home set up for a Safe that did this operation, can approve the template, fill a card with the template's real prompts, get `MATCH` with a verify page for that Safe's executed transaction, and get `MISMATCH` naming the changed value when the same card meets the transaction with one value changed. The shipped templates are `eth/transfer`, `erc20/transfer`, `morpho/vault-deposit`, `fluid/vault-deposit`, `uniswap/swap`, `uniswap/swap-permit`, `uniswap/approve-permit2` and `uniswap/allow-router` (the last two in the batched journey); each has its journey below. A template passes only when every step of its journey passes as written.

## Sub-features

- `accept-eth-transfer` runs the journey for `eth/transfer`.
- `accept-erc20-transfer` runs the journey for `erc20/transfer`.
- `accept-morpho-vault-deposit` runs the journey for `morpho/vault-deposit`.
- `accept-fluid-vault-deposit` runs the journey for `fluid/vault-deposit`.
- `accept-uniswap-swap` runs the journey for `uniswap/swap`, `accept-uniswap-swap-permit` for `uniswap/swap-permit`, and `accept-uniswap-batched` for one card of `uniswap/approve-permit2`, `uniswap/allow-router` and `uniswap/swap`, which covers the two allowance templates.

## How to get to it (user POV)

- The signer's path is the report's 下一步: `template approve`, `card new`, `verify`. The same commands, in the same order, are the journey.

## Driving it with term.sh and screenshot.sh

Preconditions:

- One run per Safe, made with `--clone`: `eval "$("$V/new-run.sh" <run> <fixture safe> --clone)"`. `eth/transfer` and `erc20/transfer` share a Safe and may share a run.
- `"$V/term.sh" start "$KSV_RUN" "$KSV_CHECKOUT"`; every prompt is answered there. `verify` runs directly in `$KSV_CHECKOUT`.
- Each `T <cmd> ...` below is `"$V/term.sh" <cmd> "$KSV_RUN" ...`.

The journey, the same for every template; the table after it gives each template's values.

1. **Approve.** `T type 'bin/kiss-sign template approve <id>'`, `T wait '\[y/N\] *$' 60`, `T type y`, `T idle`. Pass: `Approved <id>.` and `exit=0`.
2. **Address book** (transfers only). `T type 'bin/kiss-sign book add <name> <recipient>'`, `T wait '\[y/N\] *$' 30`, `T type y`, `T idle`. Pass: `Added <name>.`. This stands for the signer's own entry; the address comes from the fixture.
3. **Card.** `T type 'bin/kiss-sign card new <id>'`, then for each prompt in the order shown, `T wait '<prompt regex>' 60` and `T type '<answer>'`, then `T wait '\[y/N\] *$' 60`, `T type y`, `T idle`. Pass: the printed card shows the fixture's Safe, every value as in the table with full addresses, `Sealed card 0x<hash>`, `exit=0`. Save the transcript: `T save "$KSV_EVIDENCE/<id-with-dash>-terminal.txt"`.
4. **Transaction.** `"$V/fixture-tx.mjs" <fixture> "$KSV_DIR/tx.json"`. It prints `executed true`.
5. **MATCH.** `bin/kiss-sign verify --card <hash> --tx "$KSV_DIR/tx.json"`, output and `exit=$?` saved to `$KSV_EVIDENCE`. Pass: `MATCH`, `  safeTxHash  <the fixture's safeTxHash>`, exit 0.
6. **Page.** `"$V/screenshot.sh" <printed .html> "$KSV_EVIDENCE/<id-with-dash>-match.png" 1280 2400`, then open the PNG. Pass: the header reads `· MATCH`, every check in the strip is green, the 比對清單 lists the calls of the table's shape, and 卡片 shows the card hash.
7. **Changed transaction.** `"$V/change-tx.mjs" "$KSV_DIR/tx.json" "$KSV_DIR/tx-changed.json" <change>` (it must print at least one place changed), then verify the same card against `tx-changed.json`. Pass: `MISMATCH`, a `fields:` line naming the changed argument with `expected <card value>, got <changed value>`, `No hashes are shown. Do not sign this transaction.`, exit 1.
8. **Keep.** Copy `home/cards/<hash>.json` and the printed verdict files and pages to `$KSV_EVIDENCE`, then `"$V/cleanup.sh" "$KSV_RUN"`.

| Template | Fixture (`testdata/safe-tx/`) | Safe, nonce | Book entry | Prompts and answers | Calls on the page | Change for MISMATCH | Expected `fields:` line |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `eth/transfer` | `eth-transfer-null-data` | `0x9467dcFD4519287e3878C018c02f5670465a9003`, 107 | `eth-payee 0x4942fbdc53B295563d59Af51e6DDEdceba5E332f` | `recipient: type its number (1-N):` → `eth-payee`; `amount (eth, 18 decimals):` → `4.988797943068499801` | one CALL to `eth-payee` with value 4988797943068499801 | `--value 4988797943068499802` | `call value: expected 4988797943068499801, got 4988797943068499802` |
| `erc20/transfer` | `erc20-transfer-usdc-other-safe` | `0x9467dcFD4519287e3878C018c02f5670465a9003`, 60 | `usdc-payee 0x519b70055af55a007110b4ff99b0ea33071c720a` | `token: type its number (1-N):` → `usdc`; `recipient: ...` → `usdc-payee`; `amount (usdc 0xA0b8..., 6 decimals):` → `841,909.711357` | `usdc.transfer(usdc-payee, 841909711357)` | `--address 0x519b70055af55a007110b4ff99b0ea33071c720a 0x000000000000000000000000000000000000dEaD` | `call.transfer to: expected 0x519b...720a, got 0x...dead` |
| `morpho/vault-deposit` | `morpho-vault-deposit-v2` | `0xdb6e9e7390e9ACC34619E56eFa48ade01cFF6F12`, 1566 | none | `vault: type its number (1-N):` → `hyperithm-usdc-apex-v2-9e2f`; `amount (usdc 0xA0b8..., 6 decimals):` → `1,000,611.448606`; `min-shares` is computed, not asked | MultiSend: `usdc.approve(general-adapter-1, 1000611448606)`, `bundler3.multicall` with `erc20TransferFrom` and `erc4626Deposit` | `--uint 1000611448606 1000611448607` | `multiSend[0].approve value: expected 1000611448606, got 1000611448607` (and the two bundle amounts) |
| `fluid/vault-deposit` | `fluid-deposit-usdt-other-safe` | `0x93BD8C5eb0eAB5BE7BfE156Ebfa0887AE7Dd0CEb`, 13 | none | `vault: type its number (1-N):` → `fluid-fusdt` (the list holds only `fluid-fusdc` and `fluid-fusdt`, each with its factory `fluid-lending-factory`); `amount (usdt 0xdAC1..., 6 decimals):` → `150,003.88885` | MultiSend: `usdt.approve(fluid-fusdt, 150003888850)`, `fluid-fusdt.deposit(150003888850, Safe)` | `--uint 150003888850 150003888851` | `multiSend[0].approve value: expected 150003888850, got 150003888851` and `multiSend[1].deposit assets: ...` |
| `uniswap/swap` | `uniswap-swap-usdc-usdt` | `0xD12e20E88A05Ce0F971ae6a6554337C7c075683d`, 37 | none | `sell-token: type its number (1-N):` → `usdc`; `buy-token: ...` → `usdt`; `sell-amount (usdc 0xA0b8..., 6 decimals):` → `130`; `min-buy (usdt 0xdAC1..., 6 decimals):` → `129.893802` | one CALL `universal-router-2.1.2.execute(0x10, [<V4_SWAP bytes>], deadline)` with a 22-byte `-extra` row | `--address 0xD12e20E88A05Ce0F971ae6a6554337C7c075683d 0x000000000000000000000000000000000000dEaD` | `call.execute.inputs[0].V4_SWAP.params[2].TAKE recipient: expected 0xd12e...683d, got 0x...dead`; `--uint 129893802 129893801` gives `...SWAP_EXACT_IN params.amountOutMinimum: expected at least 129893802, got 129893801` |
| `uniswap/swap-permit` | `uniswap-swap-permit-usdc-usdt` | `0xD12e20E88A05Ce0F971ae6a6554337C7c075683d`, 33 | none | `sell-token` → `usdc`; `buy-token` → `usdt`; `sell-amount (usdc ...)` → `24,000`; `min-buy (usdt ...)` → `23,978.654164` | one CALL `universal-router-2.1.2.execute(0x0a10, [<PERMIT2_PERMIT bytes>, <V4_SWAP bytes>], deadline)`; the page's 交易後保留的授權 lists the Permit2 allowance to `universal-router-2.1.2`, 無上限, with its expiration | `--address 0xD12e20E88A05Ce0F971ae6a6554337C7c075683d 0x000000000000000000000000000000000000dEaD` | `call.execute.inputs[1].V4_SWAP.params[2].TAKE recipient: expected 0xd12e...683d, got 0x...dead` |
| batched: `card new uniswap/approve-permit2 uniswap/allow-router uniswap/swap` | `uniswap-swap-approve-usdt-usdc` | `0xa51bC681d6cA3fEe6f309b93d84ddEe0a7e846aa`, 5 | none | operation 1 `token` → `usdt`; operation 2 `token` → `usdt`; `sell-token` → `usdt`; `buy-token` → `usdc`; `sell-amount (usdt ...)` → `4,342.485506`; `min-buy (usdc ...)` → `4,334.865289` (approve each of the three templates first) | MultiSend: `usdt.approve(permit2, 2^256-1)`, `permit2.approve(usdt, universal-router-2.1.2, 2^160-1, expiration)`, `universal-router-2.1.2.execute(0x10, ...)` with a 46-byte `-extra`; 交易後保留的授權 lists both allowances | `--uint 4334865289 4334865288` | `multiSend[2].execute.inputs[0].V4_SWAP.params[0].SWAP_EXACT_IN params.amountOutMinimum: expected at least 4334865289, got 4334865288` |
Second fixtures, for a rerun on another Safe: `eth-transfer-first-nonce` (Safe `0xc6835323372A4393B90bCc227c58e82D45CE4b7d`, nonce 0, 0.001 ETH), `morpho-vault-deposit-v2-other-safe` (Safe `0xBaDA5558640eAF3CE1836aFF8085f99615D45aFE`, 200,060.208382 usdc into `hyperithm-usdc-apex-v2-9e2f`), `fluid-deposit-usdc` (Safe `0xF4AE94450BEaaDdb8fA4059D68BbB7DE7E2DF980`, 244.093807 usdc into `fluid-fusdc`). The `erc20-transfer-usdc` and `erc20-transfer-usdt` fixtures are another Safe's too.

What `main` lacks today (2026-11-16, at 1836f6a), each a gap to fill, not a step to skip:

- `morpho/vault-deposit` into `steakhouse-prime-usdc-v2-0f51`: that vault has a report but no executed fixture. To cover it, record one with `pnpm record-safe-tx <name> <safe> <safeTxHash | nonce>` from another Safe that deposited into it (find one with `pnpm past-txs morpho/vault-deposit --token steakhouse-prime-usdc-v2-0f51 --anchor mint`).

## Gotchas

- `MISMATCH` must come from the `fields:` line naming the changed value. The changed transaction is simulated as pending on a nonce long used, so its simulation is `UNVERIFIABLE`; a bad change (one that did not apply) would show only that and must fail the journey. `change-tx.mjs` refuses a change that matches nothing.
- Choices come before amounts: `erc20/transfer` asks `token`, then `recipient`, then `amount`, and `eth/transfer` asks `recipient` then `amount`, whatever order the template file lists them.
- List numbers depend on the registry and the book; answer with the exact name, which the prompt accepts, so the journey does not break when an entry is added.
- `--address` replaces the address wherever it appears; pick a change that touches only the argument under test (for `erc20/transfer`, the recipient appears once).
- The `morpho/vault-deposit` card's `min-shares` comes from today's `previewDeposit`, below the old transaction's bound; MATCH still holds because the transaction asks for at least that many shares.
- Proven on 2026-11-16 for all four templates with the values above.
- The Uniswap journeys were proven on 2026-11-16 before the templates reached `main`, with the branch served as `main` from a local bare repository: the run's clone had `origin` set to `git@github.com:ipromise2324/kiss-sign.git` and `core.sshCommand` running `git-upload-pack` on that bare repository, as `test/verify.test.ts` does, so `template approve`, `card new` and `verify` ran unchanged; `replay` from the branch checkout gave the same verdicts.
- `uniswap/swap`'s `min-buy` is typed, from the minimum the app shows: the app's slippage comes from its trading API per quote. A typed value below the transaction's own minimum still matches (`atLeast`); one above it is `MISMATCH`.
- The 比對清單 shows each router input as one undecoded `bytes` value, as `check.sh` does; the recipient and minimum inside it are checked only by `verify`'s `fields:` lines.
- `--address` of the Safe changes only TAKE's recipient in these fixtures: the Safe's own address appears nowhere else in the data.
