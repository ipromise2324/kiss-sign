# kiss-sign design

kiss-sign checks a Safe transaction against what the signer meant to do, before the signer signs it on a hardware wallet. The signer states an intent in plain words. An AI researches the operation and writes a reusable template for it. A fixed program runs that template against the proposed transaction and prints `MATCH`, `MISMATCH`, or `UNVERIFIABLE`. The hashes to compare on the hardware wallet print only on `MATCH`.

The rule the whole design keeps: **the AI writes templates, the program runs them.** The verdict is never the AI's judgment. `MATCH` means the transaction matches the template and the card the signer approved. If the AI is fooled during signing, the worst outcome must be `UNVERIFIABLE` or `MISMATCH`, never a wrong `MATCH`. A template that was wrong when the signer approved it is not caught by any check; that risk is carried by the review and its evidence.

## Who does what

| Actor | Does | Never does |
|---|---|---|
| Signer | States intents, reads reports, confirms templates, confirms intent cards and address-book entries, proposes on Safe, compares hashes on the hardware wallet | Pastes keys into the chat |
| AI (any coding agent) | Researches addresses, ABIs and past transactions; writes the report; writes the template; drafts the intent card | Decides a verdict, edits kiss-sign during signing, handles API keys |
| Program (the engine) | Fetches and hashes the Safe transaction, decodes it, runs the template's checks, simulates, compares effects with the card | Reads web pages, follows instructions found in data |

## The flow

![Detailed flow: who acts at each step, what it does, which services it uses, and what it trusts](architecture-detail.png)

### First time an operation is done: build its template

