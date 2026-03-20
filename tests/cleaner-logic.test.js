'use strict';

// Désactiver le timer auto-clean dès le require pour éviter qu'il bloque le process
const cleaner = require('../lib/cleaner');
cleaner.reschedule(null, false);

const { shouldDelete } = cleaner;
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ── Fixtures ────────────────────────────────────────────────────────────────
const NOW = 1_000_000; // timestamp Unix fixe en secondes

/** Construit un torrent minimaliste. age_sec = secondes écoulées depuis l'ajout. */
function torrent(hash, ratio, age_sec) {
  return { hash, ratio, added_on: NOW - age_sec };
}

/** Règles minimales par défaut (ratio_min=1.0, age_min=48h actifs, tout le reste off). */
const DEFAULT_RULES = {
  ratio_min:          1.0,
  ratio_max:          5.0,
  age_min_hours:      48,
  age_max_hours:      336,   // 14j
  upload_min_mb:      500,
  upload_window_hours: 48,
};

const ALL_ON   = {};                          // toutes les clés absentes → actives
const ONLY_MIN = {                            // ratio_max, age_max, upload_min désactivés
  ratio_max:    false,
  age_max_hours: false,
  upload_min_mb: false,
};

// ── Tests — Condition minimale (ET logique) ──────────────────────────────────

describe('shouldDelete — condition minimale', () => {

  it('supprime si ratio ≥ ratio_min ET âge ≥ age_min (règles min seulement)', () => {
    const t = torrent('aaa', 1.5, 50 * 3600); // ratio 1.5, âge 50h
    assert.equal(shouldDelete(t, DEFAULT_RULES, ONLY_MIN, {}, NOW), true);
  });

  it('ne supprime PAS si ratio < ratio_min', () => {
    const t = torrent('bbb', 0.8, 50 * 3600);
    assert.equal(shouldDelete(t, DEFAULT_RULES, ONLY_MIN, {}, NOW), false);
  });

  it('ne supprime PAS si âge < age_min', () => {
    const t = torrent('ccc', 2.0, 10 * 3600); // seulement 10h
    assert.equal(shouldDelete(t, DEFAULT_RULES, ONLY_MIN, {}, NOW), false);
  });

  it('ne supprime PAS si ratio ok mais âge insuffisant', () => {
    const t = torrent('ddd', 1.5, 24 * 3600); // âge=24h < min=48h
    assert.equal(shouldDelete(t, DEFAULT_RULES, ONLY_MIN, {}, NOW), false);
  });

  it('ne supprime JAMAIS si aucune règle min active (normalCondition=false)', () => {
    // Toutes les règles (min ET max) sont désactivées → rien ne déclenche la suppression
    const t = torrent('eee', 1.5, 50 * 3600);
    const rulesOn = { ratio_min: false, age_min_hours: false, upload_min_mb: false, ratio_max: false, age_max_hours: false };
    assert.equal(shouldDelete(t, DEFAULT_RULES, rulesOn, {}, NOW), false);
  });

  it('ratio_min désactivé → ratioCheck=true, décision porte uniquement sur âge', () => {
    const t = torrent('fff', 0.01, 50 * 3600); // ratio très faible mais âge ok
    const rulesOn = { ...ONLY_MIN, ratio_min: false };
    assert.equal(shouldDelete(t, DEFAULT_RULES, rulesOn, {}, NOW), true);
  });

  it('age_min désactivé → ageCheck=true, décision porte uniquement sur ratio', () => {
    const t = torrent('ggg', 1.5, 1 * 3600); // âge=1h seulement mais ratio ok
    const rulesOn = { ...ONLY_MIN, age_min_hours: false };
    assert.equal(shouldDelete(t, DEFAULT_RULES, rulesOn, {}, NOW), true);
  });

});

// ── Tests — Seuils maximaux (OU indépendant) ─────────────────────────────────

describe('shouldDelete — seuils maximaux', () => {

  it('ratio_max déclenche la suppression même si ratio_min non atteint', () => {
    const t = torrent('hhh', 6.0, 10 * 3600); // ratio=6>max=5, âge insuffisant
    assert.equal(shouldDelete(t, DEFAULT_RULES, ALL_ON, {}, NOW), true);
  });

  it('age_max déclenche la suppression même si ratio insuffisant', () => {
    const t = torrent('iii', 0.1, 400 * 3600); // âge=400h>max=336h, ratio faible
    assert.equal(shouldDelete(t, DEFAULT_RULES, ALL_ON, {}, NOW), true);
  });

  it('ratio_max désactivé → ne déclenche pas', () => {
    const t = torrent('jjj', 99.0, 10 * 3600);
    const rulesOn = { ratio_max: false, age_max_hours: false, upload_min_mb: false };
    assert.equal(shouldDelete(t, DEFAULT_RULES, rulesOn, {}, NOW), false);
  });

  it('age_max désactivé → ne déclenche pas', () => {
    const t = torrent('kkk', 0.1, 10000 * 3600);
    const rulesOn = { ratio_max: false, age_max_hours: false, upload_min_mb: false };
    assert.equal(shouldDelete(t, DEFAULT_RULES, rulesOn, {}, NOW), false);
  });

  it('ratio_max exactement atteint → supprimé', () => {
    const t = torrent('lll', 5.0, 10 * 3600); // ratio = max exact
    assert.equal(shouldDelete(t, DEFAULT_RULES, ALL_ON, {}, NOW), true);
  });

  it('ratio juste en dessous de ratio_max → non déclenché par max', () => {
    const t = torrent('mmm', 4.99, 10 * 3600);
    const rulesOn = { age_max_hours: false, upload_min_mb: false }; // ratio_min actif
    // ratio 4.99 ≥ ratio_min=1.0 mais âge=10h < age_min=48h → normalCondition=false
    assert.equal(shouldDelete(t, DEFAULT_RULES, rulesOn, {}, NOW), false);
  });

});

