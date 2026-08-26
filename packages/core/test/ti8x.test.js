import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

import {
  decode8xp,
  encode8xp,
  detokenize,
  tokenize,
  readVarFile,
  writeVarFile,
  splitTokens,
  defaultProgramName,
} from '../src/ti8x.js';
import { BY_CODE, BY_NAME, LONGEST_NAME } from '../src/tokens-8x.js';

const CODES = [...BY_CODE.keys()];
const bytesOf = (hex) => Uint8Array.from(hex.match(/../g).map((b) => parseInt(b, 16)));

/** The property the whole codec exists to guarantee. */
function assertRoundTrips(tokens, what) {
  const { text } = detokenize(tokens);
  const { bytes, warnings } = tokenize(text);
  assert.deepEqual(bytes, tokens, `${what} did not survive: ${JSON.stringify(text)}`);
  assert.deepEqual(warnings, [], `${what} produced warnings: ${warnings.join('; ')}`);
}

test('the token table is a bijection', () => {
  assert.equal(BY_CODE.size, BY_NAME.size);
  assert.ok(BY_CODE.size > 800);
  for (const [code, { name }] of BY_CODE) assert.equal(BY_NAME.get(name), code);
});

test('every token on its own round-trips', () => {
  for (const code of CODES) assertRoundTrips(bytesOf(code), `token ${code}`);
});

/**
 * The heart of it. Longest-match alone misreads 219 of these pairs — `L`+`1`
 * comes back as the list `L1`, `-`+`>` as the store arrow, and so on. Not one
 * of them is allowed to slip through.
 */
test('every adjacent token pair round-trips', () => {
  let checked = 0;
  for (const a of CODES) {
    for (const b of CODES) {
      const tokens = bytesOf(a + b);
      const { text } = detokenize(tokens);
      assert.deepEqual(tokenize(text).bytes, tokens, `${a}+${b} broke: ${JSON.stringify(text)}`);
      checked++;
    }
  }
  assert.equal(checked, CODES.length ** 2);
});

test('the pairs longest-match is known to get wrong are handled', () => {
  // A sample of the documented collisions, spelled out so a regression here
  // reads as what it is rather than as one failure among 654 481.
  const collisions = [
    ['L', '1'], // the letter L then a digit, not the list L1
    ['!', '='], // factorial then equals, not the not-equals token
    ['F', 'V'], // two letters, not the finance variable FV
    ['Z', 'Yscl'], // a letter then a window variable, not ZYscl
    ['I', '%'], // a letter then a percent, not the interest variable I%
  ];
  for (const [first, second] of collisions) {
    const a = BY_NAME.get(first);
    const b = BY_NAME.get(second);
    assert.ok(a && b, `${first}/${second} should both be tokens`);
    assert.ok(BY_NAME.has(first + second), `${first}${second} should also be a token on its own`);

    const tokens = bytesOf(a + b);
    const { text } = detokenize(tokens);
    assert.ok(text.includes('\\.'), `${a}+${b} should have needed a boundary, got ${JSON.stringify(text)}`);
    assert.deepEqual(tokenize(text).bytes, tokens);
  }
});

test('random token streams round-trip', () => {
  // Pairs cannot prove sequences: three tokens can merge where two do not.
  let seed = 20260826;
  const next = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >>> 8);

  for (let run = 0; run < 400; run++) {
    const length = 1 + (next() % 60);
    let hex = '';
    for (let i = 0; i < length; i++) hex += CODES[next() % CODES.length];
    assertRoundTrips(bytesOf(hex), `run ${run}`);
  }
});

test('a literal backslash token is never mistaken for an escape', () => {
  const backslash = BY_NAME.get('\\');
  assert.ok(backslash, 'the token table should contain a backslash token');
  const { text } = detokenize(bytesOf(backslash + backslash + '3F' + backslash));
  assert.ok(!/(^|[^\\])\\[.x]/.test(text), `escapes leaked into ${JSON.stringify(text)}`);
  assertRoundTrips(bytesOf(backslash + backslash + '3F' + backslash), 'backslash run');
});

test('bytes with no token survive as escapes', () => {
  // Assembly programs and newer OSes both put unnamed bytes in the stream.
  const unnamed = [];
  for (let b = 0; b < 0x100 && unnamed.length < 3; b++) {
    const code = b.toString(16).toUpperCase().padStart(2, '0');
    if (!BY_CODE.has(code)) unnamed.push(code);
  }
  assert.ok(unnamed.length > 0, 'expected some unnamed byte values');

  const tokens = bytesOf(unnamed.join('') + '3F41');
  const { text, warnings } = detokenize(tokens);
  assert.ok(text.includes('\\x'), 'unnamed bytes should be written as \\x escapes');
  assert.ok(warnings.some((w) => w.includes('not in the token table')));
  assert.deepEqual(tokenize(text).bytes, tokens);
});

test('two-byte tokens are split on their prefixes, not greedily', () => {
  assert.deepEqual(splitTokens(bytesOf('BBB04C31')), ['BBB0', '4C', '31']);
  // A prefix byte at the very end has no partner and stays one byte.
  assert.deepEqual(splitTokens(bytesOf('41BB')), ['41', 'BB']);
});

test('text that is not TI-BASIC is reported, not silently dropped', () => {
  const { warnings } = tokenize('Disp "HEJ"\nåäö');
  assert.ok(warnings.some((w) => w.includes('å')));
  assert.ok(warnings.some((w) => w.includes('line 2')));
});

