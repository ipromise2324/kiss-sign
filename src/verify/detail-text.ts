import type { Language } from '../language.ts';

/**
 * A check's details are stored in English, the text `replay` compares. This shows one in Traditional Chinese when it
 * has one of the fixed shapes below: each pattern matches the whole detail, a value slot (`\S+`, an address) is shown
 * as it is, and every other slot must itself match a table further down. A detail, or a part of one, of no known shape
 * throws `UNKNOWN`, and the whole detail is shown as stored, never half translated.
 */
const UNKNOWN = Symbol('unknown detail shape');

type Shape = readonly [RegExp, (...parts: string[]) => string];

const ADDRESS = '0x[0-9a-fA-F]{40}';
/** A registry or address-book name with its address, such as `bundler3 0x6566...`. */
const NAMED = `\\S+ ${ADDRESS}`;
const BLOCK = 'at block (\\d+)';

const shape = (pattern: string, zh: Shape[1]): Shape => [new RegExp(`^${pattern}$`), zh];

function translate(shapes: readonly Shape[], text: string): string {
  for (const [pattern, zh] of shapes) {
    const parts = pattern.exec(text);
    if (parts !== null) return zh(...parts.slice(1));
  }
  throw UNKNOWN;
}

/** A value as the check printed it: a number, hex, an address, a bool, a function signature, or a JSON string. */
const VALUE: readonly Shape[] = [
  shape('(-?\\d+|0x[0-9a-fA-F]*|true|false|\\w+\\(\\S*\\))', (v) => v),
  shape('("(?:[^"\\\\]|\\\\.)*")', (v) => v),
];

/** How a decoding failed, as `unwrapSafeTx` and the codec name it. */
const DECODE: Readonly<Record<string, string>> = { malformed: '格式錯誤', 'non-canonical': '不是標準編碼', 'wrong-selector': 'selector 不對' };
const DECODE_KIND = `(${Object.keys(DECODE).join('|')})`;

const EXPECTED: readonly Shape[] = [
  shape('at (most|least) (\\S+): (\\d+) assets for (\\d+) shares, scaled by 1e(\\d+)', (bound, limit, assets, shares, scale) =>
    `${bound === 'most' ? '最多' : '至少'} ${limit === 'any' ? '任意值' : limit}：${assets} 資產換 ${shares} 份額，乘上 1e${scale}`,
  ),
  shape('a stated share count, not the whole balance \\(2\\^256-1\\), to bound the price against', () => '明確的份額數量，而不是整個餘額（2^256-1），用來限制價格'),
  shape('at least (\\S+)', (v) => `至少 ${v}`),
  shape('at most (\\S+)', (v) => `最多 ${v}`),
  shape('(\\S+), as at (\\S+)', (v, path) => `${v}，和 ${path} 的值相同`),
  shape(`the owner before (\\S+) (${ADDRESS}), who is not an owner of the Safe`, (name, address) => `${name} ${address} 的前一位 owner，但 ${name} ${address} 不是這個 Safe 的 owner`),
  shape('a uint', () => '一個 uint'),
  shape('(\\d+) bytes: ((?:\\w+ \\S+)(?:, \\w+ \\S+)*)', (size, layout) => `${size} 位元組：${layout}`),
  shape('0x00 or 0x01, as abi\\.encodePacked writes a bool', () => '0x00 或 0x01，即 abi.encodePacked 寫 bool 的方式'),
  shape('(\\d+) items', (n) => `${n} 項`),
  shape('(0x[0-9a-f]{8}) (\\S+)', (selector, signature) => `${selector} ${signature}`),
  shape('canonical (\\S+)', (signature) => `${signature} 的標準編碼`),
  shape('0 \\(call\\)', () => '0（call）'),
  shape('no data', () => '沒有資料'),
  shape('an official MultiSend for a delegatecall', () => '官方的 MultiSend（delegatecall 只能呼叫它）'),
  shape('no call', () => '沒有呼叫'),
  ...VALUE,
];

