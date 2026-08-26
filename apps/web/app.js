import {
  decodeG1e,
  encodeG1e,
  defaultHeading,
  decode8xp,
  encode8xp,
  programToText,
  textToProgram,
  defaultProgramName,
  formatIdFor,
  decode8xl,
  encode8xl,
  decode8xm,
  encode8xm,
  parseNumericCsv,
  toCsv,
  FormatError,
} from './vendor/core/index.js';
import { makeZip } from './lib/zip.js';
import * as pickers from './lib/pickers.js';

/**
 * What a .txt turns into when it does not say for itself. Everything else —
 * which way round a conversion goes, which calculator a file came from — is
 * read off the file, so this is the only choice left to make.
 */
const FUNCTIONS = [
  { id: 'g1e-txt', label: 'A Casio fx-9860G document (.g1e)', kind: 'g1e' },
  { id: '8xp-txt', label: 'A TI-83/84 program (.8xp)', kind: 'ti' },
];

/** What a .csv turns into. The shape of the file answers this on its own. */
const DATA_FUNCTIONS = [
  { id: 'auto', label: 'A list, or a matrix if there are several columns' },
  { id: '8xl', label: 'Always a list (.8xl)' },
  { id: '8xm', label: 'Always a matrix (.8xm)' },
];

/**
 * What each calculator will and will not accept, in the place where the choice
 * is made. These are the things people otherwise find out from a calculator
 * screen an hour later: no lower case on the Casio, Å and Ö silently becoming
 * A and O, a list that stops at 999 values.
 */
const FORMAT_NOTES = {
  g1e: {
    gist: '21 characters a line, capitals only, no Å Ä Ö',
    notes: [
      'Lines longer than 21 characters wrap on the screen. The converter counts them for you.',
      'There is no lower case on this calculator: it draws a–z as small capitals.',
      'Å Ä Ö and other accents do not exist here. With the option below on they become A, A and O, and every substitution is listed; with it off the file is refused instead so nothing changes behind your back.',
    ],
  },
  ti: {
    gist: '16 characters a line, TI-BASIC only, no Å Ä Ö',
    notes: [
      'The home screen fits 16 characters.',
      'Every word has to be a TI-BASIC token — Disp, Then, randInt(. Anything else is dropped, and the line it was on is named.',
      'Å Ä Ö are not tokens. Lower case is, but only on a TI-83+ or newer.',
    ],
  },
  data: {
    gist: 'Numbers only, 999 to a list, 14 digits each',
    notes: [
      'The calculator keeps 14 digits of a number and no more, so longer ones are rounded to fit.',
      'A list takes up to 999 values; a matrix up to 99 by 99.',
      'A list is called L1–L6 or up to five letters; a matrix is called [A]–[J]. A name that does not fit is changed, and the change is reported.',
      'A first row of column labels is set aside. Decimal commas are understood, and a file that could be read two ways says which way it was taken.',
    ],
  },
};

/** Per-family facts the interface needs. */
const FAMILIES = {
  // Characters that fit on one line of each machine's display.
  g1e: { screen: 21, extensions: ['g1e'] },
  ti: { screen: 16, extensions: ['8xp', '83p', '82p'] },
  data: { screen: 16, extensions: ['8xl', '8xm'] },
};

const CALC_EXTENSIONS = Object.values(FAMILIES).flatMap((f) => f.extensions);
const INPUT_PATTERN = new RegExp(`\\.(${[...CALC_EXTENSIONS, 'txt', 'csv'].join('|')})$`, 'i');

const DIRECTIONS = [
  { id: 'auto', label: 'Everything' },
  { id: 'toPc', label: 'Only to computer' },
  { id: 'toCalc', label: 'Only to calculator' },
];

/**
 * Every element the page needs, looked up once by id and reached as
 * `el.chooseFolder`. A lookup table, so it is typed as one.
 * @type {Record<string, any>}
 */
