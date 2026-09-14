/* ระบบขายเศษวัสดุเหลือใช้ (TKF) — Frontend
   หน้าเว็บนี้เป็น public เสมอ (GitHub Pages) จึงไม่มีข้อมูลหรือรหัสผ่านอยู่ในไฟล์นี้
   ทุกอย่างถามไปที่ Apps Script และสิทธิ์ถูกตรวจที่ฝั่งนั้น */

const CONFIG = {
  // 👇 วาง URL ของ Apps Script Web App (ลงท้ายด้วย /exec) ตรงนี้
  API: 'https://script.google.com/macros/s/XXXXXXXXXXXXXXXXXXXX/exec',
  THUMB: 320,   // ความกว้างภาพย่อ (px)
  FULL: 1400,   // ความกว้างภาพเต็ม (px)
  QUALITY: 0.82
};

const S = { token: null, user: null, fields: [], perm: {}, status: '', rows: [], rec: null, dirty: false };
const $ = (s, r) => (r || document).querySelector(s);
const el = (t, c, txt) => { const n = document.createElement(t); if (c) n.className = c; if (txt != null) n.textContent = txt; return n; };

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
  const text = await res.text();
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
  // แถบปุ่มล่างสูงไม่เท่ากันเมื่อปุ่มตัดบรรทัดบนมือถือ จึงวัดความสูงจริงแทนการกำหนดค่าตายตัว
  const foot = $('#edFoot');
  const lift = (!$('#editor').classList.contains('hide') && foot && foot.offsetHeight)
    ? foot.offsetHeight + 16 : 24;
  document.body.style.setProperty('--toast-bottom', lift + 'px');
  const t = el('div', null, msg); t.id = 'toast';
  t.setAttribute('role', 'status');
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2800);
}

/* ──────────────── เข้า/ออกระบบ ──────────────── */
$('#loginForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const btn = $('#loginBtn'); btn.disabled = true; btn.textContent = 'กำลังเข้าสู่ระบบ…';
  $('#loginMsg').innerHTML = '';
  try {
    const r = await api('login', { username: $('#u').value, password: $('#p').value });
    S.token = r.token;
    sessionStorage.setItem('tkf_token', r.token);
    $('#p').value = '';
    await start();
  } catch (e) {
    $('#loginMsg').innerHTML = `<div class="msg msg-err">${esc(e.message)}</div>`;
  } finally { btn.disabled = false; btn.textContent = 'เข้าสู่ระบบ'; }
});

function signOut(reason) {
  // หลุดกลางคัน (session หมดอายุ) → เก็บสิ่งที่กรอกค้างไว้ก่อน แล้วกู้คืนหลังเข้าระบบใหม่
  if (reason && S.dirty && S.rec) {
    try { sessionStorage.setItem('tkf_draft', JSON.stringify(S.rec)); } catch (e) {}
  }
  S.token = null; S.dirty = false; sessionStorage.removeItem('tkf_token');
  $('#app').inert = false; S.returnFocus = null;
  $('#app').classList.add('hide'); $('#editor').classList.add('hide'); $('#login').classList.remove('hide');
  if (reason) $('#loginMsg').innerHTML = `<div class="msg msg-err">${esc(reason)}</div>`;
}

$('#btnLogout').addEventListener('click', async () => {
  try { await api('logout'); } catch (e) {}
  signOut();
});

async function start() {
  const b = await api('bootstrap');
  S.user = b.user; S.fields = b.fields; S.perm = b.permissions; S.statuses = b.statuses;
  S.protected = b.protectedFields || [];
  $('#whoName').textContent = b.user.name;
  $('#whoRole').textContent = roleLabel(b.user.role);
  $('#btnNew').hidden = !S.perm.write;
  $('#btnSettings').hidden = !(S.perm.fields || S.perm.users);
  $('#login').classList.add('hide'); $('#app').classList.remove('hide');
  buildTabs(); buildDateFilters();
  await refresh();
  restoreDraft();
}

