/**
 * ระบบขายเศษวัสดุเหลือใช้ (TKF) — Backend
 * Google Apps Script Web App + Google Sheets + Google Drive
 *
 * หลักการความปลอดภัย
 *  - หน้าเว็บบน GitHub Pages เป็น public เสมอ → ห้ามเก็บข้อมูล/รหัสผ่านไว้ที่นั่น
 *  - ทุก request ต้องแนบ token ที่ออกโดยไฟล์นี้ และตรวจสิทธิ์ที่นี่เท่านั้น
 *  - ไฟล์รูปใน Drive เป็น private (ไม่ตั้ง "ใครมีลิงก์ก็ดูได้") ส่งผ่านสคริปต์นี้หลังตรวจ token แล้ว
 */

// ───────────────────────── ตั้งค่า ─────────────────────────
const SESSION_HOURS    = 12;      // อายุ session
const MAX_LOGIN_FAILS  = 5;       // ล็อกชั่วคราวหลังกรอกผิดกี่ครั้ง
const LOCKOUT_SECONDS  = 3;       // ตอนติดตั้งตั้งสั้นไว้ได้ ใช้งานจริงควรกลับไป 60 ขึ้นไป
const HASH_ROUNDS      = 1000;    // จำนวนรอบ SHA-256 (ชะลอการเดารหัส)
const ALLOW_SELF_APPROVE = false; // true = อนุญาตให้คนสร้างเอกสารเซ็นอนุมัติเอกสารตัวเองได้
const DRIVE_ROOT_NAME  = 'TKF-ScrapSales-Files';
// หัวข้อที่ระบบใช้เป็นคอลัมน์ดัชนี (ค้นหา/กรอง/เรียง) — ลบไม่ได้ ดู keyField()
const PROTECTED_FIELDS = ['f_date', 'f_supplier'];
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // ต่อไฟล์
const CACHE_TTL_SEC    = 1500;    // อายุแคช session/ผู้ใช้ (วินาที) — กันไม่ให้ต้องไล่อ่านชีตทุกคำขอ

// บทบาทและสิทธิ์ — เป็นรายการเดียวที่ระบบยอมรับ ใช้ทั้งตอนตรวจสิทธิ์และตอนบันทึกผู้ใช้
const ROLE_RIGHTS = {
  admin:      ['read', 'write', 'submit', 'review', 'approve', 'delete', 'fields', 'users', 'reopen'],
  staff:      ['read', 'write', 'submit'],
  supervisor: ['read', 'review'],
  manager:    ['read', 'approve'],
  viewer:     ['read']
};
const ROLES = Object.keys(ROLE_RIGHTS);

const SH = {
  users: 'users', sessions: 'sessions', fields: 'fields',
  records: 'records', files: 'files', audit: 'audit'
};

const STATUS = {
  draft: 'ร่าง', submitted: 'รอตรวจสอบ', reviewed: 'รออนุมัติ',
  complete: 'สมบูรณ์', rejected: 'ตีกลับ'
};

// ───────────────────────── Router ─────────────────────────
function doGet(e) {
  return json({ ok: true, service: 'tkf-scrap-sales', time: new Date().toISOString() });
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) return json({ ok: false, error: 'ไม่มีข้อมูลที่ส่งมา' });
    const req = JSON.parse(e.postData.contents);
    const action = String(req.action || '');

    // เปิดได้โดยไม่ต้องมี token
    if (action === 'ping')  return json({ ok: true, time: new Date().toISOString() });
    if (action === 'login') return json(handleLogin(req));

    const session = requireSession(req.token);
    switch (action) {
      case 'me':             return json({ ok: true, user: session });
      case 'logout':         return json(handleLogout(req.token));
      case 'bootstrap':      return json(handleBootstrap(session));
      case 'records.list':   return json(handleRecordList(session, req));
      case 'records.get':    return json(handleRecordGet(session, req));
      case 'records.save':   return json(handleRecordSave(session, req));
      case 'records.move':   return json(handleRecordMove(session, req));
      case 'records.delete': return json(handleRecordDelete(session, req));
      case 'files.upload':   return json(handleFileUpload(session, req));
      case 'files.batch':    return json(handleFileBatch(session, req));
      case 'files.get':      return json(handleFileGet(session, req));
      case 'fields.save':    return json(handleFieldSave(session, req));
      case 'fields.delete':  return json(handleFieldDelete(session, req));
      case 'fields.reorder': return json(handleFieldReorder(session, req));
      case 'users.list':     return json(handleUserList(session));
      case 'users.save':     return json(handleUserSave(session, req));
      case 'users.password': return json(handleUserPassword(session, req));
      default:               return json({ ok: false, error: 'ไม่รู้จักคำสั่ง: ' + action });
    }
  } catch (err) {
    return json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ───────────────────────── Auth ─────────────────────────
function handleLogin(req) {
  const username = String(req.username || '').trim().toLowerCase();
  const password = String(req.password || '');
  if (!username || !password) return { ok: false, error: 'กรอกชื่อผู้ใช้และรหัสผ่าน' };

  const lockKey = 'lock:' + username;
  const gate = readLoginLock(lockKey);
  if (gate.until > Date.now()) {
    const left = Math.ceil((gate.until - Date.now()) / 1000);
    return { ok: false, error: 'กรอกรหัสผิดหลายครั้ง ลองใหม่ใน ' + left + ' วินาที' };
  }

  const row = findUser(username);
  const okPass = row && String(row.active).toLowerCase() === 'true' &&
                 hashPassword(password, row.salt) === row.password_hash;

  if (!okPass) {
    bumpLoginFail(lockKey);
    audit(username, 'login.fail', '', '');
    return { ok: false, error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' }; // ไม่บอกว่าผิดตรงไหน
  }

  PropertiesService.getScriptProperties().deleteProperty(lockKey);
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  const expires = new Date(Date.now() + SESSION_HOURS * 3600 * 1000);
  sheet(SH.sessions).appendRow([token, username, new Date(), expires]);
  audit(username, 'login.ok', '', '');
  return {
    ok: true, token: token, expiresAt: expires.toISOString(),
    user: { username: username, name: row.display_name, role: row.role }
  };
}

/** อ่าน-บวก-เขียนตัวนับรหัสผิด ต้องอยู่ในล็อกเดียวกัน
 *  ไม่งั้นยิงพร้อมกันหลายคำขอจะอ่านค่าเดิมพร้อมกันแล้วนับได้แค่ครั้งเดียว = เดารหัสได้ไม่จำกัด */
function bumpLoginFail(key) {
  const lock = LockService.getScriptLock();
  let held = false;
  try { held = lock.tryLock(10000); } catch (e) { held = false; }
  try {
    const cur = readLoginLock(key);
    cur.fails = (cur.fails || 0) + 1;
    if (cur.fails >= MAX_LOGIN_FAILS) { cur.until = Date.now() + LOCKOUT_SECONDS * 1000; cur.fails = 0; }
    PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(cur));
  } finally { if (held) lock.releaseLock(); }
}

function readLoginLock(key) {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(key) || '{"fails":0,"until":0}'); }
  catch (e) { return { fails: 0, until: 0 }; }
}

