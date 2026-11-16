# Template acceptance

A shipped template works end to end when a signer, in a fresh home set up for a Safe that did this operation, can approve the template, fill a card with the template's real prompts, get `MATCH` with a verify page for that Safe's executed transaction, and get `MISMATCH` naming the changed value when the same card meets the transaction with one value changed. The shipped templates are `eth/transfer`, `erc20/transfer`, `morpho/vault-deposit` and `fluid/vault-deposit`, and the Safe settings templates `safe/add-owner`, `safe/remove-owner`, `safe/swap-owner` and `safe/change-threshold`; each has its journey below. A template passes only when every step of its journey passes as written.

## Sub-features

- `accept-eth-transfer` runs the journey for `eth/transfer`.
- `accept-erc20-transfer` runs the journey for `erc20/transfer`.
- `accept-morpho-vault-deposit` runs the journey for `morpho/vault-deposit`.
- `accept-fluid-vault-deposit` runs the journey for `fluid/vault-deposit`.
- `accept-safe-settings` runs the journeys for `safe/add-owner`, `safe/remove-owner`, `safe/swap-owner` and `safe/change-threshold`.

## How to get to it (user POV)

- The signer's path is the report's 下一步: `template approve`, `card new`, `verify`. The same commands, in the same order, are the journey.

## Driving it with term.sh and screenshot.sh

Preconditions:

- One run per Safe, made with `--clone`: `eval "$("$V/new-run.sh" <run> <fixture safe> --clone)"`. `eth/transfer` and `erc20/transfer` share a Safe and may share a run.
- `"$V/term.sh" start "$KSV_RUN" "$KSV_CHECKOUT"`; every prompt is answered there. `verify` runs directly in `$KSV_CHECKOUT`.
- Each `T <cmd> ...` below is `"$V/term.sh" <cmd> "$KSV_RUN" ...`.

The journey, the same for every template; the table after it gives each template's values.

1. **Approve.** `T type 'bin/kiss-sign template approve <id>'`, `T wait '\[y/N\] *$' 60`, `T type y`, `T idle`. Pass: `Approved <id>.` and `exit=0`.
2. **Address book** (transfers and owner changes). `T type 'bin/kiss-sign book add <name> <recipient>'`, `T wait '\[y/N\] *$' 30`, `T type y`, `T idle`. Pass: `Added <name>.`. This stands for the signer's own entry; the address comes from the fixture.
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
| `safe/add-owner` | `safe-add-owner-raise-threshold` | `0x579B18E60d0245c0F66Fa9463610b15E226Ae8FD`, 8 | `new-owner 0x383965940c950008a4b67bfaa477fdf6ac91a7f7` | `owner: type its number (1-N):` → `new-owner`; `threshold (how many owners must sign, a whole number from 1):` → `2` | one CALL to the Safe itself: `addOwnerWithThreshold(new-owner, 2)` | `--address 0x383965940c950008a4b67bfaa477fdf6ac91a7f7 0x000000000000000000000000000000000000dEaD` | `call.addOwnerWithThreshold owner: expected 0x3839...a7f7, got 0x...dead` |
| `safe/remove-owner` | `safe-remove-owner-first` | `0xF6C9969B45739e7c32E91F43e4ae246b215F49F8`, 13 | `old-owner 0x4057bea8a5e2710ea78b7656045f3e6ec90f54f2` | `owner: ...` → `old-owner`; `threshold (...)` → `2` | `removeOwner(0x…0001, old-owner, 2)` on the Safe itself | `--uint 2 3` | `call.removeOwner _threshold: expected 2, got 3` |
| `safe/swap-owner` | `safe-swap-owner-first` | `0x2D0E888C73D4a053BD19D8e918aDcf52F76cf55F`, 42 | `old-owner 0xe759d1ab235d44ae86e7029af07fb444acc61d1c`, `new-owner 0xd97a2244f2c697f7361141dd91698a01ebe485e6` | `old-owner: ...` → `old-owner`; `new-owner: ...` → `new-owner` | `swapOwner(0x…0001, old-owner, new-owner)` on the Safe itself | `--address 0xd97a2244f2c697f7361141dd91698a01ebe485e6 0x000000000000000000000000000000000000dEaD` | `call.swapOwner newOwner: expected 0xd97a...85e6, got 0x...dead` |
| `safe/change-threshold` | `safe-change-threshold-raise` | `0xa8352e01E3Afe3703407616d0B645821dD4D07c3`, 10 | none | `threshold (...)` → `2` | `changeThreshold(2)` on the Safe itself | `--uint 2 3` | `call.changeThreshold _threshold: expected 2, got 3` |
| `fluid/vault-deposit` | `fluid-deposit-usdt-other-safe` | `0x93BD8C5eb0eAB5BE7BfE156Ebfa0887AE7Dd0CEb`, 13 | none | `vault: type its number (1-N):` → `fluid-fusdt` (the list holds only `fluid-fusdc` and `fluid-fusdt`, each with its factory `fluid-lending-factory`); `amount (usdt 0xdAC1..., 6 decimals):` → `150,003.88885` | MultiSend: `usdt.approve(fluid-fusdt, 150003888850)`, `fluid-fusdt.deposit(150003888850, Safe)` | `--uint 150003888850 150003888851` | `multiSend[0].approve value: expected 150003888850, got 150003888851` and `multiSend[1].deposit assets: ...` |

