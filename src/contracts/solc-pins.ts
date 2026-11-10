export type SolcPin = { readonly file: string; readonly sha256: string };

/**
 * Each sha256 is the one soliditylang's `bin/list.json` and `emscripten-wasm32/list.json` both give, and equals the
 * sha256 of the `soljson.js` asset of the same release on GitHub (github.com/argotorg/solidity), downloaded and hashed
 * on its own.
 */
export const SOLC_PINS: Readonly<Record<string, SolcPin>> = {
  '0.7.6+commit.7338295f': {
    file: 'soljson-v0.7.6+commit.7338295f.js',
    sha256: 'b94e69dfb056b3e26080f805ab43b668afbc0ac70bf124bfb7391ecfc0172ad2',
  },
  '0.8.27+commit.40a35a09': {
    file: 'soljson-v0.8.27+commit.40a35a09.js',
    sha256: 'd91c08277f801321af4e80958015aea18b41c01d2c6a38310a23014485b0e51c',
  },
  '0.8.28+commit.7893614a': {
    file: 'soljson-v0.8.28+commit.7893614a.js',
    sha256: '72ef580a6ec5943130028e5294313f24e9435520acc89f8c9dbfd0139d9ae146',
  },
};

export const SOLC_DOWNLOAD_BASE = 'https://binaries.soliditylang.org/bin/';
