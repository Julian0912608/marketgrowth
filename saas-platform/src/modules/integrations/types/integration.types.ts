// ============================================================
// src/modules/integrations/types/integration.types.ts
//
// Gedeelde types voor alle platform connectors.
// Elke connector vertaalt platform-specifieke data naar
// deze genormaliseerde structuren.
// ============================================================

export type PlatformSlug =
  | 'shopify'
  | 'woocommerce'
  | 'lightspeed'
  | 'magento'
  | 'bigcommerce'
  | 'bolcom';

export type IntegrationStatus =
  | 'pending'
  | 'active'
  | 'error'
  | 'disconnected'
  | 'rate_limited';

export type SyncJobType = 'full_sync' | 'incremental' | 'webhook';
export type SyncJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

// ── Connector interface ───────────────────────────────────────
// Elke platformconnector implementeert deze interface.
// Dit zorgt voor uniforme behandeling in de sync worker.
export interface IPlatformConnector {
  readonly platform: PlatformSlug;

  /** Test of de verbinding werkt met de opgeslagen credentials */
  testConnection(credentials: IntegrationCredentials): Promise<ConnectionTestResult>;

  /** Haal orders op, gesorteerd van nieuw naar oud, met paginering */
  fetchOrders(
    credentials: IntegrationCredentials,
    options: FetchOptions
  ): Promise<PaginatedResult<NormalizedOrder>>;

  /** Haal producten op */
  fetchProducts(
    credentials: IntegrationCredentials,
    options: FetchOptions
  ): Promise<PaginatedResult<NormalizedProduct>>;

  /** Haal klanten op */
  fetchCustomers(
    credentials: IntegrationCredentials,
    options: FetchOptions
  ): Promise<PaginatedResult<NormalizedCustomer>>;

  /** Registreer een webhook bij het platform (optioneel) */
  registerWebhook?(
    credentials: IntegrationCredentials,
    topic: string,
    callbackUrl: string
  ): Promise<WebhookRegistration>;

  /** Verifieer een inkomend webhook verzoek */
  verifyWebhook?(
    payload: Buffer,
    signature: string,
    secret: string
  ): boolean;

  /** Ververs het access token (alleen OAuth2) */
  refreshAccessToken?(
    credentials: IntegrationCredentials
  ): Promise<TokenRefreshResult>;
}

// ── Credentials ───────────────────────────────────────────────
export interface IntegrationCredentials {
  integrationId: string;
  platform: PlatformSlug;

  // OAuth2
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: Date;
  tokenScope?: string;

  // API Key
  apiKey?: string;
  apiSecret?: string;
  storeUrl?: string;      // WooCommerce/Magento basis URL

  // Shop identificatie
  shopDomain?: string;    // Shopify: 'mijnwinkel.myshopify.com'
}

// ── Fetch opties ──────────────────────────────────────────────
export interface FetchOptions {
  /** Haal alleen records op die zijn bijgewerkt na dit tijdstip */
  updatedAfter?: Date;
  /** Maximaal aantal records per pagina */
  limit?: number;
  /** Cursor voor volgende pagina (platform-specifiek formaat) */
  cursor?: string;
  /** Pagina nummer (voor platformen zonder cursor paginering) */
  page?: number;
}

// ── Paginering ────────────────────────────────────────────────
export interface PaginatedResult<T> {
  items: T[];
  hasNextPage: boolean;
  nextCursor?: string;    // cursor voor volgende pagina
  nextPage?: number;
  totalCount?: number;    // niet alle platformen bieden dit
}

// ── Genormaliseerde data modellen ─────────────────────────────
// Platform-agnostisch — alle connectors produceren dit formaat.

export interface NormalizedOrder {
  externalId: string;
  externalNumber?: string;
  totalAmount: number;
  subtotalAmount: number;
  taxAmount: number;
  shippingAmount: number;
  discountAmount: number;
  currency: string;
  status: string;
  financialStatus?: string;
  fulfillmentStatus?: string;
  customerEmailHash?: string;   // SHA-256 hash
  isFirstOrder?: boolean;
  lineItems: NormalizedLineItem[];
  tags?: string[];
  note?: string;
  source?: string;
  orderedAt: Date;
  updatedAt: Date;
}

export interface NormalizedLineItem {
  externalId?: string;
  productId?: string;
  variantId?: string;
  sku?: string;
  title: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  discountAmount: number;
}

export interface NormalizedProduct {
  externalId: string;
  title: string;
  handle?: string;
  status?: string;
  productType?: string;
  tags?: string[];
  vendor?: string;
  totalInventory?: number;
  requiresShipping?: boolean;
  priceMin?: number;
  priceMax?: number;
  publishedAt?: Date;
  updatedAt: Date;
}

export interface NormalizedCustomer {
  externalId: string;
  emailHash: string;         // SHA-256 hash
  firstName?: string;
  lastName?: string;
  country?: string;
  acceptsMarketing?: boolean;
  totalSpent: number;
  orderCount: number;
  firstOrderAt?: Date;
  lastOrderAt?: Date;
  updatedAt: Date;
}

// ── Resultaten ────────────────────────────────────────────────
export interface ConnectionTestResult {
  success: boolean;
  shopName?: string;
  shopCurrency?: string;
  shopTimezone?: string;
  shopCountry?: string;
  error?: string;
  rateLimitRemaining?: number;
}

export interface WebhookRegistration {
  externalHookId: string;
  topic: string;
  endpointUrl: string;
  secret: string;
}

export interface TokenRefreshResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
}

// ── API response types ────────────────────────────────────────
export interface ConnectIntegrationRequest {
  platformSlug: PlatformSlug;
  shopDomain?: string;
  apiKey?: string;
  apiSecret?: string;
  storeUrl?: string;
}

export interface ConnectIntegrationResponse {
  integrationId: string;
  status: IntegrationStatus;
  /** OAuth2 redirect URL — klant moet hierheen worden gestuurd */
  authUrl?: string;
  /** Direct verbonden (API key authenticatie) */
  connected?: boolean;
  shopName?: string;
}

export interface IntegrationSummary {
  id: string;
  platformSlug: PlatformSlug;
  platformName: string;
  shopDomain: string;
  shopName?: string;
  status: IntegrationStatus;
  lastSyncAt?: Date;
  isPrimary: boolean;
  ordersCount?: number;
  errorMessage?: string;
}

export interface SyncStatusResponse {
  integrationId: string;
  currentJob?: {
    id: string;
    type: SyncJobType;
    status: SyncJobStatus;
    orderssynced: number;
    startedAt?: Date;
  };
  lastCompletedSync?: Date;
  totalOrdersSynced?: number;
}
