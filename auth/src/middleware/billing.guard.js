// ──────────────────────────────────────────────────────────────
// middleware/billing.guard.js — The Global Billing Lock
// ──────────────────────────────────────────────────────────────

import { billingRepository } from '../repository/billing.repository.js';

/**
 * Global middleware ensuring trading/orders are locked until an active subscription is found.
 * Must be executed AFTER authGuard.
 */
export async function requireActiveSubscription(req, reply) {
  if (!req.user || !req.user.sub) {
    return reply.status(401).send({ error: 'Unauthorized. User context missing.' });
  }

  try {
    const activeSubs = await billingRepository.getActiveSubscriptions(req.user.sub);

    if (!activeSubs || activeSubs.length === 0) {
      return reply.status(402).send({ 
        error: 'Payment Required', 
        details: 'An active subscription is required to perform this action' 
      });
    }

    // Check if the current_period_end is passed? 
    // Usually status takes care of it, but checking period end gives an extra layer of protection if the sync engine was slow.
    const currentSub = activeSubs[0];
    if (new Date(currentSub.current_period_end) < new Date()) {
       // It's technically expired, although Polar hasn't successfully revoked it yet via webhook.
       // Self-healing should have caught this, but protect the API directly.
       return reply.status(402).send({
         error: 'Payment Required',
         details: 'Your subscription has expired.'
       });
    }

    // Optional: inject subscription into request for downstream use
    req.subscription = currentSub;

  } catch (err) {
    req.log.error(err);
    return reply.status(500).send({ error: 'Failed to verify billing status' });
  }
}
