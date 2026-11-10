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

| `eth-transfer-first-nonce.json` | `0xc6835323372A4393B90bCc227c58e82D45CE4b7d`, Safe 1.3.0 | 0 | `0x2f9764a54bb09d0c2a1d6fed863c3a22f66d62653f8abf970b9a70eb3d016403`, block 21,945,833 | A plain transfer of 0.001 ETH to `0x5904BfE5D9d96b57c98AaA935337e7Aa228ed528`. safeTxHash `0x5a90cb9c3ae0e4568a9572993c2c6eeefcb5f6c2b77659492ad2332f73205dbc` |
| `erc20-transfer-usdc.json` | `0xAF177c57e369bBD30F47745DbAAF1D225f4B74D0`, Safe 1.4.1 | 381 | `0x43cb0d45dad743686fbdef88a0097c58fda9f5ec5af5815edc4fc32426c0aa75`, block 26,381,847 | USDC `transfer` of 4,000,000.001000 USDC to `0xc748543C7832B39B841AE0b151E9ea53d6B0ADe3`. safeTxHash `0x5da4666bcaac9ee9e596762e220ffa6407a6da604ea91764bee1d5796810282c` |
| `erc20-transfer-usdt.json` | `0xAF177c57e369bBD30F47745DbAAF1D225f4B74D0`, Safe 1.4.1 | 382 | `0x1bbc644eaa007b97bdd856b8dc00ae461f7f50559df52a192ede7e9aed64b62e`, block 26,383,663 | USDT `transfer` of 535,223.428311 USDT to `0xc748543C7832B39B841AE0b151E9ea53d6B0ADe3`. safeTxHash `0xd1ee22c940b88f931b6b5cc65bb9eaef9d6eb6a22ea7e88f4bc9105261f21217` |
| `erc20-transfer-usdc-other-safe.json` | `0x9467dcFD4519287e3878C018c02f5670465a9003`, Safe 1.3.0 | 60 | `0xe9ba079b7cfffbe9fd942ea4701de2ce23d7bb709e0f34b29d9adbbc94a79ae1`, block 15,076,804 | USDC `transfer` of 841,909.711357 USDC to `0x519b70055af55A007110B4Ff99b0eA33071c720a`. safeTxHash `0x38a7c6944a1f2b35c595028a2bc6e3186def412c2a910117fc40f859c0567379` |
| `safe-cancel.json` | `0x9467dcFD4519287e3878C018c02f5670465a9003`, Safe 1.3.0 | 87 | `0x274ee22454c05f8ee8128de656ef76ba580901d9791c73076cc71d9889b96285`, block 16,185,376 | A cancellation: 0 ETH to the Safe itself, no data. safeTxHash `0x85b2e62e2fe9b9000331e9c2ebee7102af5968ad77fbcb800cf64eca68984825` |
| `morpho-deposit-metamorpho-1-0.json` | `0xE09b7fC43b3De7dba9CF634489D092FF0C99b753`, Safe 1.3.0 | 26 | `0xc51e8ea1847876e92e9c35e923006bd48df21a95f9ceb15762457b53fd8b286e`, block 22,922,634 | MultiSendCallOnly: USDC `approve` of 1,464,958.248813 USDC to GeneralAdapter1, then `Bundler3.multicall` depositing it into Smokehouse USDC (`0xBEeFFF209270748ddd194831b3fa287a5386f5bC`, MetaMorpho V1.0). safeTxHash `0xb676c4016bcd69b8541d83e079e22bb55187754c4fd0cfa3cb7634d4b3003eff` |
| `morpho-deposit-metamorpho-1-0-other-safe.json` | `0x07a28a8482e4c6f00520d571B8114c69ad44e71B`, Safe 1.3.0 | 564 | `0xc512da588015a75c0ea149153c595e0984af124ad9ae9f94c1031f1e88ffbcd5`, block 22,923,487 | The same shape, 200,000 USDC into Smokehouse USDC. safeTxHash `0x8c0aa7a579c9d25e8cf470f456e78fedda256364769492d099cde6a5e5f586f0` |
| `morpho-deposit-approve-trailer.json` | `0xaD62cE48D82d7Cb6F584FC2ecE5Ce1C7349F2cbA`, Safe 1.4.1 | 21 | `0x01d697f39a1c0c379885079f9fab20793b09f6e68c4d35bcdd8c0ae4b0e87fe1`, block 23,781,596 | The same shape, 20,000 USDC into Hyperithm USDC Apex (`0x777791C4d6DC2CE140D00D2828a7C93503c67777`, MetaMorpho V1.1), with the Morpho app's 8-byte trailer after both `approve` and `multicall`. safeTxHash `0x91d42376db4eb73419ba4731a46cba44679a5cd67a1139d209911faf26ac582c` |
| `morpho-deposit-approve-trailer-other-safe.json` | `0x4F6981AD898c3296C0FFC5afd44Af4281f7ebF9B`, Safe 1.4.1 | 20 | `0x052f3e223514e96cb18fc1ae346fafa113083506b63640dea71af39a8a6c7116`, block 23,787,520 | The same shape as the one above, 10,001 USDC into Hyperithm USDC Apex. safeTxHash `0xda44113d1fa93aa491fd93713d7aaa0ea34ceb28414cbe4ee1d32d796c1342f3` |
| `morpho-withdraw-apex.json` | `0xB67fE25C95177B90d895bB8d31C3587Dc8C22C35`, Safe 1.4.1 | 132 | `0x365322f8431ca07fd2c732c414ad292dee896f2f1e13846192dde2c30827d115`, block 23,726,256 | MultiSendCallOnly: Hyperithm USDC Apex `approve` of shares to GeneralAdapter1, then `Bundler3.multicall` running `erc4626Withdraw` of 583,913.520554 USDC to the Safe. safeTxHash `0xf3935e1dc593373507c9af2b480acc8b9ac6ca50ac76061a873a4ef7d10a213b` |
| `morpho-withdraw-apex-other-safe.json` | `0xCecd97DAF0B5a8A4E870C17ef825c8EBd602B2B8`, Safe 1.4.1 | 8 | `0x95c2e3259bac686232ab91243dd19299d34c1872304b0dea02c247212d76f00e`, block 23,726,458 | The same shape, 300,000 USDC from Hyperithm USDC Apex. safeTxHash `0x8d47c4a4f35a5ed92e57902348c9831461698cc3dbd90ec785b7a1a1fa1f3588` |
| `morpho-withdraw-all-apex.json` | `0xc9442e6eeCD5389D73322e965cD3fa488aaEee20`, Safe 1.3.0 | 204 | `0xb1356054ce34880681dd5239a57b37f3f7187fcc2dc0deefce6b5baa1f8f73dc`, block 23,723,151 | The same shape with `erc4626Redeem` of all the Safe's Hyperithm USDC Apex shares. safeTxHash `0xca605eaeafc5d3a21f4f27087ebd62e49a5f175ff0586303d2eea6693a71aaf6` |
| `morpho-withdraw-all-apex-other-safe.json` | `0x05Adc626f1B382af90EC14F0017c904f511CC072`, Safe 1.3.0 | 26 | `0xef206e5b4bfe20821532f082ffd22ba8b51cfd7ecad91052b36a8360117a6d47`, block 23,725,211 | The same, from another Safe. safeTxHash `0xfbf37b6ff4861f5b721f40a0da485798fb18e2d89dc0bfb89e3c91aa7151fba7` |
| `morpho-withdraw-two-vaults-all.json` | `0xdD0B39F6962d2AF180c841E0C24D7007C9E14c3F`, Safe 1.3.0 | 55 | `0xbb98496f0cbcd741b5fbe472af6ad322c2a96cc2b9a151fae0b3de22f65edf25`, block 23,446,538 | Share approvals of Smokehouse USDC and Usual Boosted USDC (`0xd63070114470f685b75B74D60EEc7c1113d33a3D`), then one `multicall` redeeming all of each. safeTxHash `0xcf3ecdec3e597f25de2da28cf31b9efd800ef0f3439972730a608e6bf63650cc` |
| `morpho-withdraw-two-vaults.json` | `0xbefdfEF6930aFE3b6c7Be985C6bAf778ea6ec215`, Safe 1.4.1 | 156 | `0xd7a9ff58f84e66a30f798956b157b9e7697e59b4fa7ccfcd0760d8472d79af24`, block 23,340,731 | The same two approvals, then one `multicall` redeeming all of Smokehouse USDC and withdrawing 154,000 USDC from Usual Boosted USDC. safeTxHash `0xb45eb79f6b3a1c2cb3164b15670ae5543117ca564873dd217e13a90a863d5e33` |
| `morpho-bundles-deposit.json` | `0x00CAfbC21F9AcfA6084d584D12f9c46eAcFE00CA`, Safe 1.4.1 | 48 | `0xeeb38080eecaecbedf9f0e08f8cbf8ddf454930e38b3012c7203e221c4af1ea4`, block 26,282,671 | MultiSendCallOnly: USDC `approve` of 31,583.325527 USDC to VaultBundlesV1 (`0x02912516d49dE997db75B9D7858faAE59209650B`), then `vaultBundlesV1Deposit` of it into Steakhouse Prime USDC, with an 8-byte trailer. safeTxHash `0xe1ae687dc96aa54128f515735204350f9bd7c0b4fb27ef0d224854901f98f5e1` |
| `morpho-bundles-deposit-two-tags.json` | `0xAF177c57e369bBD30F47745DbAAF1D225f4B74D0`, Safe 1.4.1 | 310 | `0x56e409df60195e32afea9d737a1ec70cbbaea4d22351d65e4177dd4b84c5d943`, block 26,211,057 | The same shape, 2,700,000 USDC, with a 12-byte trailer: a timestamp and two origin tags. safeTxHash `0x3fd5122233648e6d993f634406de153ddb8f7087f635d90faecf8ccb08354ab4` |
| `safe-cancel-other-safe.json` | `0xc6835323372A4393B90bCc227c58e82D45CE4b7d`, Safe 1.3.0 | 494 | `0xcb12862fa3c1a0bc7fa0896c82f35f526caeca215e2c036487ea65a943308a9c`, block 24,764,855 | A cancellation: 0 ETH to the Safe itself, no data. safeTxHash `0x337099c7c1850697c2e85f2fbcf9e5fd5d45ff4207c0d0ea2ceb6aa5a43528dd` |
| `fluid-deposit-usdt.json` | `0xF4AE94450BEaaDdb8fA4059D68BbB7DE7E2DF980`, Safe 1.4.1 | 152 | `0xbf3f89984eae08bd1c73628d5777815592ed85a339223a2517f380a2bf91c801`, block 26,304,863 | A `delegatecall` to MultiSendCallOnly 1.4.1 (`0x9641d764fc13c8B624c04430C7356C1C7C8102e2`) with two calls: USDT `approve` of 51,175.230820 USDT to fUSDT (`0x5C20B550819128074FD538Edf79791733ccEdd18`), then fUSDT `deposit` of that amount, shares to the Safe. safeTxHash `0x6743c8c0c46c13480a551c41b13ff21ea38775e593a3f9c055ce029ee62a8f2f` |
| `fluid-deposit-usdc.json` | `0xF4AE94450BEaaDdb8fA4059D68BbB7DE7E2DF980`, Safe 1.3.0 | 123 | `0xd24b81ce3d776642c935d61121b8baa831c5721d72b7bf74e47be2fa6f10c5f7`, block 24,259,957 | A `delegatecall` to MultiSendCallOnly 1.3.0 (`0x40A2aCCbd92BCA938b02010E17A5b8929b49130D`) with two calls: USDC `approve` of 244.093807 USDC to fUSDC (`0x9Fb7b4477576Fe5B32be4C1843aFB1e55F251B33`), then fUSDC `deposit` of that amount, shares to the Safe. safeTxHash `0x743c6fad5695f523cd391b7abf5a1de313c4921a560c50f0fb2a8335293598d9` |
| `fluid-withdraw-usdc.json` | `0xF4AE94450BEaaDdb8fA4059D68BbB7DE7E2DF980`, Safe 1.3.0 | 124 | `0x447871e549197550f00e6200bd592b980320102cc3094d9afd23dfb98cf431c9`, block 24,314,110 | fUSDC `withdraw` of 7,000 USDC, receiver and owner the Safe. safeTxHash `0x7259b1a33c1a6faecb7db666794f66c4ab1556f2cf65e1fbf16b956571d98637` |
| `fluid-redeem-usdt.json` | `0xF4AE94450BEaaDdb8fA4059D68BbB7DE7E2DF980`, Safe 1.3.0 | 113 | `0xd47e6d224e0db78ba69aa5ddc9a84e8054160b74344e98ce1fae9d3b58f7ab72`, block 23,941,366 | fUSDT `redeem` of 81,438.499490 shares, receiver and owner the Safe. safeTxHash `0xdda5d38fd5618cbd1227a2667ef0d2fea2425d2ccdc7a221dabf0b6b8c946d7f` |
| `fluid-deposit-usdt-other-safe.json` | `0x93BD8C5eb0eAB5BE7BfE156Ebfa0887AE7Dd0CEb`, Safe 1.4.1 | 13 | `0xf2686312095ff097f3c073df138c7057954f7089185ffa2bbbe23272dc65a19f`, block 26,021,409 | A `delegatecall` to MultiSendCallOnly 1.4.1 (`0x9641d764fc13c8B624c04430C7356C1C7C8102e2`) with two calls: USDT `approve` of 150,003.888850 USDT to fUSDT, then fUSDT `deposit` of that amount, shares to the Safe. safeTxHash `0x08e24eed62490209a17956478009d40152551596d3a48f26f37dd00a9a93ce85` |
| `fluid-withdraw-usdt-other-safe.json` | `0x93BD8C5eb0eAB5BE7BfE156Ebfa0887AE7Dd0CEb`, Safe 1.4.1 | 35 | `0x4c42906326a59fd538a0996736c8f972aeca1e2245ec897a60ae909ee1fa3cd9`, block 26,251,020 | fUSDT `withdraw` of 35,000 USDT, receiver and owner the Safe. safeTxHash `0x2f735f680c1885472d27d830e5c3cd1bec7e0822a2b42203c98f89fad6a2d8f1` |
| `fluid-redeem-usdt-other-safe.json` | `0x93BD8C5eb0eAB5BE7BfE156Ebfa0887AE7Dd0CEb`, Safe 1.4.1 | 44 | `0x00c4f712173dc316bebbfb1f8e58eaeba28ea07e820b413249d355dddb5364ca`, block 26,301,256 | fUSDT `redeem` of 36,705.111256 shares, receiver and owner the Safe. safeTxHash `0x271b00f749f54eea2d88b3f1ffecc1855ed9a67049d7ad90eb759af24688a051` |
| `fluid-claim.json` | `0x45169639f92b253958f2d5FBD787459fEF8EaE80`, Safe 1.3.0 | 151 | `0x59ea25801f6ff8891694b0249a9bab7a96a385c7b2b451c371c3097feacdd3d7`, block 22,609,103 | FluidMerkleDistributor (`0x7060FE0Dd3E31be01EFAc6B28C8D38018fD163B0`) `claim` of FLUID, recipient the Safe. safeTxHash `0xafecdb40477981d108b21b0c4ff29afc9e5db19a2922bbeece7984fd21afc00b` |
| `fluid-claim-other-safe.json` | `0x176f7558571865799bdb56FBFdABF37447227977`, Safe 1.3.0 | 40 | `0xaef8ff6374793e1ed3c9ebdeadd6c369d66d829f5a203d8bb616cd74552f593c`, block 22,652,493 | The same direct `claim`, from another Safe. safeTxHash `0xdf39adb096405aeed4a53c8b5bcad84dad68472f0c3041e6ac0d54bc8679a060` |
| `fluid-claim-two.json` | `0xCE49F4DEC84C3e44A560b39f1A5d8111ae67683F`, Safe 1.4.1 | 14 | `0x874dc6b6dc42c7232d306fccf44f0fdaa0916a192fb500bc6d0271c498e930bd`, block 23,021,539 | A `delegatecall` to MultiSendCallOnly 1.4.1 with two FluidMerkleDistributor `claim`s, each for one position, recipient the Safe. safeTxHash `0xd49c10037dbbe73c266c33cfb85cc54d674a0bc70d7f0a18e097b67c471f00d1` |
| `merkl-claim.json` | `0x79beA6B85433BFa83324991AeBA1C7d05ADBA18f`, Safe 1.4.1 | 86 | `0xf5e51feae82ed02372dde6d38307d6b7111b2dd3644bdb9a471620d875439292`, block 24,029,026 | Merkl Distributor (`0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae`) `claim` of MORPHO, user the Safe. safeTxHash `0x1ae88c7973a32b8e02925de883a3ad0f81294d4d2ee77d73d94f96fec44e5a05` |
| `merkl-claim-other-safe.json` | `0x86aa8cbd3752104Ed4Da624be502a3b192239Cd6`, Safe 1.3.0 | 470 | `0x53fec1eb454d8a84c38a56356f616a6f2226b3ad2f71baf3b7b1b6298137f882`, block 24,032,055 | The same direct `claim` of MORPHO, from another Safe. safeTxHash `0xbccbbfc0c11f9e7cc0daced69e996c2a979d6f26f9b96834c0540632c7950e5e` |
| `merkl-claim-two-tokens.json` | `0x7A4c2448EeB7A0BC297eD47C332d1a528b5A29bC`, Safe 1.3.0 | 693 | `0xb307157df56d5e51b9ca25b28646190970254a2f3db050e3937657e73b9455f9`, block 24,020,632 | One Merkl `claim` of USDC and MORPHO, two items in each of its four arrays. safeTxHash `0x1b1774a52d845dce2ea6faac3ab5dd01747adda3af6838dde7f4f4107abdd59a` |
| `merkl-claim-three-tokens.json` | `0x9260C9D6f93ABD3b288C86a58bd46088099097A3`, Safe 1.3.0 | 70 | `0x06cded3c3888831a929a95d766a429b71cb33efddb3cc21c90efa7815ff89380`, block 24,020,899 | One Merkl `claim` of MORPHO, aEthUSDe and FXN, three items in each array. safeTxHash `0xe5a8d1f6d4593e703e69a57f3b61ad669446d058699d83ce071473f269a5d8d3` |
| `morpho-urd-claim.json` | `0xDf95bb71581B224BD42eB19ceaff5E92816e181E`, Safe 1.4.1 | 40 | `0xc40b144c77500ef495717be260db8fb877692e1baa439352ce9e67e0af6e297e`, block 22,819,152 | Bundler3 `multicall` with one item: the Morpho URD (`0x330eefa8a787552DC5cAd3C3cA644844B1E61Ddb`) `claim` of MORPHO for the Safe, with the Morpho app's 8-byte trailer. safeTxHash `0x5001bd84a4a5d9daa0d42fb7148b5da12c0343cdaa0ff046c449efec4b020104` |
| `merkl-and-morpho-urd-claim.json` | `0x1c7766189b90da61BE1a7e6462E9f81eC795E40E`, Safe 1.4.1 | 7 | `0x657ac61e1f43c2b79dd504b49d0fe19dd6d6e2be32c3f2815addd5b0484547bc`, block 22,815,761 | A `delegatecall` to MultiSendCallOnly 1.4.1: a Merkl `claim` of aEthRLUSD, then a Bundler3 `multicall` claiming MORPHO from the Morpho URD. safeTxHash `0x2f85529efdd3b1fbbde890735c5cd4f81b3c4088795994b881a4ffcb872022f3` |
| `cctp-receive-then-call.json` | `0x8a25A24EDE9482C4Fc0738F99611BE58F1c839AB`, Safe 1.4.1 | 48142 | `0xdd09c9b162d956d128a51a49cb3988789358d52560c0339021afdc05b00ff716`, block 24,800,869 | A `delegatecall` to MultiSend 1.4.1: CCTP V1 MessageTransmitter (`0x0a992d191DEeC32aFe36203Ad87D7d289a738F81`) `receiveMessage` of a message that mints USDC to another address, then a call to another contract. safeTxHash `0xaffef7919a235fa81f6ddfcd5b140eb0a56f618b47d17a124fc95fa9735f002c` |

