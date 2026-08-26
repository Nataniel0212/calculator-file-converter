/**
 * Codec for TI-83/84 variable files — .8xp programs and their relatives.
 *
 * Format specification: docs/8XP-FORMAT.md
 *
 * TI-BASIC is not stored as text. It is stored as *tokens*: `Disp ` is one
 * byte, `DelVar ` is one byte, `L1` is two. Turning tokens into text is easy
 * and exact. Turning text back into tokens is the hard direction, because
 * token names collide when you put them next to each other — the text `L1`
 * can be read either as the single list token `L1` or as the letter `L`
 * followed by the digit `1`, and those are different programs.
 *
 * Existing converters resolve this by longest-match and accept the loss. That
 * is the well-known bug where a program containing `pin` comes back as `πn`.
 * Measured against the full token table, plain longest-match misreads 219 of
 * the 654 481 possible adjacent token pairs.
 *
 * This codec does not guess. Two rules, mirroring charset.js:
 *
 *  1. Decoding is **verified**. Every token is appended only if re-reading the
 *     text still yields the tokens we started from; where it would not, an
 *     explicit boundary marker `\` is written. The guarantee is therefore
 *     established by construction on every single file, not hoped for.
 *  2. Encoding **reports** rather than guesses. Text that matches no token
 *     produces a warning naming the character and the line.
 */

import { FormatError } from './container.js';
import { BY_CODE, BY_NAME, LONGEST_NAME, MODELS, TWO_BYTE_PREFIXES } from './tokens-8x.js';

/** Signatures, and the calculator family each belongs to. */
export const Signature = {
  '**TI83F*': { family: 'TI-83+/84+', extension: '.8xp' },
  '**TI83**': { family: 'TI-83', extension: '.83p' },
  '**TI82**': { family: 'TI-82', extension: '.82p' },
};

/** Variable type bytes. Everything in this container shares one header. */
export const VarType = {
  REAL: 0x00,
  LIST: 0x01,
  MATRIX: 0x02,
  PROGRAM: 0x05,
  PROTECTED_PROGRAM: 0x06,
  COMPLEX: 0x0c,
  COMPLEX_LIST: 0x0d,
};

/** What each type is called when we have to tell somebody it is the wrong one. */
export const VAR_TYPE_NAMES = {
  0x00: 'a number',
  0x01: 'a list',
  0x02: 'a matrix',
  0x03: 'an equation',
  0x04: 'a string',
  0x05: 'a program',
  0x06: 'a protected program',
  0x07: 'a picture',
  0x0c: 'a complex number',
  0x0d: 'a complex list',
  0x15: 'an application variable',
  0x17: 'a group',
};

/**
 * Escapes. A backslash always opens one, and the character after it decides
 * which — so the text after a backslash is never read as a token, and no
 * escape can be confused with ordinary program text.
 *
 *   \\      the literal backslash token
 *   \.      a boundary: "these two tokens are separate", writes nothing itself
 *   \xNN    a byte sequence the token table does not name (4 digits after a
 *           two-byte prefix, exactly as in the token stream)
 *
 * `\` is the only character that starts a token name and an escape both, which
 * is why the backslash token is always written doubled.
 */
const ESCAPE = '\\';
const BOUNDARY = '\\.';
const RAW = '\\x';

const HEADER_SIZE = 0x37; // signature + separator + comment + data-section length
const COMMENT_SIZE = 42;
const prefixes = new Set(TWO_BYTE_PREFIXES);

/**
 * Tokens at or above this tier are worth warning about. Everything the TI-83+
 * added — lower case included — is in practically every program written since,
 * so flagging it would mean flagging almost every file and saying nothing.
 */
const PORTABILITY_TIER = MODELS.indexOf('TI-84+');

/**
 * @typedef {object} Program
 * @property {string} name       on-calculator name, up to 8 characters
 * @property {string} text       the program body, one token name after another
 * @property {ProgramMeta} meta  everything needed to rebuild the file byte-for-byte
 */

