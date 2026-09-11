/* app.js — glues everything together. All state lives in IndexedDB + localStorage on this device. */

const PALETTE = ['#B98B4E','#C1584A','#7A9B76','#6C8AA8','#9A6FA8','#C77B9E','#5E9C8F','#D0A24C','#4E8FB9','#A65D57','#8E6B3C','#7A8B8C'];

const state = {
  accounts: [],
  categories: [],
  transactions: [],
  budgets: [],
  currency: localStorage.getItem('ledger-currency') || '₹',
  currentMonth: (() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; })(),
  budgetMonth: (() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; })(),
  activeView: 'dashboard',
  editingRules: {},
  selectMode: false,
  selectedTxIds: new Set(),
  categoryEditMode: false,
};

/* ---------------- PIN LOCK ---------------- */
async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

const Lock = (() => {
  let entry = '';
  let mode = 'unlock'; // unlock | create | createConfirm | change | changeConfirm
  let firstEntry = '';

  function hasPin() { return !!localStorage.getItem('ledger-pin-hash'); }

  function start() {
    mode = hasPin() ? 'unlock' : 'create';
    entry = '';
    updateTitle();
    render();
    document.getElementById('lockScreen').classList.remove('hidden');
    document.getElementById('app').classList.add('hidden');
  }

  function updateTitle() {
    const titles = {
      unlock: 'Enter your PIN',
      create: 'Create a PIN',
      createConfirm: 'Confirm your PIN',
      change: 'Enter a new PIN',
      changeConfirm: 'Confirm new PIN',
    };
    document.getElementById('lockTitle').textContent = titles[mode];
    document.getElementById('lockSub').textContent = mode === 'unlock'
      ? 'Your ledger, unlocked only here.'
      : 'Choose 4 digits. Nothing leaves this device.';
  }

  function render() {
    const dots = document.querySelectorAll('#pinDots span');
    dots.forEach((d, i) => d.classList.toggle('filled', i < entry.length));
  }

  function error(msg) {
    document.getElementById('lockError').textContent = msg;
    entry = '';
    render();
    setTimeout(() => { document.getElementById('lockError').textContent = ''; }, 1400);
  }

  async function submit() {
    if (mode === 'unlock') {
      const hash = await sha256(entry);
      if (hash === localStorage.getItem('ledger-pin-hash')) {
        unlockApp();
      } else {
        error('Incorrect PIN');
      }
    } else if (mode === 'create' || mode === 'change') {
      firstEntry = entry;
      entry = '';
      mode = mode === 'create' ? 'createConfirm' : 'changeConfirm';
      updateTitle();
      render();
    } else if (mode === 'createConfirm' || mode === 'changeConfirm') {
      if (entry === firstEntry) {
        const hash = await sha256(entry);
        localStorage.setItem('ledger-pin-hash', hash);
        if (mode === 'changeConfirm') {
          toast('PIN updated');
          document.getElementById('lockScreen').classList.add('hidden');
          document.getElementById('app').classList.remove('hidden');
        } else {
          unlockApp();
        }
      } else {
        error("PINs didn't match, try again");
        mode = mode === 'createConfirm' ? 'create' : 'change';
        updateTitle();
      }
    }
  }

  function key(k) {
    if (k === 'clear') { entry = ''; render(); return; }
    if (k === 'back') { entry = entry.slice(0, -1); render(); return; }
    if (entry.length >= 4) return;
    entry += k;
    render();
    if (entry.length === 4) submit();
  }

  function unlockApp() {
    document.getElementById('lockScreen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
  }

  function beginChange() {
    mode = 'change';
    entry = '';
    updateTitle();
    render();
    document.getElementById('lockScreen').classList.remove('hidden');
    document.getElementById('app').classList.add('hidden');
  }

  document.getElementById('keypad').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (btn) key(btn.dataset.k);
  });

  return { start, beginChange, hasPin };
})();

/* ---------------- TOAST ---------------- */
let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
}

/* ---------------- DATA LOADING ---------------- */
async function loadAll() {
  await Categorize.ensureDefaultCategories();
  state.accounts = await DB.getAll('accounts');
  state.categories = await DB.getAll('categories');
  state.transactions = await DB.getAll('transactions');
  state.budgets = await DB.getAll('budgets');

  // One-time migration: older installs won't have an explicit sort order yet.
  for (let i = 0; i < state.categories.length; i++) {
    if (state.categories[i].order === undefined) {
      state.categories[i].order = i;
      await DB.put('categories', state.categories[i]);
    }
  }

  populateAccountSelects();
  populateCategorySelects();
}

function sortedCategories() {
  return state.categories.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

function categoryById(id) { return state.categories.find(c => c.id === id); }
function accountById(id) { return state.accounts.find(a => a.id === id); }
function budgetFor(id) { return state.budgets.find(b => b.id === id); }

/* ---------------- NAVIGATION ---------------- */
const VIEW_TITLES = { dashboard: 'Dashboard', trends: 'Trends', transactions: 'Activity', accounts: 'Accounts', budgets: 'Budgets', settings: 'Settings' };

function navigate(view) {
  if (view !== 'transactions' && state.selectMode) {
    state.selectMode = false;
    state.selectedTxIds.clear();
    document.getElementById('selectModeBtn').classList.remove('hidden');
    document.getElementById('selectActions').classList.add('hidden');
  }
  if (view !== 'accounts' && state.categoryEditMode) {
    state.categoryEditMode = false;
    document.getElementById('editCategoriesBtn').textContent = 'Edit';
    document.getElementById('categoryEditHint').classList.add('hidden');
  }
  state.activeView = view;
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.getElementById('view-' + view).classList.remove('hidden');
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.nav === view));
  document.getElementById('pageTitle').textContent = VIEW_TITLES[view];
  renderView(view);
}

function renderView(view) {
  if (view === 'dashboard') renderDashboard();
  if (view === 'trends') renderTrends();
  if (view === 'transactions') renderTransactions();
  if (view === 'accounts') renderAccountsView();
  if (view === 'budgets') renderBudgets();
}

document.querySelectorAll('[data-nav]').forEach(el => {
  el.addEventListener('click', () => navigate(el.dataset.nav));
});