The claim fixtures were found with `pnpm past-txs` on transfers of the reward token out of its distributor (`--from`), the CCTP one on USDC mints; see each template's `report.md`. Each Safe's nonce is its `nonce()` at the block before. No Safe in the searched blocks received a CCTP message in a transaction of its own, so `cctp-receive-then-call` serves the CCTP tests twice: whole, and with its first call taken out as a direct call.

The four `morpho-deposit-*` fixtures were found with `pnpm past-txs morpho/vault-deposit` on vault share mints (see `templates/morpho/vault-deposit/report.md`); each Safe's nonce is its `nonce()` at the block before. The first Morpho deposit was found by listing token transfers into GeneralAdapter1 with Etherscan's `tokentx`, keeping senders whose `VERSION()` reads like a Safe, and looking each transaction up in the Safe Transaction Service by `transaction_hash`. The transfers and cancellations were found in the full executed histories of the Safes of the other fixtures, listed from the Safe Transaction Service. The Fluid fixtures come from two Safes that `pnpm past-txs fluid/vault-deposit` and `fluid/vault-withdraw` found, and from those Safes' histories in the Safe Transaction Service; the Fluid app is the origin of each. One Safe was upgraded from 1.3.0 to 1.4.1 between its nonces 124 and 152.

### Recording again

