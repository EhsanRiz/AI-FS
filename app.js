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
var MAX_PHOTOS = 2;

/* ----------------------------------------------------------------- state -- */
var S = {
  token: localStorage.getItem('fsm_token') || null,
  me: readJSON('fsm_me'),
  boot: readJSON('fsm_boot'),       // {sites, farms, progress} cached from server
  queue: [],                        // local visit records from IndexedDB
  syncing: false,
  map: null
};
var form = null;                    // active visit-form record

function readJSON(k) {
  try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; }
}
function sites() { return (S.boot && S.boot.sites) || (window.FSM_SEED || {}).sites || []; }
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
      var req = indexedDB.open('fsm', 1);
      req.onupgradeneeded = function () {
        req.result.createObjectStore('visits', { keyPath: 'id' });
      };
      req.onsuccess = function () { idb._db = req.result; resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  },
  put: function (rec) {
    return idb.open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('visits', 'readwrite');
        tx.objectStore('visits').put(rec);
        tx.oncomplete = resolve; tx.onerror = function () { reject(tx.error); };
      });
    });
  },
  del: function (id) {
    return idb.open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('visits', 'readwrite');
        tx.objectStore('visits').delete(id);
        tx.oncomplete = resolve; tx.onerror = function () { reject(tx.error); };
      });
    });
  },
  all: function () {
    return idb.open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var req = db.transaction('visits').objectStore('visits').getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }
};
function loadQueue() {
  return idb.all().then(function (rows) {
    rows.sort(function (a, b) { return (b.updated_at || '').localeCompare(a.updated_at || ''); });
    S.queue = rows;
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
    var todo = S.queue.filter(function (r) { return r.state === 'queued' || r.state === 'failed'; });
    var chain = Promise.resolve();
    var okCount = 0, failCount = 0;
    todo.forEach(function (rec) {
      chain = chain.then(function () {
        return rpc('fs_submit_visit', {
          p_token: S.token,
          p_visit: {
            id: rec.id, site_id: rec.site_id, farm_id: rec.farm_id || null,
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
          return idb.put(rec);
        }).catch(function (err) {
          if (handleAuthError(err)) throw err;
          rec.state = 'failed';
          rec.error = err.message;
          failCount++;
          return idb.put(rec);
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
    if (location.hash === '#/queue' || location.hash === '' || location.hash === '#/home') render();
    else renderNavBadge();
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
    '<main id="view"></main>' +
    navHTML(route) +
    '<div id="toast"></div>';

  var view = $('#view');
  if (route.indexOf('/visit') === 0) { view.innerHTML = viewVisit(route); bindVisit(); }
  else if (route === '/map') { view.innerHTML = viewMap(); bindMap(); }
  else if (route === '/queue') { view.innerHTML = viewQueue(); bindQueue(); }
  else if (route === '/dash') { view.innerHTML = viewDash(); bindDash(); }
  else { view.innerHTML = viewHome(); bindHome(); }
  updateNetDot();
}

function headerHTML() {
  return '<header class="app-header">' +
    '<div><div class="title">FS Field Monitoring</div>' +
    '<div class="sub">' + esc(S.me ? S.me.name : '') + (S.me && S.me.role === 'manager' ? ' · Manager' : '') + '</div></div>' +
    '<div class="header-actions">' +
    '<span class="net-dot' + (navigator.onLine ? '' : ' off') + '" id="netDot" title="Connection"></span>' +
    '<button class="icon-btn" id="btnLogout">Sign out</button>' +
    '</div></header>';
}

var ICONS = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>',
  map: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/></svg>',
  queue: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.3"/><path d="M21 3v6h-6"/></svg>',
  dash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="12" width="4" height="8" rx="1"/><rect x="10" y="7" width="4" height="13" rx="1"/><rect x="17" y="3" width="4" height="17" rx="1"/></svg>'
};

function navHTML(route) {
  var pend = pendingCount();
  var isMgr = S.me && S.me.role === 'manager';
  var items = [
    { href: '#/home', icon: 'home', label: 'Sites', active: route === '/home' || route.indexOf('/visit') === 0 },
    { href: '#/map', icon: 'map', label: 'Map', active: route === '/map' },
    { href: '#/queue', icon: 'queue', label: 'Sync', active: route === '/queue', badge: pend }
  ];
  if (isMgr) items.push({ href: '#/dash', icon: 'dash', label: 'Dashboard', active: route === '/dash' });
  return '<nav class="bottom-nav">' + items.map(function (i) {
    return '<a href="' + i.href + '" class="' + (i.active ? 'active' : '') + '">' + ICONS[i.icon] +
      '<span>' + i.label + '</span>' +
      (i.badge ? '<span class="nav-badge">' + i.badge + '</span>' : '') + '</a>';
  }).join('') + '</nav>';
}
function renderNavBadge() {
  var nav = $('.bottom-nav'); if (!nav) return;
  var route = (location.hash || '#/home').replace(/^#/, '');
  nav.outerHTML = navHTML(route);
}
function updateNetDot() {
  var d = $('#netDot'); if (d) d.className = 'net-dot' + (navigator.onLine ? '' : ' off');
}

/* ----------------------------------------------------------------- login -- */
function viewLogin() {
  return '<main id="view"><div class="login-wrap">' +
    '<div class="login-logo">4DCS</div>' +
    '<h1>FS Field Monitoring</h1>' +
    '<p class="tagline muted">Soil data collection — AI-Powered Extension for Agricultural Resilience</p>' +
    '<div class="card">' +
    '<div id="loginError"></div>' +
    '<div class="field"><label>Phone number</label>' +
    '<input id="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="e.g. 5885 1234"></div>' +
    '<div class="field"><label>PIN</label>' +
    '<input id="pin" type="password" inputmode="numeric" autocomplete="current-password" placeholder="Your PIN" maxlength="8"></div>' +
    '<button class="btn btn-primary btn-block" id="btnLogin">Sign in</button>' +
    '<p class="muted small mt12">No account? Ask your programme manager to add you.</p>' +
    '</div></div><div id="toast"></div></main>';
}
function bindLogin() {
  var busy = false;
  function go() {
    if (busy) return;
    var phone = $('#phone').value.trim(), pin = $('#pin').value.trim();
    if (!phone || !pin) { $('#loginError').innerHTML = '<div class="error-box">Enter your phone number and PIN.</div>'; return; }
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
function viewHome() {
  var prog = (S.boot && S.boot.progress) || null;
  var totals = prog ? prog.totals : null;
  var targets = prog ? prog.targets : null;
  var pm = siteProgressMap();
  var vSites = sites().filter(function (s) { return s.is_validation_site; });
  var oSites = sites().filter(function (s) { return !s.is_validation_site; });

  var html = '<a class="btn btn-primary btn-block" href="#/visit">+ New field visit</a>';

  if (totals && targets) {
    html += '<div class="stat-grid mt12">' +
      stat(totals.farms_complete + '/' + targets.validation_farms, 'Farms complete') +
      stat(totals.visits, 'Visits synced') +
      stat(totals.readings, 'Readings') +
      stat(totals.samples, 'Soil samples') +
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
  return html;
}
function stat(num, label) {
  return '<div class="stat"><div class="num">' + esc(num) + '</div><div class="lbl">' + esc(label) + '</div></div>';
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
  return '<a class="site-item" href="#/visit?site=' + s.id + '">' +
    '<span class="site-dot" style="background:' + color + '"></span>' +
    '<span class="site-main"><span class="site-name">' + esc(s.sub_area) +
    (s.rc !== s.sub_area ? ' <span class="muted small">(' + esc(s.rc) + ' RC)</span>' : '') +
    (validation ? ' <span class="chip gold">validation</span>' : '') + '</span>' +
    '<span class="site-meta">' + meta + '</span></span>' + right + '</a>';
}
function bindHome() {
  $('#btnLogout').addEventListener('click', confirmLogout);
  if (navigator.onLine) refreshBoot().then(function () {
    if ((location.hash || '#/home') === '#/home' || location.hash === '') {
      var v = $('#view'); if (v) { v.innerHTML = viewHome(); }
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

/* ------------------------------------------------------------------- map -- */
function viewMap() {
  return '<div id="map"></div>' +
    '<div class="legend">' +
    Object.keys(DISTRICT_COLORS).map(function (d) {
      return '<span class="row"><span class="site-dot" style="background:' + DISTRICT_COLORS[d] + '"></span>' + esc(d) + '</span>';
    }).join('') +
    '<span class="row"><span class="site-dot" style="background:#fff;border:2.5px solid #a16207;width:15px;height:15px"></span>Validation site</span>' +
    '</div>';
}
function bindMap() {
  $('#btnLogout').addEventListener('click', confirmLogout);
  if (typeof L === 'undefined') {
    $('#map').innerHTML = '<div class="info-box" style="margin:12px">Map needs an internet connection the first time it loads.</div>';
    return;
  }
  var map = L.map('map', { zoomControl: true });
  var pts = sites();
  map.fitBounds(pts.map(function (s) { return [s.lat, s.lon]; }), { padding: [24, 24] });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 17,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);
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
      (p && Number(p.visits) ? '<br>' + p.visits + ' visit(s), last ' + fmtWhen(p.last_visit_at) : '') +
      '<br><a href="#/visit?site=' + s.id + '">Start visit here</a>');
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
    form = blankVisit(q.site || null);
  }
  var site = form.site_id ? siteById(form.site_id) : null;
  var fList = form.site_id ? farmsOf(form.site_id) : [];

  var html = '<div class="card"><h2>' + (form.state !== 'draft' ? 'Edit visit' : 'New field visit') + '</h2>';

  // site select
  html += '<div class="field"><label>Site (sub-area)</label><select id="fSite">' +
    '<option value="">Choose a site…</option>' +
    sites().map(function (s) {
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

  // GPS
  html += '<div class="field"><label>GPS location</label><div class="gps-box">' +
    '<button type="button" class="btn btn-secondary btn-sm" id="btnGps">⌖ Capture</button>' +
    '<span class="gps-status" id="gpsStatus">' + gpsStatusHTML() + '</span></div></div>';
  html += '</div>';

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
    '</div>';

  html += '<div class="card"><h2>Photos & notes</h2>' +
    '<div class="photo-strip" id="photoStrip">' + photoStripHTML() + '</div>' +
    '<input type="file" id="fPhoto" accept="image/*" capture="environment" style="display:none">' +
    '<div class="field mt12"><label>Notes (optional)</label>' +
    '<textarea id="fNotes" placeholder="Field conditions, issues…">' + esc(form.notes) + '</textarea></div>' +
    '</div>';

  html += '<button class="btn btn-primary btn-block" id="btnSave">Save & sync</button>' +
    '<button class="btn btn-outline btn-block mt8" id="btnDraft">Save as draft</button>';
  return html;
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
  if ((form.photos || []).length < MAX_PHOTOS) html += '<button type="button" class="photo-add" id="btnAddPhoto">+</button>';
  return html;
}
function bindVisit() {
  $('#btnLogout').addEventListener('click', confirmLogout);

  $('#fSite').addEventListener('change', function () {
    captureFormText();
    form.site_id = this.value ? Number(this.value) : null;
    form.farm_id = null;
    rerenderVisit();
  });
  $all('.farm-chip').forEach(function (b) {
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
    }, function (err) {
      st.innerHTML = '<span style="color:var(--danger)">' +
        (err.code === 1 ? 'Location permission denied' : 'Could not get location') + '</span>';
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 });
  });

  $('#fSample').addEventListener('change', function () {
    form.sample_collected = this.checked;
    $('#sampleIdWrap').style.display = this.checked ? '' : 'none';
  });

  var photoInput = $('#fPhoto');
  // onclick property (not addEventListener): rerenderVisit keeps the same #view
  // element, so a listener would stack up on every partial re-render.
  $('#view').onclick = function (e) {
    if (e.target.id === 'btnAddPhoto') photoInput.click();
    var rm = e.target.getAttribute('data-rmphoto');
    if (rm != null) {
      form.photos.splice(Number(rm), 1);
      $('#photoStrip').innerHTML = photoStripHTML();
    }
  };
  photoInput.addEventListener('change', function () {
    var file = this.files && this.files[0];
    this.value = '';
    if (!file) return;
    downscalePhoto(file).then(function (p) {
      form.photos.push(p);
      $('#photoStrip').innerHTML = photoStripHTML();
    }).catch(function () { toast('Could not read that photo'); });
  });

  $('#btnSave').addEventListener('click', function () { saveVisit(true); });
  $('#btnDraft').addEventListener('click', function () { saveVisit(false); });
}
function rerenderVisit() {
  var v = $('#view');
  if (v) { v.innerHTML = viewVisit(location.hash.replace(/^#/, '').split('?')[0]); bindVisit(); }
}
function captureFormText() {
  if (!$('#fNotes')) return;
  form.notes = $('#fNotes').value;
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
  var bad = form.readings.find(function (r) { return isNaN(Number(r.value)); });
  if (bad) { toast('Reading "' + bad.value + '" is not a number'); return; }
  form.readings.forEach(function (r) { r.value = Number(r.value); });
  form.submitted_at = new Date().toISOString();
  form.updated_at = new Date().toISOString();
  form.state = queueIt ? 'queued' : 'draft';
  form.error = null;
  var rec = JSON.parse(JSON.stringify(form));
  idb.put(rec).then(function () {
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
        var max = 1280;
        var scale = Math.min(1, max / Math.max(img.width, img.height));
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        var dataUrl = canvas.toDataURL('image/jpeg', 0.72);
        URL.revokeObjectURL(url);
        resolve({ id: uuid(), mime: 'image/jpeg', data_base64: dataUrl.split(',')[1] });
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
      var readingsN = (r.readings || []).length;
      return '<div class="queue-item">' +
        '<div class="row spread"><b>' + esc(s ? s.sub_area : 'Site ' + r.site_id) + (f ? ' · ' + esc(f) : '') + '</b>' +
        '<span class="chip state-' + r.state + '">' + r.state + '</span></div>' +
        '<div class="muted small">' + fmtWhen(r.submitted_at || r.updated_at) + ' · ' + readingsN + ' readings' +
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
  $('#btnLogout').addEventListener('click', confirmLogout);
  $('#btnSyncNow').addEventListener('click', function () { syncAll(true); });
  $('#view').addEventListener('click', function (e) {
    var qid = e.target.getAttribute('data-queue');
    var did = e.target.getAttribute('data-del');
    if (qid) {
      var rec = S.queue.find(function (r) { return r.id === qid; });
      if (rec) { rec.state = 'queued'; rec.updated_at = new Date().toISOString();
        idb.put(rec).then(loadQueue).then(function () { render(); syncAll(); }); }
    } else if (did) {
      var rec2 = S.queue.find(function (r) { return r.id === did; });
      var warn = rec2 && rec2.state !== 'synced'
        ? 'Delete this visit? It has NOT been synced and will be lost.'
        : 'Remove the local copy? The synced data stays on the server.';
      if (confirm(warn)) idb.del(did).then(loadQueue).then(render);
    }
  });
}

/* ------------------------------------------------------------- dashboard -- */
function viewDash() {
  return '<div id="dashBody"><div class="card"><p class="muted">Loading dashboard…' +
    (navigator.onLine ? '' : ' (offline — showing nothing new)') + '</p></div></div>';
}
function bindDash() {
  $('#btnLogout').addEventListener('click', confirmLogout);
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
function renderDash(prog, act) {
  var el = $('#dashBody'); if (!el) return;
  var t = prog.totals, g = prog.targets;
  var html = '<div class="stat-grid">' +
    stat(t.farms_complete + '/' + g.validation_farms, 'Farms complete') +
    stat(t.visits, 'Total visits') +
    stat(t.readings, 'Readings') +
    stat(t.samples, 'Lab samples') +
    '</div>';

  // validation site progress
  var vSites = (prog.sites || []).filter(function (s) { return s.is_validation_site; });
  html += '<div class="card mt12"><h2>Validation progress</h2>' + vSites.map(function (s) {
    var pct = s.readings_target ? Math.min(100, Math.round(s.readings_done * 100 / s.readings_target)) : 0;
    return '<div class="mt8"><div class="row spread"><b>' + esc(s.sub_area) + '</b>' +
      '<span class="small muted">' + s.farms_complete + '/3 farms · ' + s.readings_done + '/' + s.readings_target + ' readings</span></div>' +
      '<div class="pbar' + (pct >= 100 ? ' full' : '') + '"><div style="width:' + pct + '%"></div></div></div>';
  }).join('') + '</div>';

  // team
  html += '<div class="card"><h2>Field team</h2>' + (act.team || []).map(function (m) {
    var initials = m.name.split(/\s+/).map(function (w) { return w[0] || ''; }).join('').slice(0, 2).toUpperCase();
    return '<div class="team-item"><span class="avatar">' + esc(initials) + '</span>' +
      '<span class="site-main"><span class="site-name">' + esc(m.name) +
      (m.role === 'manager' ? ' <span class="chip blue">manager</span>' : '') +
      (!m.active ? ' <span class="chip red">inactive</span>' : '') + '</span>' +
      '<span class="site-meta">' + esc(m.phone) + ' · ' + m.visits + ' visits · last: ' + fmtWhen(m.last_synced_at) +
      (m.last_gps ? ' @ ' + esc(m.last_gps.site) : '') + '</span></span>' +
      '<span class="row" style="gap:6px">' +
      '<button class="btn btn-outline btn-sm" data-pin="' + m.id + '" data-name="' + esc(m.name) + '">PIN</button>' +
      '<button class="btn ' + (m.active ? 'btn-danger-outline' : 'btn-secondary') + ' btn-sm" data-toggle="' + m.id + '" data-active="' + m.active + '" data-name="' + esc(m.name) + '">' +
      (m.active ? 'Off' : 'On') + '</button></span></div>';
  }).join('') +
    '<h3 class="mt12">Add team member</h3>' +
    '<div class="field"><input id="nName" placeholder="Full name"></div>' +
    '<div class="row"><div class="field" style="flex:1"><input id="nPhone" type="tel" placeholder="Phone"></div>' +
    '<div class="field" style="flex:1"><input id="nPin" type="text" inputmode="numeric" placeholder="PIN (4-8 digits)"></div></div>' +
    '<div class="field"><select id="nRole"><option value="supervisor">Field Supervisor</option><option value="manager">Manager</option></select></div>' +
    '<button class="btn btn-primary btn-block" id="btnAddMember">Add member</button>' +
    '</div>';

  // activity feed
  html += '<div class="card"><h2>Recent activity</h2><div class="scroll-x"><table class="dash-table"><thead><tr>' +
    '<th>When</th><th>Who / where</th><th>GPS</th><th>Data</th></tr></thead><tbody>' +
    (act.visits || []).slice(0, 60).map(function (v) {
      var gps = v.gps_lat == null ? '<span class="flag">no GPS</span>'
        : (v.gps_flag ? '<span class="flag">' + fmtDist(v.distance_from_site_m) + ' away ⚠</span>'
                      : fmtDist(v.distance_from_site_m));
      var data = (v.readings_count || 0) + ' readings' +
        (Number(v.out_of_range) ? ' · <span class="flag">' + v.out_of_range + ' out-of-range</span>' : '') +
        (v.sample_collected ? '<br>sample ' + esc(v.sample_id || '✓') : '') +
        (Number(v.photos) ? ' · ' + v.photos + '📷' : '');
      return '<tr><td>' + fmtWhen(v.synced_at) + '</td>' +
        '<td><b>' + esc(v.supervisor) + '</b><br>' + esc(v.site) + (v.farm ? ' · ' + esc(v.farm) : '') + '</td>' +
        '<td>' + gps + '</td><td>' + data + '</td></tr>';
    }).join('') + '</tbody></table></div>' +
    ((act.visits || []).length === 0 ? '<p class="muted small mt8">No synced visits yet.</p>' : '') +
    '</div>';

  el.innerHTML = html;

  $('#btnAddMember').addEventListener('click', function () {
    var name = $('#nName').value.trim(), phone = $('#nPhone').value.trim(), pin = $('#nPin').value.trim();
    var role = $('#nRole').value;
    if (!name || !phone || !pin) { toast('Fill in name, phone and PIN'); return; }
    rpc('fs_add_supervisor', { p_token: S.token, p_name: name, p_phone: phone, p_pin: pin, p_role: role })
      .then(function () { toast(name + ' added'); bindDash(); })
      .catch(function (err) { if (!handleAuthError(err)) toast(err.message); });
  });
  // onclick property: #dashBody persists across bindDash refreshes
  el.onclick = function (e) {
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
window.addEventListener('hashchange', render);
window.addEventListener('online', function () { updateNetDot(); syncAll(); });
window.addEventListener('offline', updateNetDot);
document.addEventListener('visibilitychange', function () {
  if (!document.hidden && S.token) syncAll();
});

loadQueue().catch(function () {}).then(function () {
  if (!location.hash) location.hash = S.token ? '#/home' : '#/login';
  render();
  if (S.token) {
    // refresh cached data, but only re-render passive views — never the visit
    // form, or a late response would wipe readings being typed
    refreshBoot().then(function () {
      var r = (location.hash || '#/home').replace(/^#/, '');
      if (r === '/home' || r === '' || r === '/map') render();
    });
    syncAll();
  }
});
