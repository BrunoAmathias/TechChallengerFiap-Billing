const defaultLogger = require("../logger");
const RabbitConnection = require("./rabbit.connection");
const OutboxPublisher = require("./outbox.publisher");
const EventConsumer = require("./consumer");
const { configurarTopologia } = require("./topology");

const QUEUE = "billing-service.events";

/**
 * Sobe a mensageria do Billing Service: conexão, topologia, consumer da saga e
 * publisher do outbox. A conexão roda em background (com reconexão), então a
 * API HTTP sobe mesmo com o broker fora; os eventos ficam no outbox até lá.
 */
function iniciarMensageria({
  url,
  handlers,
  outboxRepository,
  unitOfWork,
  queue = QUEUE,
  retryDelayMs = Number(process.env.RABBITMQ_RETRY_DELAY_MS) || 5000,
  outboxIntervalMs = Number(process.env.OUTBOX_POLL_INTERVAL_MS) || 1000,
  amqp,
  logger = defaultLogger
}) {
  const connection = new RabbitConnection({ url, amqp, logger });
  let consumer = null;

  connection.on("connected", async () => {
    try {
      const channel = await connection.createChannel();
      await configurarTopologia(channel, { queue, routingKeys: Object.keys(handlers), retryDelayMs });
      consumer = new EventConsumer({ channel, queue, handlers, logger });
      await consumer.start();
    } catch (err) {
      logger.error({ err }, "Falha ao configurar o consumer do RabbitMQ");
    }
  });

  const publisher = new OutboxPublisher({
    outboxRepository,
    unitOfWork,
    getChannel: () => connection.getPublishChannel(),
    intervalMs: outboxIntervalMs,
    logger
  });

  connection.connect();
  publisher.start();

  return {
    connection,
    publisher,
    isConnected: () => connection.isConnected(),
    async stop() {
      publisher.stop();
      if (consumer) await consumer.stop();
      await connection.close();
    }
  };
}

module.exports = { iniciarMensageria, QUEUE };