/* ---------------- DASHBOARD ---------------- */
function monthLabel(y, m) {
  return new Date(y, m, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function txInMonth(y, m) {
  return state.transactions.filter(t => {
    const d = new Date(t.date + 'T00:00:00');
    return d.getFullYear() === y && d.getMonth() === m;
  });
}

function renderDashboard() {
  const { y, m } = state.currentMonth;
  document.getElementById('monthLabel').textContent = monthLabel(y, m);
  const txs = txInMonth(y, m);
  const income = txs.filter(t => t.isIncome).reduce((s, t) => s + t.amount, 0);
  const expense = txs.filter(t => !t.isIncome).reduce((s, t) => s + t.amount, 0);
  document.getElementById('sumIncome').textContent = state.currency + income.toLocaleString(undefined,{maximumFractionDigits:0});
  document.getElementById('sumExpense').textContent = state.currency + expense.toLocaleString(undefined,{maximumFractionDigits:0});
  document.getElementById('sumNet').textContent = state.currency + (income-expense).toLocaleString(undefined,{maximumFractionDigits:0});

  const byCat = {};
  txs.filter(t => !t.isIncome).forEach(t => { byCat[t.categoryId] = (byCat[t.categoryId]||0) + t.amount; });
  const catItems = Object.entries(byCat).map(([id, value]) => {
    const c = categoryById(id);
    return { label: c ? c.name : 'Other', value, color: c ? c.color : '#8A8A7C' };
  }).sort((a,b) => b.value - a.value);
  Charts.barList(document.getElementById('categoryChart'), catItems, state.currency);

  const byAcc = {};
  txs.filter(t => !t.isIncome).forEach(t => { byAcc[t.accountId] = (byAcc[t.accountId]||0) + t.amount; });
  const accItems = Object.entries(byAcc).map(([id, value]) => {
    const a = accountById(id);
    return { label: a ? a.name : 'Unknown', value, color: a ? a.color : '#8A8A7C' };
  }).sort((a,b) => b.value - a.value);
  Charts.barList(document.getElementById('accountChart'), accItems, state.currency);

  const recent = [...txs].sort((a,b) => b.date.localeCompare(a.date)).slice(0, 6);
  renderTxList(document.getElementById('recentList'), recent);
}

document.getElementById('monthPrev').addEventListener('click', () => {
  let { y, m } = state.currentMonth;
  m--; if (m < 0) { m = 11; y--; }
  state.currentMonth = { y, m };
  renderDashboard();
});
document.getElementById('monthNext').addEventListener('click', () => {
  let { y, m } = state.currentMonth;
  m++; if (m > 11) { m = 0; y++; }
  state.currentMonth = { y, m };
  renderDashboard();
});

function renderTxList(container, txs, activityList) {
  container.innerHTML = '';
  if (!txs.length) {
    container.innerHTML = '<p class="empty-state">No transactions yet.</p>';
    return;
  }
  const selecting = !!(activityList && state.selectMode);
  txs.forEach(t => {
    const cat = categoryById(t.categoryId);
    const acc = accountById(t.accountId);
    const isSelected = selecting && state.selectedTxIds.has(t.id);
    const row = document.createElement('div');
    row.className = 'tx-row' + (selecting ? ' selectable' : '') + (isSelected ? ' selected' : '');
    row.innerHTML = `
      ${selecting ? `<span class="tx-check${isSelected ? ' checked' : ''}"></span>` : ''}
      <div class="tx-main">
        <span class="tx-desc">${escapeHtml(t.description)}</span>
        <span class="tx-meta">${formatDate(t.date)} · ${acc ? acc.name : ''} · ${cat ? cat.name : ''}</span>
      </div>
      <span class="tx-amount ${t.isIncome ? 'income' : 'expense'}">${t.isIncome ? '+' : '−'}${state.currency}${t.amount.toLocaleString(undefined,{minimumFractionDigits:2})}</span>`;
    row.addEventListener('click', () => {
      if (selecting) toggleTxSelect(t.id); else openTxModal(t);
    });
    container.appendChild(row);
  });
}

function formatDate(iso) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* ---------------- TRENDS ---------------- */
function trendsMonthList(count) {
  const now = new Date();
  const months = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ y: d.getFullYear(), m: d.getMonth(), label: d.toLocaleDateString(undefined, { month: 'short' }) });
  }
  return months;
}

function renderTrends() {
  const count = parseInt(document.getElementById('trendsDuration').value, 10) || 6;
  const months = trendsMonthList(count);

  const points = months.map(({ y, m, label }) => {
    const txs = txInMonth(y, m);
    return {
      label,
      income: txs.filter(t => t.isIncome).reduce((s,t) => s+t.amount, 0),
      expense: txs.filter(t => !t.isIncome).reduce((s,t) => s+t.amount, 0),
    };
  });
  Charts.trendChart(document.getElementById('trendChart'), points, state.currency);

  renderCategoryHeatmap(months);
}
document.getElementById('trendsDuration').addEventListener('change', renderTrends);

/* ---------------- CATEGORY FLUCTUATION HEATMAP ---------------- */
function heatColor(intensity) {
  // intensity 0..1 -> coral wash, light to full
  const alpha = intensity <= 0 ? 0 : 0.12 + intensity * 0.75;
  return `rgba(193,88,74,${alpha.toFixed(2)})`;
}

function renderCategoryHeatmap(months) {
  const container = document.getElementById('categoryHeatmap');
  const rows = state.categories.filter(c => c.id !== 'cat-income').map(c => {
    const values = months.map(({ y, m }) =>
      txInMonth(y, m).filter(t => !t.isIncome && t.categoryId === c.id).reduce((s,t) => s+t.amount, 0)
    );
    const total = values.reduce((a,b) => a+b, 0);
    return { id: c.id, name: c.name, color: c.color, values, total };
  }).filter(r => r.total > 0).sort((a,b) => b.total - a.total);

  if (!rows.length) {
    container.innerHTML = '<p class="empty-state">No spending in this period yet.</p>';
    return;
  }

  const header = `
    <div class="heatmap-header-row">
      <div class="heatmap-label-col"></div>
      <div class="heatmap-months-col">
        ${months.map(mo => `<span class="heat-month-label">${mo.label}</span>`).join('')}
      </div>
      <div class="heatmap-change-col"></div>
    </div>`;

  const rowsHTML = rows.map(r => {
    const rowMax = Math.max(...r.values, 0.0001);
    const cells = r.values.map((v, i) => {
      const intensity = v / rowMax;
      const monthLabel = `${months[i].label} ${months[i].y}`;
      return `<span class="heat-cell" style="background:${heatColor(intensity)}" data-amt="${v}" data-month="${escapeHtml(monthLabel)}"></span>`;
    }).join('');

    const last = r.values[r.values.length - 1];
    const prev = r.values.length >= 2 ? r.values[r.values.length - 2] : null;
    let changeHTML = '<span class="heat-change flat">—</span>';
    if (prev !== null) {
      if (prev === 0 && last > 0) {
        changeHTML = '<span class="heat-change new">New</span>';
      } else if (prev === 0 && last === 0) {
        changeHTML = '<span class="heat-change flat">—</span>';
      } else {
        const pct = Math.round(((last - prev) / prev) * 100);
        if (pct === 0) changeHTML = '<span class="heat-change flat">0%</span>';
        else if (pct > 0) changeHTML = `<span class="heat-change up">▲${pct}%</span>`;
        else changeHTML = `<span class="heat-change down">▼${Math.abs(pct)}%</span>`;
      }
    }

    return `
      <div class="heatmap-row">
        <div class="heatmap-label-col">
          <span class="rank-name-wrap"><span class="swatch" style="background:${r.color}"></span>${escapeHtml(r.name)}</span>
        </div>
        <div class="heatmap-months-col">${cells}</div>
        <div class="heatmap-change-col">${changeHTML}</div>
      </div>`;
  }).join('');

  container.innerHTML = header + rowsHTML;
  container.querySelectorAll('.heat-cell').forEach(cell => {
    cell.addEventListener('click', () => {
      const amt = parseFloat(cell.dataset.amt);
      toast(`${cell.dataset.month}: ${state.currency}${amt.toLocaleString(undefined,{maximumFractionDigits:0})}`);
    });
  });
}

