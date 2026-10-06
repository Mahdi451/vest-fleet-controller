/* global document, fetch, setInterval, crypto */
const byId = (id) => document.getElementById(id);
let state,
  token,
  sending = false,
  polling = false;
const message = (text) => {
  byId('message').textContent = text;
};
async function post(action, input) {
  const response = await fetch(`/api/copier/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Session-Token': token },
    body: JSON.stringify(input),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'REQUEST_FAILED');
  return result;
}
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function render() {
  byId('session').textContent =
    `Simulation ${state.session} · live remains LOCKED`;
  byId('entry').disabled = state.session !== 'ARMED' || sending;
  const entries = state.events.filter((event) => event.event.kind === 'ENTRY');
  const selected = byId('change-root').value;
  byId('change-root').replaceChildren(
    ...entries.map((event) => {
      const option = node(
        'option',
        `Entry ${event.event.sequence} · ${event.event.side}`,
      );
      option.value = event.eventId;
      return option;
    }),
  );
  if (entries.some((event) => event.eventId === selected))
    byId('change-root').value = selected;
  byId('change').disabled =
    state.session !== 'ARMED' || sending || !entries.length;
  byId('change-value').disabled = byId('change-kind').value === 'CLOSE';
  renderChanges();
  const list = byId('events');
  list.replaceChildren();
  if (!entries.length) {
    list.append(node('p', 'No leader events yet.'));
    return;
  }
  for (const event of entries) {
    const card = node('article', undefined, 'event'),
      title = node('div', undefined, 'event-title');
    title.append(
      node(
        'strong',
        `Leader ${event.event.side} · NDX · event ${event.event.sequence}`,
      ),
      node(
        'span',
        `${event.eventId.slice(0, 12)} · ${new Date(event.event.occurredAt).toLocaleTimeString()}`,
      ),
    );
    card.append(title);
    const table = node('table'),
      head = node('tr');
    for (const label of [
      'Account',
      'Intended',
      'Entry / fill',
      'Stop',
      'Target',
      'Exposure',
      'Reason',
      'Repair',
    ])
      head.append(node('th', label));
    const thead = node('thead');
    thead.append(head);
    table.append(thead);
    const body = node('tbody');
    for (const follower of event.followers) {
      const row = node('tr'),
        attempt = follower.attempt,
        outcome = attempt?.outcome;
      row.dataset.account = follower.accountId;
      const entry = node(
        'td',
        outcome ? `${outcome.submission} / ${outcome.fill}` : 'NOT ATTEMPTED',
      );
      if (outcome?.fillPrice)
        entry.append(node('small', `Fill ${outcome.fillPrice}`));
      row.append(
        node('td', follower.accountId),
        node(
          'td',
          follower.command
            ? `${follower.command.side} ${follower.command.quantity}`
            : `${event.event.side} —`,
        ),
        entry,
        node(
          'td',
          protectionLabel(outcome?.stop, outcome?.stopPrice),
          outcome?.stop === 'VERIFIED' ? 'good' : 'warn',
        ),
        node(
          'td',
          protectionLabel(outcome?.target, outcome?.targetPrice),
          outcome?.target === 'VERIFIED' ? 'good' : 'warn',
        ),
        node('td', outcome?.exposure || '—'),
        node(
          'td',
          follower.error ||
            (outcome?.reason === 'NONE' ? '—' : outcome?.reason) ||
            '—',
        ),
      );
      const actions = node('td');
      const add = (label, operation, enabled = true) => {
        const button = node('button', label, 'secondary');
        button.dataset.operation = operation;
        button.disabled = !enabled;
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            const result = await post('repair', {
              eventId: event.eventId,
              accountId: follower.accountId,
              operation,
              expectedAttemptId: attempt.attemptId,
            });
            message(
              result.result.repair?.state === 'UNKNOWN'
                ? 'Repair uncertain. Reconcile; no automatic resend.'
                : `${label}: ${result.result.repair?.state || 'observed'}`,
            );
          } catch (error) {
            message(error.message);
          }
          await refresh();
        });
        actions.append(button);
      };
      if (attempt) {
        add('Reconcile', 'RECONCILE');
        const currentRoot = state.ownedRoots.find(
          (root) =>
            root.entryEventId === event.eventId &&
            root.accountId === follower.accountId,
        );
        const owned =
          !currentRoot &&
          outcome.exposure === 'PRESENT' &&
          attempt.terminal?.result === 'FILLED';
        if (owned && outcome.stop !== 'VERIFIED')
          add('Add Stop', 'ADD_STOP', state.session === 'ARMED');
        if (owned && outcome.target !== 'VERIFIED')
          add('Add Target', 'ADD_TARGET', state.session === 'ARMED');
        if (owned) add('Flatten', 'FLATTEN', state.session === 'ARMED');
        if (
          ['NOT_SENT', 'REJECTED'].includes(attempt.terminal?.result) &&
          outcome.exposure === 'ABSENT'
        )
          add('Retry', 'RETRY', state.session === 'ARMED');
        add('Skip', 'SKIP', state.session === 'ARMED');
        if (currentRoot)
          actions.append(
            node(
              'small',
              'Use current exposure and change reconciliation below.',
            ),
          );
      }
      row.append(actions);
      body.append(row);
    }
    table.append(body);
    card.append(table);
    for (const domain of event.latency.clockDomains) {
      card.append(
        node(
          'p',
          `Fixture submit spread: ${domain.submitSpreadMs ?? 'unavailable'} ms · fastest fill: ${domain.fastest?.accountId ?? 'unavailable'} · slowest fill: ${domain.slowest?.accountId ?? 'unavailable'}`,
          'metrics',
        ),
      );
    }
    for (const metrics of event.latency.attempts)
      card.append(
        node(
          'p',
          `${metrics.accountId} · leader→submit ${metrics.leaderToSubmitMs ?? '—'} ms · leader→fill ${metrics.leaderToFillMs ?? '—'} ms · submit→fill ${metrics.submitToFillMs ?? '—'} ms · fill→protection ${metrics.fillToProtectionMs ?? '—'} ms`,
          'metrics',
        ),
      );
    list.append(card);
  }
}
function protectionLabel(status, price) {
  return `${status === 'PENDING' ? 'SUBMITTING' : status || '—'}${price && status !== 'NOT_REQUIRED' ? ` @ ${price}` : ''}`;
}
function renderChanges() {
  const roots = byId('owned-roots'),
    changes = byId('changes');
  roots.replaceChildren();
  changes.replaceChildren();
  if (!state.ownedRoots.length)
    roots.append(
      node(
        'p',
        'Exposure projections appear after the first leader change. Initial fills are shown below.',
      ),
    );
  for (const root of state.ownedRoots) {
    const card = node('article', undefined, 'event');
    card.dataset.rootAccount = root.accountId;
    card.append(
      node(
        'strong',
        `${root.accountId} · ${root.side} ${root.quantity} · ${root.closed ? 'CLOSED' : root.certainty}`,
      ),
      node(
        'p',
        `Basis ${root.basis ?? '—'} · stop ${root.closed ? 'NOT REQUIRED' : (root.stopPrice ?? 'MISSING')} · target ${root.closed ? 'NOT REQUIRED' : (root.targetPrice ?? 'MISSING')}`,
      ),
    );
    if (root.certainty === 'UNKNOWN')
      card.append(
        node(
          'p',
          'Exposure uncertain. Reconcile the change; no automatic resend.',
          'warn',
        ),
      );
    roots.append(card);
  }
  for (const activation of state.mutationActivations) {
    for (const accountId of activation.followerAccountIds) {
      if (
        state.mutations.some(
          (row) =>
            row.eventId === activation.eventId && row.accountId === accountId,
        )
      )
        continue;
      changes.append(
        node(
          'p',
          `${accountId} · event ${activation.eventId.slice(0, 12)} · NOT ATTEMPTED. Original event activation is replay-only; no catch-up submission.`,
          'warn',
        ),
      );
    }
  }
  if (!state.mutations.length && !state.mutationActivations.length)
    changes.append(node('p', 'No position or protection changes yet.'));
  for (const mutation of state.mutations) {
    const card = node('article', undefined, 'event');
    card.dataset.mutation = mutation.mutationId;
    card.append(
      node(
        'strong',
        `${mutation.accountId} · ${mutation.operation} · ${mutation.state === 'DISPATCHING' ? 'SUBMITTING' : mutation.state}`,
      ),
      node(
        'p',
        `Event ${mutation.sequence} · ${mutation.price ? `desired price ${mutation.price}` : mutation.deltaQuantity ? `quantity delta ${mutation.deltaQuantity}` : 'close owned position'} · ${mutation.reason ?? '—'}`,
      ),
      node(
        'p',
        `Fixture leader→submit ${mutation.leaderToSubmitMs ?? '—'} ms · leader→verified ${mutation.leaderToVerifiedMs ?? '—'} ms`,
        'metrics',
      ),
    );
    if (['UNKNOWN', 'DISPATCHING'].includes(mutation.state)) {
      const button = node('button', 'Reconcile change', 'secondary');
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const result = await post('change-reconcile', {
            mutationId: mutation.mutationId,
          });
          message(`Reconciliation: ${result.result.state}`);
        } catch (error) {
          message(error.message);
        }
        await refresh();
      });
      card.append(button);
    }
    changes.append(card);
  }
}
async function refresh() {
  if (polling) return;
  polling = true;
  try {
    const response = await fetch('/api/copier/state');
    if (!response.ok)
      throw new Error('Connection unavailable. Controls locked.');
    state = await response.json();
    token = state.token;
    render();
  } catch (error) {
    byId('entry').disabled = true;
    byId('change').disabled = true;
    message(error.message);
  } finally {
    polling = false;
  }
}
byId('arm').addEventListener('click', async () => {
  try {
    await post('arm', {
      followers: byId('followers')
        .value.split(',')
        .map((value) => value.trim()),
      maxLeverage: byId('leverage').value,
      maxNotional: byId('notional').value,
      maxPlannedLoss: byId('loss').value,
      durationMs: 300000,
    });
    message('Simulation armed. Live remains locked.');
  } catch (error) {
    message(error.message);
  }
  await refresh();
});
byId('lock').addEventListener('click', async () => {
  try {
    await post('lock', {});
    message('New entries locked.');
  } catch (error) {
    message(error.message);
  }
  await refresh();
});
byId('entry').addEventListener('click', async () => {
  if (sending || state?.session !== 'ARMED') return;
  sending = true;
  render();
  const request = {
    eventKey: crypto.randomUUID(),
    sequence: state.nextSequence,
    intent: {
      symbol: 'NDX',
      side: byId('side').value,
      entryType: 'MARKET',
      stopDistancePoints: byId('stop').value,
      takeProfitPoints: byId('target').value,
      riskMode: 'PERCENT_DRAWDOWN',
      riskValue: byId('risk').value,
      leverage: byId('leverage').value,
    },
  };
  try {
    await post('entry', request);
    message('Follower outcomes recorded. Inspect each account.');
  } catch (error) {
    message(
      `Entry requires inspection: ${error.message}. No automatic resend.`,
    );
  } finally {
    sending = false;
    await refresh();
  }
});
byId('scenario').addEventListener('click', async () => {
  try {
    await post('scenario', {
      accountId: byId('scenario-account').value,
      fault: byId('fault').value,
    });
    message('Fault set for the next synthetic follower entry.');
  } catch (error) {
    message(error.message);
  }
});
void refresh();
setInterval(refresh, 400);

byId('change-kind').addEventListener('change', () => {
  byId('change-value').value = ['ADD', 'REDUCE'].includes(
    byId('change-kind').value,
  )
    ? '0.25'
    : byId('change-kind').value === 'TARGET_CHANGED'
      ? '30500'
      : '30350';
  render();
});
byId('change').addEventListener('click', async () => {
  if (sending || state?.session !== 'ARMED') return;
  const kind = byId('change-kind').value;
  const request = {
    entryEventId: byId('change-root').value,
    eventKey: crypto.randomUUID(),
    sequence: state.nextSequence,
    kind,
    ...(kind === 'CLOSE'
      ? {}
      : ['ADD', 'REDUCE'].includes(kind)
        ? { quantity: byId('change-value').value }
        : { price: byId('change-value').value }),
  };
  sending = true;
  render();
  try {
    await post('change', request);
    message(
      'Leader change recorded. Inspect each follower and current exposure.',
    );
  } catch (error) {
    message(
      `Change requires inspection: ${error.message}. No automatic resend.`,
    );
  } finally {
    sending = false;
    await refresh();
  }
});
