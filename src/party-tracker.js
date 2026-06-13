import { normalizeAccountId } from './account-id.js';

const OPENDOTA_MATCH_URL = 'https://api.opendota.com/api/matches';
const OPENDOTA_PLAYER_MATCHES_URL = 'https://api.opendota.com/api/players';
const OPENDOTA_RANKED_LOBBY_TYPE = 7;
const RETRY_DELAYS_MS = [5000, 15000, 30000, 60000, 60000, 60000, 60000, 60000, 60000, 60000, 60000, 60000, 60000, 60000, 60000];

function isRankedMatch(match) {
  return Number(match?.lobby_type) === OPENDOTA_RANKED_LOBBY_TYPE;
}

export class PartyTracker {
  constructor({ statsStore, onChange }) {
    this.statsStore = statsStore;
    this.onChange = onChange || (() => {});
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

  async importRecentMatches({ accountId, count }) {
    const id = normalizeAccountId(accountId);
    if (!id) {
      throw new Error('Некорректный Dota ID');
    }

    const requested = Math.min(Math.max(1, Math.floor(Number(count) || 1)), 100);
    const matches = await fetchRankedPlayerMatchHistory(id, requested);

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
        const outcome = await processMatch(item);
        if (outcome.status === 'processed') {
          if (outcome.allies.length) {
            this.statsStore.recordPartyResult({
              allies: outcome.allies,
              result: item.result,
              matchId,
              matchPlayedAt: outcome.matchPlayedAt
            });
          } else {
            this.statsStore.markMatchProcessed(matchId);
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

async function processMatch(item) {
  const response = await fetch(`${OPENDOTA_MATCH_URL}/${item.matchId}`, {
    headers: { accept: 'application/json' }
  });

  if (response.status === 404 || response.status === 202) {
    return { status: 'retry' };
  }

  if (!response.ok) {
    throw new Error(`OpenDota HTTP ${response.status}`);
  }

  const match = await response.json();
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

async function fetchRankedPlayerMatchHistory(accountId, count) {
  const ranked = [];
  let offset = 0;

  while (ranked.length < count) {
    const response = await fetch(
      `${OPENDOTA_PLAYER_MATCHES_URL}/${accountId}/matches?limit=100&offset=${offset}`,
      { headers: { accept: 'application/json' } }
    );

    if (!response.ok) {
      throw new Error(`OpenDota HTTP ${response.status}`);
    }

    const batch = await response.json();
    if (!Array.isArray(batch) || batch.length === 0) {
      break;
    }

    for (const match of batch) {
      if (!isRankedMatch(match)) continue;
      ranked.push(match);
      if (ranked.length >= count) break;
    }

    offset += batch.length;
  }

  return ranked.slice(0, count);
}
