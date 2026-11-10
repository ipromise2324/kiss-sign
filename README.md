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

I sign Safe multisig transactions often, and every signature makes me responsible for the exact data I approve. Today the order is always the same: the transaction is built first, and the signer checks it last. That last check is like the terms on an insurance form. Everyone means to read it, and most people just click sign.

Checking the data properly is also slow: today's tools work only if you rebuild the transaction yourself and know how it is encoded.

Clear signing (ERC-7730) makes the final screen readable, but you still have to read it at the end and notice what's wrong. It also doesn't handle batched calls well yet and doesn't work for Safe transactions.

## How it works

kiss-sign turns the order around: you say what you want first, and the transaction is checked against it.

1. **Say the intent** in one sentence, and confirm a short card before you see any transaction.
2. **An AI writes a template** the first time you do an operation, and you review it as a pull request with its evidence.
3. **A fixed program checks** the transaction against the template and your card, then prints a verdict:
   - `MATCH`: it does exactly what the card says. Compare the two hashes on your hardware wallet and sign.
   - `MISMATCH`: something differs. Do not sign.
   - `UNVERIFIABLE`: it could not be proven either way. Do not sign.

![kiss-sign flow: build a template once per operation, then check every signing](docs/architecture.png)

## Keep it simple, stupid, and sign

Every part is small enough to check by hand.

- **Your job is small.** One sentence, one card, two hashes. The long review happens once per operation.
- **The judge is simple.** A fixed program decides. Templates are data, not code.
- **Trust is written down.** kiss-sign recomputes every hash, compiles every ABI, and asks two providers.
- **Doubt fails closed.** If it cannot prove a transaction, the answer is `UNVERIFIABLE`.
- **No more than needed.** Free services, Ethereum mainnet, Safe, and a hardware wallet.

## What each check stops

The diagram shows the flow. This is what each step actually does, and what it is there to stop.

**When a template is built** (once per operation, such as "deposit into a Morpho vault"):

- **Addresses are checked against more than one source.** The AI finds each address on the protocol's own site or GitHub and reads its Etherscan contract name and creator; the program proves on chain that the address has code, which implementation a proxy points to, and which factory created a vault. `pnpm check-sources` compares each source page's domain or GitHub org with DefiLlama's listing of the protocol, and checks that CoinGecko lists the named coin at each token's and vault share's address. It prints every disagreement as a finding for the signer to judge; it decides nothing, and agreeing listings are supporting evidence, not proof. *Stops:* an address copied from a look-alike site or a wrong coin's address, when a listing disagrees or the signer catches it in the report.
- **The ABI is proven by compiling it.** kiss-sign fetches the verified source from Sourcify, compiles it locally with a pinned `solc`, and matches the bytecode on chain, following proxies to their implementation. *Stops:* an ABI that labels a field as something it is not.
- **Rules come from evidence.** Past transactions show what each field normally holds, for example "`receiver` was the depositing Safe in all 42 past deposits". That count is the evidence behind the rule "`receiver` equals the Safe". *Stops:* a field the template forgot to bind.
- **The protocol's health is checked.** Past hacks, audits, recent upgrades, admin changes, and paused contracts go in the report. *Stops:* using a protocol that is unsafe right now.

**At every signing:**

- **The program checks itself first.** Before anything else, `verify` requires the local checkout to equal the merged `main` exactly. *Stops:* a template or the program being changed after you approved it.
- **The card is sealed before you see the transaction.** You confirm what you want first, and kiss-sign stores the card's hash where the AI cannot write. *Stops:* the transaction shaping what you think you asked for.
- **Every hash is recomputed.** kiss-sign trusts no hash from the Safe web app or its API. *Stops:* a tampered interface showing one transaction while you sign another, as in the Bybit hack.
- **Decode, then re-encode byte for byte.** The re-encoded transaction must equal the original exactly. *Stops:* extra bytes hidden in the calldata.
- **Mutation check.** kiss-sign changes each bound field, and every changed copy must give `MISMATCH`. *Stops:* a template that looks strict but binds nothing.
- **Floor rules apply to every template:**
  - no unlimited approval;
  - no `delegatecall` except to the official MultiSend, and the rules apply again to every call inside it, at every level;
  - no owner, module, guard, threshold, fallback handler or implementation change;
  - the Safe's own fee fields are all zero, so a correctly hashed transaction cannot pay a refund to someone else.

  *Stops:* the attacks that take over the Safe itself, such as the upgrades behind the Bybit and WazirX hacks.
- **Simulation on two providers.** The transaction runs through the Safe's `execTransaction` with `eth_simulateV1` on Alchemy and drpc. Every change to the Safe's balances and allowances must be one the card explains, and both providers must agree. *Stops:* hidden side effects and a lying provider.
- **Hashes on the hardware wallet.** On `MATCH`, kiss-sign prints the domain hash and message hash, and you compare them on the wallet's screen. *Stops:* a compromised computer swapping the transaction at the last step.

## What you confirm each time

The template is reviewed once. At each signing you confirm only the values that change, for example:

- a vault deposit: which vault and how much;
- a swap: what you sell and how much, what you buy, and the minimum you accept;
- a transfer: the token, the amount, and the recipient, which must already be in your address book.

Everything else is bound once: the receiver is the Safe, contracts come from the reviewed registry, the Safe and chain come from your config, and the program reads the nonce from the Safe. See [Intent card](docs/design.md#intent-card) for every operation.

## Threat model

TODO: the attacks kiss-sign is meant to stop, and the ones it cannot.

## More

[docs/design.md](docs/design.md) has the full design: data shapes, engine checks, chain access, known limits, and later security upgrades.

## Scope

Safe multisig transactions on Ethereum mainnet, signed with a hardware wallet that shows the Safe transaction's domain hash and message hash. EOA signing, off-chain EIP-712 signatures, and other chains are out of scope.