/**
 * @typedef {object} ProgramMeta
 * @property {string} signature   which calculator family wrote it
 * @property {number} separator   third byte after the signature; varies by tool
 * @property {string} comment     free text the writing tool left behind
 * @property {boolean} protected  editing locked on the calculator
 * @property {boolean} archived   stored in flash rather than RAM
 * @property {number} version     TI's own variable-version byte
 * @property {number} headerSize  0x0b on older files, 0x0d on current ones
 */

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------

const u16 = (bytes, at) => bytes[at] | (bytes[at + 1] << 8);

function writeU16(bytes, at, value) {
  bytes[at] = value & 0xff;
  bytes[at + 1] = (value >>> 8) & 0xff;
}

function ascii(bytes, at, length) {
  let out = '';
  for (let i = 0; i < length && bytes[at + i] !== 0; i++) out += String.fromCharCode(bytes[at + i]);
  return out;
}

/**
 * Read the container and hand back the variable's own bytes plus everything
 * needed to write the file again unchanged.
 *
 * The data is returned uninterpreted: what it means depends on the type byte,
 * and each codec reads it for itself.
 *
 * @param {Uint8Array} bytes whole file
 * @returns {{
 *   data: Uint8Array,
 *   name: string,
 *   nameBytes: Uint8Array,
 *   type: number,
 *   meta: ProgramMeta,
 *   warnings: string[],
 * }}
 */
export function readVarFile(bytes) {
  if (bytes.length < HEADER_SIZE + 2) {
    throw new FormatError('File is too short to be a calculator variable file.');
  }

  const signature = ascii(bytes, 0, 8);
  if (!Object.hasOwn(Signature, signature)) {
    throw new FormatError(
      `Not a TI calculator file: expected a "**TI83F*" signature, found "${printable(signature)}".`,
    );
  }

  const warnings = [];
  const dataSize = u16(bytes, 0x35);
  const dataEnd = HEADER_SIZE + dataSize;
  if (dataEnd + 2 > bytes.length) {
    throw new FormatError(
      `Header says the data section is ${dataSize} bytes, which runs past the end of a ${bytes.length}-byte file.`,
    );
  }
  if (dataEnd + 2 !== bytes.length) {
    warnings.push(
      `File has ${bytes.length - dataEnd - 2} trailing byte(s) after the checksum; they were ignored.`,
    );
  }

  let sum = 0;
  for (let i = HEADER_SIZE; i < dataEnd; i++) sum = (sum + bytes[i]) & 0xffff;
  const stored = u16(bytes, dataEnd);
  if (sum !== stored) {
    warnings.push(
      `Checksum mismatch: the file says ${stored}, the contents add up to ${sum}. It may be corrupt.`,
    );
  }

  const headerSize = u16(bytes, HEADER_SIZE);
  if (headerSize !== 0x0b && headerSize !== 0x0d) {
    throw new FormatError(`Unsupported variable header size 0x${headerSize.toString(16)}.`);
  }
  const varSize = u16(bytes, HEADER_SIZE + 2);
  const type = bytes[HEADER_SIZE + 4];
  const name = ascii(bytes, HEADER_SIZE + 5, 8);
  const flexible = headerSize === 0x0d;
  const version = flexible ? bytes[HEADER_SIZE + 0x0d] : 0;
  const archived = flexible ? bytes[HEADER_SIZE + 0x0e] !== 0 : false;

  const body = HEADER_SIZE + 2 + headerSize + 2;
  const end = Math.min(body + varSize, dataEnd);
  if (body + varSize > dataEnd) {
    warnings.push(`Variable claims ${varSize} bytes but only ${dataEnd - body} are present.`);
  }

  return {
    data: bytes.subarray(body, end),
    name,
    nameBytes: bytes.subarray(HEADER_SIZE + 5, HEADER_SIZE + 13),
    type,
    meta: {
      signature,
      separator: bytes[0x0a],
      comment: ascii(bytes, 0x0b, COMMENT_SIZE),
      protected: type === VarType.PROTECTED_PROGRAM,
      archived,
      version,
      headerSize,
    },
    warnings,
  };
}

