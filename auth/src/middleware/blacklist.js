// ──────────────────────────────────────────────────────────────
// middleware/blacklist.js — Redis JTI blacklist operations
// Provides instant token revocation by storing invalidated
// JTI values in Redis with a TTL matching the token's remaining
// lifetime.
// ──────────────────────────────────────────────────────────────

import { getRedisClient } from '../redis.client.js';

const JTI_PREFIX = 'jti:';

/**
 * Blacklist a JTI in Redis with a TTL.
 * After TTL expires, the key auto-deletes (token would be expired anyway).
 * @param {string} jti — JWT ID to blacklist
 * @param {number} ttlSeconds — Time-to-live in seconds
 */
export async function blacklistJti(jti, ttlSeconds) {
  const redis = getRedisClient();
  const key = `${JTI_PREFIX}${jti}`;
  // Ensure TTL is at least 1 second
  const safeTtl = Math.max(1, Math.ceil(ttlSeconds));
  await redis.set(key, '1', 'EX', safeTtl);
}

/**
 * Check if a JTI is blacklisted.
 * @param {string} jti — JWT ID to check
 * @returns {Promise<boolean>} — true if blacklisted (token revoked)
 */
export async function isJtiBlacklisted(jti) {
  const redis = getRedisClient();
  const key = `${JTI_PREFIX}${jti}`;
  const exists = await redis.exists(key);
  return exists === 1;
}
