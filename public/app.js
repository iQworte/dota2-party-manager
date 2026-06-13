const els = {
  gsiStatus: document.querySelector('#gsiStatus'),
  dotaPath: document.querySelector('#dotaPath'),
  detectDota: document.querySelector('#detectDota'),
  installGsi: document.querySelector('#installGsi'),
  currentAccount: document.querySelector('#currentAccount'),
  lastMatch: document.querySelector('#lastMatch'),
  pendingCount: document.querySelector('#pendingCount'),
  searchInput: document.querySelector('#searchInput'),
  playersBody: document.querySelector('#playersBody'),
  importMatches: document.querySelector('#importMatches'),
  importDialog: document.querySelector('#importDialog'),
  importForm: document.querySelector('#importForm'),
  importCount: document.querySelector('#importCount'),
  importCancel: document.querySelector('#importCancel'),
  resetStats: document.querySelector('#resetStats'),
  editDialog: document.querySelector('#editDialog'),
  editForm: document.querySelector('#editForm'),
  editPlayerLabel: document.querySelector('#editPlayerLabel'),
  editName: document.querySelector('#editName'),
  editWins: document.querySelector('#editWins'),
  editLosses: document.querySelector('#editLosses'),
  editCancel: document.querySelector('#editCancel'),
  resetDialog: document.querySelector('#resetDialog'),
  resetForm: document.querySelector('#resetForm'),
  resetConfirmCheck: document.querySelector('#resetConfirmCheck'),
  resetConfirmText: document.querySelector('#resetConfirmText'),
  resetCancel: document.querySelector('#resetCancel')
};

let snapshot = null;
let searchTimer = null;
let editingAccountId = null;
let lastTableKey = '';

async function api(path, body = null, method = body ? 'POST' : 'GET') {
  const response = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

function partyStats(wins, losses) {
  const w = Number(wins || 0);
  const l = Number(losses || 0);
  const total = w + l;
  const mmr = w * 25 - l * 25;
  const mmrLabel = mmr > 0 ? `(+${mmr} mmr)` : mmr < 0 ? `(${mmr} mmr)` : `(+0 mmr)`;

  if (!total) {
    return { percent: 0, label: `0% ${mmrLabel}`, tone: 'mid' };
  }

  const percent = Math.round((w / total) * 1000) / 10;
  let tone = 'mid';
  if (percent > 55) tone = 'good';
  else if (percent < 45) tone = 'bad';

  return {
    percent,
    label: `${percent}% ${mmrLabel}`,
    tone
  };
}

function formatLastMatchDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('ru-RU');
}

function winLossCell(wins, losses) {
  const w = Number(wins || 0);
  const l = Number(losses || 0);
  return `<span class="wl"><span class="wl-win">${w}W</span> - <span class="wl-loss">${l}L</span></span>`;
}

function winRateCell(wins, losses) {
  const stats = partyStats(wins, losses);
  return `<span class="winrate winrate-${stats.tone}">${escapeHtml(stats.label)}</span>`;
}

function renderPlayers(players) {
  if (!players.length) {
    els.playersBody.innerHTML = '<tr><td colspan="6" class="empty">Нет данных</td></tr>';
    return;
  }

  els.playersBody.innerHTML = players.map((player) => `
    <tr>
      <td>${escapeHtml(player.displayName || '—')}</td>
      <td>${escapeHtml(player.accountId)}</td>
      <td>${winLossCell(player.wins, player.losses)}</td>
      <td>${winRateCell(player.wins, player.losses)}</td>
      <td>${escapeHtml(formatLastMatchDate(player.lastMatchAt))}</td>
      <td class="actions">
        <button type="button" class="small icon-btn" data-edit="${escapeAttr(player.accountId)}" aria-label="Изменить" title="Изменить">
          <i class="bi bi-pencil"></i>
        </button>
        <button type="button" class="small icon-btn danger" data-delete="${escapeAttr(player.accountId)}" aria-label="Удалить" title="Удалить">
          <i class="bi bi-trash"></i>
        </button>
      </td>
    </tr>
  `).join('');
}

function buildPlayersList(state, query) {
  let players = Object.values(state.stats?.players || {}).map((player) => {
    const stats = partyStats(player.wins, player.losses);
    return {
      ...player,
      total: Number(player.wins || 0) + Number(player.losses || 0),
      winRate: stats.percent
    };
  });

  if (query) {
    players = players.filter((player) => (
      String(player.displayName || '').toLowerCase().includes(query)
      || String(player.accountId || '').includes(query)
    ));
  }

  players.sort((left, right) => {
    const leftTime = Date.parse(left.lastMatchAt || '') || 0;
    const rightTime = Date.parse(right.lastMatchAt || '') || 0;
    if (rightTime !== leftTime) return rightTime - leftTime;
    return String(left.displayName || '').localeCompare(String(right.displayName || ''), 'ru');
  });

  return players;
}

function playersTableKey(players) {
  return players.map((player) => (
    `${player.accountId}:${player.wins}:${player.losses}:${player.displayName}:${player.lastMatchAt}`
  )).join('|');
}

