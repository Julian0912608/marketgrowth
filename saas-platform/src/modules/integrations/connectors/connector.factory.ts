// ============================================================
// src/modules/integrations/connectors/connector.factory.ts
// ============================================================

import { IPlatformConnector, PlatformSlug } from '../types/integration.types';
import { ShopifyConnector }      from './shopify.connector';
import { WooCommerceConnector }  from './woocommerce.connector';
import { LightspeedConnector, BigCommerceConnector, BolcomConnector } from './lightspeed-bigcommerce-bolcom.connectors';
import { AmazonConnector, EtsyConnector } from './amazon-etsy.connectors';

const connectorMap: Record<PlatformSlug, () => IPlatformConnector> = {
  shopify:     () => new ShopifyConnector(),
  woocommerce: () => new WooCommerceConnector(),
  lightspeed:  () => new LightspeedConnector(),
  bigcommerce: () => new BigCommerceConnector(),
  bolcom:      () => new BolcomConnector(),
  magento:     () => new WooCommerceConnector(), // WooCommerce-compatibele REST API
  amazon:      () => new AmazonConnector(),
  etsy:        () => new EtsyConnector(),
  google_ads: () => { throw new Error('Google Ads gebruikt geen connector'); },
};

export function getConnector(platform: PlatformSlug): IPlatformConnector {
  const factory = connectorMap[platform];
  if (!factory) throw new Error(`Onbekend platform: ${platform}`);
  return factory();
  google_ads: () => { throw new Error('Google Ads gebruikt geen connector'); },
}
