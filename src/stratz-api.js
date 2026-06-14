import { postJson } from './proxy-fetch.js';

export const STRATZ_GRAPHQL_URL = 'https://api.stratz.com/graphql';
const USER_AGENT = 'Dota2PartyManager/1.3';
// STRATZ request filters use numeric Byte IDs (Valve lobby/game mode), not enum names.
const LOBBY_TYPE_RANKED = 7;
const RANKED_GAME_MODE_IDS = [22, 1, 2];
const SCHEMA_RETRY_PATTERN = /Cannot query field|Unknown argument|Unknown type|Field .* argument|Variable .* of type|Expected type|invalid value|is required for field|required but not provided/i;

export function normalizeStratzConfig(stratz) {
  const source = stratz && typeof stratz === 'object' ? stratz : {};
  return {
    apiToken: String(source.apiToken || source.token || '').trim()
  };
}

function sanitizeErrorBody(body) {
  const compact = String(body || '').replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  if (/cloudflare|just a moment|enable javascript and cookies/i.test(compact)) {
    return 'STRATZ заблокировал запрос (Cloudflare). Проверьте API token и прокси.';
  }
  return compact.slice(0, 240);
}

function isRankedGameMode(gameMode) {
  if (gameMode == null) return false;
  const raw = String(gameMode).trim().toUpperCase();
  if (['RANKED', 'ALL_PICK_RANKED', 'MATCHMAKING_RANKED', 'RANKED_MATCHMAKING'].includes(raw)) {
    return true;
  }
  const numeric = Number(gameMode);
  return [1, 2, 7, 22, 23].includes(numeric);
}

function isRankedLobby(lobbyType) {
  if (lobbyType == null) return null;
  const raw = String(lobbyType).trim().toUpperCase();
  if (['RANKED', 'SOLO_QUEUE'].includes(raw)) return true;
  if (['UNRANKED', 'PRACTICE', 'TUTORIAL', 'COOP_VS_BOTS', 'TURBO'].includes(raw)) return false;
  const numeric = Number(lobbyType);
  if (numeric === 7) return true;
  if ([0, 1, 2, 3, 4, 5, 8, 9].includes(numeric)) return false;
  return null;
}

function isRankedMatch(match) {
  const lobbyRanked = isRankedLobby(match?.lobbyType ?? match?.lobby_type);
  if (lobbyRanked === true) return true;
  if (lobbyRanked === false) return false;
  return isRankedGameMode(match?.gameMode ?? match?.game_mode);
}

function parseTimestamp(value) {
  if (Number.isFinite(Number(value))) {
    const numeric = Number(value);
    return numeric > 1_000_000_000_000 ? Math.floor(numeric / 1000) : Math.floor(numeric);
  }
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  }
  return null;
}

function resolveRadiantWin(match) {
  if (typeof match?.didRadiantWin === 'boolean') return match.didRadiantWin;
  if (typeof match?.radiantWin === 'boolean') return match.radiantWin;
  const winner = String(match?.winner || '').toUpperCase();
  if (winner.includes('RADIANT')) return true;
  if (winner.includes('DIRE')) return false;
  return null;
}

function normalizePlayer(player, forcedRadiant = null) {
  const accountId = Number(
    player?.steamAccountId
    ?? player?.steamAccount?.id
    ?? player?.accountId
  );
  if (!Number.isFinite(accountId) || accountId <= 0) return null;

  const isRadiant = typeof player?.isRadiant === 'boolean'
    ? player.isRadiant
    : forcedRadiant;
  const playerSlot = Number.isFinite(Number(player?.playerSlot))
    ? Number(player.playerSlot)
    : isRadiant === true
      ? 0
      : isRadiant === false
        ? 128
        : null;

  return {
    account_id: accountId,
    party_id: player?.partyId ?? player?.party_id ?? null,
    party_size: player?.partySize ?? player?.party_size ?? null,
    isRadiant,
    player_slot: playerSlot,
    personaname: String(player?.steamAccount?.name || player?.name || '').trim(),
    isVictory: typeof player?.isVictory === 'boolean' ? player.isVictory : null
  };
}

function resolveLobbyType(match) {
  const lobbyRanked = isRankedLobby(match?.lobbyType ?? match?.lobby_type);
  if (lobbyRanked === true) return 7;
  if (lobbyRanked === false) return null;
  return isRankedGameMode(match?.gameMode ?? match?.game_mode) ? 7 : null;
}

