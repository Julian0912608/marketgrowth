// ============================================================
// PATCH: src/modules/ai-engine/api/ai.routes.ts
// Vervang alleen de twee `prompt` variabelen in de /insights route
// De rest van het bestand blijft identiek
// ============================================================

// ── VERVANG de bestaande `const prompt = hasOrders ? ...` met dit: ──

const prompt = hasOrders
  ? `Je bent de AI engine van MarketGrow — een ecommerce action platform.
Je taak is NIET om te analyseren wat er is gebeurd. Je taak is om de ondernemer te vertellen wat hij vandaag moet doen, op welk kanaal, met welk product.

Verkoopdata van de afgelopen 30 dagen:
- Totaal orders: ${stats.total_orders}
- Omzet (excl. BTW): €${parseFloat(stats.revenue).toFixed(2)}
- Gemiddelde orderwaarde: €${parseFloat(stats.avg_order_value).toFixed(2)}
- Gekoppelde platforms: ${platformNames}
- Top producten: ${topProducts.map((p: any) => p.title + ' (' + p.sold + 'x verkocht, €' + parseFloat(p.revenue).toFixed(2) + ' omzet, platform: ' + p.platform_slug + ')').join(' | ')}

REGELS voor je output:
1. Elke actie moet SPECIFIEK zijn: noem het product, het platform én het concrete getal
2. Acties zijn altijd uitvoerbaar vandaag — geen vage adviezen
3. Onderscheid per kanaal: als een product op Bol.com beter loopt dan Shopify, zeg dat dan expliciet
4. High priority = doe dit vandaag. Medium = deze week. Low = overweeg dit
5. Alerts zijn echte waarschuwingen: dalende ROAS, product dat stopt, ongewone dip

Voorbeelden van GOEDE acties:
- "Verhoog je dagbudget voor [product] op Bol.com met €30 — dit product converteert 4x beter dan je Shopify variant"
- "Stop de advertenties voor [product] op Meta — ROAS is onder break-even gezakt"
- "Zet [product] ook live op Bol.com — je vergelijkbare producten doen het daar 60% beter"

Voorbeelden van SLECHTE acties (niet doen):
- "Analyseer je data regelmatig"
- "Overweeg je marketingstrategie aan te passen"
- "Blijf je conversie monitoren"

Geef een JSON response met exact deze structuur (geen markdown, alleen JSON):
{"briefing":"2-3 zinnen met de meest opvallende beweging van vandaag — specifiek, met cijfers","actions":[{"priority":"high","title":"Korte actietitel met platform/product","description":"Concrete uitleg: wat, op welk platform, waarom en met welk getal","channel":"bolcom|shopify|amazon|etsy|meta|google|algemeen"},{"priority":"medium","title":"...","description":"...","channel":"..."},{"priority":"low","title":"...","description":"...","channel":"..."}],"alerts":["Concrete waarschuwing met cijfer of lege array"]}`

  : `Je bent de AI engine van MarketGrow. De gebruiker heeft ${integrations.length} winkel(s) gekoppeld (${platformNames}) maar nog geen orders de afgelopen 30 dagen.

Geef een motiverende maar concrete briefing als JSON (geen markdown, alleen JSON):
{"briefing":"Geef aan dat de setup goed staat en wat ze kunnen verwachten zodra orders binnenkomen","actions":[{"priority":"high","title":"Wacht op eerste orders","description":"Je winkel is gekoppeld. Zodra de eerste orders binnenkomen analyseert MarketGrow je data en krijg je direct je eerste acties per kanaal.","channel":"algemeen"},{"priority":"medium","title":"Controleer sync status","description":"Ga naar Integraties en check of de laatste sync succesvol was — zo weet je zeker dat orders direct zichtbaar zijn.","channel":"algemeen"}],"alerts":[]}`;

// ============================================================
// OPMERKING: voeg ook `channel` toe aan het actions type
// in app/dashboard/ai-insights/page.tsx voor de UI:
//
// interface Action {
//   priority: 'high' | 'medium' | 'low';
//   title: string;
//   description: string;
//   channel?: string;  // ← nieuw
// }
//
// En toon het channel als badge naast de actietitel:
// const CHANNEL_LABELS: Record<string, string> = {
//   bolcom:    'Bol.com',
//   shopify:   'Shopify',
//   amazon:    'Amazon',
//   etsy:      'Etsy',
//   meta:      'Meta Ads',
//   google:    'Google Ads',
//   algemeen:  'Algemeen',
// };
// ============================================================
