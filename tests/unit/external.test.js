const nock = require('nock');
const MercadoPagoGateway = require('../../src/infrastructure/external/mercadoPago.gateway');
const FakeMercadoPagoGateway = require('../../src/infrastructure/external/fakeMercadoPago.gateway');
const OsServiceClient = require('../../src/infrastructure/external/osService.client');
const NotificationService = require('../../src/infrastructure/external/notification.service');
const { validarAssinatura, montarManifesto, lerHeaderAssinatura, assinar, listarSegredos } = require('../../src/infrastructure/external/webhookSignature');
const { gerarLinks, tokenValido, gerarToken } = require('../../src/application/linkAprovacao');
const { GatewayPagamentoError, AssinaturaInvalidaError, NaoEncontradoError } = require('../../src/domain/errors');

const MP = 'https://api.mercadopago.com';

const orcamento = {
  id: 7,
  osId: 42,
  cliente: { nome: 'Maria', email: 'maria@email.com' },
  veiculo: { placa: 'ABC1D23' },
  valorTotal: 180,
  itens: [
    { tipo: 'SERVICO', referenciaId: 1, descricao: 'Troca de óleo', quantidade: 1, valorUnitario: 120, total: 120 },
    { tipo: 'PECA', referenciaId: 4, descricao: 'Filtro', quantidade: 2, valorUnitario: 30, total: 60 }
  ]
};

beforeAll(() => nock.disableNetConnect());
afterEach(() => nock.cleanAll());
afterAll(() => nock.enableNetConnect());

describe('MercadoPagoGateway (SDK oficial, HTTP mockado com nock)', () => {
  const gateway = new MercadoPagoGateway({
    accessToken: 'TEST-token',
    notificationUrl: 'https://alb.test/webhooks/mercadopago',
    backUrl: 'https://alb.test/obrigado'
  });

  it('exige access token', () => {
    expect(() => new MercadoPagoGateway({})).toThrow('MP_ACCESS_TOKEN');
  });

  it('cria a preferência do Checkout Pro com external_reference e idempotência', async () => {
    let corpo;
    const escopo = nock(MP, { reqheaders: { 'x-idempotency-key': 'preferencia-orcamento-7', authorization: 'Bearer TEST-token' } })
      .post('/checkout/preferences/', (body) => { corpo = body; return true; })
      .reply(201, { id: 'pref-123', init_point: 'https://mp/prod', sandbox_init_point: 'https://mp/sandbox' });

    const r = await gateway.criarPreferencia(orcamento, { idempotencyKey: 'preferencia-orcamento-7' });

    expect(r).toEqual({ preferenceId: 'pref-123', initPoint: 'https://mp/sandbox' });
    expect(corpo).toMatchObject({
      external_reference: '7',
      notification_url: 'https://alb.test/webhooks/mercadopago',
      back_urls: { success: 'https://alb.test/obrigado' },
      payer: { email: 'maria@email.com' },
      metadata: { os_id: 42, orcamento_id: 7 }
    });
    expect(corpo.items).toEqual([
      { id: 'SERVICO-1', title: 'Troca de óleo', quantity: 1, unit_price: 120, currency_id: 'BRL' },
      { id: 'PECA-4', title: 'Filtro', quantity: 2, unit_price: 30, currency_id: 'BRL' }
    ]);
    expect(escopo.isDone()).toBe(true);
  });

  it('usa o init_point de produção quando sandbox=false e funciona sem URLs opcionais', async () => {
    const producao = new MercadoPagoGateway({ accessToken: 'APP-token', sandbox: false });
    nock(MP).post('/checkout/preferences/', (b) => !b.notification_url && !b.back_urls).reply(201, { id: 'p', init_point: 'https://mp/prod' });

    expect((await producao.criarPreferencia(orcamento)).initPoint).toBe('https://mp/prod');
  });

  it('consulta o pagamento real', async () => {
    nock(MP).get('/v1/payments/9001').reply(200, {
      id: 9001, status: 'approved', status_detail: 'accredited', external_reference: '7', transaction_amount: 180
    });

    const r = await gateway.buscarPagamento('9001');

    expect(r).toMatchObject({ id: '9001', status: 'approved', statusDetail: 'accredited', externalReference: '7', valor: 180 });
  });

  it('estorna o valor total', async () => {
    nock(MP, { reqheaders: { 'x-idempotency-key': 'estorno-abc' } })
      .post('/v1/payments/9001/refunds')
      .reply(201, { id: 555, status: 'approved' });

    expect(await gateway.estornar('9001', { idempotencyKey: 'estorno-abc' })).toEqual({ refundId: '555', status: 'approved' });
  });

  it('converte erros do MP em GatewayPagamentoError', async () => {
    nock(MP).post('/checkout/preferences/').reply(400, { message: 'invalid items' });
    nock(MP).get('/v1/payments/1').reply(404, { message: 'Payment not found' });
    nock(MP).post('/v1/payments/1/refunds').reply(400, { message: 'cannot refund' });

    await expect(gateway.criarPreferencia(orcamento)).rejects.toThrow(GatewayPagamentoError);
    await expect(gateway.buscarPagamento('1')).rejects.toThrow(GatewayPagamentoError);
    await expect(gateway.estornar('1')).rejects.toThrow(GatewayPagamentoError);
  });
});