function restoreDraft() {
  const raw = sessionStorage.getItem('tkf_draft');
  if (!raw) return;
  sessionStorage.removeItem('tkf_draft');
  try {
    S.rec = JSON.parse(raw);
    S.dirty = true;
    renderEditor();
    showEditor();
    if (S.rec.id) loadThumbs();
    toast('กู้คืนข้อมูลที่กรอกค้างไว้แล้ว — กดบันทึกเพื่อยืนยัน');
  } catch (e) {}
}

const roleLabel = r => ({ admin: 'ผู้ดูแลระบบ', staff: 'พนักงานบริการสำนักงาน', supervisor: 'ผู้จัดการแผนก', manager: 'ผู้จัดการฝ่าย', viewer: 'ผู้ดูอย่างเดียว' }[r] || r);

/* ──────────────── แท็บ + ตัวกรอง ──────────────── */
function buildTabs() {
  const tabs = $('#tabs'); tabs.innerHTML = '';
  const all = [['', 'ทั้งหมด']].concat(Object.values(S.statuses).map(v => [v, v]));
  all.forEach(([val, label]) => {
    const b = el('button', 'tab'); b.type = 'button'; b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(val === S.status));
    b.dataset.v = val;
    b.append(document.createTextNode(label), el('span', 'n', '0'));
    b.addEventListener('click', () => { S.status = val; buildTabs(); refresh(); });
    tabs.appendChild(b);
  });
}

function buildDateFilters() {
  const y = $('#fYear'), m = $('#fMonth');
  const now = new Date().getFullYear();
  y.innerHTML = '<option value="">ทุกปี</option>';
  for (let i = now; i >= now - 4; i--) y.insertAdjacentHTML('beforeend', `<option value="${i}">${i + 543}</option>`);
  const mn = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  m.innerHTML = '<option value="">ทุกเดือน</option>' + mn.map((t, i) => `<option value="${i + 1}">${t}</option>`).join('');
  [y, m].forEach(s => s.addEventListener('change', refresh));
  let timer; $('#q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(refresh, 350); });
}

/* ──────────────── รายการเอกสาร ──────────────── */
async function refresh() {
  $('#list').innerHTML = '<div class="empty">กำลังโหลด…</div>';
  try {
    const r = await api('records.list', {
      status: S.status, q: $('#q').value, year: $('#fYear').value, month: $('#fMonth').value
    });
    S.rows = r.rows;
    document.querySelectorAll('.tab').forEach(t => {
      const v = t.dataset.v;
      const n = v ? (r.counts[v] || 0) : Object.values(r.counts).reduce((a, b) => a + b, 0);
      $('.n', t).textContent = n;
    });
    renderList();
  } catch (e) {
    $('#list').innerHTML = `<div class="empty"><b>โหลดข้อมูลไม่สำเร็จ</b>${esc(e.message)}</div>`;
  }
}

function renderList() {
  const host = $('#list');
  if (!S.rows.length) {
    host.innerHTML = `<div class="empty"><b>ยังไม่มีเอกสารในมุมมองนี้</b>${S.perm.write ? 'กดปุ่ม “สร้างรายการ” เพื่อเริ่มบันทึก' : 'ลองเปลี่ยนตัวกรองด้านบน'}</div>`;
    return;
  }
  const cols = S.fields.filter(f => f.in_list && f.visible);
  const t = el('table');
  const thead = el('thead'), tr = el('tr');
  ['เลขที่'].concat(cols.map(c => c.label)).concat(['รูป', 'สถานะ', 'แก้ไขล่าสุด'])
    .forEach(h => tr.appendChild(el('th', null, h)));
  thead.appendChild(tr); t.appendChild(thead);

  const tb = el('tbody');
  S.rows.forEach(row => {
    const r = el('tr');
    r.tabIndex = 0;
    r.appendChild(el('td', 'c-id', row.id));
    cols.forEach(c => {
      const td = el('td', 'c-field', fmtCell(c, row.brief[c.field_id]));
      td.dataset.label = c.label;   // ใช้เป็นป้ายกำกับตอนตารางกลายเป็นการ์ดบนมือถือ
      r.appendChild(td);
    });
    const ph = el('td', 'c-meta', row.photos ? row.photos + ' รูป' : '—');
    ph.dataset.label = 'รูป'; r.appendChild(ph);

    const st = el('td', 'c-status');
    st.appendChild(statusPill(row.status));
    const waiting = waitingDays(row);
    if (waiting) st.appendChild(el('span', 'age', waiting));
    r.appendChild(st);

    const up = el('td', 'c-meta', row.updated_at); up.dataset.label = 'แก้ไขล่าสุด';
    r.appendChild(up);

    const open = () => openRecord(row.id);
    r.addEventListener('click', open);
    r.addEventListener('keydown', e => { if (e.key === 'Enter') open(); });
    tb.appendChild(r);
  });
  t.appendChild(tb);
  host.innerHTML = ''; host.appendChild(t);
}

function fmtCell(col, v) {
  if (v == null || v === '') return '—';
  return col.type === 'date' ? thaiDate(v) : String(v);
}

/** เอกสารที่รอคนเซ็นอยู่ ควรบอกว่ารอมานานแค่ไหน ไม่ใช่แค่วันที่ดิบ */
function waitingDays(row) {
  if ([S.statuses.submitted, S.statuses.reviewed].indexOf(row.status) < 0) return '';
  if (!row.updated_ms) return '';   // ใช้เวลาแบบ epoch ข้อความ 'yyyy-MM-dd HH:mm' จะถูกอ่านเป็นเวลาเครื่องผู้ใช้
  const d = Math.floor((Date.now() - row.updated_ms) / 86400000);
  if (d <= 0) return 'รอมาวันนี้';
  return 'รอมา ' + d + ' วัน';
}

function statusPill(s) {
  const p = el('span', 'pill', s); p.dataset.s = s; return p;
}

/* ──────────────── หน้าเอกสาร ──────────────── */
$('#btnNew').addEventListener('click', () => openRecord(null));
$('#edClose').addEventListener('click', closeEditor);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#editor').classList.contains('hide')) closeEditor();
});

