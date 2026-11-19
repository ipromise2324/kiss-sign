Part of [the kiss-sign design](../design.md).

## The independent check (hardened tier)

The hardened tier adds a computer that runs no AI and no kiss-sign.
It runs Foundry's `cast`, `curl`, `jq`, and one short script, `check.sh`, from a separate repository, `ipromise2324/kiss-sign-check`.
The script is kept apart from kiss-sign so that a change to kiss-sign, by a bug, an AI or a merged pull request, cannot change it.

**Set up once.**
The signer clones `kiss-sign-check` and runs `./check.sh init` with the Safe's address, its version and `LANGUAGE`, the language kiss-sign's `init` recorded (`en` unless the signer chose `zh-TW`).
No AI sets it up.

**Each signing.**
After the transaction is proposed and `verify` prints `MATCH`, the signer types on the independent computer the command `verify` prints, on its page and in the terminal: `./check.sh <nonce>`, followed by `--hints '<hints>'` when a template the card uses reads `bytes` that no ABI describes as `encoded` parameters or `packed` parts ([Hints](#hints)).
Only the nonce and those hints cross between the two computers; the Safe's address was set once.
The script:

1. fetches the transaction with that nonce from the Safe Transaction Service;
2. computes the domain hash, the message hash and the safeTxHash itself;
3. splits a MultiSend into its calls, and decodes again the calls nested in a Bundler3 `multicall`, in `multicall(bytes[])`, `submit(bytes)` and `revoke(bytes)`, and in Morpho's callback bundle, each with the ABI Sourcify gives for the contract it goes to;
4. checks each function name against the 4-byte selector of the call's data with `cast sig`;
5. decodes each call with `cast decode-calldata`;
6. shows the parts of each `bytes` value a hint reads, with a warning (see [Hints](#hints)).

The signer then compares the hashes with the hardware wallet's screen, and the 比對清單 on `check.sh`'s page with the one on `verify`'s page after `MATCH`, row by row, and the decoded calls with what they meant to do.
Several proposals can share one nonce, such as a transaction and its cancellation; the safeTxHash that matches the hardware wallet settles which one is signed.
`check.sh` writes one page per nonce, with each proposal's 比對清單 under its own heading.
Its title and header read `check.sh independent check · nonce <nonce>` in English and `獨立檢查 check.sh · nonce <nonce>` in Traditional Chinese, with a line saying it only decodes and does not judge.
All its own text, on the page and in the terminal, is in its `LANGUAGE`, which both name; only the block's two invisible markers, `<!-- 比對清單 -->` and its end, are the same in both.
`LANGUAGE` other than `en` or `zh-TW`, a trailing CR or a second line included, is refused.
Bytes after a call's arguments are a warning there, since a contract can still read them; the template, on kiss-sign's side, says how many it allows.
A `bytes` value of exactly 20 or 32 bytes that `check.sh` does not decode is a warning too, shown as the address it may be.
Each warning about a `bytes` argument or part it cannot read, or reads only through `--hints`, names the function and the contract and gives, as text, the contract's Etherscan source URL (and its implementation's, for a proxy), so the signer can look up how the contract reads those bytes.

| Check | What it catches |
|---|---|
| The transaction fetched by nonce, with its hashes computed on the independent computer | A kiss-sign that checked another transaction than the one the hardware wallet signs, or printed a wrong hash |
| MultiSend split into its calls | A call hidden in a batch that the card does not name |
| Each function name against its selector with `cast sig` | A call decoded under the wrong function |
| Each call decoded with `cast decode-calldata` | Arguments that differ from the card |

| Guaranteed | Not guaranteed |
|---|---|
| kiss-sign cannot make the signer sign something other than what the independent computer decodes. | That an address is the protocol's real contract. That stays on kiss-sign's checks and the report; `check.sh` names only the official MultiSends, the Safe and the zero address. |
| The hash math and which transaction is signed are checked without kiss-sign. | That the transaction does what the signer meant. Only kiss-sign compares the transaction with the card and simulates it. |
| | That every call is readable. A call nested inside another call's bytes is decoded only where step 3 names it, and only when Sourcify's ABI for its contract has its selector; any other is shown raw, loudly. |
| | That a hint reads `bytes` as the contract reads them. A hint only lets the independent computer show what it reads; it changes no row, and the bytes it reads keep a warning (see [Hints](#hints)). |

### Hints

Some `bytes` hold no call but data in a fixed shape that no contract's ABI describes: a Uniswap Universal Router command's input, a Morpho Vault V2 cap id, a market adapter's `allocate` data, a CoW order uid.
A template already says how it reads each one, with an `encoded` or a `packed` rule.
After `MATCH`, `verify` turns those rules, for the calls the transaction makes, into hints and prints the command for the independent computer with them, on its page above the 比對清單 and as the terminal's last line, so no one keeps a list of layouts on either computer.
`test/checklist.test.ts` pins the hints for each 比對清單 fixture in `testdata/checklist/hints/`, a copy of what `kiss-sign-check`'s tests run `check.sh` with.

The hints are one argument: `v1`, then one entry per `bytes` value, each after one space, `<path>=abi(<types>)` or `<path>=packed(<type>,...)`.
The path is the 比對清單 id of the call, `-a`, the argument's number, then `.<n>` for each step into an array's item, a tuple's component, or a part of a value an earlier entry reads, all counted from 1.
`abi` gives the parameter types the bytes are `abi.encode`d from, with no selector; `packed` gives the fixed-size types `abi.encodePacked` joined, each `address`, `bool`, `bytes1` to `bytes32`, `uint8` to `uint256` or `int8` to `int256`.
Types are canonical Solidity types, as `cast` takes them, never names.
For the Uniswap swap of the 比對清單 fixtures, whose Universal Router `execute` is call `C4`:

```
./check.sh 5 --hints 'v1 C4-a2.1=abi(bytes,bytes[]) C4-a2.1.2.1=abi((address,(address,uint24,int24,address,bytes)[],uint256[],uint128,uint128)) C4-a2.1.2.2=abi(address,uint256,bool) C4-a2.1.2.3=abi(address,address,uint256)'
```

`C4-a2.1` is the first input, a `V4_SWAP`; `C4-a2.1.2.1` to `.3` are its three actions, a swap, a settle and a take.
A Vault V2 cap submission gives `C1.1.1-a1=abi(string,address,(address,address,address,address,uint256))`, a Vault V2 reallocation `C1.1-a2=abi((address,address,address,address,uint256))`, and a CoW order `C1-a1=packed(bytes32,address,uint32)`.
The hints hold no name, text, address, URL or file path, only positions and types.
`check.sh` refuses, before it decodes anything or writes a page, hints in any other shape: another version, a character other than letters, digits, space, `(`, `)`, `[`, `]`, `,`, `.`, `=` and `-`, an empty or unknown type, an array size with no type before it, two tuples side by side, a `packed` type that is not fixed-size, or one path given twice.
Without `--hints` it runs as before, and each such value stays raw with its warning.

The hints come from the work computer, the one the hardened tier does not trust, so they can only help `check.sh` read; they cannot make the two computers agree on anything false:

- No 比對清單 row comes from a hint.
  `check.sh` writes every row from the transaction and Sourcify's ABI as without hints, and a `bytes` value a hint reads stays one row, folded with its keccak256.
  `kiss-sign-check`'s tests run every pinned fixture with kiss-sign's hints, with hostile hints and with none, and require the same 比對清單.
- A reading is shown only when its parts, encoded again with `cast abi-encode` (or `--packed`), give back exactly those bytes.
  Otherwise the value stays raw with its warning, and a second warning says why the hint did not fit.
- A reading that fits is still only the hint's.
  Any bytes whose length is a multiple of 32 also fit as that many `uint256`, a reading that would show a hidden call or address as numbers.
  So a value a hint reads keeps a warning in place of the one that says it cannot be decoded: its parts are shown as the hint reads them, checked to encode back, not checked to be what the contract reads.
  A hint can add lines to the full decode; it never changes a row, and it never leaves the bytes it reads without a warning.
  A `bytes` part no hint reads warns as before.
- An entry whose path names no `bytes` this transaction holds, or names bytes `check.sh` decodes as calls, is not used, and is a warning.

So a wrong or hostile hint shows the bytes raw with a warning, or a reading of them under a warning; the rows, the hashes and every other warning stay what `check.sh` finds on its own.


### The 比對清單

Both pages show the same block, the 比對清單, so the signer can lay them side by side.
For the same transaction, decoded the same way, the two programs write it byte for byte the same, except the name column.
`test/checklist.test.ts` compares kiss-sign's block for seven recorded transactions of other Safes, a Bundler3 deposit through MultiSend, an ETH transfer, a Merkl claim of two tokens, a CoW pre-signed order, a Uniswap swap through MultiSend with its two approvals, a Morpho Vault V2 cap submission and a Vault V2 reallocation, in each language, with the block `check.sh` writes for the same transaction in that language, `testdata/checklist/<language>/<fixture>.checklist.html`, a copy of `kiss-sign-check`'s `test/expected/<language>/` file, which that repository's tests pin against `check.sh`.
A change to either side's format fails one of the two tests until both change.

The block is one HTML line per line, between `<!-- 比對清單 -->` and `<!-- /比對清單 -->`, inside `<div class="cl">`.
A group line heads each call, `<div class="g"><span class="id">ID</span><span>TITLE</span></div>`.
Every other line is a row, `<div class="r"><span class="id">ID</span><span class="k">KEY</span><span class="v">VALUE</span><span class="nm">NAME</span></div>`.
ID is fixed text in every language.
KEY, each group's TITLE, the VALUE of an empty `-data` and the words of a folded VALUE are fixed text in the page's language, from the table below, which both programs carry word for word: kiss-sign's `language` from `init`, `check.sh`'s `LANGUAGE` in its `config`, `en` by default in both.
Two pages in different languages write these rows differently, so a signer whose two computers are set to different languages sees rows that differ and stops; each page names its language in one line above the block.
VALUE is the value to compare.
NAME is each program's own name for it, on kiss-sign's page in the signer's language: kiss-sign's registry or address book, `check.sh`'s names for the official MultiSends, the Safe and the zero address, or kiss-sign's note on a number the card bounds: its whole-token amount (`= 244.093807 usdc`), its percent (`= 5%`), or, for a share price bound, which bound it is.
It differs between the two by design, so the signer compares addresses, not names.
On kiss-sign's `-extra` row, NAME also states the template's rule as a program fact, such as `模板允許這個呼叫最多 12 bytes，這裡 8 bytes，在範圍內`, and the template's `trailer.why`, tagged AI as the signer's report tags AI text; VALUE stays the hex `check.sh` writes.

The lines, in order:

| ID | KEY | VALUE |
|---|---|---|
| group `tx`, 交易 | | |
| `tx-safeTxHash` | safeTxHash | the safeTxHash |
| `tx-domain` | domain hash | the domain hash (the EIP-712 domain separator) |
| `tx-message` | message hash | the message hash |
| `tx-nonce` | nonce | the nonce |
| the lines of call `C1`, the Safe transaction itself | | |
| group `end`, 總計 | | |
| `end-count` | Safe 發出的呼叫數 | how many calls the Safe makes |

The fixed words, in each language (the lines above name the Traditional Chinese ones):

| Where | `en` | `zh-TW` |
|---|---|---|
| group `tx` | `Transaction` | `交易` |
| group of call N | `Call #N` | `呼叫 #N` |
| group of Bundler3 call i of n | `Bundler3 call i/n` | `Bundler3 呼叫 i/n` |
| group of a call in a `bytes` argument | `Inner call` | `內含的呼叫` |
| group `end` | `Total` | `總計` |
| KEY of `-value` | `value (wei)` | `value（wei）` |
| KEY of `-fn` | `function` | `函式` |
| KEY of `-a<N>` | `argument N` | `引數 N` |
| KEY of `-extra` | `bytes after the arguments` | `引數後多出的 bytes` |
| KEY of `end-count` | `calls the Safe makes` | `Safe 發出的呼叫數` |
| VALUE of an empty `-data` | `none` | `無` |
| folded hex | `<n> bytes, keccak256 <hash>` | `<n> bytes，keccak256 <hash>` |
| folded text | `<n> characters, keccak256 <hash>` | `<n> 字元，keccak256 <hash>` |

The other KEYs, `safeTxHash`, `domain hash`, `message hash`, `nonce`, `to`, `operation` and `data`, and the VALUEs `0 CALL` and `1 DELEGATECALL`, are the same in both.

A call the Safe makes is numbered as `check.sh` numbers it: `C1` is the Safe transaction itself, and an official MultiSend's calls follow as `C2`, `C3` and on.
Its lines are a group titled `呼叫 #N`, then `<id>-to` (to, the address checksummed), `<id>-value` (value（wei）, an integer), `<id>-op` (operation, `0 CALL` or `1 DELEGATECALL`), then its data's lines.
A call inside another call's data takes its parent's id and its place among the parent's inner calls: `C3.1`, `C3.2`, and `C3.1.1` under `C3.1`.
A Bundler3 `multicall`'s calls are groups titled `Bundler3 呼叫 i/n`, each with `-to` and `-value` lines, then its data's lines.
A call nested in another `bytes` argument is a group titled `內含的呼叫`, with only its data's lines.

A call's data gives `<id>-data` (data, `無`) when it is empty, or `<id>-data` (data, the hex) when no function decodes it.
Otherwise `<id>-fn` (函式, the signature, a space and the selector), then `<id>-a1`, `<id>-a2` and on (引數 1, 引數 2, …), each argument as `cast decode-calldata` prints it, then `<id>-extra` (引數後多出的 bytes, the hex) when bytes follow the arguments, then the calls inside it.

Each VALUE, ID and NAME is first made visible: every character from U+0000 to U+001F, U+007F to U+009F, U+00AD, U+034F, U+061C, U+115F, U+1160, U+180E, U+200B to U+200F, U+2028 to U+202E, U+2060 to U+206F, U+3164, U+FE00 to U+FE0F, U+FEFF, U+FFA0, U+FFF9 to U+FFFB, U+E0000 to U+E007F and U+E0100 to U+E01EF becomes U+FFFD, so no control, bidi, zero-width, filler, tag or variation character can hide or reorder text; each value cell is also laid out left to right whatever letters it holds.
A NUL never reaches `check.sh`, since Bash cannot carry one.
A VALUE that is `0x` and an even number of hex digits longer than 32 bytes shows folded as its length in bytes and the keccak256 of the bytes; any other VALUE longer than 120 characters (Unicode code points) as its length in characters and the keccak256 of its UTF-8, each in the words of the table above.
Either way the full value follows, closed: `<details><summary>SUMMARY</summary><span class="full">VALUE</span></details>`.
Text is escaped as jq's `@html` escapes it from jq 1.7 on: `<`, `>`, `&`, `'` and `"` become `&lt;`, `&gt;`, `&amp;`, `&apos;` and `&quot;`.
`check.sh` refuses to run on a jq whose `@html` or `gsub` gives anything else.

Two decodes can still differ, and then the rows differ and the signer stops.
`check.sh` decodes the calls nested in `multicall(bytes[])`, `submit(bytes)` and `revoke(bytes)` whenever Sourcify's ABI has their selector, and kiss-sign only where the template says that argument holds a call; there `check.sh` shows more lines.
`check.sh` also decodes the bundle Morpho calls back with from `morphoSupplyCollateral`, which no kiss-sign template allows.
Where a template decodes a function Sourcify's ABI lacks, `check.sh` shows one `-data` row in place of kiss-sign's `-fn` and argument rows.
`check.sh` splits a MultiSend into the Safe's calls only when it is the Safe transaction itself, a DELEGATECALL to an official MultiSend, as kiss-sign does; any other `multiSend` is a warning, its calls not split.
A `string` argument holding a control, DEL, C1 or format character prints differently: `cast` writes `\u{1}` where kiss-sign's JSON quoting writes `\u0001` or the character itself.

`replay` writes no page and prints no 比對清單, and the verdict file does not hold them.
