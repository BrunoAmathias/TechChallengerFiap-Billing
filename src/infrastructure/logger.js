const pino = require('pino');
const { AsyncLocalStorage } = require('node:async_hooks');

const context = new AsyncLocalStorage();

function defaultLevel() {
  if (process.env.LOG_LEVEL) return process.env.LOG_LEVEL;
  return process.env.NODE_ENV === 'test' ? 'silent' : 'info';
}

const logger = pino({
  level: defaultLevel(),
  base: { service: process.env.SERVICE_NAME || 'billing-service' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label })
  },
  // Toda linha de log carrega o correlationId da requisição/evento atual.
  mixin() {
    const store = context.getStore();
    return store?.correlationId ? { correlationId: store.correlationId } : {};
  },
  redact: {
    paths: ['req.headers.authorization', 'password', 'senha', '*.password', '*.senha'],
    censor: '[REDACTED]'
  }
});

/**
 * Executa `fn` com o correlationId no contexto assíncrono.
 * Usado pelo middleware HTTP e, na Fase 2, pelos consumers do RabbitMQ.
 */
function runWithCorrelationId(correlationId, fn) {
  return context.run({ correlationId: String(correlationId) }, fn);
}

function getCorrelationId() {
  return context.getStore()?.correlationId;
}

module.exports = logger;
module.exports.runWithCorrelationId = runWithCorrelationId;
module.exports.getCorrelationId = getCorrelationId;
