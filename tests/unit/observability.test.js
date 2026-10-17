jest.mock('newrelic', () => ({
  getTransaction: jest.fn(),
  getTraceMetadata: jest.fn(),
  startBackgroundTransaction: jest.fn((nome, grupo, fn) => fn()),
  addCustomAttributes: jest.fn(),
  recordCustomEvent: jest.fn(),
  noticeError: jest.fn()
}));

const newrelic = require('newrelic');
const {
  capturarContextoTrace,
  cabecalhosDoEvento,
  processarComTrace
} = require('../../src/infrastructure/observability/tracing');
const { criarEvento, SOURCE } = require('../../src/application/events/eventFactory');
const EventConsumer = require('../../src/infrastructure/messaging/consumer');
const OutboxPublisher = require('../../src/infrastructure/messaging/outbox.publisher');

const silentLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const CABECALHOS = { traceparent: '00-abc-def-01', tracestate: 'nr=1', newrelic: 'eyJ2Ijp9' };

function transacao({ inserir = CABECALHOS, lancar = false } = {}) {
  return {
    insertDistributedTraceHeaders: jest.fn((headers) => {
      if (lancar) throw new Error('sem agente');
      Object.assign(headers, inserir, { outro: 'ignorado' });
    }),
    acceptDistributedTraceHeaders: jest.fn()
  };
}

function mensagem(evento, headers = {}) {
  return {
    content: Buffer.from(JSON.stringify(evento)),
    properties: { headers, messageId: evento.eventId, correlationId: evento.correlationId, type: evento.type, contentType: 'application/json' }
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  newrelic.getTransaction.mockReturnValue(transacao({ inserir: {} }));
  newrelic.getTraceMetadata.mockReturnValue({ traceId: '', spanId: '' });
});

describe('contexto do trace distribuído', () => {
  it('captura só os cabeçalhos de trace da transação atual', () => {
    newrelic.getTransaction.mockReturnValue(transacao());

    expect(capturarContextoTrace()).toEqual(CABECALHOS);
  });

  it('retorna undefined sem transação ativa ou se o agente falhar', () => {
    expect(capturarContextoTrace()).toBeUndefined();

    newrelic.getTransaction.mockReturnValue(transacao({ lancar: true }));
    expect(capturarContextoTrace()).toBeUndefined();
  });

  it('criarEvento guarda o traceContext no envelope quando há trace', () => {
    newrelic.getTransaction.mockReturnValue(transacao());
    expect(criarEvento('teste.ocorreu', {}, { correlationId: 1 }).traceContext).toEqual(CABECALHOS);

    newrelic.getTransaction.mockReturnValue(transacao({ inserir: {} }));
    expect(criarEvento('teste.ocorreu', {}, { correlationId: 1 })).not.toHaveProperty('traceContext');
  });

  it('cabecalhosDoEvento devolve os cabeçalhos do envelope ou objeto vazio', () => {
    expect(cabecalhosDoEvento({ traceContext: { ...CABECALHOS, extra: 'x' } })).toEqual(CABECALHOS);
    expect(cabecalhosDoEvento({})).toEqual({});
    expect(cabecalhosDoEvento(undefined)).toEqual({});
  });
});

describe('processarComTrace', () => {
  const evento = { eventId: 'e1', type: 'os.aberta', correlationId: 7, source: 'os-service', traceContext: CABECALHOS };

  it('abre uma transação de background que continua o trace de quem publicou', async () => {
    const tx = transacao();
    newrelic.getTransaction.mockReturnValue(tx);

    const resultado = await processarComTrace(evento, { tentativa: 1 }, async () => 'ok');

    expect(resultado).toBe('ok');
    expect(newrelic.startBackgroundTransaction).toHaveBeenCalledWith('Consumir/os.aberta', 'RabbitMQ', expect.any(Function));
    expect(tx.acceptDistributedTraceHeaders).toHaveBeenCalledWith('AMQP', CABECALHOS);
    expect(newrelic.addCustomAttributes).toHaveBeenCalledWith({
      eventId: 'e1',
      eventType: 'os.aberta',
      osId: '7',
      origem: 'os-service',
      tentativa: 1
    });
  });

  it('não aceita cabeçalhos quando o evento não tem traceContext', async () => {
    const tx = transacao();
    newrelic.getTransaction.mockReturnValue(tx);

    await processarComTrace({ ...evento, traceContext: undefined, source: undefined }, {}, async () => null);

    expect(tx.acceptDistributedTraceHeaders).not.toHaveBeenCalled();
    expect(newrelic.addCustomAttributes).toHaveBeenCalledWith(expect.objectContaining({ origem: '' }));
  });

  it('reutiliza a transação aberta pela instrumentação automática do amqplib', async () => {
    newrelic.getTraceMetadata.mockReturnValue({ traceId: 'trace-1', spanId: 'span-1' });

    await processarComTrace(evento, {}, async () => null);

    expect(newrelic.startBackgroundTransaction).not.toHaveBeenCalled();
    expect(newrelic.addCustomAttributes).toHaveBeenCalled();
  });
});

