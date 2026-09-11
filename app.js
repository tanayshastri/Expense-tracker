/* app.js — glues everything together. All state lives in IndexedDB + localStorage on this device. */

const PALETTE = ['#B98B4E','#C1584A','#7A9B76','#6C8AA8','#9A6FA8','#C77B9E','#5E9C8F','#D0A24C','#4E8FB9','#A65D57','#8E6B3C','#7A8B8C'];

const state = {
  accounts: [],
  categories: [],
  transactions: [],
  budgets: [],
  currency: localStorage.getItem('ledger-currency') || '₹',
  currentMonth: (() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; })(),
  activeView: 'dashboard',
  editingRules: {},
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
  populateAccountSelects();
  populateCategorySelects();
}

function categoryById(id) { return state.categories.find(c => c.id === id); }
function accountById(id) { return state.accounts.find(a => a.id === id); }
function budgetFor(id) { return state.budgets.find(b => b.id === id); }

/* ---------------- NAVIGATION ---------------- */
const VIEW_TITLES = { dashboard: 'Dashboard', trends: 'Trends', transactions: 'Activity', accounts: 'Accounts', budgets: 'Budgets', settings: 'Settings' };

function navigate(view) {
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

function renderTxList(container, txs) {
  container.innerHTML = '';
  if (!txs.length) {
    container.innerHTML = '<p class="empty-state">No transactions yet.</p>';
    return;
  }
  txs.forEach(t => {
    const cat = categoryById(t.categoryId);
    const acc = accountById(t.accountId);
    const row = document.createElement('div');
    row.className = 'tx-row';
    row.innerHTML = `
      <div class="tx-main">
        <span class="tx-desc">${escapeHtml(t.description)}</span>
        <span class="tx-meta">${formatDate(t.date)} · ${acc ? acc.name : ''} · ${cat ? cat.name : ''}</span>
      </div>
      <span class="tx-amount ${t.isIncome ? 'income' : 'expense'}">${t.isIncome ? '+' : '−'}${state.currency}${t.amount.toLocaleString(undefined,{minimumFractionDigits:2})}</span>`;
    row.addEventListener('click', () => openTxModal(t));
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
function renderTrends() {
  const points = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const txs = txInMonth(d.getFullYear(), d.getMonth());
    points.push({
      label: d.toLocaleDateString(undefined, { month: 'short' }),
      income: txs.filter(t => t.isIncome).reduce((s,t) => s+t.amount, 0),
      expense: txs.filter(t => !t.isIncome).reduce((s,t) => s+t.amount, 0),
    });
  }
  Charts.trendChart(document.getElementById('trendChart'), points, state.currency);

  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);
  const recentTxs = state.transactions.filter(t => new Date(t.date+'T00:00:00') >= sixMonthsAgo && !t.isIncome);
  const byCat = {};
  recentTxs.forEach(t => { byCat[t.categoryId] = (byCat[t.categoryId]||0) + t.amount; });
  const items = Object.entries(byCat).map(([id, value]) => {
    const c = categoryById(id);
    return { label: c ? c.name : 'Other', value, color: c ? c.color : '#8A8A7C' };
  }).sort((a,b) => b.value - a.value).slice(0, 8);
  Charts.barList(document.getElementById('trendCategoryList'), items, state.currency);
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
  const { y, m } = state.currentMonth;
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
  state.categories.filter(c => c.id !== 'cat-income').forEach(c => {
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

  document.querySelectorAll('[data-budget-edit]').forEach(el => {
    el.addEventListener('click', () => openBudgetEditor(el.dataset.budgetEdit));
  });
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
  let { y, m } = state.currentMonth;
  m--; if (m < 0) { m = 11; y--; }
  state.currentMonth = { y, m };
  renderBudgets();
});
document.getElementById('budgetMonthNext').addEventListener('click', () => {
  let { y, m } = state.currentMonth;
  m++; if (m > 11) { m = 0; y++; }
  state.currentMonth = { y, m };
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
  renderTxList(document.getElementById('txFullList'), txs);
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

/* ---------------- TRANSACTION MODAL ---------------- */
function populateAccountSelects() {
  const selects = [document.getElementById('txAccount'), document.getElementById('uploadAccount'), document.getElementById('txFilterAccount')];
  selects.forEach(sel => {
    const isFilter = sel.id === 'txFilterAccount';
    const keep = isFilter ? '<option value="">All accounts</option>' : '';
    sel.innerHTML = keep + state.accounts.map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
  });
}
function populateCategorySelects() {
  const selects = [document.getElementById('txCategory'), document.getElementById('txFilterCategory')];
  selects.forEach(sel => {
    const isFilter = sel.id === 'txFilterCategory';
    const keep = isFilter ? '<option value="">All categories</option>' : '';
    sel.innerHTML = keep + state.categories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
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

  const record = { id, description, amount: Math.abs(amount), date, accountId, categoryId, isIncome };
  await DB.put('transactions', record);
  await Categorize.learn(description, categoryId);

  const idx = state.transactions.findIndex(t => t.id === id);
  if (idx >= 0) state.transactions[idx] = record; else state.transactions.push(record);
  closeSheet('txModal');
  renderView(state.activeView);
  toast('Saved');
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

  const catWrap = document.getElementById('categoryList');
  catWrap.innerHTML = '';
  state.categories.forEach(c => {
    const total = state.transactions.filter(t => t.categoryId === c.id).reduce((s,t)=>s+t.amount,0);
    const protectedCat = c.id === 'cat-other' || c.id === 'cat-income';
    const row = document.createElement('div');
    row.className = 'rank-row';
    row.innerHTML = `
      <div class="rank-left"><span class="swatch" style="background:${c.color}"></span><span class="rank-name">${escapeHtml(c.name)}</span></div>
      <div class="row-actions"><span class="rank-value">${state.currency}${total.toLocaleString(undefined,{maximumFractionDigits:0})}</span>
      ${protectedCat ? '' : `<button class="tiny-btn" data-del-cat="${c.id}">Remove</button>`}</div>`;
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
      renderAccountsView();
      toast('Category removed');
    });
  });

  renderRuleList();
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

document.getElementById('addCategoryBtn').addEventListener('click', () => {
  openPrompt({
    title: 'Add category', label: 'Category name', withColor: true,
    onSave: async (name, color) => {
      const cat = { id: DB.uuid(), name, color };
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
  const existingKeys = new Set(state.transactions.map(t => `${t.accountId}|${t.date}|${t.amount}|${t.description.toLowerCase()}`));

  for (const file of files) {
    statusEl.textContent = `Opening ${file.name}…`;
    try {
      const candidates = await Parse.parseStatement(file, (s) => { statusEl.textContent = s; });
      for (const c of candidates) {
        const key = `${accountId}|${c.date}|${c.amount}|${c.description.toLowerCase()}`;
        if (existingKeys.has(key)) { skipped++; continue; }
        existingKeys.add(key);
        const categoryId = await Categorize.suggestCategory(c.description, c.isIncome);
        const record = { id: DB.uuid(), description: c.description, amount: c.amount, date: c.date, accountId, categoryId, isIncome: c.isIncome };
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
    version: 1,
    exportedAt: new Date().toISOString(),
    accounts: state.accounts,
    categories: state.categories,
    transactions: state.transactions,
    rules: await DB.getAll('rules'),
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
