/* ระบบขายเศษวัสดุเหลือใช้ (TKF) — Frontend
   หน้าเว็บนี้เป็น public เสมอ (GitHub Pages) จึงไม่มีข้อมูลหรือรหัสผ่านอยู่ในไฟล์นี้
   ทุกอย่างถามไปที่ Apps Script และสิทธิ์ถูกตรวจที่ฝั่งนั้น */

const CONFIG = {
  API: 'https://script.google.com/macros/s/AKfycby6tukJzC1NMnu1xN0nJTBI9p0GHTFK4vlnQs6ogXZYB5LE-oDTKF-ImvdXoCSMM8FQeg/exec',
  THUMB: 320,   // ความกว้างภาพย่อ (px)
  FULL: 1400,   // ความกว้างภาพเต็ม (px)
  QUALITY: 0.82
};

/* หัวกระดาษและผู้ลงนามของแบบฟอร์มที่พิมพ์ออกมา — แก้ข้อความได้ที่นี่ที่เดียว */
const PRINT = {
  title: 'รูปภาพแสดงขั้นตอนการขายผลพลอยได้',
  subtitle: 'โรงงานผลิตอาหารสัตว์บกธารเกษม',
  signers: ['ผู้ขับรถ', 'หน่วยงานธุรการ'],
  // ใบนี้ใช้เซ็นก่อนรถออกนอกโรงงานแล้วส่งบัญชี ตอนนั้นเอกสารแนบยังไม่ครบ จึงไม่พิมพ์ออกมา
  // ชื่อต้องตรงกับชื่อกลุ่มในชีต fields เป๊ะ ถ้าเปลี่ยนชื่อกลุ่มต้องมาแก้ตรงนี้ด้วย
  skipSections: ['เอกสารแนบ'],
  unitField: 'f_qty', unitText: 'กิโลกรัม'
};

const S = {
  token: null, user: null, fields: [], perm: {}, statuses: {}, protected: [],
  view: 'list', status: '', rows: [], rec: null, step: 0, dirty: false,
  up: {},          // fieldId -> { pct, state }  สถานะอัปโหลดที่กำลังวิ่งอยู่
  thumbs: {}       // fileId -> dataURL  กันดึงรูปเดิมซ้ำ
};

const $ = (s, r) => (r || document).querySelector(s);
const el = (t, c, txt) => { const n = document.createElement(t); if (c) n.className = c; if (txt != null) n.textContent = txt; return n; };
const svg = (d, w) => {
  const n = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  n.setAttribute('viewBox', '0 0 24 24'); n.setAttribute('width', w || 20); n.setAttribute('height', w || 20);
  n.setAttribute('fill', 'none'); n.setAttribute('stroke', 'currentColor'); n.setAttribute('stroke-width', '1.8');
  n.innerHTML = d; return n;
};
const ICON = {
  cam: '<path d="M3 8.5A1.5 1.5 0 014.5 7h2L8 5h8l1.5 2h2A1.5 1.5 0 0121 8.5v9A1.5 1.5 0 0119.5 19h-15A1.5 1.5 0 013 17.5v-9z"/><circle cx="12" cy="13" r="3.4"/>',
  check: '<path d="M5 13l4 4 10-10"/>',
  right: '<path d="M9 5l7 7-7 7"/>',
  warn: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16h.01"/>',
  box: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 10h8M8 14h5"/>'
};

/* ──────────────── API ──────────────── */
async function api(action, payload) {
  const body = Object.assign({ action, token: S.token }, payload || {});
  let res;
  try {
    // Content-Type: text/plain ทำให้เป็น "simple request" → เลี่ยง CORS preflight ที่ Apps Script ไม่รองรับ
    res = await fetch(CONFIG.API, {
      method: 'POST', mode: 'cors', redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body)
    });
  } catch (e) {
    throw new Error('ติดต่อเซิร์ฟเวอร์ไม่ได้ — ตรวจการเชื่อมต่อเน็ต หรือ URL ใน app.js');
  }
  return unwrap(await res.text());
}

/** อัปโหลดผ่าน XHR เพื่ออ่านเปอร์เซ็นต์จริง fetch ยังบอกความคืบหน้าขาส่งไม่ได้ */
function apiUpload(payload, onPct) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', CONFIG.API, true);
    xhr.setRequestHeader('Content-Type', 'text/plain;charset=utf-8');
    xhr.upload.onprogress = e => { if (e.lengthComputable && onPct) onPct(Math.round(e.loaded / e.total * 100)); };
    xhr.onload = () => { try { resolve(unwrap(xhr.responseText)); } catch (e) { reject(e); } };
    xhr.onerror = () => reject(new Error('อัปโหลดไม่สำเร็จ — ตรวจการเชื่อมต่อเน็ต'));
    xhr.send(JSON.stringify(Object.assign({ action: 'files.upload', token: S.token }, payload)));
  });
}

function unwrap(text) {
  let out;
  try { out = JSON.parse(text); }
  catch (e) { throw new Error('เซิร์ฟเวอร์ตอบกลับไม่ถูกต้อง (อาจยังไม่ได้ deploy แบบ "ทุกคน")'); }
  if (out.ok === false) {
    if (String(out.error || '').startsWith('AUTH:')) { signOut(out.error.replace('AUTH: ', '')); throw new Error(out.error); }
    throw new Error(out.error || 'เกิดข้อผิดพลาด');
  }
  return out;
}

function toast(msg) {
  const old = $('#toast'); if (old) old.remove();
  const foot = $('#edFoot');
  const lift = (!$('#editor').classList.contains('hide') && foot && foot.offsetHeight) ? foot.offsetHeight + 16 : 24;
  document.body.style.setProperty('--toast-bottom', lift + 'px');
  const t = el('div', null, msg); t.id = 'toast'; t.setAttribute('role', 'status');
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2800);
}

/* ──────────────── เข้า/ออกระบบ ──────────────── */
$('#loginForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  const btn = $('#loginBtn'); btn.disabled = true; btn.textContent = 'กำลังเข้าสู่ระบบ…';
  $('#loginMsg').innerHTML = '';
  try {
    const r = await api('login', { username: $('#u').value, password: $('#p').value });
    S.token = r.token; sessionStorage.setItem('tkf_token', r.token);
    $('#p').value = '';
    await start();
  } catch (e) {
    $('#loginMsg').innerHTML = `<div class="msg-err">${esc(e.message)}</div>`;
  } finally { btn.disabled = false; btn.textContent = 'เข้าสู่ระบบ'; }
});

function signOut(reason) {
  // หลุดกลางคัน (session หมดอายุ) → เก็บสิ่งที่กรอกค้างไว้ก่อน แล้วกู้คืนหลังเข้าระบบใหม่
  if (reason && S.dirty && S.rec) {
    try { sessionStorage.setItem('tkf_draft', JSON.stringify(S.rec)); } catch (e) {}
  }
  S.token = null; S.dirty = false; S.rec = null; S.up = {}; S.thumbs = {};
  sessionStorage.removeItem('tkf_token');
  $('#app').inert = false;
  $('#app').classList.add('hide'); $('#editor').classList.add('hide'); $('#login').classList.remove('hide');
  if (reason) $('#loginMsg').innerHTML = `<div class="msg-err">${esc(reason)}</div>`;
}

$('#btnLogout').addEventListener('click', async () => {
  if (S.dirty && !confirm('มีการแก้ไขที่ยังไม่ได้บันทึก ต้องการออกจากระบบหรือไม่?')) return;
  try { await api('logout'); } catch (e) {}
  signOut();
});

