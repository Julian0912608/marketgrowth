// ============================================================
// src/modules/integrations/base/platform-connector.ts
//
// Abstracte basisklasse voor alle platform-koppelingen.
// Elke connector (Shopify, Bol.com, etc.) erft hiervan.
// Dit zorgt voor een uniforme interface ongeacht het platform.
// ============================================================

export interface NormalizedOrder {
  externalId:          string;
  externalNumber?:     string;
  status:              OrderStatus;
  paymentStatus?:      string;
  fulfillmentStatus?:  string;
  subtotal:            number;
  shippingTotal:       number;
  taxTotal:            number;
  discountTotal:       number;
  total:               number;
  currency:            string;
  customerEmail?:      string;
  customerName?:       string;
  customerIdExternal?: string;
  orderedAt:           Date;
  updatedAtPlatform?:  Date;
  lineItems:           NormalizedLineItem[];
  rawData:             Record<string, unknown>;
}

export interface NormalizedLineItem {
  externalId?:    string;
  productIdExt?:  string;
  title:          string;
  sku?:           string;
  quantity:       number;
  unitPrice:      number;
  totalPrice:     number;
}

export interface NormalizedProduct {
  externalId:          string;
  title:               string;
  sku?:                string;
  status?:             string;
  price?:              number;
  compareAtPrice?:     number;
  costPrice?:          number;
  inventoryQuantity?:  number;
  imageUrl?:           string;
  productUrl?:         string;
  tags?:               string[];
  updatedAtPlatform?:  Date;
  rawData:             Record<string, unknown>;
}

export interface NormalizedAdCampaign {
  externalId:   string;
  name:         string;
  status?:      string;
  budget?:      number;
  spend?:       number;
  impressions?: number;
  clicks?:      number;
  conversions?: number;
  revenue?:     number;
  roas?:        number;
  periodStart?: Date;
  periodEnd?:   Date;
  rawData:      Record<string, unknown>;
}

export type OrderStatus =
  | 'pending'
  | 'processing'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'refunded'
  | 'unknown';

export interface SyncResult {
  platform:       string;
  connectionId:   string;
  ordersImported: number;
  ordersUpdated:  number;
  errors:         string[];
  syncedAt:       Date;
}

// Abstracte basisklasse — elke connector implementeert deze methodes
export abstract class PlatformConnector {
  abstract readonly platform: string;

  // Haal orders op (incrementeel via cursor)
  abstract fetchOrders(opts: {
    since?:  Date;
    cursor?: string;
    limit?:  number;
  }): Promise<{ orders: NormalizedOrder[]; nextCursor?: string }>;

  // Haal producten op
  abstract fetchProducts(opts: {
    since?: Date;
    limit?: number;
  }): Promise<NormalizedProduct[]>;

  // Haal advertentie-data op (niet alle platforms ondersteunen dit)
  fetchAdCampaigns?(opts: {
    since?: Date;
    until?: Date;
  }): Promise<NormalizedAdCampaign[]>;

  // Test of de connectie werkt
  abstract testConnection(): Promise<{ ok: boolean; shopName?: string; error?: string }>;

  // Vernieuw access token (voor OAuth platforms)
  refreshAccessToken?(): Promise<{ accessToken: string; expiresAt?: Date }>;
}