function handleLogout(token) {
  const sh = sheet(SH.sessions);
  const data = sh.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    if (data[i][0] === token) { sh.deleteRow(i + 1); break; }
  }
  dropSessionCache(token);
  return { ok: true };
}

function requireSession(token) {
  if (!token) throw new Error('AUTH: กรุณาเข้าสู่ระบบ');
  const s = lookupSession(token);
  if (!s) throw new Error('AUTH: เซสชันไม่ถูกต้อง กรุณาเข้าสู่ระบบใหม่');
  if (s.expires < Date.now()) { dropSessionCache(token); throw new Error('AUTH: เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่'); }

  const u = lookupUser(s.username);
  if (!u || String(u.active).toLowerCase() !== 'true') {
    dropSessionCache(token);
    throw new Error('AUTH: บัญชีถูกปิดใช้งาน');
  }

  // ต่ออายุแบบเลื่อน: ใช้งานอยู่จะไม่หลุดกลางคัน เขียนชีตเฉพาะตอนเหลือไม่ถึงครึ่ง
  const full = SESSION_HOURS * 3600 * 1000;
  if (s.expires - Date.now() < full / 2) renewSession(token, s, full);

  return { username: u.username, name: u.display_name, role: u.role };
}

/* แคช session/ผู้ใช้ไว้ใน CacheService — เดิมทุกคำขอต้องไล่อ่านทั้งชีต sessions และ users
   ซึ่งเป็นต้นทุนหลักของความหน่วง แคชถูกล้างทันทีตอน logout / ปิดบัญชี / แก้ผู้ใช้
   จึงไม่มีช่วงที่บัญชีถูกปิดแล้วยังใช้งานต่อได้ */
function lookupSession(token) {
  const cache = CacheService.getScriptCache();
  const key = 'sess:' + token;
  const hit = cache.get(key);
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  const data = sheet(SH.sessions).getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === token) {
      const s = { username: String(data[i][1]), expires: new Date(data[i][3]).getTime() };
      cache.put(key, JSON.stringify(s), CACHE_TTL_SEC);
      return s;
    }
  }
  return null;
}

/** หาแถวใหม่ทุกครั้งแทนการจำเลขแถวไว้ — cleanupSessions ลบแถวแล้วเลขแถวที่จำไว้จะเลื่อน */
function renewSession(token, s, full) {
  const sh = sheet(SH.sessions);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] !== token) continue;
    const until = new Date(Date.now() + full);
    sh.getRange(i + 1, 4).setValue(until);
    s.expires = until.getTime();
    CacheService.getScriptCache().put('sess:' + token, JSON.stringify(s), CACHE_TTL_SEC);
    return;
  }
}

function dropSessionCache(token) {
  try { CacheService.getScriptCache().remove('sess:' + token); } catch (e) {}
}

function lookupUser(username) {
  const cache = CacheService.getScriptCache();
  const key = 'user:' + username;
  const hit = cache.get(key);
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  const u = findUser(username);
  if (u) cache.put(key, JSON.stringify({
    username: u.username, display_name: u.display_name, role: u.role, active: u.active
  }), CACHE_TTL_SEC);
  return u;
}