const ACTUAL: readonly Shape[] = [
  shape('differs at byte (\\d+)', (n) => `在第 ${n} 位元組不同`),
  shape('1 \\(delegatecall\\)', () => '1（delegatecall）'),
  shape('(\\d+) bytes', (n) => `${n} 位元組`),
  shape('(\\d+) items', (n) => `${n} 項`),
  shape(`a call to (${ADDRESS})`, (address) => `呼叫 ${address}`),
  shape('missing', () => '缺少'),
  shape(DECODE_KIND, (kind) => DECODE[kind] as string),
  ...VALUE,
];

const STATE_VALUE = '(\\[[^\\]]*\\]|\\S+)';

const FLOOR: readonly Shape[] = [
  shape('(\\S+) is (\\S+), must be zero', (name, value) => `${name} 是 ${value}，必須是零`),
  shape(`a delegatecall to (${ADDRESS}) inside the MultiSend`, (address) => `MultiSend 裡有對 ${address} 的 delegatecall`),
  shape(`a delegatecall to (${ADDRESS}), which is not an official MultiSend`, (address) => `對 ${address} 的 delegatecall，而它不是官方的 MultiSend`),
  shape(`the MultiSend data does not decode \\(${DECODE_KIND} at byte (\\d+)\\)`, (kind, at) => `MultiSend 的資料無法解碼（第 ${at} 位元組${DECODE[kind]}）`),
  shape('a call to the Safe itself with data \\(selector (0x[0-9a-f]{8})\\)', (selector) => `帶資料呼叫 Safe 自己（selector ${selector}）`),
  shape(`(\\S+) of token (${ADDRESS}) to spender (${ADDRESS}), amount (\\d+)`, (signature, token, spender, amount) => `代幣 ${token} 給 spender ${spender} 的 ${signature}，數量 ${amount}`),
  shape(`Permit2 allowance of token (${ADDRESS}) to spender (${ADDRESS}) for (\\d+)`, (token, spender, amount) => `代幣 ${token} 經 Permit2 給 spender ${spender} 的額度 ${amount}`),
  shape(`token (${ADDRESS}) approved spender (${ADDRESS}) for (\\d+)`, (token, spender, amount) => `代幣 ${token} 授權給 spender ${spender} 的額度 ${amount}`),
  shape(`(${ADDRESS}), to remove, is not an owner before the transaction`, (address) => `要移除的 ${address} 在交易前不是 owner`),
  shape(`(${ADDRESS}), to add, is an owner before the transaction already`, (address) => `要加入的 ${address} 在交易前已經是 owner`),
  shape(`(\\S+) stayed ${STATE_VALUE}(?:, not to ${STATE_VALUE})?`, (field, is, wanted) => `${field} 維持 ${is}${wanted === undefined ? '' : `，而不是變成 ${wanted}`}`),
  shape(`(\\S+) changed from ${STATE_VALUE} to ${STATE_VALUE}(?:, not to ${STATE_VALUE})?`, (field, was, is, wanted) =>
    `${field} 從 ${was} 變成 ${is}${wanted === undefined ? '' : `，而不是變成 ${wanted}`}`,
  ),
  shape('the Safe logged (\\S+), which the card does not declare', (event) => `Safe 發出了 ${event}，卡片沒有宣告這個變更`),
  shape('the Safe logged (\\S+)', (event) => `Safe 發出了 ${event}`),
  shape("the Safe's settings were not read in a simulation of the transaction alone", () => '只模擬這筆交易時沒有讀到 Safe 的設定'),
];

