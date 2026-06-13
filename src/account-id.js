export function normalizeAccountId(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  if (number > 76561197960265728) return Math.trunc(number - 76561197960265728);
  return Math.trunc(number);
}

export function normalizeTeam(value) {
  const raw = String(value || '').toLowerCase();
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    if (numeric === 2) return 'radiant';
    if (numeric === 3) return 'dire';
  }
  if (raw.includes('radiant') || raw.includes('good') || raw === '2' || raw === 'team2') return 'radiant';
  if (raw.includes('dire') || raw.includes('bad') || raw === '3' || raw === 'team3') return 'dire';
  return null;
}

export function normalizePlayerTeam(player) {
  const direct = normalizeTeam(player?.team_name || player?.team);
  if (direct) return direct;
  const slot = Number(player?.team_slot ?? player?.player_slot);
  if (!Number.isFinite(slot)) return null;
  if (slot >= 0 && slot < 5) return 'radiant';
  if (slot >= 5 && slot < 10) return 'dire';
  if (slot >= 128) return 'dire';
  return 'radiant';
}
