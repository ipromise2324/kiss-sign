/**
 * The templates that predate the generated report, frozen when it came in. Lists that name templates not yet rebuilt,
 * design.md's and `NOT_YET_REBUILT`, may only shrink within it: a new template needs its report.
 */
export const PREDATE_REPORT: ReadonlySet<string> = new Set([
  'erc20/transfer',
  'eth/transfer',
  'fluid/vault-deposit',
]);