// ── Tests — Règle upload_min_mb ──────────────────────────────────────────────

describe('shouldDelete — règle upload_min_mb', () => {

  const WIN_SEC   = 48 * 3600;       // fenêtre = 48h
  const WIN_START = NOW - WIN_SEC;   // timestamp de début de fenêtre

  /**
   * Construit un historique d'upload avec 3 points :
   * - 1 point AVANT win_start (couvre la fenêtre)
   * - 2 points DANS la fenêtre (satisfait inWin.length >= 2)
   * @param {string} hash
   * @param {number} deltaMb - Upload total dans la fenêtre (du 2e au 3e point)
   */
  function uploadHistory(hash, deltaMb) {
    return {
      [hash.toLowerCase()]: [
        [WIN_START - 100,        0              ],  // avant la fenêtre → couvre
        [WIN_START + 100,        0              ],  // dans la fenêtre (point 1)
        [NOW,                    deltaMb * 1e6  ],  // dans la fenêtre (point 2)
      ],
    };
  }

  it('supprime si upload < seuil ET historique couvre la fenêtre', () => {
    const t    = torrent('uuu', 2.0, 50 * 3600);
    const hist = uploadHistory('uuu', 200); // 200 MB < 500 MB
    const rulesOn = { ratio_max: false, age_max_hours: false };
    assert.equal(shouldDelete(t, DEFAULT_RULES, rulesOn, hist, NOW), true);
  });

  it('ne supprime PAS si upload ≥ seuil', () => {
    const t    = torrent('vvv', 2.0, 50 * 3600);
    const hist = uploadHistory('vvv', 600); // 600 MB ≥ 500 MB
    const rulesOn = { ratio_max: false, age_max_hours: false };
    assert.equal(shouldDelete(t, DEFAULT_RULES, rulesOn, hist, NOW), false);
  });

  it('ne supprime PAS si historique ne couvre pas la fenêtre (premier point trop récent)', () => {
    const t = torrent('www', 2.0, 50 * 3600);
    // Premier point APRÈS win_start → fenêtre non couverte
    const hist = { 'www': [[WIN_START + 100, 0], [NOW, 200 * 1e6]] };
    const rulesOn = { ratio_max: false, age_max_hours: false };
    assert.equal(shouldDelete(t, DEFAULT_RULES, rulesOn, hist, NOW), false);
  });

  it('ne supprime PAS si moins de 2 points dans la fenêtre', () => {
    const t = torrent('xxx', 2.0, 50 * 3600);
    // Un seul point dans la fenêtre
    const hist = { 'xxx': [[WIN_START - 100, 0], [WIN_START - 50, 200 * 1e6]] };
    // Les deux points sont antérieurs à win_start → inWin vide
    const rulesOn = { ratio_max: false, age_max_hours: false };
    assert.equal(shouldDelete(t, DEFAULT_RULES, rulesOn, hist, NOW), false);
  });

  it('ne supprime PAS si hash absent de l\'historique (historique vide)', () => {
    const t = torrent('yyy', 2.0, 50 * 3600);
    const rulesOn = { ratio_max: false, age_max_hours: false };
    assert.equal(shouldDelete(t, DEFAULT_RULES, rulesOn, {}, NOW), false);
  });

  it('upload_min_mb désactivé → uploadCheck=true, seule la condition ratio+âge compte', () => {
    const t = torrent('zzz', 2.0, 50 * 3600); // ratio et âge ok
    const rulesOn = { ratio_max: false, age_max_hours: false, upload_min_mb: false };
    assert.equal(shouldDelete(t, DEFAULT_RULES, rulesOn, {}, NOW), true);
  });

  it('hash en majuscules dans le torrent → lookup insensible à la casse', () => {
    const t    = torrent('ABCDEF', 2.0, 50 * 3600);
    const hist = uploadHistory('abcdef', 200); // clé lowercase, 200 MB < 500 MB
    const rulesOn = { ratio_max: false, age_max_hours: false };
    assert.equal(shouldDelete(t, DEFAULT_RULES, rulesOn, hist, NOW), true);
  });

});

// ── Tests — Combinaisons et cas limites ──────────────────────────────────────

describe('shouldDelete — cas limites', () => {

  it('toutes règles actives : max override les mins non satisfaites', () => {
    const t = torrent('edge1', 0.1, 400 * 3600); // ratio faible mais âge>max
    assert.equal(shouldDelete(t, DEFAULT_RULES, ALL_ON, {}, NOW), true);
  });

  it('torrent à ratio=0 avec age_min seule active → supprimé si âge ok', () => {
    const t = torrent('edge2', 0.0, 50 * 3600);
    const rulesOn = { ratio_min: false, ratio_max: false, age_max_hours: false, upload_min_mb: false };
    assert.equal(shouldDelete(t, DEFAULT_RULES, rulesOn, {}, NOW), true);
  });

  it('règles nulles/undefined → pas de suppression (pas de crash)', () => {
    const t = torrent('edge3', 1.5, 50 * 3600);
    assert.equal(shouldDelete(t, {}, {}, {}, NOW), false);
  });

  it('added_on dans le futur → âge négatif → normalCondition false', () => {
    const t = torrent('edge4', 2.0, -3600); // added_on dans le futur
    assert.equal(shouldDelete(t, DEFAULT_RULES, ONLY_MIN, {}, NOW), false);
  });

});
