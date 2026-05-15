// ============================================================
// src/types/web-push.d.ts
//
// V0 Gap 5b: ambient type declaration for the web-push library.
//
// Why this file instead of @types/web-push from npm:
//   - @types/web-push is a devDependency and Railway's production
//     build (npm install + npm run build) does not always resolve
//     devDependency types during tsc compilation, depending on
//     install flags.
//   - This ambient declaration is checked into the repo, so the
//     build is guaranteed to find it regardless of npm install mode.
//   - We only declare the surface area we actually use.
// ============================================================

declare module 'web-push' {
  export interface PushSubscriptionKeys {
    p256dh: string;
    auth:   string;
  }

  export interface PushSubscription {
    endpoint: string;
    keys:     PushSubscriptionKeys;
  }

  export interface RequestOptions {
    TTL?:             number;
    headers?:         Record<string, string>;
    contentEncoding?: string;
    urgency?:         'very-low' | 'low' | 'normal' | 'high';
    topic?:           string;
    timeout?:         number;
  }

  export interface SendResult {
    statusCode: number;
    body:       string;
    headers:    Record<string, string>;
  }

  export interface VapidKeys {
    publicKey:  string;
    privateKey: string;
  }

  export function setVapidDetails(
    subject:    string,
    publicKey:  string,
    privateKey: string,
  ): void;

  export function sendNotification(
    subscription: PushSubscription,
    payload?:     string | Buffer | null,
    options?:     RequestOptions,
  ): Promise<SendResult>;

  export function generateVAPIDKeys(): VapidKeys;

  const webpush: {
    setVapidDetails:   typeof setVapidDetails;
    sendNotification:  typeof sendNotification;
    generateVAPIDKeys: typeof generateVAPIDKeys;
  };

  export default webpush;
}
