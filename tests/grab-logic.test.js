'use strict';

const { filterCandidates } = require('../lib/grab');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Construit un item C411 minimal. */
function item(infohash, { size = 1e9, leechers = 100, seeders = 10 } = {}) {
  return { infohash, name: `torrent-${infohash}`, link: `http://c411/${infohash}`, size, leechers, seeders };
}

const NO_RULES    = {};
const RULES_ON_ALL = {}; // toutes les clés absentes → actives par défaut
const EMPTY_SET   = new Set();

// ── Tests — Cas de base ──────────────────────────────────────────────────────

describe('filterCandidates — cas de base', () => {

  it('liste vide → résultat vide', () => {
    assert.deepEqual(filterCandidates([], EMPTY_SET, NO_RULES, {}, 10), []);
  });

  it('renvoie tous les items si aucune règle ni filtre', () => {
    const list = [item('aaa'), item('bbb'), item('ccc')];
    const result = filterCandidates(list, EMPTY_SET, NO_RULES, {}, 10);
    assert.equal(result.length, 3);
  });

  it('canGrab=0 → résultat vide', () => {
    const list = [item('aaa'), item('bbb')];
    assert.deepEqual(filterCandidates(list, EMPTY_SET, NO_RULES, {}, 0), []);
  });

});

// ── Tests — Filtre hashes existants ─────────────────────────────────────────

describe('filterCandidates — hashes existants', () => {

  it('exclut les torrents déjà dans qBittorrent', () => {
    const list = [item('aaa'), item('bbb'), item('ccc')];
    const existing = new Set(['aaa', 'ccc']);
    const result = filterCandidates(list, existing, NO_RULES, {}, 10);
    assert.equal(result.length, 1);
    assert.equal(result[0].infohash, 'bbb');
  });

  it('tous présents → résultat vide', () => {
    const list = [item('aaa'), item('bbb')];
    const existing = new Set(['aaa', 'bbb']);
    assert.deepEqual(filterCandidates(list, existing, NO_RULES, {}, 10), []);
  });

  it('aucun présent → tous passent', () => {
    const list = [item('aaa'), item('bbb')];
    assert.equal(filterCandidates(list, EMPTY_SET, NO_RULES, {}, 10).length, 2);
  });

});

// ── Tests — Filtre taille max ────────────────────────────────────────────────

describe('filterCandidates — size_max_gb', () => {

  it('exclut les torrents plus lourds que size_max_gb', () => {
    const list = [
      item('small', { size: 2e9 }),   // 2 GB
      item('large', { size: 15e9 }),  // 15 GB
    ];
    const rules   = { size_max_gb: 10 };
    const rulesOn = {};
    const result = filterCandidates(list, EMPTY_SET, rules, rulesOn, 10);
    assert.equal(result.length, 1);
    assert.equal(result[0].infohash, 'small');
  });

  it('accepte un torrent exactement à la limite', () => {
    const list = [item('exact', { size: 10e9 })]; // exactement 10 GB
    const result = filterCandidates(list, EMPTY_SET, { size_max_gb: 10 }, {}, 10);
    assert.equal(result.length, 1);
  });

  it('size_max_gb désactivé → pas de filtre taille', () => {
    const list = [item('huge', { size: 999e9 })];
    const rulesOn = { size_max_gb: false };
    const result = filterCandidates(list, EMPTY_SET, { size_max_gb: 10 }, rulesOn, 10);
    assert.equal(result.length, 1);
  });

  it('size_max_gb=0 → traité comme inactif (pas de filtre)', () => {
    const list = [item('big', { size: 50e9 })];
    const result = filterCandidates(list, EMPTY_SET, { size_max_gb: 0 }, {}, 10);
    assert.equal(result.length, 1);
  });

});

// ── Tests — Filtre leechers / seeders min ────────────────────────────────────

