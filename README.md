<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.svg">
    <img src="docs/logo.svg" alt="kiss-sign logo: an x on a signature line" width="120">
  </picture>
</p>

<h1 align="center">kiss-sign</h1>

<p align="center"><b><i>Keep it simple, stupid, and sign.</i></b></p>

> [!WARNING]
> kiss-sign is still under development and is not ready for real use. Do not rely on it to sign transactions yet.

Signing tools today show you a transaction and ask whether it looks right. Your intent is checked last, by you, at the moment you are most likely to click through. kiss-sign turns that around: you say what you want first, your AI researches the operation once and writes a report you review, and every Safe transaction is checked against what you said before you sign on a hardware wallet.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/readme/overview-dark.png">
  <img src="docs/readme/overview.png" alt="kiss-sign at a glance. You say what you want. Once per operation, your AI finds each contract's address and kiss-sign confirms it in two separate sources; kiss-sign proves each contract's ABI by checking its published source is the code on chain; using that ABI, your AI writes a rule for every value in the transaction and lists the contracts it calls behind the scenes; kiss-sign finds a year of real transactions of the same kind and your AI sets safe limits from them; kiss-sign reads the protocol's size, past hacks and holders and your AI weighs audits and incidents; kiss-sign records each contract's code so a later upgrade is caught, and writes a report, with your AI's notes marked, which your AI sends you as a pull request to read, merge and approve. At every signing you fill a card; kiss-sign verify simulates the transaction on two providers and checks it against the card; a clean computer with no AI decodes it on its own with check.sh; and you compare the hashes on your hardware wallet before signing.">
</picture>

## Contents