const el = {};
for (const id of [
  'function', 'direction', 'translit', 'add-files', 'clear', 'dropzone', 'queue', 'queue-body',
  'empty', 'filepicker', 'choose-source', 'source-path', 'choose-folder', 'dest-path',
  'history', 'history-row', 'detail', 'screen-hint', 'function-row', 'translit-row',
  'filter', 'filter-count', 'escape-hint', 'data-function', 'data-row', 'format-notes', 'data-notes',
  'format-limits', 'data-limits', 'format-summary',
  'detail-name', 'detail-stats', 'detail-close', 'screen', 'heading-field', 'heading-input',
  'text-input', 'status-lamp', 'status-text', 'progress', 'start',
]) {
  el[id.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = document.getElementById(id);
}

/** Below this many files, scanning the list beats typing at it. */
const FILTER_THRESHOLD = 8;

/** @type {any[]} */
let items = [];
let filterText = '';
let direction = 'auto';
let selectedId = null;
let nextId = 1;
/** @type {{handle: FileSystemDirectoryHandle, name: string} | null} */
let destination = null;
/** Where the files in the list came from, for the "Read from" field. */
let source = null;

// ------------------------------------------------------------ conversion setup

el.function.replaceChildren(
  ...FUNCTIONS.map((fn) => {
    const option = document.createElement('option');
    option.value = fn.id;
    option.textContent = fn.label;
    return option;
  }),
);
el.function.value = FUNCTIONS[0].id;
el.function.addEventListener('change', () => {
  for (const item of items) analyse(item);
  refresh();
});

/**
 * Show only the controls that can change the outcome, and put each format's
 * limits next to the control that picks it. Nothing is going to a calculator
 * when the list is only being read off one, so neither the target format nor
 * the Casio substitution rule has anything to act on then.
 */
function refreshControls() {
  const toCalculator = direction !== 'toPc';
  const hasNumbers = items.some((item) => item.ext === 'csv');

  el.functionRow.hidden = !toCalculator;
  el.dataRow.hidden = !toCalculator || !hasNumbers;
  el.translitRow.hidden = !toCalculator || selectedKind() !== 'g1e';

  const format = FORMAT_NOTES[selectedKind()];
  el.formatNotes.replaceChildren(...format.notes.map((note) => text('li', note)));
  el.formatSummary.textContent = format.gist;
  el.dataNotes.replaceChildren(...FORMAT_NOTES.data.notes.map((note) => text('li', note)));
}

/**
 * The limits fold away, because they are reference: everyone needs them once
 * and nobody needs them twice. What must not fold away is the reason someone
 * would open them, so the summary line carries the constraints that actually
 * catch people out rather than a label saying help lives here. Whatever the
 * reader last chose is what they get next time.
 */
for (const box of [el.formatLimits, el.dataLimits]) {
  const key = `calcconv.limits.${box.id}`;
  try {
    box.open = localStorage.getItem(key) === 'open';
  } catch {
    box.open = false; // private browsing, or storage turned off
  }
  box.addEventListener('toggle', () => {
    try { localStorage.setItem(key, box.open ? 'open' : 'closed'); } catch { /* ignore */ }
  });
}

el.dataFunction.replaceChildren(
  ...DATA_FUNCTIONS.map((fn) => {
    const option = document.createElement('option');
    option.value = fn.id;
    option.textContent = fn.label;
    return option;
  }),
);
el.dataFunction.value = DATA_FUNCTIONS[0].id;
el.dataFunction.addEventListener('change', () => {
  for (const item of items) analyse(item);
  refresh();
});

/** The family a plain .txt turns into when the file itself does not say. */
function selectedKind() {
  return FUNCTIONS.find((fn) => fn.id === el.function.value)?.kind ?? 'g1e';
}

el.direction.replaceChildren(
  ...DIRECTIONS.map((d) => {
    const label = document.createElement('label');
    label.className = 'radio';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'direction';
    input.value = d.id;
    input.checked = d.id === direction;
    input.addEventListener('change', () => {
      direction = d.id;
      for (const item of items) analyse(item);
      refresh();
    });
    const span = document.createElement('span');
    span.textContent = d.label;
    label.append(input, span);
    return label;
  }),
);

el.translit.addEventListener('change', () => {
  for (const item of items) if (item.direction) build(item);
  refresh();
});

refreshControls();

// ------------------------------------------------------------ file input

/**
 * Open the file dialog. The picker below keeps its own remembered directory,
 * so choosing an output folder does not move where this dialog opens.
 */
async function browseForFiles() {
  try {
    const files = await pickers.pickFiles();
    if (files === null) {
      el.filepicker.click(); // no picker API here — use the hidden input
      return;
    }
    if (files.length) addFiles(files, 'Selected files');
  } catch (error) {
    setStatus('err', `Could not open the file dialog: ${reason(error)}`);
  }
}

/** Take every convertible file out of one folder. */
async function browseForFolder() {
  try {
    const picked = await pickers.pickInputDirectory((name) => INPUT_PATTERN.test(name));
    if (!picked) return;
    if (!picked.files.length) {
      setStatus('warn', `“${picked.name}” holds no calculator or .txt files.`);
      return;
    }
    addFiles(picked.files, picked.name);
  } catch (error) {
    setStatus('err', `Could not open that folder: ${reason(error)}`);
  }
}

// Redrawing the list is proportional to how long it is, and the filter only
// appears once it is long. Coalesce a burst of typing into one redraw.
let filterTimer;
el.filter.addEventListener('input', () => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => {
    filterText = el.filter.value;
    renderQueue();
  }, 90);
});

