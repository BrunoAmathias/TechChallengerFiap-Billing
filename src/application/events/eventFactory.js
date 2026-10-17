const { randomUUID } = require('node:crypto');

const SOURCE = 'billing-service';

/**
 * Monta o envelope padrão de todo evento da saga:
 * { eventId, type, version, occurredAt, correlationId (= osId), source, causationId, payload }
 */
function criarEvento(type, payload, { correlationId, causationId = null, version = 1 } = {}) {
  if (correlationId == null) {
    throw new Error(`correlationId é obrigatório no evento ${type}`);
  }

  return {
    eventId: randomUUID(),
    type,
    version,
    occurredAt: new Date().toISOString(),
    correlationId: String(correlationId),
    source: SOURCE,
    causationId,
    payload
  };
}

/** Valida o envelope recebido do broker antes de entregá-lo a um handler. */
function validarEnvelope(evento) {
  const obrigatorios = ['eventId', 'type', 'occurredAt', 'correlationId', 'payload'];
  const faltando = obrigatorios.filter((campo) => evento?.[campo] == null);

  if (faltando.length > 0) {
    throw new Error(`Envelope de evento inválido, campos ausentes: ${faltando.join(', ')}`);
  }

  return evento;
}

module.exports = { criarEvento, validarEnvelope, SOURCE };
