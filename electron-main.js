import electron from 'electron';
import { dirname, join } from 'node:path';

if (!process.versions.electron) {
  console.error(
    'Этот файл нужно запускать через Electron, а не через Node.js.\n'
    + 'Используйте:\n'
    + '  npm start\n'
    + '  npm run start:dev\n'
    + 'Или только сервер без окна:\n'
    + '  npm run dev:server'
  );
  process.exit(1);
}

const { app, BrowserWindow } = electron;

let mainWindow = null;
let serverModule = null;
const devToolsEnabled = process.env.ELECTRON_DEV === '1';

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

function configureRuntimePaths() {
  if (!app.isPackaged) return;
  process.env.DOTA2_PARTY_MANAGER_DATA_DIR = join(dirname(process.execPath), 'data');
}

async function getServerModule() {
  if (!serverModule) {
    configureRuntimePaths();
    serverModule = await import('./src/server.js');
  }
  return serverModule;
}

async function createWindow() {
  const { startServer, activePort, port } = await getServerModule();
  await startServer({ host: '127.0.0.1', port });

  mainWindow = new BrowserWindow({
    width: 1250,
    height: 638,
    minWidth: 1250,
    minHeight: 638,
    title: 'Dota2 Party Manager',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      devTools: devToolsEnabled
    }
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (!devToolsEnabled) return;
    if (input.type === 'keyDown' && input.key === 'F12') {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  await mainWindow.loadURL(`http://127.0.0.1:${activePort}/`);

  if (devToolsEnabled) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

if (gotSingleInstanceLock) {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(createWindow).catch((error) => {
    console.error(error);
    app.quit();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', async () => {
    if (serverModule) {
      await serverModule.stopServer();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow().catch(console.error);
    }
  });
}
