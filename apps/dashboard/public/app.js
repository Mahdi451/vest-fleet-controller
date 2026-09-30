/* global document, fetch, window, localStorage, setInterval, setTimeout, clearTimeout, AbortController, performance */
const $ = (id) => document.getElementById(id);
const STORAGE = 'fleet-simulation-command-v1';
let state, preview, token, sessionId, command;
let side = 'LONG',
  busy = false,
  polling = false,
  connected = false,
  uncertain = false;
let uiVersion = 0,
  evidenceReceivedAt = 0;
const selected = new Set([
  '01',
  '02',
  '03',
  '04',
  '05',
  '06',
  '07',
  '08',
  '09',
  '10',
]);
const money = (v) =>
  Number(v).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const number = (v) =>
  Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
const message = (text) => {
  $('message').textContent = text;
};
const terminal = (c) => ['COMPLETE', 'REJECTED', 'EXPIRED'].includes(c?.status);
function readCommand() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE) || 'null');
  } catch {
    return null;
  }
}
function saveCommand(c) {
  // Persist identity before POST. This is a status reference, never a delivery queue.
  localStorage.setItem(STORAGE, JSON.stringify(c));
}
function belongs(c) {
  return (
    c &&
    state?.identity &&
    c.ownerId === state.identity.ownerId &&
    c.instanceId === state.identity.instanceId
  );
}
function evidenceFresh() {
  return (
    connected &&
    state?.freshness?.fresh &&
    state.freshness.ageMs + performance.now() - evidenceReceivedAt <
      state.freshness.maxAgeMs
  );
}
async function api(path, data) {
  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(),
    data === undefined ? 5000 : 15000,
  );
  let response, result;
  try {
    response = await fetch(
      `/api/${path}`,
      data === undefined
        ? { cache: 'no-store', signal: controller.signal }
        : {
            signal: controller.signal,
            method: 'POST',
            cache: 'no-store',
            headers: {
              'Content-Type': 'application/json',
              'X-Session-Token': token || '',
            },
            body: JSON.stringify(data),
          },
    );
    result = await response.json();
  } finally {
    clearTimeout(deadline);
  }
  if (!response.ok) {
    if (response.status === 401) {
      connected = false;
      $('login-panel').hidden = false;
      $('logout').hidden = true;
    }
    const error = new Error(result.error || 'REQUEST_FAILED');
    error.status = response.status;
    throw error;
  }
  return result;
}
function intent() {
  return {
    symbol: 'NDX',
    entryType: 'MARKET',
    side,
    leverage: $('leverage').value,
    riskMode: $('mode').value,
    riskValue: $('risk').value,
    stopDistancePoints: $('stop').value,
    takeProfitPoints: $('target').value,
  };
}
function invalidate() {
  preview = null;
  if (!uncertain && command?.status === 'PREVIEWED') command = null;
  render();
}
function controls() {
  const fresh =
    preview &&
    Date.now() - preview.createdAt < state?.config.maxPreviewAgeMs &&
    Date.now() < command?.expiresAt;
  const approved = fresh && preview.orders.some((o) => o.approved);
  const pending =
    uncertain ||
    (command && !terminal(command) && command.status !== 'PREVIEWED');
  const blocked =
    busy || pending || !approved || state?.halted || !evidenceFresh();
  $('long').disabled = !!blocked || side !== 'LONG';
  $('short').disabled = !!blocked || side !== 'SHORT';
  $('preview').disabled = busy || pending || !connected || state?.halted;
  $('confirm-submit').disabled = !!blocked;
  $('expiry').textContent = !connected
    ? 'Controller unreachable. Entries blocked; no command is queued for later delivery.'
    : pending
      ? 'Command pending or UNKNOWN. Recover its existing status; no new entry is allowed.'
      : !evidenceFresh()
        ? 'Controller reachable, but account evidence is stale. Refresh preview; entries remain blocked until verified.'
        : state?.halted
          ? 'Entries HALTED. Reconcile and review recovery before explicitly starting a new simulation.'
          : fresh && !approved
            ? 'No accounts approved. Review the rejection reasons.'
            : fresh
              ? `Preview expires in ${Math.max(0, Math.ceil((Math.min(preview.createdAt + state.config.maxPreviewAgeMs, command.expiresAt) - Date.now()) / 1000))}s. Review risk before confirming ${side}.`
              : 'Preview expired or changed. Refresh before entry.';
  $('connection').textContent = connected
    ? `Controller reachable · ${state?.health?.state || 'DEGRADED'}`
    : 'Controller unreachable · entries blocked';
  const verified = state?.freshness?.verifiedAt;
  $('freshness').textContent = verified
    ? `Evidence ${evidenceFresh() ? 'FRESH' : 'STALE'} · verified ${Math.max(0, Math.floor((Date.now() - verified) / 1000))}s ago (${new Date(verified).toLocaleTimeString()})`
    : 'Evidence not verified';
  $('command-status').textContent = command
    ? `Command ${uncertain ? 'UNKNOWN — querying existing identity' : command.status} · ${command.id}`
    : 'No pending command';
}
function cell(row, label, value, small, className) {
  const td = document.createElement('td'),
    text = document.createElement('strong');
  td.dataset.label = label;
  text.textContent = value;
  td.append(text);
  if (className) text.className = className;
  if (small) {
    const sub = document.createElement('small');
    sub.textContent = small;
    td.append(sub);
  }
  row.append(td);
  return td;
}
function render() {
  if (!state) {
    controls();
    return;
  }
  $('quote').textContent = number(state.quote.price);
  $('equity').textContent = money(
    state.accounts.reduce((n, a) => n + Number(a.equity), 0),
  );
  $('drawdown').textContent = money(
    state.accounts.reduce((n, a) => n + Number(a.remainingDrawdown), 0),
  );
  $('positions').textContent =
    state.accounts.reduce((n, a) => n + a.positions.length, 0) + ' / 10';
  $('circuit').textContent = state.halted
    ? 'HALTED · flatten available'
    : 'Entry checks active';
  $('instance').textContent = state.identity
    ? `Owner ${state.identity.ownerId} · Execution instance ${state.identity.instanceId}`
    : 'Local simulation';
  $('selection').textContent =
    `${selected.size} accounts selected · reserve ${money(state.config.minimumRemainingDrawdownAfterStop)} each`;
  const orders = preview?.orders || [];
  for (const [id, key] of [
    ['loss', 'totalPlannedLoss'],
    ['notional', 'notional'],
    ['margin', 'marginRequired'],
  ])
    $(id).textContent = preview
      ? money(orders.reduce((n, o) => n + Number(o[key]), 0))
      : '—';
  $('trade-preview').textContent = preview
    ? `Planned loss ${$('loss').textContent} · Notional ${$('notional').textContent} · Margin ${$('margin').textContent}. ${orders.filter((o) => o.approved).length}/${orders.length} approved. Account risk details are on Accounts.`
    : 'Risk preview not loaded';
  $('preview-status').textContent = preview
    ? `${orders.filter((o) => o.approved).length} / ${orders.length} APPROVED`
    : 'AWAITING PREVIEW';
  $('accounts').replaceChildren();
  for (const a of state.accounts) {
    const row = document.createElement('tr'),
      td = document.createElement('td'),
      check = document.createElement('input');
    td.dataset.label = 'Use';
    check.type = 'checkbox';
    check.checked = selected.has(a.accountId);
    check.disabled = busy || uncertain;
    check.setAttribute('aria-label', `Select ${a.label}`);
    check.addEventListener('change', () => {
      if (check.checked) selected.add(a.accountId);
      else selected.delete(a.accountId);
      invalidate();
    });
    td.append(check);
    row.append(td);
    cell(row, 'Account', a.label, a.enabled ? 'ENABLED' : 'DISABLED');
    cell(
      row,
      'Equity / floor',
      money(a.equity),
      `Floor ${money(a.drawdown.floor)}`,
    );
    cell(row, 'DD buffer', money(a.remainingDrawdown), a.status, 'ok');
    const o = orders.find((o) => o.accountId === a.accountId);
    cell(
      row,
      'Planned loss',
      o ? money(o.totalPlannedLoss) : '—',
      o ? 'Costs included' : '',
    );
    cell(
      row,
      'Notional',
      o ? money(o.notional) : '—',
      o ? `${Number(o.quantity).toFixed(5)} $/pt` : '',
    );
    cell(
      row,
      'After stop',
      o ? money(o.remainingAfterStop) : '—',
      o ? `${money(o.marginRequired)} margin` : '',
    );
    const p = a.positions[0];
    cell(
      row,
      'Position / protection',
      p
        ? `${p.side} · ${p.leverage}x · ${p.protectionStatus === 'ACTIVE' ? 'PROTECTED' : 'UNKNOWN'}`
        : o
          ? o.approved
            ? 'READY'
            : 'REJECTED'
          : 'FLAT',
      p
        ? `Entry ${number(p.entryPrice)} · Protection ${p.protectionStatus}`
        : o && !o.approved
          ? o.reasons.join(', ')
          : '',
      p
        ? p.protectionStatus === 'ACTIVE'
          ? 'ok'
          : 'bad'
        : o && !o.approved
          ? 'bad'
          : 'muted',
    );
    $('accounts').append(row);
  }
  $('activity').replaceChildren();
  const results = command?.results || [];
  for (const event of [
    ...state.events.slice(-20).reverse(),
    ...results.map((r) => ({
      status: r.state || r.status,
      accountId: r.accountId,
      timestamp: command.createdAt,
    })),
  ]) {
    const line = document.createElement('div'),
      label = document.createElement('span'),
      time = document.createElement('span');
    label.textContent = `${event.status}${event.accountId ? ' · ' + event.accountId : ''}`;
    label.className = ['UNKNOWN', 'HALTED', 'REJECTED'].includes(event.status)
      ? 'bad'
      : event.status === 'PROTECTED'
        ? 'ok'
        : '';
    time.textContent = new Date(event.timestamp).toLocaleTimeString();
    line.append(label, time);
    $('activity').append(line);
  }
  if (!$('activity').children.length)
    $('activity').textContent = 'No activity yet.';
  controls();
}
async function recoverCommand() {
  let saved = readCommand();
  if (saved?.sessionId !== sessionId && terminal(saved)) saved = null;
  if (command?.sessionId !== sessionId && terminal(command)) command = null;
  const active = state?.commands?.find(
    (c) => !terminal(c) && c.status !== 'PREVIEWED',
  );
  if (active) command = active;
  else if (
    belongs(saved) &&
    (!command ||
      command.id === saved.id ||
      (!terminal(saved) && saved.status !== 'PREVIEWED'))
  )
    command = saved;
  if (!command || command.status === 'PREVIEWED') return;
  if (!belongs(command)) {
    command = null;
    uncertain = false;
    return;
  }
  try {
    const result = await api(`commands/${encodeURIComponent(command.id)}`);
    const awaitingAcceptance =
      !terminal(command) && command.status !== 'PREVIEWED';
    if (
      result.command.status === 'PREVIEWED' &&
      awaitingAcceptance &&
      Date.now() < result.command.expiresAt
    ) {
      // The original POST may still be in transit; this read cannot authorize a second intent.
      uncertain = true;
      return;
    }
    command = result.command;
    saveCommand(command);
    uncertain = command.status === 'UNKNOWN';
    if (terminal(command)) preview = null;
  } catch {
    uncertain = true;
  }
}
async function refresh() {
  const previous = sessionId;
  const next = await api('state');
  state = next;
  evidenceReceivedAt = performance.now();
  token = next.token;
  sessionId = next.sessionId;
  connected = true;
  $('login-panel').hidden = true;
  $('logout').hidden = !next.identity?.authenticated;
  if (previous && previous !== sessionId) preview = null;
  await recoverCommand();
  render();
}
async function action(fn) {
  if (busy) return;
  uiVersion++;
  busy = true;
  render();
  try {
    await fn();
  } catch (error) {
    message(error.message);
  } finally {
    busy = false;
    await refresh().catch(() => {
      connected = false;
    });
    controls();
  }
}
async function makePreview() {
  preview = null;
  command = null;
  controls();
  const result = await api('preview', {
    intent: intent(),
    selected: [...selected],
  });
  preview = result.preview;
  sessionId = result.sessionId;
  command = result.command;
  message(
    `SIMULATION preview: ${preview.orders.filter((o) => o.approved).length}/${preview.orders.length} accounts approved. Review planned loss and remaining buffer on Accounts.`,
  );
}
$('preview').onclick = () => action(makePreview);
for (const button of document.querySelectorAll('[data-side]'))
  button.onclick = () => {
    if (busy || uncertain) return;
    side = button.dataset.side;
    for (const b of document.querySelectorAll('[data-side]'))
      b.classList.toggle('active', b === button);
    invalidate();
  };