describe('filterCandidates — min_leechers / min_seeders', () => {

  it('exclut les torrents avec trop peu de leechers', () => {
    const list = [
      item('popular',  { leechers: 200 }),
      item('unpopular', { leechers: 2 }),
    ];
    const result = filterCandidates(list, EMPTY_SET, { min_leechers: 10 }, {}, 10);
    assert.equal(result.length, 1);
    assert.equal(result[0].infohash, 'popular');
  });

  it('min_leechers désactivé → pas de filtre leechers', () => {
    const list = [item('low', { leechers: 1 })];
    const rulesOn = { min_leechers: false };
    assert.equal(filterCandidates(list, EMPTY_SET, { min_leechers: 100 }, rulesOn, 10).length, 1);
  });

  it('min_leechers=null → pas de filtre leechers', () => {
    const list = [item('low', { leechers: 0 })];
    assert.equal(filterCandidates(list, EMPTY_SET, { min_leechers: null }, {}, 10).length, 1);
  });

  it('exclut les torrents avec trop peu de seeders', () => {
    const list = [
      item('seeded',   { seeders: 50 }),
      item('unseeded', { seeders: 0 }),
    ];
    const result = filterCandidates(list, EMPTY_SET, { min_seeders: 5 }, {}, 10);
    assert.equal(result.length, 1);
    assert.equal(result[0].infohash, 'seeded');
  });

  it('min_seeders désactivé → pas de filtre seeders', () => {
    const list = [item('bare', { seeders: 0 })];
    const rulesOn = { min_seeders: false };
    assert.equal(filterCandidates(list, EMPTY_SET, { min_seeders: 50 }, rulesOn, 10).length, 1);
  });

  it('leechers exactement au seuil minimum → accepté', () => {
    const list = [item('border', { leechers: 10 })];
    assert.equal(filterCandidates(list, EMPTY_SET, { min_leechers: 10 }, {}, 10).length, 1);
  });

});

// ── Tests — Tri et limite canGrab ────────────────────────────────────────────

describe('filterCandidates — tri et canGrab', () => {

  it('résultat trié par leechers décroissant', () => {
    const list = [
      item('c', { leechers: 50 }),
      item('a', { leechers: 200 }),
      item('b', { leechers: 100 }),
    ];
    const result = filterCandidates(list, EMPTY_SET, NO_RULES, {}, 10);
    assert.deepEqual(result.map(t => t.infohash), ['a', 'b', 'c']);
  });

  it('canGrab limite le nombre de résultats', () => {
    const list = [item('a', { leechers: 300 }), item('b', { leechers: 200 }), item('c', { leechers: 100 })];
    const result = filterCandidates(list, EMPTY_SET, NO_RULES, {}, 2);
    assert.equal(result.length, 2);
    assert.equal(result[0].infohash, 'a'); // top leechers en premier
    assert.equal(result[1].infohash, 'b');
  });

  it('canGrab supérieur à la liste → renvoie tout', () => {
    const list = [item('a'), item('b')];
    assert.equal(filterCandidates(list, EMPTY_SET, NO_RULES, {}, 100).length, 2);
  });

});

// ── Tests — Combinaisons ─────────────────────────────────────────────────────

describe('filterCandidates — combinaisons de filtres', () => {

  it('hashes existants + taille + leechers + canGrab', () => {
    const list = [
      item('exists',   { size: 2e9,  leechers: 500 }), // déjà présent
      item('toolarge', { size: 20e9, leechers: 400 }), // trop lourd
      item('fewleech', { size: 2e9,  leechers: 2   }), // trop peu de leechers
      item('ok1',      { size: 2e9,  leechers: 300 }), // ✓
      item('ok2',      { size: 2e9,  leechers: 200 }), // ✓
      item('ok3',      { size: 2e9,  leechers: 100 }), // ✓ mais canGrab=2
    ];
    const existing = new Set(['exists']);
    const rules    = { size_max_gb: 10, min_leechers: 10 };
    const result   = filterCandidates(list, existing, rules, {}, 2);
    assert.equal(result.length, 2);
    assert.equal(result[0].infohash, 'ok1');
    assert.equal(result[1].infohash, 'ok2');
  });

});
