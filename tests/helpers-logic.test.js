'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { isSafeUrl } = require('../lib/helpers');

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
});