function normalizeMatch(match, fallbackId = null) {
  if (!match?.id && !fallbackId) return null;

  const players = [];
  if (Array.isArray(match.players)) {
    for (const player of match.players) {
      const normalized = normalizePlayer(player);
      if (normalized) players.push(normalized);
    }
  }

  const radiantWin = resolveRadiantWin(match);
  const startTime = parseTimestamp(match.startDateTime ?? match.startTime ?? match.start_time);

  return {
    match_id: String(match.id ?? fallbackId),
    gameMode: match.gameMode ?? match.game_mode ?? null,
    lobby_type: resolveLobbyType(match),
    radiant_win: radiantWin,
    start_time: startTime,
    players
  };
}

export class StratzApi {
  constructor({ getConfig, getProxyConfig, activityLog } = {}) {
    this.getConfig = getConfig || (() => ({}));
    this.getProxyConfig = getProxyConfig || (() => null);
    this.activityLog = activityLog || null;
    this.cachedMatchQuery = 0;
    this.cachedHistoryQuery = 0;
  }

  getToken() {
    const token = this.getConfig().apiToken;
    if (!token) {
      throw new Error('Укажите STRATZ API token в настройках (stratz.com/api)');
    }
    return token;
  }

  async graphql(query, variables, label = 'query') {
    const token = this.getToken();
    const response = await postJson(STRATZ_GRAPHQL_URL, {
      proxyConfig: this.getProxyConfig(),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        Authorization: `Bearer ${token}`
      },
      body: { query, variables }
    });

    const raw = await response.text();

    if (!response.ok) {
      const detail = sanitizeErrorBody(raw) || `HTTP ${response.status}`;
      this.activityLog?.add(`STRATZ ${label}: ${detail}`, { category: 'stratz', level: 'error' });
      if (response.status === 429) {
        const error = new Error('STRATZ rate limit');
        error.retryable = true;
        throw error;
      }
      throw new Error(`STRATZ HTTP ${response.status}: ${detail}`);
    }

