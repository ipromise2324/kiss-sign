import { stateOf } from './ledger.ts';
import type { FindingKind, Ledger, Result } from './ledger.ts';

/**
 * How much a finding weighs for the signer. Key: it bears on whether the address or its code is the protocol's real one
 * and does what the template assumes. Reference: context the signer may weigh that undermines neither.
 */
export type Grade = 'key' | 'reference';

/** A result's weight: passed, a finding of a grade, or neutral, a place with nothing to compare that is no finding. */
export type Weight = 'pass' | Grade | 'neutral';

/** The one table of weights; docs/design.md (Finding grades) gives the reason for each. Unsure is key. */
export const WEIGHT_OF: { readonly [K in FindingKind]: Weight } = {
  agrees: 'pass',
  'site-differs': 'key',
  'other-coin': 'key',
  'other-answer': 'key',
  'pin-not-run': 'key',
  'proof-not-pin': 'key',
  'fn-not-in-abi': 'key',
  'not-created': 'key',
  'factory-other-answer': 'key',
  'check-denied': 'key',
  'check-other-answer': 'key',
  refused: 'key',
  'judged-otherwise': 'key',
  'newer-differs': 'key',
  'package-differs': 'key',
  'few-confirmations': 'key',
  'no-answer': 'key',
  'site-not-compared': 'key',
  'commit-unconfirmed': 'key',
  'page-not-fetched': 'key',
  'name-not-on-page': 'key',
  'no-chain-result': 'key',
  'factory-unread': 'key',
  'check-unread': 'key',
  'not-pinned': 'key',
  'no-second-source': 'key',
  'compiler-not-pinned': 'key',
  'pinned-before-spans': 'key',
  'no-abi-case': 'key',
  'unexplained-coin': 'reference',
  'metadata-differs': 'reference',
  'no-coin': 'reference',
  'no-provenance': 'reference',
  'creation-unproven': 'reference',
  'source-no-answer': 'reference',
  'page-unread': 'reference',
  'bounty-not-tied': 'reference',
  'no-such-program': 'reference',
  'url-holds-address': 'reference',
  'not-listed': 'neutral',
  unlisted: 'neutral',
  'deployer-alone': 'neutral',
  'not-called': 'neutral',
  'routed-proxy': 'neutral',
};

export const weightOf = (result: Result): Weight => WEIGHT_OF[result.finding.kind];

/** Every finding of the ledger, key before reference, each red before amber before grey, then in ledger order. */
export function gradedFindings(ledger: Ledger): Result[] {
  const rank = { bad: 0, warn: 1, na: 2, ok: 3 } as const;
  const of = (grade: Grade) => ledger.results.filter((r) => weightOf(r) === grade).sort((a, b) => rank[stateOf(a)] - rank[stateOf(b)]);
  return [...of('key'), ...of('reference')];
}