```sh
ALCHEMY_API_KEY=$(sed -n 's/^ALCHEMY_API_KEY=//p' ~/.kiss-sign/.env) \
  pnpm record-safe-tx morpho-vault-deposit 0xAF177c57e369bBD30F47745DbAAF1D225f4B74D0 249
ALCHEMY_API_KEY=$(sed -n 's/^ALCHEMY_API_KEY=//p' ~/.kiss-sign/.env) \
  pnpm record-safe-tx eth-transfer-null-data 0x9467dcFD4519287e3878C018c02f5670465a9003 107
export ALCHEMY_API_KEY=$(sed -n 's/^ALCHEMY_API_KEY=//p' ~/.kiss-sign/.env)
pnpm record-safe-tx eth-transfer-first-nonce 0xc6835323372A4393B90bCc227c58e82D45CE4b7d 0
pnpm record-safe-tx erc20-transfer-usdc 0xAF177c57e369bBD30F47745DbAAF1D225f4B74D0 381
pnpm record-safe-tx erc20-transfer-usdt 0xAF177c57e369bBD30F47745DbAAF1D225f4B74D0 382
pnpm record-safe-tx erc20-transfer-usdc-other-safe 0x9467dcFD4519287e3878C018c02f5670465a9003 60
pnpm record-safe-tx safe-cancel 0x9467dcFD4519287e3878C018c02f5670465a9003 87
pnpm record-safe-tx safe-cancel-other-safe 0xc6835323372A4393B90bCc227c58e82D45CE4b7d 494
pnpm record-safe-tx morpho-deposit-metamorpho-1-0 0xE09b7fC43b3De7dba9CF634489D092FF0C99b753 26
pnpm record-safe-tx morpho-deposit-metamorpho-1-0-other-safe 0x07a28a8482e4c6f00520d571B8114c69ad44e71B 564
pnpm record-safe-tx morpho-deposit-approve-trailer 0xaD62cE48D82d7Cb6F584FC2ecE5Ce1C7349F2cbA 21
pnpm record-safe-tx morpho-deposit-approve-trailer-other-safe 0x4F6981AD898c3296C0FFC5afd44Af4281f7ebF9B 20
pnpm record-safe-tx morpho-withdraw-apex 0xB67fE25C95177B90d895bB8d31C3587Dc8C22C35 132
pnpm record-safe-tx morpho-withdraw-apex-other-safe 0xCecd97DAF0B5a8A4E870C17ef825c8EBd602B2B8 8
pnpm record-safe-tx morpho-withdraw-all-apex 0xc9442e6eeCD5389D73322e965cD3fa488aaEee20 204
pnpm record-safe-tx morpho-withdraw-all-apex-other-safe 0x05Adc626f1B382af90EC14F0017c904f511CC072 26
pnpm record-safe-tx morpho-withdraw-two-vaults-all 0xdD0B39F6962d2AF180c841E0C24D7007C9E14c3F 55
pnpm record-safe-tx morpho-withdraw-two-vaults 0xbefdfEF6930aFE3b6c7Be985C6bAf778ea6ec215 156
pnpm record-safe-tx morpho-bundles-deposit 0x00CAfbC21F9AcfA6084d584D12f9c46eAcFE00CA 48
pnpm record-safe-tx morpho-bundles-deposit-two-tags 0xAF177c57e369bBD30F47745DbAAF1D225f4B74D0 310
pnpm record-safe-tx fluid-deposit-usdt 0xF4AE94450BEaaDdb8fA4059D68BbB7DE7E2DF980 152
pnpm record-safe-tx fluid-deposit-usdc 0xF4AE94450BEaaDdb8fA4059D68BbB7DE7E2DF980 123
pnpm record-safe-tx fluid-withdraw-usdc 0xF4AE94450BEaaDdb8fA4059D68BbB7DE7E2DF980 124
pnpm record-safe-tx fluid-redeem-usdt 0xF4AE94450BEaaDdb8fA4059D68BbB7DE7E2DF980 113
pnpm record-safe-tx fluid-deposit-usdt-other-safe 0x93BD8C5eb0eAB5BE7BfE156Ebfa0887AE7Dd0CEb 13
pnpm record-safe-tx fluid-withdraw-usdt-other-safe 0x93BD8C5eb0eAB5BE7BfE156Ebfa0887AE7Dd0CEb 35
pnpm record-safe-tx fluid-redeem-usdt-other-safe 0x93BD8C5eb0eAB5BE7BfE156Ebfa0887AE7Dd0CEb 44
```

