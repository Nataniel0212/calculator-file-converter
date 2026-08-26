/**
 * The container format: the 32-byte obfuscated header shared by g1e/g1m/g1r
 * and friends, plus the group/item headers that sit behind it.
 *
 * See docs/G1E-FORMAT.md for how this was derived.
 */

export const MAGIC = 'USBPower';

/** File type byte found at offset 0x08 of the de-obfuscated header. */
export const FileType = {
  EACTIVITY: 0x49,
  MAIN_MEMORY: 0x31,
  ADDIN: 0x2c,
};

/** Bitwise-invert a byte range. The header is stored this way on disk. */
export function invert(bytes) {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = ~bytes[i] & 0xff;
  return out;
}

export function readU32(bytes, offset) {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>> 0
  );
}

export function writeU32(bytes, offset, value) {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

/**
 * Read and validate the standard header.
 *
 * @param {Uint8Array} bytes whole file
 * @returns {{fileType: number, declaredSize: number, controlOk: boolean}}
 */
export function readStandardHeader(bytes) {
  if (bytes.length < 0x20) {
    throw new FormatError('File is too short to be a calculator file.');
  }
  const header = invert(bytes.subarray(0, 0x20));
  const magic = String.fromCharCode(...header.subarray(0, 8));
  if (magic !== MAGIC) {
    throw new FormatError(
      `Not a calculator file: expected the "${MAGIC}" signature, found "${printable(magic)}".`,
    );
  }
  const declaredSize = readU32(header, 0x10);
  return {
    fileType: header[0x08],
    declaredSize,
    controlOk:
      header[0x0e] === ((declaredSize + 0x41) & 0xff) &&
      header[0x14] === ((declaredSize + 0xb8) & 0xff),
  };
}

/**
 * Build the 32-byte standard header for a file of the given size.
 *
 * @param {number} fileType one of {@link FileType}
 * @param {number} fileSize total size of the finished file
 */
export function buildStandardHeader(fileType, fileSize) {
  const header = new Uint8Array(0x20).fill(0xff);
  for (let i = 0; i < 8; i++) header[i] = MAGIC.charCodeAt(i);
  header[0x08] = fileType;
  header.set([0x00, 0x10, 0x00, 0x10, 0x00], 0x09);
  header[0x0e] = (fileSize + 0x41) & 0xff; // control byte 1
  header[0x0f] = 0x01;
  writeU32(header, 0x10, fileSize);
  header[0x14] = (fileSize + 0xb8) & 0xff; // control byte 2
  return invert(header);
}

/** Write an 8-byte NUL-padded name, as used by group and item headers. */
export function writeName(bytes, offset, name) {
  for (let i = 0; i < 8; i++) {
    bytes[offset + i] = i < name.length ? name.charCodeAt(i) : 0;
  }
}

/** Read an 8-byte NUL-padded name. */
export function readName(bytes, offset) {
  let name = '';
  for (let i = 0; i < 8 && bytes[offset + i] !== 0; i++) {
    name += String.fromCharCode(bytes[offset + i]);
  }
  return name;
}

export class FormatError extends Error {
  name = 'FormatError';
}

function printable(s) {
  return s.replace(/[^\x20-\x7e]/g, '?');
}
