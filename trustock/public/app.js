/* Trustock front end.
 *
 * Plain ES modules-free JavaScript, no build step: one script, a hash router,
 * and fetch. The whole point of the product is that the money workflow is
 * legible, so the UI is deliberately literal -- it shows the state machine,
 * the evidence behind a risk decision, and whether a transaction was real.
 */

const api = {
  token: localStorage.getItem('trustock.token') || null,
  user: JSON.parse(localStorage.getItem('trustock.user') || 'null'),

  async call(path, { method = 'GET', body } = {}) {
    const response = await fetch(`/api${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || `Request failed (${response.status})`);
      error.code = payload.code;
      error.details = payload.details;
      error.status = response.status;
      throw error;
    }
    return payload;
  },

  setSession(token, user) {
    this.token = token;
    this.user = user;
    localStorage.setItem('trustock.token', token);
    localStorage.setItem('trustock.user', JSON.stringify(user));
  },

  clearSession() {
    this.token = null;
    this.user = null;
    localStorage.removeItem('trustock.token');
    localStorage.removeItem('trustock.user');
  },
};

let integration = null;

// --- tiny helpers ---------------------------------------------------------

const $ = (selector) => document.querySelector(selector);
const view = () => $('#view');

/** Escapes anything that came from the database before it reaches innerHTML. */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function money(kobo) {
  const negative = kobo < 0;
  const abs = Math.abs(Number(kobo));
  const naira = Math.floor(abs / 100).toLocaleString('en-NG');
  const k = String(abs % 100).padStart(2, '0');
  return `${negative ? '-' : ''}₦${naira}.${k}`;
}

function when(value) {
  const date = new Date(value);
  const diff = (Date.now() - date) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return date.toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });
}

function deadlineText(value) {
  const ms = new Date(value) - Date.now();
  if (ms <= 0) return 'deadline passed';
  const days = Math.floor(ms / 86400000);
  if (days >= 1) return `${days} day${days === 1 ? '' : 's'} left`;
  return `${Math.max(1, Math.floor(ms / 3600000))}h left`;
}

const STATUS_PILL = {
  CREATED: 'pill-quiet', FUNDING: 'pill-info', MOQ_REACHED: 'pill-accent',
  RISK_REVIEW: 'pill-warn', APPROVED: 'pill-accent', REJECTED: 'pill-danger',
  SETTLEMENT: 'pill-info', COMPLETED: 'pill-accent', REFUNDING: 'pill-warn',
  REFUNDED: 'pill-quiet', EXPIRED: 'pill-quiet', CANCELLED: 'pill-quiet',
};

const statusPill = (status) =>
  `<span class="pill ${STATUS_PILL[status] || 'pill-quiet'}">${esc(status.replace(/_/g, ' '))}</span>`;

function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 5200);
}

async function busy(button, fn) {
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = '<span class="spinner"></span> Working…';
  try {
    return await fn();
  } catch (error) {
    toast(error.message, 'bad');
    throw error;
  } finally {
    button.disabled = false;
    button.innerHTML = original;
  }
}

// --- chrome ---------------------------------------------------------------

/**
 * Renders the mode banner. This is the first thing on every screen, because a
 * demo that quietly looks live is the one thing we said we would never build.
 */
function renderModeBanner() {
  const banner = $('#mode-banner');
  if (!integration) { banner.hidden = true; return; }

  const { simulated, notice } = integration.provider;
  banner.hidden = false;
  banner.className = `mode-banner ${simulated ? 'simulated' : 'live'}`;
  banner.textContent = simulated
    ? 'SIMULATED MODE — Ecobank credentials are not configured on this deployment. Every payment below is processed by Trustock\'s labelled simulator. No real money moves.'
    : notice;
}

function renderChrome() {
  const bar = $('#topbar');
  if (!api.user) { bar.hidden = true; return; }
  bar.hidden = false;
  $('#who-name').textContent = api.user.full_name;
  $('#who-role').textContent = api.user.role;
  const route = (location.hash || '#/pools').split('/')[1] || 'pools';
  document.querySelectorAll('[data-nav]').forEach((a) => {
    a.classList.toggle('active', a.dataset.nav === route);
  });
}

// --- auth screen ----------------------------------------------------------

const DEMO_ACCOUNTS = [
  ['ifeoma@trustock.demo', 'Ifeoma Eze', 'has not paid yet — pay as her'],
  ['amara@trustock.demo', 'Amara Okonkwo', 'pool organiser'],
  ['reviewer@trustock.demo', 'Ngozi Adeyemi', 'Trustock reviewer'],
];

function renderAuth(mode = 'login') {
  $('#topbar').hidden = true;
  view().innerHTML = `
    <div class="auth-wrap">
      <div class="auth">
        <div class="auth-brand">
          <div class="brand-mark">TS</div>
          <h1>Trustock</h1>
          <p>Pool your purchasing power. Protect your transaction.</p>
        </div>

        <div class="card">
          <div class="tabs">
            <button data-mode="login" class="${mode === 'login' ? 'active' : ''}">Sign in</button>
            <button data-mode="register" class="${mode === 'register' ? 'active' : ''}">Create account</button>
          </div>

          <div id="auth-error"></div>

          <form id="auth-form">
            ${mode === 'register' ? `
              <div class="field">
                <label for="full_name">Your name</label>
                <input id="full_name" name="full_name" required autocomplete="name" />
              </div>
              <div class="field">
                <label for="business_name">Business name</label>
                <input id="business_name" name="business_name" placeholder="Optional" autocomplete="organization" />
              </div>
              <div class="field">
                <label for="phone">Phone</label>
                <input id="phone" name="phone" placeholder="Optional" autocomplete="tel" />
              </div>` : ''}
            <div class="field">
              <label for="email">Email</label>
              <input id="email" name="email" type="email" required autocomplete="email" />
            </div>
            <div class="field">
              <label for="password">Password</label>
              <input id="password" name="password" type="password" required minlength="8"
                     autocomplete="${mode === 'register' ? 'new-password' : 'current-password'}" />
              ${mode === 'register' ? '<p class="hint">At least 8 characters.</p>' : ''}
            </div>
            <button class="btn btn-primary btn-block" type="submit">
              ${mode === 'register' ? 'Create account' : 'Sign in'}
            </button>
          </form>

          <details class="demo-accounts" ${mode === 'login' ? 'open' : ''}>
            <summary>Demo accounts (synthetic data — password: trustock123)</summary>
            ${DEMO_ACCOUNTS.map(([email, name, note]) => `
              <button class="demo-btn" data-email="${esc(email)}">
                <span>${esc(name)}<br /><em>${esc(email)}</em></span>
                <em>${esc(note)}</em>
              </button>`).join('')}
          </details>
        </div>
      </div>
    </div>`;

  view().querySelectorAll('.tabs button').forEach((button) => {
    button.onclick = () => renderAuth(button.dataset.mode);
  });

  view().querySelectorAll('.demo-btn').forEach((button) => {
    button.onclick = () => {
      $('#email').value = button.dataset.email;
      $('#password').value = 'trustock123';
      $('#password').focus();
    };
  });

  $('#auth-form').onsubmit = async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    const submit = event.target.querySelector('button[type=submit]');
    $('#auth-error').innerHTML = '';

    try {
      await busy(submit, async () => {
        const result = await api.call(`/auth/${mode}`, { method: 'POST', body: data });
        api.setSession(result.token, result.user);
      });
      location.hash = '#/pools';
      await boot();
    } catch (error) {
      $('#auth-error').innerHTML = `<div class="error">${esc(error.message)}</div>`;
    }
  };
}

// --- pool list ------------------------------------------------------------

const CLOSED_STATES = ['COMPLETED', 'REFUNDED', 'EXPIRED', 'CANCELLED'];

function poolCard(pool) {
  const f = pool.funding;
  return `
    <a class="card pool-card" href="#/pool/${pool.id}">
      <div class="card-head" style="margin-bottom:6px">
        <h2>${esc(pool.title)}</h2>
        ${statusPill(pool.status)}
      </div>
      <div class="pool-meta">
        <span class="ref">${esc(pool.reference)}</span>
        <span>•</span>
        <span>${esc(pool.supplier.name)}</span>
        <span class="pill ${pool.supplier.verification_status === 'verified' ? 'pill-accent' : 'pill-quiet'}">
          ${pool.supplier.verification_status === 'verified' ? 'verified' : 'external'}
        </span>
      </div>
      <div class="progress ${f.moq_reached ? 'full' : ''}"><span style="width:${f.percent_funded}%"></span></div>
      <div class="funding-line">
        <span><strong>${esc(f.funded_amount_display)}</strong>
              <span style="color:var(--faint)"> / ${esc(f.target_amount_display)}</span></span>
        <span class="pct">${f.percent_funded}%</span>
      </div>
      <div class="pool-meta" style="margin-top:10px">
        <span>${pool.member_count}/${pool.max_participants} members</span>
        <span>•</span>
        <span>${CLOSED_STATES.includes(pool.status)
          ? `closed ${esc(when(pool.updated_at))}`
          : esc(deadlineText(pool.deadline))}</span>
      </div>
    </a>`;
}

async function renderPools() {
  view().innerHTML = '<div class="empty">Loading pools…</div>';
  const { pools } = await api.call('/pools');

  const active = pools.filter((p) => !CLOSED_STATES.includes(p.status));
  const done = pools.filter((p) => CLOSED_STATES.includes(p.status));

  view().innerHTML = `
    <div class="page-head">
      <div class="grow">
        <h1>Pools</h1>
        <p>Combine your money with other buyers to reach a wholesale minimum order.</p>
      </div>
      <a class="btn btn-primary" href="#/new">Create a pool</a>
    </div>

    ${pools.length === 0 ? `
      <div class="card empty">
        <h2>No pools yet</h2>
        <p>Create one, invite the other buyers, and Trustock tracks the money from contribution to settlement.</p>
        <div style="margin-top:16px"><a class="btn btn-primary" href="#/new">Create the first pool</a></div>
      </div>` : ''}

    ${active.length ? `<div class="grid grid-2">${active.map(poolCard).join('')}</div>` : ''}
    ${done.length ? `
      <h2 style="margin:30px 0 14px;color:var(--muted);font-size:13px;text-transform:uppercase;letter-spacing:.06em">Closed</h2>
      <div class="grid grid-2">${done.map(poolCard).join('')}</div>` : ''}`;
}

// --- pool detail ----------------------------------------------------------

function evidenceBlock(signal) {
  const e = signal.evidence || {};

  // The account-change signal earns a purpose-built rendering: the whole
  // product exists for this one moment, so "was / now" should be unmissable.
  if (e.previous_account && e.current_account) {
    return `
      <div class="evidence">
        <div class="evidence-row"><b>was</b><span class="was">${esc(e.previous_account.account_name)} · ${esc(e.previous_account.account_number)} · ${esc(e.previous_account.bank_name)}</span></div>
        <div class="evidence-row"><b>now</b><span class="now">${esc(e.current_account.account_name)} · ${esc(e.current_account.account_number)} · ${esc(e.current_account.bank_name)}</span></div>
        <div class="evidence-row"><b>when</b><span>${esc(new Date(e.changed_at).toLocaleString('en-NG'))}</span></div>
      </div>`;
  }

  const entries = Object.entries(e).filter(([, v]) => v !== null && typeof v !== 'object');
  if (entries.length === 0) return '';
  return `<div class="evidence">${entries
    .map(([k, v]) => `<div class="evidence-row"><b>${esc(k.replace(/_/g, ' '))}</b><span>${esc(v)}</span></div>`)
    .join('')}</div>`;
}

function riskPanel(risk, pool, viewer, reviews) {
  if (!risk) {
    const canAssess = pool.status === 'MOQ_REACHED';
    return `
      <div class="card">
        <div class="card-head"><h2>Trust &amp; risk</h2></div>
        <p style="color:var(--muted);font-size:13px">
          ${canAssess
            ? 'The minimum order quantity has been funded. Run the assessment before any money leaves for the supplier.'
            : 'Trustock assesses the supplier and the transaction once the pool is fully funded.'}
        </p>
        ${canAssess ? '<div class="actions" style="margin-top:14px"><button class="btn btn-primary" id="assess">Run risk assessment</button></div>' : ''}
      </div>`;
  }

  const paused = pool.status === 'RISK_REVIEW';
  const decided = reviews && reviews[0];

  return `
    ${paused ? `
      <div class="paused">
        <div class="paused-icon">⏸</div>
        <div>
          <h3>Payout paused — review required</h3>
          <p>Trustock assessed this transaction as ${risk.level} risk and stopped it before settlement.
             Someone has to look at the evidence below and decide.</p>
        </div>
      </div>` : ''}
    ${pool.status === 'APPROVED' && risk.level === 'LOW' ? `
      <div class="paused approved">
        <div class="paused-icon">✓</div>
        <div>
          <h3>Cleared for settlement</h3>
          <p>Low risk (score ${risk.score}). Nothing was found that warrants holding this payout.</p>
        </div>
      </div>` : ''}

    <div class="card">
      <div class="card-head">
        <h2>Trust &amp; risk</h2>
        <span class="card-note">${esc(risk.engine_version)} · ${when(risk.created_at)}</span>
      </div>

      <div class="risk-head">
        <div class="risk-badge risk-${risk.level}">${risk.score}</div>
        <div>
          <div class="risk-level risk-${risk.level}" style="border:none;background:none">${risk.level} RISK</div>
          <div class="risk-sub">
            ${risk.signals.length} signal${risk.signals.length === 1 ? '' : 's'} raised ·
            ${(risk.checks_passed || []).length} check${(risk.checks_passed || []).length === 1 ? '' : 's'} clear ·
            score out of 100
          </div>
        </div>
      </div>

      ${risk.signals.length ? `
        <h3 style="margin:18px 0 2px;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em">What was found</h3>
        ${risk.signals.map((s) => `
          <div class="signal sev-${s.severity}">
            <div class="signal-weight">${s.weight > 0 ? '+' : ''}${s.weight}</div>
            <div class="signal-body">
              <div class="signal-label">${esc(s.label)}</div>
              <div class="signal-why">${esc(s.explanation)}</div>
              ${evidenceBlock(s)}
              <div class="signal-code">${esc(s.code)}</div>
            </div>
          </div>`).join('')}` : ''}

      ${(risk.checks_passed || []).length ? `
        <h3 style="margin:20px 0 10px;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em">What was checked and found sound</h3>
        <div class="checks">
          ${risk.checks_passed.map((c) => `
            <div class="check"><span class="tick">✓</span><span>${esc(c.label)}</span></div>`).join('')}
        </div>` : ''}

      ${(risk.data_quality?.limitations || []).length ? `
        <h3 style="margin:20px 0 8px;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em">What we could not check</h3>
        <div class="checks">
          ${risk.data_quality.limitations.map((l) => `
            <div class="check"><span class="tick" style="color:var(--faint)">–</span><span>${esc(l)}</span></div>`).join('')}
        </div>` : ''}

      <div class="disclaimer">${esc(risk.disclaimer)}</div>

      ${paused ? `
        <div style="margin-top:18px;padding-top:16px;border-top:1px solid var(--line-soft)">
          <h3 style="margin-bottom:8px">Your decision</h3>
          ${risk.level === 'HIGH' && !viewer.is_reviewer ? `
            <p style="color:var(--muted);font-size:12.8px;margin-bottom:12px">
              A HIGH risk payout cannot be approved by the pool organiser. A Trustock reviewer has to approve it.
              You can still reject it.
            </p>` : ''}
          <div class="field">
            <label for="review-notes">Notes (what did you check?)</label>
            <textarea id="review-notes" placeholder="e.g. Called the supplier on the number on file. They confirmed the account is not theirs."></textarea>
          </div>
          <div class="actions">
            <button class="btn btn-primary" id="approve" ${risk.level === 'HIGH' && !viewer.is_reviewer ? 'disabled' : ''}>
              Approve &amp; release
            </button>
            <button class="btn btn-danger" id="reject">Reject &amp; refund contributors</button>
            <button class="btn btn-ghost" id="reassess">Re-run assessment</button>
          </div>
        </div>` : ''}

      ${decided ? `
        <div style="margin-top:18px;padding-top:16px;border-top:1px solid var(--line-soft)">
          <h3 style="margin-bottom:6px">Review decision</h3>
          <div class="pool-meta">
            ${decided.decision === 'APPROVED' ? '<span class="pill pill-accent">approved</span>' : '<span class="pill pill-danger">rejected</span>'}
            <span>by ${esc(decided.reviewer_name)} (${esc(decided.reviewer_role)})</span>
            <span>•</span><span>${when(decided.created_at)}</span>
          </div>
          ${decided.notes ? `<p style="color:var(--muted);font-size:13px;margin-top:8px">“${esc(decided.notes)}”</p>` : ''}
        </div>` : ''}
    </div>`;
}

function settlementPanel(data) {
  const { pool, settlement, refunds, viewer } = data;
  const canAct = viewer.is_creator || viewer.is_reviewer;

  let action = '';
  if (pool.status === 'APPROVED' && canAct) {
    action = `<button class="btn btn-primary btn-block" id="settle">Release ${esc(pool.funding.funded_amount_display)} to ${esc(pool.supplier.name)}</button>`;
  } else if (['REJECTED', 'EXPIRED', 'CANCELLED', 'REFUNDING'].includes(pool.status) && canAct) {
    action = `<button class="btn btn-quiet btn-block" id="refund">Refund every contributor</button>`;
  }

  if (!settlement && !refunds.length && !action) return '';

  return `
    <div class="card">
      <div class="card-head">
        <h2>Settlement</h2>
        ${settlement ? statusPill(settlement.status) : ''}
      </div>

      ${settlement ? `
        <dl class="kv">
          <dt>Amount</dt><dd class="mono">${esc(settlement.amount_display)}</dd>
          <dt>Beneficiary</dt><dd>${esc(pool.supplier.account_name)}</dd>
          <dt>Account</dt><dd class="mono">${esc(pool.supplier.account_number)} · ${esc(pool.supplier.bank_name)}</dd>
          <dt>Provider ref</dt><dd class="mono">${esc(settlement.provider_reference || '—')}</dd>
          <dt>Mode</dt><dd>${settlement.simulated ? '<span class="sim-tag">SIMULATED</span>' : '<span class="pill pill-accent">live</span>'}</dd>
        </dl>` : ''}

      ${refunds.length ? `
        <h3 style="margin:${settlement ? '18px' : '0'} 0 8px;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em">Refunds</h3>
        <div class="rows">
          ${refunds.map((r) => `
            <div class="row row-members">
              <div>${esc(r.recipient_name)}<div class="row-sub">${esc(r.reason || '')}</div></div>
              <div class="num">${esc(r.amount_display)}</div>
              <div>${statusPill(r.status)}</div>
            </div>`).join('')}
        </div>` : ''}

      ${action ? `<div style="margin-top:${settlement || refunds.length ? '16px' : '0'}">${action}</div>` : ''}
    </div>`;
}

async function renderPool(id) {
  view().innerHTML = '<div class="empty">Loading pool…</div>';
  const data = await api.call(`/pools/${id}`);
  const { pool, members, contributions, risk_assessment: risk, reviews, timeline, viewer, audit_trail: trail } = data;
  const f = pool.funding;

  const canContribute = viewer.is_member && !viewer.has_paid &&
    ['CREATED', 'FUNDING'].includes(pool.status) && !f.moq_reached;
  const canJoin = !viewer.is_member && ['CREATED', 'FUNDING'].includes(pool.status) &&
    pool.member_count < pool.max_participants;

  view().innerHTML = `
    <div class="page-head">
      <div class="grow">
        <div class="pool-meta" style="margin-bottom:6px">
          <a href="#/pools" style="color:var(--muted)">← Pools</a>
          <span class="ref">${esc(pool.reference)}</span>
          ${statusPill(pool.status)}
        </div>
        <h1>${esc(pool.title)}</h1>
        ${pool.description ? `<p>${esc(pool.description)}</p>` : ''}
      </div>
    </div>

    <div class="split">
      <div>
        <div class="card">
          <div class="readout">
            <div class="amount">${esc(f.funded_amount_display)}<span class="of"> / ${esc(f.target_amount_display)}</span></div>
            <div class="sub">
              ${f.moq_reached
                ? '<span class="moq-hit">MOQ reached</span>'
                : `${esc(f.remaining_amount_display)} still needed · ${esc(deadlineText(pool.deadline))}`}
            </div>
          </div>
          <div class="progress ${f.moq_reached ? 'full' : ''}" style="margin-top:16px">
            <span style="width:${f.percent_funded}%"></span>
          </div>
          <div class="funding-line">
            <span style="color:var(--muted)">${pool.member_count} of ${pool.max_participants} members ·
              ${esc(pool.contribution_amount_display)} each</span>
            <span class="pct">${f.percent_funded}%</span>
          </div>

          ${canContribute || canJoin ? `
            <div class="actions" style="margin-top:18px">
              ${canJoin ? '<button class="btn btn-primary btn-block" id="join">Join this pool</button>' : ''}
              ${canContribute ? `<button class="btn btn-primary btn-block" id="contribute">
                  Pay my ${esc(money(Math.min(pool.contribution_amount_kobo, f.remaining_amount_kobo)))} share
                </button>` : ''}
            </div>` : ''}
          ${viewer.has_paid && !f.moq_reached
            ? '<p style="color:var(--muted);font-size:12.8px;text-align:center;margin-top:14px">Your share is paid. Waiting on the other members.</p>'
            : ''}
        </div>

        ${riskPanel(risk, pool, viewer, reviews)}
        ${settlementPanel(data)}

        <div class="card">
          <div class="card-head"><h2>Members</h2><span class="card-note">${members.length} joined</span></div>
          <div class="rows">
            ${members.map((m) => `
              <div class="row row-members">
                <div>${esc(m.full_name)}${m.user_id === (api.user && api.user.id) ? ' <span class="pill pill-quiet">you</span>' : ''}
                  <div class="row-sub">${esc(m.business_name || '')}</div></div>
                <div class="num">${esc(m.paid_amount_display)}</div>
                <div>${m.has_paid ? '<span class="pill pill-accent">paid</span>' : '<span class="pill pill-quiet">pending</span>'}</div>
              </div>`).join('')}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h2>Contributions</h2>
            <span class="card-note">every movement, with the mode it ran in</span></div>
          ${contributions.length === 0 ? '<p style="color:var(--muted);font-size:13px">Nothing paid in yet.</p>' : `
            <div class="rows">
              ${contributions.map((c) => `
                <div class="row row-tx">
                  <div>${statusPill(c.status)}</div>
                  <div>${esc(c.contributor_name)}
                    <div class="row-sub">${esc(c.provider_reference || 'no provider reference')} · ${when(c.created_at)}</div></div>
                  <div class="num">${esc(c.amount_display)}</div>
                  <div>${c.simulated ? '<span class="sim-tag">SIM</span>' : '<span class="pill pill-accent">live</span>'}</div>
                </div>`).join('')}
            </div>`}
        </div>
      </div>

      <div>
        <div class="card">
          <div class="card-head"><h2>Supplier</h2>
            <span class="pill ${pool.supplier.verification_status === 'verified' ? 'pill-accent' : 'pill-quiet'}">
              ${esc(pool.supplier.verification_status)}</span></div>
          <dl class="kv">
            <dt>Name</dt><dd>${esc(pool.supplier.name)}</dd>
            <dt>Account name</dt><dd>${esc(pool.supplier.account_name)}</dd>
            <dt>Account</dt><dd class="mono">${esc(pool.supplier.account_number)}</dd>
            <dt>Bank</dt><dd>${esc(pool.supplier.bank_name)}</dd>
          </dl>
          ${pool.supplier.verification_status === 'external' ? `
            <p style="color:var(--faint);font-size:12px;margin-top:12px">
              External supplier: these details were entered by a buyer and have not been
              independently verified by Trustock.
            </p>` : ''}
        </div>

        <div class="card">
          <div class="card-head"><h2>Lifecycle</h2></div>
          <div class="timeline">
            ${timeline.map((t, i) => `
              <div class="tl ${i === timeline.length - 1 ? '' : 'done'}">
                <div class="tl-dot"><i></i><span></span></div>
                <div class="tl-body">
                  <div class="tl-title">${esc(t.to_status.replace(/_/g, ' '))}</div>
                  <div class="tl-meta">${esc(t.reason || '')}${t.actor_name ? ` · ${esc(t.actor_name)}` : ''}</div>
                  <div class="tl-meta">${when(t.created_at)}</div>
                </div>
              </div>`).join('')}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h2>Audit trail</h2>
            <span class="card-note">${trail.length} entries</span></div>
          <div class="rows">
            ${trail.slice(-14).reverse().map((a) => `
              <div class="row" style="grid-template-columns:1fr auto">
                <div><span class="num" style="font-size:12px">${esc(a.action)}</span>
                  <div class="row-sub">${esc(a.actor_name || a.actor_type)}</div></div>
                <div class="row-sub">${when(a.created_at)}</div>
              </div>`).join('')}
          </div>
        </div>
      </div>
    </div>`;

  const reload = () => renderPool(id);

  const bind = (selector, handler) => {
    const el = $(selector);
    if (el) el.onclick = () => busy(el, handler).then(reload).catch(() => {});
  };

  bind('#join', () => api.call(`/pools/${id}/join`, { method: 'POST' })
    .then(() => toast('Joined. Pay your share when you are ready.', 'good')));

  bind('#contribute', async () => {
    // A stable key per member per pool: a double-click cannot double-charge.
    const key = `ui-${api.user.id}-${id}`;
    const result = await api.call(`/pools/${id}/contribute`, {
      method: 'POST', body: { idempotency_key: key },
    });
    toast(result.pool_status === 'MOQ_REACHED'
      ? 'Paid. The pool has reached its minimum order quantity.'
      : `Paid ${result.contribution.amount_display}.`, 'good');
  });

  bind('#assess', () => api.call(`/pools/${id}/risk-assessment`, { method: 'POST' })
    .then((r) => toast(`Assessment complete: ${r.assessment.level} risk (score ${r.assessment.score}).`,
      r.assessment.level === 'LOW' ? 'good' : 'bad')));

  bind('#reassess', () => api.call(`/pools/${id}/risk-assessment`, { method: 'POST' })
    .then((r) => toast(`Re-assessed: ${r.assessment.level} risk (score ${r.assessment.score}).`)));

  bind('#approve', () => api.call(`/pools/${id}/review`, {
    method: 'POST', body: { decision: 'APPROVED', notes: $('#review-notes').value },
  }).then(() => toast('Approved. The payout can now be released.', 'good')));

  bind('#reject', () => api.call(`/pools/${id}/review`, {
    method: 'POST', body: { decision: 'REJECTED', notes: $('#review-notes').value },
  }).then(() => toast('Rejected. Refund the contributors from the settlement panel.')));

  bind('#settle', () => api.call(`/pools/${id}/settle`, { method: 'POST' })
    .then((r) => toast(`Settlement ${r.settlement.status.toLowerCase()} — ${r.settlement.amount_display} to ${pool.supplier.name}.`, 'good')));

  bind('#refund', () => api.call(`/pools/${id}/refund`, { method: 'POST', body: {} })
    .then((r) => toast(`${r.refunds.length} refund(s) processed. Pool is ${r.pool_status}.`, 'good')));
}

// --- create pool ----------------------------------------------------------

async function renderCreate() {
  const { suppliers } = await api.call('/suppliers');
  const defaultDeadline = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 16);

  view().innerHTML = `
    <div class="page-head">
      <div class="grow">
        <h1>Create a pool</h1>
        <p>Set the wholesale target, the per-person share, and who you are buying from.</p>
      </div>
    </div>

    <div class="split">
      <form id="create-form" class="card">
        <div id="create-error"></div>

        <div class="field">
          <label for="title">What are you buying?</label>
          <input id="title" name="title" required placeholder="e.g. Vintage bale — grade A mixed" />
        </div>
        <div class="field">
          <label for="description">Details</label>
          <textarea id="description" name="description" placeholder="Optional. What the group is buying and why."></textarea>
        </div>

        <div class="field-row">
          <div class="field">
            <label for="target_amount">Wholesale target (₦)</label>
            <input id="target_amount" name="target_amount" required inputmode="decimal" placeholder="250000" />
          </div>
          <div class="field">
            <label for="contribution_amount">Each person pays (₦)</label>
            <input id="contribution_amount" name="contribution_amount" required inputmode="decimal" placeholder="50000" />
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label for="max_participants">Participants</label>
            <input id="max_participants" name="max_participants" type="number" min="2" max="50" value="5" required />
          </div>
          <div class="field">
            <label for="deadline">Funding deadline</label>
            <input id="deadline" name="deadline" type="datetime-local" value="${defaultDeadline}" required />
          </div>
        </div>
        <p class="hint" id="reach-hint" style="margin:-6px 0 16px"></p>

        <fieldset>
          <legend>Supplier</legend>
          <div class="field">
            <label for="supplier_id">Use a supplier already on file</label>
            <select id="supplier_id" name="supplier_id">
              <option value="">— enter a new supplier below —</option>
              ${suppliers.map((s) => `
                <option value="${esc(s.id)}">${esc(s.name)} · ${esc(s.account_number)} (${esc(s.bank_name)})</option>`).join('')}
            </select>
          </div>

          <div id="new-supplier">
            <div class="field">
              <label for="s_name">Supplier / wholesaler name</label>
              <input id="s_name" name="s_name" placeholder="e.g. ABC Wholesale Ltd" />
            </div>
            <div class="field-row">
              <div class="field">
                <label for="s_bank">Bank</label>
                <input id="s_bank" name="s_bank" placeholder="e.g. Ecobank Nigeria" />
              </div>
              <div class="field">
                <label for="s_account">Account number</label>
                <input id="s_account" name="s_account" inputmode="numeric" placeholder="10 digits" />
              </div>
            </div>
            <div class="field">
              <label for="s_account_name">Account name</label>
              <input id="s_account_name" name="s_account_name" placeholder="Exactly as it appears on the account" />
              <p class="hint">Trustock compares this with the supplier name during the risk assessment.</p>
            </div>
            <div class="field-row">
              <div class="field">
                <label for="s_phone">Supplier phone</label>
                <input id="s_phone" name="s_phone" placeholder="Optional but recommended" />
              </div>
              <div class="field">
                <label for="s_email">Supplier email</label>
                <input id="s_email" name="s_email" type="email" placeholder="Optional but recommended" />
              </div>
            </div>
          </div>
        </fieldset>

        <button class="btn btn-primary btn-block" type="submit">Create pool</button>
      </form>

      <div class="card">
        <div class="card-head"><h2>How this works</h2></div>
        <div class="timeline">
          ${[
            ['Pool', 'You set the target. Others join and commit their share.'],
            ['Pay', 'Each member pays through the Ecobank flow. Trustock tracks every kobo.'],
            ['Protect', 'At 100% funded, Trustock assesses the supplier and the transaction.'],
            ['Settle', 'Cleared transactions pay out. Flagged ones pause for a human.'],
          ].map(([title, body]) => `
            <div class="tl done">
              <div class="tl-dot"><i></i><span></span></div>
              <div class="tl-body"><div class="tl-title">${title}</div><div class="tl-meta">${body}</div></div>
            </div>`).join('')}
        </div>
        <p style="color:var(--faint);font-size:12px;margin-top:8px">
          Your supplier does not need a Trustock account. Bring the wholesaler you already deal with —
          they will be recorded as an external supplier.
        </p>
      </div>
    </div>`;

  const supplierSelect = $('#supplier_id');
  const newSupplier = $('#new-supplier');
  supplierSelect.onchange = () => { newSupplier.style.display = supplierSelect.value ? 'none' : ''; };

  // Live feedback on whether the pool can actually reach its own target.
  const hint = $('#reach-hint');
  const updateHint = () => {
    const target = Number($('#target_amount').value || 0);
    const share = Number($('#contribution_amount').value || 0);
    const people = Number($('#max_participants').value || 0);
    if (!target || !share || !people) { hint.textContent = ''; return; }
    const reachable = share * people;
    hint.style.color = reachable >= target ? 'var(--faint)' : 'var(--high)';
    hint.textContent = reachable >= target
      ? `${people} × ₦${share.toLocaleString()} = ₦${reachable.toLocaleString()} — enough to cover ₦${target.toLocaleString()}.`
      : `${people} × ₦${share.toLocaleString()} = ₦${reachable.toLocaleString()} — that cannot reach ₦${target.toLocaleString()}.`;
  };
  ['#target_amount', '#contribution_amount', '#max_participants']
    .forEach((sel) => { $(sel).oninput = updateHint; });

  $('#create-form').onsubmit = async (event) => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.target));
    $('#create-error').innerHTML = '';

    const body = {
      title: form.title,
      description: form.description || undefined,
      target_amount: form.target_amount,
      contribution_amount: form.contribution_amount,
      max_participants: Number(form.max_participants),
      deadline: new Date(form.deadline).toISOString(),
    };

    if (form.supplier_id) {
      body.supplier_id = form.supplier_id;
    } else {
      body.supplier = {
        name: form.s_name,
        bank_name: form.s_bank,
        account_number: form.s_account,
        account_name: form.s_account_name,
        phone: form.s_phone || undefined,
        email: form.s_email || undefined,
      };
    }

    try {
      const submit = event.target.querySelector('button[type=submit]');
      const result = await busy(submit, () => api.call('/pools', { method: 'POST', body }));
      toast('Pool created. Share the link with the other buyers.', 'good');
      location.hash = `#/pool/${result.pool.id}`;
    } catch (error) {
      $('#create-error').innerHTML = `<div class="error">${esc(error.message)}</div>`;
    }
  };
}

