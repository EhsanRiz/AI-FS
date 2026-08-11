/* =============================================================================
   FS Field Monitoring — 4D Climate Solutions
   Offline-first PWA for Field Supervisor soil-data collection (Lesotho).
   Plain JS, no build step. Backend: Supabase RPCs (see supabase/schema.sql).
   ============================================================================= */
'use strict';

/* ---------------------------------------------------------------- config -- */
var SUPABASE_URL = 'https://kgoprnbxdzwehzkxedch.supabase.co';
var SUPABASE_ANON_KEY = 'sb_publishable_ndQHws_XSRFhq7uSr2cYmw_HhuMXC-c';

var DISTRICT_COLORS = {
  'Maseru': '#2563eb', 'Berea': '#9333ea', 'Leribe': '#16a34a',
  'Mafeteng': '#ea580c', "Mohale's Hoek": '#dc2626'
};
var ZONE_COLORS = { 'Lowlands': '#eab308', 'Foothills': '#0d9488', 'Mountains': '#7c3aed' };

var PARAMS = [
  { key: 'moisture',    label: 'Moisture',  unit: '%' },
  { key: 'temperature', label: 'Temp',      unit: '°C' },
  { key: 'ph',          label: 'pH',        unit: '' },
  { key: 'ec',          label: 'EC',        unit: 'µS/cm' },
  { key: 'n',           label: 'N',         unit: 'mg/kg' },
  { key: 'p',           label: 'P',         unit: 'mg/kg' },
  { key: 'k',           label: 'K',         unit: 'mg/kg' }
];
var GPS_FLAG_M = 500;
var MAX_PHOTOS = 3;
var PHOTO_MAX_PX = 1600;      // long edge after downscale
var PHOTO_QUALITY = 0.85;     // JPEG quality
var PHOTO_MAX_B64 = 5400000;  // stay under the server's ~4 MB ceiling

/* ----------------------------------------------------------------- state -- */
var S = {
  token: localStorage.getItem('fsm_token') || null,
  me: readJSON('fsm_me'),
  boot: readJSON('fsm_boot'),       // {sites, farms, progress} cached from server
  queue: [],                        // local visit records from IndexedDB
  regQueue: [],                     // local farmer registrations awaiting sync
  syncing: false,
  map: null
};
var form = null;                    // active visit-form record

function readJSON(k) {
  try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; }
}
function sites() { return (S.boot && S.boot.sites) || (window.FSM_SEED || {}).sites || []; }
function myAssigned() { return (S.me && S.me.assigned_site_ids) || []; }
function isViewer() { return S.me && S.me.role === 'viewer'; }
function defaultSiteId() { var a = myAssigned(); return a.length === 1 ? a[0] : null; }
// Supervisors with an assigned station may only capture there (also enforced
// server-side in fs_submit_visit); managers and unassigned accounts see all.
function visitableSites() {
  if (!S.me || S.me.role !== 'supervisor') return [];   // only FS capture visits
  var a = myAssigned();
  if (S.me && S.me.role === 'supervisor' && a.length) {
    return sites().filter(function (s) { return a.indexOf(s.id) !== -1; });
  }
  return sites();
}
function canVisit(siteId) {
  return visitableSites().some(function (s) { return s.id === Number(siteId); });
}
function farmers() {
  var map = {}, order = [];
  ((S.boot && S.boot.farmers) || []).forEach(function (f) { map[f.id] = f; order.push(f.id); });
  // local registrations AND edits override the cached server copy
  S.regQueue.forEach(function (r) {
    var base = map[r.id];
    if (!base) order.push(r.id);
    map[r.id] = { id: r.id, site_id: r.site_id, name: r.name, village: r.village, gender: r.gender,
                  age: r.age, phone: r.phone, production: base ? base.production : null,
                  source: base ? base.source : 'fs_registered',
                  _state: r.state !== 'synced' ? r.state : null };
  });
  return order.map(function (id) { return map[id]; });
}
function farmersOf(siteId) {
  return farmers().filter(function (f) { return f.site_id === Number(siteId); })
    .sort(function (a, b) { return a.name.localeCompare(b.name); });
}
var _mstack = [];
var _mtitle = '';
function renderModalFrame(title, html) {
  var root = $('#modalRoot');
  if (!root) { root = document.createElement('div'); root.id = 'modalRoot'; document.body.appendChild(root); }
  root.innerHTML = '<div class="modal-overlay open" id="modalOverlay"></div>' +
    '<div class="modal open" role="dialog" aria-modal="true">' +
    (_mstack.length ? '<button class="modal-x modal-back" id="modalBack" aria-label="Back">‹</button>' : '') +
    '<button class="modal-x" id="modalX" aria-label="Close">×</button>' +
    '<h2 style="font-size:17px;color:var(--forest-dark);margin-bottom:10px;padding:0 36px 0 ' + (_mstack.length ? '40px' : '0') + '">' + esc(title) + '</h2>' +
    '<div id="modalBody">' + html + '</div></div>';
  $('#modalX').onclick = closeModal;
  $('#modalOverlay').onclick = closeModal;
  var back = $('#modalBack');
  if (back) back.onclick = modalBack;
  // drill-down inside any modal: rows can point at a visit or a site's visits
  root.onclick = function (e) {
    if (e.target.id === 'modalX' || e.target.id === 'modalBack' || e.target.id === 'modalOverlay') return;
    var vEl = e.target.closest && e.target.closest('[data-visit]');
    if (vEl) { visitDetailModal(vEl.getAttribute('data-visit')); return; }
    var spEl = e.target.closest && e.target.closest('[data-siteprofile]');
    if (spEl) { siteProfileModal(spEl.getAttribute('data-siteprofile')); return; }
    var fpEl = e.target.closest && e.target.closest('[data-fsprofile]');
    if (fpEl) { fsProfileModal(fpEl.getAttribute('data-fsprofile')); return; }
    var fdEl = e.target.closest && e.target.closest('[data-farmerdetail]');
    if (fdEl) { farmerModal(fdEl.getAttribute('data-farmerdetail')); return; }
    var sfEl = e.target.closest && e.target.closest('[data-sitefarmers]');
    if (sfEl) {
      var d = S._siteDetail || {};
      showModal('Farmers — ' + ((d.site || {}).sub_area || ''),
        ((d.farmers) || []).map(function (f) {
          return '<div class="queue-item act-row" data-farmerdetail="' + f.id + '">' +
            '<div class="row spread"><b>' + esc(f.name) + '</b>' +
            (Number(f.visits) ? '<span class="chip">' + f.visits + ' visit' + (Number(f.visits) === 1 ? '' : 's') + '</span>'
                              : '<span class="chip grey">not yet visited</span>') + '</div>' +
            (f.village ? '<div class="muted small">' + esc(f.village) + '</div>' : '') + '</div>';
        }).join(''));
      return;
    }
    var sEl = e.target.closest && e.target.closest('[data-sitevisits]');
    if (sEl) siteVisitsModal(sEl.getAttribute('data-sitevisits'));
  };
  document.addEventListener('keydown', modalEsc);
}
function showModal(title, html) {
  var root = $('#modalRoot');
  if (root && root.querySelector('.modal')) {
    _mstack.push({ t: _mtitle, h: ($('#modalBody') || {}).innerHTML || '' });
  }
  _mtitle = title;
  renderModalFrame(title, html);
}
function modalBack() {
  var prev = _mstack.pop();
  if (!prev) { closeModal(); return; }
  _mtitle = prev.t;
  renderModalFrame(prev.t, prev.h);
}
function modalEsc(e) { if (e.key === 'Escape') closeModal(); }
function closeModal() {
  _mstack = [];
  _mtitle = '';
  var root = $('#modalRoot');
  if (root) { root.innerHTML = ''; root.onclick = null; }
  document.removeEventListener('keydown', modalEsc);
}