/* ---------------- BUDGETS VIEW ---------------- */
function budgetBarClass(pct) {
  if (pct >= 100) return 'over';
  if (pct >= 80) return 'warn';
  return 'ok';
}

function budgetRowHTML({ id, name, color, spent, target, currency }) {
  const pct = target > 0 ? (spent / target) * 100 : 0;
  const widthPct = Math.min(pct, 100);
  const cls = budgetBarClass(pct);
  const over = spent > target;
  return `
    <div class="budget-row" data-budget-edit="${id}">
      <div class="budget-row-head">
        <div class="budget-row-left">
          ${color ? `<span class="swatch" style="background:${color}"></span>` : ''}
          <span class="budget-name">${escapeHtml(name)}</span>
        </div>
        <span class="budget-amounts">${currency}${spent.toLocaleString(undefined,{maximumFractionDigits:0})} / ${currency}${target.toLocaleString(undefined,{maximumFractionDigits:0})}</span>
      </div>
      <div class="budget-bar-track"><div class="budget-bar-fill ${cls}" style="width:${widthPct}%"></div></div>
      ${over ? `<div class="budget-over-note">Over by ${currency}${(spent-target).toLocaleString(undefined,{maximumFractionDigits:0})}</div>` : ''}
    </div>`;
}

function budgetEmptyRowHTML(id, name, color) {
  return `
    <div class="budget-empty" data-budget-edit="${id}">
      <div class="budget-row-left">
        ${color ? `<span class="swatch" style="background:${color}"></span>` : ''}
        <span class="budget-name">${escapeHtml(name)}</span>
      </div>
      <span class="budget-set-link">Set budget</span>
    </div>`;
}

function renderBudgets() {
  const { y, m } = state.budgetMonth;
  document.getElementById('budgetMonthLabel').textContent = monthLabel(y, m);
  const txs = txInMonth(y, m).filter(t => !t.isIncome);

  const byCat = {};
  txs.forEach(t => { byCat[t.categoryId] = (byCat[t.categoryId]||0) + t.amount; });
  const totalSpent = txs.reduce((s,t) => s+t.amount, 0);

  const overall = budgetFor('overall');
  const overallEl = document.getElementById('overallBudgetRow');
  if (overall && overall.amount > 0) {
    overallEl.innerHTML = budgetRowHTML({ id: 'overall', name: 'This month', color: null, spent: totalSpent, target: overall.amount, currency: state.currency });
  } else {
    overallEl.innerHTML = `<div class="budget-empty" data-budget-edit="overall">
      <span class="budget-name">No overall budget set</span>
      <span class="budget-set-link">Set budget</span>
    </div>`;
  }

  const catListEl = document.getElementById('categoryBudgetList');
  catListEl.innerHTML = '';
  sortedCategories().filter(c => c.id !== 'cat-income').forEach(c => {
    const spent = byCat[c.id] || 0;
    const b = budgetFor(c.id);
    const row = document.createElement('div');
    if (b && b.amount > 0) {
      row.innerHTML = budgetRowHTML({ id: c.id, name: c.name, color: c.color, spent, target: b.amount, currency: state.currency });
    } else {
      row.innerHTML = budgetEmptyRowHTML(c.id, c.name, c.color);
    }
    catListEl.appendChild(row.firstElementChild);
  });

  renderCategoryBudgetAllocationNote(overall);

  document.querySelectorAll('[data-budget-edit]').forEach(el => {
    el.addEventListener('click', () => openBudgetEditor(el.dataset.budgetEdit));
  });
}

