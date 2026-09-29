/* global document, fetch, window, crypto, setInterval */
const $ = (id) => document.getElementById(id);
let state,
  preview,
  token,
  sessionId,
  tradeId,
  side = 'LONG',
  busy = false,
  uncertain = false;
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
async function api(path, data) {
  const response = await fetch(
    `/api/${path}`,
    data === undefined
      ? {}
      : {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Session-Token': token,
          },
          body: JSON.stringify(data),
        },
  );
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'REQUEST_FAILED');
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
  tradeId = null;
  render();
}
function controls() {
  const fresh =
    preview && Date.now() - preview.createdAt < state.config.maxPreviewAgeMs;
  const approved = fresh && preview.orders.some((o) => o.approved);
  const blocked = busy || !approved || state?.halted || uncertain;
  $('long').disabled = !!blocked || side !== 'LONG';
  $('short').disabled = !!blocked || side !== 'SHORT';
  $('preview').disabled = busy || uncertain;
  $('expiry').textContent = uncertain
    ? 'Execution response lost. Use FLATTEN ALL or inspect the activity before starting a new simulation.'
    : state?.halted
      ? 'Entries halted. Start a new simulation to reset the fleet.'
      : fresh && !approved
        ? 'No accounts approved. Review the rejection reasons before changing your inputs.'
        : fresh
          ? `Preview valid for ${Math.max(0, Math.ceil((state.config.maxPreviewAgeMs - (Date.now() - preview.createdAt)) / 1000))}s. Click ${side} to execute approved accounts.`
          : 'Preview expired or changed. Refresh before execution.';
}
function cell(row, value, small, className) {
  const td = document.createElement('td');
  const text = document.createElement('strong');
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
  if (!state) return;
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
    ? 'Entries halted · flatten remains available'
    : 'Entry checks active';
  $('connection').textContent = '● Local simulator connected';
  $('selection').textContent =
    `${selected.size} accounts selected · reserve ${money(state.config.minimumRemainingDrawdownAfterStop)} each`;
  const orders = preview?.orders ?? [];
  for (const [id, key] of [
    ['loss', 'totalPlannedLoss'],
    ['notional', 'notional'],
    ['margin', 'marginRequired'],
  ])
    $(id).textContent = preview
      ? money(orders.reduce((n, o) => n + Number(o[key]), 0))
      : '—';
  $('preview-status').textContent = preview
    ? `${orders.filter((o) => o.approved).length} / ${orders.length} APPROVED`
    : 'AWAITING PREVIEW';
  $('accounts').replaceChildren();
  for (const a of state.accounts) {
    const row = document.createElement('tr'),
      td = document.createElement('td'),
      check = document.createElement('input');
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
    cell(row, a.label, a.enabled ? 'ENABLED' : 'DISABLED');
    cell(row, money(a.equity), `Floor ${money(a.drawdown.floor)}`);
    cell(row, money(a.remainingDrawdown), a.status, 'ok');
    const o = orders.find((o) => o.accountId === a.accountId);
    cell(row, o ? money(o.totalPlannedLoss) : '—', o ? 'Costs included' : '');
    cell(
      row,
      o ? money(o.notional) : '—',
      o ? `${Number(o.quantity).toFixed(5)} $/pt` : '',
    );
    cell(
      row,
      o ? money(o.remainingAfterStop) : '—',
      o ? `${money(o.marginRequired)} margin` : '',
    );
    const p = a.positions[0];
    cell(
      row,
      p
        ? `${p.side} · ${p.leverage}x`
        : o
          ? o.approved
            ? 'READY'
            : 'BLOCKED'
          : 'FLAT',
      p
        ? `Entry ${number(p.entryPrice)} · Protection ${p.protectionStatus}`
        : o && !o.approved
          ? o.reasons.includes('DRAWDOWN_RESERVE')
            ? 'Below drawdown reserve'
            : o.reasons.join(', ')
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
  for (const event of state.events.slice(-4).reverse()) {
    const line = document.createElement('div'),
      label = document.createElement('span'),
      time = document.createElement('span');
    label.textContent = `${event.status}${event.accountId ? ' · ' + event.accountId : ''}`;
    time.textContent = new Date(event.timestamp).toLocaleTimeString();
    line.append(label, time);
    $('activity').append(line);
  }
  controls();
}
async function refresh() {
  const previous = sessionId;
  state = await api('state');
  token = state.token;
  sessionId = state.sessionId;
  if (previous && previous !== sessionId) {
    preview = null;
    tradeId = null;
    uncertain = false;
  }
  render();
}
async function action(fn) {
  if (busy) return;
  busy = true;
  render();
  try {
    await fn();
  } catch (error) {
    message(error.message);
  } finally {
    busy = false;
    await refresh().catch(() => {
      $('connection').textContent = 'Disconnected';
    });
    controls();
  }
}
async function makePreview() {
  preview = null;
  tradeId = null;
  controls();
  const result = await api('preview', {
    intent: intent(),
    selected: [...selected],
  });
  preview = result.preview;
  sessionId = result.sessionId;
  tradeId = crypto.randomUUID();
  message(
    `Preview: ${preview.orders.filter((o) => o.approved).length}/${preview.orders.length} accounts approved. ${side}, ${$('leverage').value}x. Only approved accounts will execute. Review planned loss and remaining buffer below.`,
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
async function execute() {
  if (
    !preview ||
    !tradeId ||
    Date.now() - preview.createdAt >= state.config.maxPreviewAgeMs
  ) {
    invalidate();
    throw new Error('Preview expired. Refresh first.');
  }
  const request = {
    masterTradeId: tradeId,
    previewId: preview.previewId,
    sessionId,
  };
  // Keep the same request ID through uncertainty; never synthesize a second trade automatically.
  try {
    const result = await api('execute', request);
    state = result.state;
    message(
      `Execution: ${result.results.map((r) => `${r.accountId} ${r.state}${r.error ? ' (' + r.error + ')' : ''}`).join(' · ')}`,
    );
    preview = null;
    tradeId = null;
  } catch (error) {
    uncertain = true;
    preview = null;
    throw error;
  }
}
$('long').onclick = () => action(execute);
$('short').onclick = () => action(execute);
$('flatten').onclick = async () => {
  $('flatten').disabled = true;
  preview = null;
  try {
    const result = await api('flatten', {});
    state = result.state;
    uncertain = result.results.some((r) => r.status === 'UNKNOWN');
    message(
      `FLATTEN: ${result.results.map((r) => `${r.accountId} ${r.status}`).join(' · ')}. Entries halted.`,
    );
  } catch (error) {
    uncertain = true;
    message(
      `Flatten not confirmed: ${error.message}. Click FLATTEN ALL to retry.`,
    );
  } finally {
    $('flatten').disabled = false;
    await refresh().catch(() => {});
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
$('reset').onclick = () => {
  if (
    window.confirm(
      'Reset the simulation to the initial ten accounts? Current simulated positions and balances will be discarded; audit logs stay on disk.',
    )
  )
    void action(async () => {
      await api('reset', { confirm: 'RESET_SIMULATION' });
      uncertain = false;
      invalidate();
      await refresh();
      $('price').value = state.quote.price;
      message('New simulation started. Starting balances restored.');
    });
};
setInterval(() => {
  if (state) controls();
}, 250);
refresh()
  .then(() =>
    message(
      'Choose a preset or refresh the preview. No action places a live trade.',
    ),
  )
  .catch(() => {
    $('connection').textContent = 'Disconnected';
    message(
      'Cannot connect to local simulator. Start pnpm dashboard and reload.',
    );
  });
