# Third-party notices

Palworld Save Bridge is distributed under GNU GPL version 3 only; see LICENSE.
No Palworld game assets, original player saves or copyrighted game binaries are
included. Pocketpair does not endorse this application.

## Palworld Save Toolkit

Source: https://github.com/zlmitchell/palworld-save-toolkit
Pinned commit: e71370ede118311e1a2b354caadb6d527ca9bcd2
License: GPL-3.0. Included files in `vendor/palworld-save-toolkit/js` are unchanged.
The GVAS parser credits palworld-save-tools (MIT, cheahjs), and the character
adapters credit quadrantbs/palworld-hostfix-toolkit and palworld-save-tools.

## palworld-save-tools

https://github.com/cheahjs/palworld-save-tools
MIT license text is retained in `vendor/licenses/palworld-save-tools-MIT.txt`.
Its archive and save-format work underlies the included JavaScript port.

## uesave-rs

https://github.com/oMaN-Rod/uesave-rs
Schema reference commit: 11b2b4907ef6f34337135faed783fef2e450fcaf (palworld-v1).
MIT, Copyright (c) 2022 Truman Kilen. License retained in
`vendor/licenses/uesave-rs-MIT.txt`. Its modern group, concrete-model, work and item
layouts inform the adapters. Inferred profiles are identified in docs/SAVE_FORMAT_SUPPORT.md.

## ooz-wasm / ooz

https://github.com/SnosMe/ooz-wasm
https://github.com/powzix/ooz
GPL-3.0-or-later. The included `ooz-wasm/index.js` and embedded-WASM build are
unchanged from the ooz-wasm 2.0.0 npm package. License is retained alongside them.
Source and build instructions from ooz-wasm commit
`ebed82851988add824e092dc4db320c8fa39aaca` are included in
`vendor/ooz-source` for source redistribution. The base GVAS parser and its other
adapters remain from the pinned Palworld Save Toolkit commit above.

## Desktop and ZIP dependencies

- Electron: MIT, https://github.com/electron/electron. Electron/Chromium license
  notices are included by the Windows packager.
- yauzl: MIT, https://github.com/thejoshwolfe/yauzl
- yazl: MIT, https://github.com/thejoshwolfe/yazl
- Their runtime dependencies retain their own license files in the packaged modules.

Exact npm versions and integrity hashes are in package-lock.json. Development-only
test, lint and packaging tools are not runtime application dependencies.
