import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContractKind } from '../registry.ts';
import { SafeTxParseError, parseAddress } from '../safe/types.ts';
import type { Address } from '../safe/types.ts';

export const ANSWER_SCHEMA_PATH = join(import.meta.dirname, 'answer.schema.json');
const MAX_ANSWER_BYTES = 64 * 1024;

type Url = string;
type Slug = string;

export type ArgMeaning =
  | 'amount'
  | 'min-amount-out'
  | 'max-amount-in'
  | 'recipient'
  | 'owner'
  | 'spender'
  | 'token'
  | 'vault'
  | 'deadline'
  | 'proof'
  | 'calls'
  | 'nonce'
  | 'tag'
  | 'unknown';

export type HealthCategory = 'hack' | 'post-mortem' | 'audit' | 'upgrade' | 'admin-change' | 'pause' | 'deprecation' | 'bug-bounty';

export type ResearchAnswer = {
  readonly schema: 'kiss-sign/research-answer-1';
  readonly contracts: readonly {
    readonly address: Address;
    readonly kind: ContractKind;
    readonly sources: readonly Url[];
    readonly defillama: Slug;
    readonly coingecko?: Slug;
    readonly asset?: Address;
    readonly protocolApi?: { readonly endpoint: Url; readonly listed: boolean; readonly asset?: Address; readonly curator?: Address };
  }[];
  readonly deployers: readonly { readonly address: Address; readonly sources: readonly Url[] }[];
  readonly functions: readonly {
    readonly contract: Address;
    readonly selector: string;
    readonly docs: Url;
    readonly args: readonly { readonly index: number; readonly meaning: ArgMeaning }[];
  }[];
  readonly health: readonly { readonly category: HealthCategory; readonly url: Url; readonly date: string }[];
};

export class ResearchAnswerError extends Error {
  override name = 'ResearchAnswerError';

  constructor(path: string, problem: string) {
    super(`${path === '' ? 'the answer' : path}: ${problem}`);
  }
}

type Schema = Readonly<Record<string, unknown>>;

const KEYWORDS = new Set([
  '$schema',
  '$id',
  '$defs',
  '$ref',
  'description',
  'type',
  'const',
  'enum',
  'pattern',
  'maxLength',
  'format',
  'minimum',
  'maximum',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function admit(schema: Schema, value: unknown, path: string, root: Schema, rule: string): unknown {
  for (const key of Object.keys(schema)) if (!KEYWORDS.has(key)) throw new Error(`answer.schema.json uses ${key}, which the parser does not enforce`);
  if (typeof schema.$ref === 'string') {
    const name = schema.$ref.replace('#/$defs/', '');
    const target = (root.$defs as Record<string, Schema>)[name];
    if (target === undefined) throw new Error(`answer.schema.json has no $defs/${name}`);
    return admit(target, value, path, root, name);
  }
  const fail = (problem: string): never => {
    throw new ResearchAnswerError(path, problem);
  };
  if ('const' in schema && value !== schema.const) fail(`must be ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) fail(`not one of ${schema.enum.join(', ')}`);
  switch (schema.type) {
    case 'object': {
      if (!isRecord(value)) return fail('not an object');
      const properties = (schema.properties ?? {}) as Record<string, Schema>;
      if (Object.keys(value).some((key) => !Object.hasOwn(properties, key))) fail('holds a key the schema does not have');
      for (const key of (schema.required ?? []) as string[]) if (!Object.hasOwn(value, key)) fail(`missing ${key}`);
      const out: Record<string, unknown> = {};
      for (const [key, sub] of Object.entries(properties)) {
        if (Object.hasOwn(value, key)) out[key] = admit(sub, value[key], path === '' ? key : `${path}.${key}`, root, key);
      }
      return out;
    }
    case 'array': {
      if (!Array.isArray(value)) return fail('not an array');
      if (typeof schema.minItems === 'number' && value.length < schema.minItems) fail(`fewer than ${schema.minItems} items`);
      if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) fail(`more than ${schema.maxItems} items`);
      return value.map((item, i) => admit(schema.items as Schema, item, `${path}[${i}]`, root, rule));
    }
    case 'string': {
      if (typeof value !== 'string') return fail('not a string');
      if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) fail(`longer than ${schema.maxLength} characters`);
      if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) fail(`breaks the ${rule} rule (${String(schema.description ?? schema.pattern)})`);
      if (schema.format === 'eth-address') {
        try {
          return parseAddress(path, value);
        } catch (error) {
          if (error instanceof SafeTxParseError) fail('bad EIP-55 checksum');
          throw error;
        }
      }
      return value;
    }
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) fail('not an integer');
      if (typeof schema.minimum === 'number' && (value as number) < schema.minimum) fail(`below ${schema.minimum}`);
      if (typeof schema.maximum === 'number' && (value as number) > schema.maximum) fail(`above ${schema.maximum}`);
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') fail('not true or false');
      return value;
    case undefined:
      return value;
    default:
      throw new Error(`answer.schema.json uses type ${String(schema.type)}, which the parser does not enforce`);
  }
}

export function loadAnswerSchema(): Schema {
  return JSON.parse(readFileSync(ANSWER_SCHEMA_PATH, 'utf8')) as Schema;
}

export function parseResearchAnswer(text: string, schema: Schema = loadAnswerSchema()): ResearchAnswer {
  if (Buffer.byteLength(text, 'utf8') > MAX_ANSWER_BYTES) throw new ResearchAnswerError('', `larger than ${MAX_ANSWER_BYTES} bytes`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ResearchAnswerError('', 'not JSON');
  }
  return admit(schema, raw, '', schema, 'answer') as ResearchAnswer;
}
