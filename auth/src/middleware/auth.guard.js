// ──────────────────────────────────────────────────────────────
// middleware/auth.guard.js — Fastify preHandler authentication guard
// Extracts Bearer token from Authorization header, verifies
// RS256 signature, checks JTI against Redis blacklist, and
// attaches decoded user to the request.
// ──────────────────────────────────────────────────────────────

import { verifyAccessToken } from '../crypto/jwt.provider.js';
import { isJtiBlacklisted } from './blacklist.js';

/**
 * Fastify preHandler hook for protected routes.
 * Usage: { preHandler: [authGuard] }
 *
 * On success, sets request.user = { id, email, role, jti }
 * On failure, returns 401.
 */
export async function authGuard(request, reply) {
  const authHeader = request.headers.authorization;
  let token = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7); // Strip "Bearer "
  } else if (request.cookies?.access_token) {
    token = request.cookies.access_token;
  }

  if (!token) {
    return reply.status(401).send({
      error: 'Missing or malformed Authorization header.',
    });
  }

  // 1. Verify RS256 signature + expiry
  let decoded;
  try {
    decoded = verifyAccessToken(token);
  } catch (err) {
    const message = err.name === 'TokenExpiredError'
      ? 'Access token expired.'
      : 'Invalid access token.';
    return reply.status(401).send({ error: message });
  }

  // 2. Check JTI against Redis blacklist (instant revocation)
  try {
    const revoked = await isJtiBlacklisted(decoded.jti);
    if (revoked) {
      return reply.status(401).send({ error: 'Token has been revoked.' });
    }
  } catch (err) {
    // Redis failure — fail-closed (deny access) for security
    request.log.error('[AUTH-GUARD] Redis blacklist check failed:', err.message);
    return reply.status(503).send({ error: 'Authentication service temporarily unavailable.' });
  }

  // 3. Attach user identity to request
  request.user = {
    id: decoded.sub,
    email: decoded.email,
    role: decoded.role,
    jti: decoded.jti,
    mfa_verified: decoded.mfa_verified === true,
  };
}
