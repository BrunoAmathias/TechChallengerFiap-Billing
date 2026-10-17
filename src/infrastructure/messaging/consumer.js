const defaultLogger = require("../logger");
const { runWithCorrelationId } = require("../logger");
const { validarEnvelope } = require("../../application/events/eventFactory");
const { nomesDasFilas } = require("./topology");

const RETRY_HEADER = "x-retry-count";

/**
 * Consome a fila do serviço e despacha cada evento para o handler do seu tipo.
 * - sucesso → ack
 * - erro no handler → reenvia para <fila>.retry (TTL) até `maxTentativas`
 * - tentativas esgotadas ou mensagem inválida → nack sem requeue (vai para a DLQ)
 * A idempotência fica nos handlers (processed_events na mesma transação).
 */
class EventConsumer {
  constructor({ channel, queue, handlers, maxTentativas = 3, prefetch = 10, logger = defaultLogger }) {
    this.channel = channel;
    this.queue = queue;
    this.retryQueue = nomesDasFilas(queue).retryQueue;
    this.handlers = handlers;
    this.maxTentativas = maxTentativas;
    this.prefetch = prefetch;
    this.logger = logger;
  }

  async start() {
    await this.channel.prefetch(this.prefetch);
    const { consumerTag } = await this.channel.consume(this.queue, (msg) => this.onMessage(msg));
    this.consumerTag = consumerTag;
    this.logger.info({ queue: this.queue }, "Consumer iniciado");
  }

  async onMessage(msg) {
    if (!msg) return; // consumer cancelado pelo broker

    let evento;
    try {
      evento = validarEnvelope(JSON.parse(msg.content.toString()));
    } catch (err) {
      this.logger.error({ err, queue: this.queue }, "Mensagem inválida enviada para a DLQ");
      this.channel.nack(msg, false, false);
      return;
    }

    const handler = this.handlers[evento.type];
    if (!handler) {
      this.logger.warn({ eventType: evento.type }, "Evento sem handler, descartado");
      this.channel.ack(msg);
      return;
    }

    await runWithCorrelationId(evento.correlationId, async () => {
      const inicio = Date.now();
      try {
        const resultado = await handler(evento);
        this.channel.ack(msg);
        this.logger.info(
          { eventId: evento.eventId, eventType: evento.type, resultado: resultado?.resultado, duracaoMs: Date.now() - inicio },
          "Evento processado"
        );
      } catch (err) {
        this.tratarFalha(msg, evento, err);
      }
    });
  }

  tratarFalha(msg, evento, err) {
    const tentativa = Number(msg.properties.headers?.[RETRY_HEADER] ?? 0) + 1;
    const contexto = { err, eventId: evento.eventId, eventType: evento.type, tentativa };

    if (tentativa >= this.maxTentativas) {
      this.logger.error(contexto, "Tentativas esgotadas, evento enviado para a DLQ");
      this.channel.nack(msg, false, false);
      return;
    }

    this.logger.warn(contexto, "Falha ao processar evento, agendando nova tentativa");
    this.channel.sendToQueue(this.retryQueue, msg.content, {
      persistent: true,
      contentType: msg.properties.contentType,
      messageId: msg.properties.messageId,
      correlationId: msg.properties.correlationId,
      type: msg.properties.type,
      headers: {
        ...msg.properties.headers,
        [RETRY_HEADER]: tentativa,
        "x-last-error": String(err.message).slice(0, 500)
      }
    });
    this.channel.ack(msg);
  }

  async stop() {
    if (this.consumerTag) {
      await this.channel.cancel(this.consumerTag).catch(() => {});
    }
  }
}

module.exports = EventConsumer;
module.exports.RETRY_HEADER = RETRY_HEADER;