function renderStatus(state) {
  const gsi = state.gsi || {};
  const tracker = state.tracker || {};

  els.gsiStatus.textContent = gsi.connected ? 'GSI подключён' : 'GSI не подключён';
  els.gsiStatus.className = `pill ${gsi.connected ? 'ok' : 'bad'}`;

  if (document.activeElement !== els.dotaPath) {
    els.dotaPath.value = state.config?.dota?.installPath || '';
  }

  if (gsi.localAccountId) {
    const name = gsi.localDisplayName ? `${gsi.localDisplayName} (${gsi.localAccountId})` : gsi.localAccountId;
    els.currentAccount.textContent = name;
  } else {
    els.currentAccount.textContent = '—';
  }

  els.lastMatch.textContent = tracker.lastProcessedMatchId || '—';
  els.pendingCount.textContent = String((tracker.pendingMatches || []).length);

  const gsiReady = Boolean(gsi.connected && gsi.localAccountId);
  els.importMatches.disabled = !gsiReady;
}

function renderState(state) {
  snapshot = state;
  renderStatus(state);

  const query = els.searchInput.value.trim().toLowerCase();
  const players = buildPlayersList(state, query);
  const tableKey = `${query}::${playersTableKey(players)}`;

  if (tableKey !== lastTableKey) {
    lastTableKey = tableKey;
    renderPlayers(players);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("'", '&#39;');
}

function connectEvents() {
  const source = new EventSource('/api/events');
  source.onmessage = (event) => {
    renderState(JSON.parse(event.data));
  };
  source.onerror = () => {
    setTimeout(() => {
      source.close();
      connectEvents();
    }, 2000);
  };
}

els.detectDota.addEventListener('click', async () => {
  try {
    const result = await api('/api/dota/detect', null, 'GET');
    els.dotaPath.value = result.dotaPath || '';
    alert(`Dota найдена:\n${result.dotaPath}`);
  } catch (error) {
    alert(error.message);
  }
});

els.installGsi.addEventListener('click', async () => {
  try {
    const result = await api('/api/install-gsi', { dotaPath: els.dotaPath.value.trim() });
    els.dotaPath.value = result.dotaPath || els.dotaPath.value;
    alert(`GSI установлен:\n${result.cfgPath}\n\nПерезапустите Dota 2, если она уже была открыта.`);
  } catch (error) {
    alert(error.message);
  }
});

els.dotaPath.addEventListener('change', async () => {
  try {
    await api('/api/config', {
      dota: { installPath: els.dotaPath.value.trim() }
    });
  } catch (error) {
    alert(error.message);
  }
});

els.searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (snapshot) renderState(snapshot);
  }, 200);
});

els.playersBody.addEventListener('click', async (event) => {
  const editId = event.target.closest('[data-edit]')?.dataset.edit;
  const deleteId = event.target.closest('[data-delete]')?.dataset.delete;

  if (editId) {
    const player = snapshot?.stats?.players?.[editId];
    if (!player) return;
    editingAccountId = editId;
    els.editPlayerLabel.textContent = `Dota ID: ${editId}`;
    els.editName.value = player.displayName || '';
    els.editWins.value = player.wins ?? 0;
    els.editLosses.value = player.losses ?? 0;
    els.editDialog.showModal();
    return;
  }

  if (deleteId) {
    const player = snapshot?.stats?.players?.[deleteId];
    const label = player?.displayName || deleteId;
    if (!confirm(`Удалить игрока "${label}" из статистики?`)) return;
    try {
      await api(`/api/stats/players/${encodeURIComponent(deleteId)}`, null, 'DELETE');
    } catch (error) {
      alert(error.message);
    }
  }
});

els.editCancel.addEventListener('click', () => els.editDialog.close());

els.editForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!editingAccountId) return;
  try {
    await api(`/api/stats/players/${encodeURIComponent(editingAccountId)}`, {
      displayName: els.editName.value.trim(),
      wins: Number(els.editWins.value),
      losses: Number(els.editLosses.value)
    }, 'PATCH');
    els.editDialog.close();
  } catch (error) {
    alert(error.message);
  }
});

els.importMatches.addEventListener('click', () => {
  if (els.importMatches.disabled) return;
  els.importCount.value = '20';
  els.importDialog.showModal();
});

els.importCancel.addEventListener('click', () => els.importDialog.close());

els.importForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const count = Number(els.importCount.value);
  if (!Number.isFinite(count) || count < 1 || count > 100) {
    alert('Укажите число матчей от 1 до 100');
    return;
  }
  try {
    const result = await api('/api/queue/import-recent', { count });
    els.importDialog.close();
    alert(
      `Запрошено: ${result.requested}\n`
      + `Добавлено в очередь: ${result.enqueued}\n`
      + `Пропущено (уже учтены): ${result.skipped}\n`
      + `Получено из OpenDota: ${result.fetched}`
      + (result.fetched < result.requested ? '\n\nВ OpenDota найдено меньше ranked-матчей, чем запрошено.' : '')
    );
  } catch (error) {
    alert(error.message);
  }
});

els.resetStats.addEventListener('click', () => {
  els.resetConfirmCheck.checked = false;
  els.resetConfirmText.value = '';
  els.resetDialog.showModal();
});

els.resetCancel.addEventListener('click', () => els.resetDialog.close());

els.resetForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!els.resetConfirmCheck.checked || els.resetConfirmText.value.trim().toUpperCase() !== 'СБРОС') {
    alert('Подтвердите сброс: отметьте галочку и введите СБРОС');
    return;
  }
  try {
    await api('/api/stats/reset', { confirm: true });
    els.resetDialog.close();
  } catch (error) {
    alert(error.message);
  }
});

connectEvents();
api('/api/state').then(renderState).catch(console.error);
