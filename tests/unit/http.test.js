process.env.MERCADOPAGO_MODE = 'fake';
process.env.MP_WEBHOOK_SECRET = 'segredo-webhook';
process.env.JWT_SECRET = 'jwt-teste';
process.env.APPROVAL_LINK_SECRET = 'links-teste';
process.env.PUBLIC_BASE_URL = 'https://billing.test';

jest.mock('../../src/infrastructure/repositories/orcamento.repository');
jest.mock('../../src/infrastructure/repositories/pagamento.repository');
jest.mock('../../src/infrastructure/repositories/outbox.repository');
jest.mock('../../src/infrastructure/repositories/processedEvents.repository');
jest.mock('../../src/infrastructure/database/unitOfWork');

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../src/server');
const OrcamentoRepository = require('../../src/infrastructure/repositories/orcamento.repository');
const PagamentoRepository = require('../../src/infrastructure/repositories/pagamento.repository');
const OutboxRepository = require('../../src/infrastructure/repositories/outbox.repository');
const UnitOfWork = require('../../src/infrastructure/database/unitOfWork');
const { gerarToken } = require('../../src/application/linkAprovacao');
const { assinar, montarManifesto } = require('../../src/infrastructure/external/webhookSignature');

const token = jwt.sign({ id: 1 }, 'jwt-teste');
const auth = { Authorization: `Bearer ${token}` };

const orcamento = {
  id: 1,
  osId: 42,
  status: 'PENDENTE',
  valorTotal: 180,
  cliente: { nome: 'Maria', email: 'maria@email.com' },
  itens: [{ tipo: 'SERVICO', referenciaId: 1, descricao: 'Óleo', quantidade: 1, valorUnitario: 180, total: 180 }]
};

function assinatura(dataId, requestId = 'req-1', ts = '1700000000') {
  return `ts=${ts},v1=${assinar(montarManifesto({ dataId, requestId, ts }), 'segredo-webhook')}`;
}

beforeEach(() => {
  jest.clearAllMocks();
  UnitOfWork.run = jest.fn((fn) => fn({ tx: true }));
  OutboxRepository.adicionar = jest.fn().mockResolvedValue();

  OrcamentoRepository.buscarPorId = jest.fn().mockResolvedValue({ ...orcamento });
  OrcamentoRepository.buscarPorOsId = jest.fn().mockResolvedValue({ ...orcamento });
  OrcamentoRepository.buscarParaAtualizar = jest.fn().mockResolvedValue({ ...orcamento });
  OrcamentoRepository.atualizarStatus = jest.fn(async (id, status, motivo) => ({ ...orcamento, status, motivo }));

  PagamentoRepository.buscarPorId = jest.fn().mockResolvedValue({ id: 5, status: 'PENDENTE' });
  PagamentoRepository.buscarPorOrcamentoId = jest.fn().mockResolvedValue(null);
  PagamentoRepository.criar = jest.fn(async (p) => ({ ...p, id: 5 }));
  PagamentoRepository.buscarPorOrcamentoParaAtualizar = jest.fn().mockResolvedValue({ id: 5, orcamentoId: 1, osId: 42, status: 'PENDENTE', valor: 180 });
  PagamentoRepository.atualizar = jest.fn(async (id, dados) => ({ id, ...dados }));
});

