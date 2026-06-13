import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { detectDotaInstall, installGsi } from './dota-setup.js';
import {
  createInitialGsiState,
  detectPostGameMatch,
  parseGsiPayload,
  refreshGsiConnection
} from './gsi-handler.js';
import { PartyTracker } from './party-tracker.js';
import { StatsStore } from './stats-store.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const rootDir = normalize(join(__dirname, '..'));
const publicDir = join(rootDir, 'public');
const bootstrapIconsDir = resolveBootstrapIconsDir();
const dataDir = resolveDataDir();
const configPath = join(dataDir, 'config.json');
const statsPath = join(dataDir, 'stats.json');
const appPackage = JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf8'));

export const port = Number(process.env.PORT || 38456);

const defaultConfig = {
  dota: {
    installPath: '',
    cfgDir: '',
    detectionSource: ''
  }
};

const runtime = {
  config: structuredClone(defaultConfig),
  gsi: createInitialGsiState(),
  lastScoredMatchId: null,
  clients: new Set(),
  startedAt: new Date().toISOString()
};

const statsStore = new StatsStore(statsPath);
const partyTracker = new PartyTracker({
  statsStore,
  onChange: () => broadcast()
});

let serverInstance = null;
let connectionTimer = null;
let reusedExternalServer = false;
let lastBroadcastKey = '';

export let activePort = port;

function resolveBootstrapIconsDir() {
  const packed = join(rootDir, 'node_modules', 'bootstrap-icons', 'font');
  if (rootDir.includes('app.asar')) {
    return join(rootDir.replace(/app\.asar([\\/]|$)/, 'app.asar.unpacked$1'), 'node_modules', 'bootstrap-icons', 'font');
  }
  return packed;
}

function resolveDataDir() {
  if (process.env.DOTA2_PARTY_MANAGER_DATA_DIR) {
    return normalize(process.env.DOTA2_PARTY_MANAGER_DATA_DIR);
  }
  if (process.env.DOTA2_PARTY_STATS_DATA_DIR) {
    return normalize(process.env.DOTA2_PARTY_STATS_DATA_DIR);
  }
  return join(rootDir, 'data');
}

async function loadConfig() {
  try {
    const raw = await readFile(configPath, 'utf8');
    runtime.config = normalizeConfig(JSON.parse(raw));
  } catch {
    runtime.config = structuredClone(defaultConfig);
    await persistConfig();
  }
}

function normalizeConfig(config) {
  const next = config && typeof config === 'object' ? config : {};
  next.dota = next.dota && typeof next.dota === 'object' ? next.dota : {};
  next.dota.installPath = String(next.dota.installPath || '');
  next.dota.cfgDir = String(next.dota.cfgDir || '');
  next.dota.detectionSource = String(next.dota.detectionSource || '');
  return next;
}

async function persistConfig() {
  await mkdir(dataDir, { recursive: true });
  await writeFile(configPath, JSON.stringify(runtime.config, null, 2), 'utf8');
}

function publicState() {
  runtime.gsi = refreshGsiConnection(runtime.gsi);
  return {
    startedAt: runtime.startedAt,
    version: appPackage.version || '1.0.0',
    config: runtime.config,
    gsi: runtime.gsi,
    tracker: partyTracker.snapshot(),
    stats: statsStore.snapshot()
  };
}

function broadcastStateKey(state) {
  return JSON.stringify({
    config: state.config,
    gsi: {
      connected: state.gsi.connected,
      gameState: state.gsi.gameState,
      matchId: state.gsi.matchId,
      activeMatchId: state.gsi.activeMatchId,
      localAccountId: state.gsi.localAccountId,
      localDisplayName: state.gsi.localDisplayName
    },
    tracker: state.tracker,
    stats: state.stats
  });
}

function broadcast() {
  const state = publicState();
  const key = broadcastStateKey(state);
  if (key === lastBroadcastKey) return;
  lastBroadcastKey = key;

  const payload = `data: ${JSON.stringify(state)}\n\n`;
  for (const client of runtime.clients) {
    client.write(payload);
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON body');
  }
}

function sendJson(res, payload, status = 200) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

function sendText(res, text, status = 200, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(text);
}

async function serveBootstrapIcons(pathname, res) {
  if (!pathname.startsWith('/bootstrap-icons/')) return false;

  const relativePath = pathname.slice('/bootstrap-icons/'.length);
  const filePath = normalize(join(bootstrapIconsDir, relativePath));
  if (!filePath.startsWith(bootstrapIconsDir)) {
    sendText(res, 'Forbidden', 403);
    return true;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      sendText(res, 'Not found', 404);
      return true;
    }
  } catch {
    sendText(res, 'Not found', 404);
    return true;
  }

  const types = {
    '.css': 'text/css; charset=utf-8',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf'
  };
  res.writeHead(200, {
    'content-type': types[extname(filePath)] || 'application/octet-stream',
    'cache-control': 'no-store'
  });
  createReadStream(filePath).pipe(res);
  return true;
}