function renderCategoryBudgetAllocationNote(overall) {
  const noteEl = document.getElementById('categoryBudgetTotal');
  const catTotal = state.budgets
    .filter(b => b.id !== 'overall' && b.amount > 0)
    .reduce((s, b) => s + b.amount, 0);
  const count = state.budgets.filter(b => b.id !== 'overall' && b.amount > 0).length;

  if (!count) {
    noteEl.innerHTML = '';
    return;
  }

  const currency = state.currency;
  if (overall && overall.amount > 0) {
    const pct = (catTotal / overall.amount) * 100;
    const over = catTotal > overall.amount;
    const barPct = Math.min(pct, 100);
    noteEl.className = 'allocation-note' + (over ? ' over' : '');
    noteEl.innerHTML = `
      Category budgets add up to <strong>${currency}${catTotal.toLocaleString(undefined,{maximumFractionDigits:0})}</strong>
      — ${Math.round(pct)}% of your ${currency}${overall.amount.toLocaleString(undefined,{maximumFractionDigits:0})} overall budget.
      ${over ? `<br>That's ${currency}${(catTotal-overall.amount).toLocaleString(undefined,{maximumFractionDigits:0})} over your overall budget.` : ''}
      <div class="allocation-bar-track"><div class="allocation-bar-fill" style="width:${barPct}%;background:${over ? 'var(--coral)' : 'var(--sage)'}"></div></div>`;
  } else {
    noteEl.className = 'allocation-note';
    noteEl.innerHTML = `Category budgets add up to <strong>${currency}${catTotal.toLocaleString(undefined,{maximumFractionDigits:0})}</strong> across ${count} categor${count===1?'y':'ies'}. Set an overall budget above to see how that compares.`;
  }
}

function openBudgetEditor(id) {
  const isOverall = id === 'overall';
  const cat = isOverall ? null : categoryById(id);
  const existing = budgetFor(id);
  openPrompt({
    title: isOverall ? 'Overall monthly budget' : `Budget for ${cat ? cat.name : ''}`,
    label: `Amount (${state.currency}) per month`,
    numeric: true,
    initialValue: existing ? existing.amount : '',
    onSave: async (val) => {
      const amount = parseFloat(val);
      const record = { id, amount };
      await DB.put('budgets', record);
      const idx = state.budgets.findIndex(b => b.id === id);
      if (idx >= 0) state.budgets[idx] = record; else state.budgets.push(record);
      renderBudgets();
      toast('Budget saved');
    }
  });
}

document.getElementById('budgetMonthPrev').addEventListener('click', () => {
  let { y, m } = state.budgetMonth;
  m--; if (m < 0) { m = 11; y--; }
  state.budgetMonth = { y, m };
  renderBudgets();
});
document.getElementById('budgetMonthNext').addEventListener('click', () => {
  let { y, m } = state.budgetMonth;
  m++; if (m > 11) { m = 0; y++; }
  state.budgetMonth = { y, m };
  renderBudgets();
});
document.getElementById('editOverallBudgetBtn').addEventListener('click', () => openBudgetEditor('overall'));

/* ---------------- TRANSACTIONS VIEW ---------------- */
function pad2(n) { return String(n).padStart(2, '0'); }
function localISODate(d) { return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; }
function todayISO() { return localISODate(new Date()); }
function monthStartISO(monthsAgo) {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - monthsAgo, 1);
  return localISODate(d);
}
function lastMonthRangeISO() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const end = new Date(now.getFullYear(), now.getMonth(), 0); // day 0 = last day of previous month
  return { from: localISODate(start), to: localISODate(end) };
}

function getActiveDateRange() {
  const preset = document.getElementById('txDateRange').value;
  if (preset === 'month') return { from: monthStartISO(0), to: todayISO() };
  if (preset === 'lastmonth') return lastMonthRangeISO();
  if (preset === 'last3') return { from: monthStartISO(2), to: todayISO() };
  if (preset === 'last6') return { from: monthStartISO(5), to: todayISO() };
  if (preset === 'custom') {
    return {
      from: document.getElementById('txDateFrom').value || null,
      to: document.getElementById('txDateTo').value || null,
    };
  }
  return { from: null, to: null };
}

let lastFilteredTxIds = [];
function renderTransactions() {
  const search = document.getElementById('txSearch').value.trim().toLowerCase();
  const accFilter = document.getElementById('txFilterAccount').value;
  const catFilter = document.getElementById('txFilterCategory').value;
  const { from, to } = getActiveDateRange();
  let txs = [...state.transactions].sort((a,b) => b.date.localeCompare(a.date));
  if (search) txs = txs.filter(t => t.description.toLowerCase().includes(search) || String(t.amount).includes(search));
  if (accFilter) txs = txs.filter(t => t.accountId === accFilter);
  if (catFilter) txs = txs.filter(t => t.categoryId === catFilter);
  if (from) txs = txs.filter(t => t.date >= from);
  if (to) txs = txs.filter(t => t.date <= to);
  lastFilteredTxIds = txs.map(t => t.id);
  renderTxList(document.getElementById('txFullList'), txs, true);
  updateSelectUI();
  renderTxSummaryBar(txs);
}

function renderTxSummaryBar(txs) {
  const bar = document.getElementById('txSummaryBar');
  if (!txs.length) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
  const incomeTxs = txs.filter(t => t.isIncome);
  const expenseTxs = txs.filter(t => !t.isIncome);
  const incomeSum = incomeTxs.reduce((s,t) => s+t.amount, 0);
  const expenseSum = expenseTxs.reduce((s,t) => s+t.amount, 0);
  const c = state.currency;
  bar.classList.remove('hidden');
  bar.innerHTML = `
    <span><strong>${txs.length}</strong> transaction${txs.length===1?'':'s'}</span>
    <span><strong>${incomeTxs.length}</strong> credit${incomeTxs.length===1?'':'s'} · ${c}${incomeSum.toLocaleString(undefined,{maximumFractionDigits:0})}</span>
    <span><strong>${expenseTxs.length}</strong> debit${expenseTxs.length===1?'':'s'} · ${c}${expenseSum.toLocaleString(undefined,{maximumFractionDigits:0})}</span>
    <span>Net <strong>${c}${(incomeSum-expenseSum).toLocaleString(undefined,{maximumFractionDigits:0})}</strong></span>`;
}
document.getElementById('txSearch').addEventListener('input', renderTransactions);
document.getElementById('txFilterAccount').addEventListener('change', renderTransactions);
document.getElementById('txFilterCategory').addEventListener('change', renderTransactions);
document.getElementById('txDateRange').addEventListener('change', (e) => {
  document.getElementById('txCustomRange').classList.toggle('hidden', e.target.value !== 'custom');
  if (e.target.value === 'custom') {
    const from = document.getElementById('txDateFrom');
    const to = document.getElementById('txDateTo');
    if (!to.value) to.value = todayISO();
    if (!from.value) from.value = monthStartISO(0);
  }
  renderTransactions();
});
document.getElementById('txDateFrom').addEventListener('change', renderTransactions);
document.getElementById('txDateTo').addEventListener('change', renderTransactions);
document.getElementById('addTxBtn').addEventListener('click', () => openTxModal(null));

/* ---------------- MULTI-SELECT + BULK ACTIONS ---------------- */
function toggleTxSelect(id) {
  if (state.selectedTxIds.has(id)) state.selectedTxIds.delete(id); else state.selectedTxIds.add(id);
  renderTransactions();
}

function updateSelectUI() {
  document.getElementById('selectCount').textContent = `${state.selectedTxIds.size} selected`;
}

document.getElementById('selectModeBtn').addEventListener('click', () => {
  state.selectMode = true;
  state.selectedTxIds.clear();
  document.getElementById('selectModeBtn').classList.add('hidden');
  document.getElementById('selectActions').classList.remove('hidden');
  renderTransactions();
});

function exitSelectMode() {
  state.selectMode = false;
  state.selectedTxIds.clear();
  document.getElementById('selectModeBtn').classList.remove('hidden');
  document.getElementById('selectActions').classList.add('hidden');
  renderTransactions();
}
document.getElementById('selectCancelBtn').addEventListener('click', exitSelectMode);

document.getElementById('selectAllBtn').addEventListener('click', () => {
  const allSelected = lastFilteredTxIds.length > 0 && lastFilteredTxIds.every(id => state.selectedTxIds.has(id));
  if (allSelected) {
    lastFilteredTxIds.forEach(id => state.selectedTxIds.delete(id));
  } else {
    lastFilteredTxIds.forEach(id => state.selectedTxIds.add(id));
  }
  renderTransactions();
});

document.getElementById('bulkDeleteBtn').addEventListener('click', async () => {
  const ids = Array.from(state.selectedTxIds);
  if (!ids.length) { toast('Select at least one transaction'); return; }
  if (!confirm(`Delete ${ids.length} transaction${ids.length===1?'':'s'}? This can't be undone.`)) return;
  for (const id of ids) await DB.delete('transactions', id);
  state.transactions = state.transactions.filter(t => !ids.includes(t.id));
  exitSelectMode();
  toast('Deleted');
});

