'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { isSafeUrl, getIn, setIn, maskSecret } = require('../lib/helpers');

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

  it('accepte les hostname (non IP)', () => {
    assert.strictEqual(isSafeUrl('http://localhost:8080'), true);
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