/** Up and down move between rows; Enter and Space open one. */
function onRowKey(event, item) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openDetail(item);
    return;
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  event.preventDefault();
  const rows = [...el.queueBody.querySelectorAll('tr.clickable')];
  const next = rows.indexOf(event.currentTarget) + (event.key === 'ArrowDown' ? 1 : -1);
  rows[next]?.focus();
}

el.addFiles.addEventListener('click', browseForFiles);
el.empty.addEventListener('click', browseForFiles);
el.chooseSource.addEventListener('click', browseForFolder);
if (!pickers.supported) {
  el.chooseSource.disabled = true;
  el.chooseSource.title = 'This browser cannot open a whole folder — drag one in instead';
}
el.filepicker.addEventListener('change', () => {
  addFiles([...el.filepicker.files], 'Selected files');
  el.filepicker.value = '';
});

el.dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    browseForFiles();
  }
});

// A file dropped anywhere else would otherwise make the browser navigate to it.
for (const type of ['dragover', 'drop']) {
  window.addEventListener(type, (event) => {
    if (!el.dropzone.contains(/** @type {Node} */ (event.target))) event.preventDefault();
  });
}

// Counted, because dragleave also fires when the pointer crosses a child element.
let dragDepth = 0;
el.dropzone.addEventListener('dragenter', (event) => {
  event.preventDefault();
  if (dragDepth++ === 0) el.dropzone.classList.add('dragging');
});
el.dropzone.addEventListener('dragover', (event) => event.preventDefault());
el.dropzone.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    el.dropzone.classList.remove('dragging');
  }
});
el.dropzone.addEventListener('drop', async (event) => {
  event.preventDefault();
  dragDepth = 0;
  el.dropzone.classList.remove('dragging');
  const entries = [...event.dataTransfer.items]
    .map((item) => item.webkitGetAsEntry?.())
    .filter(Boolean);

  if (!entries.length) {
    addFiles([...event.dataTransfer.files], 'Dropped files');
    return;
  }
  // name the drop after the folder it came from, when it was a folder
  const folders = entries.filter((entry) => entry.isDirectory).map((entry) => entry.name);
  const label =
    folders.length === 1 ? folders[0] : folders.length ? `${folders.length} folders` : 'Dropped files';
  addFiles(await collectEntries(entries), label);
});

/** Walk dropped folders recursively. */
async function collectEntries(entries) {
  const files = [];
  const visit = async (entry) => {
    if (entry.isFile) {
      files.push(await new Promise((resolve) => entry.file(resolve)));
      return;
    }
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((resolve) => reader.readEntries(resolve));
      if (!batch.length) break;
      await Promise.all(batch.map(visit));
    }
  };
  await Promise.all(entries.map(visit));
  return files;
}

async function addFiles(files, from = 'Selected files') {
  if (files.length) source = source && source !== from ? 'Several places' : from;
  for (const file of files) {
    const dot = file.name.lastIndexOf('.');
    const item = {
      id: nextId++,
      name: file.name,
      from,
      stem: dot > 0 ? file.name.slice(0, dot) : file.name,
      ext: dot > 0 ? file.name.slice(dot + 1).toLowerCase() : '',
      raw: new Uint8Array(await file.arrayBuffer()),
      direction: null,
      status: 'skipped',
      reason: undefined,
      heading: '',
      lines: [],
      baseNotes: [],
      notes: [],
      edited: false,
      outName: '',
      output: new Uint8Array(),
      longLines: 0,
      saved: false,
    };
    analyse(item);
    items.push(item);
  }
  refresh();
}

// ------------------------------------------------------------ conversion

/** Decide what to do with an item under the current settings, and do it. */
function analyse(item) {
  const wanted = directionFor(item.ext);
  const kind = kindFor(item);
  const changedKind = item.kind !== kind;
  item.kind = kind;

  if (!wanted) {
    Object.assign(item, {
      direction: null,
      status: 'skipped',
      reason: reasonForSkipping(item.ext),
      outName: '',
      output: new Uint8Array(),
      notes: [],
      saved: false,
    });
    return;
  }

  const changed = item.direction !== wanted || changedKind;
  item.direction = wanted;
  item.reason = undefined;
  item.saved = false;

  if (changed || !item.edited) {
    try {
      if (kind === 'data') {
        analyseData(item, wanted);
      } else if (wanted === 'toText' && kind === 'ti') {
        const program = decode8xp(item.raw);
        item.progName = program.name;
        item.meta = program.meta;
        item.lines = program.text.split('\n');
        item.baseNotes = [...program.warnings];
      } else if (wanted === 'toText') {
        const doc = decodeG1e(item.raw);
        item.heading = doc.heading;
        item.lines = doc.lines;
        item.baseNotes = [...doc.warnings];
      } else if (kind === 'ti') {
        // The header a decoded program carries names it and records the bytes
        // that vary between tools, so a file that came from here goes back
        // unchanged. A hand-written one simply has no header and gets defaults.
        const program = textToProgram(decodeUtf8(item.raw), { name: item.stem });
        item.progName = program.name;
        item.meta = program.meta;
        item.lines = program.text.split('\n');
        item.baseNotes = [];
      } else {
        item.heading = item.heading || defaultHeading(item.stem);
        item.lines = splitLines(decodeUtf8(item.raw));
        item.baseNotes = [];
      }
      item.edited = false;
    } catch (error) {
      Object.assign(item, {
        status: 'error',
        reason:
          error instanceof FormatError
            ? error.message
            : `Could not read this file: ${reason(error)}`,
        // (a FormatError already explains itself in the user's terms)
        outName: '',
        output: new Uint8Array(),
        notes: [],
      });
      return;
    }
  }

  build(item);
}

