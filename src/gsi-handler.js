import { normalizeAccountId, normalizePlayerTeam, normalizeTeam } from './account-id.js';

const GSI_CONNECTED_TIMEOUT_MS = 60 * 1000;

export function createInitialGsiState() {
  return {
    connected: false,
    lastSeenAt: null,
    gameState: null,
    matchId: null,
    activeMatchId: null,
    playerTeam: null,
    winTeam: null,
    localAccountId: null,
    localDisplayName: null
  };
}

export function parseGsiPayload(previous, payload) {
  const map = payload?.map || {};
  const player = payload?.player || {};
  const gameState = map.game_state || null;
  const matchId = map.matchid || map.match_id || null;
  const activeMatchId = inferActiveMatchId(previous, gameState, matchId);
  const localAccountId = normalizeAccountId(
    player.accountid
    ?? player.account_id
    ?? player.accountId
    ?? player.steamid
    ?? player.steam_id
  );
  const localDisplayName = String(player.name || player.player_name || '').slice(0, 64);
  const playerTeam = inferLocalPlayerTeam(player, previous);
  const winTeam = normalizeTeam(map.win_team);

  return {
    connected: true,
    lastSeenAt: new Date().toISOString(),
    gameState,
    matchId: matchId ? String(matchId) : null,
    activeMatchId: activeMatchId ? String(activeMatchId) : null,
    playerTeam,
    winTeam,
    localAccountId: localAccountId ? String(localAccountId) : previous.localAccountId,
    localDisplayName: localDisplayName || previous.localDisplayName
  };
}

export function refreshGsiConnection(gsi, now = Date.now()) {
  if (!gsi?.lastSeenAt) {
    return { ...gsi, connected: false };
  }
  const lastSeen = Date.parse(gsi.lastSeenAt);
  if (!Number.isFinite(lastSeen) || now - lastSeen > GSI_CONNECTED_TIMEOUT_MS) {
    return { ...gsi, connected: false };
  }
  return gsi;
}

export function detectPostGameMatch(previous, gsi) {
  if (!gsi?.matchId && !gsi?.activeMatchId) return null;
  if (!/POST_GAME/i.test(String(gsi.gameState || ''))) return null;
  if (!gsi.winTeam || !gsi.playerTeam) return null;

  const matchId = gsi.activeMatchId || gsi.matchId;
  if (!matchId) return null;
  if (String(previous?.lastScoredMatchId || '') === String(matchId)) return null;

  const result = gsi.winTeam === gsi.playerTeam ? 'win' : 'lose';
  return {
    matchId: String(matchId),
    localAccountId: gsi.localAccountId,
    result
  };
}

function inferActiveMatchId(previous, gameState, matchId) {
  const nextMatchId = matchId ? String(matchId) : null;
  const state = String(gameState || '');

  if (/DISCONNECT/i.test(state)) {
    return previous?.activeMatchId || nextMatchId;
  }

  if (nextMatchId) return nextMatchId;
  return previous?.activeMatchId || null;
}

function inferLocalPlayerTeam(player, previous) {
  const direct = normalizePlayerTeam(player);
  if (direct) return direct;
  return previous?.playerTeam || null;
}
