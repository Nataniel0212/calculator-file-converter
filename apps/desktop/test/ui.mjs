/**
 * End-to-end interface test.
 *
 * Loads the real page in a real browser engine, drives it through the actual
 * file input and the actual buttons, and checks what the interface reports —
 * plus what actually landed on disk. Run it with:
 *
 *   npm run test:ui          (from apps/desktop)
 *
 * Covers the save-queue rule that is easy to get wrong: pressing the button
 * must write the files that have not been saved yet, and nothing else.
 */
import { app, BrowserWindow } from 'electron';
import { readdirSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const PAGE = join(here, '../../web/index.html');
const DOWNLOADS = join(tmpdir(), 'calcconv-ui-test');

const failures = [];
function check(what, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}`);
  if (!ok) failures.push(`${what}\n         expected ${JSON.stringify(expected)}\n         actual   ${JSON.stringify(actual)}`);
}

rmSync(DOWNLOADS, { recursive: true, force: true });
mkdirSync(DOWNLOADS, { recursive: true });

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 800 });
  win.webContents.session.on('will-download', (_event, item) => {
    item.setSavePath(join(DOWNLOADS, item.getFilename()));
  });

  const consoleErrors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) consoleErrors.push(message);
  });

  await win.loadFile(PAGE);

  const r = await win.webContents.executeJavaScript(`
    (async () => {
      const wait = ms => new Promise(res => setTimeout(res, ms));
      const add = (name, bytes) => {
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], name));
        const picker = document.getElementById('filepicker');
        picker.files = dt.files;
        picker.dispatchEvent(new Event('change'));
      };
      const text = s => new TextEncoder().encode(s);
      const state = () => ({
        status: document.getElementById('status-text').textContent,
        ticks: document.querySelectorAll('.tick').length,
      });
      const save = async () => { document.getElementById('start').click(); await wait(600); };

      const out = {};

      // The file dialog must ask for its own remembered directory, otherwise
      // picking an output folder moves where it opens. Stub it — a real native
      // dialog would block the test.
      const asked = [];
      window.showOpenFilePicker = async (options) => {
        asked.push(options);
        return [{ getFile: async () => new File([text('PICKED\\r\\n')], 'picked.txt') }];
      };
      document.getElementById('add-files').click();
      await wait(300);
      out.pickerOptions = { id: asked[0]?.id, multiple: asked[0]?.multiple };
      out.pickedFileLanded = [...document.querySelectorAll('.col-name .name')].map(n => n.textContent);
      out.sourceAfterPick = document.getElementById('source-path').textContent;
      document.getElementById('clear').click();
      await wait(100);
      out.sourceAfterClear = document.getElementById('source-path').textContent;

      add('one.txt', text('ALPHA\\r\\nBETA\\r\\n'));
      await wait(250);
      out.oneAdded = state();
      await save();
      out.oneSaved = state();

      add('two.txt', text('GAMMA\\r\\n'));
      await wait(250);
      out.twoAdded = state();
      await save();
      out.twoSaved = state();

      await wait(1800);
      out.buttonWhenIdle = document.getElementById('start').textContent;

      document.querySelector('#queue-body tr.clickable').click();
      await wait(200);
      const box = document.getElementById('text-input');
      box.value += '\\nDELTA';
      box.dispatchEvent(new Event('input'));
      await wait(300);
      out.afterEdit = state();

      // A text file that says which calculator it came from goes back to that
      // one, whatever the Conversion box happens to be set to.
      document.getElementById('clear').click();
      await wait(100);
      add('prog.txt', text('#format: 8xp\\n#name: GUESSNUM\\n\\nDisp "HEJ"\\n'));
      await wait(250);
      out.tiOutName = document.querySelector('.col-out .name').textContent;
      await save();

      // ...and one with no header follows the Conversion box, which still
      // reads Casio, so it must not be swept into the TI path.
      add('plain.txt', text('HELLO\\n'));
      await wait(250);
      out.outNames = [...document.querySelectorAll('.col-out .name')].map(n => n.textContent);
      await save();

      // Only the controls that can change the outcome are on show.
      const controls = () => ({
        target: !document.getElementById('function-row').hidden,
        translit: !document.getElementById('translit-row').hidden,
      });
      out.controlsForCasio = controls();
      document.getElementById('function').value = '8xp-txt';
      document.getElementById('function').dispatchEvent(new Event('change'));
      await wait(150);
      out.controlsForTi = controls();
      document.querySelector('input[name=direction][value=toPc]').click();
      await wait(150);
      out.controlsToComputer = controls();
      document.querySelector('input[name=direction][value=auto]').click();
      await wait(150);

      // A note that names a line takes you to that line.
      document.getElementById('clear').click();
      await wait(100);
      add('long.txt', text('SHORT\\nTHIS LINE IS FAR TOO WIDE FOR THE SCREEN\\n'));
      await wait(250);
      const link = document.querySelector('.note-link');
      out.noteIsALink = Boolean(link);
      out.noteText = link ? link.textContent : '';
      link.click();
      await wait(250);
      const box2 = document.getElementById('text-input');
      out.selectedLine = box2.value.slice(box2.selectionStart, box2.selectionEnd);

      // The filter appears only once the list is long enough to need it.
      out.filterHiddenWhenShort = document.getElementById('filter').hidden;
      for (let i = 0; i < 8; i++) add('bulk' + i + '.txt', text('X\\n'));
      await wait(400);
      out.filterShownWhenLong = !document.getElementById('filter').hidden;
      const filter = document.getElementById('filter');
      filter.value = 'bulk3';
      filter.dispatchEvent(new Event('input'));
      await wait(400); // the filter coalesces typing before redrawing
      out.filtered = [...document.querySelectorAll('.col-name .name')].map(n => n.textContent);
      out.filterCount = document.getElementById('filter-count').textContent;

      // Each format states its own limits, next to the control that picks it.
      document.getElementById('clear').click();
      await wait(100);
      const limits = () => [...document.querySelectorAll('#format-notes li')].map(li => li.textContent);
      document.getElementById('function').value = 'g1e-txt';
      document.getElementById('function').dispatchEvent(new Event('change'));
      await wait(150);
      out.casioMentionsAccents = limits().some(t => t.includes('Å Ä Ö'));
      out.casioMentions21 = limits().some(t => t.includes('21 characters'));
      document.getElementById('function').value = '8xp-txt';
      document.getElementById('function').dispatchEvent(new Event('change'));
      await wait(150);
      out.tiMentionsTokens = limits().some(t => t.includes('TI-BASIC token'));

      // A column of Swedish decimals becomes a list; a grid becomes a matrix.
      out.dataRowHiddenWithoutCsv = document.getElementById('data-row').hidden;
      add('LANGD.csv', text('langd\\n1,5\\n1,72\\n1,68\\n'));
      await wait(350);
      out.dataRowShownWithCsv = !document.getElementById('data-row').hidden;
      out.dataLimits = [...document.querySelectorAll('#data-notes li')].length;
      out.listOut = document.querySelector('.col-out .name').textContent;
      document.querySelector('#queue-body tr.clickable').click();
      await wait(250);
      out.listValues = document.getElementById('text-input').value.trim().split('\\n');

      add('GRID.csv', text('a;b;c\\n1;2;3\\n4;5;6\\n'));
      await wait(350);
      out.outsWithGrid = [...document.querySelectorAll('.col-out .name')].map(n => n.textContent);
      await save();
      return out;
    })()
  `);

  console.log('\ninterface:');
  check('the file dialog uses its own remembered directory', r.pickerOptions, {
    id: 'calcconv-input',
    multiple: true,
  });
  check('files chosen in that dialog reach the list', r.pickedFileLanded, ['picked.txt']);
  check('the "read from" field says where they came from', r.sourceAfterPick, 'Selected files');
  check('clearing the list resets the "read from" field', r.sourceAfterClear, 'Nothing added yet');
  check('a new file is ready and unticked', r.oneAdded, { status: '1 ready', ticks: 0 });
  check('saving confirms and ticks the row', r.oneSaved, {
    status: '✓ Saved ONE.G1E to your downloads',
    ticks: 1,
  });
  check('adding a file keeps the saved one saved', r.twoAdded, {
    status: '1 ready · 1 already saved',
    ticks: 1,
  });
  check('the second save writes only the new file', r.twoSaved, {
    status: '✓ Saved TWO.G1E to your downloads',
    ticks: 2,
  });
  check('with nothing pending the button offers a full rewrite', r.buttonWhenIdle, 'Download all again');
  check('editing a saved file makes it pending again', r.afterEdit, {
    status: '1 ready · 1 already saved',
    ticks: 1,
  });

  check('a text file naming its calculator becomes that calculator\'s file', r.tiOutName, 'GUESSNUM.8xp');
  check('a text file with no header follows the Conversion box', r.outNames, [
    'GUESSNUM.8xp',
    'PLAIN.G1E',
  ]);

  check('converting to Casio shows the target and the substitution rule', r.controlsForCasio, {
    target: true,
    translit: true,
  });
  check('converting to TI drops the Casio-only substitution rule', r.controlsForTi, {
    target: true,
    translit: false,
  });
  check('reading off a calculator drops both', r.controlsToComputer, {
    target: false,
    translit: false,
  });

  check('a note naming a line is a link', r.noteIsALink, true);
  check('the note says which line', /from line 2/.test(r.noteText), true);
  check('following it selects that line', r.selectedLine, 'THIS LINE IS FAR TOO WIDE FOR THE SCREEN');

  check('the filter stays out of the way on a short list', r.filterHiddenWhenShort, true);
  check('the filter appears once the list is long', r.filterShownWhenLong, true);
  check('the filter narrows the list', r.filtered, ['bulk3.txt']);
  check('the filter says how much it is hiding', r.filterCount, '1 of 9');

  check('the Casio warns about accents before you hit them', r.casioMentionsAccents, true);
  check('the Casio states its line width', r.casioMentions21, true);
  check('the TI states that everything must be a token', r.tiMentionsTokens, true);

  check('the numbers control stays hidden until there are numbers', r.dataRowHiddenWithoutCsv, true);
  check('adding a .csv brings the numbers control out', r.dataRowShownWithCsv, true);
  check('the numbers control states its limits too', r.dataLimits > 0, true);
  check('one column of Swedish decimals becomes a list', r.listOut, 'LANGD.8xl');
  check('and the decimals survive as decimals', r.listValues, ['1.5', '1.72', '1.68']);
  check('a grid becomes a matrix', r.outsWithGrid, ['LANGD.8xl', 'GRID.8xm']);

  console.log('\ndisk:');
  const written = readdirSync(DOWNLOADS).sort();
  check('exactly the files asked for were written, no bundle', written, [
    'GUESSNUM.8xp',
    'ONE.G1E',
    'PLAIN.G1E',
    'TWO.G1E',
    'converted.zip',
  ]);
  check('no console errors', consoleErrors, []);

  console.log(failures.length ? `\n${failures.length} failed:\n  ${failures.join('\n  ')}` : '\nall checks passed');
  app.exit(failures.length ? 1 : 0);
});
