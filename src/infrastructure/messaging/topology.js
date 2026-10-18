/**
 * Topologia de mensageria da saga (declarada de forma idempotente por cada serviço):
 *
 *   oficina.events (topic) ──routing keys──▶ <fila>
 *   <fila> ── falha no handler ──▶ <fila>.retry (TTL) ──expira──▶ <fila>
 *   <fila> ── tentativas esgotadas / mensagem inválida ──▶ oficina.dlx ──▶ <fila>.dlq
 */
const EXCHANGE_EVENTS = "oficina.events";
const EXCHANGE_DLX = "oficina.dlx";

function nomesDasFilas(queue) {
  return { queue, retryQueue: `${queue}.retry`, dlq: `${queue}.dlq` };
}

async function configurarTopologia(channel, { queue, routingKeys, retryDelayMs = 5000 }) {
  const { retryQueue, dlq } = nomesDasFilas(queue);

  await channel.assertExchange(EXCHANGE_EVENTS, "topic", { durable: true });
  await channel.assertExchange(EXCHANGE_DLX, "topic", { durable: true });

  await channel.assertQueue(queue, {
    durable: true,
    arguments: {
      "x-dead-letter-exchange": EXCHANGE_DLX,
      "x-dead-letter-routing-key": queue
    }
  });

  for (const routingKey of routingKeys) {
    await channel.bindQueue(queue, EXCHANGE_EVENTS, routingKey);
  }

  // Fila de espera: sem consumidor; quando o TTL expira a mensagem volta para a fila principal.
  await channel.assertQueue(retryQueue, {
    durable: true,
    arguments: {
      "x-message-ttl": retryDelayMs,
      "x-dead-letter-exchange": "",
      "x-dead-letter-routing-key": queue
    }
  });

  await channel.assertQueue(dlq, { durable: true });
  await channel.bindQueue(dlq, EXCHANGE_DLX, queue);

  return { queue, retryQueue, dlq };
}

module.exports = { configurarTopologia, nomesDasFilas, EXCHANGE_EVENTS, EXCHANGE_DLX };
