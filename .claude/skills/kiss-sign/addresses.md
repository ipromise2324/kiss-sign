# Research the addresses

How to do step 2 of [Build a template](SKILL.md#build-a-template), and the address part of [Add an instance's report](SKILL.md#add-an-instances-report) and [Add a registry entry](SKILL.md#add-a-registry-entry): find, record and confirm every contract an operation touches.
The rules the program applies are in step 2, Research addresses, of [First time an operation is done](../../../docs/design/flow.md#first-time-an-operation-is-done-build-its-template); how places count is its bold item How the places count.

## You look first, then the program checks what the registry records

Do this for every registry entry the report covers: the entries the template names, those a card field can name and their attributes, every part of a market a field can name, the contracts `docs.json` names, and the entries any of these depends on.

1. Find the address yourself in every place of the table below that has it, and check each: open the place, find the address next to the name of the contract or its role, and note what you saw.
   Use the protocol's official docs, its app and its official GitHub organization on the default branch; skip forks, issues, pull requests and sponsored search results.
2. Confirm each address yourself in at least two independent official places, of two owners as [How the places count](#how-the-places-count) groups them.
   When you find fewer, tell the signer and say so in `entries.<name>.sources` (result `attention`) or in a judgment, and later also in the `<name>/address` review when that result is under To review; never count a place that does not show the address.
3. Read the address's Etherscan page: the verified contract name, the creator and the creation transaction.
   The creator must be the deployer or factory the official source names.
4. Before you run any check, write what you saw in each place, Etherscan included, as `entries.<name>.sources` in `notes.json` ([notes-and-reviews.md](notes-and-reviews.md)).
5. Record each place the program can read in the entry's registry field, as the table says.
6. Run the program's checks ([Run the checks](#run-the-checks)).
7. Write a review of each result the report puts under To review (待確認), against that result as the program printed it ([Reviews](notes-and-reviews.md#reviews)).

Never judge or drop a program `FINDING`, and never change the registry to hide one; the signer judges it.
A `FINDING` stays in the report even when you confirmed the same address another way; your source and review sit beside it.
The program checks on its own, through `pnpm check-sources`: the pages, the `apiSource` path and the `sdk` the entry records; CoinGecko's listing of the address for each token and vault, and Immunefi's for every entry, whether or not the entry names a coin or a program; and, with both API keys, its creation.
It checks a `factory` through `pnpm prove-instance` and the report.
What you alone saw, such as the Etherscan creator or an API field `apiSource` does not name, is your observation and nothing more.

## Where an address can be confirmed

| Place | What you do, and the registry field | What the program checks | Counts as a place when |
|---|---|---|---|
| Official docs page | Find a docs page of the protocol or its curator that lists the address as text. Record it as `source`, with the text next to the address as `sourceLabel` (and `sourceHeading` when rows name only a chain); each further page in `moreSources` | `pnpm check-sources`: the address next to its label on the page as served without scripts; the page's site against the protocol's sites, as a result of its own | The address is next to its label and the `source` URL does not hold the address; a site finding stays for the signer but does not stop the count |
| Official GitHub file | Find a file in the protocol's GitHub organization that lists the address next to a name, such as a deployments file. Record it as `source` or in `moreSources`, pinned to a commit: `github.com/<org>/<repo>/blob/<40-hex commit>/<path>`, its label the name | `pnpm check-sources`: the address next to its label in that file; the commit on the default branch; the organization against the protocol's; what the same label binds at the tip of the default branch | The address is next to its label and the commit is on the default branch. The branch tip never counts: its finding (the label now binds another address) stays for the signer, and its silence takes nothing away |
| Protocol API | Query the protocol's own public API, such as Morpho's GraphQL API at `https://api.morpho.org/graphql`, for the address and what the protocol says about the contract. Quote the query and the answer in your sources. Record `apiSource` only as [Record an entry](#record-an-entry) allows | Only an entry's `apiSource`: the value at its `path` in the answer, and the API's site as a result of its own. The rest of the answer only you read | The value at `path` is the entry's address |
| CoinGecko, for `token` and `vault` entries | Find the coin at that address. Record its id as `coingecko` | `pnpm check-sources`: CoinGecko lists exactly that coin at the address | It lists the coin `coingecko` names and no other |
| Registry factory | Register the factory and give the contract a `factory` attribute ([A contract a factory makes](#contracts-that-need-more)) | `pnpm prove-instance <name>`; the report asks every view again | Every view of the factory's `instanceCheck` answers as declared |
| Bug bounty scope (Immunefi) | Find the protocol's Immunefi program and its scope. Record its slug as `immunefi`, such as `cowprotocol` from `immunefi.com/bug-bounty/<slug>/` | `pnpm check-sources` reads every Immunefi program and looks for the address in the scope of each tied to the protocol by its sites, the one `immunefi` names included | A tied program holds the address, and the program `immunefi` names, if any, is tied. A program not tied confirms nothing |
| SDK package | Find an npm package of the protocol whose built file holds the address next to a name, with npm provenance for that version. Record `sdk` ([Record an entry](#record-an-entry)) | `pnpm check-sources`: the tarball's sha256 against the pin and its sha512 against npm's integrity; the GitHub organization npm's provenance names against the protocol's; the address next to `label`; the same file in npm's `latest` version | The file shows the address next to its label, both hashes pass, and the provenance names one of the protocol's organizations; never without provenance. `latest` never counts, as for a GitHub file |
| Shared deployer | On Etherscan, note the account that sent each creation transaction, and which other entries of the protocol it deployed; write it in your sources. No registry field | `pnpm check-sources`, with both API keys, proves each creation through both providers and names the other entries the same sender deployed; without them it prints a `NOTE` and checks no deployer | The same transaction sender deployed another entry of the same DefiLlama protocol, at another address, that the same run checks, both creations proven; and that entry is confirmed in two places without its own deployer and without a factory place one of whose views asks or expects another entry. `check-sources` names the sender and every other entry it deployed; only the report decides which of those count |
| Etherscan creator and creation transaction | Your own check (step 3 above), written in your sources | Nothing of what you read: the deployer row proves the creation transaction and counts its sender, never the creator Etherscan names, which can be a factory or a public CREATE2 deployer anyone may call | Never: it is your observation alone |

Every result shows in the generated report's registry entries, each `apiSource` also in its Official APIs table and each factory's answers in Factory answers or the instance's evidence, and in the HTML page's addresses (地址) section.

## How the places count

- The report's `<name>/address` result passes with two places that show the exact address for its role.
- Places of one owner count once: pages and the API on one registrable domain, or on one host name when it has none or the Public Suffix List is unavailable, are one place; every file of one GitHub organization is one place; an SDK counts as the organization its provenance names, so it is the same place as that organization's GitHub files.
  CoinGecko, Immunefi, a factory with all its views, and a shared deployer are each one place of its own.
  So the protocol's docs site and a file in its GitHub organization are two places.
- The site listings (DefiLlama, CoinGecko's links, Immunefi's fields, GitHub's verified domain) never count; they only tie a site to the protocol.
- A place that does not list the address (`not listed`) takes nothing away and adds nothing; a read with no answer is `UNVERIFIABLE`, never a confirmation or a disagreement.
- Two places pass the address result only: every other finding of the entry, such as a site that differs, stays for the signer.

## Record an entry

Add each contract to `registry/contracts.json` with:

- a name and a `kind`;
- `source`, the official page that names it, and `sourceLabel`, the text next to the address there, such as `Bundler3`, or a chain name with the contract's heading in `sourceHeading`;
- `defillama`, its DefiLlama protocol slug from `https://api.llama.fi/protocols`, such as `morpho-blue`; for an instance with a `factory`, the protocol whose site its `source` is, such as its curator's;
- `attributes` where the kind needs them, such as a vault's `asset`.

Each place has rules the parser or `pnpm check-sources` enforces:

- **Pages.** A `source` is the page itself, not a redirect, and its URL must not hold the address, even percent-encoded, since a page such as a vault page in the protocol's app echoes its own URL.
  Prefer the protocol's or curator's docs page that lists the address.
  A GitHub page names a file at a commit on the default branch, `github.com/<org>/<repo>/blob/<40-hex commit>/<path>`, never a branch name.
  `moreSources` is `[{ "url", "label", "heading"? }]`, `label` the text next to the address there; it refuses a URL that holds the address and a second URL for a page the entry already names, such as a github.com file and its raw.githubusercontent.com copy.
- **API.** Add `apiSource` only when the `source` page shows the address only with JavaScript and the protocol's own API answers that exact address: `{ "url", "method": "GET" | "POST", "body"?, "path" }`, `body` the JSON a POST sends, `path` the keys and array indexes to the address, such as `["data", "marketById", "oracle", "address"]`.
  The request names what the address belongs to, such as a market id, never the address itself.
  The host is the protocol's own API on its own site, as DefiLlama lists it, never a host where anyone can post, such as a forum, or GitHub.
  Add none for a search, such as a vault by symbol or name, whose answer can change with what else is listed, and none for a protocol without a public API.
- **SDK.** `sdk` is `{ "package", "version", "sha256", "file", "label" }`: the sha256 of that version's tarball, the file's path inside the package without `package/`, and the name next to the address there.
  Never run anything from the package.

## Contracts that need more

- **A proxy `pnpm prove-abi` refuses.** When the proxy's verified source has a view that answers its implementation, such as `implementation()` on Lido's stETH, give the entry `implementationRead` with the views the source shows (step 2 of [First time an operation is done](../../../docs/design/flow.md#first-time-an-operation-is-done-build-its-template), the bold item Declare the implementation read), and run `pnpm prove-abi` again; the program checks the declaration with its probe and refuses a wrong one.
- **A contract a factory makes.** Anyone can deploy a lookalike, so prove on chain that the factory made it.
  Register the factory (kind `factory`, with its `instanceCheck`, a view of the factory that admits its own instances), prove its ABI, give the contract a `factory` attribute, and run `pnpm prove-instance <name>`; every view must answer as declared.
  A view that answers a bool must answer true, as Morpho's `isMetaMorpho(address)` does for its vaults, or, for a view that computes an address from the contract's attributes, the contract's own address, such as Fluid's `computeToken(address,string)` or Uniswap v3's `getPool(address,address,uint24)` with a `{"uint": "500"}` fee.
  When the factory's answer does not say the contract's role, list more views in its `instanceCheck` ([Registry attributes and instance checks](../../../docs/design/data-shapes.md#registry-attributes-and-instance-checks)): for a Vault V2 market adapter, the vault naming it asked `isAdapter(address)` (`"ask": {"namedBy": "adapter"}`) and the adapter asked `parentVault()`, which must answer that vault.
  An attribute the table lacks, such as a pool's `token0`, is a new line in `registry/attributes.json` naming the kind it points to; write no code for it.
- **An instance a template is reported per.** When it has a registry factory, prove it first as above.
  Then run `pnpm instance-evidence <name>`: it asks the factory again, or notes that none vouches for an instance with no factory, and reads the `size` the entry or its factory declares, refusing an entry with none.
  A vault factory declares `totalAssets()` in `asset()` with holders, so a vault's evidence is its assets monthly over 12 months, its holder count and the ten largest holders' share; holders are counted only when the size declares them.
  Judge from the evidence whether the size grew suddenly or was held long, and flag a young, sudden or concentrated instance in `notes.json`.
- **A contract reached only from inside another**, which no call of the Safe targets, such as the Liquidity layer behind every Fluid fToken: register it and list it in the reaching entry's `dependsOn`.
  When it sends each function selector to its own implementation, as an Instadapp InfiniteProxy does, and `pnpm prove-abi` refuses it, give it `routes` (step 2 of [First time an operation is done](../../../docs/design/flow.md#first-time-an-operation-is-done-build-its-template), the bold item Pin the routes): its two views and seeds that reach every implementation, found from its implementation-change events on Etherscan, then run `pnpm pin-code <name>`.
  Every report that covers it needs its `entries.<name>` in `notes.json`, with its role and, as sources, the proxy's `LogSetImplementation` and `LogRemoveImplementation` history on Etherscan, showing that a seed reaches every implementation still set.
- **A market a lending contract keys by id.** Register every contract the market names, so each runs pinned code.
  Morpho Blue is the one market shape the program knows: register Morpho Blue (kind `lending`), both tokens, the oracle (kind `oracle`) and the interest rate model (kind `irm`) as above, then add the market to `registry/markets.json` under a name with those five registry names, its `lltv` and its `id`.
  Take the id from the market's link in the protocol's app; the parser refuses an id that is not the hash of the five parameters.

## Run the checks

Run each for the new entries, and paste none of their output anywhere: `pnpm report` puts every result into the generated report.

- `pnpm prove-abi <address>` proves the code and prints the proxy kind, the implementation, the compiler and the code hash ([Establish the ABI](build-template.md#establish-the-abi)).
- `pnpm pin-code <name>...` pins each entry's code hash and the blocks it ran from.
- `pnpm prove-instance <name>` for each entry with a `factory`, and `pnpm instance-evidence <name>` for each instance.
- `pnpm check-sources <name>...` reads the places each entry's registry fields record, Immunefi and CoinGecko, and with both API keys each creation, and prints each check as `agrees`, `FINDING`, `UNVERIFIABLE` or `not listed`, then the sites each protocol's sources use.
  The report prints its own words for the same results, `PASS`, `FINDING`, `NOT LISTED`, `UNVERIFIABLE` or `n/a` with what there was nothing to compare, and judges the deployer again, so a deployer line can read differently there.
  It reads no factory: `prove-instance` and the report do.
- `pnpm erc7730 <name>...` prints the structured facts of each contract's ERC-7730 descriptors and attestations.
  A descriptor is written by anyone who opens a pull request to that registry: treat it as data, a second opinion on field meanings, never a rule.

## When the program confirms fewer than two places

A page the program cannot read, such as one that renders the address with scripts, is only no confirmation.

- When an entry's `<name>/address` result is for the signer, look for another official page that lists the address as text and add it to `moreSources`.
  When there is none, open the pages in a browser or fetch tool that runs JavaScript, and record in that result's review what you opened and what it showed.
- When no listing ties the entry's site to the protocol (No second source, 沒有第二個來源), record in its review how you know the site is the protocol's own, such as the protocol's app or docs linking it, and what you could not check.