async function start() {
  const b = await api('bootstrap');
  S.user = b.user; S.fields = b.fields; S.perm = b.permissions;
  S.statuses = b.statuses; S.protected = b.protectedFields || [];
  $('#whoName').textContent = b.user.name;
  $('#whoRole').textContent = roleLabel(b.user.role);
  $('#btnSettings').hidden = !(S.perm.fields || S.perm.users);
  $('#login').classList.add('hide'); $('#app').classList.remove('hide');
  buildTabs(); buildDateFilters();
  await switchView('list');
  restoreDraft();
}

function restoreDraft() {
  const raw = sessionStorage.getItem('tkf_draft');
  if (!raw) return;
  sessionStorage.removeItem('tkf_draft');
  try {
    S.rec = JSON.parse(raw); S.dirty = true; S.step = 0;
    openEditor();
    toast('กู้คืนข้อมูลที่กรอกค้างไว้แล้ว — กดบันทึกเพื่อยืนยัน');
  } catch (e) {}
}

const roleLabel = r => ({ admin: 'ผู้ดูแลระบบ', staff: 'พนักงานบริการสำนักงาน', supervisor: 'ผู้จัดการแผนก', manager: 'ผู้จัดการฝ่าย', viewer: 'ผู้ดูอย่างเดียว' }[r] || r);
const statusColor = s => ({ [S.statuses.draft]: 'var(--draft)', [S.statuses.submitted]: 'var(--wait)',
  [S.statuses.reviewed]: 'var(--check)', [S.statuses.complete]: 'var(--done)', [S.statuses.rejected]: 'var(--back)' }[s] || 'var(--draft)');

/* ──────────────── สลับมุมมอง ──────────────── */
$('#viewTabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-v]'); if (b) switchView(b.dataset.v);
});

async function switchView(v) {
  S.view = v;
  document.querySelectorAll('#viewTabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.v === v)));
  $('#viewTitle').textContent = v === 'dash' ? 'แดชบอร์ด' : 'ใบงานขายเศษวัสดุ';
  $('#listFilters').classList.toggle('hide', v !== 'list');
  $('#dashFilters').classList.toggle('hide', v !== 'dash');
  $('#footCreate').classList.toggle('hide', !(v === 'list' && S.perm.write));
  if (v === 'dash') { buildDashFilters(); await loadDash(); } else { await refresh(); }
}

/* ──────────────── แท็บ + ตัวกรอง ──────────────── */
function buildTabs() {
  const tabs = $('#tabs'); tabs.innerHTML = '';
  [['', 'ทั้งหมด']].concat(Object.values(S.statuses).map(v => [v, v])).forEach(([val, label]) => {
    const b = el('button', 'tab'); b.type = 'button'; b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(val === S.status)); b.dataset.v = val;
    const dot = el('span', 'dot'); if (val) dot.style.background = statusColor(val);
    b.append(dot, document.createTextNode(label), el('span', 'n', '0'));
    b.addEventListener('click', () => { S.status = val; buildTabs(); refresh(); });
    tabs.appendChild(b);
  });
}

function yearOptions(sel, allLabel) {
  const now = new Date().getFullYear();
  sel.innerHTML = `<option value="">${allLabel}</option>`;
  for (let i = now; i >= now - 4; i--) sel.insertAdjacentHTML('beforeend', `<option value="${i}">${i + 543}</option>`);
}
const MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
function monthOptions(sel, allLabel) {
  sel.innerHTML = `<option value="">${allLabel}</option>` + MONTHS.map((t, i) => `<option value="${i + 1}">${t}</option>`).join('');
}

