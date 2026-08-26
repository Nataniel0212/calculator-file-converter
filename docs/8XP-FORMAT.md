# The .8xp program format

Specification for the program files used by TI-83 and TI-84 series graphing
calculators, and for the text representation this converter reads and writes.

The container half of this is well documented by the community and is written
down here only so the codec has one page to point at. The half that matters is
[§4](#4-why-text--tokens-is-the-hard-direction): turning text back into tokens
is genuinely ambiguous, every widely used converter gets some of it wrong, and
this document sets out what "wrong" means and how the ambiguity is removed.

The container was checked against 18 files produced by TI Connect CE, TI-Tools
and TokenIDE: decode each one, re-encode it from scratch, compare. Every byte
matches. The test lives in `packages/core/test/ti8x.test.js`.

All integers are **little-endian** — the opposite of the Casio formats in
[G1E-FORMAT.md](G1E-FORMAT.md).

---

## 1. Layout at a glance

```
 offset  size  contents
 ------  ----  --------------------------------------------------
 0x0000    11  Signature and separator
 0x000B    42  Comment, NUL padded
 0x0035     2  Length of the data section
 0x0037     n  Data section: one variable entry
      +n     2  Checksum
```

## 2. File header (0x00–0x36)

| offset | size | value |
| --- | --- | --- |
| 0x00 | 8 | signature — see below |
| 0x08 | 2 | `1A 0A` |
| 0x0A | 1 | varies by writing tool: `00`, `0A` and `13` all occur |
| 0x0B | 42 | comment, e.g. `Created by TI Connect CE 5.3.0.384` |
| 0x35 | 2 | size of the data section, excluding the checksum |

| signature | calculator | extension |
| --- | --- | --- |
| `**TI83F*` | TI-83+ / TI-84+ family | `.8xp` |
| `**TI83**` | TI-83 | `.83p` |
| `**TI82**` | TI-82 | `.82p` |

Byte 0x0A carries no meaning this converter has been able to find, but it
differs between tools, so it is preserved rather than normalised. Same for the
comment: rewriting it would change the file without being asked to.

## 3. Variable entry (from 0x37)

| offset | size | value |
| --- | --- | --- |
| +0x00 | 2 | header size: `0x0B` on older files, `0x0D` on current ones |
| +0x02 | 2 | variable data size = program length + 2 |
| +0x04 | 1 | type — `0x05` program, `0x06` edit-protected program |
| +0x05 | 8 | name, NUL padded, upper case |
| +0x0D | 1 | version (only when the header size is `0x0D`) |
| +0x0E | 1 | `0x80` when archived, `0x00` when in RAM |
| +.. | 2 | variable data size again |
| +.. | 2 | program length in bytes |
| +.. | n | the token stream |

The duplicated size field is not redundant in practice — it is what the link
protocol sends — but nothing is gained by disagreeing with it, so the encoder
writes the same number twice and the decoder warns if a file does not.

**Checksum.** The two bytes after the data section hold the low 16 bits of the
sum of every byte in it:

```js
let sum = 0;
for (let i = 0x37; i < 0x37 + dataSize; i++) sum = (sum + bytes[i]) & 0xffff;
```

A mismatch is reported as a warning, not an error. A file with a bad checksum is
usually still readable, and refusing to look at it helps nobody.

## 4. Why text → tokens is the hard direction

TI-BASIC is not stored as text. `Disp ` is one byte, `DelVar ` is one byte, the
list `L1` is two bytes, and the letter `L` followed by the digit `1` is two
different bytes. The calculator never converts text to tokens; you press keys,
and each key *is* a token. Converters have to invent the reverse, and it is not
well defined.

Going **tokens → text** is exact: every byte sequence has one name.

Going **text → tokens** is ambiguous, because token names concatenate into
other token names:

| the text | reads as | or as |
| --- | --- | --- |
| `L1` | the list `L1` (`5D 00`) | `L` then `1` (`4C 31`) |
| `->` | the store arrow (`04`) | `-` then `>` (`71 6C`) |
| `!=` | not-equals (`6F`) | `!` then `=` (`2D 6A`) |
| `FV` | the finance variable `FV` (`63 2F`) | `F` then `V` (`46 56`) |

The usual answer is longest-match: always take the longest name that fits. It
is a reasonable default and it is what most tools do, but it is a guess, and
sometimes the guess is wrong. This is the well-known bug where a program
containing `pin` comes back as `πn` — reported against Cemetech's SourceCoder,
and [described in detail by taricorp][taricorp], who notes that the tokeniser's
design makes it hard to fix.

Measured against the whole table of 809 tokens, longest-match reads **219 of
the 654 481 possible adjacent token pairs** as something other than what they
were.

### The fix: verified decoding

This codec does not improve the guess. It removes the need to guess, by making
the *decoder* responsible for producing text that can only be read one way.

When writing a token's name, the decoder first checks whether appending it
would still read back as that token, leaving the tokens before it intact. If it
would not, the decoder writes a boundary marker first:

```
tokens 4C 31   ->   text  L\.1     (not "L1", which would read as the list)
tokens 5D 00   ->   text  L1
```

The check runs on every token of every file, so the round-trip guarantee is
established by construction rather than assumed. The cost is a look-back of at
most 20 characters — the longest token name — per token.

This mirrors the rule in `charset.js` on the Casio side: decoding is lossless,
and where losslessness needs help, the decoder says so explicitly instead of
letting the encoder guess later.

### Escapes

A backslash always opens an escape, and the character after it decides which.
Nothing after a backslash is read as a token, so no escape can be confused with
program text.

| written | means |
| --- | --- |
| `\\` | the backslash token itself |
| `\.` | a boundary: the tokens either side are separate. Contributes no bytes |
| `\xNN` | a byte the token table has no name for (`\xNNNN` after a two-byte prefix) |

`\` is the only character that both starts a token name and opens an escape,
which is why the backslash token is always written doubled.

## 5. Tokens

Tokens are one byte, except after one of eleven prefix bytes:

```
5C 5D 5E 60 61 62 63 7E AA BB EF
```

each of which takes a second byte. `BB` covers lower case and most of what the
TI-83+ added; `EF` covers the TI-84+ CSE and CE.

The names come from the [TI-Toolkit token sheets][tokens] (CC0), English
`accessible` spellings — the ASCII ones. The `display` spellings are not usable
here: several tokens share one, so text written with them could not be read
back at all. This is [TI-Toolkit/tokens#22][issue22]. The `accessible` names are
unique across all 809 tokens, and `packages/core/test/ti8x.test.js` asserts it
on every run rather than trusting that it stays true.

Regenerate the table with:

```sh
node scripts/build-tokens.js --fetch
```

## 6. What this codec does not do

- **Assembly programs.** A program starting `AsmPrgm` (`BB 6C`) is machine code,
  not TI-BASIC. It converts and comes back byte-exact, because unnamed bytes
  survive as `\xNN` escapes, but the text is not meaningful to read.
- **Pictures and appvars**, which share this container but not this format.
- **Groups** (`.8xg`), which hold several variables in one data section.

## 7. Lists and matrices

Same container, §2–3, with a different type byte and different contents.

| type | extension | holds |
| --- | --- | --- |
| `0x01` | `.8xl` | a list of real numbers |
| `0x02` | `.8xm` | a matrix of real numbers |

**Names** are not ASCII here. A list's name bytes are `5D` followed by either
an index — `00`–`05` for `L1`–`L6` — or up to five ASCII characters for a list
of your own. A matrix is `5C` followed by `00`–`09`, for `[A]` through `[J]`.

**A list's data** is a 2-byte count, then that many numbers.

**A matrix's data** is one byte of *columns*, one byte of *rows*, then the
numbers **row by row**. Columns come first, which is the opposite order to how
the size is spoken aloud, and both sample files that TI's own tooling produces
are square — so this is the detail to get wrong. The test suite uses a 2×4
matrix for exactly that reason.

### Numbers

Nine bytes each, and **decimal, not binary**:

| offset | size | value |
| --- | --- | --- |
| +0 | 1 | flags — `00` positive, `80` negative |
| +1 | 1 | exponent, biased by `0x80`, so `0x80` is 10⁰ |
| +2 | 7 | fourteen digits, packed two to a byte, one digit before the point |

`00 9E 23 91 80 55 75 00 00` is `2.391805575 × 10³⁰`.

Two consequences worth stating. First, `0.1` is exact — the format stores
digits, not binary fractions — so a converter must round to fourteen
significant digits on the way in rather than hand over whatever a double
happened to hold. Second, the flags byte carries more than a sign: the TI-84+
CE writes `0x1C`, `0x20` and `0x21` for exact radicals and multiples of π, and
`0x0C` for complex numbers. Those are not plain reals, and reading them as if
they were produces numbers like `1.00000300101e-129` out of nowhere. This codec
detects them, leaves the cell empty, and says which form it found.

### CSV

Going out, a list becomes one number per line and a matrix becomes rows.

Coming in, the shape of the file decides: **one column is a list, several are a
matrix**. Nothing to configure, and nothing to get wrong silently — the queue
shows which was chosen before anything is written.

The awkward part is the comma. `1,5` is one number in Sweden and two in a file
from a spreadsheet set to English, and nothing inside the file says which.
A semicolon or a tab settles it, because those are what a spreadsheet writes
when the comma is already the decimal mark; so those win whenever they appear.
When only commas are present the reading is chosen from the shape of the data
and then **stated**, along with how to force the other one. A converter that
guesses silently is how a column of heights becomes a column of nonsense.

[taricorp]: https://www.taricorp.net/2022/ti-basic-unicode-splits/
[tokens]: https://github.com/TI-Toolkit/tokens
[issue22]: https://github.com/TI-Toolkit/tokens/issues/22
