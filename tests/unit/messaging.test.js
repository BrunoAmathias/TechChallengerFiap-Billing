const { EventEmitter } = require('node:events');
const EventConsumer = require('../../src/infrastructure/messaging/consumer');
const OutboxPublisher = require('../../src/infrastructure/messaging/outbox.publisher');
const RabbitConnection = require('../../src/infrastructure/messaging/rabbit.connection');
const { configurarTopologia, EXCHANGE_EVENTS, EXCHANGE_DLX } = require('../../src/infrastructure/messaging/topology');
const { iniciarMensageria } = require('../../src/infrastructure/messaging');
const { getCorrelationId } = require('../../src/infrastructure/logger');
const { criarEvento } = require('../../src/application/events/eventFactory');

const silentLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

function fakeChannel() {
  return {
    assertExchange: jest.fn().mockResolvedValue({}),
    assertQueue: jest.fn().mockResolvedValue({}),
    bindQueue: jest.fn().mockResolvedValue({}),
    prefetch: jest.fn().mockResolvedValue(),
    consume: jest.fn().mockResolvedValue({ consumerTag: 'tag-1' }),
    cancel: jest.fn().mockResolvedValue(),
    ack: jest.fn(),
    nack: jest.fn(),
    sendToQueue: jest.fn(),
    publish: jest.fn((exchange, rk, content, options, cb) => cb(null)),
    on: jest.fn()
  };
}

function mensagem(conteudo, headers = {}) {
  return {
    content: Buffer.from(typeof conteudo === 'string' ? conteudo : JSON.stringify(conteudo)),
    properties: { headers, messageId: 'm1', correlationId: '10', type: conteudo.type, contentType: 'application/json' }
  };
}