const REFUSAL: readonly Shape[] = [
  shape(`(${ADDRESS}) has no code`, (address) => `${address} 沒有程式碼`),
  shape(`the implementation (${ADDRESS}) is itself a proxy`, (address) => `實作 ${address} 本身也是 proxy`),
  shape('both the EIP-1967 implementation and beacon slots are set, so which code runs is unknown', () => 'EIP-1967 的 implementation 和 beacon 兩個 slot 都有設定，所以不知道會執行哪份程式碼'),
  shape('an EIP-1967 slot is set, but the code has no DELEGATECALL, so it does not run that implementation', () => '設定了 EIP-1967 slot，但程式碼沒有 DELEGATECALL，所以不會執行那個實作'),
  shape(`(${ADDRESS}) hands a call it has no function for, at byte (\\d+) of its code, to code the program neither proves nor pins`, (address, pc) =>
    `${address} 把沒有對應函式的呼叫（在它程式碼的第 ${pc} 位元組）交給程式既沒證明也沒釘選的程式碼`,
  ),
  shape('Multicall3 has no code at this block, so the routes cannot be read', () => 'Multicall3 在這個區塊沒有程式碼，所以讀不到轉送路徑'),
  shape('a Multicall3 batch of route reads reverted', () => '讀轉送路徑的 Multicall3 批次 revert 了'),
];

const ASSET: readonly Shape[] = [
  shape('ETH', () => 'ETH'),
  shape(`unregistered token (${ADDRESS})`, (address) => `未登記的代幣 ${address}`),
  shape(`(${NAMED})`, (named) => named),
];

const AMOUNT: readonly Shape[] = [
  shape('([+-][\\d,]+(?:\\.\\d+)?) \\(([+-]\\d+) base units\\)', (tokens, base) => `${tokens}（${base} 最小單位）`),
  shape('(0|[+-]\\d+)', (base) => base),
];

const WANT: readonly Shape[] = [
  shape('between (.+) and (.+)', (low, high) => `介於 ${translate(AMOUNT, low)} 和 ${translate(AMOUNT, high)} 之間`),
  shape('at least (.+)', (amount) => `至少 ${translate(AMOUNT, amount)}`),
  shape('more than (.+)', (amount) => `多於 ${translate(AMOUNT, amount)}`),
  shape('less than (.+)', (amount) => `少於 ${translate(AMOUNT, amount)}`),
  shape('(.+)', (amount) => translate(AMOUNT, amount)),
];

const READ_IN: Readonly<Record<string, string>> = { 'in a simulated block': '在模擬的區塊中', 'at the parent block and the execution block': '在父區塊和執行區塊' };
const VIEW_WANT: Readonly<Record<string, string>> = { increase: '增加', decrease: '減少', 'stay the same': '不變' };
const ALLOWANCE = '(\\d+) until (\\d+) \\(nonce (\\d+)\\)';
const allowance = (amount: string, until: string, nonce: string): string => `${amount}，到 ${until} 為止（nonce ${nonce}）`;

/** What the fields check said of a changed copy that it did not call a mismatch. */
const UNCAUGHT: Readonly<Record<string, string>> = { match: '欄位檢查仍然相符', unverifiable: '欄位檢查無法完成', 'not-mutable': '這個值無法在原處修改' };

