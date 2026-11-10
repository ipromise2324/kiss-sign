# Test data

Every fixture is a fact about Ethereum mainnet, recorded by a script in this repository. None comes from the Safe kiss-sign is configured for.

## Safe transactions

`safe-tx/<name>.json` holds one executed Safe transaction:

- `service`: the transaction as the Safe Transaction Service returns it from `/api/v2/safes/<safe>/multisig-transactions/`.
- `chain`: what the Safe itself answered by `eth_call` at `block`: `VERSION()`, `domainSeparator()`, and `getTransactionHash(...)` of the service's fields.
- `providers`: the providers that both gave exactly these answers. A disagreement stops the recording.
- `block`: the block the transaction executed in, where the calls were made.

The tests require the hashes kiss-sign computes to equal `chain.domainSeparator`, `chain.transactionHash`, and the service's `safeTxHash`.

| File | Safe | Nonce | Transaction | What it does |
| --- | --- | --- | --- | --- |
| `morpho-vault-deposit.json` | `0xAF177c57e369bBD30F47745DbAAF1D225f4B74D0`, Safe 1.4.1 | 249 | `0x936609ab7c5a3e8a5b2474b8bb23afc8e01e50c3ac1ff5a5af44a43c4cd59b9f`, block 26,048,223 | A `delegatecall` to MultiSendCallOnly 1.4.1 (`0x9641d764fc13c8B624c04430C7356C1C7C8102e2`) with two calls: USDC `approve` of 1,800,000.000180 USDC to GeneralAdapter1 (`0x4A6c312ec70E8747a587EE860a0353cd42Be0aE0`), then `Bundler3.multicall` (`0x6566194141eefa99Af43Bb5Aa71460Ca2Dc90245`) running `erc20TransferFrom` and `erc4626Deposit` of that amount into the Morpho vault Steakhouse Prime USDC (`0xbeef088055857739C12CD3765F20b7679Def0f51`), shares to the Safe. safeTxHash `0x0287ff5583b9bda9564e871c98d292c1a5b433cba905b02df369bab37b20c84a` |
| `eth-transfer-null-data.json` | `0x9467dcFD4519287e3878C018c02f5670465a9003`, Safe 1.3.0 | 107 | `0xf9700d816b21085504188e92edc585999c4f06ead14d3bbdf931589ad1d28dac`, block 17,026,957 | A plain transfer of 4.988797943068499801 ETH to `0x4942fbdc53B295563d59Af51e6DDEdceba5E332f`. The service reports its empty calldata as `data: null`. safeTxHash `0xd3ac54144c716e0044b461c068ffd19742c022b265bd51f2d01f7c8ad0399df6` |

The Morpho deposit was found by listing token transfers into GeneralAdapter1 with Etherscan's `tokentx`, keeping senders whose `VERSION()` reads like a Safe, and looking each transaction up in the Safe Transaction Service by `transaction_hash`.

### Recording again

```sh
ALCHEMY_API_KEY=$(sed -n 's/^ALCHEMY_API_KEY=//p' ~/.kiss-sign/.env) \
  pnpm record-safe-tx morpho-vault-deposit 0xAF177c57e369bBD30F47745DbAAF1D225f4B74D0 249
ALCHEMY_API_KEY=$(sed -n 's/^ALCHEMY_API_KEY=//p' ~/.kiss-sign/.env) \
  pnpm record-safe-tx eth-transfer-null-data 0x9467dcFD4519287e3878C018c02f5670465a9003 107
```

The last argument is a nonce (the executed transaction at that nonce) or a safeTxHash. The script reads from Alchemy and drpc and writes only the providers' names.

## ABI proofs

`abi/<name>.json` holds everything one ABI proof read, recorded by `scripts/record-abi-case.ts` while it proved the ABI live:

- `block`: the block both providers agreed on, which every read names by hash.
- `providers`: the providers that both gave exactly these answers. A disagreement stops the recording.
- `reads`: each `getCode`, `getStorageAt` and `call` the proof made, with the agreed answer.
- `sourcify`: Sourcify's answer (`/server/v2/contract/1/<address>?fields=compilation,stdJsonInput`) for the contract compiled.

The tests replay the reads, compile the Sourcify source with the pinned solc from `vendor/solc/`, and require the proof.