/**
 * Lists and matrices are numbers, not text, so they take the same route in a
 * different currency: rows of values rather than lines of characters. Holding
 * them in `lines` keeps one code path for the queue, the preview and saving.
 */
function analyseData(item, wanted) {
  if (wanted === 'toText') {
    // A list yields values and a matrix yields rows. Reading each in its own
    // branch keeps the two shapes from being quietly treated as one.
    if (item.ext === '8xl') {
      const list = decode8xl(item.raw);
      item.varName = list.name;
      item.meta = list.meta;
      item.dataShape = '8xl';
      item.rows = list.values.map((value) => [value]);
      item.baseNotes = [...list.warnings];
    } else {
      const matrix = decode8xm(item.raw);
      item.varName = matrix.name;
      item.meta = matrix.meta;
      item.dataShape = '8xm';
      item.rows = matrix.rows;
      item.baseNotes = [...matrix.warnings];
    }
  } else {
    const { rows, warnings, skippedHeader } = parseNumericCsv(decodeUtf8(item.raw));
    if (!rows.length) throw new FormatError('This file holds no numbers.');

    const chosen = el.dataFunction.value;
    item.dataShape = chosen === 'auto' ? (rows[0].length === 1 ? '8xl' : '8xm') : chosen;
    item.varName = item.varName || item.stem;
    item.rows = rows;
    item.baseNotes = [...warnings];
    if (skippedHeader.length) {
      item.baseNotes.push(
        `Set aside the first row (${skippedHeader.join(', ')}) — the calculator holds numbers only.`,
      );
    }
  }
  item.lines = item.rows.map((row) => row.map((v) => (v === null ? '' : String(v))).join(', '));
}

/** Which direction the current settings assign to this extension, if any. */
function directionFor(ext) {
  const fromCalculator = CALC_EXTENSIONS.includes(ext);
  const fromComputer = ext === 'txt' || ext === 'csv';
  if (direction === 'toPc') return fromCalculator ? 'toText' : null;
  if (direction === 'toCalc') return fromComputer ? 'toCalc' : null;
  if (fromCalculator) return 'toText';
  if (fromComputer) return 'toCalc';
  return null;
}

/**
 * Which calculator family an item belongs to. A calculator file says so by its
 * extension; a text file says so in its own header if it has one, and
 * otherwise follows whatever the Conversion box is set to.
 */
function kindFor(item) {
  for (const [kind, family] of Object.entries(FAMILIES)) {
    if (family.extensions.includes(item.ext)) return kind;
  }
  if (item.ext === 'csv') return 'data';
  if (item.ext !== 'txt') return selectedKind();
  return /^#format:[ \t]?(8xp|83p|82p)\b/.test(decodeUtf8(item.raw).slice(0, 200))
    ? 'ti'
    : selectedKind();
}

/** Characters that fit on one line of this item's display. */
function screenWidth(item) {
  return FAMILIES[item.kind ?? 'g1e'].screen;
}

function decodeUtf8(bytes) {
  return new TextDecoder().decode(bytes).replace(/^﻿/, '');
}

/**
 * What to tell somebody when a call threw. Anything can be thrown, not only an
 * Error, and "Could not save: undefined" helps nobody.
 */
function reason(error) {
  return error instanceof Error ? error.message : String(error);
}

function reasonForSkipping(ext) {
  const label = ext ? '.' + ext : 'This';
  if (direction === 'toPc') return `${label} files are not read when converting to computer.`;
  if (direction === 'toCalc') return `${label} files are not read when converting to calculator.`;
  return `${label} files are not a format this converter handles yet.`;
}

/**
 * (Re)produce the output bytes from an item's current text. Notes are rebuilt
 * from scratch every time so repeated edits cannot pile up duplicates.
 */