function closeEditor() {
  if (S.dirty && !confirm('มีการแก้ไขที่ยังไม่ได้บันทึก ต้องการออกโดยไม่บันทึกหรือไม่?')) return;
  S.dirty = false; S.rec = null;
  $('#editor').classList.add('hide');
  $('#app').inert = false;
  if (S.returnFocus && document.contains(S.returnFocus)) S.returnFocus.focus();
  S.returnFocus = null;
  refresh();
}

/** เปิดหน้าเอกสารแบบ dialog: ล็อกโฟกัสไว้ข้างใน ไม่ให้ tab หลุดไปโดนตารางที่อยู่ข้างหลัง */
function showEditor() {
  S.returnFocus = document.activeElement;
  $('#editor').classList.remove('hide');
  $('#app').inert = true;
  $('#editor').scrollTop = 0;
  $('#edClose').focus();
}

async function openRecord(id) {
  if (id) {
    try { const r = await api('records.get', { id }); S.rec = r.record; }
    catch (e) { return toast(e.message); }
  } else {
    S.rec = { id: null, status: S.statuses.draft, data: {}, sign: {}, created_by: S.user.username };
  }
  S.openSections = null;   // เอกสารใหม่เริ่มที่ค่าเริ่มต้นเสมอ ไม่เอาสถานะพับ/กางของเอกสารก่อนหน้ามา
  S.dirty = false;
  renderEditor();
  showEditor();
  if (id) loadThumbs();
}

function editable() {
  if (!S.perm.write) return false;
  if (S.user.role === 'admin') return true;
  if (!S.rec.id) return true;
  if ([S.statuses.draft, S.statuses.rejected].indexOf(S.rec.status) < 0) return false;
  return S.rec.created_by === S.user.username;
}

