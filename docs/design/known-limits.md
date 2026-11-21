Part of [the kiss-sign design](../design.md).

## Known limits

- A past transaction's call trace comes from drpc alone, since Alchemy's free plan does not serve one.
  Its token transfers and approvals are checked against the receipt both providers agree on, but a call that moves no token, and ETH sent inside a call, which logs nothing, rest on drpc's answer.
  The receipt check counts movements, not where they sit: a `Transfer` of a token outside the registry, a registry token's mint or burn, from or to the zero address, and an `Approval` of a token outside the registry need no matching call, and a registry token's call that a hand-edited trace moves under another call, one already covered, still matches its log, and no program traces a recorded transaction again, so such an edit is not caught.
  A trace only confirms a `flow` line in the report or asks the AI for a review; it never changes a verdict.
  A trace also shows one path: a contract may branch on state, so a line seen in every past transaction may not hold for the transaction to sign, and the effects check at signing is what protects the signer.
- Etherscan name tags (labels such as "Morpho: Bundler3") are not used.
  Etherscan offers no free API for them.
  The verified contract name and the creator, read from the contract's Etherscan page, are used instead.
- The registry's addresses come from the AI's research, and no program reads a recorded answer, call trace or code span again before the signer merges.
  A re-check with main's code, `pnpm report --compare`, was removed on 2026-11-20: a steered AI may change and merge the research code such a check runs, since only the verdict core and the program gate are kept from it, so the check did not stop it.
  A steered AI that also changes that code could add an attacker's contract to the registry, record answers that agree with it, and make the report look like any other.
  `verify` and the independent computer then pass, since the transaction matches the card the signer built from that registry; both check the transaction against the card, not the registry against the protocol.
  The signer's defense is the report's sources: open each page the report lists for the entry, check that its domain is the protocol's own, and that the page lists this address.
- DefiLlama and CoinGecko are aggregators that take listing requests, so `pnpm check-sources` agreeing is supporting evidence, not proof.
  It finds the registrable domain with the Public Suffix List plus the shared hosts it leaves out (step 2); a shared host on neither still looks like one site, such as `dexscreener.com/<pair>` or `pump.fun/<coin>`.
  Every report line prints what it compared, or says that nothing was compared and why.
- The protocol facts are what DefiLlama and the chain say at the block read.
  TVL is DefiLlama's estimate, and its hacks list holds only what someone reported; the program counts a hack only when DefiLlama files it under the protocol's id or its parent's, and DefiLlama files many hacks under none, such as the 2024 oracle incident in one Morpho Blue market, so the AI looks for the rest in step 5.
  A `facts` reading is a size, not a check, and is not read again at signing.
- `pnpm check-sources` reads a page the way a browser shows it with scripts off.
  A page that renders its addresses with JavaScript shows none of them, and its entries stay findings until a source that serves the text is found; an entry's `apiSource` adds the protocol API's answer beside it without changing it.
  An API's answer is what its server says now: it shows the protocol's own service names the address, not that the service is correct, and no program checks again an answer recorded on the AI's computer.
  It reads no stylesheet, so an address a stylesheet hides, such as with a class whose rule is `display:none`, still counts as shown.
  An element hidden by its own attributes whose end tag the page leaves out hides the rest of the page, which can only turn an agreement into a finding.
  Within a block, the label and the address only need to be close: a page that writes another contract's name next to the address, or an AI that picks a label from the wrong row of a block holding no other address, still agrees.
  The `sourceLabel` and `sourceHeading` are chosen by the AI and reviewed by the signer with the registry entry.
- The places that list a protocol's sites are themselves listings: CoinGecko and Immunefi take a protocol's word for its homepage and GitHub organization, and GitHub verifies only that an organization controls a domain, not that the domain is the protocol's.
  A site passes when any one of them names it, so one wrong listing can make a lookalike site pass; the address still needs two places.
  A bounty program's scope is also its own word: a program that lists another protocol's website in scope is tied to that protocol, and its scope then counts as one place for an address it holds; the address still needs a second.