// --- history --------------------------------------------------------------

async function renderHistory() {
  view().innerHTML = '<div class="empty">Loading history…</div>';
  const { transactions } = await api.call('/transactions');

  view().innerHTML = `
    <div class="page-head">
      <div class="grow">
        <h1>Transaction history</h1>
        <p>Every movement on your account, and whether it was a live Ecobank transaction or a simulated one.</p>
      </div>
    </div>

    <div class="card">
      ${transactions.length === 0 ? '<div class="empty"><h2>Nothing yet</h2><p>Contributions, refunds and settlements show up here.</p></div>' : `
        <div class="rows">
          ${transactions.map((t) => `
            <div class="row row-tx">
              <div>${statusPill(t.status)}</div>
              <div>
                ${t.type === 'CONTRIBUTION' ? 'Contribution to' : t.type === 'REFUND' ? 'Refund from' : 'Settlement for'}
                <a href="#/pool/${esc(t.pool_id)}" style="color:var(--text);font-weight:550">${esc(t.pool_title)}</a>
                <div class="row-sub">
                  <span class="ref">${esc(t.pool_reference)}</span> ·
                  ${esc(t.provider_reference || 'no provider reference')} · ${when(t.created_at)}
                </div>
              </div>
              <div class="num" style="color:${t.direction === 'in' ? 'var(--accent)' : 'var(--text)'}">
                ${t.direction === 'in' ? '+' : '−'}${esc(t.amount_display)}
              </div>
              <div>${t.simulated ? '<span class="sim-tag">SIMULATED</span>' : '<span class="pill pill-accent">live</span>'}</div>
            </div>`).join('')}
        </div>`}
    </div>`;
}

// --- router ---------------------------------------------------------------

async function route() {
  if (!api.token) { renderAuth(); return; }

  const hash = location.hash || '#/pools';
  const [, section, param] = hash.split('/');

  renderChrome();

  try {
    if (section === 'pool' && param) await renderPool(param);
    else if (section === 'new') await renderCreate();
    else if (section === 'history') await renderHistory();
    else await renderPools();
  } catch (error) {
    if (error.status === 401) {
      api.clearSession();
      renderAuth();
      toast('Your session expired. Sign in again.', 'bad');
      return;
    }
    view().innerHTML = `<div class="card"><div class="error">${esc(error.message)}</div>
      <a class="btn btn-quiet" href="#/pools">Back to pools</a></div>`;
  }
}

async function boot() {
  try {
    integration = await api.call('/system/integration');
  } catch {
    integration = null;
  }
  renderModeBanner();
  await route();
}

window.addEventListener('hashchange', route);
document.addEventListener('click', (event) => {
  if (event.target.id === 'logout') {
    api.clearSession();
    location.hash = '#/';
    boot();
  }
});

boot();