for (const id of ['leverage', 'mode', 'risk', 'stop', 'target'])
  $(id).addEventListener('input', () => {
    invalidate();
    const mode = $('mode').value;
    $('risk-unit').textContent =
      mode === 'MARGIN_PERCENT'
        ? '% equity as margin'
        : mode === 'PERCENT_DRAWDOWN'
          ? '% drawdown / account'
          : mode === 'FIXED_DOLLAR'
            ? '$ loss / account'
            : '$ notional / account';
    $('risk-suffix').textContent = [
      'MARGIN_PERCENT',
      'PERCENT_DRAWDOWN',
    ].includes(mode)
      ? '%'
      : '$';
  });
for (const button of document.querySelectorAll('[data-risk]'))
  button.onclick = () => {
    if (busy || uncertain) return;
    $('leverage').value = button.dataset.leverage;
    $('risk').value = button.dataset.risk;
    $('mode').value = 'MARGIN_PERCENT';
    $('risk-unit').textContent = '% equity as margin';
    $('risk-suffix').textContent = '%';
    invalidate();
    void action(makePreview);
  };
function confirmEntry() {
  controls();
  if ($('long').disabled && $('short').disabled) return;
  $('confirm-details').textContent =
    `${side} · ${$('leverage').value}x · ${preview.orders.filter((o) => o.approved).length} accounts · planned loss ${$('loss').textContent}.`;
  $('confirm-entry').showModal();
}
async function execute() {
  if (
    !preview ||
    !command ||
    !evidenceFresh() ||
    Date.now() >= command.expiresAt ||
    Date.now() - preview.createdAt >= state.config.maxPreviewAgeMs
  ) {
    invalidate();
    throw new Error('Evidence or preview expired. Refresh first.');
  }
  const other = readCommand();
  if (belongs(other) && !terminal(other) && other.id !== command.id) {
    command = other;
    uncertain = true;
    throw new Error(
      'Another tab has a command pending. Recover its existing status.',
    );
  }
  // Failure to persist must prevent the first possible execution side effect.
  command = { ...command, status: 'PENDING' };
  saveCommand(command);
  uncertain = true;
  render();
  try {
    const result = await api('execute', {
      commandId: command.id,
      payloadHash: command.payloadHash,
    });
    command = result.command || {
      ...command,
      status: 'COMPLETE',
      results: result.results,
    };
    saveCommand(command);
    uncertain = command.status === 'UNKNOWN';
    preview = null;
    message(
      `Execution: ${(command.results || result.results || []).map((r) => `${r.accountId} ${r.state || r.status}${r.error ? ' (' + r.error + ')' : ''}`).join(' · ')}`,
    );
  } catch (error) {
    preview = null;
    message(
      `UNKNOWN command outcome. Querying existing command; no resend. ${error.message}`,
    );
  }
}
$('long').onclick = confirmEntry;
$('short').onclick = confirmEntry;
$('confirm-entry').addEventListener('close', () => {
  if ($('confirm-entry').returnValue === 'execute') void action(execute);
});
$('flatten').onclick = async () => {
  uiVersion++;
  $('flatten').disabled = true;
  preview = null;
  try {
    const result = await api('flatten', {});
    state = result.state;
    message(
      `FLATTEN: ${result.results.map((r) => `${r.accountId} ${r.status}`).join(' · ')}. Entries HALTED.`,
    );
  } catch (error) {
    message(
      `Flatten not confirmed: ${error.message}. Restore communication, then inspect and reconcile.`,
    );
  } finally {
    $('flatten').disabled = false;
    await refresh().catch(() => {
      connected = false;
      controls();
    });
  }
};
async function move(price) {
  const result = await api('price', { price: String(price) });
  state = result.state;
  $('price').value = state.quote.price;
  invalidate();
  message('Synthetic price updated. Stop and target checks applied.');
}
$('apply').onclick = () => action(() => move($('price').value));
$('down').onclick = () => action(() => move(Number(state.quote.price) - 80));
$('up').onclick = () => action(() => move(Number(state.quote.price) + 80));
$('reconcile').onclick = () =>
  action(async () => {
    const result = await api('reconcile', {});
    state = result.state;
    message(
      `Reconciliation: ${state.health.state}. ${state.health.issues.map((i) => i.accountId + ' ' + i.code).join(' · ') || 'Books checked.'} Reconciliation does not re-arm halted entries.`,
    );
  });
