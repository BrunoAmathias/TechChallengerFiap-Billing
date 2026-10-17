const defaultLogger = require("../logger");
const { EXCHANGE_EVENTS } = require("./topology");
const { cabecalhosDoEvento } = require("../observability/tracing");

/**
 * Transactional Outbox: faz polling da tabela outbox e publica os eventos
 * pendentes na exchange oficina.events com publisher confirms. Só marca como
 * publicado depois do ack do broker (entrega at-least-once; os consumers
 * são idempotentes).
 */
class OutboxPublisher {
  constructor({ outboxRepository, unitOfWork, getChannel, intervalMs = 1000, batchSize = 50, logger = defaultLogger }) {
    this.outboxRepository = outboxRepository;
    this.unitOfWork = unitOfWork;
    this.getChannel = getChannel;
    this.intervalMs = intervalMs;
    this.batchSize = batchSize;
    this.logger = logger;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return;

    this.timer = setInterval(() => {
      this.publicarPendentes().catch((err) => this.logger.error({ err }, "Erro no polling do outbox"));
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async publicarPendentes() {
    const channel = this.getChannel();
    if (!channel || this.running) return 0;

    this.running = true;
    try {
      return await this.unitOfWork.run(async (tx) => {
        const pendentes = await this.outboxRepository.buscarPendentes(this.batchSize, tx);
        let publicados = 0;

        for (const linha of pendentes) {
          try {
            await this.publicar(channel, linha.payload);
            await this.outboxRepository.marcarPublicado(linha.id, tx);
            publicados += 1;
          } catch (err) {
            await this.outboxRepository.registrarFalha(linha.id, err.message, tx);
            this.logger.error({ err, eventId: linha.id, eventType: linha.type }, "Falha ao publicar evento do outbox");
            break; // preserva a ordem: tenta de novo no próximo ciclo
          }
        }

        if (publicados > 0) {
          this.logger.debug({ publicados }, "Eventos do outbox publicados");
        }
        return publicados;
      });
    } finally {
      this.running = false;
    }
  }

  publicar(channel, evento) {
    return new Promise((resolve, reject) => {
      channel.publish(
        EXCHANGE_EVENTS,
        evento.type,
        Buffer.from(JSON.stringify(evento)),
        {
          persistent: true,
          contentType: "application/json",
          messageId: evento.eventId,
          correlationId: String(evento.correlationId),
          type: evento.type,
          timestamp: Math.floor(Date.parse(evento.occurredAt) / 1000),
          // contexto do trace de quem gerou o evento: o consumidor continua o mesmo trace
          headers: { source: evento.source, version: evento.version, ...cabecalhosDoEvento(evento) }
        },
        (err) => (err ? reject(err) : resolve())
      );
    });
  }
}

module.exports = OutboxPublisher;
