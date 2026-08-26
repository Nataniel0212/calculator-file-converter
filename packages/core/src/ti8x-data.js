/**
 * Codec for TI-83/84 data variables: lists (.8xl) and matrices (.8xm), to and
 * from CSV.
 *
 * Format specification: docs/8XP-FORMAT.md §7
 *
 * Getting a column of numbers onto a TI calculator is a solved problem only if
 * you own the right software: TI Connect CE is a desktop install, and the Data
 * Import feature that reads CSV directly is in TI-SmartView CE, which is paid.
 * There is no free way to turn a spreadsheet column into a list file. That is
 * what this is.
 *
 * Numbers are not IEEE floats. The calculator stores each one as nine bytes:
 * a flags byte, an exponent biased to 0x80, and fourteen decimal digits packed
 * two to a byte. It is a *decimal* format, so 0.1 is exactly 0.1 — which is
 * why a value has to be rounded to fourteen significant digits on the way in
 * rather than copied, and why doing that rounding is not a loss worth warning
 * about.
 */

import { FormatError } from './container.js';
import { VarType, VAR_TYPE_NAMES, readVarFile, writeVarFile } from './ti8x.js';

/** Bytes per stored number. */
const REAL_SIZE = 9;

/** Flags byte values that mean "an ordinary real number". */
const REAL_FLAGS = { POSITIVE: 0x00, NEGATIVE: 0x80 };

/** What the other flags mean, so a file we cannot read says why. */
const FLAG_NAMES = {
  0x0c: 'a complex number',
  0x1c: 'an exact radical',
  0x20: 'an exact multiple of pi',
  0x21: 'an exact fraction of pi',
};

/** The calculator overflows past this; warn rather than write a file it rejects. */
const MAX_EXPONENT = 99;

/** Lists are named L1–L6 by token, or by up to five characters of their own. */
const LIST_PREFIX = 0x5d;
const MATRIX_PREFIX = 0x5c;
const MATRIX_LETTERS = 'ABCDEFGHIJ';

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/**
 * Read one nine-byte number.
 *
 * @param {Uint8Array} bytes
 * @param {number} at
 * @returns {{value: number, flags: number, supported: boolean}}
 */
export function decodeReal(bytes, at) {
  const flags = bytes[at];
  const supported = flags === REAL_FLAGS.POSITIVE || flags === REAL_FLAGS.NEGATIVE;
  if (!supported) return { value: NaN, flags, supported };

  let digits = '';
  for (let i = 0; i < 7; i++) {
    digits += (bytes[at + 2 + i] >> 4).toString(10) + (bytes[at + 2 + i] & 0x0f).toString(10);
  }
  const sign = flags === REAL_FLAGS.NEGATIVE ? '-' : '';
  const exponent = bytes[at + 1] - 0x80;
  // Build the number as text so the fourteen decimal digits are handed to the
  // parser intact, rather than accumulated through arithmetic.
  return { value: Number(`${sign}${digits[0]}.${digits.slice(1)}e${exponent}`), flags, supported };
}

/**
 * Write one nine-byte number.
 *
 * @param {number} value
 * @returns {{bytes: Uint8Array, warning?: string}}
 */
export function encodeReal(value) {
  const out = new Uint8Array(REAL_SIZE);

  if (!Number.isFinite(value)) {
    return { bytes: encodeReal(0).bytes, warning: `${value} is not a number the calculator can hold; wrote 0.` };
  }
  if (value === 0) {
    out[1] = 0x80; // exponent 10^0, mantissa all zero
    return { bytes: out };
  }

  // toExponential(13) gives one digit before the point and thirteen after:
  // exactly the fourteen the format stores, correctly rounded.
  const [mantissa, exponentText] = Math.abs(value).toExponential(13).split('e');
  const digits = mantissa.replace('.', '');
  const exponent = Number(exponentText);

  let warning;
  if (Math.abs(exponent) > MAX_EXPONENT) {
    warning =
      `${value} is outside the calculator's range (10^-${MAX_EXPONENT} to 10^${MAX_EXPONENT}); wrote 0.`;
    return { bytes: encodeReal(0).bytes, warning };
  }

  out[0] = value < 0 ? REAL_FLAGS.NEGATIVE : REAL_FLAGS.POSITIVE;
  out[1] = exponent + 0x80;
  for (let i = 0; i < 7; i++) {
    out[2 + i] = (Number(digits[i * 2]) << 4) | Number(digits[i * 2 + 1]);
  }
  return { bytes: out, warning };
}

