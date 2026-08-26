/**
 * Text conversion between the calculator's character set and Unicode.
 *
 * The fx-9860G does not use Unicode. Bytes 0x20–0x7E line up with ASCII, but
 * everything above that is the machine's own set of maths symbols, and there is no
 * lower case: the calculator renders a–z as small capitals in most contexts.
 *
 * Two design rules here:
 *
 *  1. Decoding is **lossless**. Any byte we do not have a mapping for is
 *     decoded into the Unicode private use area (U+E0xx) so that re-encoding
 *     reproduces the original byte exactly. A converter that quietly mangles
 *     bytes it does not recognise is worse than useless.
 *  2. Encoding **reports** rather than guesses. Characters that cannot be
 *     represented produce a warning naming the character and the line, so the
 *     user finds out before the calculator does.
 */

const PUA_BASE = 0xe000;

/**
 * Characters a user is likely to type that the calculator cannot show, mapped
 * to the closest thing it can. Applied only when `transliterate` is enabled.
 */
export const TRANSLITERATIONS = new Map(
  Object.entries({
    å: 'A', ä: 'A', ö: 'O', Å: 'A', Ä: 'A', Ö: 'O',
    é: 'E', è: 'E', ü: 'U', ø: 'O', æ: 'AE', ß: 'SS',
    '‘': "'", '’': "'", '“': '"', '”': '"',
    '–': '-', '—': '-', '…': '...', ' ': ' ',
    '·': '*', '×': '*', '÷': '/', '−': '-',
    '\t': '  ',
  }),
);

/**
 * Decode calculator bytes to a JavaScript string.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function decodeText(bytes) {
  let out = '';
  for (const b of bytes) {
    out += b >= 0x20 && b <= 0x7e
      ? String.fromCharCode(b)
      : String.fromCharCode(PUA_BASE + b);
  }
  return out;
}

/**
 * Encode a string to calculator bytes.
 *
 * @param {string} text
 * @param {{transliterate?: boolean, where?: string}} [options]
 * @returns {{bytes: Uint8Array, warnings: string[]}}
 */
export function encodeText(text, options = {}) {
  const { transliterate = true, where = '' } = options;
  const bytes = [];
  const warnings = [];
  const seen = new Set();

  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;

    if (code >= 0x20 && code <= 0x7e) {
      bytes.push(code);
      continue;
    }
    if (code >= PUA_BASE && code <= PUA_BASE + 0xff) {
      bytes.push(code - PUA_BASE); // round-tripped byte we did not recognise
      continue;
    }

    const replacement = transliterate ? TRANSLITERATIONS.get(ch) : undefined;
    if (replacement !== undefined) {
      for (const r of replacement) bytes.push(r.charCodeAt(0));
      if (!seen.has(ch)) {
        seen.add(ch);
        warnings.push(
          `${where}"${ch}" is not available on the calculator, replaced with "${replacement}".`,
        );
      }
      continue;
    }

    bytes.push(0x3f); // '?'
    if (!seen.has(ch)) {
      seen.add(ch);
      warnings.push(
        `${where}"${ch}" (U+${code.toString(16).toUpperCase().padStart(4, '0')}) cannot be shown on the calculator, replaced with "?".`,
      );
    }
  }

  return { bytes: Uint8Array.from(bytes), warnings };
}

/** True if the string contains only characters the calculator can display. */
export function isCalculatorSafe(text) {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}