| File | Address | Proxy | Code compiled |
| --- | --- | --- | --- |
| `bundler3.json` | Morpho Bundler3 `0x6566194141eefa99Af43Bb5Aa71460Ca2Dc90245` | none | `Bundler3`, solc 0.8.28 |
| `general-adapter1.json` | Morpho GeneralAdapter1 `0x4A6c312ec70E8747a587EE860a0353cd42Be0aE0` | none | `EthereumGeneralAdapter1`, solc 0.8.28, 58 immutable spans masked |
| `morpho-token-eip1967.json` | MORPHO token `0x58D97B57BB95320F9a05dC918Aef65434969c2B2` | EIP-1967 | `MorphoTokenEthereum` at `0x4364fd2371b6318159366abFA51f190df5C24852`, solc 0.8.27 |
| `safe-proxy-1-3-0.json` | the Safe of `safe-tx/eth-transfer-null-data.json`, `0x9467dcFD4519287e3878C018c02f5670465a9003` | Safe proxy (1.3.0 factory) | `GnosisSafeL2` at `0x3E5c63644E683549055b9Be8653de26E0B4CD36E`, solc 0.7.6 |

### Recording again

```sh
export ALCHEMY_API_KEY=$(sed -n 's/^ALCHEMY_API_KEY=//p' ~/.kiss-sign/.env)
pnpm fetch-solc
pnpm record-abi-case bundler3 0x6566194141eefa99Af43Bb5Aa71460Ca2Dc90245
pnpm record-abi-case general-adapter1 0x4A6c312ec70E8747a587EE860a0353cd42Be0aE0
pnpm record-abi-case morpho-token-eip1967 0x58D97B57BB95320F9a05dC918Aef65434969c2B2
pnpm record-abi-case safe-proxy-1-3-0 0x9467dcFD4519287e3878C018c02f5670465a9003
```

An optional third argument records at that block instead of the latest.

## Simulations

`simulate/<name>.json` holds every JSON-RPC request one run of `scripts/simulate.ts` made for the Safe transaction `safe-tx/<name>.json`, with each provider's raw `result`:

- `executed` and `parent`: the block the transaction executed in, and the block the simulation sits on.
- `exchanges`: each request's `method` and `params`, and `answers` keyed by provider. Only requests both providers answered are kept.

The tests serve each provider its own recorded answer through the real reader, so parsing and agreement run as they do live. They simulate the deposit through `execTransaction` on the parent block, read its receipt, and judge both against the card. The simulation also reads the Safe's singleton, threshold, owners, modules, guard and fallback handler just before and just after the transaction, and the floor rules require them unchanged.

| File | Parent block | What the Safe gave and got |
| --- | --- | --- |
| `morpho-vault-deposit.json` | 26,048,222 | −1,800,000.000180 USDC, +1,742,403.090147006731022214 Steakhouse Prime USDC shares, no ETH; the USDC allowance to GeneralAdapter1 is 0 before and after; singleton `0x41675C099F32341bf84BFc5382aF534df5C7461a`, 6 owners, threshold 2, no modules, no guard, all unchanged |

### Recording again

```sh
ALCHEMY_API_KEY=$(sed -n 's/^ALCHEMY_API_KEY=//p' ~/.kiss-sign/.env) pnpm simulate morpho-vault-deposit \
  --card '{"operations":[{"template":"morpho/vault-deposit","values":{"vault":"steakhouse-prime-usdc","amount":"1800000000180"}}]}' \
  --record morpho-vault-deposit
```

## Past-transaction searches

`research/<name>.json` holds one run of `scripts/past-txs.ts --record <name>`:

- `query`: the template, the anchor token, the anchor kind, and the block range.
- `sources`: each request to Alchemy (`alchemy_getAssetTransfers`) and Etherscan (`logs/getLogs`), with its answer. No request holds a key.
- `providers` and `exchanges`: each `eth_getTransactionByHash` and `eth_getTransactionReceipt`, with the answers of Alchemy and drpc.

Before writing, the script drops every entry that mentions the configured Safe or one of its transactions, and refuses to write if any mention is left.

The tests replay the run and require the counts a reader sees: per source, per field, and per misfit reason. A Safe set as the configured Safe disappears from every count, and a transaction removed from one source's answer is marked as found by the other only.

| File | Anchor | Blocks | What it found |
| --- | --- | --- | --- |
| `morpho-vault-deposit.json` | Steakhouse Prime USDC shares minted | 26,044,000 to 26,052,000 | 65 transactions, all found by both sources; 3 executed by a Safe, 2 fitting `morpho/vault-deposit` |

### Recording again

```sh
KISS_SIGN_HOME=$HOME/.kiss-sign-lane-9 pnpm past-txs morpho/vault-deposit --token steakhouse-prime-usdc --anchor mint \
  --from-block 26044000 --to-block 26052000 --record morpho-vault-deposit
```

