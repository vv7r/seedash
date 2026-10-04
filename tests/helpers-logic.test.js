'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { isSafeUrl, getIn, setIn, maskSecret, checkUploadCondition } = require('../lib/helpers');

describe('isSafeUrl', () => {
  it('accepte une URL http valide', () => {
    assert.strictEqual(isSafeUrl('http://127.0.0.1:8080'), true);
  });

  it('accepte une URL https valide', () => {
    assert.strictEqual(isSafeUrl('https://c411.cc'), true);
  });

  it("rejette une URL non-http", () => {
    assert.strictEqual(isSafeUrl('ftp://example.com'), false);
  });

  it('rejette une chaîne non-URL', () => {
    assert.strictEqual(isSafeUrl('not-a-url'), false);
  });

  it('rejette 0.0.0.0', () => {
    assert.strictEqual(isSafeUrl('http://0.0.0.0:8080'), false);
  });

  it('rejette l\'IP metadata cloud 169.254.169.254', () => {
    assert.strictEqual(isSafeUrl('http://169.254.169.254/latest/meta-data/'), false);
  });

  it('rejette toute IP dans 169.254.x.x', () => {
    assert.strictEqual(isSafeUrl('http://169.254.0.1'), false);
    assert.strictEqual(isSafeUrl('http://169.254.255.255'), false);
  });

  it("n'affecte pas les IPs privées légitimes (10.x, 192.168.x)", () => {
    assert.strictEqual(isSafeUrl('http://10.0.0.1:8080'), true);
    assert.strictEqual(isSafeUrl('http://192.168.1.1:8080'), true);
  });

  it('rejette le hostname localhost', () => {
    assert.strictEqual(isSafeUrl('http://localhost:8080'), false);
    assert.strictEqual(isSafeUrl('http://LOCALHOST:8080'), false);
  });

  it('rejette le hostname metadata', () => {
    assert.strictEqual(isSafeUrl('http://metadata/latest/meta-data/'), false);
    assert.strictEqual(isSafeUrl('http://METADATA/latest/meta-data/'), false);
  });

  it('accepte les hostname (non IP)', () => {
    assert.strictEqual(isSafeUrl('https://example.com'), true);
  });

  it('rejette ::1 (loopback IPv6)', () => {
    assert.strictEqual(isSafeUrl('http://[::1]:8080'), false);
  });

  it('rejette :: (unspecified IPv6)', () => {
    assert.strictEqual(isSafeUrl('http://[::]:8080'), false);
  });

  it('rejette le link-local IPv6 fe80::', () => {
    assert.strictEqual(isSafeUrl('http://[fe80::1]:8080'), false);
    assert.strictEqual(isSafeUrl('http://[fe80::abcd:1234]:8080'), false);
  });

  it('rejette le link-local IPv6 fe90–febf (complément fe80::/10)', () => {
    assert.strictEqual(isSafeUrl('http://[fe90::1]:8080'), false);
    assert.strictEqual(isSafeUrl('http://[febf::1]:8080'), false);
    assert.strictEqual(isSafeUrl('http://[fe8f::1]:8080'), false);
  });

  it('rejette l\'IPv4-mapped IPv6 vers metadata ::ffff:169.254.x.x', () => {
    assert.strictEqual(isSafeUrl('http://[::ffff:169.254.169.254]/latest/meta-data/'), false);
    assert.strictEqual(isSafeUrl('http://[::ffff:169.254.0.1]'), false);
    assert.strictEqual(isSafeUrl('http://[::ffff:169.254.255.255]'), false);
  });

  it('rejette l\'IPv4-mapped IPv6 en forme hexadécimale (normalisée par URL)', () => {
    assert.strictEqual(isSafeUrl('http://[::ffff:a9fe:a9fe]/'), false);
    assert.strictEqual(isSafeUrl('http://[::ffff:a9:fe:a9:fe]/'), false);
  });

  it('accepte l\'IPv4-mapped IPv6 vers localhost ::ffff:127.0.0.1', () => {
    assert.strictEqual(isSafeUrl('http://[::ffff:127.0.0.1]:8080'), true);
  });

  it('rejette 127.0.0.0/8 sauf 127.0.0.1', () => {
    assert.strictEqual(isSafeUrl('http://127.0.0.1:8080'), true);
    assert.strictEqual(isSafeUrl('http://127.0.0.2:8080'), false);
    assert.strictEqual(isSafeUrl('http://127.1.0.1:8080'), false);
    assert.strictEqual(isSafeUrl('http://127.255.255.255:8080'), false);
  });
});