- Counting places by owner sees only registrable domains and GitHub organizations.
  Two domains of one owner count as two places, as do a domain and the GitHub organization of the same team, and pages on two domains served by one CDN or host.
- The deployer proof cannot tell apart two transactions in one block that both call the factory that created the address; it takes the one Etherscan names.
  A transaction relayed for its signer, such as by a relayer service, has the relayer as its sender, so two contracts relayed by one service share a deployer they do not share in fact.
- The bounty scope is read from every `etherscan.io/address/` link in the program's assets and its text on them, so an address the program names only to say it is out of scope, or a third party's contract it mentions, counts as in scope.
- An SDK's provenance is npm's attestation, which npm checks at publishing; the program reads it from npm and does not verify its Sigstore signature itself.
- A vault's `adapter` attribute, the Morpho Market V1 adapter a Vault V2's adapter and market caps are keyed by, is written during research and checked by the report through the adapter factory's `instanceCheck`: the factory answers that it created the adapter, the vault answers `isAdapter` true for it, the adapter answers `parentVault()` with the vault, and the curator's page or the Morpho API lists it among the vault's adapters.
  Those answers hold at the report's block; `verify` reads none of them at signing, and a curator can remove an adapter later; a wrong adapter in the registry would make a cap submission set a cap under an id no allocation uses, which the vault's `executableAt` view still shows as pending, so the report's answers are what stand behind it.
- The Vault V2 templates take one cap id per transaction: one adapter, one collateral or one market.
  A Vault V2 keys its caps by three kinds of id, the adapter, each collateral token and each market, and the curator app lists them as rows.
  The kinds and operations without a template are those no established curator's two-item `multicall` shows: of the last ~300 transactions of each of the 265 curator, allocator and sentinel Safes of the first 200 Vault V2s on Ethereum, a two-item `multicall` of one id was a submission 24 times for a market, 21 for a collateral and 7 for an adapter, an acceptance 7 times for an adapter, a decrease 2 times for an adapter and 2 for a market, and a revocation once for an adapter, with no acceptance, decrease or revocation of a collateral's caps alone.
  The adapter decreases lowered a retired adapter to 0, not the vault's current `adapter`, which a template binding that attribute refuses.
  The market templates other than a submission keep the fixtures of one smaller vault.
  Such a transaction is not signed with kiss-sign until a template covers it.
- A curator who batches several ids' caps into one `multicall`, as 14 Safes did in 39 transactions of the last year that accepted two cap ids at once, or submits and accepts in the same transaction on a vault whose timelock is zero, gets `MISMATCH`, since a merged call needs a target the template names, and the vault is a card field.
  Such a batch is signed only after splitting it into one transaction per id.
  Several Safe transactions executed in one Ethereum transaction, as Gauntlet's curator ran seven cap submissions at once, are `UNVERIFIABLE` from their receipt.
- The GitHub API allows 60 requests an hour without a token, and 5,000 with `GITHUB_TOKEN`; each pinned repository and commit costs two.
  Past that, every GitHub line is `UNVERIFIABLE` until the hour passes.
- No free API lists a token's holders: Etherscan's `tokenholderlist`, `tokenholdercount` and `topholders` are API Pro endpoints, and Alchemy has no holder list for ERC-20 tokens.
  `pnpm instance-evidence` takes its candidates from the Alchemy Transfers API alone; the sum against `totalSupply()` catches a missing holder but not a source that invents none.
  It counts addresses, not owners, so one owner's many wallets count as many, and a vault with more than 300,000 share transfers gets no holder count.
  `totalAssets()` is sampled once a month, so a deposit and withdrawal between two samples does not show.
  Linking holder wallets, such as by a common gas funder, is not built.
- drpc routes requests to third-party nodes, including public ones.
  Its independence from Alchemy is not proven.