/* ---------------- visit drill-down (works on local + synced records) ------ */
function visitDetailRows(v) {
  var gps = v.gps_lat == null ? '<span class="flag">not captured</span>'
    : Number(v.gps_lat).toFixed(5) + ', ' + Number(v.gps_lon).toFixed(5) +
      (v.gps_accuracy_m ? ' (±' + Math.round(v.gps_accuracy_m) + 'm)' : '') +
      (v.distance_from_site_m != null
        ? (Number(v.distance_from_site_m) > 500
            ? ' · <span class="flag">' + fmtDist(v.distance_from_site_m) + ' from site ⚠</span>'
            : ' · <b style="color:var(--ok)">' + fmtDist(v.distance_from_site_m) + ' from site</b>')
        : '');
  var rows = [
    ['When', fmtWhen(v.submitted_at || v.synced_at || v.updated_at)],
    ['Supervisor', v.supervisor ? esc(v.supervisor) : null],
    ['Site', esc(v.site || '') + (v.farm ? ' · ' + esc(v.farm) : '')],
    ['Farmer', v.farmer ? esc(v.farmer) : '<span class="muted">general visit</span>'],
    ['GPS', gps],
    ['Advisory', v.ai_administered === true ? '<b style="color:var(--ok)">AI advisory</b>'
                  : (v.ai_administered === false ? 'Conventional (no AI)' : '<span class="muted">not recorded</span>')],
    ['Issue', v.issue ? '<span style="color:var(--danger)">' + esc(v.issue) + '</span>' : null],
    ['Sample', v.sample_collected ? esc(v.sample_id || '✓ collected') : null],
    ['Notes', v.notes ? esc(v.notes) : null]
  ].filter(function (r) { return r[1] != null; });
  return '<table class="dash-table"><tbody>' + rows.map(function (r) {
    return '<tr><td style="color:var(--grey);white-space:nowrap">' + r[0] + '</td><td>' + r[1] + '</td></tr>';
  }).join('') + '</tbody></table>';
}
function visitReadingsTable(readings) {
  if (!readings || !readings.length) return '<p class="muted small mt8">No soil data on this visit.</p>';
  var by = {};
  readings.forEach(function (r) { (by[r.parameter] = by[r.parameter] || {})[r.replicate] = r; });
  return '<h3 class="mt12">Soil readings</h3>' +
    '<div class="scroll-x"><table class="readings-table"><thead><tr><th></th><th>R1</th><th>R2</th><th>R3</th></tr></thead><tbody>' +
    PARAMS.filter(function (p2) { return by[p2.key]; }).map(function (p2) {
      return '<tr><td>' + esc(p2.label) + (p2.unit ? '<span class="unit">' + esc(p2.unit) + '</span>' : '') + '</td>' +
        [1, 2, 3].map(function (rep2) {
          var r = by[p2.key][rep2];
          return '<td style="text-align:center">' + (r && r.value != null ? esc(r.value) : '—') + '</td>';
        }).join('') + '</tr>';
    }).join('') + '</tbody></table></div>';
}
function visitPhotosHTML(photos) {
  if (!photos || !photos.length) return '';
  return '<h3 class="mt12">Photos</h3>' + photos.map(function (ph) {
    return '<img class="modal-photo" src="data:' + (ph.mime || 'image/jpeg') + ';base64,' + ph.data_base64 + '" alt="visit photo">';
  }).join('');
}
function visitDetailModal(id) {
  var local = S.queue.find(function (r) { return r.id === id; });
  if (local) {
    var st = siteById(local.site_id) || {};
    var fm = local.farmer_id ? (farmers().find(function (x) { return x.id === local.farmer_id; }) || {}).name : null;
    var farmLabel = (farms().find(function (x) { return x.id === local.farm_id; }) || {}).label;
    showModal('Visit details',
      '<p class="small"><span class="chip state-' + local.state + '">' + local.state + '</span>' +
      (local.error ? ' <span class="small" style="color:var(--danger)">' + esc(local.error) + '</span>' : '') + '</p>' +
      visitDetailRows({
        submitted_at: local.submitted_at, updated_at: local.updated_at,
        site: st.sub_area, farm: farmLabel, farmer: fm,
        gps_lat: local.gps && local.gps.lat, gps_lon: local.gps && local.gps.lon,
        gps_accuracy_m: local.gps && local.gps.accuracy_m,
        ai_administered: local.ai_administered, issue: local.issue,
        sample_collected: local.sample_collected, sample_id: local.sample_id, notes: local.notes
      }) +
      visitReadingsTable(local.readings) +
      visitPhotosHTML(local.photos) +
      (S.me && S.me.role === 'supervisor'
        ? '<a class="btn btn-outline btn-block mt12" href="#/visit?edit=' + local.id + '">Open / edit this visit</a>' : ''));
    return;
  }
  if (!navigator.onLine) { toast('Connect to view visit details'); return; }
  showModal('Visit details', '<p class="muted small">Loading…</p>');
  rpc('fs_visit_detail', { p_token: S.token, p_visit_id: id }).then(function (d) {
    var body = $('#modalBody'); if (!body) return;
    body.innerHTML = visitDetailRows(d.visit || {}) +
      visitReadingsTable(d.readings) +
      visitPhotosHTML(d.photos);
  }).catch(function (err) {
    var body = $('#modalBody');
    if (body && !handleAuthError(err)) body.innerHTML = '<p class="small" style="color:var(--danger)">' + esc(err.message) + '</p>';
  });
}
function actRowHTML(v) {
  return '<div class="queue-item act-row" data-visit="' + v.id + '">' +
    '<div class="row spread"><b>' + esc(v.supervisor) + ' · ' + esc(v.site) + '</b>' +
    '<span class="muted small">' + fmtWhen(v.synced_at) + '</span></div>' +
    '<div class="muted small">' +
    (v.farmer ? '👤 ' + esc(v.farmer) + ' · ' : '') +
    (v.ai_administered === true ? 'AI advisory' : (v.ai_administered === false ? 'conventional' : 'advisory not recorded')) +
    (v.readings_count ? ' · ' + v.readings_count + ' readings' : '') +
    (v.gps_lat == null ? ' · <span class="flag">no GPS</span>'
      : (v.gps_flag ? ' · <span class="flag">' + fmtDist(v.distance_from_site_m) + ' away ⚠</span>' : '')) +
    (Number(v.out_of_range) ? ' · <span class="flag">' + v.out_of_range + ' out-of-range</span>' : '') +
    (Number(v.photos) ? ' · ' + v.photos + '📷' : '') +
    '</div>' +
    (v.issue ? '<div class="small" style="color:var(--danger)">' + esc(v.issue) + '</div>' : '') +
    '</div>';
}
function statLine(rows) {
  return '<table class="dash-table"><tbody>' + rows.filter(function (r) { return r[1] != null; })
    .map(function (r) { return '<tr><td style="color:var(--grey);white-space:nowrap">' + r[0] + '</td><td>' + r[1] + '</td></tr>'; })
    .join('') + '</tbody></table>';
}
function siteProfileModal(siteId) {
  if (!navigator.onLine) { toast('Connect to view site details'); return; }
  var st = siteById(siteId) || {};
  showModal(st.sub_area || 'Site', '<p class="muted small">Loading…</p>');
  rpc('fs_site_detail', { p_token: S.token, p_site_id: Number(siteId) }).then(function (d) {
    var body = $('#modalBody'); if (!body) return;
    var site = d.site || {}, stats = d.stats || {};
    var html = '<p class="small">' +
      '<span class="chip">' + esc(site.district) + '</span> ' +
      '<span class="chip grey">' + esc(site.zone) + '</span>' +
      (site.is_validation_site ? ' <span class="chip gold">validation site</span>' : '') +
      (site.rc !== site.sub_area ? ' <span class="muted">' + esc(site.rc) + ' RC</span>' : '') + '</p>';
    html += statLine([
      ['Field Supervisor', (d.supervisors || []).map(function (x) {
          return esc(x.name) + ' <span class="muted small">(' + x.visits_here + ' visits here · last active ' + fmtWhen(x.last_synced_at) + ')</span>';
        }).join('<br>') || '<span class="muted">none assigned</span>'],
      ['Visits', stats.visits],
      ['Farmers engaged', (stats.farmers_engaged || 0) + ' / ' + (stats.farmers_total || 0)],
      ['AI advisory visits', (stats.ai_visits || 0) + ' of ' + (stats.visits || 0)],
      ['Issues', stats.issues],
      ['Soil samples', stats.samples],
      ['Validation', site.is_validation_site
        ? (stats.farms_complete || 0) + '/3 farms · ' + (stats.readings_done || 0) + '/' + (stats.readings_target || 0) + ' readings'
        : null]
    ]);
    var fm = d.farmers || [];
    html += '<h3 class="mt12">Farmers (' + fm.length + ')</h3>' +
      '<p class="muted small">Tap a farmer for their profile and history.</p>' +
      fm.slice(0, 8).map(function (f) {
        return '<div class="queue-item act-row" data-farmerdetail="' + f.id + '">' +
          '<div class="row spread"><b>' + esc(f.name) + '</b>' +
          (Number(f.visits) ? '<span class="chip">' + f.visits + ' visit' + (Number(f.visits) === 1 ? '' : 's') +
            (f.ai_ever ? ' · AI advisory' : '') + '</span>' : '<span class="chip grey">not yet visited</span>') + '</div>' +
          (f.village ? '<div class="muted small">' + esc(f.village) + '</div>' : '') + '</div>';
      }).join('') +
      (fm.length > 8 ? '<button class="btn btn-outline btn-block btn-sm mt8" data-sitefarmers="' + site.id + '">All farmers (' + fm.length + ')</button>' : '');
    var vs = d.visits || [];
    html += '<h3 class="mt12">Recent visits (' + stats.visits + ')</h3>' +
      (vs.length ? vs.slice(0, 5).map(actRowHTML).join('') : '<p class="muted small">No synced visits yet.</p>') +
      (vs.length > 5 ? '<button class="btn btn-outline btn-block btn-sm mt8" data-sitevisits="' + esc(site.sub_area) + '">All visits</button>' : '');
    body.innerHTML = html;
    S._siteDetail = d;
  }).catch(function (err) {
    var body = $('#modalBody');
    if (body && !handleAuthError(err)) body.innerHTML = '<p class="small" style="color:var(--danger)">' + esc(err.message) + '</p>';
  });
}
function fsProfileModal(supId) {
  if (!navigator.onLine) { toast('Connect to view team details'); return; }
  showModal('Team member', '<p class="muted small">Loading…</p>');
  rpc('fs_supervisor_detail', { p_token: S.token, p_supervisor_id: supId }).then(function (d) {
    var body = $('#modalBody'); if (!body) return;
    var t = d.supervisor || {}, st2 = d.stats || {};
    var h2 = document.querySelector('.modal h2'); if (h2) h2.textContent = t.name || 'Team member';
    var html = '<p class="small">' +
      (t.role === 'supervisor' ? '<span class="chip">Field Supervisor</span>' :
        '<span class="chip blue">' + esc(t.role) + '</span>') +
      (t.active === false ? ' <span class="chip red">inactive</span>' : '') +
      (t.station ? ' <span class="muted">' + esc(t.station) + '</span>' : '') + '</p>';
    html += statLine([
      ['Username', t.username ? esc(t.username) : null],
      ['Phone', t.phone ? esc(t.phone) : null],
      ['Visits', st2.visits + ' total · ' + st2.visits_7d + ' this week'],
      ['AI advisory visits', st2.ai_visits + ' of ' + st2.visits + ' visits'],
      ['Farmers engaged', st2.farmers_engaged],
      ['Farmers registered', st2.farmers_registered],
      ['Issues reported', st2.issues],
      ['Soil samples', st2.samples],
      ['Last active', st2.last_synced_at ? fmtWhen(st2.last_synced_at) : 'never'],
      ['Last GPS', st2.last_gps ? esc(st2.last_gps.site) + ' · ' + fmtWhen(st2.last_gps.at) : null]
    ]);
    var vs = d.visits || [];
    html += '<h3 class="mt12">Recent visits</h3>' +
      (vs.length ? vs.map(actRowHTML).join('') : '<p class="muted small">No synced visits yet.</p>');
    body.innerHTML = html;
  }).catch(function (err) {
    var body = $('#modalBody');
    if (body && !handleAuthError(err)) body.innerHTML = '<p class="small" style="color:var(--danger)">' + esc(err.message) + '</p>';
  });
}
function siteVisitsModal(siteName) {
  function open(act) {
    var rows = ((act && act.visits) || []).filter(function (v) { return v.site === siteName; });
    showModal('Visits — ' + siteName,
      rows.length ? rows.map(actRowHTML).join('') : '<p class="muted small">No synced visits at this site yet.</p>');
  }
  if (S._act) { open(S._act); return; }
  if (!navigator.onLine || !S.me || S.me.role === 'supervisor') { toast('No visit list available'); return; }
  rpc('fs_activity', { p_token: S.token }).then(function (a) { S._act = a; open(a); })
    .catch(function (err) { if (!handleAuthError(err)) toast(err.message); });
}
function copyrightHTML() {
  return '<p class="copyright">© ' + new Date().getFullYear() +
    ' 4D Climate Solutions · creative · innovative · green · sustainable</p>';
}
function farms() { return (S.boot && S.boot.farms) || (window.FSM_SEED || {}).farms || []; }
function siteById(id) { return sites().find(function (s) { return s.id === Number(id); }); }
function farmsOf(siteId) { return farms().filter(function (f) { return f.site_id === Number(siteId); }); }

/* ------------------------------------------------------------------ util -- */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function $(sel, el) { return (el || document).querySelector(sel); }
function $all(sel, el) { return Array.prototype.slice.call((el || document).querySelectorAll(sel)); }
function uuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}
function toast(msg) {
  var t = $('#toast'); if (!t) return;
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove('show'); }, 2600);
}
function fmtWhen(iso) {
  if (!iso) return '—';
  var d = new Date(iso), now = new Date(), diff = (now - d) / 1000;
  if (diff < 90) return 'just now';
  if (diff < 3600) return Math.round(diff / 60) + ' min ago';
  if (diff < 86400 * 2 && d.toDateString() === now.toDateString())
    return 'today ' + d.toTimeString().slice(0, 5);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' + d.toTimeString().slice(0, 5);
}
function haversineM(lat1, lon1, lat2, lon2) {
  var R = 6371000, toR = Math.PI / 180;
  var a = Math.pow(Math.sin((lat2 - lat1) * toR / 2), 2) +
          Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.pow(Math.sin((lon2 - lon1) * toR / 2), 2);
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(a))));
}

/* ------------------------------------------------------------------- api -- */
function rpc(fn, args) {
  return fetch(SUPABASE_URL + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(args || {})
  }).then(function (res) {
    if (res.ok) return res.status === 204 ? null : res.json();
    return res.json().catch(function () { return {}; }).then(function (body) {
      var msg = (body && body.message) || ('Request failed (' + res.status + ')');
      var err = new Error(msg);
      err.status = res.status;
      err.isAuth = res.status === 403 && (msg === 'AUTH' || /session|token/i.test(msg));
      if (msg === 'AUTH') err.message = 'Session expired — please sign in again.';
      throw err;
    });
  });
}
function handleAuthError(err) {
  if (err && (err.isAuth || err.message === 'AUTH')) { doLogout(true); return true; }
  return false;
}

/* ------------------------------------------------------------- IndexedDB -- */
var idb = {
  _db: null,
  open: function () {
    if (idb._db) return Promise.resolve(idb._db);
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open('fsm', 2);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('visits')) db.createObjectStore('visits', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('farmers')) db.createObjectStore('farmers', { keyPath: 'id' });
      };
      req.onsuccess = function () { idb._db = req.result; resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  },
  put: function (store, rec) {
    return idb.open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).put(rec);
        tx.oncomplete = resolve; tx.onerror = function () { reject(tx.error); };
      });
    });
  },
  del: function (store, id) {
    return idb.open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).delete(id);
        tx.oncomplete = resolve; tx.onerror = function () { reject(tx.error); };
      });
    });
  },
  all: function (store) {
    return idb.open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var req = db.transaction(store).objectStore(store).getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }
};
function loadQueue() {
  return Promise.all([idb.all('visits'), idb.all('farmers')]).then(function (res) {
    var rows = res[0];
    rows.sort(function (a, b) { return (b.updated_at || '').localeCompare(a.updated_at || ''); });
    S.queue = rows;
    S.regQueue = res[1];
    return rows;
  });
}
function pendingCount() {
  return S.queue.filter(function (r) { return r.state === 'queued' || r.state === 'failed'; }).length;
}

