// ──────────────────────────────────────────────────────────────
// middleware/mfa.guard.js — MFA Guard middleware
// Ensures the authenticated session has verified MFA.
// ──────────────────────────────────────────────────────────────

/**
 * Fastify preHandler hook to enforce MFA verification.
 * Must be used AFTER authGuard.
 * Checks if request.user.mfa_verified is true.
 */
export async function mfaGuard(request, reply) {
  // Ensure authGuard has run
  if (!request.user) {
    return reply.status(401).send({ error: 'Authentication required.' });
  }

  if (request.user.mfa_verified !== true) {
    return reply.status(401).send({ 
      error: 'MFA verification required.',
      code: 'MFA_REQUIRED'
    });
  }
}
