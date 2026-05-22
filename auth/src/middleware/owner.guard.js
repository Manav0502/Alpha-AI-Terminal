// ──────────────────────────────────────────────────────────────
// middleware/owner.guard.js — Ownership Guard middleware
// Ensures the authenticated user matches the requested resource.
// ──────────────────────────────────────────────────────────────

/**
 * Fastify preHandler hook to enforce ownership.
 * Must be used AFTER authGuard.
 * Checks if request.user.id matches request.params.userId
 */
export async function isOwner(request, reply) {
  // Ensure authGuard has run
  if (!request.user) {
    return reply.status(401).send({ error: 'Authentication required.' });
  }

  const resourceUserId = request.params.userId;

  // If there's no userId in the route, we can't enforce ownership this way
  if (!resourceUserId) {
    request.log.warn('[OWNER-GUARD] Route missing :userId parameter.');
    return reply.status(500).send({ error: 'Internal server error.' });
  }

  if (request.user.id !== resourceUserId) {
    return reply.status(403).send({ error: 'Forbidden: You do not own this resource.' });
  }
}
