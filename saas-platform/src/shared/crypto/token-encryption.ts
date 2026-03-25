// ============================================================
// src/shared/crypto/token-encryption.ts
//
// AES-256-GCM encryptie voor third-party API credentials.
// Beschermt api_key, api_secret, access_token, refresh_token
// in de integration_credentials tabel.
//
// Vereist: ENCRYPTION_KEY als 64-karakter hex string in env
// Genereer met: openssl rand -hex 32
//
// Format van encrypted string: iv:authTag:ciphertext (hex)
// ============================================================

import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';

function getKey(): Buffer {
  const keyHex = process.env.ENCRYPTION_KEY;

  if (!keyHex) {
    throw new Error(
      'ENCRYPTION_KEY is niet ingesteld. ' +
      'Genereer een key met: openssl rand -hex 32'
    );
  }

  if (keyHex.length !== 64) {
    throw new Error(
      `ENCRYPTION_KEY moet 64 hex-karakters zijn (32 bytes), maar is ${keyHex.length} karakters.`
    );
  }

  return Buffer.from(keyHex, 'hex');
}

/**
 * Versleutelt een plaintext string met AES-256-GCM.
 * Elke aanroep produceert een andere ciphertext (random IV).
 *
 * @returns "iv:authTag:ciphertext" als hex, of null als input null/undefined is
 */
export function encryptToken(plain: string | null | undefined): string | null {
  if (plain == null || plain === '') return null;

  const key = getKey();
  const iv  = crypto.randomBytes(16);

  const cipher     = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted  = Buffer.concat([
    cipher.update(plain, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag(); // 16 bytes GCM authentication tag

  return [
    iv.toString('hex'),
    authTag.toString('hex'),
    encrypted.toString('hex'),
  ].join(':');
}

/**
 * Ontsleutelt een string die eerder via encryptToken() is versleuteld.
 *
 * @throws Error als de ciphertext corrupt is of de key niet klopt
 * @returns plaintext string, of null als input null/undefined is
 */
export function decryptToken(stored: string | null | undefined): string | null {
  if (stored == null || stored === '') return null;

  // Backward compatibility: als het geen hex:hex:hex formaat heeft,
  // is het een plain text waarde uit vóór de migratie
  if (!stored.includes(':')) {
    return stored;
  }

  const parts = stored.split(':');
  if (parts.length !== 3) {
    // Onverwacht formaat — behandel als plain text (migratie safety)
    return stored;
  }

  const [ivHex, authTagHex, encryptedHex] = parts;

  try {
    const key       = getKey();
    const iv        = Buffer.from(ivHex, 'hex');
    const authTag   = Buffer.from(authTagHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  } catch (err) {
    throw new Error(
      'Token decryptie mislukt. Controleer ENCRYPTION_KEY of de data is corrupt. ' +
      'Detail: ' + (err instanceof Error ? err.message : String(err))
    );
  }
}

/**
 * Controleert of een waarde al versleuteld is (iv:tag:cipher formaat).
 * Handig tijdens migratie om dubbele encryptie te voorkomen.
 */
export function isEncrypted(value: string | null | undefined): boolean {
  if (!value) return false;
  const parts = value.split(':');
  return parts.length === 3 && parts.every(p => /^[0-9a-f]+$/i.test(p));
}
