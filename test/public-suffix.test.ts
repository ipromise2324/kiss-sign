import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadPublicSuffixList, parsePublicSuffixList, registrableDomain } from '../src/research/public-suffix.ts';

const list = parsePublicSuffixList(readFileSync(join(import.meta.dirname, '..', 'testdata', 'sources', 'public-suffix-list.dat'), 'utf8'));

test('the registrable domain follows the Public Suffix List, private section included', () => {
  assert.equal(registrableDomain('docs.morpho.org', list), 'morpho.org');
  assert.equal(registrableDomain('www.example.co.uk', list), 'example.co.uk');
  assert.equal(registrableDomain('attacker.gitlab.io', list), 'attacker.gitlab.io');
  assert.equal(registrableDomain('docs.real.readthedocs.io', list), 'real.readthedocs.io');
  assert.equal(registrableDomain('app.herokuapp.com', list), 'app.herokuapp.com');
  assert.equal(registrableDomain('x.webflow.io', list), 'x.webflow.io');
  assert.equal(registrableDomain('a.b.ck', list), 'a.b.ck');
  assert.equal(registrableDomain('www.ck', list), 'www.ck');
  assert.equal(registrableDomain('shop.xn--55qx5d.cn', list), 'shop.xn--55qx5d.cn');
  assert.equal(registrableDomain('one.medium.com', list), 'one.medium.com');
});

test('a host that is itself a public suffix, or an IP address, has no registrable domain', () => {
  assert.equal(registrableDomain('attacker.eth.limo', list), undefined);
  assert.equal(registrableDomain('gitlab.io', list), undefined);
  assert.equal(registrableDomain('192.168.1.1', list), undefined);
  for (const shared of ['github.com', 'www.github.com', 'linktr.ee', 'x.com', 'www.youtube.com', 'docs.google.com', 'chromewebstore.google.com', 'apps.apple.com', 'immunefi.com']) {
    assert.equal(registrableDomain(shared, list), undefined, shared);
  }
});

test('a missing or altered list is unavailable and says why', () => {
  const dir = mkdtempSync(join(tmpdir(), 'psl-'));
  const missing = loadPublicSuffixList(dir);
  assert.ok('unavailable' in missing && /missing; run pnpm fetch-psl/.test(missing.unavailable));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'public_suffix_list.dat'), 'com\n');
  const altered = loadPublicSuffixList(dir);
  assert.ok('unavailable' in altered && /sha256 [0-9a-f]{64} is not the pinned/.test(altered.unavailable));
});