- [Why](#why)
- [Install](#install)
  - [Your computer: kiss-sign](#your-computer-kiss-sign)
  - [A second, clean computer: kiss-sign-check (strongly recommended)](#a-second-clean-computer-kiss-sign-check-strongly-recommended)
- [How it works](#how-it-works)
  - [1. Tell your AI what you want](#1-tell-your-ai-what-you-want)
  - [2. Review the report and merge](#2-review-the-report-and-merge)
  - [3. Fill a card](#3-fill-a-card)
  - [4. Verify on your computer, and check on a second one](#4-verify-on-your-computer-and-check-on-a-second-one)
  - [5. Sign](#5-sign)
- [Threat model](#threat-model)
- [Scope](#scope)
- [Contributing](#contributing)
- [Disclaimer](#disclaimer)
- [Donate](#donate)
- [License](#license)

## Why

- **You are responsible for the exact bytes you sign.** Today the transaction is built first and checked last, when most people just click sign. At Bybit in 2025, the signers saw a normal transfer in a tampered Safe web app and signed the attacker's transaction.
- **Checking by hand is slow and needs expertise.** Tools such as [safe-tx-hashes](https://github.com/pcaversaccio/safe-tx-hashes-util) compute the hashes your wallet should show, but you still decode the data yourself. Here is one real Morpho vault deposit, from another Safe: first what safe-tx-hashes prints, shortened, then the data decoded by hand with cast.

  ![Two terminal runs on one Morpho vault deposit. First, safe-tx-hashes prints the hashes your hardware wallet should show; Safe's API decodes the first call, an approve, and leaves the second call, the one that moves the USDC into the vault, undecoded (dataDecoded: null); the script warns that it does not verify the decoded parts and that you must decode the data yourself. Second, decoding by hand with cast: you count byte offsets to split MultiSend's packed calls; the approve lets 0x4A6c…0aE0 spend 10,001 USDC; the second call is Bundler3's multicall holding an erc20TransferFrom that pulls 10,001 USDC from the Safe and an erc4626Deposit into vault 0x7777…7777 with a maximum share price of 1.054e15 (scaled by 1e27), shares to the Safe](docs/readme/decode.png)

  Safe's API decoded the approve but not the call that moves your USDC (`"dataDecoded": null`), and even the part it decoded you must verify yourself. And verifying it yourself is hard: you must find which functions it really runs and the ABI of each, then ask: is `0x4A6c…0aE0` really Morpho's GeneralAdapter1, is `0x7777…7777` the vault you meant, is `1.054e15` a sane maximum share price? And again for the next transaction.

- **[Clear signing (ERC-7730)](https://eips.ethereum.org/EIPS/eip-7730) shows only what someone has described.** A descriptor is a JSON file in the [ERC-7730 registry](https://github.com/ethereum/clear-signing-erc7730-registry) that tells a wallet how to show one contract's calls. For the deposit above, the chain of descriptors breaks at the first link (registry commit [`3bebbd0`](https://github.com/ethereum/clear-signing-erc7730-registry/tree/3bebbd05cbc2d2d2bf9c41a8edbf5e5cc88e4eb4)):

  1. [Safe's descriptor](https://github.com/ethereum/clear-signing-erc7730-registry/blob/3bebbd05cbc2d2d2bf9c41a8edbf5e5cc88e4eb4/registry/safe/common-eip712-Safe.json) shows the SafeTx and hands its data to the descriptor of the contract it calls.
  2. That contract is MultiSend, which wraps the whole batch. MultiSend has no descriptor, so neither call inside is shown.
  3. Past MultiSend, [Bundler3's descriptor](https://github.com/ethereum/clear-signing-erc7730-registry/blob/3bebbd05cbc2d2d2bf9c41a8edbf5e5cc88e4eb4/registry/morpho/calldata-MorphoBundlerV3.json) names its call "Bundler3 Multicall" and hands each action to GeneralAdapter1, which has no descriptor either. The two steps that move your USDC into the vault have nothing to show them by.

  kiss-sign needs no descriptor. Your wallet only has to show the hashes.

## Install

> [!CAUTION]
> kiss-sign is provided as is, with no warranty. It can be wrong, and you alone are responsible for what you sign. See [Disclaimer](#disclaimer).

### Your computer: kiss-sign

Fork this repository and clone your fork. Your fork's `main` is the program `verify` trusts. You merge each template and registry pull request into it, and merging is your confirmation; program changes your AI merges itself, behind a gate (see [Your AI](#your-ai)).

```sh
git clone https://github.com/<you>/kiss-sign.git && cd kiss-sign
pnpm install
pnpm kiss-sign init --safe 0x… --language en   # or zh-TW for Traditional Chinese; see Language
pnpm kiss-sign key add alchemy
pnpm kiss-sign key add etherscan   # to build or review templates
pnpm kiss-sign key add github      # optional: raises GitHub's hourly limit to build or review templates
```

You need:

- Node 22.21 or later and pnpm.
- Free [Alchemy](https://dashboard.alchemy.com/) and [Etherscan](https://etherscan.io/myapikey) keys. A GitHub token is optional: a fine-grained, read-only one for public repositories raises GitHub's hourly limit when you build or review templates.
- A hardware wallet that shows a Safe transaction's domain hash and message hash, or its safeTxHash.

**Language.** English (`en`, the default) or Traditional Chinese (`zh-TW`). Change it later with `pnpm kiss-sign init --language zh-TW`. It sets which HTML report your AI gives you, the terminal text, `verify`'s page and `pnpm history`; addresses, hashes and verdict words stay the same, and so do verdicts. Give `./check.sh init` on the second computer the same language, or the comparison rows differ.

### A second, clean computer: kiss-sign-check (strongly recommended)

kiss-sign-check runs on a second computer that has no AI and no kiss-sign. Malware or an AI on your computer cannot change what that computer shows, so it catches a tampered computer or AI that kiss-sign alone would miss. kiss-sign works without it.

To install it, follow the [kiss-sign-check README](https://github.com/ipromise2324/kiss-sign-check#set-up) on the second computer.

## How it works

The pictures below come from one real run: another Safe's deposit of 1,000,611.448606 USDC into a Morpho vault, the Hyperithm USDC Apex vault.

### 1. Tell your AI what you want

In Claude Code, from the clone, say it in one sentence: "deposit 1,000,611.448606 USDC into Morpho's Hyperithm USDC Apex vault". If no template covers it yet, the AI builds one with the [kiss-sign skill](.claude/skills/kiss-sign/SKILL.md) and opens a pull request with a generated report.

![Claude Code opened in the kiss-sign clone, with the intent typed at its prompt: I want to deposit 1,000,611.448606 USDC into Morpho's Hyperithm USDC Apex vault](docs/readme/intent.png)

### 2. Review the report and merge

The report shows what the transaction will do and where every fact came from. Text the AI wrote is marked `AI`; everything else the program read or checked.

**The call flow.** Which contract the Safe calls, in which order, and what comes back. The Safe's own calls are the template's, which the program checks. The calls inside them are the AI's, from reading the source, and the program checks each against the call traces of other senders' past transactions: a line seen in every one is drawn solid, confirmed two ways.

![The call flow in the report: the Safe approves USDC to general-adapter-1, then calls bundler3.multicall, which pulls the USDC and deposits it, and the vault shares come back to the Safe](docs/readme/report-flow.png)

**Every field.** Each argument is fixed by the template, filled from your card, or, like a deadline or a route, left to the protocol's app within limits the template states.

![The fields of usdc.approve in the report: spender is fixed to general-adapter-1 with its full address, and value is the amount you fill in](docs/readme/report-fields.png)

**Every address.** Each place it was found, whether that site belongs to the protocol, and whether the newest version still lists it. This crop is from the CoW swap report. CoW's settlement contract is found in four sources, but places count by who owns them: two GitHub pages and the SDK all belong to CoW's GitHub organization, so with Immunefi it is confirmed in two places.

![An address the report confirmed in two places: two pages on CoW's GitHub and CoW's SDK on npm, which count as one place, CoW's GitHub organization, each still listing it at the newest version; and Immunefi's bug bounty scope. The deployer shares no other confirmed contract, so it counts for nothing](docs/readme/report-address.png)

Weak evidence is shown, not hidden. The Hyperithm vault was confirmed only by its factory, so the report flags it and lists it under To review, with the AI's suggestion: open the vault from the Morpho app's list, compare the address, and send a small amount first.

![An address confirmed in only one place, the factory, flagged with low confidence: the Morpho app page could not be read, CoinGecko had nothing to compare, Immunefi's scope does not list it, and no deployer was proven](docs/readme/report-address-flagged.png)

The report was made on the AI's computer. Before you merge, read its facts again with your own `main`'s code. `--compare` prints each fact that differs, except what changes between two honest reads: the date the listings were read, DefiLlama's TVL and most block numbers. It fetches and traces again the past transactions the report recorded, but it does not search anew, and it reuses the recorded API answer for each signed message, such as a CoW order. It also checks that each HTML report is exactly what your `main`'s code writes from the recordings and the AI's notes. Run it once more with `--instance-of` for each per-instance report the branch changes:

```sh
git fetch origin <branch>
pnpm report <protocol>/<operation> [--instance-of <instance>] --compare --data origin/<branch>
```

You review an operation once. After that you review only what changes: another vault's report, a registry pull request, or a changed template. Merging is your confirmation. Then approve the template on your own computer, which records its hash so `verify` refuses any other version:

```sh
git pull
pnpm kiss-sign template approve morpho/vault-deposit
```

A changed template has a new hash, so `verify` refuses it until you approve it again.

### 3. Fill a card

In your own terminal, pick the vault from a list with full addresses and type the amount. Values the protocol's app fills in by itself, such as the minimum shares, are computed from an on-chain read, the app's default slippage and a small margin the template states (0.10% in all for a Morpho deposit). The card is sealed under its hash before you see any transaction.

![pnpm kiss-sign card new morpho/vault-deposit: the vault is picked by number from a list with full addresses, the amount typed in whole tokens, the minimum shares computed from previewDeposit at a block where Alchemy and drpc agree, and the card sealed](docs/readme/card-new.png)

### 4. Verify on your computer, and check on a second one

Propose the transaction in the Safe web app as usual. Then, on your computer:

```sh
pnpm kiss-sign verify --card <card hash> --safe-tx-hash <safeTxHash>
```

On the second computer, run the command `verify` prints after `MATCH`:

```sh
./check.sh <nonce> --hints '…'   # --hints only when the template reads bytes no ABI describes
```

`check.sh` fetches the same transaction from Safe's API, recomputes its hashes, and decodes each call with Foundry's `cast`, using the ABI [Sourcify](https://sourcify.dev) has for the contract. It talks only to Safe's API and Sourcify, with no API key.

On `MATCH`, both pages show the same comparison list. Every row must be equal, except the last column, where kiss-sign writes its names and notes. If any other row differs, stop. `check.sh` does not judge the transaction: read its warnings, which say what it could not decode, and read its calls against what you meant to do.

First the hashes. They must be identical on both pages and on your hardware wallet's screen:

![The hash rows of both pages side by side: safeTxHash, domain hash and message hash, the same on kiss-sign verify and on check.sh](docs/readme/compare-hashes.png)

Then every call, row by row, down to the calls inside a batch: both sides split Bundler3's `multicall` into the token transfer and the vault deposit it runs. Every column must be identical except the names on the right, which only kiss-sign writes, from its registry:

![Some rows of call #3 on both pages side by side: the Bundler3 multicall, then its two inner calls, erc20TransferFrom of 1000611448606 and erc4626Deposit into the Hyperithm vault for the Safe, the same on both sides; only kiss-sign's side names the vault and the amounts in the last column](docs/readme/compare-multicall.png)

`--hints` tell `check.sh` how to read bytes that hold data rather than a call, such as a Vault V2 cap id. They carry positions and types only and never change a row, so a wrong hint cannot make the rows match. See [Hints from kiss-sign](https://github.com/ipromise2324/kiss-sign-check/blob/main/docs/hints.md).

### 5. Sign

Compare the hashes on `verify`'s page with your hardware wallet's screen, character by character: the domain hash and message hash, or the safeTxHash if that is what your wallet shows. Then sign. The first time you use a template or a new contract, send a small amount first.

## Threat model

`verify` is the check you run on your own computer before you sign ([step 4](#4-verify-on-your-computer-and-check-on-a-second-one)): it compares the transaction with your card, using the template you reviewed and checks that every template gets.

### The Safe web app or Transaction Service

`verify` checks the transaction you give it, from the Transaction Service by its safeTxHash or from a file, against your card, and comparing the hashes on your wallet checks that you sign that one.

| Attack | Stopped by |
|---|---|
| The Transaction Service gives `verify` the attacker's transaction, as at Bybit | `verify` checks it against your card: `MISMATCH` |
| The Transaction Service gives `verify` the transaction you meant, but your wallet is asked to sign another | You compare the hashes on your wallet with `verify`'s page: they differ. The attacker also needs the web app, which decides what your wallet is asked to sign |

### The RPC providers

`verify` reads the chain and simulates through two providers run by different companies, Alchemy and drpc, and uses an answer only when both give it.

| Attack | Stopped by |
|---|---|
| One provider gives a false answer, or none | `verify` compares the two answers: they differ, `UNVERIFIABLE` |
| Both give the same false answer, such as a simulation that hides your funds going elsewhere | The attacker needs both companies at once, and a bad transaction must still reach your Safe. The Safe web app's own simulation, run by Tenderly rather than these two providers, may still show your funds going elsewhere, if the web app itself is not compromised |

### Fake sources

Your AI finds each contract's address on the web, and a program fetches each contract's source code from Etherscan, so a fake page or fake source can mislead them. The report checks the site, the address and the source, and you review it before you merge.

| Attack | Stopped by |
|---|---|
| The AI uses a fake site | A program, not the AI, compares the site with those the protocol's listings name, on DefiLlama, CoinGecko, its bug bounty and GitHub: not among them, flagged for you. To pass, the fake site must be listed there too |
| The AI uses a wrong address | The address must be found in two places with different owners, such as the protocol's site, CoinGecko, the factory, the bug bounty or the SDK: fewer, flagged for you. To pass, the wrong address must be planted in two of them |
| Etherscan serves source code that is not the contract's, so a harmful call reads as a harmless one | A program compiles it with a pinned compiler and compares it byte for byte with the code on chain, except values set at deployment (immutables and linked libraries) and a metadata hash that differs, which the report flags as a finding: any other difference, refused |

With the second computer, `check.sh` takes its ABIs from Sourcify, not Etherscan. It does not judge addresses: whether one is the protocol's real contract stays on kiss-sign's source checks and your review of the report.

### Your AI

Models are trained to resist prompt injection, but a page your AI reads can still steer it, and it can simply be wrong. kiss-sign assumes both can happen.

| Attack | Stopped by |
|---|---|
| The AI gets something wrong, such as a template that allows too much | `verify` refuses a delegatecall other than to the official MultiSend, an unlimited approval other than a standing one the registry declares, such as to Permit2, a Safe setting change other than an owner or threshold change the card declares, and an unexplained balance change, whatever the template says; the rest shows in the report you review |
| A steered AI changes the report, `verify`'s code or its verdict | A bad transaction must still reach your Safe, through a compromised web app or protocol app; otherwise the attack fails. `--compare` reads the report's facts again with your `main`'s code, and a program change never shares a pull request with a template or the registry |

With the second computer, `check.sh` decodes the transaction without kiss-sign, so you see the real functions and arguments.

### The protocol you use

You choose the protocol; kiss-sign checks its state, its app's transactions and its code.

| Attack | Stopped by |
|---|---|
| The protocol or vault you pick is unsafe right now, such as one just hacked, or a vault made yesterday with no holders | The report shows the protocol's TVL and hacks from DefiLlama, and the vault's size over 12 months and its holders, found through Alchemy and their balances read through both providers, for you to judge before you merge |
| The protocol's app is compromised and sets a field you do not fill to a value no real user sends, such as a CoW order valid for a year | Of 136 CoW orders other Safes pre-signed, half expired within 30 minutes, nearly all within 3 hours, and the longest just under 7 days, so the template allows 7 days at most: later is `MISMATCH`. Drift was exploited in April 2026 through pre-signed transactions that durable nonces kept valid |
| A contract is upgraded or reconfigured to act maliciously | The simulation: a balance or allowance change the card does not explain, `MISMATCH`. The recorded code: a registry contract whose code changed since your review, `MISMATCH`. Settings an admin can change, such as a vault's curator, fees or caps, and contracts that are not registry entries, such as the markets and oracles behind a vault, are not checked |
| The protocol is hacked while your funds are in it | Nothing: kiss-sign checks only the transactions you sign |

### You

kiss-sign checks a transaction against the card you sealed and the reports you merged, so it cannot catch your own mistake in them. A card with the wrong vault or an extra zero in the amount gets `MATCH`. Nothing catches a signature you give without comparing the hashes on your wallet, or a flagged address you merge without reading the report.

## Scope

Safe multisig transactions on Ethereum mainnet. Not EOAs, Safe off-chain messages or other chains. It checks only what you sign: not what other owners sign without it, a module's transactions, or a hardware wallet that shows false hashes. A Vault V2 curator's cap change covers one cap id per transaction: one market, one collateral or one adapter.

## Contributing

Issues, security problems included, and pull requests are welcome. A change to the program starts with [docs/design.md](docs/design.md), the source of truth.

## Disclaimer

kiss-sign is provided as is, with no warranty, and can be wrong. `MATCH` means only that the transaction matches the template you approved and the card you sealed, not that it is safe. You alone are responsible for what you sign.

## Donate

If kiss-sign is useful to you, you can support it here.

**Ethereum mainnet only:**

```
0x085e5A79318931FA87050B8B677f2dc0Df303D67
```

Copy the address from this page on GitHub, and compare it in full before you send.

## License

[MIT](LICENSE), except the diagram font (Excalifont, SIL Open Font License) and other projects' logos in the diagrams, which belong to their owners.
