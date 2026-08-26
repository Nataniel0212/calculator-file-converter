# The .g1e document format

Reverse-engineered specification for the document files used by fx-9860G
series graphing calculators.

This document exists because no public specification does. [Cahute][cahute], the
reference open-source toolset for these formats, documents the outer container
but leaves the document body as `Todo: Describe this format`.

Everything below was derived by analysing `.g1e` files together with the plain
text they were produced from — no manufacturer software was decompiled or
disassembled, and no code from any existing converter was read or reused. The spec is validated by a
byte-exact round-trip test (`packages/core/test/g1e.test.js`): decode a real
`.g1e` file, re-encode it from scratch, and compare — every byte matches.

All integers are **big-endian**.

---

## 1. Layout at a glance

```
 offset  size  contents
 ------  ----  --------------------------------------------------
 0x0000    32  Standard container header (stored bitwise-inverted)
 0x0020    68  Subheader
 0x0064    20  Group header      "@EACT"
 0x0078    16  Item header       "EACT1"
 0x0088     n  document body     <- the interesting part
```

## 2. Standard header (0x00–0x1F)

The 32 bytes are stored **bitwise inverted**: every byte on disk is `~b & 0xFF`.
De-obfuscate the block first, then read the fields below.

| offset | size | value |
| --- | --- | --- |
| 0x00 | 8 | `"USBPower"` |
| 0x08 | 1 | file type — `0x49` for a document |
| 0x09 | 5 | `00 10 00 10 00` |
| 0x0E | 1 | control byte 1 = `(fileSize + 0x41) & 0xFF` |
| 0x0F | 1 | `0x01` |
| 0x10 | 4 | total file size in bytes |
| 0x14 | 1 | control byte 2 = `(fileSize + 0xB8) & 0xFF` |
| 0x15 | 11 | `0xFF` padding |

The two control bytes are the only integrity check in the file; there is **no
trailing checksum**. The final bytes of the file are simply the alignment
padding of the last text line.

## 3. Subheader (0x20–0x63)

| offset | size | value |
| --- | --- | --- |
| 0x20 | 4 | total file size (again) |
| 0x24 | 4 | `0x00000038` — offset of the group header area |
| 0x28 | 4 | `0x00010100` |
| 0x2C | 4 | `"Pack"` |
| 0x30 | 6 | zero |
| 0x36 | 5 | `14 2a 3f 02 c0` — constant in every sample observed |
| 0x3B | 5 | `00 00 00 38 20` |
| 0x40 | 36 | mostly `0x01` filler, then zero |

Nothing here varies between files except the size field, so an encoder can
carry the block verbatim from a template.

## 4. Group and item headers

```
 0x0064   4 B   zero
 0x0068   8 B   "@EACT" padded with NUL     <- group name
 0x0070   4 B   item count (1)
 0x0074   4 B   group data size = fileSize - 0x78

 0x0078   8 B   "EACT1" padded with NUL     <- item name
 0x0080   4 B   0x00000014
 0x0084   4 B   item data size = fileSize - 0x88 - 4
```

Note the `- 4` in the item data size: the field excludes the four zero bytes
that follow the line table (see §5). This asymmetry is real — dropping it
produces a file that differs from the original tooling's output in exactly one byte.

## 5. Document body (from 0x0088)

Let `DATA = 0x0088`. All offsets in this section are relative to `DATA`.

| offset | size | contents |
| --- | --- | --- |
| +0x00 | 4 | magic `d4 00 00 66` |
| +0x04 | 4 | line count `n` |
| +0x08 | 4·n | line table |
| | 4 | zero |
| | … | line text blocks |

### 5.1 Line table

Each entry is one 32-bit word:

```
 31    24 23                     0
+--------+-----------------------+
|  type  |        offset         |
+--------+-----------------------+
```

* `type` — `0x07` for the first entry (the document heading), `0x81` for an
  ordinary text line.
* `offset` — **points four bytes before the text**. The string for entry *i*
  starts at `DATA + offset + 4`. This is the one detail that makes the format
  look scrambled if you assume the offset points at the text itself.

### 5.2 Text blocks

Text blocks follow the four zero bytes after the table, in the same order as
the table. Each block is a NUL-terminated string padded with NUL bytes to a
**4-byte boundary**. An empty line is therefore four zero bytes.

Text is in the calculator's own character set, not Unicode — see
[`CHARSET.md`](CHARSET.md).

### 5.3 The heading line

Entry 0 is the heading shown at the top of the document on the calculator,
and it is *not* part of the document body. Files produced by the older
converter use a decorative default of the form:

```
======NAME    =======
```

padded so the whole heading is 21 characters wide.

---

## 6. Worked example

`INDEX.G1E`, 2616 bytes, 96 entries (1 heading + 95 text lines):

```
0000  aa ac bd af 90 88 9a 8d   ~"USBPower"
0008  b6                        ~0x49  document
000e  86                        ~0x79 = ~((0x0A38 + 0x41) & 0xFF)
0010  ff ff f5 c7               ~0x00000A38 = 2616 bytes
0014  0f                        ~0xF0 = ~((0x0A38 + 0xB8) & 0xFF)
...
0088  d4 00 00 66               body magic
008c  00 00 00 60               96 lines
0090  07 00 01 88               heading, text at 0x88 + 0x188 + 4 = 0x214
0094  81 00 01 a0               line 1,  text at 0x88 + 0x1a0 + 4 = 0x22c
...
0210  00 00 00 00               the four zero bytes
0214  "======INDEX   =======\0\0\0"
022c  "FY041G TERMODYNAMIK\0"
0240  "LOSNINGAR, 3 TENTOR\0"
0254  "\0\0\0\0"                 an empty line
```

---

## 7. Related formats

`.g2e` and `.g3e` (later colour-screen models) share the container but differ
in the body.
They are out of scope here.

[cahute]: https://cahute.org/topics/file-formats/eact.html
