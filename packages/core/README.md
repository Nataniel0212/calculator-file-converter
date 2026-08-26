# calcconv-core

File format codecs for Casio fx-9860G and TI-83/84 graphing calculators.

Zero dependencies, no build step: plain ES modules that run unchanged in Node
and in a browser via `<script type="module">`. Everything works on `Uint8Array`
and plain strings.

```sh
npm install calcconv-core
```

```js
import { decodeG1e, encodeG1e, decode8xp, encode8xp, decode8xl } from 'calcconv-core';

const doc = decodeG1e(bytes);        // { heading, lines, warnings }
doc.lines.push('NEW LINE');
encodeG1e(doc).bytes;

const program = decode8xp(bytes);    // { name, text, meta, warnings }
encode8xp(program).bytes;            // identical to `bytes`

const list = decode8xl(bytes);       // { name, values, meta, warnings }
```

## What it reads and writes

| Format | Extension |
| --- | --- |
| Casio e-Activity document | `.g1e` |
| TI-83/84 program | `.8xp` `.83p` `.82p` |
| TI-83/84 list | `.8xl` |
| TI-83/84 matrix | `.8xm` |

Round-trips are byte-exact against files the manufacturers' own software wrote,
and the test suite checks exactly that.

## Two rules the codecs keep

**Decoding is lossless, and where losslessness needs help it is verified rather
than assumed.** Bytes with no known meaning survive a round trip untouched. For
TI-BASIC, whose text form is genuinely ambiguous, the decoder checks every token
it writes and marks a boundary where the text would otherwise read as something
else — so plain longest-match cannot silently turn `pin` into `πn`.

**Encoding reports rather than guesses.** A character the calculator cannot
show, a number outside its range, a name it will not accept, a token that needs
a newer model: each produces a warning naming the thing and the line it was on,
rather than a quiet substitution.

## Documentation

- [The `.g1e` format](https://github.com/Nataniel0212/calculator-file-converter/blob/main/docs/G1E-FORMAT.md) — worked out from data files; there was no public specification
- [The `.8xp` format](https://github.com/Nataniel0212/calculator-file-converter/blob/main/docs/8XP-FORMAT.md) — the container, and why text to tokens is the hard direction

Token names come from the [TI-Toolkit token sheets](https://github.com/TI-Toolkit/tokens) (CC0).

MIT licensed. Not affiliated with, endorsed by, or sponsored by the
manufacturers of the calculators whose files it reads.
