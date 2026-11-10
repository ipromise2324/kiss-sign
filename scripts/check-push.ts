import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

type Needle = { label: string; text: string };

const ZERO_SHA = /^0+$/;

function homes(): string[] {
  const all = [process.env.KISS_SIGN_HOME, join(homedir(), '.kiss-sign')];
  return [...new Set(all.filter((home): home is string => home !== undefined && home !== ''))];
}

function needlesIn(home: string): Needle[] {
  const needles: Needle[] = [];
  const config = join(home, 'config.json');
  if (existsSync(config)) {
    const { safe } = JSON.parse(readFileSync(config, 'utf8')) as { safe?: unknown };
    if (typeof safe === 'string' && safe !== '') needles.push({ label: 'the configured Safe address', text: safe });
  }
  const env = join(home, '.env');
  if (existsSync(env)) {
    for (const line of readFileSync(env, 'utf8').split('\n')) {
      const match = /^([A-Z0-9_]+)=(.+)$/.exec(line.trim());
      if (match?.[1] && match[2]) needles.push({ label: `the value of ${match[1]}`, text: match[2] });
    }
  }
  const deny = join(home, 'push-deny');
  if (existsSync(deny)) {
    for (const line of readFileSync(deny, 'utf8').split('\n')) {
      const text = line.trim();
      if (text !== '') needles.push({ label: `"${text}" from push-deny`, text });
    }
  }
  return needles;
}

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 30 });
}

function outgoingCommits(rangeArg: string | undefined): string[] {
  if (rangeArg !== undefined) return git('rev-list', rangeArg).split('\n').filter(Boolean);
  const commits: string[] = [];
  for (const line of readFileSync(0, 'utf8').split('\n')) {
    const localSha = line.trim().split(/\s+/)[1];
    if (localSha === undefined || ZERO_SHA.test(localSha)) continue;
    commits.push(...git('rev-list', localSha, '--not', '--remotes').split('\n').filter(Boolean));
  }
  return commits;
}

const needles = homes().flatMap(needlesIn);
const findings: string[] = [];
for (const commit of outgoingCommits(process.argv[2])) {
  const text = git('show', '--format=%B', '--patch', commit).toLowerCase();
  for (const needle of needles) {
    if (text.includes(needle.text.toLowerCase())) findings.push(`${commit.slice(0, 12)} contains ${needle.label}`);
  }
}

if (findings.length > 0) {
  console.error(`check-push: refused.\n${findings.join('\n')}`);
  process.exit(1);
}
console.error(`check-push: ok, ${needles.length} patterns checked.`);
