# HTML report

Each template has a generated report the signer reads before merging: `report.generated.md` and, for a template with `notes.json`, the same page in each language the notes hold, `report.generated.en.html` (English) and `report.generated.zh-TW.html` (Traditional Chinese): header with check strip, Flow (流程) diagram, protocol, vault, To review (待確認), Wallet display (錢包顯示), Addresses (地址), Past transactions (過去交易), Next steps (下一步). The signer reads the one their config's `language` names, or the only one there is. `pnpm report <id> [--instance-of <vault>] --render` writes those files from the committed recordings, reading nothing live; `pnpm test` fails when one differs from what the recordings give, is missing, or is in a language the notes do not hold.

## Sub-features

- `report-render` rewrites both files from recordings; byte-identical to the committed ones on a clean checkout.
- `report-offline` prints the Markdown to stdout (`--offline`).
- `report-per-vault` requires `--instance-of` for a template reported per vault and refuses without it, naming the vaults.
- `report-page` renders the HTML page with no script and nothing loaded from outside.
- `report-language` writes `report.generated.<language>.html` for each language `notes.json` holds and only those, and removes a page in a language it no longer holds; every text of one notes file holds the same languages, and a per-vault report is written in the languages both its template's and its vault's notes hold. A page whose notes hold one language says so under the summary (這份報告只有繁體中文版。 or This report exists only in English.).

## How to get to it (user POV)

- `pnpm report <protocol>/<operation> --instance-of <vault> --render`, then open `templates/<protocol>/<operation>/instances/<vault>/report.generated.en.html` (or `.zh-TW.html`; a report may exist in one language only).
- For a template not yet rebuilt (`src/template/vault-reports.ts`), `pnpm report <protocol>/<operation> --render` and `templates/<protocol>/<operation>/report.generated.en.html` or `.zh-TW.html`, each only when `notes.json` holds that language.
- On GitHub, the signer reads `report.generated.md` in the pull request.

## Driving it with term.sh and screenshot.sh

Preconditions:

- Any checkout (the branch under test, or the run's clone). No key needed for `--render`/`--offline`.
- First run downloads the pinned solc builds and the Public Suffix List into `vendor/` (about 45 s); later runs are quicker.

- **Render.** `cd "$KSV_CHECKOUT" && pnpm -s report morpho/vault-deposit --instance-of hyperithm-usdc-apex-v2-9e2f --render > "$KSV_EVIDENCE/report-render.txt" 2>&1; echo "exit=$?" >> "$KSV_EVIDENCE/report-render.txt"`. The last line before `exit=0` is `wrote templates/morpho/vault-deposit/instances/hyperithm-usdc-apex-v2-9e2f/report.generated.md and .../report.generated.en.html and .../report.generated.zh-TW.html`.
- **Byte check.** `git status --short` in the same checkout prints nothing on main. On a branch that changes the renderer, `git diff --stat templates/` shows what the change does to committed reports.
- **Page.** `"$V/screenshot.sh" "$KSV_CHECKOUT/templates/morpho/vault-deposit/instances/hyperithm-usdc-apex-v2-9e2f/report.generated.zh-TW.html" "$KSV_EVIDENCE/report.png" 1280 9000` and open the PNG. It shows the contents rail (流程, morpho-blue, 金庫, 待確認, 錢包顯示, 地址, 過去交易, 下一步), the title `存入 Morpho vault` with `AI 研究` tags, the check strip (地址來源, 原始碼驗證, 合約沒被換掉, 參數保護, 雙節點比對); the `.en.html` page shows the same in English (Flow, To review, Address sources, Two providers), the 流程 diagram (你的 Safe, usdc, bundler3, general-adapter-1), and per-argument rows.
- **Refusal.** `pnpm -s report morpho/vault-deposit --render` without `--instance-of` refuses and names `hyperithm-usdc-apex-v2-9e2f` and `steakhouse-prime-usdc-v2-0f51`.

## Gotchas

- `--render` overwrites the committed files in the checkout it runs in. In the run's clone, a non-empty `git status` afterwards makes `verify`'s self-check fail; restore with `git checkout -- templates/` before verifying.
- The page is dark-only by design; a dark screenshot is correct.
- The report is long: a 4000 px screenshot cuts it. Raise the height or take several, and check the bottom sections (下一步) separately.
- `--record` and `--compare` read live and need `ALCHEMY_API_KEY`; `--record` rewrites recordings under `testdata/`. Neither belongs in a verification run unless the change under test is the research itself.