describe('EventConsumer: telemetria da saga', () => {
  const evento = criarEvento('teste.ocorreu', {}, { correlationId: 10 });

  function consumer(handler, maxTentativas = 3) {
    const channel = { ack: jest.fn(), nack: jest.fn(), sendToQueue: jest.fn() };
    const instancia = new EventConsumer({
      channel,
      queue: 'servico.events',
      handlers: { 'teste.ocorreu': handler },
      maxTentativas,
      logger: silentLogger
    });
    return { channel, instancia };
  }

  it('registra SagaEvento "processado" com resultado, duração e latência', async () => {
    const { channel, instancia } = consumer(jest.fn().mockResolvedValue({ resultado: 'APLICADO' }));

    await instancia.onMessage(mensagem(evento));

    expect(channel.ack).toHaveBeenCalled();
    expect(newrelic.recordCustomEvent).toHaveBeenCalledWith('SagaEvento', expect.objectContaining({
      servico: SOURCE,
      eventType: 'teste.ocorreu',
      eventId: evento.eventId,
      osId: '10',
      status: 'processado',
      tentativa: 1,
      resultado: 'APLICADO',
      duracaoMs: expect.any(Number),
      latenciaMs: expect.any(Number)
    }));
  });

  it('usa "ok" quando o handler não informa resultado e latência 0 com data inválida', async () => {
    const { instancia } = consumer(jest.fn().mockResolvedValue(undefined));

    await instancia.onMessage(mensagem({ ...evento, occurredAt: 'data-invalida' }));

    expect(newrelic.recordCustomEvent).toHaveBeenCalledWith('SagaEvento', expect.objectContaining({ resultado: 'ok', latenciaMs: 0 }));
  });

  it('notifica o erro e registra "retry" quando o handler falha', async () => {
    const erro = new Error('falhou');
    const { instancia } = consumer(jest.fn().mockRejectedValue(erro));

    await instancia.onMessage(mensagem(evento));

    expect(newrelic.noticeError).toHaveBeenCalledWith(erro, { eventId: evento.eventId, eventType: 'teste.ocorreu', tentativa: 1 });
    expect(newrelic.recordCustomEvent).toHaveBeenCalledWith('SagaEvento', expect.objectContaining({ status: 'retry', tentativa: 1, erro: 'falhou' }));
  });

  it('registra "dlq" quando as tentativas se esgotam', async () => {
    const { channel, instancia } = consumer(jest.fn().mockRejectedValue(new Error('de novo')));

    await instancia.onMessage(mensagem(evento, { 'x-retry-count': 2 }));

    expect(channel.nack).toHaveBeenCalledWith(expect.anything(), false, false);
    expect(newrelic.recordCustomEvent).toHaveBeenCalledWith('SagaEvento', expect.objectContaining({ status: 'dlq', tentativa: 3, erro: 'de novo' }));
  });
});

describe('OutboxPublisher: propagação do trace', () => {
  it('publica os cabeçalhos de trace do envelope nos headers da mensagem', async () => {
    const channel = { publish: jest.fn((exchange, rk, content, options, cb) => cb(null)) };
    const publisher = new OutboxPublisher({ outboxRepository: {}, unitOfWork: {}, getChannel: () => channel, logger: silentLogger });
    const evento = { ...criarEvento('teste.ocorreu', {}, { correlationId: 1 }), traceContext: CABECALHOS };

    await publisher.publicar(channel, evento);

    const options = channel.publish.mock.calls[0][3];
    expect(options.headers).toEqual({ source: SOURCE, version: 1, ...CABECALHOS });
  });
});
