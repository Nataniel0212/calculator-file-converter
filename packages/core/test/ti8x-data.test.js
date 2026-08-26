import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

import {
  decodeReal,
  encodeReal,
  decode8xl,
  encode8xl,
  decode8xm,
  encode8xm,
  parseNumericCsv,
  toCsv,
  toNumber,
  listNameBytes,
  matrixNameBytes,
  readVarName,
} from '../src/ti8x-data.js';
import { VarType, readVarFile } from '../src/ti8x.js';

/** Fourteen significant digits is everything the format holds. */
const stored = (n) => Number(n.toPrecision(14));

test('the documented worked example decodes to its documented value', () => {
  // From the TI-83 Plus assembly tutorials, day 18.
  const bytes = Uint8Array.from([0x00, 0x9e, 0x23, 0x91, 0x80, 0x55, 0x75, 0x00, 0x00]);
  assert.equal(decodeReal(bytes, 0).value, 2.391805575e30);
});

test('numbers survive a round-trip to fourteen digits', () => {
  const probes = [
    0, 1, -1, 0.5, -42.1337, 999, 3.1415926535898, 0.1, 1 / 3,
    1e-99, 9.999999999999e99, -0.000001234, 123456789012345, 2.391805575e30,
  ];
  for (const value of probes) {
    const { bytes, warning } = encodeReal(value);
    assert.equal(warning, undefined, `${value} warned unexpectedly`);
    assert.equal(decodeReal(bytes, 0).value, stored(value), `${value} did not survive`);
  }
});

test('zero is stored the way the calculator stores it', () => {
  const { bytes } = encodeReal(0);
  assert.deepEqual(bytes, Uint8Array.from([0, 0x80, 0, 0, 0, 0, 0, 0, 0]));
  assert.equal(decodeReal(bytes, 0).value, 0);
});

test('numbers the calculator cannot hold are reported, not silently mangled', () => {
  for (const value of [1e100, -1e100, NaN, Infinity]) {
    const { warning } = encodeReal(value);
    assert.ok(warning, `${value} should have warned`);
  }
  assert.ok(encodeReal(1e100).warning.includes('range'));
  assert.ok(encodeReal(NaN).warning.includes('not a number'));
});

test('a decimal fraction stays exact, because the format is decimal', () => {
  // 0.1 is not representable in binary floating point but is exact here.
  const { bytes } = encodeReal(0.1);
  assert.equal(decodeReal(bytes, 0).value, 0.1);
  assert.equal(bytes[1], 0x80 - 1);
  assert.equal(bytes[2], 0x10);
});

test('lists round-trip through the file format', () => {
  const values = [-1, 0, 2, 999, 0.5, -0.001];
  const { bytes, warnings } = encode8xl({ name: 'L3', values });
  assert.deepEqual(warnings, []);

  const back = decode8xl(bytes);
  assert.equal(back.name, 'L3');
  assert.deepEqual(back.values, values);
  assert.deepEqual(back.warnings, []);
  assert.equal(readVarFile(bytes).type, VarType.LIST);
});

test('matrices round-trip, rows and columns the right way round', () => {
  // Deliberately not square: a transposed writer would pass a square test.
  const rows = [
    [1, 2, 3, 4],
    [5, 6, 7, 8],
  ];
  const { bytes } = encode8xm({ name: '[C]', rows });
  const back = decode8xm(bytes);

  assert.equal(back.name, '[C]');
  assert.deepEqual(back.rows, rows);
  // Columns are stored first, then rows — check the bytes, not just the trip.
  const { data } = readVarFile(bytes);
  assert.equal(data[0], 4, 'first byte should be the column count');
  assert.equal(data[1], 2, 'second byte should be the row count');
});

test('list names use the token for L1-L6 and ASCII for the rest', () => {
  assert.deepEqual(listNameBytes('L1'), Uint8Array.from([0x5d, 0, 0, 0, 0, 0, 0, 0]));
  assert.deepEqual(listNameBytes('L6'), Uint8Array.from([0x5d, 5, 0, 0, 0, 0, 0, 0]));
  assert.deepEqual(listNameBytes('ABC'), Uint8Array.from([0x5d, 65, 66, 67, 0, 0, 0, 0]));
  // Names are at most five characters and must start with a letter.
  assert.equal(readVarName(listNameBytes('TOOLONGNAME'), VarType.LIST), 'TOOLO');
  assert.equal(readVarName(listNameBytes('9LIVES'), VarType.LIST), 'L9LIV');
});

test('matrix names map to the calculator letters', () => {
  assert.deepEqual(matrixNameBytes('[A]'), Uint8Array.from([0x5c, 0, 0, 0, 0, 0, 0, 0]));
  assert.deepEqual(matrixNameBytes('[J]'), Uint8Array.from([0x5c, 9, 0, 0, 0, 0, 0, 0]));
  assert.equal(readVarName(matrixNameBytes('C'), VarType.MATRIX), '[C]');
});

test('the calculator limits are enforced', () => {
  assert.throws(() => encode8xl({ values: new Array(1000).fill(0) }), /at most 999/);
  assert.throws(() => encode8xm({ rows: [[1, 2], [3]] }), /same number of columns/);
  assert.throws(() => encode8xm({ rows: new Array(100).fill([1]) }), /99 by 99/);
});

