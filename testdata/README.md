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
