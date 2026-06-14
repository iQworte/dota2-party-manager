import { normalizeAccountId } from './account-id.js';

const MAX_IMPORT_MATCHES = 500;
const MATCHES_PAGE_SIZE = 100;
const RETRY_DELAYS_MS = [5000, 15000, 30000, 60000, 60000, 60000, 60000, 60000, 60000, 60000, 60000, 60000, 60000, 60000, 60000];

function isRankedMatch(match) {
  return Number(match?.lobby_type) === 7;
}

function readPartyId(player) {
  const raw = player?.party_id ?? player?.partyId;
  if (raw == null || raw === '') return null;
  const id = Number(raw);
  return Number.isFinite(id) ? id : null;
}

function isSameTeam(player, isRadiant) {
  return Boolean(player.isRadiant ?? player.player_slot < 128) === isRadiant;
}

export class PartyTracker {
  constructor({ statsStore, onChange, stratzApi, activityLog }) {
    this.statsStore = statsStore;
    this.onChange = onChange || (() => {});
    this.stratzApi = stratzApi;
    this.activityLog = activityLog || null;
    this.pendingMatches = new Map();
    this.lastProcessedMatchId = null;
    this.lastProcessedAt = null;
    this.lastError = null;
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
    const playerProfile = await this.stratzApi.fetchPlayerProfile(id);
    const historyUnavailable = this.stratzApi.isHistoryUnavailable(playerProfile);
    const matches = await this.fetchRankedPlayerMatchHistory(id, requested, onHistoryProgress);

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

      const won = match._won;
      if (won !== true && won !== false) continue;

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
        const outcome = await this.processMatch(item);
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
              `STRATZ: матч ${matchId} ещё не готов, повтор запроса позже`,
              { category: 'stratz', level: 'warn' }
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
            `STRATZ: ошибка обработки матча ${matchId} — ${error.message}`,
            { category: 'stratz', level: 'error' }
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

  async processMatch(item) {
    const response = await this.stratzApi.fetchMatch(item.matchId);
    if (response.status === 'retry') {
      return { status: 'retry' };
    }

    const match = response.match;
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

    const partyId = readPartyId(localPlayer);
    const isRadiant = Boolean(localPlayer.isRadiant ?? localPlayer.player_slot < 128);

    if (partyId === null) {
      return { status: 'processed', allies: [] };
    }

    const matchPlayedAt = Number.isFinite(Number(match.start_time))
      ? new Date(Number(match.start_time) * 1000).toISOString()
      : null;

    const teammates = players.filter((player) => {
      const accountId = normalizeAccountId(player.account_id);
      if (!accountId || accountId === localAccountId) return false;
      return isSameTeam(player, isRadiant);
    });

    const allies = teammates
      .filter((player) => readPartyId(player) === partyId)
      .map((player) => ({
        accountId: normalizeAccountId(player.account_id),
        displayName: String(player.personaname || player.name || '').trim()
      }))
      .filter((player) => player.accountId);

    if (!allies.length) {
      const teammatesHavePartyData = teammates.some((player) => readPartyId(player) !== null);
      if (!teammatesHavePartyData) {
        return { status: 'retry' };
      }
      return { status: 'processed', allies: [] };
    }

    return { status: 'processed', allies, matchPlayedAt };
  }

  async fetchRankedPlayerMatchHistory(accountId, count, onProgress) {
    const ranked = [];
    let skip = 0;
    let completed = 0;
    let total = Math.max(1, Math.ceil(count / MATCHES_PAGE_SIZE));

    const report = () => onProgress?.(completed, total);

    report();

    while (ranked.length < count) {
      const { matches: batch } = await this.stratzApi.fetchPlayerMatchBatch(
        accountId,
        MATCHES_PAGE_SIZE,
        skip
      );

      completed += 1;

      if (!Array.isArray(batch) || batch.length === 0) {
        total = completed;
        report();
        break;
      }

      for (const match of batch) {
        const mapped = this.stratzApi.mapHistoryMatch(match, accountId);
        if (mapped._won !== true && mapped._won !== false) continue;
        ranked.push(mapped);
        if (ranked.length >= count) break;
      }

      skip += batch.length;

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
}
