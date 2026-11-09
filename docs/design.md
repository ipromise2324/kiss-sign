# kiss-sign design

kiss-sign checks a Safe transaction against what the signer meant to do, before the signer signs it on a Ledger. The signer states an intent in plain words. An AI researches the operation and writes a reusable template for it. A fixed program runs that template against the proposed transaction and prints `MATCH`, `MISMATCH`, or `UNVERIFIABLE`. Ledger hashes print only on `MATCH`.

The rule the whole design keeps: **the AI writes templates, the program runs them.** The verdict is never the AI's judgment. If the AI is fooled, the worst outcome must be `UNVERIFIABLE` or `MISMATCH`, never a wrong `MATCH`.

## Who does what

| Actor | Does | Never does |
|---|---|---|
| Signer | States intents, reads reports, confirms templates, seals intent cards, proposes on Safe, compares hashes on the Ledger | Pastes keys into the chat |
| AI (Claude Code skill) | Researches addresses, ABIs and past transactions; writes the report; writes the template; drafts the intent card | Decides a verdict, edits kiss-sign during signing, handles API keys |
| Program (the engine) | Fetches and hashes the Safe transaction, decodes it, runs the template's checks, simulates, compares effects with the card | Reads web pages, follows instructions found in data |

## The flow

### First time an operation is done: build its template

1. **State the intent.** For example, "deposit USDC into the Morpho Apex vault." The AI turns it into a concrete operation.
2. **Research addresses.** The AI finds the protocol's contracts on its official site and GitHub and cross-checks them across sources. The program confirms on chain that each address has code, which implementation a proxy points to, and which factory created an instance.
3. **Establish the ABI.** A fixed method, not the AI: fetch the verified source from Sourcify, compile it locally with a pinned `solc`, and compare the result with the bytecode read from chain. For a proxy, compare the implementation. Matching bytecode proves the ABI belongs to the deployed contract.
4. **Study past transactions.** The AI looks at real transactions of the same operation to learn each field's role and the operation's normal shape. These teach the AI. They prove nothing about safety.
5. **Report.** Where each address was verified, where the ABI came from, which transactions were studied, what each field means, which contracts the operation touches, and what the template will check. For each field, the report counts how the studied transactions filled it, and from how many distinct senders. For example, "receiver equals the sender in 42 of 42 transactions, from 31 senders." The counts show the template matches normal use. They do not show it is safe, because fake transactions are cheap.
6. **Signer confirms.** The signer reads the report and asks for changes.
7. **Write the template.** The AI writes a declarative template (below) and saves it for reuse.

### Every signing

8. **Seal the intent card.** The AI drafts this time's values, such as the amount. The signer reads the card and seals it before seeing the Safe transaction. Every address on the card must pass the program's address checks.
9. **Propose on Safe.** kiss-sign reads the transaction from the Safe Transaction Service, or the signer pastes it. kiss-sign recomputes every hash itself.
10. **Verify.** The program decodes the transaction with the template, checks every field, mutates the transaction to confirm the template catches changes, simulates it, and compares the Safe's net effects with the card.
11. **Sign.** On `MATCH`, the signer compares the domain hash and message hash on the Ledger, then signs.

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

The operation id plus this signing's values: amounts, the vault, the chain, the Safe, and the nonce. Sealed means hashed and stored where the AI cannot write.

### Verdict file

Every input the verdict used, so `replay` can recompute it offline.

## Engine checks that every template gets

These are protocol-free and change rarely.

- The Safe transaction hashes, computed locally.
- Decode, then re-encode byte for byte, so nothing hides in the encoding.
- Floor rules: no unlimited approval, no `delegatecall` except to the official MultiSend, no owner, module, guard or threshold change.
- The mutation check: change each bound field and confirm the template gives `MISMATCH`.
- Simulation through the Safe's own `execTransaction`, judged by the Safe's balance and allowance changes, not by protocol events. A Safe that pays and gets nothing is `MISMATCH` whatever the template says.

## Chain access

Every on-chain read uses two providers from different companies. Both must agree, or the result is `UNVERIFIABLE`. This covers state reads, code, simulation, receipts, and the search for past transactions.

| Role | Providers |
|---|---|
| State, code, receipts | Alchemy (free key) and drpc |
| Simulation, latest and past blocks | Alchemy and drpc, `eth_simulateV1` |
| Finding past transactions | Alchemy Transfers API and a second source (Etherscan with a free key) |

When the system resolver fails, kiss-sign resolves provider hosts over DNS over HTTPS. TLS certificate checks stay on, so a wrong address can only fail the connection.

Keys enter through `kiss-sign key add <provider>` in a hidden prompt, never through the chat. They live in `$KISS_SIGN_HOME/.env` with mode 0600.

## Known limits

- drpc routes requests to third-party nodes, including public ones. Its independence from Alchemy is not proven.
- Two providers stop one lying provider, not two that collude or share a backend.
- Simulating an executed transaction on the parent block is not its exact pre-state, because earlier transactions in its block also changed state. For executed transactions, receipts read from two providers are the source of truth.
- A template is only as good as its review. The mutation check and the simulation are the backstops.

## Later security upgrades

Not built now. Listed so the path is clear.

- **Light client (Helios).** Verifies every read against the beacon chain, so one provider is enough. Needs `eth_getProof` (Alchemy has it) and a local EVM to simulate on proven state.
- **Local simulation (anvil).** Free and open source. Adds execution diversity. On its own it trusts the same RPC state.
- **A paid or third provider.** Removes rate and range limits and adds an independent source.

## Out of scope

EOA signing, off-chain EIP-712 signatures, and chains other than Ethereum mainnet.
