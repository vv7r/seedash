'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const { spawn } = require('child_process');

const QBIT_URL = 'http://127.0.0.1:8080';
const C411_URL = 'http://127.0.0.1:8081/api/torznab';
const ULTRACC_URL = 'http://127.0.0.1:8082/ultra-api/total-stats';

let mockProc;
let tmpDir;

// ── qBittorrent client (parle au mock) ─────────────────────────────────────
let qbitCookies = '';

async function qbitLogin() {
  const r = await axios.post(`${QBIT_URL}/api/v2/auth/login`,
    'username=admin&password=admin', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  qbitCookies = r.headers['set-cookie']?.[0]?.split(';')[0] || '';
}

async function qbitRequest(method, url, body) {
  const headers = qbitCookies ? { Cookie: qbitCookies } : {};
  if (method === 'get') {
    const r = await axios.get(`${QBIT_URL}/api/v2${url}`, { headers });
    return r.data;
  }
  const r = await axios.post(`${QBIT_URL}/api/v2${url}`, body, {
    headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  return r.data;
}

async function resetMock() {
  await axios.post(`${QBIT_URL}/api/v2/torrents/reset`, '', {
    headers: qbitCookies ? { Cookie: qbitCookies } : {},
  });
}

// ── Ultra.cc helper ─────────────────────────────────────────────────────────
async function getUltraccInfo() {
  const r = await axios.get(ULTRACC_URL);
  const s = r.data.service_stats_info;
  return {
    free_storage_gb: (s.disk_quota_bytes - s.disk_used_bytes) / 1e9,
    traffic_used_pct: (s.monthly_download_bytes / s.monthly_quota_bytes) * 100,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function writeJson(p, obj) {
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

function readCfg() {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json')));
}
function writeCfg(cfg) {
  writeJson(path.join(tmpDir, 'config.json'), cfg);
}

// ── Setup ───────────────────────────────────────────────────────────────────
before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seedash-test-'));
  const logDir = path.join(tmpDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });

  writeJson(path.join(tmpDir, 'config.json'), {
    auto_clean: { enabled: false, delete_files: false, rules: {}, rules_on: {} },
    auto_grab:  { enabled: false, rules: {}, rules_on: {}, last_run: null, last_grab_count: 0 },
    c411:       { url: C411_URL, apikey: 'mock' },
    qbittorrent:{ url: QBIT_URL, username: 'admin', password: 'admin' },
  });

  mockProc = spawn(process.execPath, [path.join(__dirname, 'mock-api.js')], {
    stdio: 'ignore',
    detached: false,
  });

  for (let i = 0; i < 30; i++) {
    try {
      await axios.get(`${QBIT_URL}/api/v2/transfer/info`, { timeout: 500 });
      break;
    } catch {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  await qbitLogin();
});

after(() => {
  if (mockProc) mockProc.kill('SIGTERM');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── runClean — différentes règles ──────────────────────────────────────────

describe('runClean — règles auto-clean', () => {

  beforeEach(async () => {
    await resetMock();
    writeJson(path.join(tmpDir, 'logs', 'excluded.json'), {});
    writeJson(path.join(tmpDir, 'logs', 'upload-history.json'), {});
  });

  function setupCleaner() {
    const cleaner = require('../lib/cleaner');
    cleaner.init({
      cfgPath:  path.join(tmpDir, 'config.json'),
      connPath: path.join(tmpDir, 'config.json'),
      logDir:   path.join(tmpDir, 'logs'),
    });
    cleaner.initQbit(qbitRequest);
    return cleaner;
  }

  it('ratio_min seul actif — supprime les torrents avec ratio ≥ seuil', async () => {
    const cfg = readCfg();
    cfg.auto_clean = {
      enabled: true,
      delete_files: false,
      rules: { ratio_min: 1.5, ratio_max: 5, age_min_hours: 48, age_max_hours: 336, upload_min_mb: 500, upload_window_hours: 48 },
      rules_on: { ratio_min: true, ratio_max: false, age_min_hours: false, age_max_hours: false, upload_min_mb: false },
    };
    writeCfg(cfg);

    const cleaner = setupCleaner();
    const deleted = await cleaner.runClean('test');
    assert.equal(deleted, 2);
  });

  it('age_min_hours seul actif — supprime les torrents anciens', async () => {
    const cfg = readCfg();
    cfg.auto_clean = {
      enabled: true,
      delete_files: false,
      rules: { ratio_min: 1, ratio_max: 5, age_min_hours: 24, age_max_hours: 336, upload_min_mb: 500, upload_window_hours: 48 },
      rules_on: { ratio_min: false, ratio_max: false, age_min_hours: true, age_max_hours: false, upload_min_mb: false },
    };
    writeCfg(cfg);

    const cleaner = setupCleaner();
    const deleted = await cleaner.runClean('test');
    assert.equal(deleted, 2);
  });

  it('ratio_min + age_min (ET) — supprime seulement si les deux conditions sont ok', async () => {
    const cfg = readCfg();
    cfg.auto_clean = {
      enabled: true,
      delete_files: false,
      rules: { ratio_min: 1.5, ratio_max: 5, age_min_hours: 36, age_max_hours: 336, upload_min_mb: 500, upload_window_hours: 48 },
      rules_on: { ratio_min: true, ratio_max: false, age_min_hours: true, age_max_hours: false, upload_min_mb: false },
    };
    writeCfg(cfg);

    const cleaner = setupCleaner();
    const deleted = await cleaner.runClean('test');
    assert.equal(deleted, 2);
  });

  it('ratio_max seul actif (OU) — supprime si ratio ≥ max même si min non atteint', async () => {
    const cfg = readCfg();
    cfg.auto_clean = {
      enabled: true,
      delete_files: false,
      rules: { ratio_min: 5, ratio_max: 2.0, age_min_hours: 100, age_max_hours: 336, upload_min_mb: 500, upload_window_hours: 48 },
      rules_on: { ratio_min: true, ratio_max: true, age_min_hours: true, age_max_hours: false, upload_min_mb: false },
    };
    writeCfg(cfg);

    const cleaner = setupCleaner();
    const deleted = await cleaner.runClean('test');
    assert.equal(deleted, 1);
  });

  it('aucune règle active → rien n\'est supprimé', async () => {
    const cfg = readCfg();
    cfg.auto_clean = {
      enabled: true,
      delete_files: false,
      rules: { ratio_min: 1.0, ratio_max: 5.0, age_min_hours: 48, age_max_hours: 336, upload_min_mb: 500, upload_window_hours: 48 },
      rules_on: { ratio_min: false, ratio_max: false, age_min_hours: false, age_max_hours: false, upload_min_mb: false },
    };
    writeCfg(cfg);

    const cleaner = setupCleaner();
    const deleted = await cleaner.runClean('test');
    assert.equal(deleted, 0);
  });

  it('excluded.json protège les torrents de la suppression', async () => {
    const cfg = readCfg();
    cfg.auto_clean = {
      enabled: true,
      delete_files: false,
      rules: { ratio_min: 1.0, ratio_max: 5, age_min_hours: 1, age_max_hours: 336, upload_min_mb: 500, upload_window_hours: 48 },
      rules_on: { ratio_min: true, age_min_hours: true, ratio_max: false, age_max_hours: false, upload_min_mb: false },
    };
    writeCfg(cfg);

    const torrents = await qbitRequest('get', '/torrents/info');
    writeJson(path.join(tmpDir, 'logs', 'excluded.json'), { [torrents[0].hash.toLowerCase()]: true });

    const cleaner = setupCleaner();
    const deleted = await cleaner.runClean('test');
    assert.equal(deleted, 1);
  });

  it('upload_min_mb actif — ne supprime que si upload faible sur la fenêtre', async () => {
    const cfg = readCfg();
    cfg.auto_clean = {
      enabled: true,
      delete_files: false,
      rules: { ratio_min: 1, ratio_max: 5, age_min_hours: 48, age_max_hours: 336, upload_min_mb: 100, upload_window_hours: 24 },
      rules_on: { ratio_min: false, age_min_hours: false, age_max_hours: false, upload_min_mb: true },
    };
    writeCfg(cfg);

    const torrents = await qbitRequest('get', '/torrents/info');
    const now = Math.floor(Date.now() / 1000);
    const winStart = now - 24 * 3600;

    const hist = {
      [torrents[0].hash.toLowerCase()]: [[winStart - 100, 0], [winStart + 100, 0], [now, 50e6]],
      [torrents[2].hash.toLowerCase()]: [[winStart - 100, 0], [winStart + 100, 0], [now, 200e6]],
    };
    writeJson(path.join(tmpDir, 'logs', 'upload-history.json'), hist);

    const cleaner = setupCleaner();
    const deleted = await cleaner.runClean('test');
    assert.equal(deleted, 1);
  });

  it('toutes les règles actives (ET min + OU max) — comportement complet', async () => {
    const cfg = readCfg();
    cfg.auto_clean = {
      enabled: true,
      delete_files: false,
      rules: { ratio_min: 1.5, ratio_max: 3.0, age_min_hours: 36, age_max_hours: 100, upload_min_mb: 500, upload_window_hours: 48 },
      rules_on: { ratio_min: true, ratio_max: true, age_min_hours: true, age_max_hours: true, upload_min_mb: false },
    };
    writeCfg(cfg);

    const cleaner = setupCleaner();
    const deleted = await cleaner.runClean('test');
    assert.equal(deleted, 2);
  });
});

// ── runAutoGrab — différentes règles ───────────────────────────────────────

describe('runAutoGrab — règles auto-grab', () => {

  beforeEach(async () => {
    await resetMock();
    writeJson(path.join(tmpDir, 'logs', 'top-cache.json'), { items: [], date: '' });
    writeJson(path.join(tmpDir, 'logs', 'namemap.json'), {});
    const grab = require('../lib/grab');
    grab.resetStatus();
  });

  function setupGrab(rules, rulesOn) {
    const cfg = readCfg();
    cfg.auto_grab = {
      enabled: true,
      rules,
      rules_on: rulesOn,
      last_run: null,
      last_grab_count: 0,
    };
    cfg.c411 = { url: C411_URL, apikey: 'mock' };
    cfg.qbittorrent = { url: QBIT_URL, username: 'admin', password: 'admin' };
    writeCfg(cfg);

    const grab = require('../lib/grab');
    const maps = { nameMap: {}, categoryMap: {} };
    const logDir = path.join(tmpDir, 'logs');
    const fns = {
      getTopCache: () => JSON.parse(fs.readFileSync(path.join(logDir, 'top-cache.json'))),
      setTopCache: (c) => writeJson(path.join(logDir, 'top-cache.json'), c),
      saveCfg: () => writeCfg(readCfg()),
      saveNameMap: () => {},
      saveCategoryMap: () => {},
      appendTorrentList: () => {},
      appendHistory: () => {},
      qbitRequest,
      getUltraccInfo,
      isCleanRunning: () => false,
    };
    grab.init(cfg, maps, fns, path.join(logDir, 'top-cache.json'), logDir);
    return grab;
  }

  it('grab_limit_per_day=0 → aucun grab', async () => {
    const grab = setupGrab(
      { grab_limit_per_day: 0, active_max: 0, size_max_gb: 0, min_leechers: 0, min_seeders: 0, network_max_pct: 0 },
      { grab_limit_per_day: true, active_max: false, size_max_gb: false, min_leechers: false, min_seeders: false, network_max_pct: false },
    );
    const grabbed = await grab.runAutoGrab('test');
    assert.equal(grabbed, 0);
  });

  it('size_max_gb filtre les gros torrents', async () => {
    const grab = setupGrab(
      { grab_limit_per_day: 10, active_max: 0, size_max_gb: 3, min_leechers: 0, min_seeders: 0, network_max_pct: 0 },
      { grab_limit_per_day: true, active_max: false, size_max_gb: true, min_leechers: false, min_seeders: false, network_max_pct: false },
    );
    const before = (await qbitRequest('get', '/torrents/info')).length;
    const grabbed = await grab.runAutoGrab('test');
    const after = (await qbitRequest('get', '/torrents/info')).length;
    assert.equal(grabbed, 2);
    assert.equal(after, before + 2);
  });

  it('min_leechers filtre les torrents sans audience', async () => {
    const grab = setupGrab(
      { grab_limit_per_day: 10, active_max: 0, size_max_gb: 0, min_leechers: 10, min_seeders: 0, network_max_pct: 0 },
      { grab_limit_per_day: true, active_max: false, size_max_gb: false, min_leechers: true, min_seeders: false, network_max_pct: false },
    );
    const before = (await qbitRequest('get', '/torrents/info')).length;
    const grabbed = await grab.runAutoGrab('test');
    const after = (await qbitRequest('get', '/torrents/info')).length;
    assert.equal(grabbed, 2);
    assert.equal(after, before + 2);
  });

  it('active_max limite le nombre de torrents actifs', async () => {
    const grab = setupGrab(
      { grab_limit_per_day: 10, active_max: 1, size_max_gb: 0, min_leechers: 0, min_seeders: 0, network_max_pct: 0 },
      { grab_limit_per_day: true, active_max: true, size_max_gb: false, min_leechers: false, min_seeders: false, network_max_pct: false },
    );
    const grabbed = await grab.runAutoGrab('test');
    assert.equal(grabbed, 0);
  });

  it('network_max_pct bloque si le trafic est trop élevé', async () => {
    const grab = setupGrab(
      { grab_limit_per_day: 10, active_max: 0, size_max_gb: 0, min_leechers: 0, min_seeders: 0, network_max_pct: 5 },
      { grab_limit_per_day: true, active_max: false, size_max_gb: false, min_leechers: false, min_seeders: false, network_max_pct: true },
    );
    const grabbed = await grab.runAutoGrab('test');
    assert.equal(grabbed, 0);
  });

  it('network_max_pct désactivé → grab passe même avec trafic élevé', async () => {
    const grab = setupGrab(
      { grab_limit_per_day: 10, active_max: 0, size_max_gb: 0, min_leechers: 0, min_seeders: 0, network_max_pct: 5 },
      { grab_limit_per_day: true, active_max: false, size_max_gb: false, min_leechers: false, min_seeders: false, network_max_pct: false },
    );
    const before = (await qbitRequest('get', '/torrents/info')).length;
    const grabbed = await grab.runAutoGrab('test');
    const after = (await qbitRequest('get', '/torrents/info')).length;
    assert.equal(grabbed, 4);
    assert.equal(after, before + 4);
  });

  it('combinaison size_max + min_leechers + canGrab', async () => {
    const grab = setupGrab(
      { grab_limit_per_day: 2, active_max: 0, size_max_gb: 3, min_leechers: 5, min_seeders: 0, network_max_pct: 0 },
      { grab_limit_per_day: true, active_max: false, size_max_gb: true, min_leechers: true, min_seeders: false, network_max_pct: false },
    );
    const before = (await qbitRequest('get', '/torrents/info')).length;
    const grabbed = await grab.runAutoGrab('test');
    const after = (await qbitRequest('get', '/torrents/info')).length;
    assert.equal(grabbed, 2);
    assert.equal(after, before + 2);
  });
});

// ── Cycle complet : clean puis grab ─────────────────────────────────────────

describe('Cycle complet — clean + grab avec règles', () => {

  beforeEach(async () => {
    await resetMock();
    writeJson(path.join(tmpDir, 'logs', 'excluded.json'), {});
    writeJson(path.join(tmpDir, 'logs', 'upload-history.json'), {});
    writeJson(path.join(tmpDir, 'logs', 'top-cache.json'), { items: [], date: '' });
    writeJson(path.join(tmpDir, 'logs', 'namemap.json'), {});
    const grab = require('../lib/grab');
    grab.resetStatus();
  });

  it('clean supprime puis grab remplace avec les nouvelles règles', async () => {
    const cfg = readCfg();
    cfg.auto_clean = {
      enabled: true,
      delete_files: false,
      rules: { ratio_min: 2.0, ratio_max: 5, age_min_hours: 1, age_max_hours: 336, upload_min_mb: 500, upload_window_hours: 48 },
      rules_on: { ratio_min: true, age_min_hours: true, ratio_max: false, age_max_hours: false, upload_min_mb: false },
    };
    cfg.auto_grab = {
      enabled: true,
      rules: { grab_limit_per_day: 5, active_max: 0, size_max_gb: 0, min_leechers: 0, min_seeders: 0, network_max_pct: 0 },
      rules_on: { grab_limit_per_day: true, active_max: false, size_max_gb: false, min_leechers: false, min_seeders: false, network_max_pct: false },
      last_run: null,
      last_grab_count: 0,
    };
    cfg.c411 = { url: C411_URL, apikey: 'mock' };
    cfg.qbittorrent = { url: QBIT_URL, username: 'admin', password: 'admin' };
    writeCfg(cfg);

    const cleaner = require('../lib/cleaner');
    cleaner.init({
      cfgPath:  path.join(tmpDir, 'config.json'),
      connPath: path.join(tmpDir, 'config.json'),
      logDir:   path.join(tmpDir, 'logs'),
    });
    cleaner.initQbit(qbitRequest);
    const deleted = await cleaner.runClean('test');
    assert.equal(deleted, 1);

    const grab = require('../lib/grab');
    const maps = { nameMap: {}, categoryMap: {} };
    const logDir = path.join(tmpDir, 'logs');
    const fns = {
      getTopCache: () => JSON.parse(fs.readFileSync(path.join(logDir, 'top-cache.json'))),
      setTopCache: (c) => writeJson(path.join(logDir, 'top-cache.json'), c),
      saveCfg: () => writeCfg(readCfg()),
      saveNameMap: () => {},
      saveCategoryMap: () => {},
      appendTorrentList: () => {},
      appendHistory: () => {},
      qbitRequest,
      getUltraccInfo,
      isCleanRunning: () => false,
    };
    grab.init(cfg, maps, fns, path.join(logDir, 'top-cache.json'), logDir);

    const before = (await qbitRequest('get', '/torrents/info')).length;
    const grabbed = await grab.runAutoGrab('test');
    const after = (await qbitRequest('get', '/torrents/info')).length;
    assert.equal(grabbed, 5);
    assert.equal(after, before + 5);
  });
});
