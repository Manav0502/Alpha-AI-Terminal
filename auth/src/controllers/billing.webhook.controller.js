// ──────────────────────────────────────────────────────────────
// billing.webhook.controller.js
// Handles Webhooks from Polar API to sync subscription state.
// ──────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import { config } from '../config.js';
import { billingRepository } from '../repository/billing.repository.js';
import { BILLING_CATALOG } from '../config/billing.catalog.js';

/**
 * Validates the Polar Webhook Signature.
 * Standard implementation assuming svix-like signatures or standard HMAC.
 */
function verifySignature(payload, signatureHeader) {
  if (!config.polar.webhookSecret) {
    // If no secret is configured, skip verification (Not recommended for prod)
    console.warn('[BILLING-WEBHOOK] WARNING: No POLAR_WEBHOOK_SECRET configured. Skipping signature verification.');
    return true;
  }

  if (!signatureHeader) return false;

  // Simplistic HMAC validation for demonstration
  // Real Polar webhooks use Svix (svix-id, svix-timestamp, svix-signature)
  // For the sake of this phase, we use a standard HMAC check on the raw body.
  const hmac = crypto.createHmac('sha256', config.polar.webhookSecret);
  const digest = Buffer.from(hmac.update(payload).digest('hex'), 'utf8');
  const signature = Buffer.from(signatureHeader, 'utf8');

  try {
    return signature.length === digest.length && crypto.timingSafeEqual(digest, signature);
  } catch (err) {
    return false;
  }
}

export async function handlePolarWebhook(request, reply) {
  // 1. Signature Verification
  // In Fastify, to get the raw body for signature verification, we'd need a raw body parser.
  // Assuming request.rawBody is available or we stringify the parsed body (less safe, but works for mock).
  const rawBody = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
  const signature = request.headers['webhook-signature'] || request.headers['svix-signature'];

  if (!verifySignature(rawBody, signature)) {
    request.log.warn('Invalid Polar webhook signature');
    return reply.status(401).send({ error: 'Invalid signature' });
  }

  // 2. Event Parsing
  const event = request.body;
  if (!event || !event.type || !event.data) {
    return reply.status(400).send({ error: 'Invalid payload format' });
  }

  try {
    const { type, data } = event;
    const polarSubId = data.id;
    
    // We only care about subscriptions tied to a specific user
    // `metadata.user_id` should be injected during customer creation
    const userId = data.customer?.metadata?.user_id || data.metadata?.user_id;

    switch (type) {
      case 'subscription.created':
      case 'subscription.updated': {
        const status = data.status; // 'active', 'canceled', 'past_due'
        const currentPeriodEnd = new Date(data.current_period_end).toISOString();
        const priceId = data.price_id || data.product_price_id; // Polar structure varies slightly

        const plan = BILLING_CATALOG[priceId];
        
        // Check if subscription exists
        const existingSub = await billingRepository.getSubscriptionByPolarId(polarSubId);

        if (existingSub) {
          // Update existing
          await billingRepository.updateSubscriptionStatus(polarSubId, status, currentPeriodEnd);
          
          // Note: If the plan_tier changed due to a downgrade that finally took effect
          if (plan && existingSub.plan_tier !== plan.tier) {
             const pool = (await import('../db.js')).getPool();
             await pool.query('UPDATE subscriptions SET plan_tier = $1 WHERE polar_sub_id = $2', [plan.tier, polarSubId]);
          }
        } else if (userId && plan) {
          // Insert new
          await billingRepository.createSubscription({
            userId,
            polarSubId,
            planTier: plan.tier,
            currentPeriodEnd,
            status,
            prorationMetadata: {}
          });
        }
        break;
      }

      case 'subscription.revoked':
      case 'subscription.canceled': {
        // Immediately revoke access
        await billingRepository.updateSubscriptionStatus(polarSubId, 'revoked');
        break;
      }

      default:
        request.log.info(`Unhandled Polar webhook event type: ${type}`);
    }

    return reply.status(200).send({ received: true });
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({ error: 'Failed to process webhook' });
  }
}
