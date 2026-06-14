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
  importAccountId: document.querySelector('#importAccountId'),
  importCancel: document.querySelector('#importCancel'),
  importSubmit: document.querySelector('#importSubmit'),
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
  resetCancel: document.querySelector('#resetCancel'),
  openSettings: document.querySelector('#openSettings'),
  settingsDialog: document.querySelector('#settingsDialog'),
  settingsForm: document.querySelector('#settingsForm'),
  proxyHost: document.querySelector('#proxyHost'),
  proxyPort: document.querySelector('#proxyPort'),
  proxyLogin: document.querySelector('#proxyLogin'),
  proxyPass: document.querySelector('#proxyPass'),
  settingsCancel: document.querySelector('#settingsCancel'),
  openActivityLog: document.querySelector('#openActivityLog'),
  activityLogDialog: document.querySelector('#activityLogDialog'),
  activityLogList: document.querySelector('#activityLogList'),
  activityLogClose: document.querySelector('#activityLogClose')
};

let snapshot = null;
let searchTimer = null;
let editingAccountId = null;
let lastTableKey = '';
let lastActivityLogKey = '';
let activityLogDialogOpen = false;
let importInProgress = false;

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
}

function formatLogTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function activityLogKey(entries) {
  return (entries || []).map((entry) => `${entry.id}:${entry.message}`).join('|');
}

function renderActivityLog(entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) {
    els.activityLogList.innerHTML = '<div class="activity-log-empty">Пока нет записей</div>';
    return;
  }

  els.activityLogList.innerHTML = list.map((entry) => `
    <div class="activity-log-entry">
      <span class="activity-log-time">${escapeHtml(formatLogTime(entry.at))}</span>
      <span class="activity-log-message ${escapeAttr(entry.level || 'info')}">${escapeHtml(entry.message)}</span>
    </div>
  `).join('');
}

function setImportBusy(busy, progress = null) {
  importInProgress = busy;
  els.importAccountId.disabled = busy;
  els.importCount.disabled = busy;
  els.importCancel.disabled = busy;
  els.importSubmit.disabled = busy;

  if (!busy) {
    els.importSubmit.textContent = 'Добавить в очередь';
    return;
  }

  const current = Number(progress?.current || 0);
  const total = Number(progress?.total || 0);
  els.importSubmit.textContent = total > 0
    ? `Загрузка (${current}/${total})`
    : 'Загрузка...';
}

function renderState(state) {
  snapshot = state;
  renderStatus(state);

  if (importInProgress && state.importProgress?.active) {
    setImportBusy(true, state.importProgress);
  }

  const logKey = activityLogKey(state.activityLog);
  if (activityLogDialogOpen && logKey !== lastActivityLogKey) {
    lastActivityLogKey = logKey;
    renderActivityLog(state.activityLog);
  }

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
  const gsi = snapshot?.gsi || {};
  els.importAccountId.value = gsi.connected && gsi.localAccountId ? String(gsi.localAccountId) : '';
  els.importCount.value = '20';
  setImportBusy(false);
  els.importDialog.showModal();
});

els.importDialog.addEventListener('cancel', (event) => {
  if (importInProgress) event.preventDefault();
});

els.importCancel.addEventListener('click', () => {
  if (importInProgress) return;
  els.importDialog.close();
});

els.importForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (importInProgress) return;

  const accountId = els.importAccountId.value.trim();
  const count = Number(els.importCount.value);
  if (!accountId) {
    alert('Укажите Dota ID');
    return;
  }
  if (!Number.isFinite(count) || count < 1 || count > 500) {
    alert('Укажите число матчей от 1 до 500');
    return;
  }

  const estimatedPages = Math.max(1, Math.ceil(count / 100));
  setImportBusy(true, { current: 0, total: estimatedPages });

  try {
    const result = await api('/api/queue/import-recent', { accountId, count });
    setImportBusy(false);
    els.importDialog.close();
    alert(
      `Dota ID: ${accountId}\n`
      + `Запрошено: ${result.requested}\n`
      + `Добавлено в очередь: ${result.enqueued}\n`
      + `Пропущено (уже учтены): ${result.skipped}\n`
      + `Получено из OpenDota: ${result.fetched}`
      + (result.fetched < result.requested
        ? '\n\nВ OpenDota найдено меньше ranked-матчей, чем запрошено.'
        : '')
      + (result.fetched === 0
        ? '\n\nЕсли матчей нет, проверьте, что в Dota 2 включена опция «Expose Public Match Data» (Настройки → Социальное).'
        : '')
    );
  } catch (error) {
    setImportBusy(false);
    alert(error.message);
  }
});

els.resetStats.addEventListener('click', () => {
  els.resetConfirmCheck.checked = false;
  els.resetConfirmText.value = '';
  els.resetDialog.showModal();
});

function fillSettingsForm(proxy = {}) {
  els.proxyHost.value = proxy.host || '';
  els.proxyPort.value = proxy.port || '';
  els.proxyLogin.value = proxy.login || '';
  els.proxyPass.value = proxy.pass || '';
}

els.openSettings.addEventListener('click', () => {
  fillSettingsForm(snapshot?.config?.proxy);
  els.settingsDialog.showModal();
});

els.openActivityLog.addEventListener('click', () => {
  activityLogDialogOpen = true;
  lastActivityLogKey = activityLogKey(snapshot?.activityLog);
  renderActivityLog(snapshot?.activityLog);
  els.activityLogDialog.showModal();
});

els.activityLogClose.addEventListener('click', () => {
  activityLogDialogOpen = false;
  els.activityLogDialog.close();
});

els.activityLogDialog.addEventListener('close', () => {
  activityLogDialogOpen = false;
});

els.settingsCancel.addEventListener('click', () => els.settingsDialog.close());

els.settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const host = els.proxyHost.value.trim();
  const port = els.proxyPort.value.trim();
  const login = els.proxyLogin.value.trim();
  const pass = els.proxyPass.value;

  if ((host && !port) || (!host && port)) {
    alert('Укажите и IP, и порт прокси, либо оставьте оба поля пустыми');
    return;
  }

  if (port) {
    const portNum = Number(port);
    if (!Number.isFinite(portNum) || portNum < 1 || portNum > 65535) {
      alert('Порт должен быть от 1 до 65535');
      return;
    }
  }

  try {
    await api('/api/config', {
      proxy: { host, port, login, pass }
    });
    els.settingsDialog.close();
  } catch (error) {
    alert(error.message);
  }
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