The `morpho-withdraw-*` and `morpho-bundles-*` fixtures were found with `pnpm past-txs` on share burns and mints (see the reports of `morpho/vault-withdraw`, `morpho/vault-withdraw-all` and `morpho/vault-bundles-deposit`), and each transaction looked up in the Safe Transaction Service by `transaction_hash`.

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
| `morpho-vault-v2-apex.json` | Morpho Vault V2 Hyperithm USDC Apex `0x093272C07700d3cA5301C3Bf9B3A392624179E2F` | none | `VaultV2`, solc 0.8.28, 12 immutable spans masked. Sourcify's settings ask for an IPFS metadata hash, the code on chain carries none, so it is compiled without one |
| `metamorpho-v1-0-steakhouse-usdt.json` | MetaMorpho V1.0 Steakhouse USDT `0xbEef047a543E45807105E51A8BBEFCc5950fcfBa` | none | `MetaMorpho`, solc 0.8.21, 32 immutable spans masked |
| `metamorpho-v1-1-apex.json` | MetaMorpho V1.1 Hyperithm USDC Apex `0x777791C4d6DC2CE140D00D2828a7C93503c67777` | none | `MetaMorphoV1_1`, solc 0.8.26, 32 immutable spans masked |
| `vault-bundles-v1.json` | Morpho VaultBundlesV1 `0x02912516d49dE997db75B9D7858faAE59209650B` | none | `VaultBundlesV1`, solc 0.8.34 |
| `fluid-fusdc.json` | Fluid fUSDC `0x9Fb7b4477576Fe5B32be4C1843aFB1e55F251B33` | none | `fToken`, solc 0.8.21, 38 immutable spans masked |
| `fluid-fusdt.json` | Fluid fUSDT `0x5C20B550819128074FD538Edf79791733ccEdd18` | none | `fToken`, solc 0.8.21, 38 immutable spans masked |
| `fluid-rewards-distributor.json` | FluidMerkleDistributor "Fluid Rewards - Dec 2024" `0x7060FE0Dd3E31be01EFAc6B28C8D38018fD163B0` | none | `FluidMerkleDistributor`, solc 0.8.21, 2 immutable spans masked |
| `fluid-token.json` | FLUID token `0x6f40d4A6237C257fff2dB00FA0510DeEECd303eb` | none | `InstaToken`, solc 0.7.3 |
| `merkl-distributor.json` | Merkl Distributor `0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae` | EIP-1967 | `Distributor` at `0x33CC998Fd4AF3b6be42BaC9a67fe97e9e275d2aE`, solc 0.8.25, 5 immutable spans masked |
| `morpho-urd.json` | Morpho Universal Rewards Distributor `0x330eefa8a787552DC5cAd3C3cA644844B1E61Ddb` | none | `UniversalRewardsDistributor`, solc 0.8.19. Sourcify holds a partial match: every byte equals except the IPFS metadata hash, which is masked |
| `cctp-message-transmitter.json` | Circle CCTP V1 MessageTransmitter `0x0a992d191DEeC32aFe36203Ad87D7d289a738F81` | none | `MessageTransmitter`, solc 0.7.6, 7 immutable and 5 library spans masked. A partial match like `morpho-urd.json` |
| `safe-proxy-1-3-0.json` | the Safe of `safe-tx/eth-transfer-null-data.json`, `0x9467dcFD4519287e3878C018c02f5670465a9003` | Safe proxy (1.3.0 factory) | `GnosisSafeL2` at `0x3E5c63644E683549055b9Be8653de26E0B4CD36E`, solc 0.7.6 |