function buildDateFilters() {
  yearOptions($('#fYear'), 'ทุกปี'); monthOptions($('#fMonth'), 'ทุกเดือน');
  [$('#fYear'), $('#fMonth')].forEach(s => s.addEventListener('change', refresh));
  let timer; $('#q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(refresh, 350); });
}

function buildDashFilters() {
  if ($('#dYear').options.length) return;
  yearOptions($('#dYear'), 'ทุกปี'); monthOptions($('#dMonth'), 'ทุกเดือน');
  $('#dCat').innerHTML = '<option value="">ทุกหมวด</option>';
  $('#dSup').innerHTML = '<option value="">ทุกซัพพลายเออร์</option>';
  ['#dYear', '#dMonth', '#dCat', '#dSup'].forEach(s => $(s).addEventListener('change', loadDash));
}

/* ──────────────── รายการใบงาน ──────────────── */
async function refresh() {
  const host = $('#viewBody');
  host.innerHTML = '<div class="empty"><b>กำลังโหลด…</b></div>';
  try {
    const r = await api('records.list', {
      status: S.status, q: $('#q').value, year: $('#fYear').value, month: $('#fMonth').value
    });
    S.rows = r.rows;
    document.querySelectorAll('.tab').forEach(t => {
      const v = t.dataset.v;
      $('.n', t).textContent = v ? (r.counts[v] || 0) : Object.values(r.counts).reduce((a, b) => a + b, 0);
    });
    renderList();
  } catch (e) {
    host.innerHTML = `<div class="empty"><b>โหลดข้อมูลไม่สำเร็จ</b><p>${esc(e.message)}</p></div>`;
  }
}

function renderList() {
  const host = $('#viewBody'); host.innerHTML = '';
  if (!S.rows.length) {
    const em = el('div', 'empty');
    em.append(svg(ICON.box, 28), el('b', null, 'ไม่มีใบงานในตัวกรองนี้'),
      el('p', null, 'ลองเปลี่ยนสถานะหรือล้างคำค้น'));
    const c = el('button', 'btn', 'ล้างตัวกรอง');
    c.addEventListener('click', () => {
      $('#q').value = ''; $('#fYear').value = ''; $('#fMonth').value = '';
      S.status = ''; buildTabs(); refresh();
    });
    em.appendChild(c); host.appendChild(em);
    return;
  }
  const cols = S.fields.filter(f => f.in_list && f.visible);
  const total = S.fields.filter(f => f.visible).length || 1;

  S.rows.forEach(row => {
    const color = statusColor(row.status);
    const b = el('button', 'doc'); b.type = 'button'; b.style.borderLeftColor = color;

    const th = el('div', 'thumb');
    th.appendChild(el('span', null, row.photos ? row.photos + ' รูป' : 'ไม่มีรูป'));

    const body = el('div', 'body');
    const l1 = el('div', 'line1');
    l1.appendChild(el('span', 'id', row.id));
    const pill = el('span', 'pill'); pill.style.color = color;
    pill.append(el('span', 'dot'), document.createTextNode(row.status));
    l1.appendChild(pill);
    const waiting = waitingLabel(row);
    if (waiting) { const a = el('span', 'age', waiting.text); a.style.color = waiting.color; l1.appendChild(a); }
    body.appendChild(l1);

    const main = cols.slice(0, 2).map(c => fmtCell(c, row.brief[c.field_id])).filter(v => v !== '—').join(' · ');
    body.appendChild(el('div', 'main', main || '—'));
    // ไม่ต่อวันที่เอกสารท้ายแถวถ้ามีคอลัมน์ชนิดวันที่แสดงอยู่แล้ว ไม่งั้นการ์ดจะขึ้นวันเดียวกันสองที่
    const hasDateCol = cols.some(c => c.type === 'date' && row.brief[c.field_id]);
    const meta = cols.slice(2).map(c => fmtCell(c, row.brief[c.field_id])).filter(v => v !== '—')
      .concat([!hasDateCol && row.doc_date ? thaiDate(row.doc_date) : '']).filter(Boolean).join(' · ');
    body.appendChild(el('div', 'meta', meta || 'แก้ไขล่าสุด ' + row.updated_at));

    const done = Math.round((row.filled || 0) / total * 100);
    const pr = el('div', 'prow');
    const bar = el('div', 'pbar'); const fill = el('i');
    fill.style.width = done + '%'; fill.style.background = color; bar.appendChild(fill);
    pr.append(bar, el('span', null, (row.filled || 0) + '/' + total));
    body.appendChild(pr);

    b.append(th, body);
    b.addEventListener('click', () => openRecord(row.id));
    host.appendChild(b);
  });
}

function fmtCell(col, v) {
  if (v == null || v === '') return '—';
  if (col.type === 'date') return thaiDate(v);
  if (col.type === 'number') { const x = Number(String(v).replace(/,/g, '')); if (!isNaN(x)) return nf(x); }
  return String(v);
}

/** เอกสารที่รอคนเซ็นอยู่ ควรบอกว่ารอมานานแค่ไหน ไม่ใช่แค่วันที่ดิบ */
function waitingLabel(row) {
  if ([S.statuses.submitted, S.statuses.reviewed].indexOf(row.status) < 0) return null;
  if (!row.updated_ms) return null;
  const d = Math.floor((Date.now() - row.updated_ms) / 86400000);
  if (d <= 0) return { text: 'รอมาวันนี้', color: 'var(--muted)' };
  return { text: 'รอมา ' + d + ' วัน', color: d > 7 ? 'var(--back)' : d > 3 ? 'var(--wait)' : 'var(--muted)' };
}

$('#btnNew').addEventListener('click', () => openRecord(null));

/* ──────────────── แดชบอร์ด ──────────────── */
const nf = n => Number(n || 0).toLocaleString('th-TH', { maximumFractionDigits: 0 });

async function loadDash() {
  const host = $('#viewBody');
  host.innerHTML = '<div class="empty"><b>กำลังโหลด…</b></div>';
  try {
    const d = await api('dashboard', {
      year: $('#dYear').value, month: $('#dMonth').value,
      cat: $('#dCat').value, supplier: $('#dSup').value
    });
    syncOptions($('#dCat'), d.catOptions, 'ทุกหมวด');
    syncOptions($('#dSup'), d.supOptions, 'ทุกซัพพลายเออร์');
    renderDash(d);
  } catch (e) {
    host.innerHTML = `<div class="empty"><b>โหลดแดชบอร์ดไม่สำเร็จ</b><p>${esc(e.message)}</p></div>`;
  }
}

function syncOptions(sel, list, allLabel) {
  const cur = sel.value;
  sel.innerHTML = `<option value="">${allLabel}</option>` +
    (list || []).map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
  sel.value = cur;
  if (sel.value !== cur) sel.value = '';   // ตัวเลือกเดิมหายไปแล้ว (ข้อมูลถูกลบ) → กลับไปทุกหมวด
}

function renderDash(d) {
  const host = $('#viewBody'); host.innerHTML = '';
  if (!d.docs) {
    const em = el('div', 'empty');
    em.append(el('b', null, 'ไม่มีข้อมูลในช่วงที่เลือก'));
    const c = el('button', 'btn', 'ล้างตัวกรอง');
    c.addEventListener('click', () => { ['#dYear', '#dMonth', '#dCat', '#dSup'].forEach(s => $(s).value = ''); loadDash(); });
    em.appendChild(c); host.appendChild(em); return;
  }
  const late = d.aging.late;
  host.appendChild(kpiGrid([
    { label: 'ใบงานทั้งหมด', value: nf(d.docs), unit: 'ใบ', note: 'ในช่วงที่เลือก', noteColor: 'var(--muted)' },
    { label: 'น้ำหนักรวม', value: nf(d.weight), unit: 'กก.', note: 'จากช่องปริมาณ', noteColor: 'var(--muted)' },
    { label: 'รอดำเนินการ', value: nf(d.waiting), unit: 'ใบ', note: 'รอตรวจ/รออนุมัติ', noteColor: 'var(--wait)' },
    { label: 'ค้างเกิน 7 วัน', value: nf(late), unit: 'ใบ',
      note: late ? 'ต้องตามเร่ง' : 'ไม่มีใบค้าง', noteColor: late ? 'var(--back)' : 'var(--done)' }
  ]));

  if (d.months.length) {
    const p = panel('น้ำหนักขายรายเดือน', d.months.length + ' เดือนล่าสุด');
    const max = Math.max.apply(null, d.months.map(m => m.value)) || 1;
    const bars = el('div', 'bars');
    d.months.forEach(m => {
      const c = el('div', 'col');
      const i = el('i'); i.style.height = Math.max(4, Math.round(m.value / max * 150)) + 'px';
      c.append(el('b', null, nf(m.value)), i, el('small', null, monthShort(m.name)));
      bars.appendChild(c);
    });
    p.appendChild(bars); host.appendChild(p);
  }

  const mixTotal = Object.values(d.statusCount).reduce((a, b) => a + b, 0) || 1;
  const p2 = panel('สถานะใบงาน', mixTotal + ' ใบ');
  const mix = el('div', 'mix');
  Object.keys(d.statusCount).forEach(k => {
    if (!d.statusCount[k]) return;
    const i = el('div'); i.style.flex = d.statusCount[k]; i.style.background = statusColor(k); mix.appendChild(i);
  });
  p2.appendChild(mix);
  Object.keys(d.statusCount).forEach(k => {
    const row = el('div', 'legend');
    const sw = el('span', 'sw'); sw.style.background = statusColor(k);
    row.append(sw, el('span', 'nm', k), el('span', 'pc', Math.round(d.statusCount[k] / mixTotal * 100) + '%'),
      el('span', 'n', String(d.statusCount[k])));
    p2.appendChild(row);
  });
  host.appendChild(p2);

  if (d.waiting) {
    const p3 = panel('อายุใบงานที่รอดำเนินการ');
    const maxA = Math.max(d.aging.fresh, d.aging.warn, d.aging.late) || 1;
    [['ไม่เกิน 3 วัน', d.aging.fresh, 'var(--done)'], ['4–7 วัน', d.aging.warn, 'var(--wait)'],
     ['เกิน 7 วัน', d.aging.late, 'var(--back)']].forEach(([lab, n, col]) => {
      const r = el('div', 'hrow');
      const tr = el('div', 'track'); const i = el('i');
      i.style.width = Math.round(n / maxA * 100) + '%'; i.style.background = col; tr.appendChild(i);
      r.append(el('div', 'lab', lab), tr, el('div', 'n', String(n)));
      p3.appendChild(r);
    });
    host.appendChild(p3);
  }

  if (d.suppliers.length) host.appendChild(rankPanel('ซัพพลายเออร์ตามน้ำหนัก', d.suppliers));
  if (d.cats.length) host.appendChild(rankPanel('รายการสินค้าตามน้ำหนัก', d.cats));
}

function panel(title, right) {
  const p = el('div', 'panel');
  const h = el('div', 'head');
  h.appendChild(el('h3', null, title));
  if (right) h.appendChild(el('div', 'sub', right));
  p.appendChild(h); return p;
}

function rankPanel(title, list) {
  const p = panel(title);
  const max = Math.max.apply(null, list.map(x => x.value)) || 1;
  list.forEach(x => {
    const r = el('div', 'rank');
    const t = el('div', 't');
    t.append(el('span', null, x.name), el('span', null, nf(x.value) + ' กก.'));
    const tr = el('div', 'track'); const i = el('i');
    i.style.width = Math.round(x.value / max * 100) + '%'; tr.appendChild(i);
    r.append(t, tr); p.appendChild(r);
  });
  return p;
}

function kpiGrid(items) {
  const g = el('div', 'kpis');
  items.forEach(k => {
    const c = el('div', 'kpi');
    const v = el('div', 'val', k.value);
    v.appendChild(el('span', 'unit', ' ' + k.unit));
    const note = el('div', 'knote', k.note); note.style.color = k.noteColor;
    c.append(el('div', 'label', k.label), v, note);
    g.appendChild(c);
  });
  return g;
}

const monthShort = key => {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  return m ? MONTHS[Number(m[2]) - 1] : key;
};

/* ──────────────── หน้าเอกสาร: แบ่งเป็นขั้น ──────────────── */
/** จัดกลุ่มช่องตาม section — จำนวนขั้นมาจากข้อมูลจริง ไม่ได้ล็อกไว้ที่ 5 */
function sections() {
  const out = [];
  S.fields.filter(f => f.visible).forEach(f => {
    let g = out.find(x => x.name === f.section);
    if (!g) { g = { name: f.section, items: [] }; out.push(g); }
    g.items.push(f);
  });
  return out;
}
const filledIn = items => items.filter(f => S.rec.data[f.field_id]).length;
const canEdit = () => S.perm.write && (S.user.role === 'admin' ||
  [S.statuses.draft, S.statuses.rejected].indexOf(S.rec.status) >= 0);

async function openRecord(id) {
  if (id) {
    try { const r = await api('records.get', { id }); S.rec = r.record; }
    catch (e) { return toast(e.message); }
  } else {
    S.rec = { id: null, status: S.statuses.draft, data: {}, sign: {}, created_by: S.user.username };
  }
  S.dirty = false; S.up = {};
  S.step = canEdit() ? 0 : sections().length;   // ผู้ตรวจ/ผู้อนุมัติเปิดมาที่หน้าตรวจทานเลย
  openEditor();
  if (id) loadThumbs();
}

function openEditor() {
  S.returnFocus = document.activeElement;
  renderEditor();
  $('#editor').classList.remove('hide');
  $('#app').inert = true;
  $('#edClose').focus();
}

$('#edClose').addEventListener('click', closeEditor);
/** ลูกศรบนหัวออกจากเอกสารเสมอ การถอยทีละขั้นเป็นหน้าที่ของปุ่ม "ย้อนกลับ" ที่แถบล่าง
 *  ถ้าให้ปุ่มเดียวทำสองอย่าง คนที่อยู่ขั้น 4 ต้องกดถึง 5 ครั้งกว่าจะออกได้ */
function closeEditor() {
  if (S.dirty && !confirm('มีการแก้ไขที่ยังไม่ได้บันทึก ต้องการออกโดยไม่บันทึกหรือไม่?')) return;
  S.dirty = false; S.rec = null; S.up = {};
  $('#editor').classList.add('hide'); $('#app').inert = false;
  if (S.returnFocus && document.contains(S.returnFocus)) S.returnFocus.focus();
  S.returnFocus = null;
  if (S.view === 'dash') loadDash(); else refresh();
}

function goStep(n) { S.step = n; renderEditor(); $('#edBody').scrollTop = 0; loadThumbs(); }

function renderEditor() {
  if (!S.rec) return;
  const secs = sections();
  const reviewStep = secs.length;
  if (S.step > reviewStep) S.step = reviewStep;
  const color = statusColor(S.rec.status);

  $('#edTitle').textContent = S.rec.id || 'ใบงานใหม่';
  $('#edHint').textContent = S.rec.id ? ('แก้ไขล่าสุด ' + (S.rec.updated_at || '—')) : 'ยังไม่ได้บันทึก';
  const st = $('#edStatus'); st.textContent = ''; st.style.color = color;
  st.append(el('span', 'dot'), document.createTextNode(S.rec.status));

  renderSteps(secs, reviewStep);
  const body = $('#edBody'); body.innerHTML = '';
  if (S.step === reviewStep) renderReview(secs); else renderStep(secs[S.step]);
  renderFooter(secs, reviewStep);
}

function renderSteps(secs, reviewStep) {
  const host = $('#edSteps'); host.innerHTML = '';
  const total = S.fields.filter(f => f.visible).length || 1;
  const done = filledIn(S.fields.filter(f => f.visible));

  const row = el('div', 'steprow');
  secs.concat([{ name: 'ตรวจทาน', items: [] }]).forEach((g, i) => {
    const b = el('button'); b.type = 'button';
    b.dataset.on = i === S.step ? '1' : '0';
    b.dataset.done = (i < reviewStep && g.items.length && filledIn(g.items) === g.items.length) ? '1' : '0';
    b.append(el('i'), el('span', null, shortName(g.name, i)));
    b.title = g.name;
    b.addEventListener('click', () => goStep(i));
    row.appendChild(b);
  });
  host.appendChild(row);

  const cur = S.step === reviewStep ? { name: 'ตรวจทานก่อนส่ง', items: [] } : secs[S.step];
  const h = el('div', 'ed-h');
  h.append(el('b', null, cur.name), el('small', null, 'ขั้นที่ ' + (S.step + 1) + ' / ' + (reviewStep + 1)));
  host.appendChild(h);

  const pr = el('div', 'prow');
  const bar = el('div', 'pbar'); const fill = el('i');
  fill.style.width = Math.round(done / total * 100) + '%'; bar.appendChild(fill);
  pr.append(bar, el('span', null, done + ' / ' + total + ' ช่อง'));
  host.appendChild(pr);

  const remain = el('div', 'remain');
  if (cur.items.length) {
    const left = cur.items.length - filledIn(cur.items);
    remain.textContent = left ? ('ขั้นนี้เหลืออีก ' + left + ' ช่อง') : '';
    if (!left) { remain.textContent = 'ขั้นนี้ครบแล้ว'; remain.style.color = 'var(--done)'; }
    else remain.style.color = 'var(--wait)';
  }
  host.appendChild(remain);
}

const shortName = (n, i) => (i + 1) + '. ' + String(n).replace(/^ภาพ/, '').replace(/ดำเนินการ$/, '').trim();

function renderStep(g) {
  if (!g) return;
  const body = $('#edBody');
  const ed = canEdit();
  const allPhotos = g.items.every(f => f.type === 'image');

  if (allPhotos) {
    const grid = el('div', 'slots' + (g.items.length === 1 ? ' one' : ''));
    g.items.forEach(f => grid.appendChild(photoSlot(f, ed)));
    body.appendChild(grid);
    if (ed) {
      const n = el('div', 'note');
      n.append(svg(ICON.warn, 20), el('div', null, 'ถ่ายต่อได้เลย ระบบอัปโหลดเบื้องหลัง ไม่ต้องรอทีละรูป'));
      $('svg', n).style.color = 'var(--wait)';
      body.appendChild(n);
    }
    return;
  }
  g.items.forEach(f => body.appendChild(f.type === 'image' ? photoSlot(f, ed) : inputField(f, ed)));
}

function inputField(f, ed) {
  const lab = el('label', 'field');
  lab.appendChild(el('span', null, f.label + (f.required ? ' *' : '')));
  let inp;
  if (f.type === 'textarea') inp = el('textarea');
  else if (f.type === 'select') {
    inp = el('select');
    inp.innerHTML = '<option value="">— เลือก —</option>' + f.options.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
  } else {
    inp = el('input');
    inp.type = f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text';
    if (f.type === 'number') inp.inputMode = 'decimal';
  }
  inp.value = S.rec.data[f.field_id] || '';
  inp.disabled = !ed;
  inp.addEventListener('input', () => { S.rec.data[f.field_id] = inp.value; S.dirty = true; });
  inp.addEventListener('change', () => { S.rec.data[f.field_id] = inp.value; S.dirty = true; renderSteps(sections(), sections().length); });
  lab.appendChild(inp);
  return lab;
}

/* ──────────────── ช่องรูป + คิวอัปโหลด ──────────────── */
function photoSlot(f, ed) {
  const wrap = el('div', 'slot');
  const v = S.rec.data[f.field_id];
  const up = S.up[f.field_id];

  const btn = el('button'); btn.type = 'button'; btn.id = 'ph_' + f.field_id;
  if (v && v.thumb) {
    btn.classList.add('filled');
    const cached = S.thumbs[v.thumb];
    if (cached) { const img = el('img'); img.src = cached; img.alt = f.label; btn.appendChild(img); }
    const ok = el('span', 'ok'); ok.appendChild(svg(ICON.check, 16));
    $('svg', ok).setAttribute('stroke', '#fff'); $('svg', ok).setAttribute('stroke-width', '2.4');
    btn.appendChild(ok);
    btn.setAttribute('aria-label', 'ดูรูป ' + f.label + ' ขนาดเต็ม');
  } else if (!up) {
    btn.append(svg(ICON.cam, 30), el('span', null, ed ? 'ถ่ายรูป' : 'ไม่มีรูป'));
    btn.disabled = !ed;
    btn.setAttribute('aria-label', 'แนบรูป ' + f.label);
  }
  if (up) {
    const ov = el('span', 'up'); ov.setAttribute('role', 'status');
    const tr = el('span', 'track'); const i = el('i'); i.style.width = up.pct + '%'; tr.appendChild(i);
    ov.append(tr, el('span', null, up.state === 'resize' ? 'กำลังย่อรูป…' : 'กำลังอัปโหลด ' + up.pct + '%'));
    btn.appendChild(ov);
  }
  btn.addEventListener('click', () => {
    const cur = S.rec.data[f.field_id];
    if (cur && cur.full) return showFull(cur.full);
    if (ed && !up) pickPhoto(f);
  });
  wrap.appendChild(btn);

  if (v && ed && !up) {
    const rm = el('button', 'rm', 'ลบ'); rm.type = 'button';
    rm.setAttribute('aria-label', 'ลบรูป ' + f.label);
    rm.addEventListener('click', e => {
      e.stopPropagation();
      if (!confirm('ลบรูป "' + f.label + '" ?')) return;
      delete S.rec.data[f.field_id]; S.dirty = true;
      queueSave(); renderEditor();
    });
    wrap.appendChild(rm);
  }
  wrap.appendChild(el('div', 'cap', f.label));
  return wrap;
}

function pickPhoto(f) {
  const inp = el('input'); inp.type = 'file'; inp.accept = 'image/*';
  inp.addEventListener('change', () => { if (inp.files[0]) enqueueUpload(f, inp.files[0]); });
  inp.click();
}

/* คิวอัปโหลดทีละไฟล์ — ผู้ใช้ถ่ายรูปถัดไปได้ทันทีโดยไม่ต้องรอ
   ทำทีละคำขอเพราะฝั่ง Apps Script ลบแถวทะเบียนไฟล์ตามเลขดัชนี ยิงพร้อมกันแล้วดัชนีจะเลื่อนชนกัน */
let upChain = Promise.resolve();
function enqueueUpload(f, file) {
  S.up[f.field_id] = { pct: 0, state: 'resize' };
  S.dirty = true;
  renderEditor();
  upChain = upChain.then(() => runUpload(f, file)).catch(() => {});
  return upChain;
}

async function runUpload(f, file) {
  const paint = () => { const s = $('#ph_' + f.field_id); if (s) renderEditor(); };
  try {
    if (!S.rec.id) await queueSave();                       // ต้องมีเอกสารก่อนจึงแนบไฟล์ได้
    const full = await resize(file, CONFIG.FULL);
    const thumb = await resize(file, CONFIG.THUMB);
    S.up[f.field_id] = { pct: 0, state: 'upload' }; paint();
    const r = await apiUpload(
      { recordId: S.rec.id, fieldId: f.field_id, mime: 'image/jpeg', full: full.b64, thumb: thumb.b64 },
      pct => { if (S.up[f.field_id]) { S.up[f.field_id].pct = pct; paint(); } }
    );
    S.thumbs[r.thumb] = 'data:image/jpeg;base64,' + thumb.b64;   // ใช้ภาพในเครื่องเลย ไม่ต้องดึงกลับ
    S.rec.data[f.field_id] = { full: r.full, thumb: r.thumb, name: file.name };
    delete S.up[f.field_id];
    await queueSave();
    renderEditor();
  } catch (e) {
    delete S.up[f.field_id];
    renderEditor();
    toast('รูป "' + f.label + '": ' + e.message);
  }
}

function resize(file, maxW) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxW / img.width);
      const c = el('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve({ b64: c.toDataURL('image/jpeg', CONFIG.QUALITY).split(',')[1] });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('ไฟล์นี้ไม่ใช่รูปภาพที่เปิดได้')); };
    img.src = url;
  });
}

