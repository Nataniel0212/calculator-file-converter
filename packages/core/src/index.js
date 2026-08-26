/**
 * calcconv-core — codecs for graphing calculator file formats.
 *
 * Zero dependencies, no build step. The same modules run in Node and in the
 * browser; everything works on `Uint8Array` and plain strings.
 */

export {
  FormatError,
  FileType,
  buildStandardHeader,
  readStandardHeader,
} from './container.js';

export {
  decodeText,
  encodeText,
  isCalculatorSafe,
  TRANSLITERATIONS,
} from './charset.js';

export {
  decodeG1e,
  encodeG1e,
  defaultHeading,
  g1eToText,
  textToG1e,
} from './g1e.js';

export {
  Signature,
  VarType,
  decode8xp,
  encode8xp,
  detokenize,
  tokenize,
  splitTokens,
  readVarFile,
  writeVarFile,
  defaultProgramName,
  programToText,
  textToProgram,
  formatIdFor,
} from './ti8x.js';

export {
  decode8xl,
  encode8xl,
  decode8xm,
  encode8xm,
  decodeReal,
  encodeReal,
  parseNumericCsv,
  toCsv,
  toNumber,
  readVarName,
  listNameBytes,
  matrixNameBytes,
} from './ti8x-data.js';

export { BY_CODE as TOKENS_8X, MODELS as TI_MODELS } from './tokens-8x.js';

/** Formats this build can convert. Extended as codecs land. */
export const FORMATS = [
  {
    id: 'g1e',
    label: 'e-Activity',
    vendor: 'Casio fx-9860G series',
    extensions: ['.g1e'],
    counterpart: { extensions: ['.txt'], label: 'Plain text' },
    directions: ['decode', 'encode'],
  },
  {
    id: '8xp',
    label: 'TI-BASIC program',
    vendor: 'TI-83/84 series',
    extensions: ['.8xp', '.83p', '.82p'],
    counterpart: { extensions: ['.txt'], label: 'Plain text' },
    directions: ['decode', 'encode'],
  },
  {
    id: '8xl',
    label: 'TI list',
    vendor: 'TI-83/84 series',
    extensions: ['.8xl'],
    counterpart: { extensions: ['.csv'], label: 'CSV' },
    directions: ['decode', 'encode'],
  },
  {
    id: '8xm',
    label: 'TI matrix',
    vendor: 'TI-83/84 series',
    extensions: ['.8xm'],
    counterpart: { extensions: ['.csv'], label: 'CSV' },
    directions: ['decode', 'encode'],
  },
];