function dropUserCache(username) {
  try { CacheService.getScriptCache().remove('user:' + String(username).trim().toLowerCase()); } catch (e) {}
}

function hashPassword(password, salt) {
  let v = salt + '|' + password;
  for (let i = 0; i < HASH_ROUNDS; i++) {
    v = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, v, Utilities.Charset.UTF_8));
  }
  return v;
}

function findUser(username) {
  const data = sheet(SH.users).getDataRange().getValues();
  const head = data[0];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === username) return rowObj(head, data[i], i + 1);
  }
  return null;
}

function can(session, what) {
  return (ROLE_RIGHTS[session.role] || []).indexOf(what) >= 0;
}

function need(session, what) {
  if (!can(session, what)) throw new Error('ไม่มีสิทธิ์ทำรายการนี้ (บทบาท: ' + session.role + ')');
}

// ───────────────────────── Bootstrap ─────────────────────────
function handleBootstrap(session) {
  return {
    ok: true,
    user: session,
    fields: listFields(),
    statuses: STATUS,
    protectedFields: PROTECTED_FIELDS,
    permissions: {
      write: can(session, 'write'), submit: can(session, 'submit'),
      review: can(session, 'review'), approve: can(session, 'approve'),
      del: can(session, 'delete'), fields: can(session, 'fields'), users: can(session, 'users')
    }
  };
}

// ───────────────────────── Fields (หัวข้อแบบปรับได้เอง) ─────────────────────────
function listFields() {
  const data = sheet(SH.fields).getDataRange().getValues();
  const head = data[0];
  const out = [];
  for (let i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    const o = rowObj(head, data[i], i + 1);
    out.push({
      field_id: o.field_id, label: o.label, type: o.type, section: o.section,
      options: String(o.options || '').split('|').filter(String),
      required: String(o.required).toLowerCase() === 'true',
      visible: String(o.visible).toLowerCase() === 'true',
      in_list: String(o.in_list).toLowerCase() === 'true',
      order: Number(o.order) || 0
    });
  }
  out.sort(function (a, b) { return a.order - b.order; });
  return out;
}

function handleFieldSave(session, req) {
  need(session, 'fields');
  const f = req.field || {};
  if (!f.label) return { ok: false, error: 'ต้องระบุชื่อหัวข้อ' };
  // ซ่อนก็ไม่ได้: ถ้าไม่มีช่องนี้ในฟอร์ม ค่าที่บันทึกจะว่าง คอลัมน์ดัชนีก็ใช้กรองไม่ได้ เท่ากับลบทิ้ง
  if (PROTECTED_FIELDS.indexOf(String(f.field_id)) >= 0 && f.visible === false)
    return { ok: false, error: 'หัวข้อนี้ระบบใช้ค้นหาและกรองข้อมูล ซ่อนไม่ได้' };
  const sh = sheet(SH.fields);
  const data = sh.getDataRange().getValues();
  const head = data[0];
  const row = [
    f.field_id || ('f_' + Utilities.getUuid().slice(0, 8)),
    f.label, f.type || 'text', f.section || 'ทั่วไป',
    (f.options || []).join('|'),
    !!f.required, f.visible === false ? false : true,
    !!f.in_list,
    Number(f.order) || (data.length)
  ];
  let found = -1;
  for (let i = 1; i < data.length; i++) if (data[i][0] === f.field_id) { found = i + 1; break; }
  if (found > 0) sh.getRange(found, 1, 1, head.length).setValues([row]);
  else sh.appendRow(row);
  audit(session.username, found > 0 ? 'field.update' : 'field.create', '', f.label);
  return { ok: true, fields: listFields() };
}

/** ลบหัวข้อ = ลบนิยามออกเท่านั้น ค่าที่เคยบันทึกไว้ใน data_json ยังอยู่ครบ (กู้คืนได้ด้วยการสร้าง field_id เดิม) */
function handleFieldDelete(session, req) {
  need(session, 'fields');
  if (PROTECTED_FIELDS.indexOf(String(req.field_id)) >= 0)
    return { ok: false, error: 'หัวข้อนี้ระบบใช้ค้นหาและกรองข้อมูล ลบไม่ได้ (ซ่อนได้)' };
  const sh = sheet(SH.fields);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === req.field_id) { sh.deleteRow(i + 1); audit(session.username, 'field.delete', '', req.field_id); break; }
  }
  return { ok: true, fields: listFields() };
}

function handleFieldReorder(session, req) {
  need(session, 'fields');
  const order = req.order || []; // [field_id, ...]
  const sh = sheet(SH.fields);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const idx = order.indexOf(data[i][0]);
    if (idx >= 0) sh.getRange(i + 1, 9).setValue(idx + 1);
  }
  return { ok: true, fields: listFields() };
}