/** ดึงภาพย่อที่ยังไม่มีในเครื่องด้วยคำขอเดียว */
async function loadThumbs() {
  if (!S.rec) return;
  const ids = S.fields.filter(f => f.type === 'image')
    .map(f => S.rec.data[f.field_id]).filter(v => v && v.thumb && !S.thumbs[v.thumb]).map(v => v.thumb);
  if (!ids.length) return;
  try {
    const r = await api('files.batch', { ids });
    Object.keys(r.files).forEach(id => { if (r.files[id]) S.thumbs[id] = r.files[id]; });
    if (S.rec) renderEditor();
  } catch (e) { /* ไม่มีภาพย่อไม่ใช่เรื่องคอขาดบาดตาย ปล่อยให้ใช้งานต่อได้ */ }
}

async function showFull(id) {
  const lb = el('div'); lb.id = 'lightbox';
  lb.appendChild(el('div', null, 'กำลังโหลดภาพ…'));
  const close = el('button', 'btn', 'ปิด');
  close.addEventListener('click', () => lb.remove());
  lb.appendChild(close);
  lb.addEventListener('click', e => { if (e.target === lb) lb.remove(); });
  document.body.appendChild(lb);
  try {
    const r = await api('files.batch', { ids: [id] });
    const img = el('img'); img.src = r.files[id]; img.alt = '';
    lb.firstChild.replaceWith(img);
  } catch (e) { lb.firstChild.textContent = e.message; }
}