describe('Orçamentos', () => {
  it('exige JWT', async () => {
    expect((await request(app).get('/orcamentos/1')).status).toBe(401);
  });

  it('GET /orcamentos/:id e /orcamentos/os/:osId', async () => {
    const porId = await request(app).get('/orcamentos/1').set(auth);
    const porOs = await request(app).get('/orcamentos/os/42').set(auth);

    expect(porId.status).toBe(200);
    expect(porId.body).toMatchObject({ id: 1, osId: 42, pagamento: null });
    expect(porOs.body.id).toBe(1);
  });

  it('404 para orçamento inexistente', async () => {
    OrcamentoRepository.buscarPorId.mockResolvedValue(null);
    expect((await request(app).get('/orcamentos/9').set(auth)).status).toBe(404);
  });

  it('POST /aprovar devolve o link de pagamento e publica orcamento.aprovado', async () => {
    const res = await request(app).post('/orcamentos/1/aprovar').set(auth);

    expect(res.status).toBe(200);
    expect(res.body.initPoint).toBe('https://billing.test/fake-checkout?orcamento=1');
    expect(res.body.pagamento).toMatchObject({ status: 'PENDENTE', mpPreferenceId: 'fake-pref-1' });
    expect(OutboxRepository.adicionar.mock.calls[0][0].type).toBe('orcamento.aprovado');
  });

  it('POST /recusar com motivo; 409 quando já aprovado', async () => {
    const ok = await request(app).post('/orcamentos/1/recusar').set(auth).send({ motivo: 'caro' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'RECUSADO', motivo: 'caro' });

    OrcamentoRepository.buscarParaAtualizar.mockResolvedValue({ ...orcamento, status: 'APROVADO' });
    expect((await request(app).post('/orcamentos/1/recusar').set(auth)).status).toBe(409);
  });

  it('link do e-mail: aprovar redireciona para o checkout', async () => {
    const res = await request(app).get(`/orcamentos/1/decisao?acao=aprovar&token=${gerarToken(1, 'aprovar', 'links-teste')}`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://billing.test/fake-checkout?orcamento=1');
  });

  it('link do e-mail: recusar confirma; token inválido é 401', async () => {
    const recusa = await request(app).get(`/orcamentos/1/decisao?acao=recusar&token=${gerarToken(1, 'recusar', 'links-teste')}`);
    expect(recusa.status).toBe(200);
    expect(OrcamentoRepository.atualizarStatus).toHaveBeenCalledWith('1', 'RECUSADO', expect.stringMatching(/link do e-mail/), { tx: true });

    const invalido = await request(app).get(`/orcamentos/1/decisao?acao=aprovar&token=${gerarToken(1, 'recusar', 'links-teste')}`);
    expect(invalido.status).toBe(401);
  });

  it('link do e-mail: erro de domínio vira status HTTP', async () => {
    OrcamentoRepository.buscarParaAtualizar.mockResolvedValue({ ...orcamento, status: 'CANCELADO' });

    const res = await request(app).get(`/orcamentos/1/decisao?acao=recusar&token=${gerarToken(1, 'recusar', 'links-teste')}`);

    expect(res.status).toBe(409);
  });
});

describe('Pagamentos e webhook', () => {
  it('GET /pagamentos/:id', async () => {
    const res = await request(app).get('/pagamentos/5').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(5);

    PagamentoRepository.buscarPorId.mockResolvedValue(null);
    expect((await request(app).get('/pagamentos/9').set(auth)).status).toBe(404);
  });

  it('webhook com assinatura válida e pagamento aprovado publica pagamento.confirmado', async () => {
    const res = await request(app)
      .post('/webhooks/mercadopago?data.id=fake-1-approved&type=payment')
      .set('x-signature', assinatura('fake-1-approved'))
      .set('x-request-id', 'req-1')
      .send({ type: 'payment', action: 'payment.updated', data: { id: 'fake-1-approved' } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ recebido: true, resultado: 'confirmado' });
    expect(OutboxRepository.adicionar.mock.calls[0][0]).toMatchObject({ type: 'pagamento.confirmado', payload: { osId: 42 } });
  });

  it('webhook com assinatura inválida é 401 e não processa', async () => {
    const res = await request(app)
      .post('/webhooks/mercadopago?data.id=fake-1-approved&type=payment')
      .set('x-signature', assinatura('outro-id'))
      .set('x-request-id', 'req-1');

    expect(res.status).toBe(401);
    expect(PagamentoRepository.buscarPorOrcamentoParaAtualizar).not.toHaveBeenCalled();
  });

  it('notificação IPN legada (?topic=&id=) responde 200 sem validar nem processar', async () => {
    for (const topic of ['payment', 'merchant_order']) {
      const res = await request(app).post(`/webhooks/mercadopago?id=184674893524&topic=${topic}`).set('x-signature', 'ts=1,v1=qualquer');

      expect(res.status).toBe(200);
      expect(res.body.ignorado).toBe(`notificação IPN ${topic}`);
    }
    expect(PagamentoRepository.buscarPorOrcamentoParaAtualizar).not.toHaveBeenCalled();
  });

  it('webhook de outro tipo é ignorado com 200', async () => {
    const res = await request(app)
      .post('/webhooks/mercadopago')
      .set('x-signature', assinatura('m-1'))
      .set('x-request-id', 'req-1')
      .send({ type: 'merchant_order', data: { id: 'm-1' } });

    expect(res.status).toBe(200);
    expect(res.body.ignorado).toMatch(/merchant_order/);
  });

  it('webhook de pagamento desconhecido responde 200 para o MP não reenviar', async () => {
    PagamentoRepository.buscarPorOrcamentoParaAtualizar.mockResolvedValue(null);

    const res = await request(app)
      .post('/webhooks/mercadopago?data.id=fake-99-approved&type=payment')
      .set('x-signature', assinatura('fake-99-approved'))
      .set('x-request-id', 'req-1');

    expect(res.status).toBe(200);
    expect(res.body.ignorado).toMatch(/não encontrado/);
  });

  it('erro inesperado vira 500 (o MP reenvia)', async () => {
    PagamentoRepository.buscarPorOrcamentoParaAtualizar.mockRejectedValue(new Error('banco fora'));

    const res = await request(app)
      .post('/webhooks/mercadopago?data.id=fake-1-approved&type=payment')
      .set('x-signature', assinatura('fake-1-approved'))
      .set('x-request-id', 'req-1');

    expect(res.status).toBe(500);
  });

  describe('MP_WEBHOOK_SIGNATURE', () => {
    afterEach(() => { delete process.env.MP_WEBHOOK_SIGNATURE; });

    it('enforce (padrão): assinatura inválida é 401 e não processa', async () => {
      process.env.MP_WEBHOOK_SIGNATURE = 'enforce';

      const res = await request(app)
        .post('/webhooks/mercadopago?data.id=fake-1-approved&type=payment')
        .set('x-signature', 'ts=1700000000,v1=00ff')
        .set('x-request-id', 'req-1');

      expect(res.status).toBe(401);
      expect(PagamentoRepository.buscarPorOrcamentoParaAtualizar).not.toHaveBeenCalled();
    });

    it('warn: assinatura inválida ou ausente vira alerta e o pagamento é verificado na API do MP', async () => {
      process.env.MP_WEBHOOK_SIGNATURE = 'warn';

      const invalida = await request(app)
        .post('/webhooks/mercadopago?data.id=fake-1-approved&type=payment')
        .set('x-signature', 'ts=1700000000,v1=00ff')
        .set('x-request-id', 'req-1');
      const ausente = await request(app).post('/webhooks/mercadopago?data.id=fake-1-approved&type=payment');

      expect(invalida.status).toBe(200);
      expect(invalida.body.resultado).toBe('confirmado');
      expect(ausente.status).toBe(200);
      expect(PagamentoRepository.buscarPorOrcamentoParaAtualizar).toHaveBeenCalled();
    });

    it('warn: assinatura válida continua passando', async () => {
      process.env.MP_WEBHOOK_SIGNATURE = 'warn';

      const res = await request(app)
        .post('/webhooks/mercadopago?data.id=fake-1-approved&type=payment')
        .set('x-signature', assinatura('fake-1-approved'))
        .set('x-request-id', 'req-1');

      expect(res.body.resultado).toBe('confirmado');
    });

    it('warn não engole erros que não são de assinatura', async () => {
      process.env.MP_WEBHOOK_SIGNATURE = 'warn';
      PagamentoRepository.buscarPorOrcamentoParaAtualizar.mockRejectedValue(new Error('banco fora'));

      const res = await request(app).post('/webhooks/mercadopago?data.id=fake-1-approved&type=payment');

      expect(res.status).toBe(500);
    });
  });

  it('sem MP_WEBHOOK_SECRET o webhook é recusado fora do modo fake', async () => {
    process.env.MP_WEBHOOK_SECRET = '';
    process.env.MERCADOPAGO_MODE = 'real';

    const res = await request(app).post('/webhooks/mercadopago?data.id=1&type=payment');

    expect(res.status).toBe(401);
    process.env.MP_WEBHOOK_SECRET = 'segredo-webhook';
    process.env.MERCADOPAGO_MODE = 'fake';
  });
});

describe('httpErrors', () => {
  it('mapeia GatewayPagamentoError para 502', () => {
    const { statusDoErro } = require('../../src/interfaces/httpErrors');
    const { GatewayPagamentoError } = require('../../src/domain/errors');
    expect(statusDoErro(new GatewayPagamentoError('x'))).toBe(502);
  });
});