async function serveStatic(pathname, res) {
  const path = pathname === '/' ? '/index.html' : pathname;
  const filePath = normalize(join(publicDir, path));
  if (!filePath.startsWith(publicDir)) return sendText(res, 'Forbidden', 403);

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) return sendText(res, 'Not found', 404);
  } catch {
    return sendText(res, 'Not found', 404);
  }

  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8'
  };
  res.writeHead(200, {
    'content-type': types[extname(filePath)] || 'application/octet-stream',
    'cache-control': 'no-store'
  });
  createReadStream(filePath).pipe(res);
}

function handleEvents(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  });
  res.write(`data: ${JSON.stringify(publicState())}\n\n`);
  runtime.clients.add(res);
  req.on('close', () => runtime.clients.delete(res));
}

async function handleGsi(req, res) {
  const payload = await readBody(req);
  const previous = { ...runtime.gsi, lastScoredMatchId: runtime.lastScoredMatchId };
  runtime.gsi = parseGsiPayload(previous, payload);

  const scored = detectPostGameMatch(previous, runtime.gsi);
  if (scored?.localAccountId) {
    runtime.lastScoredMatchId = scored.matchId;
    partyTracker.enqueueMatch(scored);
  }

  broadcast();
  sendJson(res, { ok: true });
}

async function detectDotaApi(res) {
  const detected = await detectDotaInstall();
  if (!detected) {
    return sendJson(res, {
      ok: false,
      error: 'Dota 2 не найдена автоматически. Укажите папку вручную.'
    }, 404);
  }

  runtime.config.dota.installPath = detected.dotaPath;
  runtime.config.dota.cfgDir = detected.cfgDir;
  runtime.config.dota.detectionSource = detected.source;
  await persistConfig();
  broadcast();
  sendJson(res, { ok: true, ...detected });
}

async function installGsiApi(req, res) {
  const body = await readBody(req);
  const requestedPath = String(
    body.dotaPath
    || body.cfgDir
    || runtime.config.dota?.installPath
    || runtime.config.dota?.cfgDir
    || ''
  ).trim();

  try {
    const result = await installGsi({ dotaPath: requestedPath, port });
    runtime.config.dota.installPath = result.dotaPath;
    runtime.config.dota.cfgDir = result.cfgDir;
    runtime.config.dota.detectionSource = result.source;
    await persistConfig();
    broadcast();
    sendJson(res, { ok: true, ...result });
  } catch (error) {
    sendJson(res, { ok: false, error: error.message }, 400);
  }
}

async function updateConfigApi(req, res) {
  const body = await readBody(req);
  if (body?.dota) {
    runtime.config.dota.installPath = String(body.dota.installPath || runtime.config.dota.installPath || '').trim();
    runtime.config.dota.cfgDir = String(body.dota.cfgDir || runtime.config.dota.cfgDir || '').trim();
    runtime.config.dota.detectionSource = 'manual';
  }
  await persistConfig();
  broadcast();
  sendJson(res, publicState());
}

async function listPlayersApi(url, res) {
  const query = url.searchParams.get('q') || '';
  sendJson(res, { players: statsStore.listPlayers(query) });
}

async function updatePlayerApi(accountId, req, res) {
  const body = await readBody(req);
  try {
    const player = statsStore.updatePlayer(accountId, body);
    await statsStore.save();
    broadcast();
    sendJson(res, { ok: true, player });
  } catch (error) {
    sendJson(res, { ok: false, error: error.message }, 400);
  }
}

async function deletePlayerApi(accountId, res) {
  try {
    statsStore.deletePlayer(accountId);
    await statsStore.save();
    broadcast();
    sendJson(res, { ok: true });
  } catch (error) {
    sendJson(res, { ok: false, error: error.message }, 400);
  }
}

async function resetStatsApi(req, res) {
  const body = await readBody(req);
  if (body?.confirm !== true) {
    return sendJson(res, { ok: false, error: 'Confirmation required' }, 400);
  }
  statsStore.resetAll();
  partyTracker.clearQueue();
  await statsStore.save();
  broadcast();
  sendJson(res, { ok: true });
}