describe('FakeMercadoPagoGateway', () => {
  it('simula preferência, pagamento pelo id e estorno', async () => {
    const fake = new FakeMercadoPagoGateway({ baseUrl: 'http://billing' });

    expect(await fake.criarPreferencia({ id: 3 })).toEqual({ preferenceId: 'fake-pref-3', initPoint: 'http://billing/fake-checkout?orcamento=3' });
    expect(await fake.buscarPagamento('fake-3-approved')).toMatchObject({ status: 'approved', externalReference: '3' });
    expect(await fake.buscarPagamento('fake-3-rejected')).toMatchObject({ status: 'rejected', statusDetail: 'cc_rejected_other_reason' });
    expect((await fake.buscarPagamento('fake-3')).status).toBe('approved');
    expect((await fake.estornar('fake-3-approved')).refundId).toBe('fake-refund-fake-3-approved');
    expect(fake.estornos).toEqual(['fake-3-approved']);
    expect(new FakeMercadoPagoGateway().baseUrl).toBe('http://localhost:3001');
  });
});

describe('Assinatura do webhook (x-signature)', () => {
  const secret = 'segredo-webhook';
  const assinatura = (dataId, requestId, ts) => `ts=${ts},v1=${assinar(montarManifesto({ dataId, requestId, ts }), secret)}`;

  it('monta o manifesto como na documentação do MP', () => {
    expect(montarManifesto({ dataId: 'ABC123', requestId: 'req-1', ts: '1700' })).toBe('id:abc123;request-id:req-1;ts:1700;');
    expect(montarManifesto({ dataId: '12-34', ts: '1' })).toBe('id:12-34;ts:1;');
    expect(lerHeaderAssinatura('ts=1, v1=abc')).toEqual({ ts: '1', v1: 'abc' });
  });

  it('aceita assinatura válida', () => {
    expect(validarAssinatura({ xSignature: assinatura('9001', 'req-1', '1700000000'), xRequestId: 'req-1', dataId: '9001', secret })).toBe(true);
  });

  it.each([
    ['ausente', undefined],
    ['malformada', 'v1=abc'],
    ['com hash errado', 'ts=1700000000,v1=00ff'],
    ['de outro pagamento', assinatura('9999', 'req-1', '1700000000')]
  ])('rejeita assinatura %s', (_caso, xSignature) => {
    expect(() => validarAssinatura({ xSignature, xRequestId: 'req-1', dataId: '9001', secret })).toThrow(AssinaturaInvalidaError);
  });

  it('aceita qualquer uma de várias chaves separadas por vírgula (com espaços)', () => {
    const params = { xSignature: assinatura('9001', 'req-1', '1700000000'), xRequestId: 'req-1', dataId: '9001' };

    expect(validarAssinatura({ ...params, secret: `chave-antiga, ${secret}` })).toBe(true);
    expect(validarAssinatura({ ...params, secret: ['outra', secret] })).toBe(true);
    expect(() => validarAssinatura({ ...params, secret: 'a,b' })).toThrow(AssinaturaInvalidaError);
    expect(() => validarAssinatura({ ...params, secret: ' , ' })).toThrow('Nenhuma chave');
    expect(listarSegredos(' a , b ,, ')).toEqual(['a', 'b']);
  });

  it('rejeita notificação fora da janela de tempo', () => {
    const ts = '1700000000';
    const params = { xSignature: assinatura('1', 'r', ts), xRequestId: 'r', dataId: '1', secret, toleranciaSegundos: 300 };

    expect(validarAssinatura({ ...params, agora: 1700000000 * 1000 + 1000 })).toBe(true);
    expect(() => validarAssinatura({ ...params, agora: 1700000000 * 1000 + 600000 })).toThrow(/janela/);
  });
});