### Recording again

```sh
export ALCHEMY_API_KEY=$(sed -n 's/^ALCHEMY_API_KEY=//p' ~/.kiss-sign/.env)
pnpm fetch-solc
pnpm record-abi-case bundler3 0x6566194141eefa99Af43Bb5Aa71460Ca2Dc90245
pnpm record-abi-case general-adapter1 0x4A6c312ec70E8747a587EE860a0353cd42Be0aE0
pnpm record-abi-case morpho-token-eip1967 0x58D97B57BB95320F9a05dC918Aef65434969c2B2
pnpm record-abi-case safe-proxy-1-3-0 0x9467dcFD4519287e3878C018c02f5670465a9003
pnpm record-abi-case morpho-vault-v2-apex 0x093272C07700d3cA5301C3Bf9B3A392624179E2F
pnpm record-abi-case metamorpho-v1-0-steakhouse-usdt 0xbEef047a543E45807105E51A8BBEFCc5950fcfBa
pnpm record-abi-case metamorpho-v1-1-apex 0x777791C4d6DC2CE140D00D2828a7C93503c67777
pnpm record-abi-case vault-bundles-v1 0x02912516d49dE997db75B9D7858faAE59209650B
pnpm record-abi-case fluid-fusdc 0x9Fb7b4477576Fe5B32be4C1843aFB1e55F251B33
pnpm record-abi-case fluid-fusdt 0x5C20B550819128074FD538Edf79791733ccEdd18
pnpm record-abi-case fluid-rewards-distributor 0x7060FE0Dd3E31be01EFAc6B28C8D38018fD163B0
pnpm record-abi-case fluid-token 0x6f40d4A6237C257fff2dB00FA0510DeEECd303eb
pnpm record-abi-case merkl-distributor 0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae
pnpm record-abi-case morpho-urd 0x330eefa8a787552DC5cAd3C3cA644844B1E61Ddb
pnpm record-abi-case cctp-message-transmitter 0x0a992d191DEeC32aFe36203Ad87D7d289a738F81
```