// ───────────────────────── Records ─────────────────────────
function handleRecordList(session, req) {
  need(session, 'read');
  const sh = sheet(SH.records);
  const data = sh.getDataRange().getValues();
  const head = data[0];
  const status = req.status || '';
  const q = String(req.q || '').trim().toLowerCase();
  const year = req.year ? Number(req.year) : 0;
  const month = req.month ? Number(req.month) : 0;

  const listFieldIds = listFields().filter(function (f) { return f.in_list; }).map(function (f) { return f.field_id; });
  const rows = [];
  // นับตามตัวกรองปี/เดือน/คำค้นที่ใช้อยู่ (แต่ไม่กรองด้วยสถานะ) ตัวเลขบนแท็บจะได้ตรงกับแถวที่เห็นจริง
  const counts = {};
  Object.keys(STATUS).forEach(function (k) { counts[STATUS[k]] = 0; });

  for (let i = 1; i < data.length; i++) {
    const o = rowObj(head, data[i], i + 1);
    if (!o.id) continue;
    if (o.doc_date) {
      const d = new Date(o.doc_date);
      if (year && d.getFullYear() !== year) continue;
      if (month && (d.getMonth() + 1) !== month) continue;
    }
    const dj = safeParse(o.data_json);
    if (q) {
      const hay = (o.supplier + ' ' + o.id + ' ' + JSON.stringify(dj)).toLowerCase();
      if (hay.indexOf(q) < 0) continue;
    }
    counts[o.status] = (counts[o.status] || 0) + 1;
    if (status && o.status !== status) continue;
    const brief = {};
    listFieldIds.forEach(function (fid) { brief[fid] = displayValue(dj[fid]); });
    rows.push({
      id: o.id, status: o.status, doc_date: fmtDate(o.doc_date), supplier: o.supplier,
      created_by: o.created_by, updated_at: fmtDateTime(o.updated_at),
      updated_ms: o.updated_at ? new Date(o.updated_at).getTime() : 0,
      photos: countPhotos(dj), brief: brief
    });
  }
  rows.sort(function (a, b) { return (b.doc_date || '').localeCompare(a.doc_date || ''); });
  return { ok: true, rows: rows, counts: counts };
}

function handleRecordGet(session, req) {
  need(session, 'read');
  const r = findRecord(req.id);
  if (!r) return { ok: false, error: 'ไม่พบเอกสาร' };
  return { ok: true, record: recordOut(r) };
}

function handleRecordSave(session, req) {
  need(session, 'write');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet(SH.records);
    const incoming = req.record || {};
    const data = incoming.data || {};
    const now = new Date();
    const docDate = data[keyField('date')] || '';
    const supplier = data[keyField('supplier')] || '';

    if (incoming.id) {
      const r = findRecord(incoming.id);
      if (!r) return { ok: false, error: 'ไม่พบเอกสาร' };
      assertEditable(session, r);
      sh.getRange(r._row, 1, 1, 13).setValues([[
        r.id, r.created_at, r.created_by, now, session.username, r.status,
        docDate, supplier, JSON.stringify(data),
        r.sign_staff, r.sign_supervisor, r.sign_manager, r.note || ''
      ]]);
      audit(session.username, 'record.update', r.id, '');
      return { ok: true, record: recordOut(findRecord(r.id)) };
    }

    const id = nextId();
    sh.appendRow([id, now, session.username, now, session.username, STATUS.draft,
      docDate, supplier, JSON.stringify(data), '', '', '', '']);
    audit(session.username, 'record.create', id, '');
    return { ok: true, record: recordOut(findRecord(id)) };
  } finally { lock.releaseLock(); }
}

/** เปลี่ยนสถานะตาม workflow — ตรวจสิทธิ์และลำดับขั้นที่ฝั่ง server เท่านั้น */
function handleRecordMove(session, req) {
  const r = findRecord(req.id);
  if (!r) return { ok: false, error: 'ไม่พบเอกสาร' };
  const to = req.to;
  const note = String(req.note || '');
  const stamp = session.name + ' (' + session.username + ') ' + fmtDateTime(new Date());

  const sh = sheet(SH.records);
  const set = function (status, col, value) {
    sh.getRange(r._row, 6).setValue(status);
    sh.getRange(r._row, 4).setValue(new Date());
    sh.getRange(r._row, 5).setValue(session.username);
    if (col) sh.getRange(r._row, col).setValue(value);
    sh.getRange(r._row, 13).setValue(note);
  };

  if (to === STATUS.submitted) {
    need(session, 'submit');
    if ([STATUS.draft, STATUS.rejected].indexOf(r.status) < 0) return { ok: false, error: 'ส่งตรวจได้เฉพาะเอกสารสถานะร่างหรือตีกลับ' };
    assertEditable(session, r); // ส่งตรวจได้เฉพาะเอกสารที่ตนเองจัดทำ

    const missing = listFields().filter(function (f) { return f.visible && f.required && !safeParse(r.data_json)[f.field_id]; })
      .map(function (f) { return f.label; });
    if (missing.length) return { ok: false, error: 'ยังไม่ได้กรอก: ' + missing.join(', ') };
    set(STATUS.submitted, 10, stamp);
  } else if (to === STATUS.reviewed) {
    need(session, 'review');
    if (r.status !== STATUS.submitted) return { ok: false, error: 'ตรวจสอบได้เฉพาะเอกสารที่รอตรวจสอบ' };
    assertNotSelf(session, r);
    set(STATUS.reviewed, 11, stamp);
  } else if (to === STATUS.complete) {
    need(session, 'approve');
    if (r.status !== STATUS.reviewed) return { ok: false, error: 'อนุมัติได้เฉพาะเอกสารที่ผ่านการตรวจสอบแล้ว' };
    assertNotSelf(session, r);
    set(STATUS.complete, 12, stamp);
  } else if (to === STATUS.rejected) {
    if (!can(session, 'review') && !can(session, 'approve')) throw new Error('ไม่มีสิทธิ์ตีกลับเอกสาร');
    if ([STATUS.submitted, STATUS.reviewed].indexOf(r.status) < 0) return { ok: false, error: 'ตีกลับได้เฉพาะเอกสารที่อยู่ระหว่างตรวจสอบ/อนุมัติ' };
    if (!note) return { ok: false, error: 'ต้องระบุเหตุผลที่ตีกลับ' };
    set(STATUS.rejected, null, null);
    // ล้างลายเซ็นตรวจสอบ/อนุมัติ ไม่ให้ค้างอยู่บนเอกสารที่ยังไม่ผ่าน
    sh.getRange(r._row, 11, 1, 2).setValues([['', '']]);
  } else if (to === STATUS.draft) {
    need(session, 'reopen'); // admin เท่านั้น
    set(STATUS.draft, null, null);
    sh.getRange(r._row, 10, 1, 3).setValues([['', '', '']]);
  } else {
    return { ok: false, error: 'สถานะปลายทางไม่ถูกต้อง' };
  }
  audit(session.username, 'record.move→' + to, r.id, note);
  return { ok: true, record: recordOut(findRecord(r.id)) };
}