/**
 * Build a complete variable file around one variable's data.
 *
 * @param {object} variable
 * @param {Uint8Array} variable.data       the variable's own bytes, whatever its type
 * @param {string} [variable.name]         on-calculator name, for types named in ASCII
 * @param {Uint8Array} [variable.nameBytes] exact name bytes, for lists and matrices
 * @param {number} [variable.type]         one of {@link VarType}
 * @param {Partial<ProgramMeta>} [variable.meta]
 * @returns {Uint8Array}
 */
export function writeVarFile({ data, name = '', nameBytes, type, meta = {} }) {
  const {
    signature = '**TI83F*',
    separator = 0x0a,
    comment = 'Converted by calcconv',
    protected: locked = false,
    archived = false,
    version = 0,
    headerSize = 0x0d,
  } = meta;

  const varSize = data.length;
  const dataSize = 2 + headerSize + 2 + varSize;
  const out = new Uint8Array(HEADER_SIZE + dataSize + 2);

  for (let i = 0; i < 8; i++) out[i] = signature.charCodeAt(i);
  out[0x08] = 0x1a;
  out[0x09] = 0x0a;
  out[0x0a] = separator;
  for (let i = 0; i < COMMENT_SIZE && i < comment.length; i++) out[0x0b + i] = comment.charCodeAt(i) & 0xff;
  writeU16(out, 0x35, dataSize);

  writeU16(out, HEADER_SIZE, headerSize);
  writeU16(out, HEADER_SIZE + 2, varSize);
  out[HEADER_SIZE + 4] = type ?? (locked ? VarType.PROTECTED_PROGRAM : VarType.PROGRAM);
  if (nameBytes) {
    out.set(nameBytes.subarray(0, 8), HEADER_SIZE + 5);
  } else {
    const upper = name.toUpperCase().slice(0, 8);
    for (let i = 0; i < upper.length; i++) out[HEADER_SIZE + 5 + i] = upper.charCodeAt(i);
  }
  if (headerSize === 0x0d) {
    out[HEADER_SIZE + 0x0d] = version;
    out[HEADER_SIZE + 0x0e] = archived ? 0x80 : 0x00;
  }

  const body = HEADER_SIZE + 2 + headerSize;
  writeU16(out, body, varSize);
  out.set(data, body + 2);

  let sum = 0;
  for (let i = HEADER_SIZE; i < HEADER_SIZE + dataSize; i++) sum = (sum + out[i]) & 0xffff;
  writeU16(out, HEADER_SIZE + dataSize, sum);

  return out;
}

// ---------------------------------------------------------------------------
// Tokens <-> text
// ---------------------------------------------------------------------------

/** Split a token stream into hex codes. Two-byte tokens have fixed prefixes. */
export function splitTokens(bytes) {
  const codes = [];
  for (let i = 0; i < bytes.length; i++) {
    const first = hex2(bytes[i]);
    if (prefixes.has(first) && i + 1 < bytes.length) {
      codes.push(first + hex2(bytes[i + 1]));
      i++;
    } else {
      codes.push(first);
    }
  }
  return codes;
}

/**
 * Longest-match reader: the conventional algorithm, used here as the *check*
 * rather than as the answer. Stops at the first thing it cannot read.
 *
 * @param {string} text
 * @param {number} from index to start at
 * @returns {{code: string, length: number} | null}
 */
function readToken(text, from) {
  const limit = Math.min(LONGEST_NAME, text.length - from);
  for (let n = limit; n >= 1; n--) {
    const code = BY_NAME.get(text.slice(from, from + n));
    if (code) return { code, length: n };
  }
  return null;
}