/* ──────────────── หน้าตรวจทาน ──────────────── */
function renderReview(secs) {
  const body = $('#edBody');
  const visible = S.fields.filter(f => f.visible);
  const total = visible.length || 1;
  const done = filledIn(visible);
  const missing = visible.filter(f => f.required && !S.rec.data[f.field_id]);

  const p = el('div', 'panel');
  const h = el('div', 'head');
  const right = el('div'); right.style.cssText = 'font-size:15px;font-weight:600;color:var(--primary)';
  right.textContent = done + ' / ' + total + ' ช่อง';
  h.append(el('h3', null, 'ความครบของใบงาน'), right);
  const bar = el('div', 'pbar'); bar.style.height = '8px';
  const fill = el('i'); fill.style.width = Math.round(done / total * 100) + '%'; bar.appendChild(fill);
  const hint = el('div', 'sub');
  hint.textContent = missing.length
    ? 'ยังไม่ได้กรอก: ' + missing.slice(0, 4).map(f => f.label).join(', ') + (missing.length > 4 ? ` และอีก ${missing.length - 4} ช่อง` : '') + ' — ส่งตรวจได้ แต่ผู้ตรวจอาจตีกลับ'
    : 'กรอกครบทุกช่องที่ทำเครื่องหมายไว้แล้ว';
  p.append(h, bar, hint);
  body.appendChild(p);

  secs.forEach((g, i) => {
    const n = filledIn(g.items), all = n === g.items.length;
    const b = el('button', 'steplink'); b.type = 'button';
    const mk = el('span', 'mk' + (all ? ' done' : ''));
    if (all) mk.appendChild(svg(ICON.check, 16)); else mk.textContent = String(i + 1);
    const tx = el('span', 'tx');
    const detail = el('small', null, all ? 'ครบ ' + n + ' / ' + g.items.length : n + ' / ' + g.items.length + ' — ยังไม่ครบ');
    if (!all) detail.style.color = 'var(--wait)';
    tx.append(el('b', null, g.name), detail);
    b.append(mk, tx, svg(ICON.right, 22));
    b.addEventListener('click', () => goStep(i));
    body.appendChild(b);
  });

  const sp = el('div', 'panel');
  sp.appendChild(el('h3', null, 'ลายเซ็น — ระบบประทับให้อัตโนมัติ'));
  const grid = el('div', 'signs');
  const sg = S.rec.sign || {};
  [['จัดทำ', sg.staff], ['ตรวจสอบ', sg.supervisor], ['รับทราบ', sg.manager]].forEach(([role, val]) => {
    const c = el('div', 'sign' + (val ? ' on' : ''));
    const parts = String(val || '').split(') ');
    c.append(el('div', 'r', role),
      el('div', 'nm', val ? parts[0] + (parts.length > 1 ? ')' : '') : '—'),
      el('div', 'tm', val && parts.length > 1 ? parts.slice(1).join(') ') : 'ยังไม่ได้เซ็น'));
    if (!val) $('.nm', c).style.color = 'var(--muted)';
    grid.appendChild(c);
  });
  sp.appendChild(grid);
  body.appendChild(sp);

  if (S.rec.note) {
    const np = el('div', 'panel');
    np.append(el('h3', null, 'เหตุผลการตีกลับ'), el('div', 'sub', S.rec.note));
    $('.sub', np).style.color = 'var(--back)';
    body.appendChild(np);
  }
}

