import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, normalize } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const GSI_CFG_FILENAME = 'gamestate_integration_dota2partymanager.cfg';

export function makeGsiConfig(port) {
  return `"Dota2PartyManager"
{
  "uri" "http://127.0.0.1:${port}/gsi/dota2"
  "timeout" "5.0"
  "buffer" "0.1"
  "throttle" "0.1"
  "heartbeat" "30.0"
  "data"
  {
    "provider" "1"
    "map" "1"
    "player" "1"
    "hero" "1"
    "items" "1"
    "allplayers" "1"
    "draft" "1"
    "events" "1"
  }
}
`;
}

export async function detectDotaInstall() {
  const libraryRoots = await findSteamLibraryRoots();
  const checked = new Set();

  for (const libraryRoot of libraryRoots) {
    const normalizedRoot = normalize(libraryRoot);
    if (checked.has(normalizedRoot.toLowerCase())) continue;
    checked.add(normalizedRoot.toLowerCase());

    const target = await resolveDotaGsiTarget(join(normalizedRoot, 'steamapps', 'common', 'dota 2 beta'), `Steam library: ${normalizedRoot}`);
    if (target) return target;
  }

  const commonDotaPaths = [
    'C:\\SteamLibrary\\steamapps\\common\\dota 2 beta',
    'D:\\SteamLibrary\\steamapps\\common\\dota 2 beta',
    'C:\\Program Files (x86)\\Steam\\steamapps\\common\\dota 2 beta',
    'C:\\Program Files\\Steam\\steamapps\\common\\dota 2 beta'
  ];

  for (const path of commonDotaPaths) {
    const target = await resolveDotaGsiTarget(path, 'common path');
    if (target) return target;
  }

  return null;
}

export async function installGsi({ dotaPath, cfgDir, port }) {
  let target = null;
  const requestedPath = String(dotaPath || cfgDir || '').trim();
  if (requestedPath) {
    target = await resolveDotaGsiTarget(requestedPath, 'manual');
  }
  if (!target) {
    target = await detectDotaInstall();
  }
  if (!target) {
    throw new Error('Dota 2 не найдена. Укажите папку вручную, например: C:\\SteamLibrary\\steamapps\\common\\dota 2 beta');
  }

  const resolvedCfgDir = target.cfgDir;
  await mkdir(resolvedCfgDir, { recursive: true });
  const cfgPath = join(resolvedCfgDir, GSI_CFG_FILENAME);
  await writeFile(cfgPath, makeGsiConfig(port), 'utf8');

  return {
    cfgPath,
    dotaPath: target.dotaPath,
    cfgDir: resolvedCfgDir,
    source: target.source
  };
}

async function findSteamLibraryRoots() {
  const roots = new Set();
  const steamPaths = await findSteamInstallPaths();

  for (const steamPath of steamPaths) {
    roots.add(normalize(steamPath));
    const vdfPath = join(steamPath, 'steamapps', 'libraryfolders.vdf');
    try {
      const vdf = await readFile(vdfPath, 'utf8');
      for (const path of parseSteamLibraryFolders(vdf)) {
        roots.add(normalize(path));
      }
    } catch {}
  }

  for (const fallback of ['C:\\SteamLibrary', 'D:\\SteamLibrary', 'C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam']) {
    roots.add(normalize(fallback));
  }

  return Array.from(roots);
}

async function findSteamInstallPaths() {
  const paths = new Set();
  const registryQueries = [
    ['HKCU\\Software\\Valve\\Steam', ['SteamPath', 'SteamExe']],
    ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', ['InstallPath']],
    ['HKLM\\SOFTWARE\\Valve\\Steam', ['InstallPath']]
  ];

  for (const [key, names] of registryQueries) {
    for (const name of names) {
      const value = await readRegistryValue(key, name);
      if (!value) continue;
      paths.add(normalize(name === 'SteamExe' ? dirname(value) : value));
    }
  }

  paths.add(normalize('C:\\Program Files (x86)\\Steam'));
  paths.add(normalize('C:\\Program Files\\Steam'));
  return Array.from(paths);
}

async function readRegistryValue(key, name) {
  try {
    const { stdout } = await execFileAsync('reg', ['query', key, '/v', name], { windowsHide: true });
    const line = stdout.split(/\r?\n/).find((item) => item.includes(name) && item.includes('REG_'));
    return line?.match(/\s+REG_\w+\s+(.+?)\s*$/)?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

function parseSteamLibraryFolders(vdf) {
  const paths = [];
  for (const match of vdf.matchAll(/"path"\s+"([^"]+)"/g)) {
    paths.push(match[1].replace(/\\\\/g, '\\'));
  }
  return paths;
}

export async function resolveDotaGsiTarget(inputPath, source = 'manual') {
  if (!inputPath) return null;
  const input = normalize(inputPath.replace(/^"+|"+$/g, ''));
  const candidates = candidateDotaPaths(input);

  for (const candidate of candidates) {
    const dotaPath = candidate.dotaPath;
    const cfgDir = candidate.cfgDir;
    if (await looksLikeDotaInstall(dotaPath)) {
      return { dotaPath, cfgDir, source };
    }
  }

  const directCfgDir = normalize(input);
  if (basename(directCfgDir).toLowerCase() === 'gamestate_integration') {
    const dotaPath = normalize(join(directCfgDir, '..', '..', '..', '..'));
    return { dotaPath, cfgDir: directCfgDir, source };
  }

  return null;
}

function candidateDotaPaths(input) {
  return [
    {
      dotaPath: input,
      cfgDir: join(input, 'game', 'dota', 'cfg', 'gamestate_integration')
    },
    {
      dotaPath: normalize(join(input, '..', '..')),
      cfgDir: join(input, 'cfg', 'gamestate_integration')
    },
    {
      dotaPath: normalize(join(input, '..', '..', '..', '..')),
      cfgDir: input
    }
  ];
}

async function looksLikeDotaInstall(dotaPath) {
  if (!dotaPath) return false;
  return await pathExists(join(dotaPath, 'game', 'dota'))
    || await pathExists(join(dotaPath, 'game', 'bin'))
    || await pathExists(join(dotaPath, 'game', 'dota', 'pak01_dir.vpk'));
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