document.getElementById('bulkEditBtn').addEventListener('click', () => {
  if (!state.selectedTxIds.size) { toast('Select at least one transaction'); return; }
  document.getElementById('bulkEditCount').textContent = `Applying to ${state.selectedTxIds.size} transaction${state.selectedTxIds.size===1?'':'s'}. Leave a field as "No change" to skip it.`;
  document.getElementById('bulkCategory').value = '';
  document.getElementById('bulkAccount').value = '';
  document.getElementById('bulkRemember').checked = false;
  openSheet('bulkEditModal');
});

document.getElementById('bulkSaveBtn').addEventListener('click', async () => {
  const newCategory = document.getElementById('bulkCategory').value;
  const newAccount = document.getElementById('bulkAccount').value;
  const remember = document.getElementById('bulkRemember').checked;
  if (!newCategory && !newAccount) { toast('Choose a category or account to apply'); return; }
  const ids = Array.from(state.selectedTxIds);
  for (const id of ids) {
    const t = state.transactions.find(x => x.id === id);
    if (!t) continue;
    const updated = { ...t };
    if (newCategory) updated.categoryId = newCategory;
    if (newAccount) updated.accountId = newAccount;
    await DB.put('transactions', updated);
    if (newCategory && remember) await Categorize.learn(updated.description, newCategory);
    const idx = state.transactions.findIndex(x => x.id === id);
    if (idx >= 0) state.transactions[idx] = updated;
  }
  closeSheet('bulkEditModal');
  exitSelectMode();
  toast(`Updated ${ids.length} transaction${ids.length===1?'':'s'}`);
});

/* ---------------- TRANSACTION MODAL ---------------- */
function populateAccountSelects() {
  const selects = [document.getElementById('txAccount'), document.getElementById('uploadAccount'), document.getElementById('txFilterAccount'), document.getElementById('bulkAccount')];
  selects.forEach(sel => {
    let keep = '';
    if (sel.id === 'txFilterAccount') keep = '<option value="">All accounts</option>';
    if (sel.id === 'bulkAccount') keep = '<option value="">No change</option>';
    sel.innerHTML = keep + state.accounts.map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
  });
}
function populateCategorySelects() {
  const selects = [document.getElementById('txCategory'), document.getElementById('txFilterCategory'), document.getElementById('bulkCategory')];
  selects.forEach(sel => {
    let keep = '';
    if (sel.id === 'txFilterCategory') keep = '<option value="">All categories</option>';
    if (sel.id === 'bulkCategory') keep = '<option value="">No change</option>';
    sel.innerHTML = keep + sortedCategories().map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  });
}

function openTxModal(t) {
  if (!state.accounts.length) { toast('Add an account first, in the Accounts tab'); return; }
  document.getElementById('txModalTitle').textContent = t ? 'Edit transaction' : 'Add transaction';
  document.getElementById('txId').value = t ? t.id : '';
  document.getElementById('txDesc').value = t ? t.description : '';
  document.getElementById('txAmount').value = t ? t.amount : '';
  document.getElementById('txDate').value = t ? t.date : new Date().toISOString().slice(0,10);
  document.getElementById('txAccount').value = t ? t.accountId : state.accounts[0].id;
  document.getElementById('txCategory').value = t ? t.categoryId : 'cat-other';
  setSegmented('txType', t ? (t.isIncome ? 'income' : 'expense') : 'expense');
  document.getElementById('txRemember').checked = true;
  document.getElementById('deleteTxBtn').classList.toggle('hidden', !t);
  openSheet('txModal');
}

function setSegmented(id, value) {
  const wrap = document.getElementById(id);
  wrap.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.v === value));
  wrap.dataset.value = value;
}
document.getElementById('txType').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (btn) setSegmented('txType', btn.dataset.v);
});

document.getElementById('saveTxBtn').addEventListener('click', async () => {
  const id = document.getElementById('txId').value || DB.uuid();
  const description = document.getElementById('txDesc').value.trim();
  const amount = parseFloat(document.getElementById('txAmount').value);
  const date = document.getElementById('txDate').value;
  const accountId = document.getElementById('txAccount').value;
  const categoryId = document.getElementById('txCategory').value;
  const isIncome = document.getElementById('txType').dataset.value === 'income';
  if (!description || isNaN(amount) || !date || !accountId) { toast('Fill in description, amount and date'); return; }

  const existing = state.transactions.find(t => t.id === id);
  const record = { id, description, amount: Math.abs(amount), date, accountId, categoryId, isIncome, refNo: existing ? (existing.refNo || null) : null };
  await DB.put('transactions', record);

  let retroCount = 0;
  if (document.getElementById('txRemember').checked) {
    await Categorize.learn(description, categoryId);
    const merchantKey = Categorize.normalizeMerchant(description);
    const mismatched = state.transactions.filter(t =>
      t.id !== id && Categorize.normalizeMerchant(t.description) === merchantKey && t.categoryId !== categoryId
    );
    if (mismatched.length) {
      const catName = categoryById(categoryId)?.name || 'this category';
      const plural = mismatched.length === 1 ? '' : 's';
      const ok = confirm(`${mismatched.length} other existing transaction${plural} from this merchant ${mismatched.length===1?'is':'are'} categorized differently. Update ${mismatched.length===1?'it':'them'} to ${catName} too?`);
      if (ok) {
        for (const t of mismatched) {
          const updated = { ...t, categoryId };
          await DB.put('transactions', updated);
          const idx2 = state.transactions.findIndex(x => x.id === t.id);
          if (idx2 >= 0) state.transactions[idx2] = updated;
        }
        retroCount = mismatched.length;
      }
    }
  }

  const idx = state.transactions.findIndex(t => t.id === id);
  if (idx >= 0) state.transactions[idx] = record; else state.transactions.push(record);
  closeSheet('txModal');
  renderView(state.activeView);
  toast(retroCount ? `Saved — also updated ${retroCount} other transaction${retroCount===1?'':'s'}` : 'Saved');
});