/* ──────────────── ปุ่มดำเนินการ ──────────────── */
function renderFooter(secs, reviewStep) {
  const foot = $('#edFoot'); foot.innerHTML = '';
  const ed = canEdit();

  if (S.step < reviewStep) {
    const row = el('div', 'row');
    if (S.step > 0) row.appendChild(mkBtn('ย้อนกลับ', 'btn', () => goStep(S.step - 1)));
    const next = mkBtn(S.step === reviewStep - 1 ? 'ตรวจทานก่อนส่ง' : 'ถัดไป · ' + secs[S.step + 1].name,
      'btn btn-primary', () => goStep(S.step + 1));
    next.appendChild(svg(ICON.right, 20));
    next.style.flex = '1.6';
    row.appendChild(next);
    foot.appendChild(row);
    if (ed) foot.appendChild(mkBtn('บันทึกร่าง', 'btn', () => queueSave().then(() => toast('บันทึกแล้ว ' + S.rec.id))));
    return;
  }

  const row = el('div', 'row');
  const rec = S.rec;
  if (ed) {
    row.appendChild(mkBtn('บันทึกร่าง', 'btn', () => queueSave().then(() => toast('บันทึกแล้ว ' + rec.id))));
    if (S.perm.submit) row.appendChild(mkBtn('ส่งตรวจสอบ', 'btn btn-primary', async () => {
      await queueSave(); await move(S.statuses.submitted);
    }));
  }
  if (S.perm.review && rec.status === S.statuses.submitted) {
    row.appendChild(mkBtn('ตีกลับ', 'btn btn-danger', () => move(S.statuses.rejected)));
    row.appendChild(mkBtn('ตรวจผ่าน', 'btn btn-primary', () => move(S.statuses.reviewed)));
  }
  if (S.perm.approve && rec.status === S.statuses.reviewed) {
    row.appendChild(mkBtn('ตีกลับ', 'btn btn-danger', () => move(S.statuses.rejected)));
    row.appendChild(mkBtn('อนุมัติ', 'btn btn-primary', () => move(S.statuses.complete)));
  }
  if (row.children.length) foot.appendChild(row);

  const row2 = el('div', 'row');
  if (rec.id) row2.appendChild(mkBtn('🖨 พิมพ์', 'btn', openPrint));
  if (S.user.role === 'admin' && rec.id && rec.status !== S.statuses.draft)
    row2.appendChild(mkBtn('ดึงกลับเป็นร่าง', 'btn', () => move(S.statuses.draft)));
  if (S.perm.del && rec.id) row2.appendChild(mkBtn('ลบเอกสาร', 'btn btn-danger', async () => {
    if (!confirm('ลบเอกสาร ' + rec.id + ' และรูปทั้งหมด?\n\nลบแล้วกู้คืนไม่ได้')) return;
    try { await api('records.delete', { id: rec.id }); S.dirty = false; closeEditor(); toast('ลบแล้ว'); }
    catch (e) { toast(e.message); }
  }));
  if (row2.children.length) foot.appendChild(row2);
}

function mkBtn(label, cls, fn) {
  const b = el('button', cls, label);
  b.addEventListener('click', async () => {
    const all = $('#edFoot').querySelectorAll('button');
    all.forEach(x => { x.disabled = true; });
    const prev = b.textContent; b.textContent = 'กำลังทำงาน…';
    try { await fn(); } catch (e) { /* ข้อความแจ้งผู้ใช้ถูกจัดการใน fn แล้ว */ }
    finally { if (document.contains(b)) { b.textContent = prev; all.forEach(x => { x.disabled = false; }); } }
  });
  return b;
}

/* บันทึกทีละคำขอตามลำดับ — รูปที่อัปเสร็จระหว่างรอจะได้ไม่ถูกคำขอเก่าเขียนทับ */
let saveChain = Promise.resolve();
function queueSave() {
  saveChain = saveChain.then(() => doSave());
  return saveChain;
}

async function doSave() {
  if (!S.rec) return;
  S.dirty = false;                       // แก้ระหว่างรอคำตอบจะตั้ง dirty กลับเป็น true เอง
  try {
    const r = await api('records.save', { record: { id: S.rec.id, data: S.rec.data } });
    if (!S.rec) return;
    // รับเฉพาะข้อมูลกำกับ ไม่เอา data กลับมาทับ ไม่งั้นรูปที่เพิ่งอัปเสร็จระหว่างรอจะหาย
    const k = r.record;
    S.rec.id = k.id; S.rec.status = k.status; S.rec.updated_at = k.updated_at;
    S.rec.created_by = k.created_by; S.rec.sign = k.sign; S.rec.note = k.note;
  } catch (e) { S.dirty = true; toast(e.message); throw e; }
}

async function move(to) {
  let note = '';
  if (to === S.statuses.rejected) {
    note = prompt('ระบุเหตุผลที่ตีกลับ (ผู้จัดทำจะเห็นข้อความนี้)') || '';
    if (!note.trim()) return;
  }
  try {
    const r = await api('records.move', { id: S.rec.id, to, note });
    Object.assign(S.rec, r.record);
    S.step = sections().length;
    renderEditor();
    toast('เปลี่ยนสถานะเป็น ' + to);
  } catch (e) { toast(e.message); }
}