- Two providers stop one lying provider, not two that collude or share a backend.
- Simulating an executed transaction on the parent block is not its exact pre-state, because earlier transactions in its block also changed state.
  For executed transactions, receipts read from two providers are the source of truth.
- The AI that writes templates reads web pages, chain data and API answers, and any of them can carry a prompt injection. kiss-sign does not try to prevent it.
  The defenses are the program's checks, the signer's review of every template and registry pull request, the program gate for every program pull request, and in the hardened tier the independent computer.
- Program pull requests are merged by the AI, not read by a person.
  The program gate proves only what its canaries test: a change that weakens a check no canary covers, with the other tests that would catch it edited in the same branch or dropped in a way the title scan does not see, is merged when the AI reviewer misses it (see [Who owns the program](program-ownership.md#who-owns-the-program)).
  The gate is not a lock either: the AI holds merge rights, so an AI that skips `pnpm program-gate`, or merges a template pull request itself, is stopped only by its skill.
  Branch protection could require the `program-gate` job, at the cost of the signer overriding it for every pull request that changes only `templates/`, `registry/` or `testdata/`, which starts no such job, so the required check would wait on it forever.
- The self-check runs inside the program it checks.
  Anything with shell access to the work computer, such as an AI, that deliberately rewrites both the program and its self-check passes it.
  The basic tier does not stop this; in the hardened tier the independent check still decodes what the hash commits to.
- In the basic tier an AI on the work computer can read `$KISS_SIGN_HOME/.env`, and research scripts read the keys there on its behalf.
  The rule that the AI never asks for or prints a key is its behaviour, not a lock.
- The report's 錢包顯示 says what a Ledger that supports ERC-7730 can show, not what the signer's wallet shows.
  A Ledger with a current Ethereum app resolves the Safe proxy to its singleton through Ledger's own signed server answer, not the chain, then decodes the `SafeTx` and, from app 1.19, the call inside it.
  Not verified: whether Safe{Wallet}'s Ledger connection uses that path (Ledger's context module) or an older one that shows only hashes or raw fields, and whether Ledger's live metadata service serves the Safe descriptors of the pinned commit.
  Trezor, Keystone and GridPlus do not document ERC-7730 proxy matching for a Safe, so the report claims nothing for them.
  No descriptor decodes a Safe MultiSend batch, and the `SafeTx` descriptor hides the nonce and `safeTxGas`.
  The hashes cover all of it, and a Ledger shows them beside a decoded `SafeTx` only with its "Transaction hash" setting on; in the hardened tier the independent check decodes the transaction on a second computer.
  That setting's name and effect were read in the Ethereum app's source (`LedgerHQ/app-ethereum` at `e5b6dbff`, `src/features/sign_message_eip712/eip712_v1_ui_logic.c` and `src/nbgl/ui_home.c`), not tried on a device.
- A template is only as good as its review.
  The mutation check and the simulation are the backstops.
- The v1 templates were written and merged by the AI without human review.
  The signer reviews them during final testing.
- The perturbation test samples a few values per free field on recorded transactions.
  A contract that treats one rare value of a free number differently, chosen by an attacker at signing, is not found by it; the lint keeps such a field to a number, never an address or a call.
  Empty `bytes`, such as the VaultBundles permit data, has no byte to change in place, so its `unread` claim is not exercised, and an empty array of numbers, such as a Uniswap swap's `minHopPriceX36` when the app sends none, has no item to change.
  A `route` claim is checked only against the effects: a pool the perturbation reaches gives some other amount, and the test shows only that it stays within the card's minimum, not that every pool anyone opens does; that rests on the transaction's own minimum, which the router enforces.
  CCTP's message and attestation are claimed `proof` but have no recorded transaction to perturb, since no Safe received a CCTP message in a transaction of its own in the searched blocks.
- The perturbation replay checks each recorded block header against its own hash and the executed block's number and time against the Safe Transaction Service's record, but nothing offline ties a block hash to the chain.
  A recording made up whole, with a header built to hash to a new hash, every simulation answer edited to match, and the `testdata/safe-tx/` fixture's `executionDate` edited too, still replays; the diff of the fixture shows the last edit.
- The perturbation test compares logs and the Safe's measured effects, so a changed free field that only writes storage without an event looks the same.
  A free field with nothing to change, such as empty bytes or an empty array, gets no run, and the report does not flag it.
- For an executed transaction, the Safe's ETH change is its balance at the execution block minus its balance at the parent block, since no log shows ETH sent as the value of `execTransaction` itself.
  Another transaction in the same block that moves the Safe's ETH changes that number too; the field checks still bind the value of every call the Safe makes.
- For an executed transaction, a card that gives `all` of a token reads the Safe's balance of it at the parent block and at the end of the execution block, and is `UNVERIFIABLE` unless the two differ by exactly this transaction's change.
  Two other transactions in that block whose changes to the token cancel out go unnoticed.
- A view effect checks a direction, not an amount.
  Morpho Blue's `position` counts shares, and turning them into assets takes the market's totals and Morpho's own rounding, which is protocol code the engine does not hold.
  So a supply that gives the card's amount and adds a single share passes the view; that the bundler supplies the whole amount rests on the field rules, which bind `assets` to the card's amount, and on the review and code pins of BlueBundlesV1 and Morpho Blue.
- For an executed transaction, a view effect reads the parent block and the end of the execution block, and also simulates the transaction alone on its parent block, and both readings must show the change.
  Another transaction in the execution block can still change the block reading, such as another supply to the Safe's position in the same market, which can make a correct transaction `MISMATCH`.
  The simulation, like every simulation of an executed transaction, does not see the transactions before it in its block, so an earlier transaction that stops this one from moving the view on chain, together with a later one that moves it, still passes both readings; for a Morpho supply the receipt still shows exactly the amount leaving the Safe.
  A simulation that cannot run leaves the views unread, so such a transaction is `UNVERIFIABLE`: one of a Safe 1.1.1, whose settings a simulation cannot read, or the second of one Safe's transactions in the same block, whose nonce at the parent block is not its own.
  This applies to executed transactions only, as `pnpm history` and `verify` on an executed hash read them; a transaction to sign reads its views around itself in one simulated block.
  Neither reading relaxes a field rule: those still bind every call the Safe makes.
- For an executed transaction, the floor rules on the Safe's settings read the receipt's events, and for a declared owner or threshold change also a simulation of the transaction alone on its parent block, and an `ownerBefore` rule reads the owner list at the parent block too; earlier transactions in its block may have moved either, as when one Safe adds and then removes an owner in one block; a correct change can then be `UNVERIFIABLE` or `MISMATCH`, never the reverse.
  A storage write without an event shows only in a simulation.
  The static floor refuses a delegatecall from the Safe itself, but a call to an already enabled module can still make one through `execTransactionFromModule`.
- The Safe web app's Manage signers dialog sends one call for one change and a MultiSend of several calls for several, such as a replacement and a new threshold. kiss-sign checks one change per Safe transaction (at most one operation with `effects.safe` on a card), so a batch of several gives `MISMATCH`, or is refused at `card seal` when the card names two such operations; the signer makes each change as its own transaction.
- The Safe's own code is not pinned: a call to the Safe runs whatever singleton its proxy names.
  The floor refuses every transaction that changes the singleton, and the registry holds the official Safe 1.3.0 and 1.4.1 singletons, whose ABI proof the Safe settings reports show, but `verify` does not yet check which singleton the configured Safe runs.
- A Uniswap swap's router inputs are `encoded` parameters, not calls, so the 比對清單 shows each as `check.sh` does, one undecoded `bytes` value: in the hardened tier the independent computer confirms the hashes and the `execute` call, and shows the swap's recipient and minimum out inside it only as kiss-sign's hints read them, under a warning; that the router reads them so rests on `verify`'s field check.
- A standing allowance to Permit2 lets any Permit2 permit the Safe signs move that token.
  A Safe signs such a permit off-chain, as a Safe message its owners sign (EIP-1271), which kiss-sign does not check: an owner tricked into signing a permit for another spender gives that spender the token, with no transaction for `verify` to see.
  The Universal Router's own allowance is safe to keep only while the router pulls from its caller alone, which its pinned code shows; a router at another address is another registry entry and needs its own review.
- The static floor refuses an ERC-20 approval only at or above 2^255, and a Permit2 approval only at the uint160 maximum.
  A token-specific sentinel such as 2^96-1 (UNI, COMP) passes the floor; the effects check refuses any measured allowance, ERC-20 or Permit2, that ends above its value before the transaction.
- Not yet seen by effects: an NFT `setApprovalForAll`, ERC-1155 balances and approvals, Aave's `approveDelegation`, Compound Comet's `allow`, and allowances in the Safe AllowanceModule.
  A change to any of them moves no balance the program measures.
  Permit2 is read only at its canonical address.
  A transaction that lets the Safe accept EIP-1271 signatures moves no allowance now but enables a later `permit`; the floor rules already refuse the usual routes, a delegatecall to SignMessageLib and a fallback handler change.
  The static floor refuses `setApprovalForAll` when it is set, and a call that changes only one of them is marked as moving no asset.
- The mark on calls that move no asset is per call the Safe makes.
  A call that moves an asset and also grants a permission, such as a `multicall` that deposits and authorizes, is not marked.
  Each call runs as its own Safe transaction, so a contract that reads the Safe's nonce or the transaction's origin can act differently than in the real batch; a call that does not execute that way makes the scan unreadable, which `verify` prints.
  For an executed transaction the scan is a simulation on the parent block, not its exact pre-state.
- The repository to trust is the `repo` that `init` wrote into `$KISS_SIGN_HOME/config.json`.
  An AI that can write that file, or run `init` on a fresh home from a clone whose `origin` it chose, names another repository and passes the self-check.
  In the basic tier nothing stops an AI on the same computer from doing either; the hardened tier's independent check reads neither.
  The self-check's git calls take no `GIT_*` variable from the caller, follow no git replace ref, run no hook and ask no fsmonitor; all but the fetch and the origin URL read only the clone's own git config.
  The fetch reads the system and global config too, since a private repository needs the signer's credential helper there.
  So git config, in the clone or global, that runs a program or reroutes the connection during the fetch, such as `core.sshCommand`, a credential helper, a proxy or a turned-off TLS check, can run code or serve another repository under the configured URL.
  In the basic tier nothing stops an AI on the same computer from writing that config.
  The self-check does not check code the root `.gitignore` ignores, such as the root `node_modules/`; an ignored directory counts only at the root, so `src/node_modules/` is named.
  The packages Node loads from `node_modules/` are checked against their pins instead, before any is loaded (see [The installed packages](program-ownership.md#the-installed-packages)); Node itself and `NODE_OPTIONS` are not.
  It refuses a clone whose git directory is not its own `.git`, such as a linked worktree, so the clone `verify` runs from is a plain `git clone`.
  It also refuses git replace refs.
  It checks the clone once, so code that rewrites the clone or its objects after the check, while the program runs, is not caught.
  `template approve` and `history` fetch through the same origin check and object check, and `history` falls back to the local `origin/main`, unchecked, when the fetch fails.
- `pnpm erc7730` reads one pinned commit of the ERC-7730 registry.
  A descriptor or attestation added later is unseen until the pin moves; a revocation is read on chain, so it shows at once.
- `pnpm erc7730` checks only offchain attestations kept in the registry's `sigs/` folders.
  An onchain EAS attestation of the same schema is not searched.
  A signer that is a contract (ERC-1271) is not checked: its attestation prints as `INVALID`, because its signature does not recover to the contract's address.
- An attestation proves who reviewed a descriptor, not that it is right.
  The `auditors/` folder, like every descriptor, is added by pull request to the registry; the program prints only the signer's address and whether a folder lists it.
- A descriptor scoped by a factory applies, in `pnpm erc7730`, only when its factory is the one the entry's registry `factory` attribute names.
  The output's first lines name every factory-scoped descriptor in the archive, so one scoped by another factory that also deployed the contract is visible but not matched.
- `descriptorHash` merges includes the way the registry's own script does, and matches the attested hash of 162 of the 164 calldata attestations at the pinned commit; the other two (Safe's `SafeMigration-1.5.0` and WalletConnect's `wct`) attest an earlier version of their descriptor and print as `INVALID`.
- `replay` trusts the verdict file it is given.
  It shows what a recorded verdict was based on; it is not permission to sign.
- When the code on chain ends in a metadata trailer without a source hash, as solc writes with `bytecodeHash: "none"`, matching bytecode proves the ABI's selectors and types but not its parameter names, since no byte on chain depends on them.
- When the source Etherscan holds compiles to the code on chain except the metadata hash (IPFS, or Swarm `bzzr0` for solc before 0.5.9), which hashes the source text, file names and comments included, the proof masks that hash, so it proves the ABI's selectors and types but not its parameter names.
  The generated report prints this as a FINDING, graded reference (see Finding grades under Report, step 6 of [the flow](flow.md#first-time-an-operation-is-done-build-its-template)).
  The signer's HTML page keeps it out of 待確認, since every other byte is proven and nothing the signer could check would change it: USDT, USDC, Morpho Blue and Circle's CCTP MessageTransmitter all differ there.
  A source verified on Etherscan as one flattened file usually differs there, since its file name and layout are not the deployed ones.
- The simulation reads at most 50 modules.
  A Safe with more is `UNVERIFIABLE`.
- A code pin covers the code a call runs, not the contract's storage.
  A contract that changes its behavior by a storage switch in its own code keeps its pin: USDT forwards every call to another contract once its owner sets `deprecated`.
  Settings an admin can change, such as a vault's curator, fees or caps, are not pinned either.
- Only registry entries are code-checked.
  A market on the card names Morpho Blue, its tokens, its oracle and its interest rate model as registry entries, so each of them is pinned.
  A contract the transaction reaches without being one is not: the Morpho Blue markets, oracles and interest rate models behind a vault, the adapters of a Morpho Vault V2 that no card reference names, and the Safe's own singleton, fallback handler and guard.
  For the Safe's settings the floor rules check only that the transaction does not change them.
  A contract reached only from inside a registry contract, such as Fluid's Liquidity layer behind each fToken, is checked when that entry names it in `dependsOn`.
- A proxy that routes each selector to its own implementation has no view that lists its implementations, so its pin covers the implementations its seeds reach and the selectors those list.
  Seeds that miss an implementation leave it unchecked: the pin does not hold it, neither `verify` nor the report reads it, and a call to one of its selectors runs code nothing pinned.
  Only the AI's notes on the entry, from the proxy's implementation history, say that a seed reaches every implementation still set, and no program checks them.
  An implementation added later whose selectors are all new is reached by no seed and is not seen: Fluid added one so at block 24,649,359, removing nothing and leaving the placeholder in its slot.
  Until it was added, a call to those selectors reverted.
  The two views are the proxy's own: an Instadapp InfiniteProxy defines `getSigsImplementation` and `getImplementationSigs` in the proxy contract and sends to an implementation only a selector it does not define, so its own code answers them, no route can take them over, and other answers need other proxy code, which the pinned code hash refuses.
  A proxy whose views were themselves routed would answer them from an implementation, which the pin holds only when a seed reaches it.
  The routes are read through Multicall3, which has code from block 14,353,601, so routes at an earlier block cannot be read and `pnpm pin-code`'s walk stops there.
  Storage other than the routes, such as the Liquidity layer's rates and limits, is not pinned (see the code pin limit above).
- Earlier pins come from the chain, not from a review of that code.
  They answer whether a past transaction ran the code that contract held at its block, not whether that code was safe.
  The generated report prints every span of every entry it covers and checks its first block and the block before on the chain when the AI records it, so a hand-written span whose code the chain did not run there is a FINDING; no program reads those recorded answers again, and a span a reader of the report accepts is still unreviewed code.
  The spans of an entry no generated report covers are seen only in the `registry/contracts.json` diff.
  The check reads the two blocks at each edge, not every block in between, so code that changed and changed back inside a span is not seen; `verify` still reads the code at each transaction's own block.
  An entry pinned before ranges holds one pin from block 0 until `pnpm pin-code` reads it again, so a past transaction that ran before an upgrade of such an entry is `MISMATCH` (contract-code).
- `pnpm pin-code`'s walk finds where each pin starts by halving the blocks, so it assumes a pin holds over one unbroken run.
  Code or routes that change and change back, A to B to A, between two blocks it reads leave B unseen, and the gap joins A's span.
  Routes make this likelier than code, since an admin can add an implementation and remove it again.
  Only a transaction executed in that gap is affected: `verify` reads the code at its block, finds B where the pin names A, and gives `MISMATCH`, the safe direction; a transaction to sign needs today's pin.
- A proxy is recognized only by EIP-1167, the Safe proxy, the EIP-1967 implementation and beacon slots, and the ZeppelinOS slot, or, for an entry that declares `routes`, by the routes its pin holds, or, for one that declares `implementationRead`, by its views and the probe; an implementation's extension only as the one constant address the walk finds its fallback handing a call to.
  Code that delegates anywhere else is refused only when the walk of a call that matches no function reaches that delegation (see Establish the ABI, step 3 of [the flow](flow.md#first-time-an-operation-is-done-build-its-template)).
  The walk follows one such selector, so a fallback that delegates only for some selectors it compares, such as only for `transfer`, or that copies a slot's value through branches on it, passes, and so does a named function of the proven ABI whose own body delegates, as each function of a Compound-style delegator does: a call to it runs code that is neither proven nor pinned.
  A beacon proxy's code is not walked.
  A fallback that forwards a call with CALL to an address from storage, as Synthetix's `ProxyERC20` does, is not a delegation and is not refused, though the ABI proven is still only the forwarder's.
  A word the walk neither folds nor knows, and that state did not choose, counts as a word of the call's data, so a constant address passed through arithmetic the walk does not fold, such as ADD, or written to memory at an offset that is not a constant and read back from there, passes as the call's data: code built to hide a delegation this way is not refused.
  Code that can delegate and whose dispatcher jumps to computed targets, as a Vyper jump table may, is refused as `fallback-unfollowable`.
  The walk computes no hash, so a ZeppelinOS proxy whose compiler hashes the slot's name at run time, as solc 0.4 does, is refused although `locate` finds it; no registry contract is one.
- The probe of a declared `implementationRead` shows that the declared code runs as the proxy, not that the proxy's one delegation goes to it directly.
  That delegation may go to a contract whose code no pin holds, which hands the call on to the declared implementation by its own DELEGATECALL, or reads the replaced code with EXTCODECOPY and returns its word, and does something else for other selectors; the probe passes and that contract is neither proven nor pinned.
  A proxy built to hide code this way is not told apart from Aragon's.
  The probe follows one call, with one selector the proxy's code never pushes, as the walk does.
  A fallback that takes its one delegation more than once, as a loop could, first to code nothing replaced and then to the declared implementation, still answers the word, and a fallback that picks its implementation by the selector is seen only for the selector probed.
  The views run code no pin holds, such as an Aragon kernel's `getApp`: a change there is seen only as another implementation answered, which the pin then refuses.
  The probe needs `eth_call` with a state override from both providers at every block it reads, including the old blocks `pnpm pin-code` searches.
- Local registry entries for `pnpm history` (`$KISS_SIGN_HOME/history/registry.json`) are pinned with `pnpm pin-code --history`.
  A history row that touches an unpinned local entry is `UNVERIFIABLE`.
- A `pnpm history` card that names a template origin/main does not hold, such as one removed since the card was written, is not run: its row's reason is `no-template` with the missing template ids, and the other rows still run.
- The process a compile runs in is a limit, not a sandbox built for hostile code: Node's permission model in Node 22 does not restrict the network, and Node does not promise that code it runs cannot get around the model.
  A pinned build that turned out hostile could still reach the network: send what it was given, the verified source, which is public, and it may signal the signer's other processes.
  It needs no network to defeat the proof: it can compile the source correctly and answer the right bytecode beside a wrong ABI.
  That is why the pin, not the process, is the defense against such a build.
  The `vm` context the build runs in keeps Node's globals out of its sight but is no boundary: a dynamic `import()` in it rejects with an error of the host's realm, whose constructor reaches the host's `Function`.
- A solc before 0.6.2 is pinned by `bin/list.json` and the GitHub release asset alone, and `pnpm pin-solc` does not read the wasm list for it: soliditylang's `emscripten-wasm32/list.json` holds, for those releases, a wasm build made later that no release carries, with another sha256.
- A signed message is checked only when its `lookup` answers it.
  A CoW order is in CoW's order API once the app has posted it, before the Safe transaction is proposed; while the API is down, or for an order it never received, `verify` is `UNVERIFIABLE`.
  The program reads no other part of the answer: what the order's app data holds (a partner fee, hooks a solver runs from CoW's trampoline contract) is not checked, since the settlement contract never reads it and enforces the signed limit, receiver and amounts whatever it says; the review weighs it.
- A signed message is read only from an API that serves it by its digest to one GET with no key, as one struct whose members are atomic, `string` or `bytes`.
  As of November 2026, CoW's order API fits with no `answer`, Velora's Delta API (`/delta/orders/hash/{hash}`) serves its order under `order` but signs a nested `Bridge` struct, 1inch's Fusion and orderbook APIs answer only with an API key, UniswapX's order API answers the order ABI-encoded inside a Permit2 witness of nested structs and arrays, and Bebop's order status is read by quote id, not by digest.
  None of those is read.
- An approval `effects.approves` leaves open can be spent by any order the spender's protocol accepts from the Safe, not only the order of this transaction: for CoW, any of the Safe's orders still valid, such as an earlier pre-signed one or a conditional order the Safe's fallback handler signs.
  The approval is the card's sell amount, so no order can take more than that.
- A CoW order is pre-signed for as long as its `validTo` allows and its approval stays open until the order fills.
  Both CoW templates bind `validTo` to at most 604800 seconds (seven days) after the time of the block the transaction is judged on (`withinSeconds`), so a signed order can stay open for up to a week; the card has no expiry of its own.
  The order fills at most once, at no less than the card's minimum, and the Safe can cancel it.
- Safe 1.1.1 has no `getStorageAt`, so a simulation cannot read its settings, and a pending transaction of a 1.1.1 Safe is at best `UNVERIFIABLE`.

## Later security upgrades

Not built now.
Listed so the path is clear.

- **Light client (Helios).**
  Verifies every read against the beacon chain, so one provider is enough.
  Needs `eth_getProof` (Alchemy has it) and a local EVM to simulate on proven state.
- **Local simulation (anvil).**
  Free and open source.
  Adds execution diversity.
  On its own it trusts the same RPC state.
- **A paid or third provider.**
  Removes rate and range limits and adds an independent source.
- **Clear signing on the wallet (ERC-7730).**
  Export templates as display descriptors so the device shows the decoded call.
  Wait until wallets decode Safe MultiSend batches and the descriptors stop hiding the nonce; until then, hash comparison stays.

## Out of scope

EOA signing, off-chain EIP-712 signatures, and chains other than Ethereum mainnet.