/**
 * Turn a token stream into text.
 *
 * A token is written plainly when doing so still reads back as that token, and
 * with a leading `\` when it would not. Because the check runs for every token,
 * the text this returns is guaranteed to tokenise back to the input bytes.
 *
 * @param {Uint8Array} bytes token stream
 * @returns {{text: string, warnings: string[]}}
 */
export function detokenize(bytes) {
  const codes = splitTokens(bytes);
  const warnings = [];
  const unknown = new Set();
  const newest = new Map();

  let text = '';
  let line = 1;
  // Start positions of the tokens written since the last escape. An escape
  // stops longest-match dead, so nothing before one can affect what follows.
  // A merge spans at most LONGEST_NAME characters, hence the trimming.
  let starts = [];

  for (const code of codes) {
    const token = BY_CODE.get(code);

    if (!token) {
      unknown.add(code);
      text += RAW + code;
      starts = [];
      continue;
    }
    if (token.name === ESCAPE) {
      text += ESCAPE + ESCAPE;
      starts = [];
      continue;
    }
    // Keep the longest name per tier: "dayOfWk(" tells the reader what is going
    // to break on an older machine, "a" does not.
    if (token.tier >= PORTABILITY_TIER && (newest.get(token.tier)?.name.length ?? 0) < token.name.length) {
      newest.set(token.tier, { name: token.name, line });
    }
    if (code === '3F') line++;

    if (!safeToAppend(text, starts, token)) {
      text += BOUNDARY;
      starts = [];
    }
    starts.push(text.length);
    text += token.name;
    const cutoff = text.length - LONGEST_NAME;
    while (starts.length > 1 && starts[1] <= cutoff) starts.shift();
  }

  if (unknown.size) {
    warnings.push(
      `${unknown.size} byte sequence(s) are not in the token table (${[...unknown].join(', ')}). ` +
        `They were written as ${RAW}NN escapes and will convert back unchanged.`,
    );
  }
  const highest = [...newest].sort((a, b) => b[0] - a[0])[0];
  if (highest) {
    const [tier, { name, line: at }] = highest;
    warnings.push(`Needs a ${MODELS[tier]} or newer: line ${at} uses "${name}".`);
  }

  return { text, warnings };
}

/**
 * Would appending this token still read back as itself, leaving the tokens
 * before it intact? Re-reads the tail from a known token start, which is all
 * longest-match can reach back to.
 *
 * @param {string} text        what has been written so far
 * @param {number[]} starts    token start positions since the last escape
 * @param {{name: string}} token
 */
function safeToAppend(text, starts, token) {
  const from = starts.length ? starts[0] : text.length;
  const combined = text.slice(from) + token.name;
  const boundary = combined.length - token.name.length;

  let at = 0;
  while (at < boundary) {
    const read = readToken(combined, at);
    if (!read || at + read.length > boundary) return false; // a token got swallowed
    at += read.length;
  }
  const read = readToken(combined, boundary);
  return read !== null && read.length === token.name.length;
}

/**
 * Turn text back into a token stream.
 *
 * @param {string} text
 * @param {{where?: string}} [options]
 * @returns {{bytes: Uint8Array, warnings: string[]}}
 */