/* ------------------------------------------------------------------ sync -- */
function syncAll(manual) {
  if (S.syncing || !S.token) return Promise.resolve();
  if (!navigator.onLine) {
    if (manual) toast('You are offline — will sync when back online');
    return Promise.resolve();
  }
  S.syncing = true;
  updateNetDot();
  return loadQueue().then(function () {
    var chain = Promise.resolve();
    var okCount = 0, failCount = 0;
    // farmer registrations sync first so visits referencing them don't bounce
    S.regQueue.filter(function (r) { return r.state === 'queued' || r.state === 'failed'; })
      .forEach(function (reg) {
        chain = chain.then(function () {
          return rpc('fs_register_farmer', {
            p_token: S.token,
            p_farmer: { id: reg.id, site_id: reg.site_id, name: reg.name, village: reg.village,
                        gender: reg.gender, age: reg.age, phone: reg.phone }
          }).then(function () {
            reg.state = 'synced';
            reg.error = null;
            return idb.put('farmers', reg);
          }).catch(function (err) {
            if (handleAuthError(err)) throw err;
            reg.state = 'failed';
            reg.error = err.message;
            failCount++;
            return idb.put('farmers', reg);
          });
        });
      });
    var todo = S.queue.filter(function (r) { return r.state === 'queued' || r.state === 'failed'; });
    todo.forEach(function (rec) {
      chain = chain.then(function () {
        return rpc('fs_submit_visit', {
          p_token: S.token,
          p_visit: {
            id: rec.id, site_id: rec.site_id, farm_id: rec.farm_id || null,
            farmer_id: rec.farmer_id || null,
            ai_administered: rec.ai_administered,
            issue: rec.issue || null,
            gps_lat: rec.gps ? rec.gps.lat : null, gps_lon: rec.gps ? rec.gps.lon : null,
            gps_accuracy_m: rec.gps ? rec.gps.accuracy_m : null,
            started_at: rec.started_at, submitted_at: rec.submitted_at,
            sample_collected: !!rec.sample_collected, sample_id: rec.sample_id || null,
            notes: rec.notes || null
          },
          p_readings: rec.readings || [],
          p_photos: (rec.photos || []).map(function (p) {
            return { id: p.id, mime: p.mime, data_base64: p.data_base64 };
          })
        }).then(function (res) {
          rec.state = 'synced';
          rec.error = null;
          rec.server_distance_m = res && res.distance_from_site_m != null ? Number(res.distance_from_site_m) : null;
          rec.synced_at = new Date().toISOString();
          okCount++;
          return idb.put('visits', rec);
        }).catch(function (err) {
          if (handleAuthError(err)) throw err;
          rec.state = 'failed';
          rec.error = err.message;
          failCount++;
          return idb.put('visits', rec);
        });
      });
    });
    return chain.then(function () {
      if (todo.length && (manual || okCount)) {
        toast(okCount + ' visit' + (okCount === 1 ? '' : 's') + ' synced' + (failCount ? ', ' + failCount + ' failed' : ''));
      } else if (manual && !todo.length) {
        toast('Nothing to sync');
      }
      if (okCount) refreshBoot();
    });
  }).catch(function () {}).then(function () {
    S.syncing = false;
    updateNetDot();
    var r = (location.hash || '#/home').replace(/^#/, '');
    var v = $('#view');
    if (r === '/queue' && v) { v.innerHTML = viewQueue(); bindQueue(); }
    else if ((r === '/home' || r === '') && v && S.me && S.me.role !== 'manager') {
      v.innerHTML = viewSmartHome(); bindSmartHome();
    }
    renderNavBadge();
  });
}
function refreshBoot() {
  if (!S.token || !navigator.onLine) return Promise.resolve();
  return rpc('fs_bootstrap', { p_token: S.token }).then(function (boot) {
    S.boot = boot;
    localStorage.setItem('fsm_boot', JSON.stringify(boot));
    if (boot.supervisor) {
      S.me = boot.supervisor;
      localStorage.setItem('fsm_me', JSON.stringify(boot.supervisor));
    }
  }).catch(function (err) { handleAuthError(err); });
}

/* ------------------------------------------------------------------ auth -- */
function doLogout(expired) {
  localStorage.removeItem('fsm_token');
  localStorage.removeItem('fsm_me');
  localStorage.removeItem('fsm_boot');
  S.token = null; S.me = null; S.boot = null;
  location.hash = '#/login';
  render();
  if (expired) toast('Session expired — please sign in again');
}

/* ---------------------------------------------------------------- render -- */
function render() {
  var route = (location.hash || '#/home').replace(/^#/, '');
  if (!S.token && route !== '/login') { location.hash = '#/login'; return; }
  if (S.token && route === '/login') { location.hash = '#/home'; return; }

  var root = $('#root');
  if (route === '/login') { root.innerHTML = viewLogin(); bindLogin(); return; }

  root.innerHTML =
    headerHTML() +
    '<div id="offBar" class="offline-bar"' + (navigator.onLine ? ' hidden' : '') + '>' +
    'You are offline — visits are saved on this phone and will sync automatically when you are back online.</div>' +
    '<main id="view"></main>' +
    navHTML(route) +
    '<div id="toast"></div>';

  if (route.indexOf('/visit') === 0 && S.me && S.me.role !== 'supervisor') { location.hash = '#/home'; return; }
  var view = $('#view');
  if (route.indexOf('/visit') === 0) { view.innerHTML = viewVisit(route); bindVisit(); }
  else if (route === '/farmers') { view.innerHTML = viewFarmers(); bindFarmers(); }
  else if (route === '/map') { view.innerHTML = viewMap(); bindMap(); }
  else if (route === '/queue') { view.innerHTML = viewQueue(); bindQueue(); }
  else if (route === '/sites') { view.innerHTML = viewSites(); bindSites(); }
  else if (route === '/dash') { location.hash = '#/home'; return; }
  else if (S.me && (S.me.role === 'manager' || S.me.role === 'viewer')) { view.innerHTML = viewDash(); bindDash(); }
  else { view.innerHTML = viewSmartHome(); bindSmartHome(); }
  updateNetDot();
  bindDrawer();
}

function headerHTML() {
  var staff = S.me && S.me.role !== 'supervisor';
  return '<header class="app-header">' +
    (staff ? '<button class="burger" id="btnBurger" aria-label="Menu"><span></span><span></span><span></span></button>' : '') +
    '<div><div class="title">FS Field Monitoring</div>' +
    '<div class="sub">' + esc(S.me ? S.me.name : '') +
    (S.me && S.me.role === 'manager' ? ' · Manager' : (S.me && S.me.role === 'viewer' ? ' · Viewer' : '')) + '</div></div>' +
    '<div class="header-actions">' +
    '<span class="net-dot' + (navigator.onLine ? '' : ' off') + '" id="netDot" title="Connection"></span>' +
    '<button class="icon-btn" id="btnLogout">Sign out</button>' +
    '</div></header>';
}

var ICONS = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>',
  map: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/></svg>',
  queue: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.3"/><path d="M21 3v6h-6"/></svg>',
  dash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="12" width="4" height="8" rx="1"/><rect x="10" y="7" width="4" height="13" rx="1"/><rect x="17" y="3" width="4" height="17" rx="1"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.2 3.4-5 6.5-5s5.7 1.8 6.5 5"/><circle cx="17" cy="9" r="2.6"/><path d="M16.5 15.2c2.6.3 4.4 1.9 5 4.8"/></svg>'
};

function navItems(route) {
  var items = [
    { href: '#/home', icon: 'dash', label: 'Home', active: route === '/home' || route === '' },
    { href: '#/sites', icon: 'home', label: 'Sites', active: route === '/sites' || route.indexOf('/visit') === 0 },
    { href: '#/farmers', icon: 'users', label: 'Farmers', active: route === '/farmers' },
    { href: '#/map', icon: 'map', label: 'Map', active: route === '/map' }
  ];
  if (S.me && S.me.role === 'supervisor') items.push({ href: '#/queue', icon: 'queue', label: 'Sync', active: route === '/queue', badge: pendingCount() });
  return items;
}
function navLinksHTML(route) {
  return navItems(route).map(function (i) {
    return '<a href="' + i.href + '" class="' + (i.active ? 'active' : '') + '">' + ICONS[i.icon] +
      '<span>' + i.label + '</span>' +
      (i.badge ? '<span class="nav-badge">' + i.badge + '</span>' : '') + '</a>';
  }).join('');
}
function navHTML(route) {
  var staff = S.me && S.me.role !== 'supervisor';
  // FS: one-tap bottom tabs (no burger). Staff: burger drawer on mobile, no
  // bottom tabs; both become the left sidebar on >=900px screens.
  var html = '<nav class="bottom-nav' + (staff ? ' staff-nav' : '') + '">' + navLinksHTML(route) + '</nav>';
  if (staff) {
    html += '<div class="drawer-overlay" id="drawerOverlay"></div>' +
      '<aside class="drawer" id="drawer">' +
      '<img src="assets/logo-4dcs.png?v=1" alt="4D Climate Solutions" style="width:170px;margin:4px 0 14px">' +
      '<nav class="drawer-nav">' + navLinksHTML(route) + '</nav>' +
      '<div class="drawer-foot">' +
      '<a class="btn btn-outline btn-block btn-sm" href="testing.html" target="_blank" style="margin-bottom:8px">Testing guide</a>' +
      '<button class="btn btn-outline btn-block btn-sm" id="drawerLogout">Sign out</button>' +
      copyrightHTML() + '</div></aside>';
  }
  return html;
}
function bindDrawer() {
  var burger = $('#btnBurger'), drawer = $('#drawer'), ov = $('#drawerOverlay');
  if (!burger || !drawer) return;
  function close() { drawer.classList.remove('open'); ov.classList.remove('open'); }
  burger.onclick = function () { drawer.classList.toggle('open'); ov.classList.toggle('open'); };
  ov.onclick = close;
  drawer.onclick = function (e) { if (e.target.closest('a')) close(); };
  $('#drawerLogout').onclick = function () { close(); confirmLogout(); };
}
function renderNavBadge() {
  var nav = $('.bottom-nav'); if (!nav) return;
  var route = (location.hash || '#/home').replace(/^#/, '');
  nav.innerHTML = navLinksHTML(route);
  var dn = $('.drawer-nav'); if (dn) dn.innerHTML = navLinksHTML(route);
}
function updateNetDot() {
  var d = $('#netDot'); if (d) d.className = 'net-dot' + (navigator.onLine ? '' : ' off');
  var b = $('#offBar'); if (b) b.hidden = navigator.onLine;
}

/* ----------------------------------------------------------------- login -- */
function viewLogin() {
  return '<main id="view"><div class="login-wrap">' +
    '<img class="login-logo-img" src="assets/logo-4dcs.png?v=1" alt="4D Climate Solutions">' +
    '<h1>FS Field Monitoring</h1>' +
    '<p class="tagline muted">Field Supervisor Monitoring — AI-Powered Extension for Agricultural Resilience</p>' +
    '<div class="card">' +
    '<div id="loginError"></div>' +
    '<div class="field"><label>First name (or phone number)</label>' +
    '<input id="phone" type="text" autocomplete="username" autocapitalize="none" placeholder="e.g. molapo"></div>' +
    '<div class="field"><label>PIN</label>' +
    '<input id="pin" type="password" inputmode="numeric" autocomplete="current-password" placeholder="Your PIN" maxlength="8"></div>' +
    '<button class="btn btn-primary btn-block" id="btnLogin">Sign in</button>' +
    '<p class="muted small mt12">No account? Ask your programme manager to add you.</p>' +
    '</div>' +
    '<p class="muted small" style="text-align:center">Works offline in the field — captured visits sync automatically when you are back online.</p>' +
    copyrightHTML() +
    '</div><div id="toast"></div></main>';
}
function bindLogin() {
  var busy = false;
  function go() {
    if (busy) return;
    var phone = $('#phone').value.trim(), pin = $('#pin').value.trim();
    if (!phone || !pin) { $('#loginError').innerHTML = '<div class="error-box">Enter your name and PIN.</div>'; return; }
    busy = true; $('#btnLogin').disabled = true; $('#btnLogin').textContent = 'Signing in…';
    rpc('fs_login', { p_phone: phone, p_pin: pin }).then(function (res) {
      S.token = res.token; S.me = res.supervisor;
      localStorage.setItem('fsm_token', res.token);
      localStorage.setItem('fsm_me', JSON.stringify(res.supervisor));
      return refreshBoot();
    }).then(function () {
      location.hash = '#/home'; render(); syncAll();
    }).catch(function (err) {
      busy = false;
      var btn = $('#btnLogin');
      if (btn) { btn.disabled = false; btn.textContent = 'Sign in'; }
      var box = $('#loginError');
      if (box) box.innerHTML = '<div class="error-box">' +
        esc(navigator.onLine ? err.message : 'You are offline. Connect to sign in the first time.') + '</div>';
    });
  }
  $('#btnLogin').addEventListener('click', go);
  $('#pin').addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
}

/* ------------------------------------------------------------------ home -- */
function siteProgressMap() {
  var m = {};
  if (S.boot && S.boot.progress && S.boot.progress.sites) {
    S.boot.progress.sites.forEach(function (p) { m[p.site_id] = p; });
  }
  return m;
}
function viewSites() {
  var prog = (S.boot && S.boot.progress) || null;
  var totals = prog ? prog.totals : null;
  var targets = prog ? prog.targets : null;
  var pm = siteProgressMap();
  var mine = myAssigned();
  function bySort(a, b) {
    return (mine.indexOf(b.id) !== -1 ? 1 : 0) - (mine.indexOf(a.id) !== -1 ? 1 : 0) || a.id - b.id;
  }
  var vSites = sites().filter(function (s) { return s.is_validation_site; }).sort(bySort);
  var oSites = sites().filter(function (s) { return !s.is_validation_site; }).sort(bySort);

  var html = (S.me && S.me.role === 'supervisor')
    ? '<a class="btn btn-primary btn-block" href="#/visit">+ New field visit</a>' : '';

  if (totals && targets) {
    html += '<div class="stat-grid mt12">' +
      stat(totals.farms_complete + '/' + targets.validation_farms, 'Farms complete', 'farms') +
      stat(totals.visits, 'Visits synced', 'visits_total') +
      stat(totals.readings, 'Readings', 'readings') +
      stat(totals.samples, 'Soil samples', 'samples') +
      '</div>';
  } else {
    html += '<div class="info-box mt12">Progress appears here after your first sync.</div>';
  }

  html += '<div class="card mt12"><h2>Validation sites</h2>';
  html += '<p class="muted small">Target: 3 farms per site × 3 readings × 5 parameters + topsoil sample (0–20 cm).</p>';
  html += vSites.map(function (s) { return siteRow(s, pm[s.id], true); }).join('');
  html += '</div>';

  html += '<div class="card"><h2>All sub-areas</h2>';
  html += oSites.map(function (s) { return siteRow(s, pm[s.id], false); }).join('');
  html += '</div>';
  html += copyrightHTML();
  return html;
}
function stat(num, label, key) {
  return '<div class="stat' + (key ? ' stat-click" data-modal="' + key + '"' : '"') + '>' +
    (key ? '<span class="stat-i">i</span>' : '') +
    '<div class="num">' + esc(num) + '</div><div class="lbl">' + esc(label) + '</div></div>';
}
function progForModals() { return S._prog || (S.boot && S.boot.progress) || {}; }
function mySiteRows(prog) {
  var mine = myAssigned();
  var rows = (prog.sites || []);
  if (S.me && S.me.role === 'supervisor' && mine.length) {
    rows = rows.filter(function (ps) { return mine.indexOf(ps.site_id) !== -1; });
  }
  return rows;
}
function miniTable(rows) {
  return '<table class="dash-table"><tbody>' + rows.map(function (r) {
    return '<tr><td>' + r[0] + '</td><td style="text-align:right;white-space:nowrap"><b>' + r[1] + '</b></td></tr>';
  }).join('') + '</tbody></table>';
}
function statModal(key) {
  var prog = progForModals();
  var act = S._act;
  var sites2 = mySiteRows(prog);
  var t = prog.totals || {};
  var pend = pendingCount();
  var esc2 = esc;
  if (key === 'visits_week') {
    showModal('Visits this week', '<p class="muted small">Field Supervisor visits synced in the last 7 days.</p>' +
      miniTable((prog.supervisors || []).filter(function (x) { return x.role === 'supervisor' && Number(x.visits_7d); })
        .map(function (x) { return [esc2(x.name), x.visits_7d]; })) +
      (pend ? '<div class="nudge warn mt8">' + pend + ' visit(s) on this phone not yet synced</div>' : ''));
  } else if (key === 'visits_total') {
    var siteRows = sites2.filter(function (x) { return Number(x.visits); })
      .sort(function (a, b) { return b.visits - a.visits; });
    var staffDrill = S.me && S.me.role !== 'supervisor';
    showModal('Visits by site', siteRows.length
      ? (staffDrill ? '<p class="muted small">Tap a site to see its visits.</p>' : '') +
        siteRows.map(function (x) {
          return '<div class="hbar-row' + (staffDrill ? ' act-row' : '') + '"' +
            (staffDrill ? ' data-siteprofile="' + x.site_id + '"' : '') + '>' +
            '<span class="hbar-label" style="flex:1">' + esc2(x.sub_area) + '</span>' +
            '<span class="hbar-val">' + x.visits + ' visit' + (Number(x.visits) === 1 ? '' : 's') + (staffDrill ? ' ›' : '') + '</span></div>';
        }).join('')
      : '<p class="muted">No synced visits yet.</p>');
  } else if (key === 'farmers_engaged') {
    showModal('Farmer engagement', '<p class="muted small">A farmer counts as engaged once at least one synced visit records them. Tap a site for its full profile.</p>' +
      sites2.map(function (x) {
        return '<div class="hbar-row act-row" data-siteprofile="' + x.site_id + '">' +
          '<span class="hbar-label" style="flex:1">' + esc2(x.sub_area) + '</span>' +
          '<span class="hbar-val">' + (x.farmers_engaged || 0) + ' / ' + (x.farmers_total || 0) + ' ›</span></div>';
      }).join(''));
  } else if (key === 'ai') {
    showModal('AI advisory administered', '<p class="muted small">Visits where the AI advisory was administered to the farmer. Field Supervisors only.</p>' +
      (prog.supervisors || []).filter(function (x) { return x.role === 'supervisor'; })
        .map(function (x) {
          return '<div class="hbar-row act-row" data-fsprofile="' + x.id + '">' +
            '<span class="hbar-label" style="flex:1">' + esc2(x.name) + '</span>' +
            '<span class="hbar-val">' + (x.ai_visits || 0) + ' of ' + (x.visits || 0) + ' ›</span></div>';
        }).join(''));
  } else if (key === 'issues') {
    var list = (act && act.visits ? act.visits.filter(function (v) { return v.issue; }).slice(0, 10) : []);
    showModal('Issues logged', list.length
      ? '<p class="muted small">Tap an issue for the full visit.</p>' + list.map(function (v) {
          return '<div class="queue-item act-row" data-visit="' + v.id + '"><b>' + esc2(v.site) + '</b> · ' + esc2(v.supervisor) + ' · ' + fmtWhen(v.synced_at) +
            '<div class="small" style="color:var(--danger)">' + esc2(v.issue) + '</div></div>';
        }).join('')
      : '<p class="muted small">Issues reported by Field Supervisors during visits appear here.' +
        (t.issues ? ' Total so far: <b>' + t.issues + '</b>.' : '') + '</p>');
  } else if (key === 'farms') {
    showModal('Validation farms', '<p class="muted small">A farm is complete when all 21 readings (7 parameters × 3 replicates) exist.</p>' +
      miniTable(sites2.filter(function (x) { return x.is_validation_site; })
        .map(function (x) { return [esc2(x.sub_area), (x.farms_complete || 0) + ' / 3 farms']; })));
  } else if (key === 'readings') {
    showModal('Soil readings', '<p class="muted small">Sensor readings captured vs the validation target per site.</p>' +
      miniTable(sites2.filter(function (x) { return x.is_validation_site; })
        .map(function (x) { return [esc2(x.sub_area), (x.readings_done || 0) + ' / ' + (x.readings_target || 0)]; })));
  } else if (key === 'samples') {
    showModal('Topsoil samples', '<p class="muted small">Visits where a 0–20 cm topsoil sample was collected for laboratory pairing (matched to sensor readings via the sample ID).</p>' +
      '<p>Total collected: <b>' + (t.samples || 0) + '</b></p>');
  } else if (key === 'fs_unstarted' || key === 'fs_inactive') {
    var team = ((S._act || {}).team || []).filter(function (m) { return m.role === 'supervisor' && m.active !== false; });
    var pick = (prog.supervisors || []).filter(function (sp) {
      if (sp.role !== 'supervisor' || sp.active === false) return false;
      return key === 'fs_unstarted' ? !sp.last_synced_at
                                    : (sp.last_synced_at && daysSince(sp.last_synced_at) >= 7);
    });
    showModal(key === 'fs_unstarted' ? 'Not started yet' : 'Inactive 7+ days',
      '<p class="muted small">' + (key === 'fs_unstarted'
        ? 'Field Supervisors with no synced visits so far.'
        : 'No synced visits in the last 7 days.') + '</p>' +
      pick.map(function (sp) {
        var tm = team.find(function (m) { return m.id === sp.id; }) || {};
        return '<div class="hbar-row act-row" data-fsprofile="' + sp.id + '">' +
          '<span class="hbar-label" style="flex:1">' + esc2(sp.name) +
          (tm.station ? ' <span class="muted small">· ' + esc2(tm.station) + '</span>' : '') + '</span>' +
          '<span class="hbar-val">' + (sp.last_synced_at ? daysSince(sp.last_synced_at) + 'd ago' : '—') + ' ›</span></div>';
      }).join(''));
  } else if (key === 'flags') {
    var fl = ((S._act || {}).visits || []).filter(function (v) { return v.gps_flag || Number(v.out_of_range); }).slice(0, 10);
    showModal('Data-quality flags', fl.length
      ? '<p class="muted small">Tap a row for the full visit.</p>' + fl.map(function (v) {
        var why = [];
        if (v.gps_lat == null) why.push('no GPS');
        else if (v.gps_flag) why.push(fmtDist(v.distance_from_site_m) + ' from site');
        if (Number(v.out_of_range)) why.push(v.out_of_range + ' reading(s) out of range');
        return '<div class="queue-item act-row" data-visit="' + v.id + '"><b>' + esc2(v.site) + '</b> · ' + esc2(v.supervisor) + ' · ' + fmtWhen(v.synced_at) +
          '<div class="small" style="color:var(--warn)">' + esc2(why.join(' · ')) + '</div></div>';
      }).join('') : '<p class="muted small">No flagged visits.</p>');
  } else if (key === 'farmers_listed') {
    showModal('Farmers by site', miniTable(sites2.map(function (x) {
      return [esc2(x.sub_area), x.farmers_total || 0]; })));
  }
}
function siteRow(s, p, validation) {
  var color = DISTRICT_COLORS[s.district] || '#888';
  var meta = esc(s.district) + ' · ' + esc(s.zone) + ' · ' + s.farmers + ' farmers';
  var right = '';
  if (validation) {
    var done = p ? Number(p.readings_done || 0) : 0;
    var target = p ? Number(p.readings_target || 63) : 63;
    var pct = target ? Math.min(100, Math.round(done * 100 / target)) : 0;
    right = '<div style="width:88px;text-align:right">' +
      '<span class="small" style="font-weight:700">' + (p ? p.farms_complete : 0) + '/3 farms</span>' +
      '<div class="pbar' + (pct >= 100 ? ' full' : '') + '"><div style="width:' + pct + '%"></div></div></div>';
  } else if (p && Number(p.visits)) {
    right = '<span class="chip grey">' + p.visits + ' visit' + (Number(p.visits) === 1 ? '' : 's') + '</span>';
  }
  var tappable = canVisit(s.id);
  var staffDrill = S.me && S.me.role !== 'supervisor';
  return (tappable
      ? '<a class="site-item" href="#/visit?site=' + s.id + '">'
      : (staffDrill
          ? '<span class="site-item act-row" data-siteprofile="' + s.id + '">'
          : '<span class="site-item" style="opacity:.75">')) +
    '<span class="site-dot" style="background:' + color + '"></span>' +
    '<span class="site-main"><span class="site-name">' + esc(s.sub_area) +
    (s.rc !== s.sub_area ? ' <span class="muted small">(' + esc(s.rc) + ' RC)</span>' : '') +
    (validation ? ' <span class="chip gold">validation</span>' : '') +
    (myAssigned().indexOf(s.id) !== -1 ? ' <span class="chip blue">your station</span>' : '') + '</span>' +
    '<span class="site-meta">' + meta + '</span></span>' + right + (tappable ? '</a>' : '</span>');
}
function bindSites() {
  $('#btnLogout').onclick = confirmLogout;
  $('#view').onclick = function (e) {
    var sp = e.target.closest && e.target.closest('[data-siteprofile]');
    if (sp) { siteProfileModal(sp.getAttribute('data-siteprofile')); return; }
    var k = e.target.closest && e.target.closest('[data-modal]');
    if (k) statModal(k.getAttribute('data-modal'));
  };
  if (navigator.onLine) refreshBoot().then(function () {
    if (location.hash === '#/sites') {
      var v = $('#view'); if (v) { v.innerHTML = viewSites(); }
    }
  });
}

/* ------------------------------------------------------- smart home (FS) -- */
function daysSince(iso) {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}
function viewSmartHome() {
  var prog = (S.boot && S.boot.progress) || {};
  var mySites = myAssigned().map(siteById).filter(Boolean);
  var me = ((prog.supervisors || []).find(function (x) { return x.id === (S.me && S.me.id); })) || {};
  var siteRows = (prog.sites || []).filter(function (ps) {
    return myAssigned().indexOf(ps.site_id) !== -1;
  });
  var pend = pendingCount();
  var stationName = mySites.map(function (x) { return x.sub_area; }).join(' + ');

  var html = '<div class="hero card">' +
    '<div class="muted small">' + new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }) + '</div>' +
    '<h2 style="font-size:19px;margin:2px 0 2px">Welcome back, ' + esc((S.me.name || '').split(/\s+/)[0]) + '</h2>' +
    (stationName ? '<div class="muted small">Your station: <b>' + esc(stationName) + '</b></div>' : '') +
    '</div>';

  // nudges
  var nudges = [];
  if (pend) nudges.push(['warn', pend + ' visit' + (pend === 1 ? '' : 's') + ' on this phone waiting to sync', '#/queue']);
  var engaged = 0, totalFarmers = 0, valDone = 0, valTarget = 0, valSite = null;
  siteRows.forEach(function (ps) {
    engaged += Number(ps.farmers_engaged || 0);
    totalFarmers += Number(ps.farmers_total || 0);
    if (ps.is_validation_site) { valDone += Number(ps.readings_done || 0); valTarget += Number(ps.readings_target || 0); valSite = ps.sub_area; }
  });
  if (totalFarmers && engaged < totalFarmers) {
    nudges.push(['info', (totalFarmers - engaged) + ' of your ' + totalFarmers + ' farmers not yet visited', '#/farmers']);
  }
  var d = daysSince(me.last_synced_at);
  if (me.last_synced_at == null) nudges.push(['info', 'No synced visits yet — start with your first field visit', '#/visit']);
  else if (d >= 4) nudges.push(['warn', 'No synced visits in ' + d + ' days', '#/visit']);
  if (valTarget && valDone < valTarget) {
    nudges.push(['info', 'Soil validation at ' + esc(valSite) + ': ' + Math.round(valDone * 100 / valTarget) + '% of readings done', '#/sites']);
  }
  if (nudges.length) {
    html += nudges.map(function (n) {
      return '<a class="nudge ' + n[0] + '" href="' + n[2] + '">' + esc(n[1]) + ' <span style="margin-left:auto">›</span></a>';
    }).join('');
  }

  html += '<div class="stat-grid mt12">' +
    stat(me.visits_7d != null ? me.visits_7d : '—', 'Visits this week', 'visits_week') +
    stat(me.visits != null ? me.visits : '—', 'Visits total', 'visits_total') +
    stat(totalFarmers ? engaged + '/' + totalFarmers : (me.farmers_engaged || 0), 'Farmers engaged', 'farmers_engaged') +
    stat(me.ai_visits != null ? me.ai_visits : '—', 'AI administered', 'ai') +
    '</div>';

  if (totalFarmers) {
    var pct = Math.min(100, Math.round(engaged * 100 / totalFarmers));
    html += '<div class="card mt12"><div class="row spread"><h3>Farmer engagement</h3>' +
      '<span class="small muted">' + pct + '%</span></div>' +
      '<div class="pbar' + (pct >= 100 ? ' full' : '') + '"><div style="width:' + pct + '%"></div></div></div>';
  }

  html += '<a class="btn btn-primary btn-block mt12" href="#/visit">+ New field visit</a>' +
    '<div class="row mt8" style="gap:8px">' +
    '<a class="btn btn-secondary btn-sm" style="flex:1" href="#/farmers">Farmers</a>' +
    '<a class="btn btn-secondary btn-sm" style="flex:1" href="#/sites">Sites</a>' +
    '<a class="btn btn-secondary btn-sm" style="flex:1" href="#/map">Map</a>' +
    '</div>';

  html += '<p class="small" style="text-align:center;margin-top:14px"><a href="testing.html" style="color:var(--forest-dark)">Testing guide</a></p>' +
    copyrightHTML();
  return html;
}
function bindSmartHome() {
  $('#btnLogout').onclick = confirmLogout;
  $('#view').onclick = function (e) {
    var k = e.target.closest && e.target.closest('[data-modal]');
    if (k) statModal(k.getAttribute('data-modal'));
  };
  if (navigator.onLine) refreshBoot().then(function () {
    var r = (location.hash || '#/home').replace(/^#/, '');
    if (r === '/home' || r === '') {
      var v = $('#view'); if (v && S.me && S.me.role !== 'manager') v.innerHTML = viewSmartHome();
    }
  });
}
function confirmLogout() {
  var pend = pendingCount();
  var msg = pend
    ? 'You still have ' + pend + ' unsynced visit(s). Signing out keeps them on this phone. Sign out?'
    : 'Sign out?';
  if (confirm(msg)) doLogout();
}

/* --------------------------------------------------------------- farmers -- */
var farmerSearch = '';
var editingFarmerId = null;
function prodLabel(p) {
  return p === 'H' ? 'Horticulture' : (p === 'A' ? 'Agronomy' : (p === 'H+A' ? 'Horticulture + Agronomy' : null));
}
function farmerVisitRow(v, localState) {
  return '<div class="queue-item act-row" data-visit="' + v.id + '">' +
    '<div class="row spread"><b>' + fmtWhen(v.submitted_at || v.synced_at || v.updated_at) + '</b>' +
    (localState ? '<span class="chip state-' + localState + '">' + localState + '</span>'
                : (v.supervisor ? '<span class="chip grey">' + esc(v.supervisor) + '</span>' : '')) + '</div>' +
    '<div class="muted small">' +
    (v.ai_administered === true ? 'AI advisory' : (v.ai_administered === false ? 'conventional' : '')) +
    (Number(v.readings_count) || (v.readings || []).length ? ' · ' + (v.readings_count || v.readings.length) + ' readings' : ' · no soil data') +
    (v.sample_collected ? ' · sample ' + esc(v.sample_id || '✓') : '') +
    '</div>' +
    (v.issue ? '<div class="small" style="color:var(--danger)">' + esc(v.issue) + '</div>' : '') +
    (v.notes ? '<div class="small muted">' + esc(v.notes) + '</div>' : '') +
    '</div>';
}
function farmerModal(fid) {
  var f = farmers().find(function (x) { return x.id === fid; });
  if (!f) f = { id: fid, name: 'Farmer' };   // detail fetch below fills the rest
  var st = siteById(f.site_id);
  var rows = [
    ['Station', st ? st.sub_area + ' (' + st.rc + ' RC)' : ''],
    ['Village', f.village], ['Gender', f.gender === 'F' ? 'Female' : (f.gender === 'M' ? 'Male' : null)],
    ['Age', f.age], ['Production', prodLabel(f.production)],
    ['Field size', f.field_size], ['Crops', f.crops], ['System', f.system],
    ['Phone', f.phone ? '<a href="tel:' + esc(f.phone.split('/')[0]) + '">' + esc(f.phone) + '</a>' : null]
  ].filter(function (r) { return r[1] != null && r[1] !== ''; });
  var localVisits = S.queue.filter(function (r) { return r.farmer_id === fid; });
  var html = '<table class="dash-table"><tbody>' + rows.map(function (r) {
      return '<tr><td style="color:var(--grey);white-space:nowrap">' + r[0] + '</td><td>' + (r[0] === 'Phone' ? r[1] : esc(r[1])) + '</td></tr>';
    }).join('') + '</tbody></table>' +
    (f.source === 'fs_registered' ? '<p class="small muted mt8">Registered in the field' + (f._state ? ' — ' + f._state : '') + '</p>' : '') +
    '<h3 class="mt12">Visit history</h3>' +
    (localVisits.length ? localVisits.map(function (v) { return farmerVisitRow(v, v.state !== 'synced' ? v.state : null); }).join('') : '') +
    '<div id="farmerHistory">' +
    (navigator.onLine ? '<p class="muted small">Loading synced visits…</p>'
                      : '<p class="muted small">Connect to see the full synced history.</p>') +
    '</div>';
  showModal(f.name, html);
  if (!navigator.onLine) return;
  rpc('fs_farmer_detail', { p_token: S.token, p_farmer_id: fid }).then(function (d) {
    var h2 = document.querySelector('.modal h2');
    if (h2 && d.farmer && d.farmer.name) { h2.textContent = d.farmer.name; _mtitle = d.farmer.name; }
    var box = $('#farmerHistory'); if (!box) return;
    var localIds = {};
    localVisits.forEach(function (v) { localIds[v.id] = true; });
    var serverVisits = (d.visits || []).filter(function (v) { return !localIds[v.id]; });
    var stats = d.stats || {};
    box.innerHTML =
      '<p class="small muted">' + (stats.visits || 0) + ' synced visit(s)' +
      (stats.ai_visits ? ' · AI administered ' + stats.ai_visits + '×' : '') +
      (stats.last_visit_at ? ' · last ' + fmtWhen(stats.last_visit_at) : '') + '</p>' +
      (serverVisits.length ? serverVisits.map(function (v) { return farmerVisitRow(v, null); }).join('')
        : (localVisits.length ? '' : '<p class="muted small">No visits recorded with this farmer yet.</p>'));
  }).catch(function (err) {
    var box = $('#farmerHistory');
    if (box && !handleAuthError(err)) box.innerHTML = '<p class="small" style="color:var(--danger)">' + esc(err.message) + '</p>';
  });
}
function farmerFormFields(prefix, f) {
  f = f || {};
  return '<div class="field"><label>Farmer full name</label><input id="' + prefix + 'Name" type="text" value="' + esc(f.name || '') + '"></div>' +
    '<div class="row"><div class="field" style="flex:1"><label>Village</label><input id="' + prefix + 'Village" type="text" value="' + esc(f.village || '') + '"></div>' +
    '<div class="field" style="flex:0 0 90px"><label>Age</label><input id="' + prefix + 'Age" type="text" inputmode="numeric" value="' + esc(f.age != null ? f.age : '') + '"></div></div>' +
    '<div class="row"><div class="field" style="flex:1"><label>Gender</label><select id="' + prefix + 'Gender">' +
    '<option value="">—</option><option value="F"' + (f.gender === 'F' ? ' selected' : '') + '>Female</option>' +
    '<option value="M"' + (f.gender === 'M' ? ' selected' : '') + '>Male</option></select></div>' +
    '<div class="field" style="flex:1"><label>Phone</label><input id="' + prefix + 'Phone" type="tel" value="' + esc(f.phone || '') + '"></div></div>';
}
function viewFarmers() {
  // staff browse every site's farmers; FS see their capture scope
  var vSites = (S.me && S.me.role === 'supervisor') ? visitableSites() : sites();
  var q = farmerSearch.toLowerCase();
  var html = '<div class="field" style="margin-bottom:10px">' +
    '<input id="farmerSearch" type="search" placeholder="Search farmers…" value="' + esc(farmerSearch) + '"></div>';

  if (S.me && S.me.role === 'supervisor')
  html += '<div class="card"><h3>Register a new farmer</h3>' +
    (vSites.length > 1
      ? '<div class="field"><label>Site</label><select id="rfSite"><option value="">Choose…</option>' +
        vSites.map(function (st) { return '<option value="' + st.id + '">' + esc(st.sub_area) + '</option>'; }).join('') + '</select></div>'
      : '') +
    '<div class="field"><label>Farmer full name</label><input id="rfName" type="text"></div>' +
    '<div class="row"><div class="field" style="flex:1"><label>Village</label><input id="rfVillage" type="text"></div>' +
    '<div class="field" style="flex:0 0 90px"><label>Age</label><input id="rfAge" type="text" inputmode="numeric"></div></div>' +
    '<div class="row"><div class="field" style="flex:1"><label>Gender</label><select id="rfGender">' +
    '<option value="">—</option><option value="F">Female</option><option value="M">Male</option></select></div>' +
    '<div class="field" style="flex:1"><label>Phone</label><input id="rfPhone" type="tel"></div></div>' +
    '<button class="btn btn-primary btn-block" id="btnRegFarmer">Register farmer</button></div>';

  vSites.forEach(function (st) {
    var list = farmersOf(st.id).filter(function (f) {
      return !q || (f.name + ' ' + (f.village || '')).toLowerCase().indexOf(q) !== -1;
    });
    html += '<div class="card"><h2>' + esc(st.sub_area) + ' <span class="muted small">(' + list.length + ' farmers)</span></h2>' +
      (list.length ? list.map(function (f) {
        var meta = [f.village, f.age ? f.age + ' yrs' : null,
                    f.gender === 'F' ? 'Female' : (f.gender === 'M' ? 'Male' : null),
                    f.production].filter(Boolean).join(' · ');
        var row = '<div class="site-item">' +
          '<span class="site-main" data-farmerdetail="' + f.id + '" style="cursor:pointer"><span class="site-name">' + esc(f.name) +
          (f.source === 'fs_registered' ? ' <span class="chip blue">new</span>' : '') +
          (f._state ? ' <span class="chip state-' + f._state + '">' + f._state + '</span>' : '') +
          '</span><span class="site-meta">' + esc(meta || '—') + '</span></span>' +
          (isViewer() ? '' :
            '<span class="row" style="gap:6px">' +
            '<button class="btn btn-outline btn-sm" data-editfarmer="' + f.id + '">Edit</button>' +
            (S.me && S.me.role === 'supervisor'
              ? '<a class="btn btn-outline btn-sm" href="#/visit?site=' + st.id + '&farmer=' + f.id + '">Visit</a>' : '') +
            '</span>') +
          '</div>';
        if (editingFarmerId === f.id) {
          row += '<div style="border:1.5px dashed var(--line);border-radius:12px;padding:12px;margin:4px 0 10px">' +
            farmerFormFields('ef', f) +
            '<div class="row"><button class="btn btn-primary btn-sm" style="flex:1" data-savefarmer="' + f.id + '" data-site="' + f.site_id + '">Save changes</button>' +
            '<button class="btn btn-outline btn-sm" data-canceledit="1">Cancel</button></div></div>';
        }
        return row;
      }).join('') : '<p class="muted small">No farmers match.</p>') + '</div>';
  });
  html += copyrightHTML();
  return html;
}
function bindFarmers() {
  $('#btnLogout').onclick = confirmLogout;
  if ($('#farmerSearch')) $('#farmerSearch').addEventListener('input', function () {
    farmerSearch = this.value;
    var v = $('#view');
    var pos = this.selectionStart;
    v.innerHTML = viewFarmers(); bindFarmers();
    var inp = $('#farmerSearch');
    inp.focus(); inp.setSelectionRange(pos, pos);
  });
  if ($('#btnRegFarmer')) $('#btnRegFarmer').addEventListener('click', function () {
    var vSites = visitableSites();
    var siteId = vSites.length === 1 ? vSites[0].id : Number(($('#rfSite') || {}).value || 0);
    registerFarmer({
      site_id: siteId || null,
      name: $('#rfName').value, village: $('#rfVillage').value,
      gender: $('#rfGender').value, age: $('#rfAge').value, phone: $('#rfPhone').value
    }, function () {
      var v = $('#view'); v.innerHTML = viewFarmers(); bindFarmers();
    });
  });
  // row actions via onclick property (view element persists across list re-renders)
  $('#view').onclick = function (e) {
    var detEl = e.target.closest && e.target.closest('[data-farmerdetail]');
    if (detEl) { farmerModal(detEl.getAttribute('data-farmerdetail')); return; }
    var editId = e.target.getAttribute('data-editfarmer');
    var saveId = e.target.getAttribute('data-savefarmer');
    if (editId) {
      editingFarmerId = editingFarmerId === editId ? null : editId;
      var v = $('#view'); v.innerHTML = viewFarmers(); bindFarmers();
    } else if (saveId) {
      registerFarmer({
        id: saveId, site_id: Number(e.target.getAttribute('data-site')),
        name: $('#efName').value, village: $('#efVillage').value,
        gender: $('#efGender').value, age: $('#efAge').value, phone: $('#efPhone').value
      }, function () {
        editingFarmerId = null;
        var v = $('#view'); v.innerHTML = viewFarmers(); bindFarmers();
      });
    } else if (e.target.getAttribute('data-canceledit')) {
      editingFarmerId = null;
      var v = $('#view'); v.innerHTML = viewFarmers(); bindFarmers();
    }
  };
}

/* ------------------------------------------------------------------- map -- */
function viewMap() {
  return '<div id="map"></div>' +
    '<div class="legend">' +
    Object.keys(DISTRICT_COLORS).map(function (d) {
      return '<span class="row"><span class="site-dot" style="background:' + DISTRICT_COLORS[d] + '"></span>' + esc(d) + '</span>';
    }).join('') +
    '<span class="row"><span class="site-dot" style="background:#fff;border:2.5px solid #a16207;width:15px;height:15px"></span>Validation site</span>' +
    (myAssigned().length ? '<span class="row"><span class="site-dot" style="background:rgba(141,198,63,.3);border:2px dashed #8DC63F"></span>Your area</span>' : '') +
    '</div>';
}
function bindMap() {
  $('#btnLogout').onclick = confirmLogout;
  $('#view').onclick = function (e) {
    var sp = e.target.closest && e.target.closest('[data-siteprofile]');
    if (sp) { e.preventDefault(); siteProfileModal(sp.getAttribute('data-siteprofile')); }
  };
  if (typeof L === 'undefined') {
    $('#map').innerHTML = '<div class="info-box" style="margin:12px">Map needs an internet connection the first time it loads.</div>';
    return;
  }
  var map = L.map('map', { zoomControl: true });
  var pts = sites();
  var mine = myAssigned();
  var myPts = pts.filter(function (s) { return mine.indexOf(s.id) !== -1; });
  if (myPts.length) {
    map.fitBounds(myPts.map(function (s) { return [s.lat, s.lon]; }), { padding: [70, 70], maxZoom: 12 });
  } else {
    map.fitBounds(pts.map(function (s) { return [s.lat, s.lon]; }), { padding: [24, 24] });
  }
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 17,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);
  // lime halo around the FS's own station(s)
  myPts.forEach(function (s) {
    L.circle([s.lat, s.lon], {
      radius: 2500, color: '#8DC63F', weight: 2, dashArray: '6 6',
      fillColor: '#8DC63F', fillOpacity: 0.15
    }).addTo(map);
  });
  var pm = siteProgressMap();
  pts.forEach(function (s) {
    var color = DISTRICT_COLORS[s.district] || '#888';
    var m = L.circleMarker([s.lat, s.lon], {
      radius: s.is_validation_site ? 10 : 7,
      color: s.is_validation_site ? '#a16207' : color,
      weight: s.is_validation_site ? 3 : 2,
      fillColor: color, fillOpacity: 0.85
    }).addTo(map);
    var p = pm[s.id];
    m.bindPopup('<b>' + esc(s.sub_area) + '</b> (' + esc(s.rc) + ' RC)<br>' +
      esc(s.district) + ' · ' + esc(s.zone) + ' · ' + s.farmers + ' farmers' +
      (s.is_validation_site ? '<br><b>Validation site</b> — ' + (p ? p.farms_complete : 0) + '/3 farms complete' : '') +
      (mine.indexOf(s.id) !== -1 ? '<br><b style="color:#5a8f1e">★ Your station</b>' : '') +
      (p && Number(p.visits) ? '<br>' + p.visits + ' visit(s), last ' + fmtWhen(p.last_visit_at) : '') +
      ((S.me && S.me.role !== 'supervisor') || mine.indexOf(s.id) !== -1
        ? '<br><a href="#" data-siteprofile="' + s.id + '">Site details</a>' : '') +
      (canVisit(s.id) ? '<br><a href="#/visit?site=' + s.id + '">Start visit here</a>' : ''));
    if (mine.indexOf(s.id) !== -1 && myPts.length === 1) m.openPopup();
  });
  S.map = map;
}