function build(item) {
  const notes = [...(item.baseNotes ?? [])];
  const width = screenWidth(item);

  if (item.kind === 'data') {
    if (item.direction === 'toText') {
      item.outName = item.stem + '.csv';
      item.output = new TextEncoder().encode(toCsv(item.rows, { newline: '\r\n' }));
    } else {
      const isList = item.dataShape === '8xl';
      const result = isList
        ? encode8xl({ name: item.varName, values: item.rows.map((row) => row[0]) })
        : encode8xm({ name: item.varName, rows: item.rows });
      if (isList && item.rows[0].length > 1) {
        notes.push(
          `Only the first of ${item.rows[0].length} columns became the list. ` +
            'Choose "Always a matrix" above to keep all of them.',
        );
      }
      item.outName = item.stem.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) + '.' + item.dataShape;
      item.output = result.bytes;
      notes.push(...result.warnings);
    }
  } else if (item.direction === 'toText' && item.kind === 'ti') {
    item.outName = item.stem + '.txt';
    // Token names include accented letters, so these files are UTF-8 — unlike
    // the Casio side, whose text is that calculator's own byte-per-glyph set.
    item.output = new TextEncoder().encode(
      programToText({ name: item.progName, text: item.lines.join('\n'), meta: item.meta }, { newline: '\r\n' }),
    );
  } else if (item.direction === 'toText') {
    item.outName = item.stem + '.txt';
    item.output = latin1(item.lines.join('\r\n') + '\r\n');
  } else if (item.kind === 'ti') {
    const { bytes, warnings } = encode8xp({
      name: item.progName || defaultProgramName(item.stem),
      text: item.lines.join('\n'),
      meta: item.meta,
    });
    // A .83p stays a .83p: the signature travels in the item's metadata, so
    // the name has to follow it rather than assume the newest family.
    item.outName =
      (item.progName || defaultProgramName(item.stem)) + '.' + formatIdFor(item.meta?.signature);
    item.output = bytes;
    notes.push(...warnings);
  } else {
    const { bytes, warnings } = encodeG1e(
      { heading: item.heading, lines: item.lines },
      { transliterate: el.translit.checked },
    );
    // Upper case throughout, matching what the calculator shows in its
    // storage memory listing.
    item.outName = item.stem.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) + '.G1E';
    item.output = bytes;
    notes.push(...warnings);
  }

  item.longLines = item.lines.filter((line) => line.length > width).length;
  // Only worth saying when the file is heading for the calculator — a text
  // file on a computer has no line width to run out of, and numbers land in a
  // table rather than on the home screen.
  if (item.longLines && item.direction === 'toCalc' && item.kind !== 'data') {
    const first = item.lines.findIndex((line) => line.length > width) + 1;
    notes.push(
      `${item.longLines} line${item.longLines === 1 ? '' : 's'} longer than ${width} characters, ` +
        `from line ${first} — these wrap on the calculator screen.`,
    );
  }

  item.notes = notes;
  item.status = notes.length ? 'warn' : 'ready';
  // The bytes just changed, so whatever was written earlier is now stale.
  item.saved = false;
}

// ------------------------------------------------------------ destination

if (!pickers.supported) {
  el.chooseFolder.disabled = true;
  el.chooseFolder.title = 'This browser cannot write to folders — files are downloaded instead';
  el.destPath.textContent = 'Downloads folder (this browser cannot pick one)';
}

el.chooseFolder.addEventListener('click', async () => {
  try {
    const handle = await pickers.pickDirectory();
    if (!handle) return;
    destination = { handle, name: handle.name };
    await loadHistory();
    refresh();
  } catch (error) {
    // Not every context allows writing to a folder; fall back to downloading.
    destination = null;
    el.chooseFolder.disabled = true;
    refresh();
    setStatus('warn', `Cannot pick a folder here (${reason(error)}) — files will be downloaded instead.`);
  }
});

el.history.addEventListener('change', async () => {
  const recent = await pickers.recentDirectories();
  const row = recent.find((r) => r.id === el.history.value);
  if (!row) return;
  if (!(await pickers.ensureWritable(row.handle))) {
    setStatus('err', `Permission to write to “${row.name}” was declined.`);
    return;
  }
  destination = { handle: row.handle, name: row.name };
  refresh();
});

async function loadHistory() {
  const recent = await pickers.recentDirectories();
  el.historyRow.hidden = recent.length === 0;
  el.history.replaceChildren(
    ...recent.map((row) => {
      const option = document.createElement('option');
      option.value = row.id;
      option.textContent = row.name;
      option.selected = destination?.name === row.name;
      return option;
    }),
  );
}

// ------------------------------------------------------------ the one button

/**
 * What the button acts on: the files that have not been saved yet. Once
 * everything in the list has been saved it falls back to the whole list, so
 * "save all again" into a second folder is still one click.
 */
function filesToSave() {
  const ready = items.filter((item) => item.output.length);
  const pending = ready.filter((item) => !item.saved);
  return pending.length ? pending : ready;
}

function markSaved(files) {
  for (const item of files) {
    item.saved = true;
    item.savedTo = destination ? destination.name : 'your downloads';
  }
}