async function importRecentMatchesApi(req, res) {
  runtime.gsi = refreshGsiConnection(runtime.gsi);
  if (!runtime.gsi.connected || !runtime.gsi.localAccountId) {
    return sendJson(res, { ok: false, error: 'GSI не подключён' }, 400);
  }

  const body = await readBody(req);
  const count = Number(body?.count);
  if (!Number.isFinite(count) || count < 1 || count > 100) {
    return sendJson(res, { ok: false, error: 'Укажите число матчей от 1 до 100' }, 400);
  }

  try {
    const result = await partyTracker.importRecentMatches({
      accountId: runtime.gsi.localAccountId,
      count
    });
    broadcast();
    sendJson(res, { ok: true, ...result });
  } catch (error) {
    sendJson(res, { ok: false, error: error.message }, 400);
  }
}

async function requestHandler(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  const { pathname } = url;

  try {
    if (req.method === 'GET' && pathname === '/api/events') return handleEvents(req, res);
    if (req.method === 'GET' && pathname === '/api/state') return sendJson(res, publicState());
    if (req.method === 'GET' && pathname === '/api/config') return sendJson(res, runtime.config);
    if (req.method === 'POST' && pathname === '/api/config') return updateConfigApi(req, res);
    if (req.method === 'GET' && pathname === '/api/dota/detect') return detectDotaApi(res);
    if (req.method === 'POST' && pathname === '/api/install-gsi') return installGsiApi(req, res);
    if (req.method === 'POST' && pathname === '/gsi/dota2') return handleGsi(req, res);
    if (req.method === 'GET' && pathname === '/api/stats/players') return listPlayersApi(url, res);

    const playerMatch = pathname.match(/^\/api\/stats\/players\/([^/]+)$/);
    if (playerMatch) {
      const accountId = decodeURIComponent(playerMatch[1]);
      if (req.method === 'PATCH') return updatePlayerApi(accountId, req, res);
      if (req.method === 'DELETE') return deletePlayerApi(accountId, res);
    }

    if (req.method === 'POST' && pathname === '/api/stats/reset') return resetStatsApi(req, res);
    if (req.method === 'POST' && pathname === '/api/queue/import-recent') return importRecentMatchesApi(req, res);

    if (req.method === 'GET' && await serveBootstrapIcons(pathname, res)) return;
    if (req.method === 'GET') return serveStatic(pathname, res);
    return sendText(res, 'Not found', 404);
  } catch (error) {
    sendJson(res, { ok: false, error: error.message }, 500);
  }
}

export async function startServer(options = {}) {
  await mkdir(dataDir, { recursive: true });
  await loadConfig();
  await statsStore.load();
  partyTracker.restoreFromStore();

  const host = options.host ?? '127.0.0.1';
  const portToUse = Number(options.port ?? port);

  if (serverInstance) {
    activePort = portToUse;
    return serverInstance;
  }

  if (await probeExistingServer(host, portToUse)) {
    reusedExternalServer = true;
    activePort = portToUse;
    return null;
  }

  reusedExternalServer = false;
  serverInstance = createServer((req, res) => {
    requestHandler(req, res).catch((error) => sendJson(res, { ok: false, error: error.message }, 500));
  });

  try {
    await new Promise((resolve, reject) => {
      serverInstance.once('error', reject);
      serverInstance.listen(portToUse, host, resolve);
    });
  } catch (error) {
    serverInstance = null;
    if (error?.code === 'EADDRINUSE' && await probeExistingServer(host, portToUse)) {
      reusedExternalServer = true;
      activePort = portToUse;
      return null;
    }
    if (error?.code === 'EADDRINUSE') {
      throw new Error(
        `Порт ${portToUse} уже занят другим приложением. Закройте другой экземпляр или выполните: `
        + `Stop-Process -Id (Get-NetTCPConnection -LocalPort ${portToUse}).OwningProcess -Force`
      );
    }
    throw error;
  }

  activePort = portToUse;

  connectionTimer = setInterval(() => {
    const before = runtime.gsi.connected;
    runtime.gsi = refreshGsiConnection(runtime.gsi);
    if (before !== runtime.gsi.connected) broadcast();
  }, 5000);

  return serverInstance;
}

async function probeExistingServer(host, portToUse) {
  try {
    const response = await fetch(`http://${host}:${portToUse}/api/state`, {
      signal: AbortSignal.timeout(2000)
    });
    if (!response.ok) return false;
    const state = await response.json();
    return Boolean(state?.stats && state?.gsi && state?.tracker && state?.config?.dota !== undefined);
  } catch {
    return false;
  }
}

export async function stopServer() {
  if (reusedExternalServer) {
    reusedExternalServer = false;
    return;
  }
  if (connectionTimer) {
    clearInterval(connectionTimer);
    connectionTimer = null;
  }
  for (const client of runtime.clients) {
    client.end();
  }
  runtime.clients.clear();
  if (!serverInstance) return;
  await new Promise((resolve) => serverInstance.close(resolve));
  serverInstance = null;
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isDirectRun) {
  startServer().then(() => {
    console.log(`Dota2 Party Manager listening on http://127.0.0.1:${port}`);
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
