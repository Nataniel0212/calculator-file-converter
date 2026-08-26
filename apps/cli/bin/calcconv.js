#!/usr/bin/env node
/**
 * calcconv — batch converter for graphing calculator files.
 *
 * The direction is inferred from each input's extension, so you can throw a
 * mixed pile of files at it:
 *
 *   calcconv notes/*.g1e -o text/
 *   calcconv games/*.8xp -o text/
 *   calcconv text/*.txt  -o notes/
 *   calcconv notes/                 # a whole folder, in place
 */

import { readFileSync, writeFileSync, statSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join, extname, basename, dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  decodeG1e,
  encodeG1e,
  defaultHeading,
  decode8xp,
  encode8xp,
  programToText,
  textToProgram,
  decode8xl,
  encode8xl,
  decode8xm,
  encode8xm,
  parseNumericCsv,
  toCsv,
} from 'calcconv-core';

const USAGE = `calcconv — convert graphing calculator files to text and back

Usage
  calcconv <files or folders...> [options]

Options
  -o, --out <dir>       write results here (default: next to each input)
      --to <format>     what a .txt becomes: g1e, 8xp, 83p or 82p.
                        Default: whatever the file's own #format header says,
                        otherwise g1e.
                        For a .csv: 8xl or 8xm. Default: one column of numbers
                        becomes a list, several columns become a matrix
      --name <name>     what the calculator calls the result: L1-L6 or up to
                        five characters for a list, A-J for a matrix
      --heading <text>  heading line shown at the top of the .g1e
                        (default: a ======NAME    ======= banner)
      --no-translit     fail loudly on characters the calculator lacks
                        instead of substituting the closest match
      --newline <crlf|lf>  line endings for generated .txt (default: crlf)
      --no-header       omit the #name/#comment block from generated .txt
                        (smaller files, but no longer byte-exact coming back)
  -n, --dry-run         show what would happen, write nothing
  -q, --quiet           only report errors
  -h, --help            this text

Conversions
  .g1e              ->  .txt    Casio fx-9860G document to plain text
  .8xp .83p .82p    ->  .txt    TI-83/84 program to TI-BASIC text
  .8xl              ->  .csv    TI-83/84 list to a column of numbers
  .8xm              ->  .csv    TI-83/84 matrix to rows of numbers
  .txt              ->  either  see --to
  .csv              ->  .8xl or .8xm
`;

/** Extensions that hold a TI program, and the signature each implies. */
const TI_EXTENSIONS = ['.8xp', '.83p', '.82p'];

/** Extensions that hold numbers rather than text. */
const DATA_EXTENSIONS = ['.8xl', '.8xm'];

