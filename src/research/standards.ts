import type { ContractKind, HttpsUrl } from '../registry.ts';

type CanonicalSignature = string;
/** The function as the standard's page writes it, with parameter names. */
type Declaration = string;

/** A token standard whose own page documents functions every contract of `kinds` has. */
export type Standard = {
  readonly name: string;
  readonly page: HttpsUrl;
  readonly org: string;
  readonly kinds: readonly ContractKind[];
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
]);
