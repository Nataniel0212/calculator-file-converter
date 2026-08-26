# calcconv

Convert graphing calculator files to plain text and back, a folder at a time.

```sh
npx calcconv notes/*.g1e -o text/     # Casio documents to text
npx calcconv games/*.8xp -o text/     # TI programs to TI-BASIC text
npx calcconv data.csv --to 8xl        # a spreadsheet column to a TI list
npx calcconv text/ -o out/            # a whole folder back again
```

| From | To |
| --- | --- |
| `.g1e` Casio fx-9860G document | `.txt` |
| `.8xp` `.83p` `.82p` TI-83/84 program | `.txt` (TI-BASIC) |
| `.8xl` list, `.8xm` matrix | `.csv` |
| `.txt` | any of the above — see `--to` |
| `.csv` | `.8xl` if one column, `.8xm` if several |

Every conversion is byte-exact: decode a file the manufacturer's own software
wrote, re-encode it from scratch, and every byte matches.

TI-BASIC is stored as tokens rather than text, and turning text back into
tokens is ambiguous — `L1` is either the list `L1` or the letter `L` followed
by a `1`. Tools resolve this by guessing, which is why a program containing
`pin` can come back containing `πn`. This one writes text that can only be read
one way, and checks that on every token of every file. Half of a sample of real
published programs contain at least one place where the guess would be wrong.

Run `calcconv --help` for every flag.

**[Full documentation, and the browser and desktop versions →](https://github.com/Nataniel0212/calculator-file-converter)**

MIT licensed. Not affiliated with, endorsed by, or sponsored by the
manufacturers of the calculators whose files it reads.