document.getElementById('deleteTxBtn').addEventListener('click', async () => {
  const id = document.getElementById('txId').value;
  if (!id) return;
  await DB.delete('transactions', id);
  state.transactions = state.transactions.filter(t => t.id !== id);
  closeSheet('txModal');
  renderView(state.activeView);
  toast('Deleted');
});

/* ---------------- SHEETS ---------------- */
function openSheet(id) { document.getElementById(id).classList.remove('hidden'); }
function closeSheet(id) { document.getElementById(id).classList.add('hidden'); }
document.querySelectorAll('[data-close]').forEach(btn => {
  btn.addEventListener('click', () => closeSheet(btn.dataset.close));
});
document.querySelectorAll('.sheet').forEach(sheet => {
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.classList.add('hidden'); });
});

/* ---------------- ACCOUNTS + CATEGORIES VIEW ---------------- */
function renderAccountsView() {
  const accWrap = document.getElementById('accountList');
  accWrap.innerHTML = '';
  if (!state.accounts.length) accWrap.innerHTML = '<p class="empty-state">No accounts yet. Add one to get started.</p>';
  state.accounts.forEach(a => {
    const row = document.createElement('div');
    row.className = 'rank-row';
    const total = state.transactions.filter(t => t.accountId === a.id && !t.isIncome).reduce((s,t)=>s+t.amount,0);
    row.innerHTML = `
      <div class="rank-left"><span class="swatch" style="background:${a.color}"></span><span class="rank-name">${escapeHtml(a.name)}</span></div>
      <div class="row-actions"><span class="rank-value">${state.currency}${total.toLocaleString(undefined,{maximumFractionDigits:0})}</span>
      <button class="tiny-btn" data-del-acc="${a.id}">Remove</button></div>`;
    accWrap.appendChild(row);
  });
  accWrap.querySelectorAll('[data-del-acc]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.delAcc;
      const has = state.transactions.some(t => t.accountId === id);
      if (has && !confirm('This account has transactions. Remove it anyway? Its transactions will stay but show as Unknown account.')) return;
      await DB.delete('accounts', id);
      state.accounts = state.accounts.filter(a => a.id !== id);
      populateAccountSelects();
      renderAccountsView();
    });
  });

  renderCategoryList();
  renderRuleList();
}

function renderCategoryList() {
  const catWrap = document.getElementById('categoryList');
  catWrap.innerHTML = '';
  const editing = state.categoryEditMode;
  sortedCategories().forEach(c => {
    const total = state.transactions.filter(t => t.categoryId === c.id).reduce((s,t)=>s+t.amount,0);
    const protectedCat = c.id === 'cat-other' || c.id === 'cat-income';
    const row = document.createElement('div');
    row.className = 'rank-row draggable-row';
    row.dataset.catId = c.id;
    row.innerHTML = `
      ${editing ? `<span class="drag-handle" aria-label="Drag to reorder">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
          <circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/>
          <circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/>
          <circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/>
        </svg>
      </span>` : ''}
      <div class="rank-left"><span class="swatch" style="background:${c.color}"></span><span class="rank-name">${escapeHtml(c.name)}</span></div>
      <div class="row-actions"><span class="rank-value">${state.currency}${total.toLocaleString(undefined,{maximumFractionDigits:0})}</span>
      ${(editing && !protectedCat) ? `<button class="tiny-btn" data-del-cat="${c.id}">Remove</button>` : ''}</div>`;
    catWrap.appendChild(row);
  });
  catWrap.querySelectorAll('[data-del-cat]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.delCat;
      const affected = state.transactions.filter(t => t.categoryId === id);
      if (affected.length && !confirm(`This category has ${affected.length} transaction${affected.length===1?'':'s'}. They'll be moved to "Other". Continue?`)) return;
      if (!affected.length && !confirm('Remove this category?')) return;

      for (const t of affected) {
        const updated = { ...t, categoryId: 'cat-other' };
        await DB.put('transactions', updated);
        const idx = state.transactions.findIndex(x => x.id === t.id);
        if (idx >= 0) state.transactions[idx] = updated;
      }

      await DB.delete('budgets', id);
      state.budgets = state.budgets.filter(b => b.id !== id);

      const rules = await DB.getAll('rules');
      for (const r of rules) {
        if (r.categoryId === id) await DB.delete('rules', r.merchant);
      }

      await DB.delete('categories', id);
      state.categories = state.categories.filter(c => c.id !== id);
      populateCategorySelects();
      renderCategoryList();
      toast('Category removed');
    });
  });
  catWrap.querySelectorAll('.drag-handle').forEach(handle => {
    handle.addEventListener('touchstart', onCategoryDragStart, { passive: false });
  });
}

/* Drag-to-reorder for categories (touch, long-press-and-slide) */
let categoryDrag = null;

function onCategoryDragStart(e) {
  e.preventDefault();
  const row = e.target.closest('.draggable-row');
  if (!row) return;
  categoryDrag = { id: row.dataset.catId };
  row.classList.add('dragging');
  document.addEventListener('touchmove', onCategoryDragMove, { passive: false });
  document.addEventListener('touchend', onCategoryDragEnd, { passive: false });
  document.addEventListener('touchcancel', onCategoryDragEnd, { passive: false });
}

function onCategoryDragMove(e) {
  if (!categoryDrag) return;
  e.preventDefault();
  const touchY = e.touches[0].clientY;
  const rows = Array.from(document.querySelectorAll('#categoryList .draggable-row'));
  if (!rows.length) return;
  let newIndex = rows.length - 1;
  for (let i = 0; i < rows.length; i++) {
    const rect = rows[i].getBoundingClientRect();
    if (touchY < rect.top + rect.height / 2) { newIndex = i; break; }
  }
  const ordered = sortedCategories();
  const oldIndex = ordered.findIndex(c => c.id === categoryDrag.id);
  if (oldIndex === -1 || newIndex === oldIndex) return;
  const [moved] = ordered.splice(oldIndex, 1);
  ordered.splice(newIndex, 0, moved);
  ordered.forEach((c, i) => { c.order = i; });
  renderCategoryList();
  const newRow = document.querySelector(`#categoryList .draggable-row[data-cat-id="${categoryDrag.id}"]`);
  if (newRow) newRow.classList.add('dragging');
}

async function onCategoryDragEnd() {
  document.removeEventListener('touchmove', onCategoryDragMove);
  document.removeEventListener('touchend', onCategoryDragEnd);
  document.removeEventListener('touchcancel', onCategoryDragEnd);
  if (!categoryDrag) return;
  const id = categoryDrag.id;
  categoryDrag = null;
  const row = document.querySelector(`#categoryList .draggable-row[data-cat-id="${id}"]`);
  if (row) row.classList.remove('dragging');
  for (const c of state.categories) await DB.put('categories', c);
}

