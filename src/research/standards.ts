import type { ContractKind, HttpsUrl } from '../registry.ts';
import type { Address } from '../safe/types.ts';

type CanonicalSignature = string;
/**
 * The function as the standard's page writes it: a Solidity declaration with parameter names, or, for a page that writes
 * each function as a YAML entry, the entry's first line.
 */
type Declaration = string;

/**
 * A token standard whose own page documents functions every contract of `kinds` has, or, with `only`, the one deployed
 * contract at that address whose source the page is.
 */
export type Standard = {
  readonly name: string;
  readonly page: HttpsUrl;
  readonly org: string;
  readonly kinds: readonly ContractKind[];
  readonly only?: Address;
  readonly declarations: ReadonlyMap<CanonicalSignature, Declaration>;
};

export const STANDARDS: ReadonlyMap<string, Standard> = new Map([
  [
    'erc-20',
    {
      name: 'ERC-20',
      page: 'https://github.com/ethereum/ERCs/blob/ae65e89408f387ffb47d220879925c4ab384dfc2/ERCS/erc-20.md' as HttpsUrl,
      org: 'ethereum',
      kinds: ['token', 'vault'],
      declarations: new Map([
        ['transfer(address,uint256)', 'function transfer(address _to, uint256 _value)'],
        ['transferFrom(address,address,uint256)', 'function transferFrom(address _from, address _to, uint256 _value)'],
        ['approve(address,uint256)', 'function approve(address _spender, uint256 _value)'],
      ]),
    },
  ],
  [
    'erc-4626',
    {
      name: 'ERC-4626',
      page: 'https://github.com/ethereum/ERCs/blob/ae65e89408f387ffb47d220879925c4ab384dfc2/ERCS/erc-4626.md' as HttpsUrl,
      org: 'ethereum',
      kinds: ['vault'],
      declarations: new Map(
        (
          [
            ['asset()', 'asset'],
            ['totalAssets()', 'totalAssets'],
            ['convertToShares(uint256)', 'convertToShares'],
            ['convertToAssets(uint256)', 'convertToAssets'],
            ['maxDeposit(address)', 'maxDeposit'],
            ['previewDeposit(uint256)', 'previewDeposit'],
            ['deposit(uint256,address)', 'deposit'],
            ['maxMint(address)', 'maxMint'],
            ['previewMint(uint256)', 'previewMint'],
            ['mint(uint256,address)', 'mint'],
            ['maxWithdraw(address)', 'maxWithdraw'],
            ['previewWithdraw(uint256)', 'previewWithdraw'],
            ['withdraw(uint256,address,address)', 'withdraw'],
            ['maxRedeem(address)', 'maxRedeem'],
            ['previewRedeem(uint256)', 'previewRedeem'],
            ['redeem(uint256,address,address)', 'redeem'],
          ] as const
        ).map(([signature, name]) => [signature, `- name: ${name}`]),
      ),
    },
  ],
  [
    'weth9',
    {
      name: 'WETH9',
      page: 'https://github.com/dapphub/ds-weth/blob/72355fbac1755331aeab354b3e4a92ca47d06b35/src/weth9.sol' as HttpsUrl,
      org: 'dapphub',
      kinds: ['token'],
      only: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' as Address,
      declarations: new Map([
        ['deposit()', 'function deposit()'],
        ['withdraw(uint256)', 'function withdraw(uint wad)'],
      ]),
    },
  ],
]);