function handleRecordDelete(session, req) {
  need(session, 'delete');
  const r = findRecord(req.id);
  if (!r) return { ok: false, error: 'ไม่พบเอกสาร' };
  // ลบไฟล์แนบใน Drive ด้วย
  const fsh = sheet(SH.files);
  const fd = fsh.getDataRange().getValues();
  for (let i = fd.length - 1; i >= 1; i--) {
    if (fd[i][1] === r.id) {
      try { DriveApp.getFileById(fd[i][0]).setTrashed(true); } catch (e) {}
      fsh.deleteRow(i + 1);
    }
  }
  sheet(SH.records).deleteRow(r._row);
  audit(session.username, 'record.delete', r.id, '');
  return { ok: true };
}

function assertEditable(session, r) {
  if (session.role === 'admin') return;
  if ([STATUS.draft, STATUS.rejected].indexOf(r.status) < 0)
    throw new Error('เอกสารสถานะ "' + r.status + '" แก้ไขไม่ได้');
  if (r.created_by !== session.username)
    throw new Error('แก้ไขได้เฉพาะเอกสารที่ตนเองสร้าง');
}

function assertNotSelf(session, r) {
  if (!ALLOW_SELF_APPROVE && r.created_by === session.username && session.role !== 'admin')
    throw new Error('ไม่สามารถเซ็นเอกสารที่ตนเองเป็นผู้จัดทำได้');
}

function findRecord(id) {
  if (!id) return null;
  const data = sheet(SH.records).getDataRange().getValues();
  const head = data[0];
  for (let i = 1; i < data.length; i++) if (String(data[i][0]) === String(id)) return rowObj(head, data[i], i + 1);
  return null;
}

function recordOut(r) {
  return {
    id: r.id, status: r.status, created_by: r.created_by,
    created_at: fmtDateTime(r.created_at), updated_at: fmtDateTime(r.updated_at),
    updated_by: r.updated_by, note: r.note,
    sign: { staff: r.sign_staff, supervisor: r.sign_supervisor, manager: r.sign_manager },
    data: safeParse(r.data_json)
  };
}

function nextId() {
  const props = PropertiesService.getScriptProperties();
  const y = new Date().getFullYear();
  const key = 'seq:' + y;
  const n = Number(props.getProperty(key) || 0) + 1;
  props.setProperty(key, String(n));
  return 'SC' + y + '-' + ('000' + n).slice(-4);
}

function keyField(kind) {
  // field_id ที่ใช้เป็นคอลัมน์ดัชนีสำหรับค้นหา/กรอง
  return kind === 'date' ? 'f_date' : 'f_supplier';
}

