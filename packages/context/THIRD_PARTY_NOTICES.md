# Third-party notices

These notices accompany `@forgesworn/context@0.2.0`. The package itself is
MIT licensed, Copyright (c) 2026 TheCryptoDonkey; see `LICENSE`.

Runtime dependencies are installed separately by the package manager, not
bundled into this tarball. Their licences remain their own. The verbatim
notices below cover direct runtime dependencies; retain the licence files
from transitive dependencies as well when redistributing an installation or
bundle. Dependency versions and source links refer to this release.

## @noble/ciphers@2.1.1

Declared licence: MIT. Source package: https://www.npmjs.com/package/@noble/ciphers/v/2.1.1

```text
The MIT License (MIT)

Copyright (c) 2022 Paul Miller (https://paulmillr.com)
Copyright (c) 2016 Thomas Pornin <pornin@bolet.org>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the “Software”), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## @noble/hashes@1.8.0

Declared licence: MIT. Source package: https://www.npmjs.com/package/@noble/hashes/v/1.8.0

```text
The MIT License (MIT)

Copyright (c) 2022 Paul Miller (https://paulmillr.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the “Software”), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## nostr-tools@2.25.0

Declared licence: Unlicense. Source package: https://www.npmjs.com/package/nostr-tools/v/2.25.0

```text
This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or
distribute this software, either in source code form or as a compiled
binary, for any purpose, commercial or non-commercial, and by any
means.

In jurisdictions that recognize copyright laws, the author or authors
of this software dedicate any and all copyright interest in the
software to the public domain. We make this dedication for the benefit
of the public at large and to the detriment of our heirs and
successors. We intend this dedication to be an overt act of
relinquishment in perpetuity of all present and future rights to this
software under copyright law.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.

For more information, please refer to <https://unlicense.org>
```

## Wildbloom format and conformance data

The envelope implementation was extracted from KithMoot and follows the
Wildbloom FSWNENC2 specification. Both projects carry the MIT notice
Copyright (c) 2026 TheCryptoDonkey, preserved in this package. FSWNENC2 is
the ForgeSworn encryption version 2 file marker; it is a format identifier,
not a separate encryption algorithm.

Specification and Unicode fixture source:
https://github.com/forgesworn/wildbloom/tree/8d4dcda0a0592b676e70064344d73637652f3b9d

Synthetic conformance fixtures live in the source repository, not the npm
tarball. The fixture directory records its source and licence.

## Transitive dependency: nostr-wasm@0.1.0

`nostr-tools@2.25.0` declares this dependency. This context package imports
`nostr-tools/pure` and `nostr-tools/nip44`, which do not load its WASM module.
The npm dependency installation can nevertheless contain `nostr-wasm`.

Its published manifest declares MIT and names fiatjaf as author. Neither the
0.1.0 npm artifact nor its recorded source revision supplies a licence file
or a wrapper copyright notice. We do not invent one or claim that this
notice repairs the upstream omission. Redistributors bundling that WASM
module must resolve the wrapper notice with its maintainer.

Published source revision:
https://github.com/fiatjaf/nostr-wasm/tree/8c65c3e1a2e5d7615f23727a882d3285c767c313

That revision references the unmodified libsecp256k1 submodule at
`77af1da9f631fa622fb5b5895fd27be431432368`. Its original `COPYING` follows:
https://github.com/bitcoin-core/secp256k1/blob/77af1da9f631fa622fb5b5895fd27be431432368/COPYING

```text
Copyright (c) 2013 Pieter Wuille

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
