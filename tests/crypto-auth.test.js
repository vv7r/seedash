'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { encrypt, decrypt, PREFIX } = require('../crypto-config');
const auth = require('../lib/auth');

describe('crypto-config', () => {
  const secret = 'test-jwt-secret-key';

  it('chiffre et déchiffre une valeur (round-trip)', () => {
    const enc = encrypt('my-secret-value', secret);
    assert.ok(enc.startsWith(PREFIX));
    const dec = decrypt(enc, secret);
    assert.strictEqual(dec, 'my-secret-value');
  });

  it('produit un chiffré différent à chaque appel (IV aléatoire)', () => {
    const e1 = encrypt('same-value', secret);
    const e2 = encrypt('same-value', secret);
    assert.notStrictEqual(e1, e2);
  });

  it('retourne la valeur telle quelle si non chiffrée (idempotence)', () => {
    assert.strictEqual(decrypt('plain-text', secret), 'plain-text');
    assert.strictEqual(decrypt('', secret), '');
    assert.strictEqual(decrypt(null, secret), null);
    assert.strictEqual(decrypt(undefined, secret), undefined);
  });

  it('échoue avec une clé incorrecte', () => {
    const enc = encrypt('secret', secret);
    assert.throws(() => decrypt(enc, 'wrong-key'));
  });

  it('gère les valeurs unicode', () => {
    const val = 'pässwörd-éèïü';
    const enc = encrypt(val, secret);
    assert.strictEqual(decrypt(enc, secret), val);
  });

  it('gère les valeurs vides', () => {
    const enc = encrypt('', secret);
    assert.strictEqual(decrypt(enc, secret), '');
  });
});

describe('auth', () => {
  const cfg = { auth: { jwt_secret: 'test-secret-123', username: 'user', password_hash: 'hash', issued_after: 0, setup_completed: true } };

  it('init stocke la référence cfg', () => {
    auth.init(cfg);
    assert.strictEqual(auth.getJwtSecret(), 'test-secret-123');
  });

  it('isSetupComplete retourne true si setup_completed est true', () => {
    auth.init(cfg);
    assert.strictEqual(auth.isSetupComplete(), true);
  });

  it('isSetupComplete retourne false si setup_completed est false', () => {
    auth.init({ auth: { setup_completed: false } });
    assert.strictEqual(auth.isSetupComplete(), false);
  });

  it('isSetupComplete retourne true si setup_completed est absent (installation existante)', () => {
    auth.init({ auth: {} });
    assert.strictEqual(auth.isSetupComplete(), true);
  });

  it('checkBruteForce retourne false pour une IP inconnue', () => {
    auth.init(cfg);
    assert.strictEqual(auth.checkBruteForce('1.2.3.4'), false);
  });

  it('recordFailedLogin + checkBruteForce après 5 tentatives', () => {
    auth.init(cfg);
    const ip = '5.6.7.8';
    for (let i = 0; i < 5; i++) auth.recordFailedLogin(ip);
    assert.strictEqual(auth.checkBruteForce(ip), true);
  });

  it('resetLoginAttempts débloque l\'IP', () => {
    auth.init(cfg);
    const ip = '9.10.11.12';
    for (let i = 0; i < 5; i++) auth.recordFailedLogin(ip);
    assert.strictEqual(auth.checkBruteForce(ip), true);
    auth.resetLoginAttempts(ip);
    assert.strictEqual(auth.checkBruteForce(ip), false);
  });

  it('initAuth génère un jwt_secret si absent', async () => {
    const c = { auth: {} };
    auth.init(c);
    await auth.initAuth(() => {});
    assert.strictEqual(c.auth.jwt_secret.length, 128);
  });

  it('initAuth initialise setup_completed à false au premier démarrage', async () => {
    const c = { auth: { jwt_secret: 'x' } };
    auth.init(c);
    await auth.initAuth(() => {});
    assert.strictEqual(c.auth.setup_completed, false);
  });

  it('decryptSecrets déchiffre les champs chiffrés', () => {
    const c = {
      auth: { jwt_secret: 'test-key' },
      c411: { apikey: encrypt('real-key', 'test-key') },
      qbittorrent: { username: 'admin', password: encrypt('pass', 'test-key') },
      ultracc_api: { url: 'http://x', token: encrypt('tok', 'test-key') },
    };
    auth.init(c);
    auth.decryptSecrets();
    assert.strictEqual(c.c411.apikey, 'real-key');
    assert.strictEqual(c.qbittorrent.password, 'pass');
    assert.strictEqual(c.ultracc_api.token, 'tok');
  });

  it('decryptSecrets est silencieux sans clé JWT', () => {
    auth.init({ auth: {} });
    auth.decryptSecrets();
  });

  it('decryptSecrets met à "" si déchiffrement impossible (clé changée)', () => {
    const c = {
      auth: { jwt_secret: 'new-key' },
      c411: { apikey: encrypt('old-secret', 'old-key') },
      qbittorrent: { username: '', password: '' },
      ultracc_api: { url: '', token: '' },
    };
    auth.init(c);
    auth.decryptSecrets();
    assert.strictEqual(c.c411.apikey, '');
  });
});
