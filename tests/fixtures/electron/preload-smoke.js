'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.resolve(__dirname, '../../../src/preload.js'),
    },
  });
  ipcMain.handle('get-recording-state', () => ({ state: 'recording', sessionId: 'fixture' }));
  await win.loadURL('data:text/html,<html><body>Preload smoke</body></html>');
  const state = await win.webContents.executeJavaScript('window.electronAPI.getRecordingState()');
  await win.webContents.executeJavaScript(`
    window.receivedRecordingEvents = [];
    window.stopRecordingEvents = window.electronAPI.onRecordingProgress((event) => {
      window.receivedRecordingEvents.push(event);
    });
    void 0;
  `);
  win.webContents.send('recording-progress', { phase: 'audio_encoding' });
  const first = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('IPC progress event timed out')), 5000);
    const poll = setInterval(() => {
      if (window.receivedRecordingEvents.length) {
        clearTimeout(timeout); clearInterval(poll); resolve(window.receivedRecordingEvents.slice());
      }
    }, 10);
  })`);
  await win.webContents.executeJavaScript('window.stopRecordingEvents()');
  win.webContents.send('recording-progress', { phase: 'unexpected' });
  const count = await win.webContents.executeJavaScript('new Promise(resolve => setTimeout(() => resolve(window.receivedRecordingEvents.length), 100))');
  process.stdout.write(`PRELOAD_SMOKE ${JSON.stringify({ state, first, count })}\n`);
  app.quit();
}).catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});