el.start.addEventListener('click', async () => {
  const ready = filesToSave();
  if (!ready.length) return;

  el.start.disabled = true;
  try {
    if (destination) {
      if (!(await pickers.ensureWritable(destination.handle))) {
        setStatus('err', 'Permission to write to that folder was declined.');
        return;
      }
      await pickers.writeFiles(
        destination.handle,
        ready.map((item) => ({ name: item.outName, bytes: item.output })),
        (done, total) => {
          el.progress.textContent = `${done} of ${total}`;
        },
      );
      markSaved(ready);
      announce(`Saved ${count(ready.length)} to ${destination.name}`);
    } else if (ready.length === 1) {
      download(ready[0].outName, ready[0].output);
      markSaved(ready);
      announce(`Saved ${ready[0].outName} to your downloads`);
    } else {
      downloadBlob('converted.zip', makeZip(ready.map((i) => ({ name: i.outName, bytes: i.output }))));
      markSaved(ready);
      announce(`Saved ${count(ready.length)} to your downloads as converted.zip`);
    }
    renderQueue();
  } catch (error) {
    setStatus('err', `Could not save: ${reason(error)}`);
  } finally {
    el.progress.textContent = '';
    el.start.disabled = false;
  }
});

el.clear.addEventListener('click', () => {
  items = [];
  source = null;
  closeDetail();
  refresh();
});

// ------------------------------------------------------------ rendering

function refresh() {
  refreshControls();
  renderQueue();
  renderStatus();
  el.destPath.textContent = destination
    ? destination.name
    : pickers.supported
      ? 'Downloads folder'
      : 'Downloads folder (this browser cannot pick one)';
  el.sourcePath.textContent = source ?? 'Nothing added yet';
}

/**
 * A note that names a line becomes a link to it. Saying "3 lines are too long"
 * and leaving the reader to find them is most of the way to saying nothing.
 * The line number is read back out of the message rather than threaded through
 * the codecs, which report in prose so the command line can print them as-is.
 */
function noteItem(item, note, isError) {
  const at = /\bline (\d+)/i.exec(note);
  if (!at || !item.direction) return text('li', note, isError ? 'err' : '');

  const li = document.createElement('li');
  const button = text('button', note, 'note-link');
  button.type = 'button';
  button.title = `Show line ${at[1]}`;
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    openDetail(item);
    selectLine(Number(at[1]));
  });
  li.append(button);
  return li;
}

/** Put the caret on a line of the text box and scroll it into view. */
function selectLine(number) {
  const lines = el.textInput.value.split('\n');
  const index = Math.min(Math.max(number, 1), lines.length) - 1;
  const start = lines.slice(0, index).reduce((n, line) => n + line.length + 1, 0);

  el.textInput.focus();
  el.textInput.setSelectionRange(start, start + lines[index].length);
  // No scrollIntoView for a range inside a textarea, so approximate it.
  const lineHeight = el.textInput.scrollHeight / (lines.length || 1);
  el.textInput.scrollTop = Math.max(0, lineHeight * index - el.textInput.clientHeight / 2);
}

/** The list as the filter box leaves it. */
function visibleItems() {
  const needle = filterText.trim().toLowerCase();
  if (!needle) return items;
  return items.filter(
    (item) =>
      item.name.toLowerCase().includes(needle) || item.outName.toLowerCase().includes(needle),
  );
}