/* ----------------------------------------------------------- visit form -- */
function blankVisit(siteId) {
  return {
    id: uuid(),
    site_id: siteId ? Number(siteId) : null,
    farm_id: null,
    gps: null,
    started_at: new Date().toISOString(),
    submitted_at: null,
    sample_collected: false,
    sample_id: '',
    farmer_id: null,
    ai_administered: null,   // must be answered Yes/No before sync
    issue: '',
    notes: '',
    readings: [],     // [{parameter, replicate, value, unit}]
    photos: [],       // [{id, mime, data_base64}]
    state: 'draft',
    updated_at: new Date().toISOString()
  };
}
function parseRoute(route) {
  var q = {};
  var qs = route.split('?')[1] || '';
  qs.split('&').forEach(function (kv) {
    var p = kv.split('='); if (p[0]) q[p[0]] = decodeURIComponent(p[1] || '');
  });
  return q;
}
function viewVisit(route) {
  var q = parseRoute(route);
  if (q.edit) {
    var rec = S.queue.find(function (r) { return r.id === q.edit; });
    form = rec ? JSON.parse(JSON.stringify(rec)) : blankVisit(null);
  } else if (!form || form._done || q.site) {
    var pre = q.site ? Number(q.site) : defaultSiteId();
    if (pre && !canVisit(pre)) pre = defaultSiteId();
    form = blankVisit(pre);
    if (q.farmer && pre) form.farmer_id = q.farmer;
  }
  var site = form.site_id ? siteById(form.site_id) : null;
  var fList = form.site_id ? farmsOf(form.site_id) : [];
  var fmList = form.site_id ? farmersOf(form.site_id) : [];
  var soilOn = form._soil != null ? form._soil
    : ((form.readings || []).length > 0 || !!form.sample_collected);

  var html = '<div class="card"><h2>' + (form.state !== 'draft' ? 'Edit visit' : 'New field visit') + '</h2>';

  // site select
  html += '<div class="field"><label>Site (sub-area)</label><select id="fSite">' +
    '<option value="">Choose a site…</option>' +
    visitableSites().map(function (s) {
      return '<option value="' + s.id + '"' + (form.site_id === s.id ? ' selected' : '') + '>' +
        esc(s.sub_area) + (s.is_validation_site ? ' ★' : '') + ' — ' + esc(s.district) + '</option>';
    }).join('') + '</select></div>';

  // farm chips
  if (fList.length) {
    html += '<div class="field"><label>Farm</label><div class="farm-chips">' +
      fList.map(function (f) {
        return '<button type="button" class="farm-chip' + (form.farm_id === f.id ? ' sel' : '') + '" data-farm="' + f.id + '">' + esc(f.label) + '</button>';
      }).join('') + '</div></div>';
  } else if (site) {
    html += '<p class="muted small" style="margin-bottom:12px">Not a validation site — general visit (no farm targets).</p>';
  }

  // farmer
  if (site) {
    html += '<div class="field"><label>Farmer</label><select id="fFarmer">' +
      '<option value="">— General visit (no specific farmer) —</option>' +
      fmList.map(function (f) {
        return '<option value="' + f.id + '"' + (form.farmer_id === f.id ? ' selected' : '') + '>' +
          esc(f.name) + (f.village ? ' — ' + esc(f.village) : '') + '</option>';
      }).join('') + '</select>' +
      '<button type="button" class="btn btn-outline btn-sm mt8" id="btnNewFarmer">+ Register new farmer</button>' +
      '<div id="newFarmerBox" class="mt8" style="display:none;border:1.5px dashed var(--line);border-radius:12px;padding:12px">' +
      '<div class="field"><label>Farmer full name</label><input id="nfName" type="text"></div>' +
      '<div class="row"><div class="field" style="flex:1"><label>Village</label><input id="nfVillage" type="text"></div>' +
      '<div class="field" style="flex:0 0 90px"><label>Age</label><input id="nfAge" type="text" inputmode="numeric"></div></div>' +
      '<div class="row"><div class="field" style="flex:1"><label>Gender</label><select id="nfGender">' +
      '<option value="">—</option><option value="F">Female</option><option value="M">Male</option></select></div>' +
      '<div class="field" style="flex:1"><label>Phone</label><input id="nfPhone" type="tel"></div></div>' +
      '<button type="button" class="btn btn-secondary btn-block" id="btnSaveFarmer">Save farmer</button>' +
      '</div></div>';
  }

  // GPS
  html += '<div class="field"><label>GPS location <span style="color:var(--danger)">*</span></label><div class="gps-box">' +
    '<button type="button" class="btn btn-secondary btn-sm" id="btnGps">⌖ Capture</button>' +
    '<span class="gps-status" id="gpsStatus">' + gpsStatusHTML() + '</span></div></div>';
  html += '</div>';

  // visit activity: which kind of advisory was given (both groups advise farmers)
  html += '<div class="card"><h2>Visit activity</h2>' +
    '<div class="field"><label>Advisory given this visit <span style="color:var(--danger)">*</span></label>' +
    '<p class="muted small" style="margin:-2px 0 6px">Advice is given to every farmer — record which type. Either answer keeps the rest of the form open.</p>' +
    '<div class="farm-chips">' +
    '<button type="button" class="farm-chip' + (form.ai_administered === true ? ' sel' : '') + '" data-ai="1">AI advisory</button>' +
    '<button type="button" class="farm-chip' + (form.ai_administered === false ? ' sel' : '') + '" data-ai="0">Conventional (no AI)</button>' +
    '</div></div>' +
    '<div class="field mt8"><label>Specific issue observed (optional)</label>' +
    '<textarea id="fIssue" placeholder="e.g. pest outbreak, sensor fault, farmer unavailable…">' + esc(form.issue || '') + '</textarea></div>' +
    '</div>';

  // soil data — optional, off by default (not every visit collects soil data)
  html += '<div class="card"><div class="toggle-row"><span style="font-weight:700">Soil data collected this visit?</span>' +
    '<span class="switch"><input type="checkbox" id="fSoil"' + (soilOn ? ' checked' : '') + '><span class="track"></span></span></div></div>';
  html += '<div id="soilWrap" style="' + (soilOn ? '' : 'display:none') + '">';

  // readings
  html += '<div class="card"><h2>Sensor readings</h2>' +
    '<p class="muted small">3 readings per parameter. Leave blank what you did not measure.</p>' +
    '<div class="scroll-x"><table class="readings-table"><thead><tr><th></th><th>R1</th><th>R2</th><th>R3</th></tr></thead><tbody>' +
    PARAMS.map(function (p) {
      return '<tr><td>' + esc(p.label) + (p.unit ? '<span class="unit">' + esc(p.unit) + '</span>' : '') + '</td>' +
        [1, 2, 3].map(function (rep) {
          var val = readingVal(p.key, rep);
          return '<td><input type="text" inputmode="decimal" data-param="' + p.key + '" data-rep="' + rep + '" value="' + esc(val) + '"></td>';
        }).join('') + '</tr>';
    }).join('') +
    '</tbody></table></div></div>';

  // sample + photos + notes
  html += '<div class="card"><h2>Topsoil sample (0–20 cm)</h2>' +
    '<div class="toggle-row"><span style="font-weight:700">Sample collected for lab?</span>' +
    '<span class="switch"><input type="checkbox" id="fSample"' + (form.sample_collected ? ' checked' : '') + '><span class="track"></span></span></div>' +
    '<div class="field mt8" id="sampleIdWrap" style="' + (form.sample_collected ? '' : 'display:none') + '">' +
    '<label>Sample ID (write the same ID on the bag)</label>' +
    '<input id="fSampleId" type="text" placeholder="e.g. KOLO-F1-001" value="' + esc(form.sample_id) + '"></div>' +
    '</div>' +
    '</div>';  // /soilWrap

  html += '<div class="card"><h2>Photos & notes</h2>' +
    '<p class="muted small">At least one photo is required. Notes are optional.</p>' +
    '<div class="photo-strip" id="photoStrip">' + photoStripHTML() + '</div>' +
    '<input type="file" id="fPhotoCam" accept="image/*" capture="environment" style="display:none">' +
    '<input type="file" id="fPhoto" accept="image/*" style="display:none">' +
    '<div class="field mt12"><label>Notes (optional)</label>' +
    '<textarea id="fNotes" placeholder="Field conditions, issues…">' + esc(form.notes) + '</textarea></div>' +
    '</div>';

  html += '<div class="card"><h3>Required before sync</h3><div id="reqList"></div></div>' +
    '<button class="btn btn-primary btn-block" id="btnSave">Save & sync</button>' +
    '<button class="btn btn-outline btn-block mt8" id="btnDraft">Save as draft</button>' +
    '<p class="muted small mt8" style="text-align:center">Drafts stay on this phone until the required items are complete.</p>';
  return html;
}
function visitReqs(rec) {
  return [
    ['Site selected', !!rec.site_id],
    ['GPS location captured', !!rec.gps],
    ['Advisory type selected', rec.ai_administered === true || rec.ai_administered === false],
    ['At least one photo added', (rec.photos || []).length > 0]
  ];
}
function updateReqs() {
  var el = $('#reqList'); if (!el || !form) return;
  var reqs = visitReqs(form);
  el.innerHTML = reqs.map(function (r) {
    return '<div class="req-row' + (r[1] ? ' ok' : '') + '">' +
      '<span class="req-dot">' + (r[1] ? '✓' : '') + '</span>' + esc(r[0]) + '</div>';
  }).join('');
  var ready = reqs.every(function (r) { return r[1]; });
  var btn = $('#btnSave');
  if (btn) {
    btn.disabled = !ready;
    btn.classList.toggle('btn-ready', ready);
    btn.textContent = ready ? '✓ Save & sync' : 'Save & sync';
  }
}
function readingVal(param, rep) {
  var r = (form.readings || []).find(function (x) { return x.parameter === param && x.replicate === rep; });
  return r && r.value != null ? r.value : '';
}
function gpsStatusHTML() {
  if (!form.gps) return '<span class="muted">Not captured yet</span>';
  var s = form.site_id ? siteById(form.site_id) : null;
  var txt = form.gps.lat.toFixed(5) + ', ' + form.gps.lon.toFixed(5) +
    (form.gps.accuracy_m ? ' (±' + Math.round(form.gps.accuracy_m) + 'm)' : '');
  if (s) {
    var d = haversineM(form.gps.lat, form.gps.lon, s.lat, s.lon);
    txt += d > GPS_FLAG_M
      ? ' — <b style="color:var(--warn)">' + (d >= 1000 ? (d / 1000).toFixed(1) + ' km' : d + ' m') + ' from site</b>'
      : ' — <b style="color:var(--ok)">' + d + ' m from site ✓</b>';
  }
  return txt;
}
function photoStripHTML() {
  var html = (form.photos || []).map(function (p, i) {
    return '<span class="photo-thumb"><img src="data:' + p.mime + ';base64,' + p.data_base64 + '" alt="photo">' +
      '<button type="button" data-rmphoto="' + i + '">×</button></span>';
  }).join('');
  if ((form.photos || []).length < MAX_PHOTOS) {
    html += '<label for="fPhotoCam" class="photo-add" role="button" id="btnCamera">📷<span style="font-size:11px;font-weight:700">Camera</span></label>' +
      '<label for="fPhoto" class="photo-add" role="button" id="btnGallery">🖼<span style="font-size:11px;font-weight:700">Gallery</span></label>';
  }
  return html;
}
function bindVisit() {
  $('#btnLogout').onclick = confirmLogout;

  $('#fSite').addEventListener('change', function () {
    captureFormText();
    form.site_id = this.value ? Number(this.value) : null;
    form.farm_id = null;
    rerenderVisit();
  });
  // only real farm chips — the AI Yes/No buttons share the class for styling
  $all('.farm-chip[data-farm]').forEach(function (b) {
    b.addEventListener('click', function () {
      captureFormText();
      form.farm_id = Number(this.dataset.farm);
      rerenderVisit();
    });
  });

  $('#btnGps').addEventListener('click', function () {
    var st = $('#gpsStatus');
    if (!navigator.geolocation) { st.innerHTML = '<span style="color:var(--danger)">GPS not available on this device</span>'; return; }
    st.textContent = 'Getting location…';
    navigator.geolocation.getCurrentPosition(function (pos) {
      form.gps = {
        lat: pos.coords.latitude, lon: pos.coords.longitude,
        accuracy_m: pos.coords.accuracy, at: new Date().toISOString()
      };
      st.innerHTML = gpsStatusHTML();
      updateReqs();
    }, function (err) {
      st.innerHTML = '<span style="color:var(--danger)">' +
        (err.code === 1 ? 'Location permission denied' : 'Could not get location') + '</span>';
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 });
  });

  $('#fSample').addEventListener('change', function () {
    form.sample_collected = this.checked;
    $('#sampleIdWrap').style.display = this.checked ? '' : 'none';
  });

  var farmerSel = $('#fFarmer');
  if (farmerSel) {
    farmerSel.addEventListener('change', function () { form.farmer_id = this.value || null; });
  }
  var btnNF = $('#btnNewFarmer');
  if (btnNF) {
    btnNF.addEventListener('click', function () {
      var box = $('#newFarmerBox');
      box.style.display = box.style.display === 'none' ? '' : 'none';
    });
    $('#btnSaveFarmer').addEventListener('click', function () {
      captureFormText();
      registerFarmer({
        site_id: form.site_id,
        name: $('#nfName').value, village: $('#nfVillage').value,
        gender: $('#nfGender').value, age: $('#nfAge').value, phone: $('#nfPhone').value
      }, function (reg) {
        form.farmer_id = reg.id;
        rerenderVisit();
      });
    });
  }
  $all('[data-ai]').forEach(function (b) {
    b.addEventListener('click', function () {
      form.ai_administered = this.dataset.ai === '1';
      $all('[data-ai]').forEach(function (x) { x.classList.toggle('sel', x === b); });
      updateReqs();
    });
  });
  $('#fSoil').addEventListener('change', function () {
    form._soil = this.checked;
    $('#soilWrap').style.display = this.checked ? '' : 'none';
  });

  var photoInput = $('#fPhoto');
  var camInput = $('#fPhotoCam');
  // onclick property (not addEventListener): rerenderVisit keeps the same #view
  // element, so a listener would stack up on every partial re-render.
  $('#view').onclick = function (e) {
    // the labels open the pickers natively; these are only backstops
    if (e.target.closest && e.target.closest('#btnGallery')) { try { photoInput.click(); } catch (err) {} }
    else if (e.target.closest && e.target.closest('#btnCamera')) { try { camInput.click(); } catch (err) {} }
    var rm = e.target.getAttribute('data-rmphoto');
    if (rm != null) {
      form.photos.splice(Number(rm), 1);
      $('#photoStrip').innerHTML = photoStripHTML();
      updateReqs();
    }
  };
  function acceptPhoto() {
    var file = this.files && this.files[0];
    this.value = '';
    if (!file) return;
    toast('Adding photo…');
    downscalePhoto(file).then(function (p) {
      form.photos.push(p);
      $('#photoStrip').innerHTML = photoStripHTML();
      updateReqs();
      toast('Photo added');
    }).catch(function () { toast('Could not read that photo'); });
  }
  photoInput.addEventListener('change', acceptPhoto);
  camInput.addEventListener('change', acceptPhoto);

  $('#btnSave').addEventListener('click', function () { saveVisit(true); });
  $('#btnDraft').addEventListener('click', function () { saveVisit(false); });
  updateReqs();
}
function registerFarmer(data, done) {
  var name = (data.name || '').trim();
  if (!data.site_id) { toast('Choose a site first'); return; }
  if (name.length < 3) { toast('Enter the farmer\'s full name'); return; }
  if (!canVisit(data.site_id)) { toast('You can only register farmers at your own station'); return; }
  var reg = {
    id: data.id || uuid(), site_id: Number(data.site_id), name: name,
    village: (data.village || '').trim() || null,
    gender: (data.gender || '').trim() || null,
    age: /^\d{1,3}$/.test((data.age || '').trim()) ? Number(data.age) : null,
    phone: (data.phone || '').trim() || null,
    state: 'queued', created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  };
  idb.put('farmers', reg).then(function () {
    var i = S.regQueue.findIndex(function (r) { return r.id === reg.id; });
    if (i >= 0) S.regQueue[i] = reg; else S.regQueue.push(reg);
    toast(name + (data.id ? ' updated' : ' added') + (navigator.onLine ? '' : ' — will sync when online'));
    if (done) done(reg);
    syncAll();
  });
}
function rerenderVisit() {
  var v = $('#view');
  if (v) { v.innerHTML = viewVisit(location.hash.replace(/^#/, '').split('?')[0]); bindVisit(); }
}
function captureFormText() {
  if (!$('#fNotes')) return;
  form.notes = $('#fNotes').value;
  form.issue = $('#fIssue') ? $('#fIssue').value : form.issue;
  form.farmer_id = $('#fFarmer') ? ($('#fFarmer').value || null) : form.farmer_id;
  var soilOn = $('#fSoil') ? $('#fSoil').checked : true;
  form._soil = $('#fSoil') ? soilOn : form._soil;
  if (!soilOn) {
    form.readings = [];
    form.sample_collected = false;
    form.sample_id = '';
    return;
  }
  form.sample_id = $('#fSampleId') ? $('#fSampleId').value : form.sample_id;
  form.readings = [];
  $all('.readings-table input').forEach(function (inp) {
    var raw = inp.value.trim().replace(',', '.');
    if (raw === '') return;
    var p = PARAMS.find(function (x) { return x.key === inp.dataset.param; });
    form.readings.push({
      parameter: inp.dataset.param,
      replicate: Number(inp.dataset.rep),
      value: raw,
      unit: p ? p.unit : ''
    });
  });
}
function saveVisit(queueIt) {
  captureFormText();
  if (!form.site_id) { toast('Choose a site first'); return; }
  if (queueIt) {
    var missing = visitReqs(form).filter(function (r) { return !r[1]; });
    if (missing.length) { toast('Cannot sync yet — ' + missing[0][0].toLowerCase()); updateReqs(); return; }
  }
  var bad = form.readings.find(function (r) { return isNaN(Number(r.value)); });
  if (bad) { toast('Reading "' + bad.value + '" is not a number'); return; }
  form.readings.forEach(function (r) { r.value = Number(r.value); });
  form.submitted_at = new Date().toISOString();
  form.updated_at = new Date().toISOString();
  form.state = queueIt ? 'queued' : 'draft';
  form.error = null;
  var rec = JSON.parse(JSON.stringify(form));
  idb.put('visits', rec).then(function () {
    form._done = true;
    return loadQueue();
  }).then(function () {
    location.hash = '#/queue';
    if (queueIt) syncAll();
  });
}
function downscalePhoto(file) {
  return new Promise(function (resolve, reject) {
    var img = new Image();
    var url = URL.createObjectURL(file);
    img.onload = function () {
      try {
        // keep detail (1600px / q0.85); step down only if the result would
        // exceed what the server accepts, so big camera photos still go through
        var px = PHOTO_MAX_PX, q = PHOTO_QUALITY, b64;
        for (var attempt = 0; attempt < 4; attempt++) {
          var scale = Math.min(1, px / Math.max(img.width, img.height));
          var canvas = document.createElement('canvas');
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          b64 = canvas.toDataURL('image/jpeg', q).split(',')[1];
          if (b64.length <= PHOTO_MAX_B64) break;
          px = Math.round(px * 0.8); q = Math.max(0.6, q - 0.08);
        }
        URL.revokeObjectURL(url);
        resolve({ id: uuid(), mime: 'image/jpeg', data_base64: b64 });
      } catch (e) { reject(e); }
    };
    img.onerror = reject;
    img.src = url;
  });
}

/* ----------------------------------------------------------------- queue -- */
function viewQueue() {
  var pend = pendingCount();
  var html = '<div class="row spread">' +
    '<h2 class="brand-font" style="font-size:18px;color:var(--forest-dark)">Sync status</h2>' +
    '<button class="btn btn-secondary btn-sm" id="btnSyncNow">' + (S.syncing ? 'Syncing…' : 'Sync now') + '</button></div>';
  if (!navigator.onLine) html += '<div class="info-box mt8">You are offline. Visits are saved on this phone and will sync automatically when you have signal.</div>';
  if (!S.queue.length) html += '<div class="card mt12"><p class="muted">No visits recorded on this phone yet.</p></div>';
  else {
    html += '<div class="card mt12">' + S.queue.map(function (r) {
      var s = siteById(r.site_id);
      var f = (farms().find(function (x) { return x.id === r.farm_id; }) || {}).label;
      var fm = r.farmer_id ? (farmers().find(function (x) { return x.id === r.farmer_id; }) || {}).name : null;
      var readingsN = (r.readings || []).length;
      return '<div class="queue-item">' +
        '<div class="row spread"><b>' + esc(s ? s.sub_area : 'Site ' + r.site_id) + (f ? ' · ' + esc(f) : '') + '</b>' +
        '<span class="chip state-' + r.state + '">' + r.state + '</span></div>' +
        '<div class="muted small">' + fmtWhen(r.submitted_at || r.updated_at) +
        (fm ? ' · ' + esc(fm) : '') +
        (r.ai_administered === true ? ' · AI advisory' : (r.ai_administered === false ? ' · conventional' : '')) +
        (r.issue ? ' · issue noted' : '') +
        ' · ' + readingsN + ' readings' +
        (r.sample_collected ? ' · sample ' + esc(r.sample_id || '') : '') +
        ((r.photos || []).length ? ' · ' + r.photos.length + ' photo(s)' : '') + '</div>' +
        (r.error ? '<div class="small" style="color:var(--danger);margin-top:3px">' + esc(r.error) + '</div>' : '') +
        '<div class="row mt8">' +
        '<a class="btn btn-outline btn-sm" href="#/visit?edit=' + r.id + '">Edit</a>' +
        (r.state === 'draft' ? '<button class="btn btn-secondary btn-sm" data-queue="' + r.id + '">Queue for sync</button>' : '') +
        (r.state !== 'synced' ? '<button class="btn btn-danger-outline btn-sm" data-del="' + r.id + '">Delete</button>'
                              : '<button class="btn btn-outline btn-sm" data-del="' + r.id + '">Remove from phone</button>') +
        '</div></div>';
    }).join('') + '</div>';
  }
  html += '<p class="muted small">' + pend + ' pending · synced visits stay safe on the server.</p>';
  return html;
}
function bindQueue() {
  $('#btnLogout').onclick = confirmLogout;
  $('#btnSyncNow').addEventListener('click', function () { syncAll(true); });
  $('#view').onclick = function (e) {
    var qid = e.target.getAttribute('data-queue');
    var did = e.target.getAttribute('data-del');
    if (qid) {
      var rec = S.queue.find(function (r) { return r.id === qid; });
      if (rec) {
        var missing = visitReqs(rec).filter(function (r2) { return !r2[1]; });
        if (missing.length) {
          toast('Complete first: ' + missing[0][0].toLowerCase());
          location.hash = '#/visit?edit=' + rec.id;
          return;
        }
        rec.state = 'queued'; rec.updated_at = new Date().toISOString();
        idb.put('visits', rec).then(loadQueue).then(function () { render(); syncAll(); });
      }
    } else if (did) {
      var rec2 = S.queue.find(function (r) { return r.id === did; });
      var warn = rec2 && rec2.state !== 'synced'
        ? 'Delete this visit? It has NOT been synced and will be lost.'
        : 'Remove the local copy? The synced data stays on the server.';
      if (confirm(warn)) idb.del('visits', did).then(loadQueue).then(render);
    }
  };
}

/* ------------------------------------------------------------- dashboard -- */
function viewDash() {
  return '<div id="dashBody"><div class="card"><p class="muted">Loading dashboard…' +
    (navigator.onLine ? '' : ' (offline — showing nothing new)') + '</p></div></div>';
}
function bindDash() {
  $('#btnLogout').onclick = confirmLogout;
  if (!navigator.onLine) {
    $('#dashBody').innerHTML = '<div class="info-box">The dashboard needs a connection.</div>';
    return;
  }
  Promise.all([
    rpc('fs_progress', { p_token: S.token }),
    rpc('fs_activity', { p_token: S.token })
  ]).then(function (res) {
    renderDash(res[0], res[1]);
  }).catch(function (err) {
    if (handleAuthError(err)) return;
    var el = $('#dashBody');
    if (el) el.innerHTML = '<div class="error-box">' + esc(err.message) + '</div>';
  });
}
function chartVisitsByFS(prog) {
  var rows = (prog.supervisors || []).filter(function (x) { return x.role === 'supervisor'; })
    .sort(function (a, b) { return (b.visits || 0) - (a.visits || 0); });
  var withData = rows.filter(function (x) { return Number(x.visits); });
  if (!withData.length) return '<p class="muted small">Chart appears once visits start syncing.</p>';
  var max = Math.max.apply(null, withData.map(function (x) { return x.visits; }));
  return '<div class="chart-legend">' +
    '<span class="row" style="gap:6px"><span class="sw" style="background:#006838"></span>AI administered</span>' +
    '<span class="row" style="gap:6px"><span class="sw" style="background:#00a0dc"></span>Conventional</span></div>' +
    withData.map(function (x) {
      var ai = Number(x.ai_visits || 0), rest = Number(x.visits) - ai;
      return '<div class="hbar-row act-row" data-fsprofile="' + x.id + '" title="' + esc(x.name) + ': ' + x.visits + ' visits, ' + ai + ' with AI advisory">' +
        '<span class="hbar-label">' + esc((x.name || '').split(/\s+/)[0]) + '</span>' +
        '<span class="hbar-bars">' +
        (ai ? '<span class="hbar-seg" style="background:#006838;width:' + (ai / max * 100) + '%"></span>' : '') +
        (rest ? '<span class="hbar-seg" style="background:#00a0dc;width:' + (rest / max * 100) + '%"></span>' : '') +
        '</span>' +
        '<span class="hbar-val">' + x.visits + (ai ? ' (' + ai + ' AI)' : '') + '</span></div>';
    }).join('');
}
function chartEngagement(prog) {
  var rows = (prog.sites || []).filter(function (x) { return Number(x.farmers_total); })
    .map(function (x) {
      return { id: x.site_id, name: x.sub_area, e: Number(x.farmers_engaged || 0), t: Number(x.farmers_total),
               pct: Number(x.farmers_engaged || 0) / Number(x.farmers_total) };
    }).sort(function (a, b) { return b.pct - a.pct || b.e - a.e; });
  if (!rows.length) return '<p class="muted small">No farmer data yet.</p>';
  return rows.map(function (x) {
    return '<div class="hbar-row act-row" data-siteprofile="' + x.id + '" title="' + esc(x.name) + ': ' + x.e + ' of ' + x.t + ' farmers engaged">' +
      '<span class="hbar-label">' + esc(x.name) + '</span>' +
      '<span class="hbar-track"><span class="hbar-seg" style="background:#006838;width:' + Math.min(100, Math.round(x.pct * 100)) + '%"></span></span>' +
      '<span class="hbar-val">' + x.e + '/' + x.t + '</span></div>';
  }).join('');
}
function chartWeekly(act) {
  var now = new Date();
  var weeks = [];
  for (var i = 7; i >= 0; i--) {
    var d = new Date(now.getTime() - i * 7 * 86400000);
    var day = (d.getDay() + 6) % 7;                       // Monday start
    var start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
    weeks.push({ start: start, n: 0 });
  }
  ((act && act.visits) || []).forEach(function (v) {
    var t = new Date(v.synced_at).getTime();
    for (var j = weeks.length - 1; j >= 0; j--) {
      if (t >= weeks[j].start.getTime()) { weeks[j].n++; break; }
    }
  });
  if (!weeks.some(function (w) { return w.n; })) return '<p class="muted small">Chart appears once visits start syncing.</p>';
  var max = Math.max.apply(null, weeks.map(function (w) { return w.n; }));
  return '<div class="cols">' + weeks.map(function (w) {
    var label = w.start.getDate() + ' ' + w.start.toLocaleDateString(undefined, { month: 'short' });
    return '<div class="col" title="Week of ' + label + ': ' + w.n + ' visit' + (w.n === 1 ? '' : 's') + '">' +
      '<span class="cv">' + (w.n || '') + '</span>' +
      '<span class="cbar" style="height:' + (w.n ? Math.max(6, Math.round(w.n / max * 82)) : 2) + 'px' + (w.n ? '' : ';background:#eceae3') + '"></span>' +
      '<span class="cl">' + label + '</span></div>';
  }).join('') + '</div>';
}
function renderDash(prog, act) {
  var el = $('#dashBody'); if (!el) return;
  S._prog = prog; S._act = act;
  var canManage = S.me && S.me.role === 'manager';
  var t = prog.totals, g = prog.targets;
  var html = '';

  // recent activity first — latest 5, tap a row for full detail, View all for the rest
  var allVisits = act.visits || [];
  html += '<div class="card"><div class="row spread"><h2>Recent activity</h2>' +
    (allVisits.length > 5 ? '<button class="btn btn-outline btn-sm" id="btnAllActivity">View all (' + allVisits.length + ')</button>' : '') +
    '</div>' +
    (allVisits.length ? allVisits.slice(0, 5).map(actRowHTML).join('')
                      : '<p class="muted small">No synced visits yet.</p>') +
    '</div>';

  // intelligence strip: at most 4 aggregated, tappable items — never a wall of rows
  var fsAll = (prog.supervisors || []).filter(function (sp) { return sp.role === 'supervisor' && sp.active !== false; });
  var unstarted = fsAll.filter(function (sp) { return !sp.last_synced_at; });
  var inactive = fsAll.filter(function (sp) { return sp.last_synced_at && daysSince(sp.last_synced_at) >= 7; });
  var flaggedList = (act.visits || []).filter(function (v) { return v.gps_flag || Number(v.out_of_range); });
  var issueList = (act.visits || []).filter(function (v) { return v.issue; });
  var attention = [];
  if (unstarted.length) attention.push(['warn',
    unstarted.length + ' of ' + fsAll.length + ' Field Supervisors have not synced a visit yet', 'fs_unstarted']);
  if (inactive.length) attention.push(['warn',
    inactive.length + ' Field Supervisor' + (inactive.length === 1 ? '' : 's') + ' inactive for 7+ days', 'fs_inactive']);
  if (flaggedList.length) attention.push(['info',
    flaggedList.length + ' recent visit' + (flaggedList.length === 1 ? '' : 's') + ' with data-quality flags', 'flags']);
  if (issueList.length) attention.push(['info',
    issueList.length + ' issue' + (issueList.length === 1 ? '' : 's') + ' reported — latest: ' +
    esc(String(issueList[0].issue).slice(0, 50)), 'issues']);
  html += '<div class="card"><h2>Needs attention</h2>' +
    (attention.length
      ? attention.map(function (a) {
          return '<button class="nudge ' + a[0] + '" style="width:100%;margin-bottom:6px" data-modal="' + a[2] + '">' +
            a[1] + ' <span style="margin-left:auto">›</span></button>';
        }).join('')
      : '<div class="nudge ok">All good — nothing needs attention right now</div>') +
    '</div>';

  html += '<div class="stat-grid">' +
    stat(t.visits, 'Total visits', 'visits_total') +
    stat((t.farmers_engaged || 0) + '/' + (t.farmers || 0), 'Farmers engaged', 'farmers_engaged') +
    stat(t.ai_visits || 0, 'AI administered', 'ai') +
    stat(t.issues || 0, 'Issues logged', 'issues') +
    stat(t.farms_complete + '/' + g.validation_farms, 'Farms complete', 'farms') +
    stat(t.readings, 'Readings', 'readings') +
    stat(t.samples, 'Lab samples', 'samples') +
    stat(t.farmers || 0, 'Farmers listed', 'farmers_listed') +
    '</div>';

  html += '<div class="card mt12" data-modal="ai"><h2>Visits by Field Supervisor</h2>' + chartVisitsByFS(prog) + '</div>' +
    '<div class="card" data-modal="farmers_engaged"><h2>Farmer engagement by site</h2>' + chartEngagement(prog) + '</div>' +
    '<div class="card" data-modal="visits_week"><h2>Visits per week</h2>' + chartWeekly(act) + '</div>';

  // validation site progress
  var vSites = (prog.sites || []).filter(function (s) { return s.is_validation_site; });
  html += '<div class="card mt12"><h2>Validation progress</h2>' + vSites.map(function (s) {
    var pct = s.readings_target ? Math.min(100, Math.round(s.readings_done * 100 / s.readings_target)) : 0;
    return '<div class="mt8"><div class="row spread"><b>' + esc(s.sub_area) + '</b>' +
      '<span class="small muted">' + s.farms_complete + '/3 farms · ' + s.readings_done + '/' + s.readings_target + ' readings</span></div>' +
      '<div class="pbar' + (pct >= 100 ? ' full' : '') + '"><div style="width:' + pct + '%"></div></div></div>';
  }).join('') + '</div>';

  // team — Field Supervisors (performance data) separate from programme staff
  var mgmtBtns = function (m) {
    return canManage ? '<span class="row" style="gap:6px">' +
      '<button class="btn btn-outline btn-sm" data-pin="' + m.id + '" data-name="' + esc(m.name) + '">PIN</button>' +
      '<button class="btn ' + (m.active ? 'btn-danger-outline' : 'btn-secondary') + ' btn-sm" data-toggle="' + m.id + '" data-active="' + m.active + '" data-name="' + esc(m.name) + '">' +
      (m.active ? 'Off' : 'On') + '</button></span>' : '';
  };
  var avatarOf = function (m) {
    return '<span class="avatar">' + esc(m.name.split(/\s+/).map(function (w) { return w[0] || ''; }).join('').slice(0, 2).toUpperCase()) + '</span>';
  };
  var fsRow = function (m) {
    return '<div class="team-item">' + avatarOf(m) +
      '<span class="site-main act-row" data-fsprofile="' + m.id + '"><span class="site-name">' + esc(m.name) +
      (!m.active ? ' <span class="chip red">inactive</span>' : '') + '</span>' +
      '<span class="site-meta">' + esc(m.username || m.phone || '') +
      (m.station ? ' · ' + esc(m.station) : '') + ' · ' + m.visits + ' visits' +
      (Number(m.farmers_registered) ? ' · +' + m.farmers_registered + ' farmers' : '') +
      ' · last: ' + fmtWhen(m.last_synced_at) +
      (m.last_gps ? ' @ ' + esc(m.last_gps.site) : '') + '</span></span>' + mgmtBtns(m) + '</div>';
  };
  var staffRow = function (m) {
    return '<div class="team-item">' + avatarOf(m) +
      '<span class="site-main"><span class="site-name">' + esc(m.name) +
      (m.role === 'manager' ? ' <span class="chip blue">manager</span>' : ' <span class="chip grey">viewer</span>') +
      (!m.active ? ' <span class="chip red">inactive</span>' : '') + '</span>' +
      '<span class="site-meta">' + esc(m.username || m.phone || '') + '</span></span>' + mgmtBtns(m) + '</div>';
  };
  var fieldTeam = (act.team || []).filter(function (m) { return m.role === 'supervisor'; });
  var staff = (act.team || []).filter(function (m) { return m.role !== 'supervisor'; });
  html += '<div class="card"><h2>Field team</h2>' + fieldTeam.map(fsRow).join('') +
    (staff.length ? '<h3 class="mt12">Programme staff</h3>' + staff.map(staffRow).join('') : '') +
    (canManage ? '<h3 class="mt12">Add team member</h3>' +
    '<div class="field"><input id="nName" placeholder="Full name"></div>' +
    '<div class="row"><div class="field" style="flex:1"><input id="nUser" autocapitalize="none" placeholder="Username (first name)"></div>' +
    '<div class="field" style="flex:1"><input id="nPin" type="text" inputmode="numeric" placeholder="PIN (4-8 digits)"></div></div>' +
    '<div class="field"><input id="nPhone" type="tel" placeholder="Phone (optional)"></div>' +
    '<div class="field"><select id="nRole"><option value="supervisor">Field Supervisor</option>' +
    '<option value="viewer">Viewer (read-only)</option><option value="manager">Manager</option></select></div>' +
    '<button class="btn btn-primary btn-block" id="btnAddMember">Add member</button>' : '') +
    '</div>';

  html += copyrightHTML();

  el.innerHTML = html;

  if ($('#btnAddMember')) $('#btnAddMember').addEventListener('click', function () {
    var name = $('#nName').value.trim(), phone = $('#nPhone').value.trim(), pin = $('#nPin').value.trim();
    var user = $('#nUser').value.trim(), role = $('#nRole').value;
    if (!name || !pin || (!user && !phone)) { toast('Fill in name, PIN and a username (or phone)'); return; }
    rpc('fs_add_supervisor', { p_token: S.token, p_name: name, p_phone: phone, p_pin: pin, p_role: role, p_username: user })
      .then(function () { toast(name + ' added'); bindDash(); })
      .catch(function (err) { if (!handleAuthError(err)) toast(err.message); });
  });
  // onclick property: #dashBody persists across bindDash refreshes
  el.onclick = function (e) {
    if (e.target.id === 'btnAllActivity') {
      showModal('All activity', (act.visits || []).map(actRowHTML).join(''));
      return;
    }
    var vEl = e.target.closest && e.target.closest('[data-visit]');
    if (vEl) { visitDetailModal(vEl.getAttribute('data-visit')); return; }
    var spEl = e.target.closest && e.target.closest('[data-siteprofile]');
    if (spEl) { siteProfileModal(spEl.getAttribute('data-siteprofile')); return; }
    var fpEl = e.target.closest && e.target.closest('[data-fsprofile]');
    if (fpEl) { fsProfileModal(fpEl.getAttribute('data-fsprofile')); return; }
    var mk = e.target.closest && e.target.closest('[data-modal]');
    if (mk) { statModal(mk.getAttribute('data-modal')); return; }
    var pinId = e.target.getAttribute('data-pin');
    var togId = e.target.getAttribute('data-toggle');
    if (pinId) {
      var np = prompt('New PIN for ' + e.target.getAttribute('data-name') + ' (4-8 digits):');
      if (!np) return;
      rpc('fs_set_supervisor', { p_token: S.token, p_id: pinId, p_new_pin: np.trim() })
        .then(function () { toast('PIN updated'); })
        .catch(function (err) { if (!handleAuthError(err)) toast(err.message); });
    } else if (togId) {
      var isActive = e.target.getAttribute('data-active') === 'true';
      var nm = e.target.getAttribute('data-name');
      if (!confirm((isActive ? 'Deactivate ' : 'Reactivate ') + nm + '?')) return;
      rpc('fs_set_supervisor', { p_token: S.token, p_id: togId, p_active: !isActive })
        .then(function () { toast(nm + (isActive ? ' deactivated' : ' reactivated')); bindDash(); })
        .catch(function (err) { if (!handleAuthError(err)) toast(err.message); });
    }
  };
}
function fmtDist(m) {
  if (m == null) return '—';
  m = Number(m);
  return m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m';
}

/* ------------------------------------------------------------------ boot -- */
window.addEventListener('hashchange', function () { closeModal(); render(); });
window.addEventListener('online', function () {
  updateNetDot();
  if (pendingCount()) toast('Back online — syncing your visits…');
  syncAll();
});
window.addEventListener('offline', updateNetDot);
document.addEventListener('visibilitychange', function () {
  if (!document.hidden && S.token) syncAll();
});

loadQueue().catch(function () {}).then(function () {
  if (!location.hash) location.hash = S.token ? '#/home' : '#/login';
  render();
  if (S.token) {
    // refresh cached data, then re-render only the content view — a full
    // render would wipe in-progress typing and reset the open drawer
    refreshBoot().then(function () {
      var r = (location.hash || '#/home').replace(/^#/, '');
      var v = $('#view');
      if (!v) return;
      if ((r === '/home' || r === '') && S.me && S.me.role === 'supervisor') {
        v.innerHTML = viewSmartHome(); bindSmartHome();
      } else if (r === '/map') {
        v.innerHTML = viewMap(); bindMap();
      }
      renderNavBadge();
    });
    syncAll();
  }
});