// ───────────────────────── Files (รูป/เอกสารแนบ) ─────────────────────────
function handleFileUpload(session, req) {
  need(session, 'write');
  const recordId = String(req.recordId || '');
  const fieldId = String(req.fieldId || '');
  if (!recordId || !fieldId) return { ok: false, error: 'ข้อมูลไม่ครบ' };
  const r = findRecord(recordId);
  if (!r) return { ok: false, error: 'ไม่พบเอกสาร' };
  assertEditable(session, r);

  // เก็บกวาดไฟล์รุ่นก่อนของช่องนี้ ทำ "ก่อน" อัปโหลด และเก็บไฟล์ที่ data_json ชี้อยู่ไว้เสมอ
  // ถ้าลบไฟล์ที่เอกสารยังอ้างถึงแล้วการบันทึกรอบถัดไปพลาด (เน็ตหลุดกลางลาน) รูปจะหายจากเอกสารทันที
  // จึงยอมให้ไฟล์ค้างได้ 1 รุ่นต่อช่อง แล้วเก็บกวาดตอนอัปโหลดครั้งถัดไป
  purgeFieldFiles(recordId, fieldId, linkedIds(safeParse(r.data_json)[fieldId]));

  const mime = req.mime || 'image/jpeg';
  const full = Utilities.base64Decode(req.full);
  const thumb = Utilities.base64Decode(req.thumb);
  if (full.length > MAX_UPLOAD_BYTES) return { ok: false, error: 'ไฟล์ใหญ่เกิน 8 MB' };

  const folder = recordFolder(recordId);
  const base = fieldId + '_' + Date.now();
  const fFull = folder.createFile(Utilities.newBlob(full, mime, base + '.jpg'));
  const fThumb = folder.createFile(Utilities.newBlob(thumb, mime, base + '_t.jpg'));

  const fsh = sheet(SH.files);
  fsh.appendRow([fFull.getId(), recordId, fieldId, 'full', session.username, new Date()]);
  fsh.appendRow([fThumb.getId(), recordId, fieldId, 'thumb', session.username, new Date()]);
  audit(session.username, 'file.upload', recordId, fieldId);
  return { ok: true, full: fFull.getId(), thumb: fThumb.getId() };
}

function linkedIds(v) {
  return (v && typeof v === 'object') ? [String(v.full || ''), String(v.thumb || '')] : [];
}

/** ลบไฟล์ของช่องนี้ทั้งหมด ยกเว้นรหัสที่สั่งให้เก็บไว้ */
function purgeFieldFiles(recordId, fieldId, keepIds) {
  const fsh = sheet(SH.files);
  const fd = fsh.getDataRange().getValues();
  for (let i = fd.length - 1; i >= 1; i--) {
    if (String(fd[i][1]) !== String(recordId) || String(fd[i][2]) !== String(fieldId)) continue;
    if ((keepIds || []).indexOf(String(fd[i][0])) >= 0) continue;
    try { DriveApp.getFileById(fd[i][0]).setTrashed(true); } catch (e) {}
    fsh.deleteRow(i + 1);
  }
}

function handleFileBatch(session, req) {
  need(session, 'read');
  const ids = (req.ids || []).slice(0, 40);
  const reg = fileRegistry();
  const out = {};
  ids.forEach(function (id) {
    if (!reg[id]) return;              // ไม่อยู่ในทะเบียน = ไม่ส่งออกไป
    try {
      const f = DriveApp.getFileById(id);
      out[id] = 'data:' + f.getMimeType() + ';base64,' + Utilities.base64Encode(f.getBlob().getBytes());
    } catch (e) { out[id] = null; }
  });
  return { ok: true, files: out };
}

function handleFileGet(session, req) {
  return handleFileBatch(session, { ids: [req.id] });
}

function fileRegistry() {
  const data = sheet(SH.files).getDataRange().getValues();
  const reg = {};
  for (let i = 1; i < data.length; i++) if (data[i][0]) reg[data[i][0]] = data[i][1];
  return reg;
}

function recordFolder(recordId) {
  const root = driveRoot();
  const it = root.getFoldersByName(recordId);
  return it.hasNext() ? it.next() : root.createFolder(recordId);
}

function driveRoot() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('driveRootId');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const it = DriveApp.getFoldersByName(DRIVE_ROOT_NAME);
  const folder = it.hasNext() ? it.next() : DriveApp.createFolder(DRIVE_ROOT_NAME);
  props.setProperty('driveRootId', folder.getId());
  return folder;
}

// ───────────────────────── Users ─────────────────────────
function handleUserList(session) {
  need(session, 'users');
  const data = sheet(SH.users).getDataRange().getValues();
  const out = [];
  for (let i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    out.push({ username: data[i][0], display_name: data[i][1], role: data[i][2], active: String(data[i][5]).toLowerCase() === 'true' });
  }
  return { ok: true, users: out };
}

function handleUserSave(session, req) {
  need(session, 'users');
  const u = req.user || {};
  const username = String(u.username || '').trim().toLowerCase();
  if (!username) return { ok: false, error: 'ต้องระบุชื่อผู้ใช้' };
  // บทบาทนอกตารางสิทธิ์ = บัญชีที่เข้าระบบได้แต่ทำอะไรไม่ได้เลย และดูปกติในหน้าจัดการผู้ใช้
  if (u.role !== undefined && ROLES.indexOf(String(u.role)) < 0)
    return { ok: false, error: 'บทบาทไม่ถูกต้อง ใช้ได้เฉพาะ: ' + ROLES.join(', ') };

  const sh = sheet(SH.users);
  const existing = findUser(username);
  if (existing) {
    // อัปเดตเฉพาะช่องที่ส่งมาจริง — ส่ง role มาอย่างเดียวต้องไม่ไปเปิดบัญชีที่ปิดไว้
    const role = u.role !== undefined ? String(u.role) : String(existing.role);
    const active = u.active !== undefined ? u.active !== false
                                          : String(existing.active).toLowerCase() === 'true';
    const blocked = lastAdminGuard(username, existing, role, active);
    if (blocked) return { ok: false, error: blocked };
    sh.getRange(existing._row, 2).setValue(u.display_name || existing.display_name);
    sh.getRange(existing._row, 3).setValue(role);
    sh.getRange(existing._row, 6).setValue(active);
  } else {
    if (!u.password || String(u.password).length < 8) return { ok: false, error: 'รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร' };
    const salt = Utilities.getUuid();
    sh.appendRow([username, u.display_name || username, u.role || 'viewer', salt, hashPassword(u.password, salt), u.active !== false]);
  }
  dropUserCache(username);
  audit(session.username, 'user.save', '', username);
  return handleUserList(session);
}

