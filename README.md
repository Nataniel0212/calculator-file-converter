# File Converter

Convert graphing calculator files — Casio `.g1e` documents and TI-83/84 `.8xp`
programs — to plain text and back. In the browser, from the command line, or as
a desktop app. No installation, no upload, no limit on how many files you
convert at once.

**[Open the converter →](https://Nataniel0212.github.io/calculator-file-converter/)**

```
 notes.txt  ─┐                        ┌─  NOTES.G1E
 lab.txt    ─┤   drop the folder in   ├─  LAB.G1E
 game.txt   ─┘                        └─  GAME.8xp
```

## Why

For Casio documents, the converter most people use is a Windows program from
2012 that handles **one file at a time**. If you keep revision notes on the
calculator, converting a folder of them is a few hundred clicks.

For TI programs the problem is not effort but correctness. TI-BASIC is stored
as tokens, not text, and turning text back into tokens is ambiguous: the text
`L1` is either the list `L1` or the letter `L` followed by the digit `1`. Tools
resolve this by guessing, which is why a program containing `pin` can come back
containing `πn`. Across the whole token table that guess is wrong for **219 of
the 654 481 possible adjacent token pairs**.

This converter does not guess. It writes text that can only be read one way,
and checks that claim on every token of every file. See
[docs/8XP-FORMAT.md §4](docs/8XP-FORMAT.md#4-why-text--tokens-is-the-hard-direction).

And for getting a column of numbers *onto* a calculator, the free options run
out entirely. TI Connect CE is a desktop install; the Data Import that reads a
CSV directly is in TI-SmartView CE, which is paid. So a spreadsheet column can
become a `.8xl` list here, in a browser, in one step.

It also takes the whole folder, writes the results straight into a folder you
choose, and tells you what will not fit or will not run — the lines too long
for the screen, the characters the Casio cannot display, the tokens that need a
newer TI — before you find out on the calculator. Each format states its limits
next to the control that picks it, so `Å` becoming `A` is something you read
beforehand rather than discover afterwards.

## What it converts

| From | To | Status |
| --- | --- | --- |
| `.g1e` document | `.txt` | ✅ byte-exact, round-trip tested |
| `.txt` | `.g1e` document | ✅ byte-exact, round-trip tested |
| `.8xp` `.83p` `.82p` program | `.txt` (TI-BASIC) | ✅ byte-exact, round-trip tested |
| `.txt` (TI-BASIC) | `.8xp` `.83p` `.82p` program | ✅ byte-exact, round-trip tested |
| `.8xl` list, `.8xm` matrix | `.csv` | ✅ byte-exact, round-trip tested |
| `.csv` | `.8xl` list, `.8xm` matrix | ✅ byte-exact, round-trip tested |

"Byte-exact" means: take a file the manufacturer's own software produced,
decode it, re-encode it from scratch, and every byte matches. The test suite
checks exactly that against real files.

For the TI side it also checks something stronger, and checks it in CI without
needing any files: **every one of the 654 481 adjacent token pairs** survives a
decode/encode round-trip, along with every token alone and 400 random token
streams.

## Three ways to use it

### Browser

Nothing to install. Files are read and written locally — the page makes no
network requests at all, which its Content-Security-Policy enforces rather than
merely promises. Works offline once loaded.

In Chrome and Edge you can pick a destination folder and the files are written
straight into it; the folder is remembered between visits. Firefox has no such
API, so there the results arrive as a download instead.

### Command line

```sh
npx calcconv notes/*.g1e -o text/     # Casio documents to text
npx calcconv games/*.8xp -o text/     # TI programs to TI-BASIC text
npx calcconv data.csv --to 8xl        # a spreadsheet column to a TI list
npx calcconv text/ -o out/            # a whole folder back again
npx calcconv notes/ --dry-run         # see what would happen first
```

| Flag | Meaning |
| --- | --- |
| `-o, --out <dir>` | where to write (default: beside each input) |
| `--to <format>` | what a `.txt` becomes: `g1e`, `8xp`, `83p` or `82p` |
| `--heading <text>` | the title line shown at the top of the document |
| `--no-translit` | fail on characters the calculator lacks instead of substituting |
| `--newline <crlf\|lf>` | line endings for generated `.txt` |
| `--no-header` | leave the `#name` block out of generated `.txt` |
| `-n, --dry-run` | write nothing |

A `.txt` this tool produced from a TI program starts with a small header naming
it, so converting a folder back needs no flags and reproduces the original
bytes:

```
#format: 8xp
#name: GUESSNUM
#comment: Created by TI Connect CE 5.3.0.384

Disp "GUESS"
```

Hand-written TI-BASIC needs no header — `--to 8xp` is enough.

### Desktop

Windows, macOS and Linux builds are attached to each
[release](../../releases). Same interface, in a window, fully offline.

## The formats

`.g1e` has no public specification. [Cahute][cahute], the reference open source
toolset for these formats, documents the container and marks the document body
`Todo: Describe this format`. So this repository contains one:

**[docs/G1E-FORMAT.md](docs/G1E-FORMAT.md)**

It was worked out by comparing documents with the text they were made from —
purely from data files. No manufacturer software was decompiled or
disassembled, and no code from any existing converter was read or reused.

`.8xp` is documented by the community, so **[docs/8XP-FORMAT.md](docs/8XP-FORMAT.md)**
covers the container briefly and spends its length on the part nobody had
written down: why text → tokens is ambiguous, exactly how far the usual
longest-match guess misses, and how to make the question decidable instead.

Token names come from the [TI-Toolkit token sheets][tokens] (CC0).

## Using the codecs in your own project

```js
import { decodeG1e, encodeG1e, decode8xp, encode8xp } from 'calcconv-core';

const doc = decodeG1e(bytes);        // { heading, lines, warnings }
doc.lines.push('NEW LINE');
const { bytes: out } = encodeG1e(doc);

const program = decode8xp(bytes);    // { name, text, meta, warnings }
encode8xp(program).bytes;            // identical to `bytes`
```

Zero dependencies, plain ES modules, no build step — the same files run in Node
and in a browser via `<script type="module">`.

## Development

```sh
node --test "packages/core/test/*.test.js"   # run the tests
node scripts/serve.js                        # web app on localhost:5173
node scripts/sync-core.js                    # refresh apps/web/vendor/core
node scripts/build-tokens.js --fetch         # refresh the TI token table
```

To check the encoders against real calculator files, point the suite at folders
holding them — `.g1e` files with their `.txt` counterparts, and `.8xp` files:

```sh
SAMPLE_FILES=/path/to/casio TI_SAMPLE_FILES=/path/to/ti \
  node --test "packages/core/test/*.test.js"
```

No calculator files are committed to this repository — they are somebody's
notes and somebody's programs, and the `.gitignore` keeps them out.

## Layout

```
packages/core     the codecs — no dependencies, runs anywhere
apps/web          the browser app — no framework, no bundler
apps/cli          calcconv
apps/desktop      desktop shell around the web app
docs              file format notes
```

## Licence and independence

MIT — see [LICENSE](LICENSE).

This is an independent project. It is not affiliated with, endorsed by, or
sponsored by the manufacturers of the calculators whose files it reads.
"fx-9860G", "TI-83" and "TI-84" are used only to say which files the tool
understands. The repository contains no manufacturer software, firmware, or
documentation, and none is required to build or use it.

The TI token table is generated from the [TI-Toolkit token sheets][tokens],
released under CC0.

[cahute]: https://cahute.org/topics/file-formats/eact.html
[tokens]: https://github.com/TI-Toolkit/tokens