async function renderRuleList() {
  const rules = await DB.getAll('rules');
  const wrap = document.getElementById('ruleList');
  wrap.innerHTML = '';
  if (!rules.length) { wrap.innerHTML = '<p class="empty-state">No learned rules yet.</p>'; return; }
  rules.sort((a,b) => b.updatedAt - a.updatedAt).forEach(r => {
    const c = categoryById(r.categoryId);
    const row = document.createElement('div');
    row.className = 'rank-row';
    row.innerHTML = `
      <div class="rank-left"><span class="swatch" style="background:${c?c.color:'#8A8A7C'}"></span><span class="rank-name">${escapeHtml(r.merchant)} → ${c?c.name:'—'}</span></div>
      <button class="tiny-btn" data-del-rule="${r.merchant}">Remove</button>`;
    wrap.appendChild(row);
  });
  wrap.querySelectorAll('[data-del-rule]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await DB.delete('rules', btn.dataset.delRule);
      renderRuleList();
    });
  });
}

/* ---------------- DUPLICATE TRANSACTION FINDER ---------------- */
function findDuplicateGroups() {
  const buckets = new Map();
  for (const t of state.transactions) {
    let key;
    if (t.refNo) {
      key = `ref:${t.accountId}|${t.refNo}`;
    } else {
      const merchantKey = Categorize.normalizeMerchant(t.description);
      key = `fallback:${t.accountId}|${t.date}|${t.amount.toFixed(2)}|${t.isIncome ? 'in' : 'out'}|${merchantKey}`;
    }
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(t);
  }
  return [...buckets.values()].filter(group => group.length > 1);
}

function renderDuplicates(groups) {
  const wrap = document.getElementById('duplicatesResults');
  if (!groups) { wrap.innerHTML = ''; return; }
  if (!groups.length) {
    wrap.innerHTML = '<p class="empty-state">No duplicates found.</p>';
    return;
  }
  wrap.innerHTML = groups.map((group, gi) => {
    const first = group[0];
    const acc = accountById(first.accountId);
    const exactMatch = !!first.refNo;
    const itemsHTML = group.map((t, i) => `
      <div class="dup-item">
        <input type="checkbox" data-dup-check="${gi}:${t.id}" ${i === 0 ? '' : 'checked'}>
        <span class="dup-item-desc">${escapeHtml(t.description)}${i === 0 ? '<span class="dup-keep-tag">kept by default</span>' : ''}</span>
      </div>`).join('');
    return `
      <div class="dup-group" data-group="${gi}">
        <div class="dup-group-head">${group.length} matches (${exactMatch ? 'exact reference match' : 'likely match'}) — ${formatDate(first.date)} · ${state.currency}${first.amount.toLocaleString(undefined,{minimumFractionDigits:2})} · ${acc ? acc.name : ''} · ${first.isIncome ? 'credit' : 'debit'}</div>
        ${itemsHTML}
        <div class="dup-group-actions"><button class="tiny-btn" data-del-group="${gi}">Delete checked</button></div>
      </div>`;
  }).join('');

  wrap.querySelectorAll('[data-del-group]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const gi = btn.dataset.delGroup;
      const checks = wrap.querySelectorAll(`[data-dup-check^="${gi}:"]:checked`);
      const ids = Array.from(checks).map(cb => cb.dataset.dupCheck.split(':')[1]);
      if (!ids.length) { toast('Nothing checked to delete'); return; }
      if (!confirm(`Delete ${ids.length} transaction${ids.length===1?'':'s'}?`)) return;
      for (const id of ids) await DB.delete('transactions', id);
      state.transactions = state.transactions.filter(t => !ids.includes(t.id));
      const remaining = findDuplicateGroups();
      renderDuplicates(remaining);
      toast('Deleted');
      renderAccountsView();
    });
  });
}

document.getElementById('scanDuplicatesBtn').addEventListener('click', () => {
  renderDuplicates(findDuplicateGroups());
});

/* Prompt modal for simple add-name (+color) or numeric-amount flows */
function openPrompt({ title, label, withColor, numeric, initialValue, onSave }) {
  document.getElementById('promptTitle').textContent = title;
  document.getElementById('promptLabel').textContent = label;
  const input = document.getElementById('promptInput');
  input.type = numeric ? 'number' : 'text';
  input.inputMode = numeric ? 'decimal' : '';
  input.step = numeric ? '0.01' : '';
  input.min = numeric ? '0' : '';
  input.value = initialValue != null ? initialValue : '';
  const colorRow = document.getElementById('promptColorRow');
  colorRow.classList.toggle('hidden', !withColor);
  let chosenColor = PALETTE[Math.floor(Math.random()*PALETTE.length)];
  if (withColor) {
    colorRow.innerHTML = PALETTE.map(c => `<span class="color-dot" data-c="${c}" style="background:${c}"></span>`).join('');
    colorRow.querySelectorAll('.color-dot').forEach((dot, i) => {
      if (dot.dataset.c === chosenColor) dot.classList.add('selected');
      dot.addEventListener('click', () => {
        colorRow.querySelectorAll('.color-dot').forEach(d => d.classList.remove('selected'));
        dot.classList.add('selected');
        chosenColor = dot.dataset.c;
      });
    });
  }
  const saveBtn = document.getElementById('promptSaveBtn');
  const handler = async () => {
    const val = input.value.trim();
    if (!val) { toast(numeric ? 'Enter an amount' : 'Enter a name'); return; }
    if (numeric && (isNaN(parseFloat(val)) || parseFloat(val) < 0)) { toast('Enter a valid amount'); return; }
    await onSave(val, chosenColor);
    closeSheet('promptModal');
    saveBtn.removeEventListener('click', handler);
  };
  saveBtn.addEventListener('click', handler);
  openSheet('promptModal');
}

document.getElementById('addAccountBtn').addEventListener('click', () => {
  openPrompt({
    title: 'Add account', label: 'Account name (e.g. Chase Checking)', withColor: true,
    onSave: async (name, color) => {
      const acc = { id: DB.uuid(), name, color };
      await DB.put('accounts', acc);
      state.accounts.push(acc);
      populateAccountSelects();
      renderAccountsView();
      toast('Account added');
    }
  });
});