/** ถ้าปล่อยให้ admin ที่ใช้งานได้เหลือศูนย์คน จะไม่มีใครแก้ผู้ใช้ได้อีกเลย
 *  ต้องไปแก้ในชีตด้วยมือเท่านั้น — กันไว้ตั้งแต่ต้น */
function lastAdminGuard(username, existing, role, active) {
  const wasActiveAdmin = String(existing.role) === 'admin' &&
                         String(existing.active).toLowerCase() === 'true';
  if (!wasActiveAdmin) return '';
  if (role === 'admin' && active) return '';
  const data = sheet(SH.users).getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    if (String(data[i][0]).trim().toLowerCase() === username) continue;
    if (String(data[i][2]) === 'admin' && String(data[i][5]).toLowerCase() === 'true') return '';
  }
  return 'ต้องเหลือผู้ดูแลระบบที่ใช้งานได้อย่างน้อย 1 บัญชี — เพิ่มผู้ดูแลคนใหม่ก่อนจึงจะเปลี่ยนบัญชีนี้ได้';
}

function handleUserPassword(session, req) {
  const target = String(req.username || session.username).trim().toLowerCase();
  if (target !== session.username) need(session, 'users'); // เปลี่ยนของคนอื่นต้องเป็น admin
  const pw = String(req.password || '');
  if (pw.length < 8) return { ok: false, error: 'รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร' };
  const u = findUser(target);
  if (!u) return { ok: false, error: 'ไม่พบผู้ใช้' };
  const salt = Utilities.getUuid();
  const sh = sheet(SH.users);
  sh.getRange(u._row, 4).setValue(salt);
  sh.getRange(u._row, 5).setValue(hashPassword(pw, salt));
  audit(session.username, 'user.password', '', target);
  return { ok: true };
}

// ───────────────────────── Helpers ─────────────────────────
function sheet(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function rowObj(head, row, rowNumber) {
  const o = { _row: rowNumber };
  head.forEach(function (h, i) { if (h) o[String(h).trim()] = row[i]; });
  return o;
}

function safeParse(s) { try { return JSON.parse(s || '{}'); } catch (e) { return {}; } }

function displayValue(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return v.thumb ? '📷' : '';
  return String(v);
}

function countPhotos(dj) {
  let n = 0;
  Object.keys(dj).forEach(function (k) { if (dj[k] && typeof dj[k] === 'object' && dj[k].full) n++; });
  return n;
}

function fmtDate(d) {
  if (!d) return '';
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);
  const dt = new Date(d);
  return isNaN(dt) ? String(d) : Utilities.formatDate(dt, 'Asia/Bangkok', 'yyyy-MM-dd');
}

function fmtDateTime(d) {
  if (!d) return '';
  const dt = new Date(d);
  return isNaN(dt) ? String(d) : Utilities.formatDate(dt, 'Asia/Bangkok', 'yyyy-MM-dd HH:mm');
}

function audit(username, action, recordId, detail) {
  try { sheet(SH.audit).appendRow([new Date(), username, action, recordId, detail]); } catch (e) {}
}

/**
 * ปลดล็อกบัญชีที่ถูกล็อกจากการกรอกรหัสผิด — รันจากเมนู Apps Script เมื่อโดนล็อกเอง
 * (แก้ค่า LOCKOUT_SECONDS อย่างเดียวไม่ช่วย เพราะเวลาปลดถูกบันทึกไว้ตั้งแต่ตอนล็อกแล้ว)
 */
function unlock() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  let n = 0;
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('lock:') === 0) { props.deleteProperty(k); n++; }
  });
  return 'ปลดล็อกแล้ว ' + n + ' บัญชี';
}

/** ล้าง session ที่หมดอายุ — ตั้ง trigger รายวันได้ */
function cleanupSessions() {
  const sh = sheet(SH.sessions);
  const data = sh.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    if (new Date(data[i][3]).getTime() < Date.now()) {
      dropSessionCache(String(data[i][0]));
      sh.deleteRow(i + 1);
    }
  }
}