$('reset').onclick = () => {
  if (
    uncertain ||
    (command && !terminal(command) && command.status !== 'PREVIEWED')
  ) {
    message(
      'Resolve the pending or UNKNOWN command before starting a new simulation.',
    );
    return;
  }
  if (
    window.confirm(
      'Start a new simulation? Current simulated positions and balances will be discarded; durable audit logs stay on disk.',
    )
  )
    void action(async () => {
      await api('reset', { confirm: 'RESET_SIMULATION' });
      uncertain = false;
      command = null;
      localStorage.removeItem(STORAGE);
      invalidate();
      await refresh();
      $('price').value = state.quote.price;
      message('New SIMULATION started. Starting balances restored.');
    });
};
$('login-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void action(async () => {
    try {
      await api('login', { secret: $('login-secret').value });
      $('login-secret').value = '';
      await refresh();
      $('logout').hidden = false;
      $('login-message').textContent = '';
    } catch (error) {
      $('login-message').textContent = error.message;
    }
  });
});
$('logout').onclick = () =>
  action(async () => {
    await api('logout', {});
    connected = false;
    preview = null;
    state = null;
    token = null;
    $('login-panel').hidden = false;
    $('logout').hidden = true;
    message(
      'Signed out. Pending commands remain owned by the host; sign in to query their status.',
    );
  });