    let payload;
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error('STRATZ вернул некорректный JSON');
    }

    if (Array.isArray(payload.errors) && payload.errors.length) {
      const message = payload.errors.map((entry) => entry.message || 'GraphQL error').join('; ');
      const retryable = payload.errors.every((entry) => SCHEMA_RETRY_PATTERN.test(String(entry.message || '')));
      this.activityLog?.add(`STRATZ ${label}: ${message}`, { category: 'stratz', level: 'error' });
      const error = new Error(`STRATZ: ${message}`);
      error.retryable = retryable;
      throw error;
    }

    this.activityLog?.add(`STRATZ ${label}: OK`, { category: 'stratz', level: 'success' });
    return payload.data || null;
  }

  async executeCandidates(candidates, cacheKey, input) {
    const order = [];
    const cached = this[cacheKey];
    if (Number.isInteger(cached) && cached >= 0 && cached < candidates.length) {
      order.push(cached);
    }
    candidates.forEach((_, index) => {
      if (index !== cached) order.push(index);
    });

    let lastRetryable = null;
    for (const index of order) {
      const candidate = candidates[index];
      try {
        const data = await this.graphql(candidate.query, candidate.variables(input), candidate.label);
        const result = candidate.map(data, input);
        if (result !== undefined) {
          this[cacheKey] = index;
          return result;
        }
      } catch (error) {
        if (error?.retryable) {
          lastRetryable = error;
          continue;
        }
        throw error;
      }
    }

    if (lastRetryable) throw lastRetryable;
    return null;
  }

  matchCandidates() {
    return [
      {
        label: 'match/party',
        query: `
          query MatchParty($id: Long!) {
            match(id: $id) {
              id
              gameMode
              lobbyType
              didRadiantWin
              startDateTime
              players {
                steamAccountId
                partyId
                isRadiant
                playerSlot
                steamAccount { id name }
              }
            }
          }
        `,
        variables: (input) => ({ id: input.matchId }),
        map: (data) => normalizeMatch(data?.match)
      }
    ];
  }

  historyCandidates() {
    const historyFields = `
      id
      gameMode
      lobbyType
      didRadiantWin
      players {
        steamAccountId
        isRadiant
        isVictory
      }
    `;

    return [
      {
        label: 'player/matches-ranked-lobby',
        query: `
          query PlayerMatches($steamAccountId: Long!, $take: Int!, $skip: Int!) {
            player(steamAccountId: $steamAccountId) {
              steamAccount { id name isAnonymous }
              matches(request: { take: $take, skip: $skip, lobbyTypeIds: [${LOBBY_TYPE_RANKED}] }) {
                ${historyFields}
              }
            }
          }
        `,
        variables: (input) => ({
          steamAccountId: input.accountId,
          take: input.take,
          skip: input.skip
        }),
        map: (data) => data?.player || null
      },
      {
        label: 'player/matches-ranked-mode',
        query: `
          query PlayerMatches($steamAccountId: Long!, $take: Int!, $skip: Int!) {
            player(steamAccountId: $steamAccountId) {
              steamAccount { id name isAnonymous }
              matches(request: { take: $take, skip: $skip, gameModeIds: [${RANKED_GAME_MODE_IDS.join(', ')}] }) {
                ${historyFields}
              }
            }
          }
        `,
        variables: (input) => ({
          steamAccountId: input.accountId,
          take: input.take,
          skip: input.skip
        }),
        map: (data) => data?.player || null
      },
      {
        label: 'player/matches-all',
        query: `
          query PlayerMatches($steamAccountId: Long!, $take: Int!, $skip: Int!) {
            player(steamAccountId: $steamAccountId) {
              steamAccount { id name isAnonymous }
              matches(request: { take: $take, skip: $skip }) {
                ${historyFields}
              }
            }
          }
        `,
        variables: (input) => ({
          steamAccountId: input.accountId,
          take: input.take,
          skip: input.skip
        }),
        map: (data) => {
          const player = data?.player;
          if (!player) return null;
          const matches = Array.isArray(player.matches)
            ? player.matches.filter((match) => isRankedMatch(match))
            : [];
          return { ...player, matches };
        }
      }
    ];
  }

  profileCandidates() {
    return [
      {
        label: 'player/profile',
        query: `
          query PlayerProfile($steamAccountId: Long!) {
            player(steamAccountId: $steamAccountId) {
              matchCount
              steamAccount { id name isAnonymous }
            }
          }
        `,
        variables: (input) => ({ steamAccountId: input.accountId }),
        map: (data) => data?.player || null
      }
    ];
  }

  async fetchMatch(matchId) {
    const id = Number(matchId);
    if (!Number.isFinite(id) || id <= 0) {
      throw new Error('Некорректный ID матча');
    }

    const match = await this.executeCandidates(this.matchCandidates(), 'cachedMatchQuery', { matchId: id });
    if (!match) {
      return { status: 'retry', match: null };
    }
    if (!match.players?.length) {
      return { status: 'retry', match: null };
    }
    return { status: 'ok', match };
  }

  async fetchPlayerProfile(accountId) {
    const id = Number(accountId);
    const player = await this.executeCandidates(this.profileCandidates(), 'cachedProfileQuery', { accountId: id });
    if (!player) {
      throw new Error('Игрок с таким Dota ID не найден в STRATZ');
    }
    return player;
  }

  async fetchPlayerMatchBatch(accountId, take, skip) {
    const id = Number(accountId);
    const player = await this.executeCandidates(this.historyCandidates(), 'cachedHistoryQuery', {
      accountId: id,
      take,
      skip
    });
    return {
      player,
      matches: Array.isArray(player?.matches) ? player.matches : []
    };
  }

  isHistoryUnavailable(player) {
    if (!player) return true;
    if (player.steamAccount?.isAnonymous) return true;
    return false;
  }

  mapHistoryMatch(match, accountId) {
    const localId = Number(accountId);
    const players = Array.isArray(match.players) ? match.players : [];
    const localPlayer = players.find((player) => Number(player.steamAccountId) === localId)
      || players[0];

    let won = null;
    if (typeof localPlayer?.isVictory === 'boolean') {
      won = localPlayer.isVictory;
    } else if (typeof match.didRadiantWin === 'boolean' && typeof localPlayer?.isRadiant === 'boolean') {
      won = match.didRadiantWin === localPlayer.isRadiant;
    }

    const isRadiant = typeof localPlayer?.isRadiant === 'boolean'
      ? localPlayer.isRadiant
      : null;

    return {
      match_id: String(match.id),
      radiant_win: won == null ? null : (isRadiant ? won : !won),
      player_slot: isRadiant === true ? 0 : isRadiant === false ? 128 : null,
      lobby_type: 7,
      _won: won
    };
  }
}

export { isRankedGameMode, isRankedMatch, normalizeMatch };
