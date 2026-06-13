import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { normalizeAccountId } from './account-id.js';

export function createEmptyStats() {
  return {
    version: 1,
    processedMatches: [],
    pendingMatches: [],
    players: {}
  };
}

export class StatsStore {
  constructor(statsPath) {
    this.statsPath = statsPath;
    this.stats = createEmptyStats();
    this.loaded = false;
  }

  async load() {
    try {
      const raw = await readFile(this.statsPath, 'utf8');
      this.stats = normalizeStats(JSON.parse(raw));
    } catch {
      this.stats = createEmptyStats();
      await this.save();
    }
    this.loaded = true;
    return this.stats;
  }

  async save() {
    await mkdir(dirname(this.statsPath), { recursive: true });
    await writeFile(this.statsPath, JSON.stringify(this.stats, null, 2), 'utf8');
  }

  isMatchProcessed(matchId) {
    return this.stats.processedMatches.includes(String(matchId));
  }

  markMatchProcessed(matchId) {
    const id = String(matchId);
    if (!this.stats.processedMatches.includes(id)) {
      this.stats.processedMatches.push(id);
      if (this.stats.processedMatches.length > 5000) {
        this.stats.processedMatches = this.stats.processedMatches.slice(-5000);
      }
    }
  }

  recordPartyResult({ allies, result, matchId, matchPlayedAt }) {
    const now = new Date().toISOString();
    const playedAt = stringOrNull(matchPlayedAt) || now;
    for (const ally of allies) {
      const accountId = normalizeAccountId(ally.accountId);
      if (!accountId) continue;
      const key = String(accountId);
      const existing = this.stats.players[key] || {
        accountId: key,
        displayName: '',
        wins: 0,
        losses: 0,
        firstSeenAt: now,
        lastSeenAt: now,
        lastMatchId: null,
        lastMatchAt: null
      };

      existing.displayName = String(ally.displayName || existing.displayName || '').slice(0, 64);
      existing.lastSeenAt = now;
      existing.lastMatchId = String(matchId);
      existing.lastMatchAt = playedAt;
      if (result === 'win') existing.wins += 1;
      if (result === 'lose') existing.losses += 1;
      this.stats.players[key] = existing;
    }

    this.markMatchProcessed(matchId);
  }

  listPlayers(query = '') {
    const q = String(query || '').trim().toLowerCase();
    let players = Object.values(this.stats.players);

    if (q) {
      players = players.filter((player) => (
        String(player.displayName || '').toLowerCase().includes(q)
        || String(player.accountId || '').includes(q)
      ));
    }

    return players
      .map((player) => ({
        ...player,
        total: Number(player.wins || 0) + Number(player.losses || 0),
        winRate: winRate(player.wins, player.losses)
      }))
      .sort((left, right) => {
        const leftTime = Date.parse(left.lastMatchAt || '') || 0;
        const rightTime = Date.parse(right.lastMatchAt || '') || 0;
        if (rightTime !== leftTime) return rightTime - leftTime;
        return String(left.displayName || '').localeCompare(String(right.displayName || ''), 'ru');
      });
  }

  updatePlayer(accountId, patch) {
    const id = normalizeAccountId(accountId);
    if (!id) throw new Error('Invalid account ID');
    const key = String(id);
    const existing = this.stats.players[key];
    if (!existing) throw new Error('Player not found');

    if (patch.displayName !== undefined) {
      existing.displayName = String(patch.displayName || '').slice(0, 64);
    }
    if (patch.wins !== undefined) {
      existing.wins = clampInt(patch.wins, 0, 100000);
    }
    if (patch.losses !== undefined) {
      existing.losses = clampInt(patch.losses, 0, 100000);
    }

    this.stats.players[key] = existing;
    return existing;
  }

  deletePlayer(accountId) {
    const id = normalizeAccountId(accountId);
    if (!id) throw new Error('Invalid account ID');
    const key = String(id);
    if (!this.stats.players[key]) throw new Error('Player not found');
    delete this.stats.players[key];
  }

  resetAll() {
    this.stats = createEmptyStats();
  }

  getPendingMatches() {
    return Array.isArray(this.stats.pendingMatches) ? this.stats.pendingMatches : [];
  }

  setPendingMatches(items) {
    this.stats.pendingMatches = items;
  }

  snapshot() {
    return structuredClone(this.stats);
  }
}

function normalizeStats(value) {
  const stats = value && typeof value === 'object' ? value : createEmptyStats();
  stats.version = 1;
  stats.processedMatches = Array.isArray(stats.processedMatches)
    ? stats.processedMatches.map(String).slice(-5000)
    : [];
  stats.pendingMatches = normalizePendingMatches(stats.pendingMatches, stats.processedMatches);
  stats.players = stats.players && typeof stats.players === 'object' ? stats.players : {};

  for (const [key, player] of Object.entries(stats.players)) {
    if (!player || typeof player !== 'object') {
      delete stats.players[key];
      continue;
    }
    const accountId = normalizeAccountId(player.accountId ?? key);
    if (!accountId) {
      delete stats.players[key];
      continue;
    }
    stats.players[String(accountId)] = {
      accountId: String(accountId),
      displayName: String(player.displayName || '').slice(0, 64),
      wins: clampInt(player.wins, 0, 100000),
      losses: clampInt(player.losses, 0, 100000),
      firstSeenAt: stringOrNull(player.firstSeenAt),
      lastSeenAt: stringOrNull(player.lastSeenAt),
      lastMatchId: player.lastMatchId ? String(player.lastMatchId) : null,
      lastMatchAt: stringOrNull(player.lastMatchAt ?? player.lastSeenAt)
    };
    if (key !== String(accountId)) delete stats.players[key];
  }

  return stats;
}

function normalizePendingMatches(value, processedMatches) {
  const processed = new Set((processedMatches || []).map(String));
  const seen = new Set();
  const items = [];

  for (const raw of Array.isArray(value) ? value : []) {
    const item = normalizePendingMatch(raw);
    if (!item || processed.has(item.matchId) || seen.has(item.matchId)) continue;
    seen.add(item.matchId);
    items.push(item);
  }

  return items.slice(-500);
}

function normalizePendingMatch(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const matchId = String(raw.matchId || '').trim();
  const localAccountId = normalizeAccountId(raw.localAccountId);
  const result = raw.result;
  if (!matchId || !localAccountId || !['win', 'lose'].includes(result)) return null;

  return {
    matchId,
    localAccountId: String(localAccountId),
    result,
    attempts: clampInt(raw.attempts, 0, 1000),
    enqueuedAt: stringOrNull(raw.enqueuedAt) || new Date().toISOString(),
    nextAttemptAt: Number.isFinite(Number(raw.nextAttemptAt)) ? Number(raw.nextAttemptAt) : Date.now()
  };
}

function winRate(wins, losses) {
  const w = Number(wins || 0);
  const l = Number(losses || 0);
  const total = w + l;
  if (!total) return 0;
  return Math.round((w / total) * 1000) / 10;
}

function clampInt(value, min, max) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function stringOrNull(value) {
  const text = String(value || '').trim();
  return text || null;
}