Second fixtures, for a rerun on another Safe: `eth-transfer-first-nonce` (Safe `0xc6835323372A4393B90bCc227c58e82D45CE4b7d`, nonce 0, 0.001 ETH), `morpho-vault-deposit-v2-other-safe` (Safe `0xBaDA5558640eAF3CE1836aFF8085f99615D45aFE`, 200,060.208382 usdc into `hyperithm-usdc-apex-v2-9e2f`), `fluid-deposit-usdc` (Safe `0xF4AE94450BEaaDdb8fA4059D68BbB7DE7E2DF980`, 244.093807 usdc into `fluid-fusdc`). The `erc20-transfer-usdc` and `erc20-transfer-usdt` fixtures are another Safe's too.

What `main` lacks today (2026-11-16, at 1836f6a), each a gap to fill, not a step to skip:

- `morpho/vault-deposit` into `steakhouse-prime-usdc-v2-0f51`: that vault has a report but no executed fixture. To cover it, record one with `pnpm record-safe-tx <name> <safe> <safeTxHash | nonce>` from another Safe that deposited into it (find one with `pnpm past-txs morpho/vault-deposit --token steakhouse-prime-usdc-v2-0f51 --anchor mint`).

- `safe/*` until it is merged: `template approve`, `card new` and `verify` need the templates on GitHub's main. On 2026-11-16 the branch `safe-admin` proved steps 4 to 7 with its own code through verify's evaluation (not its self-check) on all eight `safe-*` fixtures: each executed transaction `MATCH`ed its card by receipt with its Transaction Service safeTxHash, `bin/kiss-sign replay` reproduced every verdict, and the four changes in the table gave `MISMATCH` with the `fields:` line shown. Steps 1 to 3 and the page screenshot run once it is merged.

## Gotchas

- `MISMATCH` must come from the `fields:` line naming the changed value. The changed transaction is simulated as pending on a nonce long used, so its simulation is `UNVERIFIABLE`; a bad change (one that did not apply) would show only that and must fail the journey. `change-tx.mjs` refuses a change that matches nothing.
- Choices come before amounts: `erc20/transfer` asks `token`, then `recipient`, then `amount`, and `eth/transfer` asks `recipient` then `amount`, whatever order the template file lists them.
- List numbers depend on the registry and the book; answer with the exact name, which the prompt accepts, so the journey does not break when an entry is added.
- `--address` replaces the address wherever it appears; pick a change that touches only the argument under test (for `erc20/transfer`, the recipient appears once).
- The `morpho/vault-deposit` card's `min-shares` comes from today's `previewDeposit`, below the old transaction's bound; MATCH still holds because the transaction asks for at least that many shares.
- A changed `safe/remove-owner` or `safe/swap-owner` transaction is judged as pending at the latest block, where the old owner is already gone, so a second `fields:` line also names `prevOwner` (`who is not an owner of the Safe`). That line is expected; the changed argument's line is the pass condition.
- Proven on 2026-11-16 for the four transfer and deposit templates with the values above.