function renderQueue() {
  const has = items.length > 0;
  const shown = visibleItems();

  // The filter only earns its place once the list is long enough to need it.
  el.filter.hidden = items.length < FILTER_THRESHOLD;
  if (el.filter.hidden && filterText) {
    filterText = '';
    el.filter.value = '';
  }
  el.filterCount.textContent =
    !el.filter.hidden && filterText ? `${shown.length} of ${items.length}` : '';

  el.queue.hidden = !has;
  el.empty.hidden = has;
  if (!has) {
    el.queueBody.replaceChildren();
    return;
  }
  if (!shown.length) {
    el.queueBody.replaceChildren(
      (() => {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 6;
        td.className = 'muted pad';
        td.textContent = `No file here matches “${filterText}”.`;
        tr.append(td);
        return tr;
      })(),
    );
    return;
  }

  const rows = [];
  for (const item of shown) {
    const tr = document.createElement('tr');
    if (item.direction) {
      tr.className = 'clickable' + (item.id === selectedId ? ' selected' : '');
      tr.tabIndex = 0;
      tr.addEventListener('click', () => openDetail(item));
      tr.addEventListener('keydown', (event) => onRowKey(event, item));
    }

    // A saved file shows a tick instead of a lamp — the one state change the
    // user needs to see without reading anything.
    const mark = document.createElement('span');
    if (item.saved) {
      mark.className = 'tick';
      mark.textContent = '✓';
      mark.title = item.savedTo ? `Saved to ${item.savedTo}` : 'Saved';
    } else {
      mark.className = `lamp ${{ ready: '', warn: 'warn', error: 'err', skipped: 'skip' }[item.status]}`;
      mark.title = { ready: 'Ready', warn: 'Ready, with notes', error: 'Could not read', skipped: 'Skipped' }[
        item.status
      ];
    }
    if (item.saved) tr.classList.add('saved');
    tr.append(cell(mark, 'col-status'));

    const inName = text('span', item.name, 'name' + (item.direction ? '' : ' muted'));
    if (item.from) inName.title = `From ${item.from}`;
    tr.append(cell(inName, 'col-name'));

    const outName = text('span', item.outName || '—', 'name out' + (item.outName ? '' : ' muted'));
    if (item.outName) {
      outName.title = item.saved
        ? `Saved to ${item.savedTo}`
        : `Will be written to ${destination ? destination.name : 'your downloads folder'}`;
    }
    tr.append(cell(outName, 'col-out'));
    tr.append(cell(text('span', item.direction ? String(item.lines.length) : '—'), 'col-num'));
    tr.append(cell(text('span', item.output.length ? formatSize(item.output.length) : '—'), 'col-num'));

    const remove = text('button', '✕', 'x');
    remove.type = 'button';
    remove.title = 'Remove from list';
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      items = items.filter((other) => other.id !== item.id);
      if (selectedId === item.id) closeDetail();
      refresh();
    });
    tr.append(cell(remove, 'col-act'));
    rows.push(tr);

    const notes = item.reason ? [item.reason, ...item.notes] : item.notes;
    if (notes.length) {
      const noteRow = document.createElement('tr');
      noteRow.className = 'notes-row';
      const td = document.createElement('td');
      td.colSpan = 6;
      const list = document.createElement('ul');
      list.className = 'notes';
      list.replaceChildren(
        ...notes.map((note, index) =>
          noteItem(item, note, item.status === 'error' && index === 0),
        ),
      );
      td.append(list);
      noteRow.append(td);
      rows.push(noteRow);
    }
  }
  el.queueBody.replaceChildren(...rows);
}

function renderStatus() {
  const ready = items.filter((i) => i.output.length);
  const alreadySaved = ready.filter((i) => i.saved).length;
  const pending = ready.length - alreadySaved;

  el.start.disabled = ready.length === 0;
  // leave the button alone while it is showing its "Saved" confirmation
  if (!el.start.classList.contains('done')) {
    el.start.textContent = startLabel();
    el.start.title = pending
      ? `Only the ${pending} file${pending === 1 ? '' : 's'} not saved yet`
      : 'Everything here has been saved already — this writes all of it once more';
  }

  if (!items.length) return setStatus('idle', 'No files');

  const parts = [`${pending} ready`];
  const warned = items.filter((i) => i.status === 'warn' && !i.saved).length;
  const skipped = items.filter((i) => i.status === 'skipped').length;
  const failed = items.filter((i) => i.status === 'error').length;
  if (alreadySaved) parts.push(`${alreadySaved} already saved`);
  if (warned) parts.push(`${warned} with notes`);
  if (skipped) parts.push(`${skipped} skipped`);
  if (failed) parts.push(`${failed} unreadable`);
  setStatus(failed ? 'err' : warned ? 'warn' : pending ? 'ready' : 'idle', parts.join(' · '));
}

function setStatus(kind, message) {
  el.statusLamp.className = `lamp ${{ ready: '', warn: 'warn', err: 'err', idle: 'idle' }[kind]}`;
  el.statusText.className = 'status-text';
  el.statusText.textContent = message;
}

/**
 * Confirm that something actually happened. Clicking a button and seeing
 * nothing change is the worst outcome, so this says so in three places at
 * once: the status line, the button itself, and a tick on every saved row.
 */
let announceTimer;
function announce(message) {
  el.statusLamp.className = 'lamp';
  el.statusText.className = 'status-text done';
  el.statusText.textContent = `✓ ${message}`;

  el.start.textContent = 'Saved';
  el.start.classList.add('done');
  clearTimeout(announceTimer);
  // Recompute the label rather than restoring the old one: saving twice in
  // quick succession would otherwise leave the button stuck reading "Saved".
  announceTimer = setTimeout(() => {
    el.start.classList.remove('done');
    el.start.textContent = startLabel();
  }, 2200);
}

/** The button's caption for the current state of the list. */
function startLabel() {
  const ready = items.filter((i) => i.output.length);
  const pending = ready.filter((i) => !i.saved).length;
  const verb = destination ? 'save' : 'download';
  if (!pending) return destination ? 'Save all again' : 'Download all again';
  return `Convert and ${verb}` + (ready.length - pending ? ` (${pending})` : '');
}