describe('checkUploadCondition', () => {
  const nowSec = 1_000_000;
  const winSec = 3600;

  it('retourne true si upload < seuil sur la fenêtre', () => {
    const points = [[nowSec - winSec, 1e6], [nowSec - 1800, 1.5e6], [nowSec - 600, 2e6]];
    assert.strictEqual(checkUploadCondition('abc', points, nowSec, winSec, 10), true);
  });

  it('retourne false si upload ≥ seuil', () => {
    const points = [[nowSec - 7200, 1e6], [nowSec - 1800, 2e7]];
    assert.strictEqual(checkUploadCondition('abc', points, nowSec, winSec, 10), false);
  });

  it('retourne false si historique ne couvre pas la fenêtre', () => {
    const points = [[nowSec - 600, 1e6], [nowSec - 300, 1.5e6]];
    assert.strictEqual(checkUploadCondition('abc', points, nowSec, winSec, 10), false);
  });

  it('retourne false si moins de 2 points dans la fenêtre', () => {
    const points = [[nowSec - 7200, 1e6]];
    assert.strictEqual(checkUploadCondition('abc', points, nowSec, winSec, 10), false);
  });

  it('retourne false si historique vide', () => {
    assert.strictEqual(checkUploadCondition('abc', [], nowSec, winSec, 10), false);
  });

  it('retourne false si points null', () => {
    assert.strictEqual(checkUploadCondition('abc', null, nowSec, winSec, 10), false);
  });
});

describe('getIn', () => {
  const obj = { a: { b: { c: 42 } }, d: null };

  it('lit une valeur à un chemin valide', () => {
    assert.strictEqual(getIn(obj, ['a', 'b', 'c']), 42);
  });

  it('retourne undefined si un niveau est absent', () => {
    assert.strictEqual(getIn(obj, ['a', 'x', 'c']), undefined);
  });

  it('retourne undefined sur chemin vide', () => {
    assert.strictEqual(getIn(obj, []), obj);
  });

  it('gère les valeurs null intermédiaires', () => {
    assert.strictEqual(getIn(obj, ['d', 'x']), undefined);
  });
});

describe('setIn', () => {
  it('écrit une valeur à un chemin existant', () => {
    const obj = { a: { b: 1 } };
    setIn(obj, ['a', 'b'], 99);
    assert.strictEqual(obj.a.b, 99);
  });

  it('ne crée pas les niveaux manquants', () => {
    const obj = { a: {} };
    setIn(obj, ['a', 'x', 'y'], 1);
    assert.strictEqual(obj.a.x, undefined);
  });
});

describe('maskSecret', () => {
  it('retourne une chaîne vide pour une valeur vide', () => {
    assert.strictEqual(maskSecret(''), '');
    assert.strictEqual(maskSecret(null), '');
    assert.strictEqual(maskSecret(undefined), '');
  });

  it('masque une valeur courte avec 8 étoiles', () => {
    assert.strictEqual(maskSecret('abc'), '********');
    assert.strictEqual(maskSecret('abcd'), '********');
  });

  it('masque partiellement une valeur longue', () => {
    assert.strictEqual(maskSecret('abcdefghij', 3), 'abc****hij');
  });

  it('respecte le paramètre show', () => {
    assert.strictEqual(maskSecret('abcdef', 1), 'a****f');
  });
});