function showScreen(screen) {
  for (const button of document.querySelectorAll('[data-screen]')) {
    if (button.dataset.screen === screen)
      button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  for (const view of document.querySelectorAll('[data-view]'))
    view.classList.toggle('phone-active', view.dataset.view === screen);
}
for (const button of document.querySelectorAll('[data-screen]'))
  button.onclick = () => showScreen(button.dataset.screen);
showScreen('trade');
window.addEventListener('storage', (event) => {
  if (event.key === STORAGE) {
    const saved = readCommand();
    if (belongs(saved)) {
      command = saved;
      uncertain = !terminal(saved);
      preview = null;
      render();
    }
    void refresh().catch(() => {
      connected = false;
      controls();
    });
  }
});
window.addEventListener('pageshow', () => {
  preview = null;
  connected = false;
  controls();
  void refresh().catch(() => {
    connected = false;
    controls();
  });
});
window.addEventListener('offline', () => {
  connected = false;
  preview = null;
  controls();
});
window.addEventListener('online', () => {
  void refresh().catch(() => {
    connected = false;
    controls();
  });
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    preview = null;
    connected = false;
    controls();
    void refresh().catch(() => {
      connected = false;
      controls();
    });
  }
});
setInterval(async () => {
  if (busy || polling) return;
  polling = true;
  const version = uiVersion;
  try {
    if (version === uiVersion) await refresh();
  } catch {
    if (!busy && version === uiVersion) {
      connected = false;
      preview = null;
      controls();
    }
  } finally {
    polling = false;
  }
}, 2000);
setInterval(controls, 250);
refresh()
  .then(() =>
    message(
      'Choose exposure and refresh the preview. All actions are SIMULATION ONLY.',
    ),
  )
  .catch(() => {
    connected = false;
    controls();
    message(
      'Cannot connect or authentication is required. Start your simulation host or sign in.',
    );
  });
