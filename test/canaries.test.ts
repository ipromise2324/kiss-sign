import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCanary } from '../src/canaries.ts';
import { CANARY_LIST, CanaryListError, parseCanaryList } from '../src/verdict-core.ts';

const ROOT = join(import.meta.dirname, '..');
const canaries = parseCanaryList(readFileSync(join(ROOT, CANARY_LIST), 'utf8'));

test('docs/canaries.txt lists every canary file in test/canaries/, and every path it says a canary reads exists', () => {
  const files = readdirSync(join(ROOT, 'test', 'canaries')).filter((name) => name.endsWith('.canary.ts')).map((name) => `test/canaries/${name}`);
  assert.deepEqual(canaries.map(({ file }) => file).sort(), files.sort());
  for (const path of canaries.flatMap(({ reads }) => reads)) assert.ok(existsSync(join(ROOT, path)), path);
});

for (const canary of canaries) {
  test(`canary ${canary.file} passes and reads only what docs/canaries.txt names`, async () => {
    const run = await runCanary(ROOT, canary);
    assert.ok(run.ok, `${run.passed} passed, ${run.failed} failed\n${run.output}`);
    assert.deepEqual(run.unlisted, [], `${canary.file} reads paths its block in ${CANARY_LIST} does not name`);
  });
}

test('the canary list refuses a block that names no guard, a file outside test/canaries/, or a read outside testdata/ and test/', () => {
  const refused = (text: string, message: RegExp) => assert.throws(() => parseCanaryList(text), (error: unknown) => error instanceof CanaryListError && message.test(error.message));
  refused('canary test/canaries/a.canary.ts\n', /exactly one canary and one guards line/);
  refused('canary test/a.test.ts\nguards x\n', /test\/a\.test\.ts is not a test\/canaries\/<name>\.canary\.ts file/);
  refused('canary test/canaries/a.canary.ts\nguards x\nreads src/floor/floor.ts\n', /reads src\/floor\/floor\.ts, which is not a path under testdata\/ or test\//);
  refused('canary test/canaries/a.canary.ts\nguards x\nreads testdata/../src/\n', /not a path under testdata\/ or test\//);
  refused('canary test/canaries/a.canary.ts\nguards x\n\ncanary test/canaries/a.canary.ts\nguards y\n', /listed twice/);
  refused('canary test/canaries/a.canary.ts\nguards x\nskip all\n', /"skip all" is not a canary, guards or reads line/);
});