That home's `config.json` names the Safe of `safe-tx/morpho-vault-deposit.json`, so its deposit in this range is left out.

## Verdicts

`verify/<name>.json` is a verdict file written by a live `kiss-sign verify`: every input the verdict used and every request sent to Alchemy and drpc, with each provider's answer (`answers` for a JSON-RPC result, `errors` for a JSON-RPC error, `statuses` for an HTTP status without either). Its `commit` is the origin/main commit of the clone it ran from.

The tests set up a clone and a `$KISS_SIGN_HOME` from its inputs, run `verify` with every provider answer served from the file, and require `MATCH` with the hashes the Safe gave in `safe-tx/morpho-vault-deposit.json`. A copy with its receiver changed must give `MISMATCH`. `replay` must reproduce the verdict without opening a socket.

| File | Transaction | Verdict |
| --- | --- | --- |
| `morpho-vault-deposit.json` | `safe-tx/morpho-vault-deposit.json`, executed, judged by its receipt | `MATCH`, safeTxHash `0x0287ff5583b9bda9564e871c98d292c1a5b433cba905b02df369bab37b20c84a` |

### Recording again

```sh
export KISS_SIGN_HOME=$HOME/.kiss-sign-lane-8
bin/kiss-sign init --safe 0xAF177c57e369bBD30F47745DbAAF1D225f4B74D0
bin/kiss-sign template approve morpho/vault-deposit
echo '{"operations":[{"template":"morpho/vault-deposit","values":{"vault":"steakhouse-prime-usdc","amount":"1800000000180"}}]}' > card.json
bin/kiss-sign card seal card.json
ALCHEMY_API_KEY=$(sed -n 's/^ALCHEMY_API_KEY=//p' ~/.kiss-sign/.env) \
  bin/kiss-sign verify --card <sealed hash> --safe-tx-hash 0x0287ff5583b9bda9564e871c98d292c1a5b433cba905b02df369bab37b20c84a
cp "$KISS_SIGN_HOME"/verdicts/0x0287ff55*.json testdata/verify/morpho-vault-deposit.json
```

Run it from a clean clone at origin/main, or the self-check stops it.

## Safe history

`history/<name>.jsonl` holds executed transactions of one Safe, one Transaction Service record per line, as `pnpm history fetch` wrote them for that Safe. The tests set up a home for that Safe, write its intents, cards and notes, run `pnpm history` with the chain answers of `verify/morpho-vault-deposit.json`, and require the rows a reader sees.

| File | Safe | Nonce | What it does | Row it gives |
| --- | --- | --- | --- | --- |
| `morpho-safe.jsonl` | `0xAF177c57e369bBD30F47745DbAAF1D225f4B74D0` | 248 | USDT `transfer` | `no-card-yet` |
| | | 249 | The Morpho deposit of `safe-tx/morpho-vault-deposit.json` | `MATCH` with its card |
| | | 338 | MultiSend: `approve` of 2^256-1 vault shares, then a call to another contract | `refused-by-design: unlimited-approval` |
| `cow-safe.jsonl` | `0xc6835323372A4393B90bCc227c58e82D45CE4b7d` | 559 | MultiSend: `approve` of 2^256-1 to the CoW vault relayer, then `GPv2Settlement.setPreSignature` | `cow-next-phase`, the floor also refusing the approval |

The CoW Safe was found among the owners of `PreSignature` events on GPv2Settlement (`0x9008D19f58AAbD9eD0D60971565AA8510560ab41`), listed with Etherscan's `getLogs`.

### Recording again

```sh
for pair in 0xAF177c57e369bBD30F47745DbAAF1D225f4B74D0:morpho-safe:248,249,338 \
            0xc6835323372A4393B90bCc227c58e82D45CE4b7d:cow-safe:559; do
  IFS=: read safe name nonces <<< "$pair"
  export KISS_SIGN_HOME=$(mktemp -d)
  bin/kiss-sign init --safe "$safe"
  pnpm history fetch
  node -e 'const [file, nonces] = process.argv.slice(1); const want = nonces.split(",");
    const lines = require("fs").readFileSync(file, "utf8").trim().split("\n").filter((l) => { const r = JSON.parse(l); return r.isExecuted && want.includes(String(r.nonce)); });
    process.stdout.write(lines.join("\n") + "\n")' "$KISS_SIGN_HOME/history/txs.jsonl" "$nonces" > "testdata/history/$name.jsonl"
done
```