/** @type {import('node:util').ParseArgsConfig['options']} */
const options = {
  out: { type: 'string', short: 'o' },
  to: { type: 'string' },
  name: { type: 'string' },
  heading: { type: 'string' },
  'no-translit': { type: 'boolean', default: false },
  newline: { type: 'string', default: 'crlf' },
  'no-header': { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', short: 'n', default: false },
  quiet: { type: 'boolean', short: 'q', default: false },
  help: { type: 'boolean', short: 'h', default: false },
};

let parsed;
try {
  parsed = parseArgs({ options, allowPositionals: true });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
// parseArgs types every value as string|boolean|array regardless of what the
// option declared, and these are read by name throughout. A loose bag, typed
// as one, rather than a narrowing cast at each of a dozen uses.
/** @type {Record<string, any>} */
const flags = parsed.values;
const { positionals } = parsed;

if (flags.help || positionals.length === 0) {
  process.stdout.write(USAGE);
  process.exit(positionals.length === 0 && !flags.help ? 1 : 0);
}

const newline = flags.newline === 'lf' ? '\n' : '\r\n';
const TARGETS = ['g1e', '8xp', '83p', '82p', '8xl', '8xm'];
if (flags.to && !TARGETS.includes(flags.to)) {
  fail(`--to must be one of ${TARGETS.join(', ')} (got "${flags.to}")`);
}

const inputs = positionals.flatMap(expand);
if (inputs.length === 0) {
  fail(`No convertible files found (.g1e, ${[...TI_EXTENSIONS, ...DATA_EXTENSIONS].join(', ')}, .txt or .csv).`);
}

let converted = 0;
let failed = 0;

for (const input of inputs) {
  try {
    convert(input);
    converted++;
  } catch (error) {
    failed++;
    console.error(`  ${basename(input)}: ${error instanceof Error ? error.message : error}`);
  }
}

if (!flags.quiet) {
  const verb = flags['dry-run'] ? 'would convert' : 'converted';
  console.log(`\n${verb} ${converted} file${converted === 1 ? '' : 's'}` + (failed ? `, ${failed} failed` : ''));
}
process.exit(failed ? 1 : 0);

// ---------------------------------------------------------------------------

/** Expand a folder into the convertible files it holds. */
function expand(path) {
  const full = resolve(path);
  if (!existsSync(full)) fail(`${path}: no such file or folder`);
  if (!statSync(full).isDirectory()) return [full];
  return readdirSync(full)
    .map((name) => join(full, name))
    .filter((file) => !statSync(file).isDirectory() && isConvertible(file));
}

function isConvertible(file) {
  const ext = extname(file).toLowerCase();
  return ext === '.g1e' || ext === '.txt' || ext === '.csv'
    || TI_EXTENSIONS.includes(ext) || DATA_EXTENSIONS.includes(ext);
}

function convert(input) {
  const ext = extname(input).toLowerCase();
  const stem = basename(input, extname(input));
  const outDir = flags.out ? resolve(flags.out) : dirname(input);

  if (ext === '.g1e') return g1eToTxt(input, stem, outDir);
  if (TI_EXTENSIONS.includes(ext)) return tiToTxt(input, stem, outDir);
  if (DATA_EXTENSIONS.includes(ext)) return dataToCsv(input, stem, outDir, ext);
  if (ext === '.csv') return csvToData(input, stem, outDir);
  if (ext === '.txt') {
    // A .txt produced by this tool says what it came from; otherwise --to, and
    // failing that the Casio format the converter started life with.
    const raw = readFileSync(input, 'utf8').replace(/^﻿/, '');
    const declared = /^#format:[ \t]?(\S+)/m.exec(raw.split('\n', 1)[0])?.[1];
    const target = flags.to ?? declared ?? 'g1e';
    return target === 'g1e'
      ? txtToG1e(input, stem, outDir, raw)
      : txtToTi(input, stem, outDir, raw, target);
  }

  throw new Error(`don't know how to convert ${ext} files`);
}

function g1eToTxt(input, stem, outDir) {
  const doc = decodeG1e(new Uint8Array(readFileSync(input)));
  const text = doc.lines.join(newline) + newline;
  const target = join(outDir, stem + '.txt');
  report(input, target, doc.warnings, `${doc.lines.length} lines`);
  if (!flags['dry-run']) write(target, Buffer.from(text, 'latin1'));
}

function txtToG1e(input, stem, outDir, raw) {
  const lines = raw.split(/\r\n|\r|\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const heading = flags.heading ?? defaultHeading(stem);
  const { bytes, warnings } = encodeG1e({ heading, lines }, { transliterate: !flags['no-translit'] });
  if (flags['no-translit'] && warnings.length) {
    throw new Error(warnings[0].replace(/^Line \d+: |^Heading: /, ''));
  }
  // Upper case throughout, matching what the calculator shows in its
  // storage memory listing.
  const target = join(outDir, stem.toUpperCase().slice(0, 8) + '.G1E');
  report(input, target, warnings, `${lines.length} lines, ${bytes.length} bytes`);
  if (!flags['dry-run']) write(target, Buffer.from(bytes));
}

function tiToTxt(input, stem, outDir) {
  const program = decode8xp(new Uint8Array(readFileSync(input)));
  const text = programToText(program, { newline, header: !flags['no-header'] });
  const target = join(outDir, stem + '.txt');
  const lines = program.text ? program.text.split('\n').length : 0;
  report(input, target, program.warnings, `${program.name}, ${lines} lines`);
  // Token names include accented letters (ì, é, ñ), so these files are UTF-8 —
  // unlike the .g1e side, whose text is the calculator's own byte-per-glyph set.
  if (!flags['dry-run']) write(target, Buffer.from(text, 'utf8'));
}

function txtToTi(input, stem, outDir, raw, format) {
  const program = textToProgram(raw, { name: stem });
  // An explicit --to wins over whatever the file's own header claimed.
  const meta = { ...program.meta, ...(flags.to ? signatureFor(format) : {}) };
  const { bytes, warnings } = encode8xp({ ...program, meta });
  if (flags['no-translit'] && warnings.length) {
    throw new Error(warnings[0].replace(/^line \d+: /, ''));
  }
  const target = join(outDir, program.name + '.' + format);
  report(input, target, warnings, `${program.name}, ${bytes.length} bytes`);
  if (!flags['dry-run']) write(target, Buffer.from(bytes));
}

function dataToCsv(input, stem, outDir, ext) {
  const bytes = new Uint8Array(readFileSync(input));
  // Kept apart rather than folded into one expression: a list yields values
  // and a matrix yields rows, and pretending they are the same shape is how
  // one of them ends up read as the other.
  let name, rows, warnings, shape;
  if (ext === '.8xl') {
    const list = decode8xl(bytes);
    ({ name, warnings } = list);
    rows = list.values.map((value) => [value]);
    shape = `${rows.length} values`;
  } else {
    const matrix = decode8xm(bytes);
    ({ name, rows, warnings } = matrix);
    shape = `${rows.length}x${rows[0]?.length ?? 0}`;
  }

  const target = join(outDir, stem + '.csv');
  report(input, target, warnings, `${name}, ${shape}`);
  if (!flags['dry-run']) write(target, Buffer.from(toCsv(rows, { newline }), 'utf8'));
}

function csvToData(input, stem, outDir) {
  const raw = readFileSync(input, 'utf8');
  const { rows, warnings, skippedHeader } = parseNumericCsv(raw);
  if (!rows.length) throw new Error('no numbers found in this file');

  // One column of numbers is a list; several are a matrix. Anyone who wants
  // the other reading says so with --to.
  const columns = rows[0].length;
  const format = flags.to === '8xl' || flags.to === '8xm' ? flags.to : columns === 1 ? '8xl' : '8xm';

  if (skippedHeader.length) {
    warnings.push(`Ignored the first row (${skippedHeader.join(', ')}) — the calculator holds numbers only.`);
  }

  const name = flags.name ?? stem;
  const result = format === '8xl'
    ? encode8xl({ name, values: rows.map((row) => row[0]) })
    : encode8xm({ name, rows });
  warnings.push(...result.warnings);

  if (format === '8xl' && columns > 1) {
    warnings.push(`Only the first of ${columns} columns became the list; --to 8xm keeps all of them.`);
  }

  const target = join(outDir, stem + '.' + format);
  const shape = format === '8xl' ? `${rows.length} values` : `${rows.length}x${columns}`;
  report(input, target, warnings, `${shape}, ${result.bytes.length} bytes`);
  if (!flags['dry-run']) write(target, Buffer.from(result.bytes));
}

function signatureFor(format) {
  const signatures = { '8xp': '**TI83F*', '83p': '**TI83**', '82p': '**TI82**' };
  return { signature: signatures[format] };
}

function write(target, buffer) {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, buffer);
}

function report(input, target, warnings, detail) {
  if (!flags.quiet) {
    console.log(`${basename(input)} -> ${basename(target)}  (${detail})`);
    for (const warning of warnings) console.log(`   ! ${warning}`);
  }
}

/**
 * @param {string} message
 * @returns {never} this never comes back — the process ends here
 */
function fail(message) {
  console.error(`calcconv: ${message}`);
  process.exit(1);
}
