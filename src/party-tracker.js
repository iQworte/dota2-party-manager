import { normalizeAccountId } from './account-id.js';
import { createOpenDotaFetch } from './opendota-fetch.js';

const OPENDOTA_MATCH_URL = 'https://api.opendota.com/api/matches';
const OPENDOTA_PLAYER_MATCHES_URL = 'https://api.opendota.com/api/players';
const OPENDOTA_RANKED_LOBBY_TYPE = 7;
const MAX_IMPORT_MATCHES = 500;
const MATCHES_PAGE_SIZE = 100;
const RETRY_DELAYS_MS = [5000, 15000, 30000, 60000, 60000, 60000, 60000, 60000, 60000, 60000, 60000, 60000, 60000, 60000, 60000];

function isRankedMatch(match) {
  return Number(match?.lobby_type) === OPENDOTA_RANKED_LOBBY_TYPE;
}

export class PartyTracker {
  constructor({ statsStore, onChange, getProxyConfig, activityLog }) {
    this.statsStore = statsStore;
    this.onChange = onChange || (() => {});
    this.getProxyConfig = getProxyConfig || (() => null);
    this.activityLog = activityLog || null;
    this.pendingMatches = new Map();
    this.lastProcessedMatchId = null;
    this.lastProcessedAt = null;
    this.lastError = null;
  }

  fetchOpenDota(url, options) {
    return createOpenDotaFetch(this.getProxyConfig())(url, options);
  }

  restoreFromStore() {
    this.pendingMatches.clear();
    for (const item of this.statsStore.getPendingMatches()) {
      if (this.statsStore.isMatchProcessed(item.matchId)) continue;
      this.pendingMatches.set(item.matchId, { ...item });
    }
    if (this.pendingMatches.size > 0) {
      this.scheduleProcessing();
    }
  }

  enqueueMatch({ matchId, localAccountId, result }) {
    const id = String(matchId);
    if (!id || !localAccountId || !['win', 'lose'].includes(result)) return;
    if (this.statsStore.isMatchProcessed(id)) return;
    if (this.pendingMatches.has(id)) return;

    this.pendingMatches.set(id, {
      matchId: id,
      localAccountId: String(localAccountId),
      result,
      attempts: 0,
      enqueuedAt: new Date().toISOString(),
      nextAttemptAt: Date.now()
    });

    this.persistQueue().catch(() => {});
    this.scheduleProcessing();
  }

  clearQueue() {
    this.pendingMatches.clear();
    this.statsStore.setPendingMatches([]);
  }

  async importRecentMatches({ accountId, count, onHistoryProgress }) {
    const id = normalizeAccountId(accountId);
    if (!id) {
      throw new Error('Некорректный Dota ID');
    }

    const requested = Math.min(Math.max(1, Math.floor(Number(count) || 1)), MAX_IMPORT_MATCHES);
    const fetchFn = (url, options) => this.fetchOpenDota(url, options);
    const playerProfile = await fetchPlayerProfile(id, fetchFn, this.activityLog);
    const historyUnavailable = isMatchHistoryUnavailable(playerProfile);
    const matches = await fetchRankedPlayerMatchHistory(
      id,
      requested,
      fetchFn,
      this.activityLog,
      onHistoryProgress
    );

    if (!matches.length && historyUnavailable) {
      throw new Error(
        'История матчей недоступна: в Dota 2 отключена опция «Expose Public Match Data». '
        + 'Включите её в клиенте: Настройки → Социальное.'
      );
    }

    let enqueued = 0;
    let skipped = 0;

    for (const match of matches) {
      const matchId = String(match?.match_id || '').trim();
      if (!matchId) continue;

      if (this.statsStore.isMatchProcessed(matchId) || this.pendingMatches.has(matchId)) {
        skipped += 1;
        continue;
      }

      const isRadiant = Number(match.player_slot) < 128;
      const won = Boolean(match.radiant_win) === isRadiant;
      this.enqueueMatch({
        matchId,
        localAccountId: String(id),
        result: won ? 'win' : 'lose'
      });
      enqueued += 1;
    }

    return { requested, enqueued, skipped, fetched: matches.length };
  }

  logQueueEnqueue({ matchId, result, source = 'gsi' }) {
    const label = result === 'win' ? 'победа' : 'поражение';
    const prefix = source === 'import' ? 'Импорт' : 'Матч завершён';
    this.activityLog?.add(
      `${prefix}: ${matchId} (${label}), добавлен в очередь обработки`,
      { category: 'queue', level: 'success' }
    );
  }

  getPendingMatches() {
    return Array.from(this.pendingMatches.values()).map((item) => ({
      matchId: item.matchId,
      result: item.result,
      attempts: item.attempts,
      enqueuedAt: item.enqueuedAt
    }));
  }

