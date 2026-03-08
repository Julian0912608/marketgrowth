// ============================================================
// src/modules/integrations/connectors/connector.factory.ts
//
// Factory die de juiste connector retourneert op basis van platform.
// Voeg hier nieuwe platforms toe — de rest van de code hoeft
// niet te veranderen.
// ============================================================

import { PlatformSlug, IPlatformConnector } from '../types/integration.types';
import { ShopifyConnector }     from './shopify.connector';
import { WooCommerceConnector } from './woocommerce.connector';
import {
  LightspeedConnector,
  BigCommerceConnector,
  BolcomConnector,
} from './lightspeed-bigcommerce-bolcom.connectors';

const connectors: Record<string, IPlatformConnector> = {
  shopify:     new ShopifyConnector(),
  woocommerce: new WooCommerceConnector(),
  lightspeed:  new LightspeedConnector(),
  magento:     new WooCommerceConnector(),  // Magento2 gebruikt zelfde REST structuur
  bigcommerce: new BigCommerceConnector(),
  bolcom:      new BolcomConnector(),
};

export function getConnector(platform: string): IPlatformConnector {
  const connector = connectors[platform];
  if (!connector) {
    throw new Error(`Geen connector beschikbaar voor platform: ${platform}`);
  }
  return connector;
}

export function getSupportedPlatforms(): PlatformSlug[] {
  return Object.keys(connectors) as PlatformSlug[];
}