/* ──────────────── พิมพ์แบบฟอร์ม A4 ──────────────── */
/* พิมพ์ได้ทุกสถานะ ไม่ต้องรอส่งตรวจหรืออนุมัติ — ใบงานที่บันทึกแล้วพิมพ์ได้ทันที */
async function openPrint() {
  if (!S.rec || !S.rec.id) { toast('บันทึกใบงานก่อนจึงจะพิมพ์ได้'); return; }
  const rec = S.rec;
  const secs = sections().filter(g => PRINT.skipSections.indexOf(g.name) < 0);

  const pv = $('#printview'); pv.innerHTML = ''; pv.classList.remove('hide');
  const bar = el('div', 'pv-bar');
  const btnPrint = el('button', 'btn btn-primary', 'กำลังเตรียมรูป…'); btnPrint.disabled = true;
  const btnClose = el('button', 'btn', 'ปิด');
  btnClose.addEventListener('click', () => { pv.classList.add('hide'); pv.innerHTML = ''; S.fitPage = null; });
  bar.append(btnPrint, btnClose); pv.appendChild(bar);

  const page = el('div', 'page'); pv.appendChild(page);
  fitPage(page); S.fitPage = () => fitPage(page);
  const head = el('div', 'p-head');
  head.append(el('h2', null, PRINT.title), el('h3', null, PRINT.subtitle));
  page.appendChild(head);

  // ข้อมูลหัวเอกสาร: ช่องที่ไม่ใช่รูป เรียงตามลำดับในฟอร์ม
  const info = el('div', 'p-info');
  secs.forEach(g => g.items.filter(f => f.type !== 'image').forEach(f => {
    const raw = rec.data[f.field_id];
    const text = f.type === 'date' ? (raw ? thaiDate(raw) : '') : String(raw == null ? '' : raw);
    // ช่องยาวหรือหลายบรรทัดกินเต็มแถว ไม่งั้นข้อความจะถูกตัดหายในคอลัมน์แคบ
    const wide = f.type === 'textarea' || text.length > 38;
    const row = el('div', 'p-f' + (wide ? ' wide' : ''));
    row.appendChild(el('div', 'lb', f.label + ':'));
    if (f.field_id === PRINT.unitField) {
      const v = el('div', 'vl unit');
      const num = Number(String(text).replace(/,/g, ''));
      v.append(el('span', null, isNaN(num) || !text ? text : nf(num)), el('b', null, PRINT.unitText));
      row.appendChild(v);
    } else row.appendChild(el('div', 'vl', text));
    info.appendChild(row);
  }));
  page.appendChild(info);

  // กลุ่มรูป: กลุ่มละแถว 4 รูปตามแบบฟอร์มเดิม
  const need = [];
  secs.forEach(g => {
    const imgs = g.items.filter(f => f.type === 'image');
    if (!imgs.length) return;
    page.appendChild(el('div', 'p-sec', g.name));
    const grid = el('div', 'p-photos');
    imgs.forEach(f => {
      const cell = el('div', 'p-ph');
      const v = rec.data[f.field_id];
      if (v && v.full) { cell.appendChild(el('div', 'none', 'กำลังโหลด…')); need.push({ id: v.full, cell: cell }); }
      else cell.appendChild(el('div', 'none', 'ไม่มีรูป'));
      cell.appendChild(el('div', 'cap', f.label));
      grid.appendChild(cell);
    });
    page.appendChild(grid);
  });

  const sign = el('div', 'p-sign');
  PRINT.signers.forEach(role => {
    const b = el('div', 'p-sb');
    const nm = el('div', 'nm');
    nm.append(document.createTextNode('('), el('i'), document.createTextNode(')'));
    b.append(el('b', null, role), el('div', 'ln'), nm);
    sign.appendChild(b);
  });
  page.appendChild(sign);

  // ดึงภาพเต็มทีละ 4 รูป — ยิงทีเดียว 12 รูปทำให้คำตอบใหญ่เกินและ Apps Script ตอบช้ามาก
  let done = 0;
  for (let i = 0; i < need.length; i += 4) {
    const part = need.slice(i, i + 4);
    try {
      const r = await api('files.batch', { ids: part.map(x => x.id) });
      part.forEach(x => {
        if (!r.files[x.id]) return;
        const img = el('img'); img.src = r.files[x.id]; img.alt = '';
        x.cell.replaceChild(img, x.cell.firstChild);
      });
    } catch (e) { toast('ดึงรูปบางส่วนไม่สำเร็จ: ' + e.message); }
    done += part.length;
    if (pv.classList.contains('hide')) return;          // ผู้ใช้ปิดไปแล้วระหว่างโหลด
    btnPrint.textContent = 'กำลังเตรียมรูป… ' + done + '/' + need.length;
  }
  need.forEach(x => { if (x.cell.firstChild.className === 'none') x.cell.firstChild.textContent = 'โหลดรูปไม่สำเร็จ'; });

  btnPrint.textContent = '🖨 พิมพ์เอกสาร'; btnPrint.disabled = false;
  btnPrint.addEventListener('click', () => window.print());
}

/** กระดาษ A4 กว้างกว่าจอมือถือ ย่อให้พอดีเฉพาะตอนดูตัวอย่าง ตอนพิมพ์ CSS บังคับกลับเป็น 1 */
function fitPage(page) {
  const paper = 794;                                   // 210mm ที่ 96dpi
  const avail = document.documentElement.clientWidth - 20;
  page.style.zoom = avail < paper ? (avail / paper).toFixed(3) : '';
}
window.addEventListener('resize', () => { if (S.fitPage && !$('#printview').classList.contains('hide')) S.fitPage(); });

/* ──────────────── ตั้งค่า: หัวข้อ + ผู้ใช้ ──────────────── */
$('#btnSettings').addEventListener('click', openSettings);

function openSettings() {
  S.rec = null; S.dirty = false;
  $('#edTitle').textContent = 'ตั้งค่าระบบ';
  $('#edHint').textContent = 'หัวข้อในแบบฟอร์มและผู้ใช้';
  $('#edStatus').textContent = ''; $('#edSteps').innerHTML = ''; $('#edFoot').innerHTML = '';
  const body = $('#edBody'); body.innerHTML = '';
  if (S.perm.fields) body.appendChild(fieldManager());
  if (S.perm.users) body.appendChild(userManager());
  body.appendChild(passwordBox());
  S.returnFocus = document.activeElement;
  $('#editor').classList.remove('hide'); $('#app').inert = true;
  $('#edBody').scrollTop = 0; $('#edClose').focus();
}

function fieldManager() {
  const sec = el('div', 'section');
  sec.appendChild(el('h3', null, 'หัวข้อในแบบฟอร์ม — เพิ่ม / แก้ไข / ซ่อน / ลบ'));
  const sb = el('div', 'section-body');
  const list = el('div'); sb.appendChild(list);

  const draw = () => {
    list.innerHTML = '';
    const t = el('table');
    t.innerHTML = '<thead><tr><th>หัวข้อ</th><th>ชนิด</th><th>กลุ่ม</th><th></th></tr></thead>';
    const tb = el('tbody');
    S.fields.forEach((f, i) => {
      const tr = el('tr');
      tr.innerHTML = `<td>${esc(f.label)}${f.required ? ' *' : ''}${f.visible ? '' : ' (ซ่อน)'}</td>
        <td>${esc(f.type)}</td><td>${esc(f.section)}</td>`;
      const td = el('td');
      const locked = (S.protected || []).indexOf(f.field_id) >= 0;
      const why = 'หัวข้อนี้ระบบใช้ค้นหาและกรองข้อมูล ลบหรือซ่อนไม่ได้';

      const up = el('button', 'btn btn-sm', '↑'); up.disabled = i === 0;
      up.addEventListener('click', () => reorder(i, i - 1));
      const dn = el('button', 'btn btn-sm', '↓'); dn.disabled = i === S.fields.length - 1;
      dn.addEventListener('click', () => reorder(i, i + 1));
      const edit = el('button', 'btn btn-sm', 'แก้ไข');
      edit.addEventListener('click', () => fieldForm(f, draw));
      const hide = el('button', 'btn btn-sm', f.visible ? 'ซ่อน' : 'แสดง');
      hide.disabled = locked && f.visible;
      if (hide.disabled) hide.title = why;
      hide.addEventListener('click', async () => {
        try { const r = await api('fields.save', { field: Object.assign({}, f, { visible: !f.visible }) }); S.fields = r.fields; draw(); }
        catch (e) { toast(e.message); }
      });
      const del = el('button', 'btn btn-sm btn-danger', 'ลบ');
      del.disabled = locked; del.title = locked ? why : 'ลบหัวข้อนี้';
      del.addEventListener('click', async () => {
        if (!confirm('ลบหัวข้อ "' + f.label + '"?\n\nข้อมูลที่เคยกรอกไว้จะยังอยู่ในชีต และกลับมาแสดงได้ถ้าสร้างหัวข้อรหัสเดิมใหม่')) return;
        try { const r = await api('fields.delete', { field_id: f.field_id }); S.fields = r.fields; draw(); }
        catch (e) { toast(e.message); }
      });
      [up, dn, edit, hide, del].forEach(b => td.appendChild(b));
      tr.appendChild(td); tb.appendChild(tr);
    });
    t.appendChild(tb);
    const wrap = el('div', 'tablewrap'); wrap.appendChild(t); list.appendChild(wrap);
    const add = el('button', 'btn btn-primary', '+ เพิ่มหัวข้อ');
    add.addEventListener('click', () => fieldForm({ type: 'text', section: 'ทั่วไป', visible: true }, draw));
    list.appendChild(add);
  };

  const reorder = async (from, to) => {
    const ids = S.fields.map(f => f.field_id);
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    try { const r = await api('fields.reorder', { order: ids }); S.fields = r.fields; draw(); }
    catch (e) { toast(e.message); }
  };

  draw(); sec.appendChild(sb); return sec;
}

