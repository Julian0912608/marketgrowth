// ============================================================
// src/modules/integrations/types/integration.types.ts
// ============================================================

export type PlatformSlug =
  | 'shopify'
  | 'woocommerce'
  | 'lightspeed'
  | 'bigcommerce'
  | 'bolcom'
  | 'magento'
  | 'amazon'
  | 'etsy';

export interface IntegrationCredentials {
  integrationId:  string;
  platform:       PlatformSlug;
  accessToken?:   string;
  refreshToken?:  string;
  tokenExpiresAt?: Date;
  apiKey?:        string;
  apiSecret?:     string;
  storeUrl?:      string;
  shopDomain?:    string;
}

// FetchOptions — jobType toegevoegd zodat connectors weten of het full_sync is
export interface FetchOptions {
  updatedAfter?: Date;
  limit?:        number;
  cursor?:       string;
  page?:         number;
  jobType?:      'full_sync' | 'incremental'; // ← nieuw
}

export interface NormalizedLineItem {
  externalId:     string;
  productId?:     string;
  variantId?:     string;
  sku?:           string;
  title:          string;
  quantity:       number;
  unitPrice:      number;
  totalPrice:     number;
  discountAmount: number;
}

export interface NormalizedOrder {
  externalId:         string;
  externalNumber?:    string;
  totalAmount:        number;
  subtotalAmount:     number;
  taxAmount:          number;
  shippingAmount:     number;
  discountAmount:     number;
  currency:           string;
  status:             string;
  financialStatus?:   string;
  fulfillmentStatus?: string;
  customerEmailHash?: string;
  isFirstOrder?:      boolean;
  lineItems:          NormalizedLineItem[];
  tags?:              string[];
  note?:              string;
  source?:            string;
  orderedAt:          Date;
  updatedAt:          Date;
}

export interface NormalizedProduct {
  externalId:        string;
  title:             string;
  handle?:           string;
  status?:           string;
  productType?:      string;
  tags?:             string[];
  vendor?:           string;
  totalInventory?:   number;
  requiresShipping?: boolean;
  priceMin?:         number;
  priceMax?:         number;
  publishedAt?:      Date;
  updatedAt:         Date;
  // Bol.com specifiek
  ean?:              string;
  condition?:        string;
  fulfillmentBy?:    string;
}

export interface NormalizedCustomer {
  externalId:         string;
  emailHash:          string;
  firstName?:         string;
  lastName?:          string;
  country?:           string;
  acceptsMarketing?:  boolean;
  totalSpent?:        number;
  orderCount?:        number;
  updatedAt:          Date;
}

export interface PaginatedResult<T> {
  items:       T[];
  hasNextPage: boolean;
  nextCursor?: string;
  nextPage?:   number;
  totalCount?: number;
}

export interface ConnectionTestResult {
  success:       boolean;
  shopName?:     string;
  shopCurrency?: string;
  shopTimezone?: string;
  shopCountry?:  string;
  error?:        string;
}

export interface WebhookRegistration {
  externalHookId: string;
  topic:          string;
  endpointUrl:    string;
  secret:         string;
}

export interface TokenRefreshResult {
  accessToken:   string;
  refreshToken?: string;
  expiresAt:     Date;
}

export interface IPlatformConnector {
  readonly platform: PlatformSlug;
  testConnection(creds: IntegrationCredentials): Promise<ConnectionTestResult>;
  fetchOrders(creds: IntegrationCredentials, options: FetchOptions): Promise<PaginatedResult<NormalizedOrder>>;
  fetchProducts(creds: IntegrationCredentials, options: FetchOptions): Promise<PaginatedResult<NormalizedProduct>>;
  fetchCustomers(creds: IntegrationCredentials, options: FetchOptions): Promise<PaginatedResult<NormalizedCustomer>>;
  refreshAccessToken?(creds: IntegrationCredentials): Promise<TokenRefreshResult>;
  registerWebhook?(creds: IntegrationCredentials, topic: string, callbackUrl: string): Promise<WebhookRegistration>;
  verifyWebhook?(payload: Buffer, signature: string, secret: string): boolean;
}

// ── Service types ─────────────────────────────────────────────

export interface ConnectIntegrationRequest {
  platformSlug:  PlatformSlug;
  shopDomain?:   string;
  apiKey?:       string;
  apiSecret?:    string;
  storeUrl?:     string;
  code?:         string;
  state?:        string;
}

export interface ConnectIntegrationResponse {
  integrationId: string;
  redirectUrl?:  string;
  authUrl?:      string;
  status:        'connected' | 'oauth_required' | 'pending' | 'active' | string;
}

export interface IntegrationSummary {
  id:             string;
  platformSlug:   PlatformSlug;
  platformName:   string;
  status:         string;
  shopDomain?:    string;
  shopName?:      string;
  isPrimary?:     boolean;
  lastSyncAt?:    Date;
  nextSyncAt?:    Date;
  ordersCount?:   number;
  errorMessage?:  string;
  createdAt:      Date;
}

export interface SyncJobSummary {
  id:           string;
  jobType:      string;
  status:       string;
  orderssynced: number;
  startedAt:    Date;
  completedAt:  Date;
}

export interface SyncStatusResponse {
  integrationId: string;
  status:        string;
  lastSyncAt?:   Date;
  nextSyncAt?:   Date;
  errorMessage?: string;
  currentJob?:   SyncJobSummary;
  recentJobs:    SyncJobSummary[];
}
