<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.svg">
    <img src="docs/logo.svg" alt="kiss-sign logo: an x on a signature line" width="120">
  </picture>
</p>

<h1 align="center">kiss-sign</h1>

<p align="center"><b><i>Keep it simple, stupid, and sign.</i></b></p>

kiss-sign checks a Safe transaction against what you meant to do, before you sign it on a hardware wallet.

> Status: early development. Nothing here is ready to use yet.

## Why kiss-sign

I sign Safe multisig transactions often, and every signature makes me responsible for the exact data I approve. Today the order is always the same: the transaction is built first, and the signer checks it last. That last check is like the terms on an insurance form. Everyone means to read it, and most people just click sign. Checking the data properly is also slow: today's tools work only if you rebuild the transaction yourself and know how it is encoded. Clear signing (ERC-7730) makes the final screen readable, but you still have to read it at the end and notice what's wrong. It also doesn't handle batched calls well yet and doesn't work for Safe transactions.

## How it works

kiss-sign turns the order around: you say what you want first, and the transaction is checked against it.

1. **Say the intent** in one sentence, and confirm a short card before you see any transaction.
2. **An AI writes a template** the first time you do an operation, and you review it as a pull request with its evidence.
3. **A fixed program checks** the transaction against the template and your card, then prints a verdict:
   - `MATCH`: it does exactly what the card says. Compare the two hashes on your hardware wallet and sign.
   - `MISMATCH`: something differs. Do not sign.
   - `UNVERIFIABLE`: it could not be proven either way. Do not sign.

The AI never decides the verdict. If it is fooled while you sign, the worst outcome is `MISMATCH` or `UNVERIFIABLE`. The one thing no check can catch is a template that was wrong when you approved it, which is why templates are reviewed on GitHub.

![kiss-sign flow: build a template once per operation, then check every signing](docs/architecture.png)

## Keep it simple, stupid, and sign

Every part is small enough to check by hand.

- **Your job is small.** One sentence, one card, two hashes. The long review happens once per operation.
- **The judge is simple.** A fixed program decides. Templates are data, not code.
- **Trust is written down.** kiss-sign recomputes every hash, compiles every ABI, and asks two providers.
- **Doubt fails closed.** If it cannot prove a transaction, the answer is `UNVERIFIABLE`.
- **No more than needed.** Free services, Ethereum mainnet, Safe, and a hardware wallet.

## Build a template (once per operation)

An operation is something like "deposit USDT into a Morpho vault" or "withdraw from a Fluid vault". You build its template the first time you do it, and reuse it afterwards.

| Step | Who | What happens | Services | What it trusts |
|---|---|---|---|---|
| 1. Name the operation | Signer | You say in plain words what you want to do. | An AI agent | You agree the AI's restatement is what you meant. |
| 2. Research | AI | Find the protocol's official contract addresses on its site and GitHub, and cross-check them. Study past transactions of the same operation to learn what a normal one looks like. Check the protocol's health: past hacks and incidents, audits, recent upgrades or admin changes, paused contracts. Look up each contract's ERC-7730 clear-signing descriptor and which auditors attested it. | An AI agent, GitHub, DefiLlama, CoinGecko, Etherscan, Alchemy, ERC-7730 registry | Official sources. Past transactions only show what normal looks like; they prove nothing about safety, because fakes are cheap. |
| 3. Prove on chain | Program | Confirm each address has code, which implementation a proxy points to, and which factory created it. Prove the ABI: fetch the verified source from Sourcify, compile it locally with a pinned `solc`, and match the bytecode on chain. | Sourcify, `solc`, Alchemy + drpc | A local compile that matches the chain. Two providers from different companies do not lie together. |
| 4. Open a pull request | AI | The pull request holds three things. The report: where every address came from; the protocol's health; whether an audited ERC-7730 descriptor exists and agrees with the AI's reading; and how many past transactions show what normal looks like, for example "42 past deposits from 31 different Safes", with what each field held in them. The template: what the program will check, and what the Safe should give and get. The tests: past transactions that must give `MATCH`, and mutated copies that must give `MISMATCH`. | GitHub | Counts show normal use, not safety. |
| 5. Review the pull request | Signer | Read the report and every rule, and ask for changes. Merging is the confirmation. CI reruns the tests on every change. | GitHub | Your judgment. |

## Every signing

| Step | Who | What happens | Services | What it trusts |
|---|---|---|---|---|
| 6. Say this signing's intent | Signer | For example "deposit 65,266 USDT into Steakhouse USDT". | An AI agent | |
| 7. Fill the card | AI | Pick the template and fill in only the values that change: amounts, vault, limits. | An AI agent | Nothing yet: you confirm the card next. |
| 8. Confirm the card | Signer | Read the card before seeing the transaction. kiss-sign then seals it on its own. | Local | You read the card. Every address on it comes from the contract registry or your address book. |
| 9. Propose on Safe | Signer | Create the transaction in the Safe web app. kiss-sign reads it from the Safe Transaction Service, or you paste it. | Safe | Nothing from the API. kiss-sign recomputes every hash itself. |
| 10. Check | Program | Decode and re-encode byte for byte. Check every field against the template and the card. Change each bound field: every change must give `MISMATCH`. | Local | The fixed program and the template you reviewed. |
| 11. Simulate | Program | Run the transaction through the Safe's `execTransaction` with `eth_simulateV1`. What the Safe gives and gets must equal the card. | Alchemy + drpc | Both providers must agree, or the verdict is `UNVERIFIABLE`. |
| 12. Sign on the hardware wallet | Signer | Only on `MATCH`: compare the domain hash and message hash on the wallet's screen, then sign. | A hardware wallet that shows both hashes | The wallet's screen. |

### What you confirm each time

The template is reviewed once. At each signing you confirm only the values that change, for example:

- a vault deposit: which vault and how much;
- a swap: what you sell and how much, what you buy, and the minimum you accept;
- a transfer: the token, the amount, and the recipient, which must already be in your address book.

Everything else is bound once: the receiver is the Safe, contracts come from the reviewed registry, the Safe and chain come from your config, and the program reads the nonce from the Safe. See [Intent card](docs/design.md#intent-card) for every operation.

## What goes on GitHub

Each operation's template, report, and tests live in this repository, so every rule has a reviewed pull request and evidence behind it. The contract registry lives here too.

Your Safe's address never does. Templates say "the Safe", not an address. Test transactions come from other senders, and your own Safe is left out of the search. Your Safe address, API keys, address book, intent cards, and verdicts stay local, in `$KISS_SIGN_HOME`. Before every push, a check greps the outgoing commits for your Safe address and for API keys.

GitHub stores and records; it is not trusted. At signing, the program checks that the template is the exact version you merged.

## Chain access

Every on-chain read goes to two providers run by different companies, Alchemy and drpc, and both must agree. Otherwise the verdict is `UNVERIFIABLE`. API keys go in through `kiss-sign key add <provider>` in a hidden prompt, never through the chat.

## More

[docs/design.md](docs/design.md) has the full design: data shapes, engine checks, chain access, known limits, and later security upgrades.

## Scope

Safe multisig transactions on Ethereum mainnet, signed with a hardware wallet that shows the Safe transaction's domain hash and message hash. EOA signing, off-chain EIP-712 signatures, and other chains are out of scope.
