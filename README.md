<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.svg">
    <img src="docs/logo.svg" alt="kiss-sign logo: an x on a signature line" width="120">
  </picture>
</p>

<h1 align="center">kiss-sign</h1>

<p align="center"><b><i>Keep it simple, stupid, and sign.</i></b></p>

kiss-sign checks a Safe multisig transaction against what you meant to do, before you sign it on a hardware wallet. You state the intent first, on a short card. A fixed program then checks the transaction against that card and prints `MATCH`, `MISMATCH` or `UNVERIFIABLE`.

> **Status.** It works end to end for the four operations listed under [What it can sign today](#what-it-can-sign-today). It has not been audited. The four templates were written by an AI and are being reviewed by their first signer now. Start every new operation with a small amount.

## Why

Every signature on a Safe makes you responsible for the exact bytes you approve. Today the transaction is built first and the signer checks it last. That last check is like the terms on an insurance form: everyone means to read it, and most people click sign.

Checking properly is slow. You have to rebuild the transaction yourself and know how it is encoded. Clear signing (ERC-7730) makes the final screen readable, but you still read it at the end and must notice what is wrong, and it does not yet decode Safe MultiSend batches.

The Bybit hack in 2025 showed the cost: the signers saw a normal transfer in a tampered Safe web app and signed a change to the Safe itself.

## How it works

kiss-sign turns the order around.

1. **Once per operation, an AI writes a template.** It researches the contracts, proves their ABIs by compiling the verified source, studies past transactions of other Safes, and opens a pull request with a generated report of its evidence. You read the report and merge. The AI never merges.
2. **At every signing, you fill a card in your own terminal.** You pick each vault or recipient from a numbered list with its full address and type the amount. You confirm the card and it is sealed under its hash, before you see any transaction.
3. **A fixed program judges.** `verify` recomputes the Safe hashes, decodes the transaction with the template, simulates it on two providers, and compares every change to the Safe's balances and allowances with the card.
   - `MATCH`: it does what the card says. Compare the two printed hashes with your hardware wallet's screen, then sign.
   - `MISMATCH`: something differs. Do not sign.
   - `UNVERIFIABLE`: it could not be proven either way. Do not sign.

The verdict is never the AI's judgment. The AI writes templates, and the program runs them.

![kiss-sign flow: build a template once per operation, then check every signing](docs/architecture.png)

## What it can sign today

| Template | Operation | You confirm |
|---|---|---|
| `eth/transfer` | Send ETH | amount, recipient from your address book |
| `erc20/transfer` | Send an ERC-20 token | token, amount, recipient from your address book |
| `morpho/vault-deposit` | Deposit into a Morpho vault | vault, amount |
| `fluid/vault-deposit` | Deposit into a Fluid fToken | vault, amount |

Each vault has its own report, under the template's `vaults/` folder. For another operation or vault, ask your AI to build it with the kiss-sign skill (`.claude/skills/kiss-sign/SKILL.md`). It opens a pull request for you to review.

Ethereum mainnet only. Safe multisig only.

## Two tiers

kiss-sign does not try to stop a prompt-injected AI. The AI that writes templates reads the web, and nobody yet knows how to stop such an AI from editing code it may edit. Pick how much else you trust.

**Basic.** kiss-sign runs on your work computer, and your AI may run there too. This stops attacks from outside kiss-sign. It does not stop kiss-sign itself being wrong or changed.

**Hardened.** Add a second computer that runs no AI and no kiss-sign, only Foundry's `cast`, `curl`, `jq` and one short script, [`kiss-sign-check`](https://github.com/ipromise2324/kiss-sign-check). Before you sign, you type `check.sh <nonce>` there. It fetches the transaction, computes its hashes itself, decodes every call, and labels each address from a list you wrote by hand. Both programs write an HTML page with the same comparison list (the 比對清單): the hashes and every call, argument by argument, one numbered row each. You compare the two pages row by row and the hashes with your hardware wallet. A broken or rewritten kiss-sign then cannot make you sign something other than what that computer decodes.

| Attack | Basic | Hardened |
|---|---|---|
| A tampered Safe web app shows one transaction and sends another, as at Bybit | Stopped | Stopped |
| The transaction does more or other than your card says | Stopped | Stopped |
| A call hands over the Safe: owner, module, guard, threshold, fallback handler or implementation change, or a `delegatecall` other than the official MultiSend | Stopped | Stopped |
| An unlimited approval, or any allowance that ends higher than it started | Stopped | Stopped |
| One RPC provider lies about the chain | Stopped | Stopped |
| A registry contract was upgraded since its review | Stopped (`MISMATCH` until the new code is pinned) | Stopped |
| A bug in kiss-sign, or an AI that rewrites kiss-sign, your cards or your config on the same computer | **Not stopped** | Stopped: you sign only what the second computer decodes |
| An address that is not the protocol's real contract | Rests on the report and your review | Rests on the report, your review and your own address list |
| A template that was wrong when you merged it | **Not stopped**. A small first amount catches crude mistakes | **Not stopped** |
| A contract that behaves differently for large amounts, turns hostile later through its settings, or two RPC providers that collude | **Not stopped** | **Not stopped** |

The full list of limits is in [Known limits](docs/design.md#known-limits).

Three habits close more of the gap:

- **Branch protection on `main`.** `verify` trusts your fork's `main`. With protection on, only your approval merges, and the AI pushes from an account that cannot approve or merge. That holds only while the AI cannot use your own GitHub credentials.
- **A small amount first.** The first time a template or a vault is used, send a small amount and wait for it to settle as expected.
- **Read every pull request's report.** A permission or parameter change moves no value, so a small amount cannot test it. It relies on the program's checks and on your review.

## Setup

You need Node 22.21 or later, pnpm, git, a GitHub account, a free [Alchemy](https://dashboard.alchemy.com/) key, and a hardware wallet that shows a Safe transaction's domain hash and message hash.

1. Fork this repository. Your fork's `main` is the program `verify` trusts, so merging a pull request into it is your confirmation, whether it changes a template or the program.
2. Clone your fork and set it up:

   ```sh
   git clone https://github.com/<you>/kiss-sign.git && cd kiss-sign
   pnpm install
   pnpm kiss-sign init --safe 0x…
   pnpm kiss-sign key add alchemy
   ```

   `init` writes `~/.kiss-sign/config.json` with your Safe and your fork. Your Safe's address stays there, never in the repository; a pre-push hook refuses any push that contains it or an API key. `key add` reads the key at a hidden prompt into `~/.kiss-sign/.env`, readable only by you.

3. Run every command from the clone as `pnpm kiss-sign <command>`.

To build templates, the research scripts also need a free [Etherscan](https://etherscan.io/myapikey) key (`pnpm kiss-sign key add etherscan`). They download the pinned compilers and lists they need on first use and refuse any file whose sha256 differs from its pin.

## Sign with it

```sh
git pull                                              # the lists you pick from must equal GitHub's main
pnpm kiss-sign template approve morpho/vault-deposit  # once per template version
pnpm kiss-sign card new morpho/vault-deposit          # pick the vault, type the amount, seal
# propose the transaction in the Safe web app as usual
pnpm kiss-sign verify --card <card hash> --safe-tx-hash <safeTxHash>
```

On `MATCH`, `verify` prints the domain hash and message hash and writes an HTML page with the card, the expected balance changes and the 比對清單. Compare both hashes with your hardware wallet, character by character, then sign.

The signer-facing pages, the report and `verify`'s page, are in Traditional Chinese. The terminal, the code and the docs are in English.

## What each check stops

When a template is built:

- **Addresses come from more than one source.** The protocol's own site or GitHub, cross-checked against DefiLlama and CoinGecko by `pnpm check-sources`, with the factory that created each vault proven on chain. Stops an address copied from a look-alike site.
- **ABIs are proven by compiling.** The verified source from Sourcify is compiled locally with a pinned `solc` and must match the code on chain. Stops an ABI that labels a field as something it is not.
- **Rules come from past transactions.** "`receiver` was the depositing Safe in all 42 past deposits" becomes the rule "`receiver` equals the Safe". Stops a field the template forgot to bind.
- **Every free field is perturbed.** Each field the template leaves free is changed and simulated; it must revert or change nothing. Stops a free field that quietly grants a permission.

At every signing:

- **The program checks itself first.** The clone must equal your fork's `main` byte for byte. Stops an edit made in the clone instead of through a pull request.
- **The card is sealed before you see the transaction.** Stops the transaction shaping what you think you asked for.
- **Every hash is recomputed.** Nothing from the Safe web app or its API is trusted. Stops a tampered interface.
- **Decode, then re-encode byte for byte.** Stops bytes hidden in the calldata.
- **Floor rules for every template.** No unlimited approval, no foreign `delegatecall`, no change to the Safe's owners, modules, guard, threshold, fallback handler or implementation, and no gas refund. Stops the attacks that take over the Safe.
- **Simulation on two providers.** Every change to the Safe's balances and allowances must be one the card explains, and Alchemy and drpc must agree. Stops hidden side effects and one lying provider.
- **Code pins.** Every registry contract the transaction touches must run the code its review pinned. Stops a contract upgraded since its review.

[docs/design.md](docs/design.md) is the source of truth for every check, data shape and limit.

## Contributing

Each signer owns their own fork, and their AI may change templates, the registry and the program in pull requests to it. This repository is a source of updates you pull when you want them:

```sh
git remote add upstream https://github.com/ipromise2324/kiss-sign.git
git pull upstream main && git push origin main
```

A program change (`src/`, `scripts/`, `docs/design.md`) works for you as soon as you merge it into your fork. Please also open it here, so other signers can review it and every fork keeps running the same program. Change `docs/design.md` first. Tests replay recorded transactions of other Safes and run offline with `pnpm test`.

## Security

Report a vulnerability privately through [GitHub's security advisories](https://github.com/ipromise2324/kiss-sign/security/advisories/new), not in a public issue.

kiss-sign never signs, never sends a transaction and never asks for a private key.

## License

TODO
