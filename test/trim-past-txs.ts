/**
 * Cuts full past-txs recordings down to test fixtures: for each name, replays .cache/past-txs/<name>.json with the test
 * fixtures' templates and registry, notes every search answer, chain read, signed message and trace the replay reads,
 * and writes testdata/past-txs/<name>.json holding only those, each search answer and block cut as `--record` cuts them
 * today, so a recording made before those cuts shrinks too. A test that replays the fixture reads no more than that.
 *
 *   node test/trim-past-txs.ts <name>...
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readRecording, recordingText } from '../src/chain/bytecode.ts';
import { createReader } from '../src/chain/reader.ts';
import { REPLAY_ENDPOINTS, replayTransport, trimBlockAnswers } from '../src/chain/recording.ts';
import { loadRegistry } from '../src/registry.ts';
import { pastTxs } from '../src/research/past-txs.ts';
import { RECORDINGS_DIR } from '../src/research/past-txs-summary.ts';
import { replayMessages } from '../src/research/messages.ts';
import { anchorOf, samplingOf } from '../src/research/recording.ts';
import type { PastTxsRecording } from '../src/research/recording.ts';
import { recordingAsk, replayAsk } from '../src/research/sources.ts';
import { replayTraces } from '../src/research/trace.ts';
import { loadTemplate } from '../src/template/template.ts';
import { repoWithTestFixtures } from './repo-with-test-fixtures.ts';

const REPO = join(import.meta.dirname, '..');
const names = process.argv.slice(2);
if (names.length === 0 || names.some((name) => !/^[a-z0-9-]+$/.test(name))) {
  console.error('usage: node test/trim-past-txs.ts <name>...');
  process.exit(64);
}

const root = repoWithTestFixtures('implementation-read');
const registry = loadRegistry(root);
const key = (method: string, params: unknown) => `${method} ${JSON.stringify(params)}`;

for (const name of names) {
  const { excluded, ...recording } = readRecording<PastTxsRecording>(join(REPO, RECORDINGS_DIR, `${name}.json`));
  if ((excluded?.found.length ?? 0) + (excluded?.sampled.length ?? 0) > 0) {
    console.error(`${name}: the recording lists transactions of the configured Safe in excluded, which a committed fixture must not hold`);
    process.exit(1);
  }
  const read = new Set<string>();
  const messages = new Set<string>();
  const traced = new Set<string>();
  const search = recordingAsk(replayAsk(recording.sources));
  const transport = replayTransport(recording.exchanges, REPLAY_ENDPOINTS);
  const readMessage = replayMessages(recording.messages ?? []);
  const traces = replayTraces(recording.traces);
  const { query } = recording;
  await pastTxs(
    { template: loadTemplate(root, query.template, registry), anchor: anchorOf(query), sampling: samplingOf(query) },
    {
      ask: search.ask,
      reader: createReader(
        REPLAY_ENDPOINTS,
        (url, body, signal) => {
          const { method, params } = JSON.parse(body) as { method: string; params: unknown };
          read.add(key(method, params));
          return transport(url, body, signal);
        },
        { timeoutMs: 1000, retryPausesMs: [], rateLimitPausesMs: [] },
      ),
      registry,
      readMessage: (url, message) => (messages.add(url), readMessage(url, message)),
      exclude: undefined,
      maxTxs: query.maxTxs,
      traces: (hash) => (traced.add(hash), traces(hash)),
    },
  );
  const trimmed: PastTxsRecording = {
    ...recording,
    sources: search.exchanges(),
    exchanges: recording.exchanges.filter((e) => read.has(key(e.method, e.params))).map(trimBlockAnswers),
    ...(recording.messages === undefined ? {} : { messages: recording.messages.filter((m) => messages.has(m.url)) }),
    ...(recording.traces === undefined ? {} : { traces: recording.traces.filter((t) => traced.has(t.hash)) }),
  };
  const out = join(REPO, 'testdata', 'past-txs', `${name}.json`);
  mkdirSync(join(out, '..'), { recursive: true });
  const text = recordingText(trimmed, 1);
  writeFileSync(out, text);
  console.log(`${out}: ${trimmed.sources.length} of ${recording.sources.length} search answers, ${trimmed.exchanges.length} of ${recording.exchanges.length} chain reads, ${(text.length / 1e6).toFixed(2)} MB`);
}
