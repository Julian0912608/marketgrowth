// ============================================================
// src/modules/integrations/connectors/connector.factory.ts
//
// UPDATE: meta_ads en bolcom_ads toegevoegd aan factory.
// ============================================================

import { IPlatformConnector, PlatformSlug } from '../types/integration.types';
import { ShopifyConnector }      from './shopify.connector';
import { WooCommerceConnector }  from './woocommerce.connector';
import { LightspeedConnector, BigCommerceConnector, BolcomConnector } from './lightspeed-bigcommerce-bolcom.connectors';
import { AmazonConnector, EtsyConnector } from './amazon-etsy.connectors';
import { MetaAdsConnector }      from './meta-ads.connector';

const connectorMap: Record<PlatformSlug, () => IPlatformConnector> = {
  shopify:     () => new ShopifyConnector(),
  woocommerce: () => new WooCommerceConnector(),
  lightspeed:  () => new LightspeedConnector(),
  bigcommerce: () => new BigCommerceConnector(),
  bolcom:      () => new BolcomConnector(),
  magento:     () => new WooCommerceConnector(), // WooCommerce-compatibele REST API
  amazon:      () => new AmazonConnector(),
  etsy:        () => new EtsyConnector(),
  google_ads:  () => { throw new Error('Google Ads gebruikt geen connector'); },
  bolcom_ads:  () => { throw new Error('Bol.com Ads gebruikt syncBolcomAdvertisingData direct'); },
  meta_ads:    () => new MetaAdsConnector(),
};

export function getConnector(platform: PlatformSlug): IPlatformConnector {
  const factory = connectorMap[platform];
  if (!factory) throw new Error(`Onbekend platform: ${platform}`);
  return factory();
}