  scheduleProcessing() {
    if (this.processTimer) return;
    this.processTimer = setTimeout(() => {
      this.processTimer = null;
      this.processQueue().catch((error) => {
        this.lastError = error.message;
      });
    }, 250);
  }

  async persistQueue() {
    const items = Array.from(this.pendingMatches.values()).map((item) => ({
      matchId: item.matchId,
      localAccountId: item.localAccountId,
      result: item.result,
      attempts: item.attempts,
      enqueuedAt: item.enqueuedAt,
      nextAttemptAt: item.nextAttemptAt
    }));
    this.statsStore.setPendingMatches(items);
    await this.statsStore.save();
  }

  async processQueue() {
    const now = Date.now();
    let workLeft = false;
    let queueChanged = false;

    for (const [matchId, item] of this.pendingMatches.entries()) {
      if (item.nextAttemptAt > now) {
        workLeft = true;
        continue;
      }

      if (this.statsStore.isMatchProcessed(matchId)) {
        this.pendingMatches.delete(matchId);
        queueChanged = true;
        continue;
      }

      item.attempts += 1;

      try {
        const outcome = await processMatch(item, (url, options) => this.fetchOpenDota(url, options), this.activityLog);
        if (outcome.status === 'processed') {
          if (outcome.allies.length) {
            this.statsStore.recordPartyResult({
              allies: outcome.allies,
              result: item.result,
              matchId,
              matchPlayedAt: outcome.matchPlayedAt
            });
            this.activityLog?.add(
              `Матч ${matchId} обработан: ${outcome.allies.length} напарник(ов), ${item.result === 'win' ? 'победа' : 'поражение'}`,
              { category: 'queue', level: 'success' }
            );
          } else {
            this.statsStore.markMatchProcessed(matchId);
            this.activityLog?.add(
              `Матч ${matchId} обработан без пати`,
              { category: 'queue', level: 'info' }
            );
          }

          this.pendingMatches.delete(matchId);
          this.lastProcessedMatchId = matchId;
          this.lastProcessedAt = new Date().toISOString();
          this.lastError = null;
          queueChanged = true;
          this.statsStore.setPendingMatches(Array.from(this.pendingMatches.values()));
          await this.statsStore.save();
          this.onChange();
          continue;
        }

        if (outcome.status === 'retry') {
          if (item.attempts === 1) {
            this.activityLog?.add(
              `OpenDota: матч ${matchId} ещё не готов, повтор запроса позже`,
              { category: 'opendota', level: 'warn' }
            );
          }
          const delay = RETRY_DELAYS_MS[Math.min(item.attempts - 1, RETRY_DELAYS_MS.length - 1)];
          item.nextAttemptAt = Date.now() + delay;
          workLeft = true;
          queueChanged = true;
          continue;
        }

        this.pendingMatches.delete(matchId);
        this.statsStore.markMatchProcessed(matchId);
        queueChanged = true;
        this.statsStore.setPendingMatches(Array.from(this.pendingMatches.values()));
        await this.statsStore.save();
        this.onChange();
      } catch (error) {
        this.lastError = error.message;
        if (item.attempts === 1) {
          this.activityLog?.add(
            `OpenDota: ошибка обработки матча ${matchId} — ${error.message}`,
            { category: 'opendota', level: 'error' }
          );
        }
        const delay = RETRY_DELAYS_MS[Math.min(item.attempts - 1, RETRY_DELAYS_MS.length - 1)];
        item.nextAttemptAt = Date.now() + delay;
        workLeft = true;
        queueChanged = true;
      }
    }

    if (queueChanged) {
      await this.persistQueue().catch(() => {});
    }

    if (workLeft || this.pendingMatches.size > 0) {
      const nextItem = Array.from(this.pendingMatches.values())
        .sort((left, right) => left.nextAttemptAt - right.nextAttemptAt)[0];
      const waitMs = nextItem ? Math.max(500, nextItem.nextAttemptAt - Date.now()) : 5000;
      this.processTimer = setTimeout(() => {
        this.processTimer = null;
        this.processQueue().catch(() => {});
      }, waitMs);
    }
  }

  snapshot() {
    return {
      pendingMatches: this.getPendingMatches(),
      lastProcessedMatchId: this.lastProcessedMatchId,
      lastProcessedAt: this.lastProcessedAt,
      lastError: this.lastError
    };
  }
}

function shortOpenDotaPath(url) {
  return String(url).replace('https://api.opendota.com/api/', '');
}

