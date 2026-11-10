export type SolcPin = { readonly file: string; readonly sha256: string };

/**
 * Each sha256 is the one soliditylang's `bin/list.json` and `emscripten-wasm32/list.json` both give, and equals the
 * sha256 of the `soljson.js` asset of the same release on GitHub (github.com/argotorg/solidity), downloaded and hashed
 * on its own.
 */
export const SOLC_PINS: Readonly<Record<string, SolcPin>> = {
  '0.7.3+commit.9bfce1f6': {
    file: 'soljson-v0.7.3+commit.9bfce1f6.js',
    sha256: 'caf4b1f3e01fcf946aad2d22bbe046b9dc4fd50049a05c3458ff239e2c93a785',
  },
  '0.7.6+commit.7338295f': {
    file: 'soljson-v0.7.6+commit.7338295f.js',
    sha256: 'b94e69dfb056b3e26080f805ab43b668afbc0ac70bf124bfb7391ecfc0172ad2',
  },
  '0.8.19+commit.7dd6d404': {
    file: 'soljson-v0.8.19+commit.7dd6d404.js',
    sha256: 'e0b74e0a16e783a35169f74d1a615ecb48d07c30f97346b83cd587949268681e',
  },
  '0.8.21+commit.d9974bed': {
    file: 'soljson-v0.8.21+commit.d9974bed.js',
    sha256: '45bea352b41d04039e19439962ddef1d3e10cf2bc9526feba39f2cc79e3c5a17',
  },
  '0.8.25+commit.b61c2a91': {
    file: 'soljson-v0.8.25+commit.b61c2a91.js',
    sha256: 'f8c9554471ff2db3843167dffb7a503293b5dc728c8305b044ef9fd37d626ca7',
  },
  '0.8.26+commit.8a97fa7a': {
    file: 'soljson-v0.8.26+commit.8a97fa7a.js',
    sha256: 'db85e5396f523cc1a53c4c4d742e204f6dcba1a05842623d73be946809e11cd6',
  },
  '0.8.27+commit.40a35a09': {
    file: 'soljson-v0.8.27+commit.40a35a09.js',
    sha256: 'd91c08277f801321af4e80958015aea18b41c01d2c6a38310a23014485b0e51c',
  },
  '0.8.28+commit.7893614a': {
    file: 'soljson-v0.8.28+commit.7893614a.js',
    sha256: '72ef580a6ec5943130028e5294313f24e9435520acc89f8c9dbfd0139d9ae146',
  },
  '0.8.34+commit.80d5c536': {
    file: 'soljson-v0.8.34+commit.80d5c536.js',
    sha256: 'c8649f8d57f81b3244c7d2dd662efc0620d1ae296f623b347a2c616a6cfd11d8',
  },
};

export const SOLC_DOWNLOAD_BASE = 'https://binaries.soliditylang.org/bin/';