/** Read a run of numbers, reporting the ones this codec cannot represent. */
function readReals(data, at, count, what, warnings) {
  const values = [];
  const unsupported = new Set();

  for (let i = 0; i < count; i++) {
    const offset = at + i * REAL_SIZE;
    if (offset + REAL_SIZE > data.length) {
      warnings.push(`${what} claims ${count} values but the file holds ${i}.`);
      break;
    }
    const { value, flags, supported } = decodeReal(data, offset);
    if (!supported) {
      unsupported.add(FLAG_NAMES[flags] ?? `an unknown form (flags 0x${flags.toString(16)})`);
      values.push(null);
    } else {
      values.push(value);
    }
  }

  if (unsupported.size) {
    warnings.push(
      `${[...unsupported].join(' and ')} cannot be written as a plain number; ` +
        'those cells are blank. Put the calculator in decimal mode and save again to keep them.',
    );
  }
  return values;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** Turn a variable's raw name bytes into something readable. */
export function readVarName(nameBytes, type) {
  if (type === VarType.LIST || type === VarType.COMPLEX_LIST) {
    if (nameBytes[0] !== LIST_PREFIX) return 'L1';
    // L1–L6 are stored as an index; anything else is the name in ASCII.
    if (nameBytes[1] <= 0x05 && nameBytes[2] === 0) return `L${nameBytes[1] + 1}`;
    let name = '';
    for (let i = 1; i < 8 && nameBytes[i]; i++) name += String.fromCharCode(nameBytes[i]);
    return name;
  }
  if (type === VarType.MATRIX) {
    return `[${MATRIX_LETTERS[nameBytes[1]] ?? 'A'}]`;
  }
  let name = '';
  for (let i = 0; i < 8 && nameBytes[i]; i++) name += String.fromCharCode(nameBytes[i]);
  return name;
}

/**
 * Build the eight name bytes for a list.
 *
 * @param {string} name `L1`–`L6`, or up to five characters of your own
 */
export function listNameBytes(name) {
  const out = new Uint8Array(8);
  out[0] = LIST_PREFIX;

  const builtin = /^L([1-6])$/i.exec(name.trim());
  if (builtin) {
    out[1] = Number(builtin[1]) - 1;
    return out;
  }

  // A custom name is one to five characters, letters and digits, first a letter.
  let cleaned = name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  if (!cleaned || !/^[A-Z]/.test(cleaned)) cleaned = ('L' + cleaned).slice(0, 5);
  for (let i = 0; i < cleaned.length; i++) out[1 + i] = cleaned.charCodeAt(i);
  return out;
}

/**
 * Build the eight name bytes for a matrix.
 *
 * @param {string} name `[A]`–`[J]`, or just the letter
 */
export function matrixNameBytes(name) {
  const out = new Uint8Array(8);
  out[0] = MATRIX_PREFIX;
  const letter = (name.replace(/[^A-Za-z]/g, '')[0] ?? 'A').toUpperCase();
  out[1] = Math.max(0, MATRIX_LETTERS.indexOf(letter));
  return out;
}

// ---------------------------------------------------------------------------
// Lists and matrices
// ---------------------------------------------------------------------------

/**
 * Decode a .8xl list file.
 *
 * @param {Uint8Array} bytes
 * @returns {{name: string, values: (number|null)[], meta: object, warnings: string[]}}
 */
export function decode8xl(bytes) {
  const { data, nameBytes, type, meta, warnings } = readVarFile(bytes);
  if (type !== VarType.LIST) {
    throw new FormatError(
      `This file holds ${VAR_TYPE_NAMES[type] ?? `type 0x${type.toString(16)}`}, not a list. ` +
        (type === VarType.MATRIX ? 'Matrices convert too — this tool reads them as .8xm.' : ''),
    );
  }

  const count = data[0] | (data[1] << 8);
  const values = readReals(data, 2, count, 'The list', warnings);
  return { name: readVarName(nameBytes, type), values, meta, warnings };
}

/**
 * Encode a list of numbers as a .8xl file.
 *
 * @param {{name?: string, values: number[], meta?: object}} list
 */
export function encode8xl({ name = 'L1', values, meta = {} }) {
  if (values.length > 999) {
    throw new FormatError(`A list holds at most 999 values; this one has ${values.length}.`);
  }

  const nameBytes = listNameBytes(name);
  const warnings = nameNote(name, readVarName(nameBytes, VarType.LIST), 'A list is called L1 to L6, or up to five letters and digits starting with a letter');

  const data = new Uint8Array(2 + values.length * REAL_SIZE);
  data[0] = values.length & 0xff;
  data[1] = (values.length >> 8) & 0xff;

  values.forEach((value, i) => {
    const { bytes, warning } = encodeReal(value);
    if (warning) warnings.push(`Value ${i + 1}: ${warning}`);
    data.set(bytes, 2 + i * REAL_SIZE);
  });

  return { bytes: writeVarFile({ data, nameBytes, type: VarType.LIST, meta }), warnings };
}

/**
 * The calculator's naming rules are narrow, so a name often cannot be kept.
 * Changing it silently means the file lands under a name nobody looked for.
 */
function nameNote(asked, got, rule) {
  if (!asked || asked.toUpperCase() === got.toUpperCase()) return [];
  return [`“${asked}” is not a name this calculator allows, so it is called ${got}. ${rule}.`];
}

/**
 * Decode a .8xm matrix file.
 *
 * @param {Uint8Array} bytes
 * @returns {{name: string, rows: (number|null)[][], meta: object, warnings: string[]}}
 */
export function decode8xm(bytes) {
  const { data, nameBytes, type, meta, warnings } = readVarFile(bytes);
  if (type !== VarType.MATRIX) {
    throw new FormatError(
      `This file holds ${VAR_TYPE_NAMES[type] ?? `type 0x${type.toString(16)}`}, not a matrix.`,
    );
  }

  // Columns are stored first, then rows; the values follow row by row.
  const columns = data[0];
  const rowCount = data[1];
  const flat = readReals(data, 2, columns * rowCount, 'The matrix', warnings);

  const rows = [];
  for (let r = 0; r < rowCount; r++) rows.push(flat.slice(r * columns, (r + 1) * columns));
  return { name: readVarName(nameBytes, type), rows, meta, warnings };
}

/**
 * Encode a rectangular array of numbers as a .8xm file.
 *
 * @param {{name?: string, rows: number[][], meta?: object}} matrix
 */
export function encode8xm({ name = '[A]', rows, meta = {} }) {
  const rowCount = rows.length;
  const columns = rowCount ? rows[0].length : 0;

  if (rows.some((row) => row.length !== columns)) {
    throw new FormatError('Every row of a matrix must have the same number of columns.');
  }
  if (rowCount > 99 || columns > 99) {
    throw new FormatError(`A matrix is at most 99 by 99; this one is ${rowCount} by ${columns}.`);
  }

  const nameBytes = matrixNameBytes(name);
  const warnings = nameNote(
    name.replace(/[[\]]/g, ''),
    readVarName(nameBytes, VarType.MATRIX).replace(/[[\]]/g, ''),
    'A matrix is called [A] to [J]',
  );

  const data = new Uint8Array(2 + rowCount * columns * REAL_SIZE);
  data[0] = columns;
  data[1] = rowCount;

  let at = 2;
  rows.forEach((row, r) =>
    row.forEach((value, c) => {
      const { bytes, warning } = encodeReal(value);
      if (warning) warnings.push(`Row ${r + 1}, column ${c + 1}: ${warning}`);
      data.set(bytes, at);
      at += REAL_SIZE;
    }),
  );

  return { bytes: writeVarFile({ data, nameBytes, type: VarType.MATRIX, meta }), warnings };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * Read a CSV or one-number-per-line file into rows of numbers.
 *
 * Deliberately forgiving about the things spreadsheets actually produce:
 * semicolons and tabs as well as commas, a decimal comma, quoted cells, a
 * header row of labels, thousands separators, and blank lines.
 *
 * @param {string} text
 * @returns {{rows: number[][], warnings: string[], skippedHeader: string[]}}
 */
export function parseNumericCsv(text) {
  const warnings = [];
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/).filter((line) => line.trim() !== '');
  if (!lines.length) return { rows: [], warnings, skippedHeader: [] };

  const { separator, note } = pickSeparator(lines);
  if (note) warnings.push(note);
  const split = (line) => (separator === null ? [line.trim()] : splitCsvLine(line, separator));

  // A first row that holds no numbers at all is column labels, not data.
  let skippedHeader = [];
  const first = split(lines[0]);
  if (lines.length > 1 && first.every((cell) => cell !== '' && toNumber(cell) === null)) {
    skippedHeader = first;
    lines.shift();
  }

  const rows = [];
  const bad = new Set();
  for (const [index, line] of lines.entries()) {
    const cells = split(line);
    const values = cells.map((cell) => {
      const value = toNumber(cell);
      if (value === null && cell !== '') bad.add(`"${cell}"`);
      return value ?? 0;
    });
    rows.push(values);
    if (index === 0) continue;
    if (values.length !== rows[0].length) {
      warnings.push(
        `Row ${index + 1} has ${values.length} value(s) where the first row has ${rows[0].length}.`,
      );
    }
  }

  if (bad.size) {
    const shown = [...bad].slice(0, 4).join(', ');
    warnings.push(
      `${bad.size} cell(s) are not numbers (${shown}${bad.size > 4 ? ', …' : ''}) and were read as 0. ` +
        'The calculator stores numbers only — text has to go in a program.',
    );
  }
  return { rows, warnings, skippedHeader };
}

/** Serialise rows of numbers back to CSV. */
export function toCsv(rows, { separator = ',', newline = '\r\n' } = {}) {
  return rows.map((row) => row.map(cellText).join(separator)).join(newline) + newline;
}

function cellText(value) {
  if (value === null || value === undefined) return '';
  // Fourteen significant digits is everything the calculator held; asking for
  // more would print the noise of the binary conversion, not the stored value.
  return Number(value.toPrecision(14)).toString();
}

/**
 * Decide what separates the cells.
 *
 * A semicolon or a tab settles it: those are what a spreadsheet writes when the
 * comma is already taken as the decimal mark. A comma on its own does not,
 * because `1,5` is one number in half of Europe and two in the other half —
 * and nothing in the file says which. So that case is decided on the shape of
 * the data and then *said out loud*, because a converter that guesses silently
 * is how a column of heights becomes a column of nonsense.
 *
 * @returns {{separator: string|null, note?: string}} null means one value per line
 */
function pickSeparator(lines) {
  if (lines.some((line) => line.includes(';'))) return { separator: ';' };
  if (lines.some((line) => line.includes('\t'))) return { separator: '\t' };
  if (!lines.some((line) => line.includes(','))) return { separator: ',' };

  // The first line may be a column label, which would never match the pattern.
  const pattern = /^\s*(-?\d+),(\d+)\s*$/;
  const match = (rows) => {
    const found = rows.map((line) => pattern.exec(line.trim()));
    return found.length && found.every(Boolean) ? found : null;
  };
  const pairs = match(lines) ?? match(lines.slice(1));
  if (!pairs) return { separator: ',' };

  // Every data line is exactly `digits,digits`, which is two readings of the
  // same bytes. Groups of three digits read as thousands or as a second
  // column; anything else reads as a decimal comma. Either way, say so.
  if (pairs.every((m) => m[2].length === 3)) {
    return {
      separator: ',',
      note:
        'Every line is a number, a comma and three digits, so the comma was read as a separator. ' +
        'If these were decimals like 1,500 save the file with semicolons instead.',
    };
  }
  return {
    separator: null,
    note:
      'Every line looks like one decimal number written with a comma, so the file was read as ' +
      'a single column. If these were meant to be two columns, save the file with semicolons.',
  };
}

/** Split one line, honouring double quotes. */
function splitCsvLine(line, separator) {
  const cells = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === separator) {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim());
  return cells;
}

/**
 * Read one cell as a number, accepting what spreadsheets in different locales
 * write: `1 234,5`, `1,234.5`, `1.234,5`, `−3` with a real minus sign, `50%`.
 * Returns null when the cell is not a number at all.
 */
export function toNumber(cell) {
  let text = cell.trim().replace(/[−‒-―]/g, '-').replace(/[\s ']/g, '');
  if (text === '') return null;

  const percent = text.endsWith('%');
  if (percent) text = text.slice(0, -1);

  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    // Whichever comes last is the decimal mark; the other groups thousands.
    text = lastComma > lastDot
      ? text.replace(/\./g, '').replace(',', '.')
      : text.replace(/,/g, '');
  } else if (lastComma >= 0) {
    // A lone comma is a decimal mark unless it is grouping digits in threes.
    text = /^-?\d{1,3}(,\d{3})+$/.test(text) ? text.replace(/,/g, '') : text.replace(',', '.');
  }

  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  return percent ? value / 100 : value;
}