function renderEditor() {
  const rec = S.rec, ed = editable();
  $('#edTitle').textContent = rec.id ? 'เอกสาร ' + rec.id : 'สร้างรายการใหม่';
  const sp = $('#edStatus'); sp.textContent = rec.status; sp.dataset.s = rec.status;

  const body = $('#edBody'); body.innerHTML = '';

  if (rec.status === S.statuses.rejected && rec.note) {
    body.insertAdjacentHTML('beforeend', `<div class="msg msg-err"><b>ถูกตีกลับ:</b> ${esc(rec.note)}</div>`);
  }
  if (!ed && rec.id) {
    body.insertAdjacentHTML('beforeend',
      `<div class="msg msg-ok">เอกสารสถานะ “${esc(rec.status)}” อยู่ในโหมดอ่านอย่างเดียว</div>`);
  }

  // จัดกลุ่มตาม section ตามลำดับที่ตั้งไว้
  const groups = [];
  S.fields.filter(f => f.visible).forEach(f => {
    let g = groups.find(x => x.name === f.section);
    if (!g) { g = { name: f.section, items: [] }; groups.push(g); }
    g.items.push(f);
  });

  groups.forEach((g, gi) => {
    const sec = el('section', 'section');
    const allPhotos = g.items.every(f => f.type === 'image');
    const filled = g.items.filter(f => S.rec.data[f.field_id]).length;

    // กลุ่มแรกเปิดไว้ ที่เหลือพับ — ฟอร์ม 26 ช่องบนมือถือยาวเกินกว่าจะกางทั้งหมด
    const collapsed = (S.openSections && g.name in S.openSections)
      ? !S.openSections[g.name]
      : gi > 0;
    if (collapsed) sec.classList.add('collapsed');

    const h3 = el('h3');
    const head = el('button', 'sechead'); head.type = 'button';
    head.setAttribute('aria-expanded', String(!collapsed));
    head.append(
      el('span', 'chev', '▾'),
      document.createTextNode(g.name),
      el('span', 'count' + (filled === g.items.length ? ' full' : ''), filled + '/' + g.items.length)
    );
    head.addEventListener('click', () => {
      sec.classList.toggle('collapsed');
      const open = !sec.classList.contains('collapsed');
      head.setAttribute('aria-expanded', String(open));
      S.openSections = S.openSections || {};
      S.openSections[g.name] = open;
      if (open) loadThumbs();
    });
    h3.appendChild(head); sec.appendChild(h3);

    const sb = el('div', 'section-body grid' + (allPhotos ? ' photos' : ''));
    g.items.forEach(f => sb.appendChild(renderField(f, ed)));
    sec.appendChild(sb);
    body.appendChild(sec);
  });

  // ลายเซ็นตามขั้นตอน
  if (rec.id) {
    const sec = el('section', 'section');
    sec.appendChild(el('h3', null, 'การลงนาม'));
    const sb = el('div', 'section-body signs');
    sb.innerHTML = `
      <div><b>จัดทำ</b> — ${esc(rec.sign.staff || '—')}</div>
      <div><b>ตรวจสอบ (ผู้จัดการแผนก)</b> — ${esc(rec.sign.supervisor || '—')}</div>
      <div><b>รับทราบ (ผู้จัดการฝ่าย)</b> — ${esc(rec.sign.manager || '—')}</div>
      <div style="margin-top:8px;color:var(--muted)">สร้างโดย ${esc(rec.created_by)} · แก้ไขล่าสุด ${esc(rec.updated_at || '')}</div>`;
    sec.appendChild(sb); body.appendChild(sec);
  }

  renderFooter(ed);
}

function renderField(f, ed) {
  const wrap = el('div', 'field');
  const lab = el('label', null, f.label);
  lab.htmlFor = 'in_' + f.field_id;
  if (f.required) lab.appendChild(el('span', 'req', ' *'));
  wrap.appendChild(lab);

  if (f.type === 'image') {
    wrap.appendChild(photoBox(f, ed));
    return wrap;
  }

  let input;
  if (f.type === 'select') {
    input = el('select');
    input.appendChild(new Option('— เลือก —', ''));
    f.options.forEach(o => input.appendChild(new Option(o, o)));
  } else if (f.type === 'textarea') {
    input = el('textarea'); input.rows = 3;
  } else {
    input = el('input');
    input.type = { date: 'date', number: 'number' }[f.type] || 'text';
    if (f.type === 'number') input.step = 'any';
  }
  input.id = 'in_' + f.field_id;
  input.value = S.rec.data[f.field_id] != null ? S.rec.data[f.field_id] : '';
  input.disabled = !ed;
  input.addEventListener('input', () => { S.rec.data[f.field_id] = input.value; S.dirty = true; });
  wrap.appendChild(input);
  return wrap;
}