// ───────────────────────── ติดตั้งครั้งแรก ─────────────────────────
/**
 * รันฟังก์ชันนี้ 1 ครั้งจากเมนู Apps Script
 * จะสร้างชีตทั้งหมด ใส่หัวข้อเริ่มต้น และสร้างบัญชี admin
 * ⚠ เปลี่ยนรหัสผ่านทันทีหลังเข้าระบบครั้งแรก
 */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const defs = {
    users:    ['username', 'display_name', 'role', 'salt', 'password_hash', 'active'],
    sessions: ['token', 'username', 'created_at', 'expires_at'],
    fields:   ['field_id', 'label', 'type', 'section', 'options', 'required', 'visible', 'in_list', 'order'],
    records:  ['id', 'created_at', 'created_by', 'updated_at', 'updated_by', 'status', 'doc_date', 'supplier', 'data_json', 'sign_staff', 'sign_supervisor', 'sign_manager', 'note'],
    files:    ['drive_id', 'record_id', 'field_id', 'kind', 'uploaded_by', 'ts'],
    audit:    ['ts', 'username', 'action', 'record_id', 'detail']
  };
  Object.keys(defs).forEach(function (name) {
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.appendRow(defs[name]);
      sh.getRange(1, 1, 1, defs[name].length).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
  });

  // หัวข้อเริ่มต้น (ย้ายมาจาก AppSheet) — แก้/เพิ่ม/ลบได้จากหน้าเว็บภายหลัง
  const f = ss.getSheetByName('fields');
  if (f.getLastRow() <= 1) {
    const img = 'image', S1 = 'ข้อมูลรายการ', S2 = 'ภาพก่อนดำเนินการ', S3 = 'ภาพระหว่างดำเนินการ',
          S4 = 'ภาพหลังดำเนินการ', S5 = 'เอกสารแนบ';
    const seed = [
      ['f_date', 'วัน/เดือน/ปี', 'date', S1, '', true, true, true],
      ['f_supplier', 'ซัพพลายเออร์', 'text', S1, '', true, true, true],
      ['f_item', 'รายการสินค้า', 'text', S1, '', true, true, true],
      ['f_plate', 'ทะเบียนรถ', 'text', S1, '', true, true, true],
      ['f_carrier', 'ผู้ขนส่ง', 'text', S1, '', false, true, false],
      ['f_qty', 'ปริมาณน้ำหนัก/จำนวน', 'number', S1, '', true, true, true],
      ['f_b_front', 'รูปหน้ารถ ก่อนดำเนินการ', img, S2, '', true, true, false],
      ['f_b_left', 'รูปข้างรถซ้าย ก่อนดำเนินการ', img, S2, '', true, true, false],
      ['f_b_back', 'รูปหลังรถ ก่อนดำเนินการ', img, S2, '', true, true, false],
      ['f_b_right', 'รูปข้างรถขวา ก่อนดำเนินการ', img, S2, '', true, true, false],
      ['f_d_1', 'รูปรถระหว่างดำเนินการ ภาพ 1', img, S3, '', false, true, false],
      ['f_d_2', 'รูปรถระหว่างดำเนินการ ภาพ 2', img, S3, '', false, true, false],
      ['f_d_3', 'รูปรถระหว่างดำเนินการ ภาพ 3', img, S3, '', false, true, false],
      ['f_d_4', 'รูปรถระหว่างดำเนินการ ภาพ 4', img, S3, '', false, true, false],
      ['f_a_front', 'รูปหน้ารถ ดำเนินการเสร็จ', img, S4, '', true, true, false],
      ['f_a_left', 'รูปข้างรถซ้าย ดำเนินการเสร็จ', img, S4, '', true, true, false],
      ['f_a_back', 'รูปหลังรถ ดำเนินการเสร็จ', img, S4, '', true, true, false],
      ['f_a_right', 'รูปข้างรถขวา ดำเนินการเสร็จ', img, S4, '', true, true, false],
      ['f_ko2', 'เอกสารแสดงการจัดการ (กอ.2)', img, S5, '', true, true, false],
      ['f_wastetag', 'รูปติด waste tag', img, S5, '', false, true, false],
      ['f_approval', 'ใบขออนุมัติขาย ลงนามเสร็จ', img, S5, '', true, true, false],
      ['f_weigh', 'ใบชั่งน้ำหนัก', img, S5, '', true, true, false],
      ['f_slip', 'สลิปโอนเงิน', img, S5, '', false, true, false],
      ['f_gps', 'รูปการติดตามระบบ GPS', img, S5, '', false, true, false],
      ['f_dest', 'รูปสินค้าถึงสถานที่ปลายทาง', img, S5, '', false, true, false],
      ['f_ko2_org', 'เอกสารแสดงการจัดการ (กอ.2 ตัวจริง)', img, S5, '', false, true, false]
    ];
    seed.forEach(function (s, i) { f.appendRow(s.concat([i + 1])); });
  }

  // บัญชีผู้ดูแลเริ่มต้น
  const u = ss.getSheetByName('users');
  if (u.getLastRow() <= 1) {
    const salt = Utilities.getUuid();
    u.appendRow(['admin', 'ผู้ดูแลระบบ', 'admin', salt, hashPassword('ChangeMe2026!', salt), true]);
  }
  driveRoot();
  SpreadsheetApp.getUi().alert('ติดตั้งเสร็จแล้ว\n\nผู้ใช้: admin\nรหัสผ่าน: ChangeMe2026!\n\nเข้าระบบแล้วเปลี่ยนรหัสผ่านทันที');
}
