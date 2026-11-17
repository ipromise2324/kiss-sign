import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { checksumAddress } from '../safe/types.ts';
import type { Language } from '../language.ts';
import type { ArgNote, BundleCall, CallData, CallTree, Label, Labeled, SafeCall } from './expected.ts';

/** One line of the 比對清單, which check.sh writes line for line the same for the same transaction, except `name`. */
export type ChecklistLine =
  | { readonly kind: 'group'; readonly id: string; readonly title: string }
  | { readonly kind: 'row'; readonly id: string; readonly key: string; readonly value: string; readonly name: string; readonly ai?: string };

const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffb\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;
export const visible = (text: string): string => text.replace(INVISIBLE, '�');

/** jq's `@html`, which check.sh uses, so the two pages' bytes agree. */
const HTML: Readonly<Record<string, string>> = { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' };
const html = (text: string): string => text.replace(/[<>&'"]/g, (c) => HTML[c] as string);

/** The fixed words of the block, word for word those of check.sh's table for the same language, so the rows compare byte for byte. */
const ROW_WORDS = {
  en: {
    tx: 'Transaction',
    call: (n: number) => `Call #${n}`,
    bundle: (i: number, n: number) => `Bundler3 call ${i}/${n}`,
    inner: 'Inner call',
    end: 'Total',
    value: 'value (wei)',
    fn: 'function',
    arg: (n: number) => `argument ${n}`,
    extra: 'bytes after the arguments',
    count: 'calls the Safe makes',
    none: 'none',
    bytes: (n: number, hash: string) => `${n} bytes, keccak256 ${hash}`,
    text: (n: number, hash: string) => `${n} characters, keccak256 ${hash}`,
  },
  'zh-TW': {
    tx: '交易',
    call: (n: number) => `呼叫 #${n}`,
    bundle: (i: number, n: number) => `Bundler3 呼叫 ${i}/${n}`,
    inner: '內含的呼叫',
    end: '總計',
    value: 'value（wei）',
    fn: '函式',
    arg: (n: number) => `引數 ${n}`,
    extra: '引數後多出的 bytes',
    count: 'Safe 發出的呼叫數',
    none: '無',
    bytes: (n: number, hash: string) => `${n} bytes，keccak256 ${hash}`,
    text: (n: number, hash: string) => `${n} 字元，keccak256 ${hash}`,
  },
} satisfies Record<Language, unknown>;
type RowWords = (typeof ROW_WORDS)['en'];

const BYTES_SHOWN = 32;
const TEXT_SHOWN = 120;

function folded(value: string, r: RowWords): string | undefined {
  if (/^0x([0-9a-fA-F]{2})*$/.test(value) && value.length > 2 + 2 * BYTES_SHOWN) {
    return r.bytes((value.length - 2) / 2, `0x${bytesToHex(keccak_256(hexToBytes(value.slice(2))))}`);
  }
  const length = [...value].length;
  return length > TEXT_SHOWN ? r.text(length, `0x${bytesToHex(keccak_256(utf8ToBytes(value)))}`) : undefined;
}

/** One line of HTML per checklist line, in the exact bytes check.sh writes in the same language. */
export function checklistLineHtml(line: ChecklistLine, language: Language): string {
  if (line.kind === 'group') return `<div class="g"><span class="id">${html(visible(line.id))}</span><span>${html(visible(line.title))}</span></div>`;
  const value = visible(line.value);
  const summary = folded(value, ROW_WORDS[language]);
  const shown = summary === undefined ? html(value) : `<details><summary>${html(summary)}</summary><span class="full">${html(value)}</span></details>`;
  const ai = line.ai === undefined ? '' : ` <span class="aiw" data-ai><span class="byai">AI</span><span>${html(visible(line.ai))}</span></span>`;
  return `<div class="r"><span class="id">${html(visible(line.id))}</span><span class="k">${html(line.key)}</span><span class="v">${shown}</span><span class="nm">${html(visible(line.name))}${ai}</span></div>`;
}

export const CHECKLIST_START = '<!-- 比對清單 -->';
export const CHECKLIST_END = '<!-- /比對清單 -->';

export const checklistHtml = (lines: readonly ChecklistLine[], language: Language): string =>
  [CHECKLIST_START, '<div class="cl">', ...lines.map((line) => checklistLineHtml(line, language)), '</div>', CHECKLIST_END].join('\n');

/** The words of the last column, which check.sh does not share. */
const ZH = {
  unregistered: '未登記',
  safe: '本 Safe',
  zero: '零地址',
  addressBook: (name: string) => `${name}（地址簿）`,
  raw: '沒有範本可以解碼',
  trailer: (max: number, bytes: number) => `模板允許這個呼叫最多 ${max} bytes，這裡 ${bytes} bytes，在範圍內`,
  hardwareWallet: '和硬體錢包比對',
  sharePrice: { max: '每股價格上限', min: '每股價格下限' },
};
const EN: typeof ZH = {
  unregistered: 'not registered',
  safe: 'this Safe',
  zero: 'zero address',
  addressBook: (name: string) => `${name} (address book)`,
  raw: 'no template to decode it',
  trailer: (max: number, bytes: number) => `extra bytes after the arguments: the template allows at most ${max}; this call has ${bytes}, within range`,
  hardwareWallet: 'compare with the hardware wallet',
  sharePrice: { max: 'highest share price', min: 'lowest share price' },
};
const NAMES: Readonly<Record<Language, typeof ZH>> = { en: EN, 'zh-TW': ZH };
type Words = typeof ZH & RowWords;

function labelName(label: Label, w: Words): string {
  if (label === undefined) return w.unregistered;
  switch (label.kind) {
    case 'safe':
      return w.safe;
    case 'zero':
      return w.zero;
    case 'registry':
      return label.name;
    case 'address-book':
      return w.addressBook(label.name);
  }
}

const row = (id: string, key: string, value: string, name = ''): ChecklistLine => ({ kind: 'row', id, key, value, name });
const noteText = (note: ArgNote | undefined, w: Words): string => (note === undefined ? '' : note.kind === 'equals' ? `= ${note.text}` : w.sharePrice[note.bound]);
const toRow = (id: string, to: Labeled, w: Words): ChecklistLine => row(`${id}-to`, 'to', checksumAddress(to.address), labelName(to.label, w));

function dataLines(id: string, data: CallData, w: Words): ChecklistLine[] {
  if (data.kind === 'empty') return [row(`${id}-data`, 'data', w.none)];
  if (data.kind === 'raw') return [row(`${id}-data`, 'data', data.hex, w.raw)];
  const named = new Map(data.addresses.map((a) => [checksumAddress(a.address), labelName(a.label, w)]));
  const lines = [
    row(`${id}-fn`, w.fn, `${data.signature} ${data.selector}`),
    ...data.args.map((arg, i) => row(`${id}-a${i + 1}`, w.arg(i + 1), arg.text, named.get(arg.text) ?? noteText(arg.note, w))),
  ];
  if (data.trailer !== undefined) {
    const { hex, allowance } = data.trailer;
    const fact = w.trailer(allowance.maxBytes, (hex.length - 2) / 2);
    lines.push({ kind: 'row', id: `${id}-extra`, key: w.extra, value: hex, name: fact, ai: allowance.why });
  }
  const nested = data.nested;
  if (nested?.kind === 'multisend') lines.push(...nested.calls.flatMap((call) => safeCallLines(call, w)));
  if (nested?.kind === 'bundle') lines.push(...nested.calls.flatMap((call, i) => bundleCallLines(`${id}.${i + 1}`, call, w.bundle(i + 1, nested.calls.length), w)));
  if (nested?.kind === 'bytes') {
    nested.calls.forEach((call, i) => lines.push({ kind: 'group', id: `${id}.${i + 1}`, title: w.inner }, ...dataLines(`${id}.${i + 1}`, call, w)));
  }
  return lines;
}

function bundleCallLines(id: string, call: BundleCall, title: string, w: Words): ChecklistLine[] {
  return [{ kind: 'group', id, title }, toRow(id, call.to, w), row(`${id}-value`, w.value, `${call.value}`), ...dataLines(id, call.data, w)];
}

function safeCallLines(call: SafeCall, w: Words): ChecklistLine[] {
  const id = `C${call.number}`;
  return [
    { kind: 'group', id, title: w.call(call.number) },
    toRow(id, call.to, w),
    row(`${id}-value`, w.value, `${call.value}`),
    row(`${id}-op`, 'operation', call.operation === 0 ? '0 CALL' : '1 DELEGATECALL'),
    ...dataLines(id, call.data, w),
  ];
}

export function checklist(tree: CallTree, language: Language): ChecklistLine[] {
  const w: Words = { ...NAMES[language], ...ROW_WORDS[language] };
  return [
    { kind: 'group', id: 'tx', title: w.tx },
    row('tx-safeTxHash', 'safeTxHash', tree.hashes.safeTxHash, w.hardwareWallet),
    row('tx-domain', 'domain hash', tree.hashes.domainHash, w.hardwareWallet),
    row('tx-message', 'message hash', tree.hashes.messageHash, w.hardwareWallet),
    row('tx-nonce', 'nonce', `${tree.nonce}`),
    ...safeCallLines(tree.top, w),
    { kind: 'group', id: 'end', title: w.end },
    row('end-count', w.count, `${tree.count}`),
  ];
}

/** check.sh carries a copy of these rules. */
export const CHECKLIST_CSS = `.main.solo{max-width:none}
.banner{display:flex;gap:12px;align-items:center;margin-top:22px;padding:14px 16px;border:1px solid var(--line2);border-radius:var(--r);font-size:18px;font-weight:590}
.banner .i{width:20px;height:20px}
.banner.ok{border-color:var(--ok)} .banner.warn{border-color:var(--warn)} .banner.bad{border-color:var(--bad)}
.banner+.lead{margin-top:14px}
.cl{border-top:1px solid var(--line);font-size:var(--t-row)}
.cl .g{display:flex;gap:12px;align-items:baseline;padding:22px 0 8px;border-bottom:1px solid var(--line2);font-weight:590}
.cl .g .id{font-weight:400}
.cl .r{display:grid;grid-template-columns:150px 150px minmax(0,1fr) minmax(0,190px);gap:4px 16px;padding:9px 0;border-bottom:1px solid var(--line);align-items:baseline}
.cl .r:hover{background:var(--hover)}
.cl .id{font-family:var(--mono);font-size:var(--t-label);color:var(--fg3);overflow-wrap:anywhere}
.cl .k{color:var(--fg2)}
.cl .v{font-family:var(--mono);font-size:var(--t-mono);overflow-wrap:anywhere;min-width:0;unicode-bidi:bidi-override;direction:ltr}
.cl .nm{color:var(--fg2);font-size:var(--t-small);overflow-wrap:anywhere}
.cl details>summary,.log details>summary{cursor:pointer}
.cl .full{display:block;margin-top:6px;color:var(--fg2);font-size:13px;line-height:1.5}
.log{font-family:var(--mono);font-size:13px;line-height:1.6;color:var(--fg2);border-top:1px solid var(--line);padding-top:10px}
.log>div{white-space:pre-wrap;overflow-wrap:anywhere}
@media (max-width:720px){.cl .r{grid-template-columns:minmax(0,1fr)}}`;