async function openDotaGet(url, fetchFn, activityLog) {
  const shortPath = shortOpenDotaPath(url);
  const response = await fetchFn(url, { headers: { accept: 'application/json' } });
  const status = response.status;

  if (status === 404 || status === 202) {
    activityLog?.add(`OpenDota GET ${shortPath}: HTTP ${status}`, { category: 'opendota', level: 'warn' });
    return { response, data: null, status };
  }

  if (!response.ok) {
    activityLog?.add(`OpenDota GET ${shortPath}: HTTP ${status}`, { category: 'opendota', level: 'error' });
    throw new Error(`OpenDota HTTP ${status}`);
  }

  const data = await response.json();
  let detail = `HTTP ${status}`;

  if (Array.isArray(data)) {
    detail += `, записей: ${data.length}`;
  } else if (data?.profile?.account_id) {
    detail += `, аккаунт ${data.profile.account_id}`;
  } else if (data?.match_id) {
    detail += `, матч ${data.match_id}, игроков: ${Array.isArray(data.players) ? data.players.length : 0}`;
  }

  activityLog?.add(`OpenDota GET ${shortPath}: ${detail}`, { category: 'opendota', level: 'success' });
  return { response, data, status };
}

async function processMatch(item, fetchFn, activityLog) {
  const { data: match, status } = await openDotaGet(
    `${OPENDOTA_MATCH_URL}/${item.matchId}`,
    fetchFn,
    activityLog
  );

  if (status === 404 || status === 202) {
    return { status: 'retry' };
  }

  const players = Array.isArray(match?.players) ? match.players : [];
  if (!players.length) {
    return { status: 'retry' };
  }

  if (!isRankedMatch(match)) {
    return { status: 'processed', allies: [] };
  }

  const localAccountId = normalizeAccountId(item.localAccountId);
  const localPlayer = players.find((player) => normalizeAccountId(player.account_id) === localAccountId);
  if (!localPlayer) {
    return { status: 'done', allies: [] };
  }

  const partyId = Number(localPlayer.party_id);
  const partySize = Number(localPlayer.party_size);
  const isRadiant = Boolean(localPlayer.isRadiant ?? localPlayer.player_slot < 128);

  if (!Number.isFinite(partySize) || partySize <= 1) {
    return { status: 'processed', allies: [] };
  }

  if (!Number.isFinite(partyId)) {
    return { status: 'processed', allies: [] };
  }

  const matchPlayedAt = Number.isFinite(Number(match.start_time))
    ? new Date(Number(match.start_time) * 1000).toISOString()
    : null;

  const allies = players
    .filter((player) => {
      const accountId = normalizeAccountId(player.account_id);
      if (!accountId || accountId === localAccountId) return false;
      const sameSide = Boolean(player.isRadiant ?? player.player_slot < 128) === isRadiant;
      if (!sameSide) return false;
      return Number(player.party_id) === partyId;
    })
    .map((player) => ({
      accountId: normalizeAccountId(player.account_id),
      displayName: String(player.personaname || player.name || '').trim()
    }))
    .filter((player) => player.accountId);

  return { status: 'processed', allies, matchPlayedAt };
}

async function fetchPlayerProfile(accountId, fetchFn, activityLog) {
  const { data, status } = await openDotaGet(
    `${OPENDOTA_PLAYER_MATCHES_URL}/${accountId}`,
    fetchFn,
    activityLog
  );

  if (status === 404) {
    throw new Error('Игрок с таким Dota ID не найден в OpenDota');
  }

  return data;
}

function isMatchHistoryUnavailable(player) {
  const profile = player?.profile && typeof player.profile === 'object' ? player.profile : {};
  if (profile.is_pro) return false;
  return Boolean(profile.fh_unavailable);
}

async function fetchRankedPlayerMatchHistory(accountId, count, fetchFn, activityLog, onProgress) {
  const ranked = [];
  let offset = 0;
  let completed = 0;
  let total = Math.max(1, Math.ceil(count / MATCHES_PAGE_SIZE));

  const report = () => onProgress?.(completed, total);
  report();

  while (ranked.length < count) {
    const { data: batch } = await openDotaGet(
      `${OPENDOTA_PLAYER_MATCHES_URL}/${accountId}/matches?limit=${MATCHES_PAGE_SIZE}&offset=${offset}`,
      fetchFn,
      activityLog
    );

    completed += 1;

    if (!Array.isArray(batch) || batch.length === 0) {
      total = completed;
      report();
      break;
    }

    for (const match of batch) {
      if (!isRankedMatch(match)) continue;
      ranked.push(match);
      if (ranked.length >= count) break;
    }

    offset += batch.length;

    if (ranked.length >= count) {
      total = completed;
      report();
      break;
    }

    if (batch.length === MATCHES_PAGE_SIZE) {
      total = Math.max(total, completed + 1);
    } else {
      total = completed;
    }
    report();
  }

  return ranked.slice(0, count);
}
