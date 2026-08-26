/**
 * Codec for .g1e documents, as used by fx-9860G series graphing calculators.
 *
 * Format specification: docs/G1E-FORMAT.md
 */

import {
  FormatError,
  FileType,
  buildStandardHeader,
  readName,
  readStandardHeader,
  readU32,
  writeU32,
} from './container.js';
import { decodeText, encodeText } from './charset.js';

/** Offset of the e-Activity body inside the container. */
const DATA = 0x88;

/** Body magic at DATA + 0x00. */
const BODY_MAGIC = [0xd4, 0x00, 0x00, 0x66];

const LineType = {
  HEADING: 0x07,
  TEXT: 0x81,
};

/**
 * Everything in the 0x88-byte prologue that never varies between files.
 * Generated from real files; the fields we compute are zeroed out here.
 * @see docs/G1E-FORMAT.md §3–4
 */
const PROLOGUE_TEMPLATE =
  '0000000000000000000000000000000000000000000000000000000000000000' +
  '0000000000000038000101005061636b000000000000142a3f02c00000003820' +
  '0000000001020101010301010101010101010101010100000000000000000000' +
  '0000000000000000404541435400000000000001000000004541435431000000' +
  '0000001400000000';

/**
 * @typedef {object} EActivity
 * @property {string} heading   title line shown at the top on the calculator
 * @property {string[]} lines   document body, one string per line
 */

/**
 * Decode a .g1e file.
 *
 * @param {Uint8Array} bytes
 * @returns {EActivity & {warnings: string[]}}
 */
export function decodeG1e(bytes) {
  const { fileType, declaredSize, controlOk } = readStandardHeader(bytes);
  const warnings = [];

  if (fileType !== FileType.EACTIVITY) {
    throw new FormatError(
      `This is a calculator file, but not a .g1e document (type byte 0x${fileType.toString(16)}). ` +
        'Only .g1e files can be converted to text.',
    );
  }
  if (declaredSize !== bytes.length) {
    warnings.push(
      `Header says the file is ${declaredSize} bytes but it is ${bytes.length}. It may be truncated.`,
    );
  }
  if (!controlOk) warnings.push('Header control bytes do not match the file size.');

  const group = readName(bytes, 0x68);
  if (group !== '@EACT') {
    warnings.push(`Expected group "@EACT", found "${group}".`);
  }
  if (BODY_MAGIC.some((b, i) => bytes[DATA + i] !== b)) {
    throw new FormatError('Document body signature missing — file is not readable.');
  }

  const count = readU32(bytes, DATA + 4);
  const tableEnd = DATA + 8 + 4 * count;
  if (count > 100000 || tableEnd > bytes.length) {
    throw new FormatError(`Line count ${count} is impossible for a ${bytes.length}-byte file.`);
  }

  const entries = [];
  for (let i = 0; i < count; i++) {
    const word = readU32(bytes, DATA + 8 + 4 * i);
    const type = word >>> 24;
    const start = DATA + (word & 0xffffff) + 4; // see spec §5.1
    if (start >= bytes.length) {
      throw new FormatError(`Line ${i + 1} points outside the file.`);
    }
    let end = start;
    while (end < bytes.length && bytes[end] !== 0) end++;
    entries.push({ type, text: decodeText(bytes.subarray(start, end)) });
  }

  const unknown = entries.filter((e) => e.type !== LineType.TEXT && e.type !== LineType.HEADING);
  if (unknown.length) {
    warnings.push(
      `${unknown.length} line(s) use an entry type this tool does not understand ` +
        `(${[...new Set(unknown.map((e) => '0x' + e.type.toString(16)))].join(', ')}). ` +
        'They were read as plain text; the document may contain strips or embedded programs.',
    );
  }

  const heading = entries.length && entries[0].type === LineType.HEADING ? entries[0].text : '';
  const body = entries.length && entries[0].type === LineType.HEADING ? entries.slice(1) : entries;

  return { heading, lines: body.map((e) => e.text), warnings };
}

/**
 * Encode an e-Activity to a .g1e file.
 *
 * @param {EActivity} activity
 * @param {{transliterate?: boolean}} [options]
 * @returns {{bytes: Uint8Array, warnings: string[]}}
 */
export function encodeG1e(activity, options = {}) {
  const { transliterate = true } = options;
  const warnings = [];

  const entries = [{ type: LineType.HEADING, text: activity.heading ?? '' }];
  for (const line of activity.lines) entries.push({ type: LineType.TEXT, text: line });

  const encoded = entries.map((entry, i) => {
    const where = i === 0 ? 'Heading: ' : `Line ${i}: `;
    const { bytes, warnings: w } = encodeText(entry.text, { transliterate, where });
    warnings.push(...w);
    return { type: entry.type, bytes };
  });

  const count = encoded.length;
  const table = new Uint8Array(4 * count);
  const blocks = [];
  let payloadLength = 4; // the four zero bytes that follow the table

  encoded.forEach((entry, i) => {
    // Stored offset points four bytes before the text, hence the -4.
    writeU32(table, 4 * i, (entry.type << 24) | (8 + 4 * count + payloadLength - 4));
    const padded = new Uint8Array(align4(entry.bytes.length + 1));
    padded.set(entry.bytes);
    blocks.push(padded);
    payloadLength += padded.length;
  });

  const fileSize = DATA + 8 + 4 * count + payloadLength;
  const out = new Uint8Array(fileSize);
  out.set(hexToBytes(PROLOGUE_TEMPLATE));
  out.set(buildStandardHeader(FileType.EACTIVITY, fileSize), 0);
  writeU32(out, 0x20, fileSize); // subheader size
  writeU32(out, 0x74, fileSize - 0x78); // @EACT group data size
  writeU32(out, 0x84, fileSize - DATA - 4); // EACT1 item data size

  out.set(BODY_MAGIC, DATA);
  writeU32(out, DATA + 4, count);
  out.set(table, DATA + 8);
  let at = DATA + 8 + 4 * count + 4;
  for (const block of blocks) {
    out.set(block, at);
    at += block.length;
  }

  return { bytes: out, warnings };
}

/**
 * The decorative heading the older converter produces, e.g. `======INDEX   =======`.
 * @param {string} name base file name, without extension
 */
export function defaultHeading(name) {
  const upper = name.toUpperCase().replace(/[^\x20-\x7e]/g, '');
  return '======' + upper.slice(0, 8).padEnd(8, ' ') + '=======';
}

/** Convert a .g1e file to plain text. */
export function g1eToText(bytes, { newline = '\r\n' } = {}) {
  const { heading, lines, warnings } = decodeG1e(bytes);
  return { text: lines.join(newline) + newline, heading, warnings };
}

/** Convert plain text to a .g1e file. */
export function textToG1e(text, { heading = '', transliterate = true } = {}) {
  const lines = text.split(/\r\n|\r|\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return encodeG1e({ heading, lines }, { transliterate });
}

function align4(n) {
  return (n + 3) & ~3;
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
