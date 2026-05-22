// ──────────────────────────────────────────────────────────────
// middleware/error.handler.js — Global error handling middleware
// Catches unhandled errors and maps them to consistent HTTP responses.
// ──────────────────────────────────────────────────────────────

/**
 * Register a global Fastify error handler.
 * Maps domain errors (with statusCode) to proper HTTP responses.
 * @param {import('fastify').FastifyInstance} app
 */
export function registerErrorHandler(app) {
  app.setErrorHandler((error, request, reply) => {
    // Domain errors with a statusCode property
    if (error.statusCode && error.statusCode < 500) {
      return reply.status(error.statusCode).send({
        error: error.message,
        code: error.name,
      });
    }

    // Fastify validation errors (schema validation)
    if (error.validation) {
      return reply.status(400).send({
        error: 'Validation error.',
        details: error.validation,
      });
    }

    // Unhandled errors — log and return 500
    request.log.error(error);
    return reply.status(500).send({
      error: 'Internal server error.',
    });
  });
}