function count(n) {
  return `${n} file${n === 1 ? '' : 's'}`;
}

// ------------------------------------------------------------ preview

function openDetail(item) {
  selectedId = item.id;
  el.detail.hidden = false;
  el.detailName.textContent = `${item.name} → ${item.outName}`;
  // Only the Casio document has a heading line; a TI program has a name, and
  // that comes from the file's own header.
  el.headingField.hidden = !(item.direction === 'toCalc' && item.kind === 'g1e');
  el.headingInput.value = item.heading ?? '';
  el.textInput.value = item.lines.join('\n');
  paint();
  renderQueue();
}

function closeDetail() {
  selectedId = null;
  el.detail.hidden = true;
}

/** Redraw the LCD and the readout for the open file. */
function paint() {
  const item = find(selectedId);
  if (!item) return;

  const rows = [];
  const width = screenWidth(item);
  if (item.direction === 'toCalc' && item.kind === 'g1e' && item.heading) {
    rows.push({ text: item.heading, head: true });
  }
  for (const line of item.lines) rows.push({ text: line, head: false });

  el.screen.replaceChildren(
    ...rows.flatMap((row) => {
      const nodes = [
        ...paintSegment(row.text.slice(0, width) || ' ', row.head ? 'head' : '', item.kind),
        ...paintSegment(row.text.slice(width), 'over', item.kind),
      ];
      nodes.push(document.createTextNode('\n'));
      return nodes;
    }),
  );

  el.escapeHint.hidden = !(item.kind === 'ti' && /\\[.\\x]/.test(item.lines.join('\n')));

  el.screenHint.textContent =
    `The screen fits ${width} characters. Anything past that is shown inverted and wraps on the calculator.`;

  el.detailStats.textContent =
    `${item.lines.length} lines · ${formatSize(item.output.length)}` +
    (item.longLines ? ` · ${item.longLines} wrap` : '');
}

/**
 * Draw one stretch of a line onto the screen. TI text carries escapes that are
 * not characters the calculator shows: a boundary is a hairline between two
 * tokens, a nameless byte is its hex. Drawing them literally would suggest the
 * calculator displays a backslash, which it does not.
 */
function paintSegment(content, className, kind) {
  if (!content) return [];
  if (kind !== 'ti') return [text('span', content, className)];

  const nodes = [];
  // Split on whole escapes, keeping them: `\\`, `\.`, `\xNN` or `\xNNNN`.
  for (const piece of content.split(/(\\\\|\\\.|\\x[0-9A-F]{2}(?:[0-9A-F]{2})?)/)) {
    if (!piece) continue;
    if (piece === '\\.') {
      const mark = text('span', '', `${className} boundary`.trim());
      mark.title = 'These two tokens stay separate';
      nodes.push(mark);
    } else if (piece === '\\\\') {
      nodes.push(text('span', '\\', className));
    } else if (piece.startsWith('\\x')) {
      const raw = text('span', piece.slice(2), `${className} raw`.trim());
      raw.title = 'A byte the token table has no name for';
      nodes.push(raw);
    } else {
      nodes.push(text('span', piece, className));
    }
  }
  return nodes;
}

el.textInput.addEventListener('input', () => {
  const item = find(selectedId);
  if (!item) return;
  item.lines = el.textInput.value.split('\n');
  // Numbers are edited as text but stored as numbers, so read them back.
  if (item.kind === 'data') {
    const { rows, warnings } = parseNumericCsv(el.textInput.value);
    item.rows = rows;
    item.baseNotes = warnings;
  }
  item.edited = true;
  build(item);
  paint();
  refresh();
});

el.headingInput.addEventListener('input', () => {
  const item = find(selectedId);
  if (!item) return;
  item.heading = el.headingInput.value;
  item.edited = true;
  build(item);
  paint();
  refresh();
});

el.detailClose.addEventListener('click', () => {
  closeDetail();
  renderQueue();
});

// ------------------------------------------------------------ helpers

function find(id) {
  return items.find((item) => item.id === id) ?? null;
}

function cell(child, className) {
  const td = document.createElement('td');
  if (className) td.className = className;
  td.append(child);
  return td;
}

function text(tag, content, className) {
  const node = document.createElement(tag);
  node.textContent = content;
  if (className) node.className = className;
  return node;
}

function splitLines(string) {
  const lines = string.split(/\r\n|\r|\n/);
  while (lines.length && lines.at(-1) === '') lines.pop();
  return lines;
}

function download(name, bytes) {
  downloadBlob(name, new Blob([bytes], { type: 'application/octet-stream' }));
}

function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function latin1(string) {
  const out = new Uint8Array(string.length);
  for (let i = 0; i < string.length; i++) out[i] = string.charCodeAt(i) & 0xff;
  return out;
}

function formatSize(bytes) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} kB`;
}

loadHistory();
refresh();
