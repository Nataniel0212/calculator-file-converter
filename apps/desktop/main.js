/**
 * Desktop shell — the same web app, in a window, working offline.
 *
 * There is deliberately no preload script and no IPC: the app never needs
 * privileged access, because all conversion happens in ordinary browser APIs.
 */

import { app, BrowserWindow, shell } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function createWindow() {
  const window = new BrowserWindow({
    width: 1040,
    height: 820,
    minWidth: 560,
    minHeight: 480,
    backgroundColor: '#101211',
    title: 'File Converter',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  window.loadFile(join(here, '../web/index.html'));

  // external links open in the real browser, never inside the app window
  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