An optional third argument records at that block instead of the latest.

## Simulations

`simulate/<name>.json` holds every JSON-RPC request one run of `scripts/simulate.ts` made for the Safe transaction `safe-tx/<name>.json`, with each provider's raw `result`:

- `executed` and `parent`: the block the transaction executed in, and the block the simulation sits on.
- `exchanges`: each request's `method` and `params`, and `answers` keyed by provider. Only requests both providers answered are kept.

The tests serve each provider its own recorded answer through the real reader, so parsing and agreement run as they do live. They simulate each transaction through `execTransaction` on the parent block, read its receipt and the Safe's ETH balance at the parent and execution blocks, and judge both against the card. The simulation also reads the Safe's singleton, threshold, owners, modules, guard and fallback handler just before and just after the transaction, and the floor rules require them unchanged.

| File | Parent block | What the Safe gave and got |
| --- | --- | --- |
| `eth-transfer-null-data.json` | 17,026,956 | −4.988797943068499801 ETH in the simulation and by the balance around the receipt; Safe settings unchanged |
| `morpho-vault-deposit.json` | 26,048,222 | −1,800,000.000180 USDC, +1,742,403.090147006731022214 Steakhouse Prime USDC shares, no ETH; the USDC allowance to GeneralAdapter1 is 0 before and after; singleton `0x41675C099F32341bf84BFc5382aF534df5C7461a`, 6 owners, threshold 2, no modules, no guard, all unchanged |
| `fluid-deposit-usdt.json` | 26,304,862 | −51,175.230820 USDT, +42,209.067384 fUSDT, no ETH; the USDT allowance to fUSDT is 0 before and after, though USDT's `approve` returns nothing; Safe settings unchanged |
| `fluid-withdraw-usdt-other-safe.json` | 26,251,019 | +35,000 USDT, −28,895.090944 fUSDT, no ETH; Safe settings unchanged |
| `fluid-redeem-usdt.json` | 23,941,365 | −81,438.499490 fUSDT, +95,466.865113 USDT, no ETH; Safe settings unchanged |
| `fluid-claim.json` | 22,609,102 | +58.037012247904058352 FLUID, no ETH; Safe settings unchanged |
| `merkl-claim.json` | 24,029,025 | +100.951036832327882581 MORPHO, no ETH; Safe settings unchanged |
| `morpho-urd-claim.json` | 22,819,151 | +3,824.546796543481634870 MORPHO, no ETH; Safe settings unchanged |

