// ── BOL.COM TOKEN CACHE FIX ───────────────────────────────────
//
// Vervang de getAccessToken() methode in BolcomConnector
// in het bestand:
// saas-platform/src/modules/integrations/connectors/lightspeed-bigcommerce-bolcom.connectors.ts
//
// PROBLEEM: token wordt bij elke API call opnieuw opgehaald.
// Bol.com token is 299 seconden geldig. Bij strikte rate limits
// op de auth endpoint kan dit leiden tot IP blocking.
//
// FIX: token 240 seconden cachen in Redis (59 sec buffer).
// ─────────────────────────────────────────────────────────────

import { redis } from '../../../infrastructure/cache/redis';

// Voeg dit toe BOVENAAN de BolcomConnector class, voor testConnection():

  // Token cache: slaat per integrationId de token + expiry op in Redis
  // TTL = 240 sec (token is 299 sec geldig, we vernieuwen 59 sec voor expiry)
  private async getAccessToken(creds: IntegrationCredentials): Promise<string> {
    const cacheKey = 'bolcom:token:' + creds.integrationId;

    // Probeer uit Redis cache
    try {
      const cached = await (redis as any).get(cacheKey);
      if (cached) return cached;
    } catch {
      // Redis niet beschikbaar → direct nieuwe token ophalen
    }

    // Haal nieuwe token op
    const encoded = Buffer.from(creds.apiKey + ':' + creds.apiSecret).toString('base64');
    const res = await fetch('https://login.bol.com/token?grant_type=client_credentials', {
      method:  'POST',
      headers: {
        'Authorization': 'Basic ' + encoded,
        'Accept':        'application/json',
        'Content-Type':  'application/x-www-form-urlencoded',
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error('Bol.com auth mislukt (' + res.status + '): ' + body.slice(0, 200));
    }

    const d = await res.json() as { access_token: string; expires_in: number };
    const token = d.access_token;
    const ttl   = Math.max((d.expires_in ?? 299) - 60, 30); // 60 sec buffer

    // Sla op in Redis
    try {
      await (redis as any).setex(cacheKey, ttl, token);
    } catch {
      // Redis niet beschikbaar → geen cache, token direct gebruiken
    }

    return token;
  }
