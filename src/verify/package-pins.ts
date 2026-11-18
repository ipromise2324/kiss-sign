/** Every file of a package's tarball with its sha256, keyed by the tarball's sha512 as pnpm-lock.yaml gives it. */
export type PackagePin = { readonly package: string; readonly files: Readonly<Record<string, string>> };

/**
 * Written by `node scripts/pin-packages.ts`, which downloads each tarball from registry.npmjs.org and requires its sha512
 * to be the key before it hashes the files. Every command of bin/kiss-sign requires each package it loads to hold
 * exactly these files.
 */
export const PACKAGE_PINS: Readonly<Record<string, PackagePin>> = {
  "sha512-X5XaVWZIBCT7HHZGm5I7ZQXDwLG+bGXuSrMQAW+7Zvl87h1kmc1ZB1VSRJcpUfoUrGQp4Fkoxm5kZ+Ms+aW+eA==": {
    "package": "@noble/hashes@2.4.0",
    "files": {
      "LICENSE": "4f221aee6e072336700c408c68ab3b96a3fc09f6aebe6f48f1bd99e5ef13faec",
      "README.md": "668a613b90e2d867df4f8d610566e4a874d6e33f799d9770714a26702c6d7dd0",
      "_blake.d.ts": "c32b86abfcd4514e98a2f27b4f67672cb1446ac081d2e715d0dca60e96e8120a",
      "_blake.js": "cabbff61d1f373bac45594ad758df7c42e176464ddbb94b44f5533fa977a4f56",
      "_md.d.ts": "f5ffc0d52997445b4531a0e1e67ee0f6f376e0ed5c66f978e80288973d50cd06",
      "_md.js": "60cf3010fda89e3e4d3f0e7ff1ce249e9c467f34b4fd41b6fd6101d9f69be763",
      "_u64.d.ts": "78744410de5b7594879963d315b7a339a06ecafa73b0a0ddf63fdabdb926dd25",
      "_u64.js": "b09da8c07fe8187c07649494cdb7cd0bcf13df90b506a9473d19e4d5f8c2e102",
      "argon2.d.ts": "a455841ea6f034d54790094ac67afc9311a78a39abb967009a605c37122c03d9",
      "argon2.js": "f39753324bdf2f484150731d24b1d71236f26bf10bedd594f7d190fcdfdefdc9",
      "blake1.d.ts": "f1cc242d614865d7277362ba8a90b58f755aae260881be79e0119ce85a1f6017",
      "blake1.js": "da1d08b4d0702ad4f185a796df8fce3fec2855de53b02190eba3bd8555677b5c",
      "blake2.d.ts": "e60ec6813a51e31751919e471daedaab9510d7a88dc0ef6b4dc05c7de502736e",
      "blake2.js": "03f00237bcc0b4d822a80f7c0ac22e42632c48e246c3b6da584e6452186e32f0",
      "blake3.d.ts": "b9a9fdcc7b04f07674c609fa40b0fdf1252c3ccf024968038fff06e6da00c627",
      "blake3.js": "bc25a8f6c50acabf3781c44ec55cb364b00f6f3f4349d841813a1057a8af2f20",
      "eskdf.d.ts": "d5f8b356eb63754539034e40c22ef45e58af9eb51e121ed7ef1c757eb47f7fe7",
      "eskdf.js": "7ded32d320b0d1d71c59a4a3b493722a13c9c6a66de83f19f8a382b29af7a2f6",
      "hkdf.d.ts": "b31b80e958e55dcff73eebfed1061ab4a49ef5cadc2fca1cf0999e1dd06f2786",
      "hkdf.js": "ccb942a8008f974018965eeb1e33b8f4739bf767c6f95f2ceb06f5873a302f67",
      "hmac.d.ts": "e98501df98e30aadc27a2fac0c725b7755bb297ed8f722b4d9edbad0a52eabce",
      "hmac.js": "fec9f8f3aeda785ea2de91cc4c059d54ef98196261c026c43f48341007ae52c9",
      "index.d.ts": "8e609bb71c20b858c77f0e9f90bb1319db8477b13f9f965f1a1e18524bf50881",
      "index.js": "b0d908a44e09a1b7c27a43d7b9036a6147a7a32db758bb64d9a668ea5c72d1af",
      "legacy.d.ts": "efea3066bab29b907291bb209c8e0ebf33aa7c7de7e284debdf70800ef0c7cfa",
      "legacy.js": "690553a41af2fdd1e32ff6b534ba8508e95f1861c09c2d62fe762b6b501e09be",
      "package.json": "3e361734f5269de162fa362483d7f45dee7efb533ec217157945338f7591baaf",
      "pbkdf2.d.ts": "5e992532a48c56c72d23a01491702f259637fe7d14bb13cea7ce731d74aea9d2",
      "pbkdf2.js": "62b75b5465a89af052a80bdebe7e0383ba01648b12f64877ce285a2e9896c713",
      "scrypt.d.ts": "f3b2a890f8b6564a0f4c8fd3dc80f443501cdd8f4dd18760d472773923329902",
      "scrypt.js": "a38a020620776fa5c57c00f151bdc1033c192827c9d841996daaf29122ea82c1",
      "sha2.d.ts": "5b1c09cb23f0c1e7018d31d28f4eec2b18eec6454f07c0f69ff2eb3c8decdb21",
      "sha2.js": "471746bba6ec4c6238ca41358d1d3b40b6ff31cf3363f0b4d550c649c1a8e83b",
      "sha3-addons.d.ts": "2d838c7d9eaa1e89d8cc45e894ef92cdf7db60bf9bd2eb04b89e2570510fcf47",
      "sha3-addons.js": "e979866a213955afba24c105966bc42afa5d1377d77fe1017dea29a958fddcb7",
      "sha3.d.ts": "6f8d601930e11339441fffbaec65a66c76d62c5c62b91c49230d64e75fa6457a",
      "sha3.js": "9a81e1edb24eae27b335533220167609cfb58008c5690e140ce478acdc669f32",
      "src/_blake.ts": "9eda40c7520d7ccaabf7accca24225ba6bac9ca7b1b7486fc960e15870af1f97",
      "src/_md.ts": "d469c5ca7f638b0ec14df23acd9e631f7f04592bfb8cdd7a13918f178ebeb19d",
      "src/_u64.ts": "3dd3e0a061dfedf2fd3a0c622e746b2927c141dcde8045e5f7cbc5df0b758a74",
      "src/argon2.ts": "6672b2cca5a86f7b3d9c9de75d2d12bf4fea8711fa7f43dcf185d8033839795d",
      "src/blake1.ts": "a4864dcddbfe4e03df638463339d953aca3cb0995ae0b498d1dd3ecc7d50bdb7",
      "src/blake2.ts": "edee1cce752a6e86cea251f11282adb34b5bb8e20e023d317849bbc2920a38ad",
      "src/blake3.ts": "7d7f9432a069cdb05516549091344d525a2762ea698993f5e05f7180ed3aa873",
      "src/eskdf.ts": "fc953318a9f6cc95eced18543f29022a2a1da81795aa63622299180ce37de579",
      "src/hkdf.ts": "0f145497126d9943373c6830d8c67f91f177bf9827bc18e99149909315186423",
      "src/hmac.ts": "74a1ac9f74e3cb97076665c6deada914c3b8e3d645fc65e7e64b71b6d43728fe",
      "src/index.ts": "9f2034ab7b5c452fd7b2b9df6ec7ef0266830cd11f05908e9f5e862993a19c30",
      "src/legacy.ts": "2bacb7fed94e9d0c33d98313bf764989d9d9c23c2fa13d8f7f5ad5a4fea4751f",
      "src/pbkdf2.ts": "1a6230a1c1b18a090601667b28b32b2b7843dfb80539bd33d9be5bb3d20d23ca",
      "src/scrypt.ts": "5f03c5bef264a42f413d199bbee69918f6ca8828be8f2e9f710143043b662b80",
      "src/sha2.ts": "27447d36015d30a97dbe68a08978af65094208ba6f093d9197785105d95c20bc",
      "src/sha3-addons.ts": "8f0ed953b9194fa0b0f6164ab02d33ee78f491fc2b264876a3e4080522bc55ce",
      "src/sha3.ts": "a4a94b8b6755466a6972a3ab7816ec8cb2cabc013c1f4107dd09f235b4815415",
      "src/utils.ts": "df2e7c132fb6c451c792dd32dc8a7643de449bcb7782f50fd23664696fbc5962",
      "src/webcrypto.ts": "799203593e71f7658d2a6aa7863ac082eee1b725024630e300669c7770378628",
      "utils.d.ts": "cfccade8c719b698bd8b0313ff996941f5d5a384654ec2886d9141224f6db439",
      "utils.js": "037ad49adb78168b6b699598fd33f85f7877456b1d28b4d032e2a1a16807947c",
      "webcrypto.d.ts": "e56b2ea68f6b6b21e14ed99b2520bc754ac900c178d23fe7d6d451ae2a7d12c8",
      "webcrypto.js": "83f476a634233b999ce6e6cd67dc03e64f07b8d5a826e67ad4a50c940d9ce7ee"
    }
  }
};
