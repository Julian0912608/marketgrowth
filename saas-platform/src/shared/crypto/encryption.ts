// ============================================================
// src/shared/crypto/encryption.ts
//
// AES-256-GCM encryptie voor opgeslagen API tokens.
// Nooit plain text credentials in de database.
// ============================================================

import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;  // 256 bit
const IV_LENGTH  = 16;

function getKey(): Buffer {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret) throw new Error('ENCRYPTION_KEY environment variable niet ingesteld');
  // Deriveer een vaste 32-byte key uit de secret
  return crypto.createHash('sha256').update(secret).digest();
}

export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv  = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Formaat: iv:authTag:encrypted (alles base64)
  return [
    iv.toString('base64'),
    authTag.toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

export function decryptSecret(ciphertext: string): string {
  const key = getKey();
  const [ivB64, authTagB64, encryptedB64] = ciphertext.split(':');

  if (!ivB64 || !authTagB64 || !encryptedB64) {
    throw new Error('Ongeldig versleuteld formaat');
  }

  const iv        = Buffer.from(ivB64, 'base64');
  const authTag   = Buffer.from(authTagB64, 'base64');
  const encrypted = Buffer.from(encryptedB64, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return decipher.update(encrypted).toString('utf8') + decipher.final('utf8');
}
