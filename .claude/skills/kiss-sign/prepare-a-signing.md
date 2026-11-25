# Prepare a signing

How to do [Prepare a signing](SKILL.md#prepare-a-signing): what to tell the signer, who runs every step in their own terminal.
The flow is in [Every signing](../../../docs/design/flow.md#every-signing).

## The signer's steps

The signer runs every command from the clone as `pnpm kiss-sign <command>`, after `git pull`:

1. Once per merged template, and again whenever it changes: `pnpm kiss-sign template approve <protocol>/<operation>`.
2. `pnpm kiss-sign card new <protocol>/<operation>`.
   It first fetches GitHub's `main` and stops, telling the signer to `git pull`, when the clone's `templates/` or `registry/` differ from it.
   It lists each contract, market or recipient with its full address; the signer picks by number, or by the exact name, full address or market id as listed.
   It asks each amount in whole tokens (commas between thousands allowed), reading a registry token's decimals on chain itself; ETH is 18 with no read, and a token outside the registry is asked in base units.
   It does not ask a computed field, such as a vault deposit's `min-shares`: it checks that every contract the read names runs its pinned code, reads the declared view, applies the template's slippage, and prints the value with its slippage and source for the signer to check.
   A swap's minimum (a field with a `floor`) follows the two tokens picked:
   - Both have a feed and the same peg, and the feeds' stated deviations sum to at most 50 bps: it asks only the slippage the app shows (Enter is 0.50%, at most 1.00%) and computes the minimum.
   - Both have a feed, otherwise: the signer types the app's minimum, and one more than 2.50% below the price must be typed twice.
   - Either token has no feed: it says there is no independent price, and the signer types the app's minimum once.

   When the price is in doubt (a late feed, a lost peg, a pool that disagrees, is thin or gives no mean price) it says why, computes nothing, and the minimum must be typed twice.
   It refuses the card, with nothing to type, when a feed's answer is not above 0, its time is 0 or in the future, it reverts, or its description or decimals are not the registry's; when a feed or pool runs other code than its pin; or when the providers disagree.
   It ends with the card in one box and asks the seal question; on the signer's yes it stores the card and prints its hash, which `verify --card` takes, before the signer sees the Safe transaction.
3. After the transaction is proposed in the Safe web app: `pnpm kiss-sign verify --card <card hash> --safe-tx-hash <safeTxHash>`.

When the card has an amount the signer types, tell the signer to name a small amount the first time a template or an instance is used, as the report advises; no program enforces it, and the full amount gets a new card once the small transaction has settled as expected ([Every signing](../../../docs/design/flow.md#every-signing), step 13, Small amount first).

The Next steps (下一步) section at the bottom of the signer's HTML report walks through these steps and this template's prompts.

## A recipient not in the address book

Tell the signer to add it in their own terminal with `pnpm kiss-sign book add <name> <address>`, taking the address from a source outside this chat and checking it character by character.

## The hardened tier

If the signer uses it, remind them to run the `./check.sh` command `verify` prints after `MATCH`, `--hints` included, from `ipromise2324/kiss-sign-check` on their independent computer, which runs no AI and no kiss-sign.
They compare its hashes with the hardware wallet, its page's 比對清單 row by row with the one on `verify`'s page, and its decoded calls with what they meant to do.
Never offer to run it.