test('the wrong variable type is refused by name', () => {
  const list = encode8xl({ values: [1] }).bytes;
  assert.throws(() => decode8xm(list), /holds a list, not a matrix/);
  const matrix = encode8xm({ rows: [[1]] }).bytes;
  assert.throws(() => decode8xl(matrix), /holds a matrix, not a list/);
});

test('exact forms are reported rather than read as wrong numbers', () => {
  const { bytes } = encode8xl({ values: [1, 2] });
  const { data } = readVarFile(bytes);
  data[2] = 0x20; // mark the first element as an exact multiple of pi
  const back = decode8xl(bytes);
  assert.equal(back.values[0], null);
  assert.ok(back.warnings.some((w) => w.includes('multiple of pi')));
});

// --- CSV -------------------------------------------------------------------

test('a plain column of numbers reads as one column', () => {
  assert.deepEqual(parseNumericCsv('1\n2\n3\n').rows, [[1], [2], [3]]);
});

test('a row of labels is recognised and set aside', () => {
  const { rows, skippedHeader } = parseNumericCsv('height;weight\n1.5;60\n1.7;70\n');
  assert.deepEqual(skippedHeader, ['height', 'weight']);
  assert.deepEqual(rows, [[1.5, 60], [1.7, 70]]);
});

test('semicolons and tabs win over commas, because that is why they are there', () => {
  assert.deepEqual(parseNumericCsv('1,5;2,5\n3,5;4,5\n').rows, [[1.5, 2.5], [3.5, 4.5]]);
  assert.deepEqual(parseNumericCsv('1\t2\n3\t4\n').rows, [[1, 2], [3, 4]]);
});

test('a column of decimal commas is read as decimals, and says so', () => {
  const { rows, warnings } = parseNumericCsv('langd\n1,5\n1,7\n1,62\n');
  assert.deepEqual(rows, [[1.5], [1.7], [1.62]]);
  assert.ok(warnings.some((w) => w.includes('single column')));
});

test('the genuinely ambiguous comma case is decided out loud', () => {
  // `1,234` is one number in Sweden and two in a two-column file. Both
  // readings get a note saying which was taken and how to force the other.
  const grouped = parseNumericCsv('1,234\n5,678\n');
  assert.deepEqual(grouped.rows, [[1, 234], [5, 678]]);
  assert.ok(grouped.warnings.some((w) => w.includes('semicolons')));
});

test('cells are read the way spreadsheets in different places write them', () => {
  assert.equal(toNumber('1234.5'), 1234.5);
  assert.equal(toNumber('1 234,5'), 1234.5);
  assert.equal(toNumber('1,234.5'), 1234.5);
  assert.equal(toNumber('1.234,5'), 1234.5);
  assert.equal(toNumber('−3'), -3); // a real minus sign, not a hyphen
  assert.equal(toNumber('50%'), 0.5);
  assert.equal(toNumber('1e3'), 1000);
  assert.equal(toNumber('abc'), null);
  assert.equal(toNumber(''), null);
});

test('text in a numeric file is reported rather than read as zero in silence', () => {
  const { rows, warnings } = parseNumericCsv('1;abc\n2;3\n');
  assert.deepEqual(rows, [[1, 0], [2, 3]]);
  assert.ok(warnings.some((w) => w.includes('not numbers')));
});

test('ragged rows are reported', () => {
  const { warnings } = parseNumericCsv('1;2\n3;4;5\n');
  assert.ok(warnings.some((w) => w.includes('Row 2')));
});

test('CSV out and back in is stable', () => {
  const rows = [[1, -2.5], [0.1, 999]];
  assert.deepEqual(parseNumericCsv(toCsv(rows)).rows, rows);
});

/**
 * Real list and matrix files, as written by TI's own software.
 *
 *   TI_SAMPLE_FILES=/path/to/folder node --test "packages/core/test/*.test.js"
 */
const samplesDir = process.env.TI_SAMPLE_FILES;
test('re-encoding real list and matrix files is byte-exact', { skip: !samplesDir || !existsSync(samplesDir) }, () => {
  const files = readdirSync(samplesDir).filter((f) => ['.8xl', '.8xm'].includes(extname(f).toLowerCase()));
  let checked = 0;

  for (const file of files) {
    const original = new Uint8Array(readFileSync(join(samplesDir, file)));
    let decoded;
    try {
      decoded = extname(file).toLowerCase() === '.8xl' ? decode8xl(original) : decode8xm(original);
    } catch {
      continue; // complex lists and the like are refused by design
    }
    // A file holding exact forms cannot be written back as plain numbers.
    if (decoded.warnings.some((w) => w.includes('cannot be written'))) continue;

    const { bytes } = extname(file).toLowerCase() === '.8xl'
      ? encode8xl({ name: decoded.name, values: decoded.values, meta: decoded.meta })
      : encode8xm({ name: decoded.name, rows: decoded.rows, meta: decoded.meta });
    assert.deepEqual(bytes, original, `${file} did not re-encode byte-for-byte`);
    checked++;
  }
  assert.ok(checked > 0, 'no plain list or matrix files found in TI_SAMPLE_FILES');
});
