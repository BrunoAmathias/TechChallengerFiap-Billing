const { randomUUID } = require('node:crypto');
const { runWithCorrelationId } = require('../../infrastructure/logger');

const HEADER = 'x-correlation-id';

function correlationIdMiddleware(req, res, next) {
  const correlationId = req.get(HEADER) || randomUUID();
  req.correlationId = correlationId;
  res.set(HEADER, correlationId);
  runWithCorrelationId(correlationId, next);
}

module.exports = correlationIdMiddleware;
