import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli/main.ts';

const ROOT = join(import.meta.dirname, '..');
const SKILL_DIR = join(ROOT, '.claude', 'skills', 'kiss-sign');
const files = readdirSync(SKILL_DIR).filter((name) => name.endsWith('.md'));
const text = files.map((name) => readFileSync(join(SKILL_DIR, name), 'utf8')).join('\n');

/** Text inside backticks and fenced blocks: where the skill names commands and paths. */
const code = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```|`([^`\n]+)`/g)].map((m) => m[1] ?? m[2] ?? '');

async function usage(): Promise<string> {
  let stderr = '';
  await main([], {
    env: {},
    stdout: () => {},
    stderr: (t) => void (stderr += t),
    readSecret: undefined,
    ask: undefined,
    repoRoot: ROOT,
    transport: async () => assert.fail('no chain reads'),
    fetchJson: async () => assert.fail('no fetches'),
  });
  return stderr;
}

test('the skill names only kiss-sign commands the CLI has', async () => {
  const commands = (await usage())
    .split('\n')
    .map((line) => line.trim().split(' ').slice(1))
    .map((words) => words.filter((_, i) => !words.slice(0, i + 1).some((w) => /^[<-]/.test(w))).join(' '))
    .filter((literal) => literal !== '');
  const named = code.flatMap((span) => [...span.matchAll(/\bkiss-sign ([a-z]+(?: [a-z]+)?)/g)].map((m) => m[1] as string));
  assert.ok(named.length >= 5, 'the skill names the signer commands');
  for (const words of named) {
    const known = commands.includes(words);
    assert.ok(known, `kiss-sign ${words} is not a CLI command`);
  }
});

test('the skill names only pnpm scripts package.json has', () => {
  const scripts = Object.keys(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts);
  const named = code.flatMap((span) => [...span.matchAll(/\bpnpm ([a-z][a-z-]*)/g)].map((m) => m[1] as string));
  assert.ok(named.includes('past-txs'), 'the skill names pnpm past-txs');
  for (const script of named) assert.ok(scripts.includes(script), `pnpm ${script} is not a script`);
});

test('every repository path the skill names exists, or is an output path under a directory that exists', () => {
  const paths = code.flatMap((span) => span.split(/\s+/)).filter((word) => /^(\.claude|bin|docs|registry|scripts|src|templates|test|testdata)\//.test(word));
  assert.ok(paths.length > 0);
  for (const path of paths) {
    const placeholder = path.indexOf('<');
    const existing = placeholder === -1 ? path : path.slice(0, path.lastIndexOf('/', placeholder) + 1);
    assert.ok(existsSync(join(ROOT, existing)), `${path} does not exist`);
  }
});

test('the skill holds no address', () => {
  assert.doesNotMatch(text, /0x[0-9a-fA-F]{40}/);
});
