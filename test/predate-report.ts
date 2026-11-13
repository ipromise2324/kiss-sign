/**
 * The templates that predate the generated report, frozen when it came in. Lists that name templates not yet rebuilt,
 * design.md's and `NOT_YET_REBUILT`, may only shrink within it: a new template needs its report.
 */
export const PREDATE_REPORT: ReadonlySet<string> = new Set([
  'cctp/receive',
  'erc20/transfer',
  'eth/transfer',
  'fluid/rewards-claim',
  'fluid/vault-deposit',
  'fluid/vault-redeem',
  'fluid/vault-withdraw',
  'merkl/claim',
  'morpho/urd-claim',
  'morpho/vault-bundles-deposit',
  'morpho/vault-migrate-all',
  'morpho/vault-withdraw',
  'morpho/vault-withdraw-all',
  'safe/cancel',
]);
