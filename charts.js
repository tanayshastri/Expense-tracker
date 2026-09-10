/* charts.js — small dependency-free SVG charts */
const Charts = (() => {

  function fmt(n, currency) {
    return currency + Math.round(n).toLocaleString();
  }

  // Horizontal bar list: [{label, value, color}]
  function barList(container, items, currency) {
    container.innerHTML = '';
    if (!items.length) {
      container.innerHTML = '<p class="empty-state">Nothing here yet.</p>';
      return;
    }
    const max = Math.max(...items.map(i => i.value), 1);
    const wrap = document.createElement('div');
    items.forEach(item => {
      const row = document.createElement('div');
      row.style.marginBottom = '10px';
      const pct = Math.max((item.value / max) * 100, 3);
      row.innerHTML = `
        <div style="display:flex;justify-content:space-between;font-size:0.82rem;margin-bottom:4px;">
          <span>${item.label}</span>
          <span style="font-variant-numeric:tabular-nums;color:#6b6a5f;">${fmt(item.value, currency)}</span>
        </div>
        <div style="background:#EFE9D8;border-radius:6px;height:8px;overflow:hidden;">
          <div style="width:${pct}%;height:100%;background:${item.color || '#B98B4E'};border-radius:6px;"></div>
        </div>`;
      wrap.appendChild(row);
    });
    container.appendChild(wrap);
  }

  // Line/area chart for monthly trend: points = [{label, income, expense}]
  function trendChart(container, points, currency) {
    container.innerHTML = '';
    if (!points.length) {
      container.innerHTML = '<p class="empty-state">Not enough data yet.</p>';
      return;
    }
    const W = container.clientWidth || 320, H = 180;
    const padL = 8, padR = 8, padT = 10, padB = 24;
    const maxVal = Math.max(...points.map(p => Math.max(p.income, p.expense)), 1);
    const stepX = (W - padL - padR) / Math.max(points.length - 1, 1);

    function toXY(i, val) {
      const x = padL + i * stepX;
      const y = padT + (1 - val / maxVal) * (H - padT - padB);
      return [x, y];
    }

    function pathFor(key) {
      return points.map((p, i) => {
        const [x, y] = toXY(i, p[key]);
        return (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1);
      }).join(' ');
    }

    const labels = points.map((p, i) => {
      const [x] = toXY(i, 0);
      return `<text x="${x}" y="${H-6}" font-size="9" fill="#8a8a7c" text-anchor="middle">${p.label}</text>`;
    }).join('');

    const svg = `
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg">
        <path d="${pathFor('expense')}" fill="none" stroke="#C1584A" stroke-width="2"/>
        <path d="${pathFor('income')}" fill="none" stroke="#7A9B76" stroke-width="2"/>
        ${points.map((p,i)=>{const [x,y]=toXY(i,p.expense);return `<circle cx="${x}" cy="${y}" r="2.6" fill="#C1584A"/>`;}).join('')}
        ${points.map((p,i)=>{const [x,y]=toXY(i,p.income);return `<circle cx="${x}" cy="${y}" r="2.6" fill="#7A9B76"/>`;}).join('')}
        ${labels}
      </svg>
      <div style="display:flex;gap:14px;justify-content:center;margin-top:6px;font-size:0.75rem;color:#6b6a5f;">
        <span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#7A9B76;margin-right:5px;"></span>Income</span>
        <span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#C1584A;margin-right:5px;"></span>Expenses</span>
      </div>`;
    container.innerHTML = svg;
  }

  return { barList, trendChart };
})();