export function tokenize(text, options = {}) {
  const { where = '' } = options;
  const bytes = [];
  const warnings = [];
  const seen = new Set();
  let line = 1;
  let at = 0;

  while (at < text.length) {
    if (text[at] === ESCAPE) {
      const marker = text[at + 1];

      if (marker === ESCAPE) {
        // Present in every token sheet, and asserted by the test suite; the
        // guard is so a future sheet without it degrades rather than crashes.
        const backslash = BY_NAME.get(ESCAPE);
        if (backslash) pushCode(backslash);
        at += 2;
        continue;
      }
      if (marker === '.') {
        at += 2; // a boundary contributes no bytes of its own
        continue;
      }
      if (marker === 'x') {
        const hex = (/^[0-9a-fA-F]{0,4}/.exec(text.slice(at + 2))?.[0] ?? '').toUpperCase();
        // Two-byte prefixes take two more digits, exactly as in the stream.
        const width = prefixes.has(hex.slice(0, 2)) ? 4 : 2;
        if (hex.length >= width) {
          pushCode(hex.slice(0, width));
          at += 2 + width;
          continue;
        }
      }

      warnings.push(
        `${where}line ${line}: "${text.slice(at, at + 2)}" is not a valid escape and was skipped.`,
      );
      at += 1;
      continue;
    }

    const read = readToken(text, at);
    if (!read) {
      // Anything outside the basic plane — an emoji, say — is two code units.
      // Taking one at a time would report it twice, as two halves of nothing.
      const code = text.codePointAt(at) ?? 0;
      const ch = String.fromCodePoint(code);
      if (!seen.has(ch)) {
        seen.add(ch);
        warnings.push(
          `${where}line ${line}: "${ch}" (U+${code.toString(16).toUpperCase().padStart(4, '0')}) ` +
            'is not a TI-BASIC token and was skipped.',
        );
      }
      at += ch.length;
      continue;
    }

    pushCode(read.code);
    if (read.code === '3F') line++;
    at += read.length;
  }

  return { bytes: Uint8Array.from(bytes), warnings };

  function pushCode(code) {
    for (let i = 0; i < code.length; i += 2) bytes.push(parseInt(code.slice(i, i + 2), 16));
  }
}

// ---------------------------------------------------------------------------
// Whole-file conversion
// ---------------------------------------------------------------------------

/**
 * Decode a .8xp file to a program.
 *
 * @param {Uint8Array} bytes
 * @returns {Program & {warnings: string[]}}
 */
export function decode8xp(bytes) {
  const { data, name, type, meta, warnings } = readVarFile(bytes);

  if (type !== VarType.PROGRAM && type !== VarType.PROTECTED_PROGRAM) {
    throw new FormatError(
      `This is a TI calculator file, but it holds ${VAR_TYPE_NAMES[type] ?? `type 0x${hex2(type)}`}, ` +
        'not a program. Only programs convert to TI-BASIC text.',
    );
  }

  // A program's data begins with the length of the token stream that follows.
  const declared = u16(data, 0);
  if (declared !== data.length - 2) {
    warnings.push(`Program length ${declared} does not match the ${data.length - 2} bytes present.`);
  }
  const tokens = data.subarray(2, 2 + Math.min(declared, data.length - 2));

  const { text, warnings: textWarnings } = detokenize(tokens);
  return { name, text, meta, warnings: [...warnings, ...textWarnings] };
}

/**
 * Encode a program to a .8xp file.
 *
 * @param {{name: string, text: string, meta?: Partial<ProgramMeta>}} program
 * @returns {{bytes: Uint8Array, warnings: string[]}}
 */
export function encode8xp({ name, text, meta = {} }) {
  const { bytes: tokens, warnings } = tokenize(text);
  if (tokens.length > 0xfffd) {
    throw new FormatError(
      `Program is ${tokens.length} bytes; the format cannot hold more than 65533.`,
    );
  }
  const data = new Uint8Array(tokens.length + 2);
  writeU16(data, 0, tokens.length);
  data.set(tokens, 2);
  return {
    bytes: writeVarFile({ data, name, type: meta.protected ? VarType.PROTECTED_PROGRAM : VarType.PROGRAM, meta }),
    warnings,
  };
}

// ---------------------------------------------------------------------------
// The text file
// ---------------------------------------------------------------------------

