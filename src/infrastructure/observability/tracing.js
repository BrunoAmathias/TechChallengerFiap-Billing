const newrelic = require("newrelic");

/** Cabeçalhos (W3C Trace Context + New Relic) que levam o trace distribuído entre os serviços. */
const CABECALHOS_TRACE = ["traceparent", "tracestate", "newrelic"];

function filtrarCabecalhos(origem) {
  const contexto = {};
  for (const nome of CABECALHOS_TRACE) {
    if (origem?.[nome]) contexto[nome] = String(origem[nome]);
  }
  return Object.keys(contexto).length > 0 ? contexto : undefined;
}

/**
 * Captura o contexto do trace da transação atual (requisição HTTP ou consumo de evento).
 * Ele viaja dentro do envelope porque quem publica é o outbox, fora da transação
 * que gerou o evento. Sem transação ativa (ou com o agente desligado) retorna undefined.
 */
function capturarContextoTrace() {
  const cabecalhos = {};
  try {
    newrelic.getTransaction().insertDistributedTraceHeaders(cabecalhos);
  } catch {
    return undefined;
  }
  return filtrarCabecalhos(cabecalhos);
}

/** Cabeçalhos de trace guardados no envelope, prontos para irem nos headers da mensagem AMQP. */
function cabecalhosDoEvento(evento) {
  return filtrarCabecalhos(evento?.traceContext) ?? {};
}

/**
 * Executa o processamento de um evento dentro de uma transação do New Relic que
 * continua o trace de quem publicou. Se a instrumentação automática do amqplib
 * já abriu uma transação de mensagem (e aceitou os headers), apenas a reutiliza.
 */
function processarComTrace(evento, atributos, fn) {
  const executar = async () => {
    newrelic.addCustomAttributes({
      eventId: evento.eventId,
      eventType: evento.type,
      osId: String(evento.correlationId),
      origem: String(evento.source ?? ""),
      ...atributos
    });
    return fn();
  };

  if (newrelic.getTraceMetadata?.().traceId) {
    return executar();
  }

  return newrelic.startBackgroundTransaction(`Consumir/${evento.type}`, "RabbitMQ", () => {
    const contexto = filtrarCabecalhos(evento.traceContext);
    if (contexto) {
      newrelic.getTransaction().acceptDistributedTraceHeaders("AMQP", contexto);
    }
    return executar();
  });
}

module.exports = { capturarContextoTrace, cabecalhosDoEvento, processarComTrace, CABECALHOS_TRACE };