document.getElementById('editCategoriesBtn').addEventListener('click', () => {
  state.categoryEditMode = !state.categoryEditMode;
  const btn = document.getElementById('editCategoriesBtn');
  btn.textContent = state.categoryEditMode ? 'Done' : 'Edit';
  document.getElementById('categoryEditHint').classList.toggle('hidden', !state.categoryEditMode);
  renderCategoryList();
});

document.getElementById('addCategoryBtn').addEventListener('click', () => {
  openPrompt({
    title: 'Add category', label: 'Category name', withColor: true,
    onSave: async (name, color) => {
      const maxOrder = state.categories.reduce((m, c) => Math.max(m, c.order ?? 0), -1);
      const cat = { id: DB.uuid(), name, color, order: maxOrder + 1 };
      await DB.put('categories', cat);
      state.categories.push(cat);
      populateCategorySelects();
      renderAccountsView();
      toast('Category added');
    }
  });
});

/* ---------------- UPLOAD FLOW ---------------- */
document.getElementById('uploadBtn').addEventListener('click', () => {
  if (!state.accounts.length) { toast('Add an account first, in the Accounts tab'); return; }
  document.getElementById('uploadResult').classList.add('hidden');
  document.getElementById('uploadProgress').classList.add('hidden');
  document.getElementById('dropZone').classList.remove('hidden');
  document.getElementById('pdfInput').value = '';
  openSheet('uploadModal');
});

document.getElementById('pdfInput').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  const accountId = document.getElementById('uploadAccount').value;
  document.getElementById('dropZone').classList.add('hidden');
  document.getElementById('uploadProgress').classList.remove('hidden');
  const statusEl = document.getElementById('uploadStatus');

  let added = 0, skipped = 0;
  const existingRefKeys = new Set(
    state.transactions.filter(t => t.refNo).map(t => `${t.accountId}|${t.refNo}`)
  );
  const existingFallbackKeys = new Set(
    state.transactions.map(t => `${t.accountId}|${t.date}|${t.amount}|${t.description.toLowerCase()}`)
  );

  for (const file of files) {
    statusEl.textContent = `Opening ${file.name}…`;
    try {
      const candidates = await Parse.parseStatement(file, (s) => { statusEl.textContent = s; });
      for (const c of candidates) {
        if (c.refNo) {
          const refKey = `${accountId}|${c.refNo}`;
          if (existingRefKeys.has(refKey)) { skipped++; continue; }
          existingRefKeys.add(refKey);
        } else {
          const fallbackKey = `${accountId}|${c.date}|${c.amount}|${c.description.toLowerCase()}`;
          if (existingFallbackKeys.has(fallbackKey)) { skipped++; continue; }
          existingFallbackKeys.add(fallbackKey);
        }
        const categoryId = await Categorize.suggestCategory(c.description, c.isIncome);
        const record = { id: DB.uuid(), description: c.description, amount: c.amount, date: c.date, accountId, categoryId, isIncome: c.isIncome, refNo: c.refNo || null };
        await DB.put('transactions', record);
        state.transactions.push(record);
        added++;
      }
    } catch (err) {
      console.error(err);
      toast(`Could not read ${file.name}`);
    }
  }

  document.getElementById('uploadProgress').classList.add('hidden');
  const resultEl = document.getElementById('uploadResult');
  resultEl.classList.remove('hidden');
  resultEl.innerHTML = `Added <strong>${added}</strong> transaction${added===1?'':'s'}.` +
    (skipped ? ` Skipped ${skipped} that looked like duplicates.` : '') +
    (added === 0 && skipped === 0 ? ' Nothing recognizable was found — you can add transactions manually, or try a clearer scan.' : '') +
    `<br><br>Review anything mis-parsed in the Activity tab — tap a transaction to fix it.`;

  if (added === 0 && files.length === 1) {
    try {
      const debug = await Parse.debugExtract(files[0]);
      const pre = document.createElement('pre');
      pre.style.cssText = 'white-space:pre-wrap;font-size:0.65rem;background:#EFE9D8;padding:10px;border-radius:8px;margin-top:12px;max-height:240px;overflow:auto;';
      pre.textContent = JSON.stringify(debug, null, 2);
      const label = document.createElement('p');
      label.className = 'hint';
      label.style.marginTop = '10px';
      label.textContent = 'Debug info below — screenshot this and send it back so the parser can be tuned:';
      resultEl.appendChild(label);
      resultEl.appendChild(pre);
    } catch (e) { console.error(e); }
  }
  renderView(state.activeView);
});

/* ---------------- SETTINGS ---------------- */
document.getElementById('changePinBtn').addEventListener('click', () => Lock.beginChange());

document.getElementById('dateFormatSelect').addEventListener('change', (e) => {
  Parse.setDateFormat(e.target.value);
  toast('Date format updated');
});

document.getElementById('currencySelect').addEventListener('change', (e) => {
  state.currency = e.target.value;
  localStorage.setItem('ledger-currency', state.currency);
  renderView(state.activeView);
});

document.getElementById('exportBtn').addEventListener('click', async () => {
  const backup = {
    version: 2,
    exportedAt: new Date().toISOString(),
    accounts: state.accounts,
    categories: state.categories,
    transactions: state.transactions,
    rules: await DB.getAll('rules'),
    budgets: await DB.getAll('budgets'),
    currency: state.currency,
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ledger-backup-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Backup downloaded');
});

document.getElementById('importBtn').addEventListener('click', () => document.getElementById('importFile').click());
document.getElementById('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!confirm('Restoring will add these accounts, categories and transactions to what you already have. Continue?')) return;
    for (const a of data.accounts || []) await DB.put('accounts', a);
    for (const c of data.categories || []) await DB.put('categories', c);
    for (const t of data.transactions || []) await DB.put('transactions', t);
    for (const r of data.rules || []) await DB.put('rules', r);
    for (const b of data.budgets || []) await DB.put('budgets', b);
    if (data.currency) { state.currency = data.currency; localStorage.setItem('ledger-currency', data.currency); }
    await loadAll();
    renderView(state.activeView);
    toast('Backup restored');
  } catch (err) {
    console.error(err);
    toast('Could not read that backup file');
  }
});

document.getElementById('resetBtn').addEventListener('click', async () => {
  if (!confirm('This permanently erases every account, category, and transaction on this device. This cannot be undone. Continue?')) return;
  if (!confirm('Are you absolutely sure? There is no way to recover this data afterward.')) return;
  await DB.clearAll();
  localStorage.removeItem('ledger-pin-hash');
  location.reload();
});

/* ---------------- INIT ---------------- */
(async function init() {
  document.getElementById('currencySelect').value = state.currency;
  document.getElementById('dateFormatSelect').value = Parse.getDateFormat();
  await loadAll();
  navigate('dashboard');
  Lock.start();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
