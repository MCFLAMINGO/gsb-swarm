/**
 * posDecrypt.js
 * Decrypt POS credentials stored in businesses.pos_config
 * Uses AES-256-GCM — same key as inbox/pos route
 */

'use strict';

const crypto = require('crypto');

function decryptPosConfig(posConfig) {
  if (!posConfig || !posConfig.data) throw new Error('no pos_config to decrypt');

  const key      = Buffer.from(
    (process.env.POS_ENCRYPT_KEY || 'localintel-pos-key-32-bytes-here!').padEnd(32).slice(0, 32)
  );
  const iv       = Buffer.from(posConfig.iv,  'hex');
  const tag      = Buffer.from(posConfig.tag, 'hex');
  const data     = Buffer.from(posConfig.data,'hex');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain    = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

module.exports = { decryptPosConfig };
