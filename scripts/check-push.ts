import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { exitOnHelp } from '../src/script-help.ts';
import { branchSplit, mixedRefusal } from '../src/verdict-core.ts';

const HELP = `usage: pnpm check-push <base>..<head>
       .githooks/pre-push (git runs it before every push; pnpm install turns it on)

Refuses a push whose commits name the configured Safe or an API key, or whose branch mixes files
that must not share a pull request. It searches each commit's message and patch, ignoring letter
case, for the Safe of $KISS_SIGN_HOME/config.json, each value of $KISS_SIGN_HOME/.env and each line
of $KISS_SIGN_HOME/push-deny, and always for those in ~/.kiss-sign too.
Given a range, such as origin/main..HEAD, it searches the commits of the range and judges the branch
from where it left the range's base (git diff <base>...<head>). It takes only a range; a run by hand
or in CI names one.
With no argument, as the hook, it reads git's pushed refs on stdin, searches every pushed commit no
remote holds, and judges each pushed ref against origin/main.
It refuses a branch that changes the verdict core, or the guards counted with it, together with a
file under templates/ or registry/ other than an existing generated report rendered again, or the
verdict core together with a program gate file, naming both sets of files, and a branch git cannot
compare with its base.
It prints "check-push: ok" with the count of patterns, or "check-push: refused" with each finding,
on stderr, and exits 0, 1 when refused, or 2 for an argument that is not a range.
CI runs it on every pull request and every push to main.

Writes: nothing.
Keys: none (it reads the key values only to search for them).
Rules: docs/design/program-ownership.md, "The verdict core" and "The program gate";
docs/design/engine-and-chain.md, "The Safe's address is never published".`;

exitOnHelp(HELP);

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

type Branch = { readonly base: string; readonly head: string; readonly name: string };

function outgoing(rangeArg: string | undefined): { readonly commits: string[]; readonly branches: Branch[] } {
  const revList = (...args: string[]) => git('rev-list', ...args).split('\n').filter(Boolean);
  if (rangeArg !== undefined) {
    const [, base, head] = /^(.+?)\.\.\.?(.*)$/.exec(rangeArg) ?? [];
    if (!base) {
      console.error(`check-push takes a range such as origin/main..HEAD, not ${rangeArg}.`);
      process.exit(2);
    }
    return { commits: revList(rangeArg), branches: [{ base, head: head || 'HEAD', name: head || 'HEAD' }] };
  }
  const pushed = readFileSync(0, 'utf8')
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .flatMap(([name, sha]) => (name !== undefined && sha !== undefined && !ZERO_SHA.test(sha) ? [{ name, sha }] : []));
  return {
    commits: pushed.flatMap(({ sha }) => revList(sha, '--not', '--remotes')),
    branches: pushed.map(({ name, sha }) => ({ base: 'origin/main', head: sha, name })),
  };
}

const needles = homes().flatMap(needlesIn);
const { commits, branches } = outgoing(process.argv[2]);
const findings: string[] = [];
for (const commit of commits) {
  const text = git('show', '--format=%B', '--patch', commit).toLowerCase();
  for (const needle of needles) {
    if (text.includes(needle.text.toLowerCase())) findings.push(`${commit.slice(0, 12)} contains ${needle.label}`);
  }
}
for (const { base, head, name } of branches) {
  const split = branchSplit(process.cwd(), base, head);
  const refusal = split === undefined ? `git could not compare ${name} with ${base}, so it cannot tell whether ${name} changes the verdict core beside a template; fetch ${base} and run this again` : mixedRefusal(base, name, split);
  if (refusal !== undefined) findings.push(refusal);
}

if (findings.length > 0) {
  console.error(`check-push: refused.\n${findings.join('\n')}`);
  process.exit(1);
}
console.error(`check-push: ok, ${needles.length} patterns checked.`);