/**
 * A .8xp holds more than its program text: the name the calculator shows, a
 * comment the writing tool left, whether the variable is archived, and a
 * handful of bytes that vary between the tools people use. Rebuilding the file
 * byte-for-byte means keeping all of it, so the .txt carries it in a small
 * header:
 *
 *   #format: 8xp
 *   #name: GUESSNUM
 *   #comment: Created by TI Connect CE 5.3.0.384
 *
 *   Disp "GUESS"
 *
 * Everything is optional; a plain TI-BASIC file with no header at all converts
 * fine and gets sensible defaults. Only a `#` line whose key is one of these is
 * treated as a header, so a program line starting with `#` is safe unless it
 * happens to spell one of them.
 */
const HEADER_KEYS = ['format', 'name', 'comment', 'version', 'archived', 'protected', 'separator', 'header'];

const FORMAT_SIGNATURES = { '8xp': '**TI83F*', '83p': '**TI83**', '82p': '**TI82**' };

/** Short format id for a signature, e.g. `**TI83F*` -> `8xp`. */
export function formatIdFor(signature) {
  return Object.keys(FORMAT_SIGNATURES).find((id) => FORMAT_SIGNATURES[id] === signature) ?? '8xp';
}

/**
 * Render a decoded program as a text file, header and all.
 *
 * @param {Program} program
 * @param {{newline?: string, header?: boolean}} [options]
 */
export function programToText(program, { newline = '\n', header = true } = {}) {
  const body = program.text.replace(/\n/g, newline);
  if (!header) return body;

  const { meta } = program;
  const lines = [
    `#format: ${formatIdFor(meta.signature)}`,
    `#name: ${program.name}`,
  ];
  if (meta.comment) lines.push(`#comment: ${meta.comment}`);
  if (meta.version) lines.push(`#version: ${meta.version}`);
  if (meta.archived) lines.push('#archived: yes');
  if (meta.protected) lines.push('#protected: yes');
  if (meta.separator !== 0x0a) lines.push(`#separator: 0x${hex2(meta.separator)}`);
  if (meta.headerSize !== 0x0d) lines.push(`#header: 0x${hex2(meta.headerSize)}`);

  return lines.join(newline) + newline + newline + body;
}

/**
 * Read a text file back into a program. The inverse of {@link programToText}.
 *
 * @param {string} text
 * @param {{name?: string}} [options] fallback name, normally the file stem
 * @returns {{name: string, text: string, meta: Partial<ProgramMeta>, format: string}}
 */
export function textToProgram(text, { name = 'PROGRAM' } = {}) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const fields = new Map();

  let at = 0;
  for (; at < lines.length; at++) {
    const match = /^#([a-z]+):[ \t]?(.*)$/.exec(lines[at]);
    if (!match || !HEADER_KEYS.includes(match[1])) break;
    fields.set(match[1], match[2]);
  }
  if (at > 0 && lines[at] === '') at++; // the blank line that ends the header

  const yes = (key) => /^(yes|true|1)$/i.test(fields.get(key) ?? '');
  const num = (key, fallback) => {
    const raw = fields.get(key);
    if (raw === undefined) return fallback;
    const value = Number(raw.trim());
    return Number.isFinite(value) ? value : fallback;
  };

  const format = fields.get('format')?.trim() ?? '8xp';
  return {
    name: defaultProgramName(fields.get('name')?.trim() || name),
    text: lines.slice(at).join('\n'),
    format,
    meta: {
      signature: FORMAT_SIGNATURES[format] ?? FORMAT_SIGNATURES['8xp'],
      comment: fields.get('comment') ?? 'Converted by calcconv',
      version: num('version', 0),
      archived: yes('archived'),
      protected: yes('protected'),
      separator: num('separator', 0x0a),
      headerSize: num('header', 0x0d),
    },
  };
}

/** The on-calculator name a file gets: upper case, at most 8 characters. */
export function defaultProgramName(stem) {
  const cleaned = stem.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return (cleaned.slice(0, 8) || 'PROGRAM').replace(/^[0-9]/, 'P');
}

function hex2(byte) {
  return byte.toString(16).toUpperCase().padStart(2, '0');
}

function printable(s) {
  return s.replace(/[^\x20-\x7e]/g, '?');
}
