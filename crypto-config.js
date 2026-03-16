'use strict';

const crypto = require('crypto');
const ALGO   = 'aes-256-gcm';
const PREFIX = 'enc:';

function getKey(secret) {
  return crypto.createHash('sha256').update(secret).digest();
}

function encrypt(value, secret) {
  const iv     = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGO, getKey(secret), iv);
  const enc    = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(value, secret) {
  if (!value?.startsWith(PREFIX)) return value;
  const buf      = Buffer.from(value.slice(PREFIX.length), 'base64');
  const decipher = crypto.createDecipheriv(ALGO, getKey(secret), buf.slice(0, 16));
  decipher.setAuthTag(buf.slice(16, 32));
  return decipher.update(buf.slice(32)) + decipher.final('utf8');
}

module.exports = { encrypt, decrypt, PREFIX };