function fieldForm(f, done) {
  const label = prompt('ชื่อหัวข้อ', f.label || ''); if (!label) return;
  const type = prompt('ชนิด: text / number / date / select / textarea / image', f.type || 'text') || 'text';
  const section = prompt('กลุ่ม (ใช้เป็นชื่อขั้นในฟอร์ม)', f.section || 'ทั่วไป') || 'ทั่วไป';
  const options = type === 'select' ? (prompt('ตัวเลือก คั่นด้วย |', (f.options || []).join('|')) || '').split('|').filter(Boolean) : [];
  const required = confirm('ทำเครื่องหมายว่าควรกรอกหรือไม่? (ตกลง = ใช่)');
  const in_list = confirm('แสดงในการ์ดหน้าแรกหรือไม่? (ตกลง = แสดง)');
  api('fields.save', { field: Object.assign({}, f, { label, type, section, options, required, in_list, visible: f.visible !== false }) })
    .then(r => { S.fields = r.fields; done(); toast('บันทึกหัวข้อแล้ว'); })
    .catch(e => toast(e.message));
}

function userManager() {
  const sec = el('div', 'section');
  sec.appendChild(el('h3', null, 'ผู้ใช้และบทบาท'));
  const sb = el('div', 'section-body');
  const list = el('div'); sb.appendChild(list);
  const roles = ['admin', 'staff', 'supervisor', 'manager', 'viewer'];

  /** บทบาทที่พิมพ์ผิดจะสร้างบัญชีที่เข้าระบบได้แต่ไม่มีสิทธิ์อะไรเลย จึงต้องตรงกับรายการเท่านั้น */
  const askRole = current => {
    const v = prompt('บทบาท: ' + roles.join(' / '), current);
    if (v === null) return '';
    const r = String(v).trim().toLowerCase();
    if (roles.indexOf(r) < 0) { toast('บทบาทไม่ถูกต้อง — ใช้ได้เฉพาะ: ' + roles.join(', ')); return ''; }
    return r;
  };

  const draw = async () => {
    const r = await api('users.list');
    const t = el('table');
    t.innerHTML = '<thead><tr><th>ชื่อผู้ใช้</th><th>ชื่อแสดง</th><th>บทบาท</th><th>สถานะ</th><th></th></tr></thead>';
    const tb = el('tbody');
    r.users.forEach(u => {
      const tr = el('tr');
      tr.innerHTML = `<td>${esc(u.username)}</td><td>${esc(u.display_name)}</td><td>${esc(roleLabel(u.role))}</td><td>${u.active ? 'ใช้งาน' : 'ปิด'}</td>`;
      const td = el('td');
      const bR = el('button', 'btn btn-sm', 'เปลี่ยนบทบาท');
      bR.addEventListener('click', async () => {
        const role = askRole(u.role); if (!role) return;
        try { await api('users.save', { user: { username: u.username, role } }); draw(); } catch (e) { toast(e.message); }
      });
      const bA = el('button', 'btn btn-sm', u.active ? 'ปิดใช้งาน' : 'เปิดใช้งาน');
      bA.addEventListener('click', async () => {
        try { await api('users.save', { user: { username: u.username, active: !u.active } }); draw(); } catch (e) { toast(e.message); }
      });
      const bP = el('button', 'btn btn-sm', 'ตั้งรหัสใหม่');
      bP.addEventListener('click', async () => {
        const pw = prompt('รหัสผ่านใหม่ (อย่างน้อย 8 ตัว)'); if (!pw) return;
        try { await api('users.password', { username: u.username, password: pw }); toast('เปลี่ยนรหัสแล้ว'); }
        catch (e) { toast(e.message); }
      });
      [bR, bA, bP].forEach(b => td.appendChild(b));
      tr.appendChild(td); tb.appendChild(tr);
    });
    t.appendChild(tb);
    list.innerHTML = ''; const wrap = el('div', 'tablewrap'); wrap.appendChild(t); list.appendChild(wrap);
    const add = el('button', 'btn btn-primary', '+ เพิ่มผู้ใช้');
    add.addEventListener('click', async () => {
      const username = prompt('ชื่อผู้ใช้ (ภาษาอังกฤษ)'); if (!username) return;
      const display_name = prompt('ชื่อที่แสดง', username) || username;
      const role = askRole('staff'); if (!role) return;
      const password = prompt('รหัสผ่านเริ่มต้น (อย่างน้อย 8 ตัว)'); if (!password) return;
      try { await api('users.save', { user: { username, display_name, role, password } }); draw(); toast('เพิ่มผู้ใช้แล้ว'); }
      catch (e) { toast(e.message); }
    });
    list.appendChild(add);
  };
  draw().catch(e => toast(e.message));
  sec.appendChild(sb); return sec;
}

function passwordBox() {
  const sec = el('div', 'section');
  sec.appendChild(el('h3', null, 'รหัสผ่านของฉัน'));
  const sb = el('div', 'section-body');
  const b = el('button', 'btn', 'เปลี่ยนรหัสผ่าน');
  b.addEventListener('click', async () => {
    const pw = prompt('รหัสผ่านใหม่ (อย่างน้อย 8 ตัว)'); if (!pw) return;
    try { await api('users.password', { password: pw }); toast('เปลี่ยนรหัสผ่านแล้ว'); }
    catch (e) { toast(e.message); }
  });
  sb.appendChild(b); sec.appendChild(sb); return sec;
}

/* ──────────────── utils ──────────────── */
/** 2026-09-14 → 14 ก.ย. 2569 (ให้ตรงกับ dropdown ตัวกรองที่เป็น พ.ศ.) */
function thaiDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
  if (!m) return String(s);
  return Number(m[3]) + ' ' + MONTHS[Number(m[2]) - 1] + ' ' + (Number(m[1]) + 543);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

window.addEventListener('beforeunload', e => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

/* เปิดหน้าแล้วลองใช้ session เดิมก่อน */
(async function init() {
  const t = sessionStorage.getItem('tkf_token');
  if (!t) return;
  S.token = t;
  try { await start(); } catch (e) { signOut(); }
})();