const DETAIL: readonly Shape[] = [
  shape('(\\S+) (\\S+): expected (.+), got (.+)', (path, arg, expected, actual) => `${path} ${arg}：應為 ${translate(EXPECTED, expected)}，實際 ${translate(ACTUAL, actual)}`),
  shape('(\\S+) (\\S+): no (\\S+) read from (\\S+) hashes to (0x[0-9a-f]{64})', (path, arg, struct, url, digest) => `${path} ${arg}：從 ${url} 讀到的 ${struct} 沒有一個的 hash 是 ${digest}`),
  shape('(\\S+) hashes to (0x[0-9a-f]{64}), the approved hash is (0x[0-9a-f]{64})', (template, hash, approved) => `${template} 的 hash 是 ${hash}，你核准的是 ${approved}`),
  shape('(\\S+) was never approved; run (pnpm kiss-sign template approve \\S+)', (template, command) => `${template} 從未核准；執行 ${command}`),
  shape('(fee-fields|delegatecall|self-call|unlimited-approval|safe-state) at (\\S+): (.+)', (rule, path, detail) => `${rule} 在 ${path}：${translate(FLOOR, detail)}`),
  shape(`(${NAMED}) holds (${ADDRESS}) by its asset\\(\\) ${BLOCK}, the registry says (${NAMED})`, (vault, held, block, asset) => `${vault} 在區塊 ${block} 的 asset() 是 ${held}，登記表寫的是 ${asset}`),
  shape(`(${NAMED}) gave no asset\\(\\) ${BLOCK}`, (vault, block) => `${vault} 在區塊 ${block} 沒有回傳 asset()`),
  shape(`(${NAMED}) has no code pin in the registry; run (pnpm pin-code \\S+)`, (entry, command) => `${entry} 在登記表裡沒有程式碼釘選；執行 ${command}`),
  shape(`(${NAMED}) ${BLOCK}: the registry pins its code only from block (\\d+)`, (entry, block, from) => `${entry} 在區塊 ${block}：登記表只從區塊 ${from} 起釘選它的程式碼`),
  shape(`(${NAMED}) has code hash (0x[0-9a-f]{64}) ${BLOCK}, the registry pins (0x[0-9a-f]{64})`, (entry, hash, block, pin) => `${entry} 在區塊 ${block} 的程式碼 hash 是 ${hash}，登記表釘選的是 ${pin}`),
  shape(`(${NAMED}) no longer delegates to (${ADDRESS}) ${BLOCK}, the registry pins that implementation`, (entry, address, block) => `${entry} 在區塊 ${block} 不再委派給 ${address}，登記表釘選的是那個實作`),
  shape(`(${NAMED}) delegates to (${ADDRESS}) ${BLOCK}, the registry pins no implementation`, (entry, address, block) => `${entry} 在區塊 ${block} 委派給 ${address}，登記表沒有釘選任何實作`),
  shape(`(${NAMED}) delegates to (${ADDRESS}) ${BLOCK}, the registry pins (${ADDRESS})`, (entry, address, block, pin) => `${entry} 在區塊 ${block} 委派給 ${address}，登記表釘選的是 ${pin}`),
  shape(`(${NAMED})'s implementation (${ADDRESS}) has code hash (0x[0-9a-f]{64}) ${BLOCK}, the registry pins (0x[0-9a-f]{64})`, (entry, address, hash, block, pin) =>
    `${entry} 的實作 ${address} 在區塊 ${block} 的程式碼 hash 是 ${hash}，登記表釘選的是 ${pin}`,
  ),
  shape(`(${NAMED}) routes selectors to (${ADDRESS}) ${BLOCK}, an implementation the registry does not pin`, (entry, address, block) => `${entry} 在區塊 ${block} 把 selector 轉給 ${address}，登記表沒有釘選這個實作`),
  shape(`(${NAMED}) routes no seed to (${ADDRESS}) ${BLOCK}, an implementation the registry pins`, (entry, address, block) => `${entry} 在區塊 ${block} 沒有把任何 seed 轉給登記表釘選的實作 ${address}`),
  shape(`(${NAMED})'s routed implementation (${ADDRESS}) has code hash (0x[0-9a-f]{64}) ${BLOCK}, the registry pins (0x[0-9a-f]{64})`, (entry, address, hash, block, pin) =>
    `${entry} 轉送到的實作 ${address} 在區塊 ${block} 的程式碼 hash 是 ${hash}，登記表釘選的是 ${pin}`,
  ),
  shape(`(${NAMED})'s routed implementation (${ADDRESS}) serves ((?:0x[0-9a-f]{8})(?:, 0x[0-9a-f]{8})*) ${BLOCK}, which the registry does not pin`, (entry, address, selectors, block) =>
    `${entry} 轉送到的實作 ${address} 在區塊 ${block} 提供 ${selectors}，登記表沒有釘選這些`,
  ),
  shape(`(${NAMED})'s routed implementation (${ADDRESS}) no longer serves ((?:0x[0-9a-f]{8})(?:, 0x[0-9a-f]{8})*) ${BLOCK}, which the registry pins`, (entry, address, selectors, block) =>
    `${entry} 轉送到的實作 ${address} 在區塊 ${block} 不再提供登記表釘選的 ${selectors}`,
  ),
  shape(`(${NAMED})'s routed implementation (${ADDRESS}) lists the pinned selectors in another order ${BLOCK}`, (entry, address, block) => `${entry} 轉送到的實作 ${address} 在區塊 ${block} 列出釘選 selector 的順序不同`),
  shape(`(${NAMED}) ${BLOCK}: (.+)`, (entry, block, refusal) => `${entry} 在區塊 ${block}：${translate(REFUSAL, refusal)}`),
  shape('not run, because the fields did not match', () => '未執行，因為欄位不符'),
  shape('failed and gave no detail', () => '失敗，但沒有說明原因'),
  shape('could not finish and gave no detail', () => '無法完成，但沒有說明原因'),
  shape(`a change to (\\S+) (\\S+) gave (${Object.keys(UNCAUGHT).join('|')}), not a mismatch`, (path, arg, outcome) => `把 ${path} ${arg} 改成別的值，${UNCAUGHT[outcome]}，而不是不符`),
  shape('(.+) still held (\\d+) after the transaction, the card gives all of it', (asset, left) => `交易後 ${translate(ASSET, asset)} 還剩 ${left}，但卡片要全部給出`),
  shape(`approval raised and not spent in the same transaction: (.+) to (${ADDRESS}), (\\d+) before, (\\d+) after`, (token, spender, before, after) =>
    `授權額度提高了，卻沒在同一筆交易裡用掉：${translate(ASSET, token)} 給 ${spender}，之前 ${before}，之後 ${after}`,
  ),
  shape(`Permit2 allowance raised and not spent in the same transaction: (.+) to (${ADDRESS}), ${ALLOWANCE} before, ${ALLOWANCE} after`, (token, spender, a, u, n, a2, u2, n2) =>
    `Permit2 授權額度提高了，卻沒在同一筆交易裡用掉：${translate(ASSET, token)} 給 ${spender}，之前 ${allowance(a, u, n)}，之後 ${allowance(a2, u2, n2)}`,
  ),
  shape(`(ETH|${NAMED}|unregistered token ${ADDRESS}) (.+) (\\S+): (-?\\d+) before, (-?\\d+) after (${Object.keys(READ_IN).join('|')}); the template needs it to (${Object.keys(VIEW_WANT).join('|')}|be -?\\d+, as the card says)`, (to, call, value, before, after, readIn, want) => {
    const wanted = VIEW_WANT[want] ?? `等於卡片上的 ${want.slice('be '.length, -', as the card says'.length)}`;
    return `${translate(ASSET, to)} ${call} ${value}：交易前 ${before}，交易後 ${after}（${READ_IN[readIn]}讀取）；模板要求它${wanted}`;
  }),
  shape('(.+) changed by (.+), the card explains (.+)', (asset, actual, want) => `${translate(ASSET, asset)} 變動了 ${translate(AMOUNT, actual)}，卡片說明的是 ${translate(WANT, want)}`),
  shape('no value at (\\S+)', (path) => `${path} 沒有值`),
  shape('the registry has no (\\S+)', (name) => `登記表裡沒有 ${name}`),
  shape('no card amount (\\S+)', (field) => `卡片沒有數量 ${field}`),
  shape('card (\\S+) is not an address', (field) => `卡片的 ${field} 不是地址`),
];

/** A stored detail as the signer reads it in `language`: English as stored, Traditional Chinese for a known shape. */
export function detailText(detail: string, language: Language): string {
  if (language === 'en') return detail;
  try {
    return translate(DETAIL, detail);
  } catch (error) {
    if (error === UNKNOWN) return detail;
    throw error;
  }
}