function photoBox(f, ed) {
  const wrap = el('div', 'photo-wrap');
  const v = S.rec.data[f.field_id];

  // เป็น <button> จริง ไม่ใช่ div ที่ดักคลิก → ใช้คีย์บอร์ดแนบรูปได้ และ <label for> ผูกได้ถูกต้อง
  const box = el('button', 'photo'); box.type = 'button'; box.id = 'ph_' + f.field_id;
  if (v && v.thumb) {
    box.classList.add('filled');
    box.appendChild(el('span', null, 'กำลังโหลดภาพ…'));
    box.setAttribute('aria-label', 'ดูรูป ' + f.label + ' ขนาดเต็ม');
  } else {
    box.appendChild(el('span', null, ed ? '📷 แตะเพื่อเลือกรูป' : 'ไม่มีรูป'));
    box.disabled = !ed;
    box.setAttribute('aria-label', 'แนบรูป ' + f.label);
  }
  box.addEventListener('click', () => {
    const cur = S.rec.data[f.field_id];
    if (cur && cur.full) return showFull(cur.full);
    if (ed) pickPhoto(f);
  });
  wrap.appendChild(box);

  if (v && ed) {
    const acts = el('div', 'ph-act');
    // ถ่ายเบลอแล้วเปลี่ยนใหม่เป็นงานที่เกิดบ่อย ไม่ควรต้องลบก่อนแล้วค่อยแนบใหม่
    const swap = el('button', null, 'เปลี่ยน'); swap.type = 'button';
    swap.title = 'เลือกรูปใหม่แทนรูปเดิม';
    swap.addEventListener('click', () => pickPhoto(f));
    const rm = el('button', null, '×'); rm.type = 'button';
    rm.title = 'ลบรูปนี้'; rm.setAttribute('aria-label', 'ลบรูป ' + f.label);
    rm.addEventListener('click', () => {
      if (!confirm('ลบรูป "' + f.label + '" ?')) return;
      delete S.rec.data[f.field_id]; S.dirty = true;
      renderEditor(); loadThumbs();
    });
    acts.append(swap, rm);
    wrap.appendChild(acts);
  }
  return wrap;
}

/* เลือกรูป → ย่อในเครื่อง 2 ขนาด → อัปโหลด
   ย่อก่อนอัปช่วยให้ส่งเร็วขึ้นมาก และหน้ารายการโหลดแค่ภาพย่อ */
function pickPhoto(f) {
  const inp = el('input'); inp.type = 'file'; inp.accept = 'image/*';
  inp.addEventListener('change', async () => {
    const file = inp.files[0]; if (!file) return;
    const box = $('#ph_' + f.field_id);
    const busy = el('div', 'busy', 'กำลังย่อรูป…');
    busy.setAttribute('role', 'status');
    box.parentElement.appendChild(busy);
    try {
      if (!S.rec.id) { busy.textContent = 'กำลังสร้างเอกสาร…'; await saveRecord(false, true); }
      const full = await resize(file, CONFIG.FULL);
      const thumb = await resize(file, CONFIG.THUMB);
      busy.textContent = 'กำลังอัปโหลด…';
      const r = await api('files.upload', {
        recordId: S.rec.id, fieldId: f.field_id, mime: 'image/jpeg',
        full: full.b64, thumb: thumb.b64
      });
      S.rec.data[f.field_id] = { full: r.full, thumb: r.thumb, name: file.name };
      await saveRecord(false, true);
      renderEditor(); loadThumbs();
      toast('อัปโหลดรูปแล้ว');
    } catch (e) {
      busy.remove(); toast(e.message);
    }
  });
  inp.click();
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
      const dataUrl = c.toDataURL('image/jpeg', CONFIG.QUALITY);
      resolve({ b64: dataUrl.split(',')[1], w: c.width });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('ไฟล์นี้ไม่ใช่รูปภาพที่เปิดได้')); };
    img.src = url;
  });
}