test('a malformed escape is reported', () => {
  const { warnings } = tokenize('A\\qB');
  assert.ok(warnings.some((w) => w.includes('not a valid escape')));
});

test('decoding warns when a program needs a newer calculator', () => {
  const modern = BY_NAME.get('dayOfWk(');
  assert.ok(modern, 'dayOfWk( should be a token');
  assert.ok(detokenize(bytesOf(modern)).warnings.some((w) => /Needs a TI-8/.test(w)));

  // Lower case arrived on the TI-83+ and is in nearly every program written
  // since. Warning about it would drown out the warnings that matter.
  const lowercase = BY_NAME.get('a');
  assert.deepEqual(detokenize(bytesOf(lowercase)).warnings, []);
});

test('container round-trips through encode and decode', () => {
  const program = {
    name: 'HEJ',
    text: 'Disp "HEJ"\n',
    meta: { comment: 'test', archived: true, version: 4, separator: 0x13 },
  };
  const { bytes } = encode8xp(program);
  const back = decode8xp(bytes);

  assert.equal(back.name, 'HEJ');
  assert.equal(back.text, program.text);
  assert.equal(back.meta.archived, true);
  assert.equal(back.meta.version, 4);
  assert.equal(back.meta.separator, 0x13);
  assert.equal(back.meta.comment, 'test');
  assert.deepEqual(back.warnings, []);
});

test('the checksum covers the data section', () => {
  const { bytes } = encode8xp({ name: 'CHK', text: 'Disp 1\n' });
  const size = bytes[0x35] | (bytes[0x36] << 8);
  let sum = 0;
  for (let i = 0x37; i < 0x37 + size; i++) sum = (sum + bytes[i]) & 0xffff;
  assert.equal(sum, bytes[0x37 + size] | (bytes[0x37 + size + 1] << 8));
  assert.equal(bytes.length, 0x37 + size + 2);
});

test('a corrupt checksum is reported but still readable', () => {
  const { bytes } = encode8xp({ name: 'BAD', text: 'Disp 1\n' });
  bytes[bytes.length - 1] ^= 0xff;
  const back = decode8xp(bytes);
  assert.ok(back.warnings.some((w) => w.includes('Checksum mismatch')));
  assert.equal(back.text, 'Disp 1\n');
});

test('rejects files that are not TI variable files', () => {
  assert.throws(() => decode8xp(new Uint8Array(200)), /Not a TI calculator file/);
  assert.throws(() => decode8xp(new Uint8Array(4)), /too short/);
});

test('rejects variables that are not programs', () => {
  const { bytes } = encode8xp({ name: 'X', text: '' });
  bytes[0x3b] = 0x01; // a real number, not a program
  assert.throws(() => decode8xp(bytes), /not a program/);
});

test('older 0x0b variable headers are read as well as written', () => {
  const { bytes } = encode8xp({ name: 'OLD', text: 'Disp 1\n', meta: { headerSize: 0x0b } });
  const back = readVarFile(bytes);
  assert.equal(back.meta.headerSize, 0x0b);
  assert.equal(back.meta.archived, false);
  assert.equal(decode8xp(bytes).text, 'Disp 1\n');
});

test('the container carries any variable type, not only programs', () => {
  const data = Uint8Array.from([1, 2, 3, 4]);
  const bytes = writeVarFile({ data, name: 'X', type: 0x01 });
  const back = readVarFile(bytes);
  assert.equal(back.type, 0x01);
  assert.deepEqual(back.data, data);
  assert.throws(() => decode8xp(bytes), /not a program/);
});

test('program names follow the calculator rules', () => {
  assert.equal(defaultProgramName('hej'), 'HEJ');
  assert.equal(defaultProgramName('a-very-long-name'), 'AVERYLON');
  assert.equal(defaultProgramName('2fast'), 'PFAST');
  assert.equal(defaultProgramName('---'), 'PROGRAM');
});

test('a long program round-trips', () => {
  const text = Array.from({ length: 2000 }, (_, i) => `Disp ${i}`).join('\n') + '\n';
  const { bytes } = encode8xp({ name: 'BIG', text });
  assert.equal(decode8xp(bytes).text, text);
});

test('no token name is longer than the matcher looks ahead', () => {
  for (const { name } of BY_CODE.values()) assert.ok(name.length <= LONGEST_NAME);
});

/**
 * Byte-exactness against files produced by TI's own software and by the
 * community's tools.
 *
 * Real .8xp files are not committed (they are somebody's programs), so point
 * TI_SAMPLE_FILES at a folder holding them:
 *
 *   TI_SAMPLE_FILES=/path/to/folder node --test "packages/core/test/*.test.js"
 */
const samplesDir = process.env.TI_SAMPLE_FILES;
test('re-encoding real calculator files is byte-exact', { skip: !samplesDir || !existsSync(samplesDir) }, () => {
  const files = readdirSync(samplesDir).filter((f) => ['.8xp', '.83p', '.82p'].includes(extname(f).toLowerCase()));
  assert.ok(files.length > 0, 'no program files found in TI_SAMPLE_FILES');

  for (const file of files) {
    const original = new Uint8Array(readFileSync(join(samplesDir, file)));
    const program = decode8xp(original);
    const { bytes } = encode8xp(program);
    assert.deepEqual(bytes, original, `${file} did not re-encode byte-for-byte`);
  }
});
