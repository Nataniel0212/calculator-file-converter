/**
 * Choosing files to read and a folder to write to.
 *
 * Both pickers are opened through the File System Access API where it exists,
 * for one reason above all: it takes an `id`, and the browser remembers a
 * separate starting directory per id. A plain `<input type="file">` has no such
 * control — it lands wherever the operating system last put *any* dialog, so
 * picking an output folder would drag the next "add files" dialog along with
 * it. With two ids the input and output dialogs keep their own places.
 *
 * Where the API is missing (Firefox) the caller falls back to a hidden file
 * input and an ordinary download.
 */

const DB = 'calcconv';
const STORE = 'destinations';
const LIMIT = 5;

/** Ids the browser keys its remembered directories on. Keep them distinct. */
const INPUT_ID = 'calcconv-input';
const OUTPUT_ID = 'calcconv-output';

const hasApi = (name) => typeof window !== 'undefined' && typeof window[name] === 'function';

/** Can we write into a folder the user picks? */
export const supported = hasApi('showDirectoryPicker');

/** Can we open files through a picker that remembers its own directory? */
export const canPickFiles = hasApi('showOpenFilePicker');

/**
 * Ask for files to convert.
 *
 * @returns {Promise<File[] | null>} the chosen files, an empty array if the
 *   dialog was dismissed, or null if this browser has no such picker.
 */
export async function pickFiles() {
  if (!canPickFiles) return null;
  try {
    const handles = await window.showOpenFilePicker({
      id: INPUT_ID, // its own remembered directory, separate from the output one
      multiple: true,
      types: [
        {
          description: 'Calculator documents and text files',
          accept: { 'application/octet-stream': ['.g1e'], 'text/plain': ['.txt'] },
        },
      ],
    });
    return await Promise.all(handles.map((handle) => handle.getFile()));
  } catch (error) {
    if (dismissed(error)) return [];
    throw error;
  }
}

/**
 * Closing a file dialog without choosing anything throws, and it is the one
 * failure that is not a failure. Everything else is passed on.
 */
function dismissed(error) {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * Ask for a whole folder of files to convert.
 *
 * @param {(name: string) => boolean} accepts which file names to take
 * @returns {Promise<{name: string, files: File[]} | null>} null if dismissed
 */
export async function pickInputDirectory(accepts) {
  try {
    const handle = await window.showDirectoryPicker({ id: INPUT_ID, mode: 'read' });
    const files = [];
    for await (const entry of handle.values()) {
      if (entry.kind === 'file' && accepts(entry.name)) files.push(await entry.getFile());
    }
    return { name: handle.name, files };
  } catch (error) {
    if (dismissed(error)) return null;
    throw error;
  }
}

/** Ask for a folder to write into. Returns null if the dialog was dismissed. */
export async function pickDirectory() {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: OUTPUT_ID });
    await remember(handle);
    return handle;
  } catch (error) {
    if (dismissed(error)) return null;
    throw error;
  }
}

/** Confirm we may still write to a folder chosen earlier. */
export async function ensureWritable(handle) {
  const options = { mode: 'readwrite' };
  if ((await handle.queryPermission(options)) === 'granted') return true;
  return (await handle.requestPermission(options)) === 'granted';
}

/**
 * Write files into a folder.
 *
 * @param {FileSystemDirectoryHandle} directory
 * @param {Array<{name: string, bytes: Uint8Array<ArrayBuffer>}>} files
 * @param {(done: number, total: number) => void} [onProgress]
 */
export async function writeFiles(directory, files, onProgress) {
  let done = 0;
  for (const file of files) {
    const handle = await directory.getFileHandle(file.name, { create: true });
    const stream = await handle.createWritable();
    await stream.write(file.bytes);
    await stream.close();
    onProgress?.(++done, files.length);
  }
}

/** Folders used before, newest first. */
export async function recentDirectories() {
  if (!supported) return [];
  try {
    const store = await open('readonly');
    const rows = await request(store.getAll());
    return rows.sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

async function remember(handle) {
  try {
    const store = await open('readwrite');
    const rows = await request(store.getAll());
    const existing = [];
    for (const row of rows) {
      if (await row.handle.isSameEntry?.(handle)) existing.push(row.id);
    }
    for (const id of existing) store.delete(id);

    store.put({ id: crypto.randomUUID(), name: handle.name, handle, at: Date.now() });

    const keep = rows.filter((row) => !existing.includes(row.id)).sort((a, b) => b.at - a.at);
    for (const row of keep.slice(LIMIT - 1)) store.delete(row.id);
  } catch {
    // remembering is a convenience; never let it break a conversion
  }
}

function open(mode) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => {
      const db = request.result;
      resolve(db.transaction(STORE, mode).objectStore(STORE));
    };
    request.onerror = () => reject(request.error);
  });
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
