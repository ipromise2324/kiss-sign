import type { Address } from './types.ts';

export type SafeSingleton = {
  readonly address: Address;
  readonly contract: 'GnosisSafe' | 'GnosisSafeL2' | 'Safe' | 'SafeL2';
  readonly version: '1.0.0' | '1.1.1' | '1.2.0' | '1.3.0' | '1.4.1' | '1.5.0';
};

/**
 * Mainnet singletons from github.com/safe-global/safe-deployments at commit ca9cb0d2d5f5175fc8e41d579f356748d2bc1c62,
 * `src/assets/v<version>/{gnosis_safe,gnosis_safe_l2,safe,safe_l2}.json`, both the canonical and the eip155 deployment
 * where network 1 lists both.
 */
export const OFFICIAL_SAFE_SINGLETONS: readonly SafeSingleton[] = [
  { address: '0xb6029ea3b2c51d09a50b53ca8012feeb05bda35a' as Address, contract: 'GnosisSafe', version: '1.0.0' },
  { address: '0x34cfac646f301356faa8b21e94227e3583fe3f5f' as Address, contract: 'GnosisSafe', version: '1.1.1' },
  { address: '0x6851d6fdfafd08c0295c392436245e5bc78b0185' as Address, contract: 'GnosisSafe', version: '1.2.0' },
  { address: '0xd9db270c1b5e3bd161e8c8503c55ceabee709552' as Address, contract: 'GnosisSafe', version: '1.3.0' },
  { address: '0x69f4d1788e39c87893c980c06edf4b7f686e2938' as Address, contract: 'GnosisSafe', version: '1.3.0' },
  { address: '0x3e5c63644e683549055b9be8653de26e0b4cd36e' as Address, contract: 'GnosisSafeL2', version: '1.3.0' },
  { address: '0xfb1bffc9d739b8d520daf37df666da4c687191ea' as Address, contract: 'GnosisSafeL2', version: '1.3.0' },
  { address: '0x41675c099f32341bf84bfc5382af534df5c7461a' as Address, contract: 'Safe', version: '1.4.1' },
  { address: '0x29fcb43b46531bca003ddc8fcb67ffe91900c762' as Address, contract: 'SafeL2', version: '1.4.1' },
  { address: '0xff51a5898e281db6dfc7855790607438df2ca44b' as Address, contract: 'Safe', version: '1.5.0' },
  { address: '0xedd160febbd92e350d4d398fb636302fccd67c7e' as Address, contract: 'SafeL2', version: '1.5.0' },
];