describe('Links de aprovação', () => {
  it('gera links assinados e valida o token por orçamento e ação', () => {
    const links = gerarLinks(7, { baseUrl: 'https://b', secret: 's' });
    const token = new URL(links.aprovar).searchParams.get('token');

    expect(links.aprovar).toMatch(/^https:\/\/b\/orcamentos\/7\/decisao\?acao=aprovar&token=/);
    expect(tokenValido('7', 'aprovar', token, 's')).toBe(true);
    expect(tokenValido('7', 'recusar', token, 's')).toBe(false);
    expect(tokenValido('8', 'aprovar', token, 's')).toBe(false);
    expect(tokenValido('7', 'aprovar', token, 'outro')).toBe(false);
    expect(tokenValido('7', 'excluir', gerarToken(7, 'excluir', 's'), 's')).toBe(false);
    expect(tokenValido('7', 'aprovar', undefined, 's')).toBe(false);
    expect(tokenValido('7', 'aprovar', token, undefined)).toBe(false);
    expect(() => gerarLinks(7, { baseUrl: 'https://b' })).toThrow('APPROVAL_LINK_SECRET');
  });
});

describe('OsServiceClient', () => {
  const client = new OsServiceClient({ baseUrl: 'http://api-service.os:3000', serviceToken: 'svc' });

  it('chama GET /internal/os/:id com o token de serviço', async () => {
    nock('http://api-service.os:3000', { reqheaders: { 'x-service-token': 'svc' } })
      .get('/internal/os/42')
      .reply(200, { id: 42, cliente: { email: 'a@b.com' } });

    expect((await client.buscarOs(42)).cliente.email).toBe('a@b.com');
  });

  it('trata 404, erro HTTP e URL ausente', async () => {
    nock('http://api-service.os:3000').get('/internal/os/1').reply(404, {});
    nock('http://api-service.os:3000').get('/internal/os/2').reply(500, {});

    await expect(client.buscarOs(1)).rejects.toThrow(NaoEncontradoError);
    await expect(client.buscarOs(2)).rejects.toThrow(/respondeu 500/);
    await expect(new OsServiceClient({}).buscarOs(1)).rejects.toThrow('OS_SERVICE_URL');
  });
});

describe('NotificationService', () => {
  const links = { aprovar: 'https://b/aprovar', recusar: 'https://b/recusar' };

  it('envia o orçamento por SMTP com itens, total e links', async () => {
    const sendMail = jest.fn().mockResolvedValue({ messageId: 'm1' });
    const transportFactory = jest.fn().mockReturnValue({ sendMail });
    const env = { SMTP_HOST: 'smtp', SMTP_PORT: '465', SMTP_SECURE: 'true', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'oficina@x.com' };
    const service = new NotificationService({ env, transportFactory });

    const r = await service.enviarOrcamento(orcamento, links);
    await service.enviarOrcamento(orcamento, links);

    expect(r).toEqual({ enviado: true, messageId: 'm1' });
    expect(transportFactory).toHaveBeenCalledTimes(1);
    expect(transportFactory).toHaveBeenCalledWith(expect.objectContaining({ host: 'smtp', port: 465, secure: true }));
    const email = sendMail.mock.calls[0][0];
    expect(email).toMatchObject({ from: 'oficina@x.com', to: 'maria@email.com' });
    expect(email.subject).toMatch(/OS #42/);
    expect(email.text).toContain('Filtro (2x)');
    expect(email.text).toContain('veículo ABC1D23');
    expect(email.text).toContain('Aprovar e pagar: https://b/aprovar');
  });

  it('sem SMTP registra o e-mail só em log', async () => {
    const service = new NotificationService({ env: {} });

    expect(await service.enviarOrcamento({ ...orcamento, veiculo: null, cliente: { email: 'x@y.com' } }, links)).toEqual({ enviado: false, fallback: true });
  });
});
