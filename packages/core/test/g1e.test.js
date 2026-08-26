import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, extname, basename } from 'node:path';

import { decodeG1e, encodeG1e, textToG1e, g1eToText, defaultHeading } from '../src/g1e.js';
import { readStandardHeader, invert } from '../src/container.js';
import { encodeText, decodeText } from '../src/charset.js';

const sample = { heading: defaultHeading('TEST'), lines: ['HELLO', '', 'WORLD 42', 'X=1'] };

test('encode then decode returns the same document', () => {
  const { bytes } = encodeG1e(sample);
  const back = decodeG1e(bytes);
  assert.equal(back.heading, sample.heading);
  assert.deepEqual(back.lines, sample.lines);
  assert.deepEqual(back.warnings, []);
});

test('header declares the real file size and valid control bytes', () => {
  const { bytes } = encodeG1e(sample);
  const header = readStandardHeader(bytes);
  assert.equal(header.declaredSize, bytes.length);
  assert.ok(header.controlOk);
});

test('every text block is 4-byte aligned and NUL terminated', () => {
  const { bytes } = encodeG1e({ heading: 'H', lines: ['A', 'BB', 'CCC', 'DDDD', ''] });
  assert.equal(bytes.length % 4, 0);
  // the last byte of the file is padding or a terminator, never text
  assert.equal(bytes[bytes.length - 1], 0);
});

test('empty document is still a valid file', () => {
  const { bytes } = encodeG1e({ heading: '', lines: [] });
  const back = decodeG1e(bytes);
  assert.deepEqual(back.lines, []);
});

test('a long document round-trips', () => {
  const lines = Array.from({ length: 2000 }, (_, i) => `LINE ${i} ${'X'.repeat(i % 40)}`);
  const { bytes } = encodeG1e({ heading: 'BIG', lines });
  assert.deepEqual(decodeG1e(bytes).lines, lines);
});

test('text conversion normalises all newline styles', () => {
  for (const nl of ['\n', '\r\n', '\r']) {
    const { bytes } = textToG1e(`A${nl}B${nl}C${nl}`);
    assert.deepEqual(decodeG1e(bytes).lines, ['A', 'B', 'C']);
  }
});

test('unrepresentable characters are reported, not silently dropped', () => {
  const { warnings } = textToG1e('KÖTTBULLAR ≈ 5');
  assert.ok(warnings.some((w) => w.includes('Ö')));
  assert.ok(warnings.some((w) => w.includes('≈')));
});

test('unknown bytes survive a decode/encode round-trip', () => {
  const weird = Uint8Array.from([0x41, 0xf7, 0x99, 0x42]);
  const { bytes } = encodeText(decodeText(weird));
  assert.deepEqual(bytes, weird);
});

test('rejects files that are not e-Activities', () => {
  const notACalculatorFile = new Uint8Array(200);
  assert.throws(() => decodeG1e(notACalculatorFile), /Not a calculator file/);
});

test('defaultHeading matches the classic 21-character layout', () => {
  assert.equal(defaultHeading('INDEX'), '======INDEX   =======');
  assert.equal(defaultHeading('VARMEMOT'), '======VARMEMOT=======');
  assert.equal(defaultHeading('a-very-long-name').length, 21);
});

/**
 * Byte-exactness against files produced by the manufacturer's own tooling.
 *
 * Real .g1e files are not committed (they are somebody's documents), so point
 * SAMPLE_FILES at a folder holding .g1e files and their .txt counterparts:
 *
 *   SAMPLE_FILES=/path/to/folder node --test
 */
const samplesDir = process.env.SAMPLE_FILES;
test('re-encoding real calculator files is byte-exact', { skip: !samplesDir || !existsSync(samplesDir) }, () => {
  const files = readdirSync(samplesDir).filter((f) => extname(f).toLowerCase() === '.g1e');
  assert.ok(files.length > 0, 'no .g1e files found in SAMPLE_FILES');

  for (const file of files) {
    const original = new Uint8Array(readFileSync(join(samplesDir, file)));
    const doc = decodeG1e(original);
    const { bytes } = encodeG1e(doc);
    assert.deepEqual(bytes, original, `${file} did not re-encode byte-for-byte`);

    const txt = join(samplesDir, basename(file, extname(file)) + '.txt');
    if (existsSync(txt)) {
      const expected = readFileSync(txt, 'latin1').split(/\r\n/);
      while (expected.length && expected[expected.length - 1] === '') expected.pop();
      assert.deepEqual(doc.lines, expected, `${file} text does not match its .txt`);
    }
  }
});
