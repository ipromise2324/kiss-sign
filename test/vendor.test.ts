import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ERC7730_ARCHIVE } from '../src/research/erc7730.ts';
import { PUBLIC_SUFFIX_PIN } from '../src/research/public-suffix.ts';
import { ensureVendored, nodeVendorIo } from '../src/vendor.ts';
import type { VendorIo } from '../src/vendor.ts';

const PSL = readFileSync(join(nodeVendorIo.root, 'publicsuffix', PUBLIC_SUFFIX_PIN.file));

function offline(served: Uint8Array) {
  const downloads: string[] = [];
  const log: string[] = [];
  const io: VendorIo = {
    root: mkdtempSync(join(tmpdir(), 'kiss-sign-vendor-')),
    download: async (url) => {
      downloads.push(url);
      return new Response(served);
    },
    get: async (url) => {
      if (url.endsWith('/compare/main...3bebbd05cbc2d2d2bf9c41a8edbf5e5cc88e4eb4?per_page=1')) return { status: 404, text: '{}' };
      return { status: 200, text: JSON.stringify({ default_branch: 'main' }) };
    },
    log: (line) => void log.push(line),
  };
  return { io, downloads, log };
}

test('a missing Public Suffix List is downloaded once, with one line saying so, and then left alone', async () => {
  const { io, downloads, log } = offline(PSL);
  assert.equal(await ensureVendored(['psl'], io), true);
  assert.deepEqual(downloads, [PUBLIC_SUFFIX_PIN.url]);
  assert.equal(log[0], 'downloading the pinned Public Suffix List into vendor/publicsuffix/, since a file there is missing or differs from its pin');
  assert.deepEqual(readFileSync(join(io.root, 'publicsuffix', PUBLIC_SUFFIX_PIN.file)), PSL);

  log.length = 0;
  assert.equal(await ensureVendored(['psl'], io), true);
  assert.deepEqual(downloads, [PUBLIC_SUFFIX_PIN.url]);
  assert.deepEqual(log, []);
});

test('a download whose sha256 differs from the pin is refused and not written', async () => {
  const { io, log } = offline(new TextEncoder().encode('// not the pinned list\ncom\n'));
  assert.equal(await ensureVendored(['psl'], io), false);
  assert.match(log.at(-1) ?? '', /^Public Suffix List: refused, sha256 [0-9a-f]{64} is not the pinned d3e6243b/);
  assert.equal(existsSync(join(io.root, 'publicsuffix', PUBLIC_SUFFIX_PIN.file)), false);
});

test('a file that differs from its pin is downloaded again', async () => {
  const { io, downloads } = offline(PSL);
  mkdirSync(join(io.root, 'publicsuffix'));
  writeFileSync(join(io.root, 'publicsuffix', PUBLIC_SUFFIX_PIN.file), 'altered');
  assert.equal(await ensureVendored(['psl'], io), true);
  assert.equal(downloads.length, 1);
  assert.deepEqual(readFileSync(join(io.root, 'publicsuffix', PUBLIC_SUFFIX_PIN.file)), PSL);
});

test('the ERC-7730 archive is not downloaded when GitHub does not show its commit on the default branch', async () => {
  const { io, downloads, log } = offline(PSL);
  assert.equal(await ensureVendored(['erc7730'], io), false);
  assert.deepEqual(downloads, []);
  assert.match(log.at(-1) ?? '', /^refused, commit 3bebbd05.*not on the default branch main \(no such commit in the repository\)/);
  assert.equal(existsSync(join(io.root, 'erc7730', ERC7730_ARCHIVE)), false);
});