describe('topologia', () => {
  it('declara exchanges, fila principal, retry com TTL e DLQ', async () => {
    const ch = fakeChannel();

    const nomes = await configurarTopologia(ch, { queue: 'billing-service.events', routingKeys: ['a.b', 'c.d'], retryDelayMs: 1000 });

    expect(nomes).toEqual({ queue: 'billing-service.events', retryQueue: 'billing-service.events.retry', dlq: 'billing-service.events.dlq' });
    expect(ch.assertExchange).toHaveBeenCalledWith(EXCHANGE_EVENTS, 'topic', { durable: true });
    expect(ch.assertExchange).toHaveBeenCalledWith(EXCHANGE_DLX, 'topic', { durable: true });
    expect(ch.assertQueue).toHaveBeenCalledWith('billing-service.events', {
      durable: true,
      arguments: { 'x-dead-letter-exchange': EXCHANGE_DLX, 'x-dead-letter-routing-key': 'billing-service.events' }
    });
    expect(ch.assertQueue).toHaveBeenCalledWith('billing-service.events.retry', {
      durable: true,
      arguments: { 'x-message-ttl': 1000, 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': 'billing-service.events' }
    });
    expect(ch.bindQueue).toHaveBeenCalledWith('billing-service.events', EXCHANGE_EVENTS, 'a.b');
    expect(ch.bindQueue).toHaveBeenCalledWith('billing-service.events', EXCHANGE_EVENTS, 'c.d');
    expect(ch.bindQueue).toHaveBeenCalledWith('billing-service.events.dlq', EXCHANGE_DLX, 'billing-service.events');
  });
});

describe('EventConsumer', () => {
  const evento = criarEvento('orcamento.gerado', { osId: 10 }, { correlationId: 10 });

  function criarConsumer(handlers, maxTentativas = 3) {
    const channel = fakeChannel();
    const consumer = new EventConsumer({ channel, queue: 'q', handlers, maxTentativas, logger: silentLogger });
    return { channel, consumer };
  }

  it('inicia com prefetch e consome a fila', async () => {
    const { channel, consumer } = criarConsumer({});

    await consumer.start();
    await consumer.stop();

    expect(channel.prefetch).toHaveBeenCalledWith(10);
    expect(channel.consume).toHaveBeenCalledWith('q', expect.any(Function));
    expect(channel.cancel).toHaveBeenCalledWith('tag-1');
  });

  it('processa o evento com o correlationId no contexto e faz ack', async () => {
    let correlation;
    const handler = jest.fn(async () => { correlation = getCorrelationId(); return { resultado: 'aplicado' }; });
    const { channel, consumer } = criarConsumer({ 'orcamento.gerado': handler });
    const msg = mensagem(evento);

    await consumer.onMessage(msg);

    expect(handler).toHaveBeenCalledWith(evento);
    expect(correlation).toBe('10');
    expect(channel.ack).toHaveBeenCalledWith(msg);
  });

  it('agenda retry com o contador de tentativas quando o handler falha', async () => {
    const { channel, consumer } = criarConsumer({ 'orcamento.gerado': jest.fn().mockRejectedValue(new Error('fora de ordem')) });
    const msg = mensagem(evento, { foo: 'bar' });

    await consumer.onMessage(msg);

    expect(channel.sendToQueue).toHaveBeenCalledWith(
      'q.retry',
      msg.content,
      expect.objectContaining({
        persistent: true,
        headers: { foo: 'bar', 'x-retry-count': 1, 'x-last-error': 'fora de ordem' }
      })
    );
    expect(channel.ack).toHaveBeenCalledWith(msg);
    expect(channel.nack).not.toHaveBeenCalled();
  });

  it('envia para a DLQ quando as tentativas se esgotam', async () => {
    const { channel, consumer } = criarConsumer({ 'orcamento.gerado': jest.fn().mockRejectedValue(new Error('x')) }, 3);
    const msg = mensagem(evento, { 'x-retry-count': 2 });

    await consumer.onMessage(msg);

    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
    expect(channel.sendToQueue).not.toHaveBeenCalled();
  });

  it('envia mensagem malformada direto para a DLQ', async () => {
    const { channel, consumer } = criarConsumer({});
    const msg = mensagem('{nao-e-json');

    await consumer.onMessage(msg);
    await consumer.onMessage(mensagem({ type: 'sem-envelope' }));

    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
    expect(channel.nack).toHaveBeenCalledTimes(2);
  });

  it('descarta com ack evento sem handler e ignora mensagem nula', async () => {
    const { channel, consumer } = criarConsumer({});
    const msg = mensagem(criarEvento('outro.evento', {}, { correlationId: 1 }));

    await consumer.onMessage(msg);
    await consumer.onMessage(null);

    expect(channel.ack).toHaveBeenCalledWith(msg);
  });
});

describe('OutboxPublisher', () => {
  const evento = criarEvento('os.aberta', { osId: 1 }, { correlationId: 1 });

  function criarPublisher(channel, pendentes) {
    const outboxRepository = {
      buscarPendentes: jest.fn().mockResolvedValue(pendentes),
      marcarPublicado: jest.fn().mockResolvedValue(),
      registrarFalha: jest.fn().mockResolvedValue()
    };
    const unitOfWork = { run: jest.fn((fn) => fn({ tx: true })) };
    const publisher = new OutboxPublisher({ outboxRepository, unitOfWork, getChannel: () => channel, batchSize: 5, logger: silentLogger });
    return { publisher, outboxRepository };
  }

  it('publica os pendentes na exchange com confirm e marca como publicados', async () => {
    const channel = fakeChannel();
    const { publisher, outboxRepository } = criarPublisher(channel, [{ id: evento.eventId, type: evento.type, payload: evento }]);

    const publicados = await publisher.publicarPendentes();

    expect(publicados).toBe(1);
    expect(outboxRepository.buscarPendentes).toHaveBeenCalledWith(5, { tx: true });
    const [exchange, routingKey, content, options] = channel.publish.mock.calls[0];
    expect(exchange).toBe('oficina.events');
    expect(routingKey).toBe('os.aberta');
    expect(JSON.parse(content.toString())).toEqual(evento);
    expect(options).toMatchObject({ persistent: true, messageId: evento.eventId, correlationId: '1', type: 'os.aberta' });
    expect(outboxRepository.marcarPublicado).toHaveBeenCalledWith(evento.eventId, { tx: true });
  });

  it('registra a falha e para o lote quando o broker recusa (nack)', async () => {
    const channel = fakeChannel();
    channel.publish.mockImplementation((e, rk, c, o, cb) => cb(new Error('nack')));
    const linhas = [{ id: 'a', type: 'os.aberta', payload: evento }, { id: 'b', type: 'os.aberta', payload: evento }];
    const { publisher, outboxRepository } = criarPublisher(channel, linhas);

    const publicados = await publisher.publicarPendentes();

    expect(publicados).toBe(0);
    expect(outboxRepository.registrarFalha).toHaveBeenCalledWith('a', 'nack', { tx: true });
    expect(channel.publish).toHaveBeenCalledTimes(1);
  });

  it('não faz nada sem canal conectado', async () => {
    const { publisher, outboxRepository } = criarPublisher(null, []);

    expect(await publisher.publicarPendentes()).toBe(0);
    expect(outboxRepository.buscarPendentes).not.toHaveBeenCalled();
  });

  it('start/stop controlam o polling', () => {
    jest.useFakeTimers();
    const { publisher } = criarPublisher(fakeChannel(), []);
    const spy = jest.spyOn(publisher, 'publicarPendentes');

    publisher.start();
    publisher.start();
    jest.advanceTimersByTime(2500);
    publisher.stop();
    jest.advanceTimersByTime(2000);

    expect(spy).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });
});

describe('RabbitConnection', () => {
  function fakeAmqp() {
    const connection = new EventEmitter();
    const confirmChannel = new EventEmitter();
    connection.createConfirmChannel = jest.fn().mockResolvedValue(confirmChannel);
    connection.createChannel = jest.fn().mockResolvedValue(fakeChannel());
    connection.close = jest.fn().mockResolvedValue();
    return { amqp: { connect: jest.fn().mockResolvedValue(connection) }, connection, confirmChannel };
  }

  it('conecta, cria o canal de publicação e emite connected', async () => {
    const { amqp, confirmChannel } = fakeAmqp();
    const conn = new RabbitConnection({ url: 'amqp://x', amqp, logger: silentLogger });
    const onConnected = jest.fn();
    conn.on('connected', onConnected);

    await conn.connect();

    expect(amqp.connect).toHaveBeenCalledWith('amqp://x', { heartbeat: 30 });
    expect(conn.isConnected()).toBe(true);
    expect(conn.getPublishChannel()).toBe(confirmChannel);
    expect(onConnected).toHaveBeenCalled();
    await conn.createChannel();
    await conn.close();
    expect(conn.isConnected()).toBe(false);
  });

  it('reconecta quando a conexão cai ou falha', async () => {
    jest.useFakeTimers();
    const { amqp, connection } = fakeAmqp();
    amqp.connect.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const conn = new RabbitConnection({ url: 'amqp://x', amqp, reconnectDelayMs: 100, logger: silentLogger });

    await conn.connect();
    expect(conn.isConnected()).toBe(false);

    await jest.advanceTimersByTimeAsync(100);
    expect(conn.isConnected()).toBe(true);

    connection.emit('error', new Error('boom'));
    connection.emit('close');
    expect(conn.isConnected()).toBe(false);

    await jest.advanceTimersByTimeAsync(100);
    expect(amqp.connect).toHaveBeenCalledTimes(3);

    await conn.close();
    jest.useRealTimers();
  });

  it('createChannel falha sem conexão', async () => {
    const conn = new RabbitConnection({ url: 'amqp://x', amqp: {}, logger: silentLogger });
    await expect(conn.createChannel()).rejects.toThrow('RabbitMQ não conectado');
  });
});

describe('iniciarMensageria', () => {
  it('ao conectar configura a topologia com os eventos dos handlers e inicia o consumer', async () => {
    const channel = fakeChannel();
    const connection = new EventEmitter();
    connection.createConfirmChannel = jest.fn().mockResolvedValue(new EventEmitter());
    connection.createChannel = jest.fn().mockResolvedValue(channel);
    connection.close = jest.fn().mockResolvedValue();
    const amqp = { connect: jest.fn().mockResolvedValue(connection) };

    const mensageria = iniciarMensageria({
      url: 'amqp://x',
      handlers: { 'orcamento.gerado': jest.fn() },
      outboxRepository: {},
      unitOfWork: { run: jest.fn() },
      outboxIntervalMs: 60000,
      amqp,
      logger: silentLogger
    });

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(mensageria.isConnected()).toBe(true);
    expect(channel.bindQueue).toHaveBeenCalledWith('billing-service.events', 'oficina.events', 'orcamento.gerado');
    expect(channel.consume).toHaveBeenCalledWith('billing-service.events', expect.any(Function));

    await mensageria.stop();
    expect(connection.close).toHaveBeenCalled();
  });
});