1. **State the intent.** For example, "deposit USDC into the Morpho Apex vault." The AI turns it into a concrete operation.
2. **Research addresses.**
   - **Find:** the AI finds the protocol's contracts on its official site and GitHub and cross-checks them across sources.
   - **Prove on chain:** the program confirms that each address has code, which implementation a proxy points to, and which factory created an instance.
   - **Third source:** Etherscan's address labels and contract-creation records check both the address and its creator.
   - **Register:** each verified contract goes into the contract registry under a name.
   - **ERC-7730:** the AI looks up each contract in the ERC-7730 clear-signing registry. Where a descriptor exists, the program checks who reviewed it: each auditor signs an ERC-8176 attestation for that exact descriptor, and the program verifies the signature offline and reads on chain whether it was revoked (for example with Sourcify's `@ethereum-sourcify/clear-signing` library). The AI renders the studied past transactions with the descriptor and compares its field meanings with its own.

   The descriptor is a second opinion on what each field means. It never becomes a rule by itself, and a field the descriptor hides does not become a free field.
3. **Establish the ABI.** A fixed method, not the AI: fetch the verified source from Sourcify, compile it locally with a pinned `solc`, and compare the result with the bytecode read from chain. For a proxy, compare the implementation. Matching bytecode proves the ABI belongs to the deployed contract.
4. **Study past transactions.** The AI looks at real transactions of the same operation to learn each field's role and the operation's normal shape. These teach the AI. They prove nothing about safety.
5. **Check the protocol's health.** The AI looks for anything that makes the protocol unsafe to use right now: past hacks and incidents (for example DefiLlama's hack list and the protocol's own post-mortems), audits, recent upgrades, admin or timelock changes, paused or deprecated contracts. Every claim cites its source.

   This informs the signer's decision; it does not change what the program checks. What the program can read on chain, such as an upgraded implementation or a paused contract, it checks again at every signing.
6. **Report.** It covers:
   - **Addresses and ABI:** where each address was verified, and where each ABI came from.
   - **Fields:** what each field means, which contracts the operation touches, and what the template will check.
   - **Past transactions:** how many were studied and from how many senders, for example "42 past deposits from 31 different Safes", and for each field what they held: "`receiver` (who gets the vault shares) was the depositing Safe in all 42". That is the evidence behind the rule "`receiver` equals the Safe".
   - **ERC-7730:** whether each contract has a descriptor, its hash, which auditors attested it, whether any attestation is revoked, and where its field meanings differ from the AI's.
   - **Protocol health:** the check from step 5.

   The counts show the template matches normal use. They do not show it is safe, because fake transactions are cheap.
7. **Write the template.** The AI writes a declarative template (below) and its test transactions, and opens a pull request with the template, the report, and the tests.
8. **Signer reviews the pull request.** The signer reads the report and the template's rules and asks for changes. Merging the pull request is the confirmation. kiss-sign records the hash of the merged template locally.

### Every signing

9. **State this signing's intent.** The signer says what to do this time, for example "deposit 65,266 USDT into Steakhouse USDT". The AI picks the template and fills in the card values. The signer reads the card and confirms it before seeing the Safe transaction.

   kiss-sign then seals the card on its own: it hashes the card and stores it where the AI cannot write. The template is not reviewed again; only the card's values are.
10. **Propose on Safe.** kiss-sign reads the transaction from the Safe Transaction Service, or the signer pastes it. kiss-sign recomputes every hash itself.
11. **Verify.** The program decodes the transaction with the template, checks every field, mutates the transaction to confirm the template catches changes, simulates it, and compares the Safe's net effects with the card.
12. **Sign.** On `MATCH`, the signer compares the domain hash and message hash on the hardware wallet's screen, then signs. Any hardware wallet that shows both hashes for a Safe transaction works.

## Data shapes

### Template

A template describes one operation for one protocol, for example `morpho/vault-deposit`. It is data, not code.

- `contracts`. Each named contract with its address, the source that names it, and its code hash.
- `calls`. The call tree the Safe makes, with MultiSend unwrapped. Each call names its target contract and its function signature.
- `fields`. A rule for every argument. One of:
  - equals a card value (`amount`, `vault`);
  - equals the Safe;
  - equals a named contract;
  - equals a constant;
  - free, with a written reason (for example a Merkle proof). The mutation check treats free fields as free.
- `effects`. What the Safe gives and gets, in tokens and amounts written as card values. Approvals must be exact and spent in the same transaction.

### Intent card

The operation id plus this signing's values. The template is reviewed once; the card is the only thing the signer confirms at every signing. So the card holds only what changes between signings, and every other value is bound once, somewhere the signer already reviewed.

Where each value comes from:

| Source | Confirmed | Examples |
|---|---|---|
| Template | Once, when the signer reviews the template | Target contracts, `receiver` and `owner` equal the Safe, the spender of an approval equals a named contract |
| Contract registry | Once per contract, during research (step 2) | Each Morpho vault, each Fluid fToken, routers |
| Address book | Once per address, by the signer | An external recipient of a transfer |
| Config | Once, at `init` | The Safe, the chain |
| The Safe, read on chain | By the program, every signing | The nonce |
| Card | By the signer, every signing | Amounts, which vault, swap limits, which address-book entry receives a transfer |

An address on the card is never typed by the AI. It is a name from the contract registry or the address book, or the Safe itself. The card shows the name and the full address, and the program resolves the name.

Card values per operation, covering the operations in the Safe's history:

| Operation | Card values | Bound by the template |
|---|---|---|
| Transfer ETH or a token | token, amount, recipient | none |
| Deposit into a vault (Morpho, Fluid) | vault, amount | the asset is the vault's asset; receiver is the Safe; the approval is exact and goes to the vault |
| Withdraw or redeem from a vault | vault, amount or `all` | receiver and owner are the Safe |
| Claim rewards (Fluid, Merkl) | reward token | recipient is the Safe; amount and proof are free; the Safe gives nothing and receives only the reward token |
| Swap through a router (Uniswap, Odos) | sell token, sell amount, buy token, minimum buy amount | recipient is the Safe; the router is a named contract |
| Cancel a queued transaction | the nonce to replace | 0 ETH to the Safe itself, no data |

- One Safe transaction can batch several operations, for example withdrawing from two vaults. The card then lists each operation with its values, and the MultiSend must contain exactly those calls. An approval belongs to the operation that spends it, not to its own line.
- Swap limits are stated as a minimum amount, not a slippage percentage, so the program never needs a price. The AI may suggest the number from a quote; the signer confirms the number.
- A recipient that is not the Safe must already be in the address book. Adding an entry is a separate step, done before signing, where the signer checks the full address against a source outside the chat.

Sealed means hashed and stored where the AI cannot write.

### Verdict file

Every input the verdict used, so `replay` can recompute it offline.

## What goes on GitHub

Templates are reviewed once and reused, so they live in git, where every change is a diff someone reviewed. The evidence behind each template goes with it.

| Published in the repository | Kept local, in `$KISS_SIGN_HOME` |
|---|---|
| Templates: what each operation checks | Config: the Safe address, providers, API keys |
| Reports: where every address and rule came from | Address book |
| Test transactions | Intent cards and verdict files |
| Contract registry | Approved template hashes |

- Each operation has a folder, for example `templates/morpho/vault-deposit/`, holding `template.json`, `report.md`, and `tests/`.
- The tests are real past transactions of the operation, each with the card values it implies. Every one must give `MATCH`, and every mutated copy must give `MISMATCH`. CI reruns the decoding, field checks, and mutation checks on every change. Simulation needs live providers, so it runs locally.
- Git stores and records; it is not trusted. At signing, the program checks that the template's hash equals the hash recorded when the signer merged it. A template from someone else's repository is only a starting point: its report still has to be reviewed.

### The Safe's address is never published

Published files would otherwise tie the Safe, its balances, and its history to whoever owns the repository.

- Templates refer to "the Safe", never to an address.
- Test transactions come from other senders. The signer's own Safe is excluded when searching for past transactions.
- Reports count senders but list no Safe of the signer's.
- Before every push, a check greps the outgoing commits for the configured Safe address and for API keys, and must find nothing.

## Engine checks that every template gets

These are protocol-free and change rarely.

- The Safe transaction hashes, computed locally.
- Decode, then re-encode byte for byte, so nothing hides in the encoding.
- Floor rules:
  - no unlimited approval;
  - no `delegatecall` except to the official MultiSend, and the rules apply again to every call inside it, at every level;
  - no owner, module, guard, threshold, fallback handler or implementation change;
  - the Safe's own fee fields are all zero: `safeTxGas`, `baseGas`, `gasPrice`, `gasToken`, `refundReceiver`. Otherwise a correctly hashed transaction can pay a refund to someone else.
- The mutation check: change each bound field and confirm the template gives `MISMATCH`.
- Simulation through the Safe's own `execTransaction`, judged by the Safe's balance and allowance changes, not by protocol events. Every change to the Safe's balances and allowances must be one the template's effects explain; any other change is `MISMATCH`, whatever else the template says. A transfer explains its payment by its card's recipient and amount; a deposit or a swap must also receive what its effects promise.

## Chain access

Every on-chain read uses two providers from different companies. Both must agree, or the result is `UNVERIFIABLE`. This covers state reads, code, simulation, receipts, and the search for past transactions.

| Role | Providers |
|---|---|
| State, code, receipts | Alchemy (free key) and drpc |
| Contract code and creator, during research | Alchemy and drpc, with Etherscan as a third source |
| Simulation, latest and past blocks | Alchemy and drpc, `eth_simulateV1` |
| Finding past transactions | Alchemy Transfers API and a second source (Etherscan with a free key) |

When the system resolver fails, kiss-sign resolves provider hosts over DNS over HTTPS. TLS certificate checks stay on, so a wrong address can only fail the connection.

Keys enter through `kiss-sign key add <provider>` in a hidden prompt, never through the chat. They live in `$KISS_SIGN_HOME/.env` with mode 0600.

## The program checks itself first

kiss-sign runs from one clone of this repository. `kiss-sign verify` starts with a self-check before anything else:

1. Fetch `origin`.
2. The local checkout must be exactly `origin/main`: the same commit, with no local changes and no extra files in the program, the templates, or the settings.
3. If anything differs, stop and name the files. Nothing is verified.

Templates are read from that commit, so a template counts only after its pull request is merged. `main` changes only through pull requests.

This catches accidental edits and an AI that was tricked into changing a check or a template. It cannot catch an AI that deliberately rewrites both a check and the self-check itself, because the self-check is part of the same program. See Known limits and Later security upgrades.

## Known limits

- drpc routes requests to third-party nodes, including public ones. Its independence from Alchemy is not proven.
- Two providers stop one lying provider, not two that collude or share a backend.
- Simulating an executed transaction on the parent block is not its exact pre-state, because earlier transactions in its block also changed state. For executed transactions, receipts read from two providers are the source of truth.
- The self-check runs inside the program it checks. An AI with shell access that deliberately rewrites both the program and its self-check is not stopped this round.
- The hardware wallet shows only the two hashes, not the decoded transaction. ERC-7730 clear signing does not yet cover Safe MultiSend batches.
- A template is only as good as its review. The mutation check and the simulation are the backstops.

## Later security upgrades

Not built now. Listed so the path is clear.

- **Light client (Helios).** Verifies every read against the beacon chain, so one provider is enough. Needs `eth_getProof` (Alchemy has it) and a local EVM to simulate on proven state.
- **Local simulation (anvil).** Free and open source. Adds execution diversity. On its own it trusts the same RPC state.
- **A paid or third provider.** Removes rate and range limits and adds an independent source.
- **Lock the AI out of the program.** Ship `.claude/settings.json` with deny rules for program code, settings, `gh pr merge`, and pushes to `main`; these hold even in bypass-permissions mode. Add the agent's sandbox, so a script cannot write the program either. Other agents need their own equivalent.
- **Clear signing on the wallet (ERC-7730).** Export templates as display descriptors so the device shows the decoded call. Wait until wallets decode Safe MultiSend batches; until then, hash comparison stays.

## Next phase: CoW orders

A CoW order is not a swap inside the Safe transaction. The transaction only pre-signs an order (`setPreSignature`) and sets an approval; a solver settles the order later. So the order's sell and buy limits, receiver, and expiry live in the order, not in the transaction's effects, and the approval is not spent in the same transaction. Supporting it needs its own rules: rebuild the order from its uid, check every order field against the card, and allow the approval to stay open until the order settles or expires.

## Out of scope

EOA signing, off-chain EIP-712 signatures, and chains other than Ethereum mainnet.