/** ดึงภาพย่อทั้งหมดในเอกสารด้วยคำขอเดียว */
async function loadThumbs() {
  const ids = S.fields.filter(f => f.type === 'image')
    .map(f => S.rec.data[f.field_id]).filter(v => v && v.thumb).map(v => v.thumb);
  if (!ids.length) return;
  try {
    const r = await api('files.batch', { ids });
    S.fields.filter(f => f.type === 'image').forEach(f => {
      const v = S.rec.data[f.field_id]; if (!v || !r.files[v.thumb]) return;
      const box = $('#ph_' + f.field_id); if (!box) return;
      const img = el('img'); img.src = r.files[v.thumb]; img.alt = f.label; img.loading = 'lazy';
      box.querySelectorAll('span').forEach(n => n.remove());
      box.parentElement.querySelectorAll('.busy').forEach(n => n.remove());
      box.prepend(img);
    });
  } catch (e) { toast(e.message); }
}

async function showFull(id) {
  const lb = el('div'); lb.id = 'lightbox';
  lb.innerHTML = '<div style="color:#fff">กำลังโหลดภาพ…</div>';
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

/* ──────────────── ปุ่มดำเนินการ ──────────────── */
function renderFooter(ed) {
  const foot = $('#edFoot'); foot.innerHTML = '';
  const rec = S.rec;
  // Apps Script ตอบ 1–3 วินาที ถ้าไม่ล็อกปุ่มไว้ ผู้ใช้จะกดซ้ำและได้ error สถานะที่อ่านไม่รู้เรื่อง
  const add = (label, cls, fn) => {
    const b = el('button', 'btn ' + cls, label);
    b.addEventListener('click', async () => {
      const all = foot.querySelectorAll('button');
      all.forEach(x => { x.disabled = true; });
      const prev = b.textContent; b.textContent = 'กำลังทำงาน…';
      try { await fn(); }
      catch (e) { /* ข้อความแจ้งผู้ใช้ถูกจัดการใน fn แล้ว */ }
      finally {
        // footer อาจถูก render ใหม่ระหว่างทาง จึงต้องเช็กว่าปุ่มนี้ยังอยู่ในหน้าจริงไหม
        if (document.contains(b)) { b.textContent = prev; all.forEach(x => { x.disabled = false; }); }
      }
    });
    foot.appendChild(b);
  };

  if (ed) add('บันทึกร่าง', '', () => saveRecord(false));
  if (ed && S.perm.submit) add('บันทึกและส่งตรวจสอบ', 'btn-primary', () => saveRecord(true));

  if (rec.id && rec.status === S.statuses.submitted && S.perm.review) {
    add('ตีกลับ', 'btn-danger', () => move(S.statuses.rejected));
    add('ตรวจสอบผ่าน', 'btn-primary', () => move(S.statuses.reviewed));
  }
  if (rec.id && rec.status === S.statuses.reviewed && S.perm.approve) {
    add('ตีกลับ', 'btn-danger', () => move(S.statuses.rejected));
    add('อนุมัติ (ปิดงาน)', 'btn-primary', () => move(S.statuses.complete));
  }
  if (rec.id && rec.status === S.statuses.complete && S.user.role === 'admin') {
    add('เปิดแก้ไขใหม่', '', () => { if (confirm('เปิดเอกสารที่ปิดงานแล้วกลับมาแก้ไข? การลงนามเดิมจะถูกล้าง')) move(S.statuses.draft); });
  }
  if (rec.id && S.perm.del) {
    add('ลบเอกสาร', 'btn-danger', async () => {
      if (!confirm('ลบเอกสาร ' + rec.id + ' และรูปทั้งหมด? กู้คืนไม่ได้')) return;
      try { await api('records.delete', { id: rec.id }); S.dirty = false; closeEditor(); toast('ลบแล้ว'); }
      catch (e) { toast(e.message); }
    });
  }
}

async function saveRecord(thenSubmit, silent) {
  try {
    const r = await api('records.save', { record: { id: S.rec.id, data: S.rec.data } });
    S.rec = r.record; S.dirty = false;
    if (!silent) { renderEditor(); loadThumbs(); toast('บันทึกแล้ว ' + S.rec.id); }
    if (thenSubmit) await move(S.statuses.submitted);
    return r.record;
  } catch (e) { toast(e.message); throw e; }
}

async function move(to) {
  let note = '';
  if (to === S.statuses.rejected) {
    note = prompt('ระบุเหตุผลที่ตีกลับ (ผู้จัดทำจะเห็นข้อความนี้)') || '';
    if (!note.trim()) return;
  }
  try {
    const r = await api('records.move', { id: S.rec.id, to, note });
    S.rec = r.record; renderEditor(); loadThumbs();
    toast('เปลี่ยนสถานะเป็น ' + to);
  } catch (e) { toast(e.message); }
}

/* ──────────────── ตั้งค่า: หัวข้อ + ผู้ใช้ ──────────────── */
$('#btnSettings').addEventListener('click', openSettings);

function openSettings() {
  S.rec = null; S.dirty = false;
  $('#edTitle').textContent = 'ตั้งค่าระบบ';
  $('#edStatus').textContent = ''; $('#edStatus').dataset.s = '';
  const body = $('#edBody'); body.innerHTML = ''; $('#edFoot').innerHTML = '';
  if (S.perm.fields) body.appendChild(fieldManager());
  if (S.perm.users) body.appendChild(userManager());
  body.appendChild(passwordBox());
  showEditor();
}

function fieldManager() {
  const sec = el('section', 'section');
  sec.appendChild(el('h3', null, 'หัวข้อในแบบฟอร์ม — เพิ่ม / แก้ไข / ซ่อน / ลบ'));
  const sb = el('div', 'section-body');
  const list = el('div'); sb.appendChild(list);

  const draw = () => {
    list.innerHTML = '';
    const t = el('table');
    t.innerHTML = '<thead><tr><th>ลำดับ</th><th>ชื่อหัวข้อ</th><th>ชนิด</th><th>กลุ่ม</th><th>บังคับ</th><th>แสดง</th><th>ในตาราง</th><th></th></tr></thead>';
    const tb = el('tbody');
    S.fields.forEach((f, i) => {
      const tr = el('tr');
      tr.innerHTML = `<td>${i + 1}</td><td>${esc(f.label)}</td><td>${esc(f.type)}</td><td>${esc(f.section)}</td>
        <td>${f.required ? '✓' : ''}</td><td>${f.visible ? '✓' : '—'}</td><td>${f.in_list ? '✓' : ''}</td>`;
      const td = el('td');
      const bUp = el('button', 'btn btn-sm', '↑'); bUp.disabled = i === 0;
      bUp.addEventListener('click', () => reorder(i, i - 1));
      const bDn = el('button', 'btn btn-sm', '↓'); bDn.disabled = i === S.fields.length - 1;
      bDn.addEventListener('click', () => reorder(i, i + 1));
      const bEd = el('button', 'btn btn-sm', 'แก้ไข');
      bEd.addEventListener('click', () => fieldForm(f, draw));
      const locked = (S.protected || []).indexOf(f.field_id) >= 0;
      const lockWhy = 'หัวข้อนี้ระบบใช้ค้นหาและกรองข้อมูล ลบหรือซ่อนไม่ได้';
      const bHide = el('button', 'btn btn-sm', f.visible ? 'ซ่อน' : 'แสดง');
      bHide.disabled = locked && f.visible;
      if (bHide.disabled) bHide.title = lockWhy;
      bHide.addEventListener('click', async () => {
        try {
          const r = await api('fields.save', { field: Object.assign({}, f, { visible: !f.visible }) });
          S.fields = r.fields; draw();
        } catch (e) { toast(e.message); }
      });
      const bDel = el('button', 'btn btn-sm btn-danger', 'ลบ');
      bDel.disabled = locked;
      bDel.title = locked ? lockWhy : 'ลบหัวข้อนี้';
      bDel.addEventListener('click', async () => {
        if (!confirm('ลบหัวข้อ "' + f.label + '"?\n\nข้อมูลที่เคยกรอกไว้จะยังอยู่ในชีต และกลับมาแสดงได้ถ้าสร้างหัวข้อรหัสเดิมใหม่')) return;
        try { const r = await api('fields.delete', { field_id: f.field_id }); S.fields = r.fields; draw(); }
        catch (e) { toast(e.message); }
      });
      [bUp, bDn, bEd, bHide, bDel].forEach(b => td.appendChild(b));
      tr.appendChild(td); tb.appendChild(tr);
    });
    t.appendChild(tb);
    const wrap = el('div', 'tablewrap'); wrap.appendChild(t); list.appendChild(wrap);
    const add = el('button', 'btn btn-primary', '+ เพิ่มหัวข้อ');
    add.style.marginTop = '12px';
    add.addEventListener('click', () => fieldForm({ type: 'text', section: 'ทั่วไป', visible: true }, draw));
    list.appendChild(add);
  };

  const reorder = async (from, to) => {
    const ids = S.fields.map(f => f.field_id);
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    const r = await api('fields.reorder', { order: ids }); S.fields = r.fields; draw();
  };

  draw(); sec.appendChild(sb); return sec;
}

function fieldForm(f, done) {
  const types = [['text', 'ข้อความ'], ['number', 'ตัวเลข'], ['date', 'วันที่'], ['select', 'ตัวเลือก'], ['textarea', 'ข้อความยาว'], ['image', 'รูปภาพ/เอกสาร']];
  const label = prompt('ชื่อหัวข้อ', f.label || ''); if (!label) return;
  const type = prompt('ชนิด: ' + types.map(t => t[0]).join(' / '), f.type || 'text'); if (!type) return;
  const section = prompt('กลุ่ม (หัวข้อย่อยในฟอร์ม)', f.section || 'ทั่วไป') || 'ทั่วไป';
  const options = type === 'select' ? (prompt('ตัวเลือก คั่นด้วย |', (f.options || []).join('|')) || '').split('|').filter(Boolean) : [];
  const required = confirm('บังคับกรอกก่อนส่งตรวจสอบหรือไม่? (ตกลง = บังคับ)');
  const in_list = confirm('แสดงคอลัมน์นี้ในตารางหน้าแรกหรือไม่? (ตกลง = แสดง)');
  api('fields.save', { field: Object.assign({}, f, { label, type, section, options, required, in_list, visible: f.visible !== false }) })
    .then(r => { S.fields = r.fields; done(); toast('บันทึกหัวข้อแล้ว'); })
    .catch(e => toast(e.message));
}

function userManager() {
  const sec = el('section', 'section');
  sec.appendChild(el('h3', null, 'ผู้ใช้และบทบาท'));
  const sb = el('div', 'section-body');
  const list = el('div'); sb.appendChild(list);
  const roles = ['admin', 'staff', 'supervisor', 'manager', 'viewer'];

  /** บทบาทที่พิมพ์ผิดจะสร้างบัญชีที่เข้าระบบได้แต่ไม่มีสิทธิ์อะไรเลย จึงต้องตรงกับรายการเท่านั้น */
  const askRole = (current) => {
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
        try { await api('users.save', { user: { username: u.username, role } }); draw(); }
        catch (e) { toast(e.message); }
      });
      const bA = el('button', 'btn btn-sm', u.active ? 'ปิดใช้งาน' : 'เปิดใช้งาน');
      bA.addEventListener('click', async () => {
        try { await api('users.save', { user: { username: u.username, active: !u.active } }); draw(); }
        catch (e) { toast(e.message); }
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
    const add = el('button', 'btn btn-primary', '+ เพิ่มผู้ใช้'); add.style.marginTop = '12px';
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
  const sec = el('section', 'section');
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
const THAI_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

/** 2026-09-14 → 14 ก.ย. 2569 (ให้ตรงกับ dropdown ตัวกรองที่เป็น พ.ศ.) */
function thaiDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
  if (!m) return String(s);
  return Number(m[3]) + ' ' + THAI_MONTHS[Number(m[2]) - 1] + ' ' + (Number(m[1]) + 543);
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