| `morpho-withdraw-all.json`, of `safe-tx/morpho-withdraw-all-apex-other-safe.json` | 23,725,210 | −23,966.697414743719468099 Hyperithm USDC Apex shares, all the Safe held, +25,175.574782 USDC; the share allowance to GeneralAdapter1 is 0 before and after |
| `morpho-withdraw-open-allowance.json`, of `safe-tx/morpho-withdraw-apex-other-safe.json` | 23,726,457 | −285,544.697740669157631830 Hyperithm USDC Apex shares, +300,000 USDC; the share allowance to GeneralAdapter1 goes from 4,850,840,670,525,793,065 to 40,963,643,267,656,996,464 |
| `morpho-withdraw-two-vaults-all.json` | 23,446,537 | −18,906.363414828162262882 Smokehouse USDC and −15,590.886101795651433674 Usual Boosted USDC shares, all of each, +37,568.419169 USDC; both share allowances 0 before and after |

### Recording again

```sh
export ALCHEMY_API_KEY=$(sed -n 's/^ALCHEMY_API_KEY=//p' ~/.kiss-sign/.env)
pnpm simulate morpho-withdraw-all-apex-other-safe --card '{"operations":[{"template":"morpho/vault-withdraw-all","values":{"vault":"hyperithm-usdc-apex-7777"}}]}' --record morpho-withdraw-all
pnpm simulate morpho-withdraw-apex-other-safe --card '{"operations":[{"template":"morpho/vault-withdraw","values":{"vault":"hyperithm-usdc-apex-7777","amount":"300000000000"}}]}' --record morpho-withdraw-open-allowance
pnpm simulate morpho-withdraw-two-vaults-all --card '{"operations":[{"template":"morpho/vault-withdraw-all","values":{"vault":"smokehouse-usdc"}},{"template":"morpho/vault-withdraw-all","values":{"vault":"usual-boosted-usdc"}}]}' --record morpho-withdraw-two-vaults-all
ALCHEMY_API_KEY=$(sed -n 's/^ALCHEMY_API_KEY=//p' ~/.kiss-sign/.env) pnpm simulate morpho-vault-deposit \
  --card '{"operations":[{"template":"morpho/vault-deposit","values":{"vault":"steakhouse-prime-usdc","amount":"1800000000180"}}]}' \
  --record morpho-vault-deposit
ALCHEMY_API_KEY=$(sed -n 's/^ALCHEMY_API_KEY=//p' ~/.kiss-sign/.env) pnpm simulate eth-transfer-null-data \
  --card '{"operations":[{"template":"eth/transfer","values":{"amount":"4988797943068499801","recipient":"recipient"}}]}' \
  --book '{"recipient":"0x4942fbdc53B295563d59Af51e6DDEdceba5E332f"}' --record eth-transfer-null-data
export ALCHEMY_API_KEY=$(sed -n 's/^ALCHEMY_API_KEY=//p' ~/.kiss-sign/.env)
pnpm simulate fluid-deposit-usdt --record fluid-deposit-usdt \
  --card '{"operations":[{"template":"fluid/vault-deposit","values":{"vault":"fluid-fusdt","amount":"51175230820"}}]}'
pnpm simulate fluid-withdraw-usdt-other-safe --record fluid-withdraw-usdt-other-safe \
  --card '{"operations":[{"template":"fluid/vault-withdraw","values":{"vault":"fluid-fusdt","amount":"35000000000"}}]}'
pnpm simulate fluid-redeem-usdt --record fluid-redeem-usdt \
  --card '{"operations":[{"template":"fluid/vault-redeem","values":{"vault":"fluid-fusdt","shares":"81438499490"}}]}'
pnpm simulate fluid-claim --record fluid-claim --card '{"operations":[{"template":"fluid/rewards-claim","values":{"token":"fluid"}}]}'
pnpm simulate merkl-claim --record merkl-claim --card '{"operations":[{"template":"merkl/claim","values":{"token":"morpho"}}]}'
pnpm simulate morpho-urd-claim --record morpho-urd-claim --card '{"operations":[{"template":"morpho/urd-claim","values":{"token":"morpho"}}]}'
```

## Past-transaction searches

`research/<name>.json` holds one run of `scripts/past-txs.ts --record <name>`:

- `query`: the template, the anchor token, the anchor kind, the sender when the search had one (`--from`), and the block range.
- `sources`: each request to Alchemy (`alchemy_getAssetTransfers`) and Etherscan (`logs/getLogs`), with its answer. No request holds a key.
- `providers` and `exchanges`: each `eth_getTransactionByHash` and `eth_getTransactionReceipt`, with the answers of Alchemy and drpc.

Before writing, the script drops every entry that mentions the configured Safe or one of its transactions, and refuses to write if any mention is left.

The tests replay the run and require the counts a reader sees: per source, per field, and per misfit reason. A Safe set as the configured Safe disappears from every count, and a transaction removed from one source's answer is marked as found by the other only.

| File | Anchor | Blocks | What it found |
| --- | --- | --- | --- |
| `morpho-vault-deposit.json` | Steakhouse Prime USDC shares minted | 26,044,000 to 26,052,000 | 65 transactions, all found by both sources; 3 executed by a Safe, 2 fitting `morpho/vault-deposit` |
| `merkl-claim.json` | MORPHO moved out of the Merkl Distributor | 24,020,000 to 24,030,000 | 120 transactions, all found by both sources; 3 executed by a Safe, 1 fitting `merkl/claim` |

### Recording again

```sh
KISS_SIGN_HOME=$HOME/.kiss-sign-lane-9 pnpm past-txs morpho/vault-deposit --token steakhouse-prime-usdc --anchor mint \
  --from-block 26044000 --to-block 26052000 --record morpho-vault-deposit
```

That home's `config.json` names the Safe of `safe-tx/morpho-vault-deposit.json`, so its deposit in this range is left out.

```sh
pnpm past-txs merkl/claim --token morpho --anchor any --from merkl-distributor --from-block 24020000 --to-block 24030000 --record merkl-claim
```

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
| | | 10 | `approve` of 8964319619782462544 base units of `0x365AccFCa291e7D3914637ABf1F7635dB165Bb09` to the CoW vault relayer | with a note naming 11 as its spender, `cow-next-phase` like 11 |
| | | 11 | `GPv2Settlement.setPreSignature` | `cow-next-phase` |
| | | 558 | `GPv2Settlement.invalidateOrder`, cancelling an order | `cow-next-phase` |

The CoW Safe was found among the owners of `PreSignature` events on GPv2Settlement (`0x9008D19f58AAbD9eD0D60971565AA8510560ab41`), listed with Etherscan's `getLogs`.

### Recording again

```sh
for pair in 0xAF177c57e369bBD30F47745DbAAF1D225f4B74D0:morpho-safe:248,249,338 \
            0xc6835323372A4393B90bCc227c58e82D45CE4b7d:cow-safe:10,11,558,559; do
  IFS=: read safe name nonces <<< "$pair"
  export KISS_SIGN_HOME=$(mktemp -d)
  bin/kiss-sign init --safe "$safe"
  pnpm history fetch
  node -e 'const [file, nonces] = process.argv.slice(1); const want = nonces.split(",");
    const lines = require("fs").readFileSync(file, "utf8").trim().split("\n").filter((l) => { const r = JSON.parse(l); return r.isExecuted && want.includes(String(r.nonce)); });
    process.stdout.write(lines.join("\n") + "\n")' "$KISS_SIGN_HOME/history/txs.jsonl" "$nonces" > "testdata/history/$name.jsonl"
done
```

## Attack replays

`attacks/<case>/` holds a real attack on a Safe whose signers were shown another transaction: `case.json` from the post-mortems, and `recording.json` from `pnpm attacks --record <case>`. [attacks/README.md](attacks/README.md) lists the cases, their sources, and what catches each.
