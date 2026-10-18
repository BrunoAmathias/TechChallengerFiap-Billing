const path = require('node:path');
const { loadFeature, defineFeature } = require('jest-cucumber');
const { GerarOrcamento, AprovarOrcamento, RecusarOrcamento } = require('../../src/application/orcamento.service');
const { ProcessarWebhookPagamento, EstornarPagamento } = require('../../src/application/pagamento.service');
const { criarHandlers } = require('../../src/application/handlers');
const { criarFakes, payloadOsAberta, evento } = require('../unit/fakes');

const feature = loadFeature(path.join(__dirname, 'saga-billing.feature'));
const brl = (texto) => Number(texto.replace(/[^\d,]/g, '').replace(',', '.'));

/** Billing com banco, Mercado Pago, e-mail e broker em memória. */
function criarMundo() {
  const { db, deps } = criarFakes();
  const notificationService = { enviarOrcamento: jest.fn().mockResolvedValue({ enviado: true }) };
  const links = { baseUrl: 'https://billing.test', secret: 'segredo-bdd' };
  const useCases = {
    gerarOrcamento: new GerarOrcamento({ ...deps, notificationService, osServiceClient: null, links }),
    aprovarOrcamento: new AprovarOrcamento(deps),
    recusarOrcamento: new RecusarOrcamento(deps),
    processarWebhook: new ProcessarWebhookPagamento(deps),
    estornarPagamento: new EstornarPagamento(deps)
  };
  const handlers = criarHandlers(useCases);

  return {
    db,
    deps,
    notificationService,
    useCases,
    publicar: (type, payload, source) => handlers[type](evento(type, payload, source)),
    orcamento: () => db.orcamentos[0],
    pagamento: () => db.pagamentos[0],
    eventos: (type) => db.outbox.filter((e) => e.type === type),
    async notificarMp(statusMp, valor) {
      deps.gateway.buscarPagamento.mockResolvedValue({
        id: '9001', status: statusMp, statusDetail: 'detalhe', externalReference: String(db.orcamentos[0].id),
        valor, moeda: 'BRL', raw: {}
      });
      return useCases.processarWebhook.execute({ paymentId: '9001' });
    }
  };
}

defineFeature(feature, (test) => {
  let mundo;

  const contexto = (given) =>
    given(/^que o OS Service publicou "os.aberta" com total de R\$ (.*) para "(.*)"$/, async (valor, email) => {
      mundo = criarMundo();
      const payload = payloadOsAberta({ cliente: { id: 1, nome: 'Maria', email } });
      expect(payload.valorTotal).toBe(brl(valor));
      await mundo.publicar('os.aberta', payload, 'os-service');
    });

  const orcamentoFica = (step) => step(/^o orçamento fica "(.*)"$/, (status) => expect(mundo.orcamento().status).toBe(status));
  const pagamentoFica = (step) => step(/^o pagamento fica "(.*)"$/, (status) => expect(mundo.pagamento().status).toBe(status));
  const eventoPublicado = (step) => step(/^o evento "(.*)" é publicado$/, (type) => {
    const eventos = mundo.eventos(type);
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({ source: 'billing-service', correlationId: '42', payload: { osId: 42 } });
  });
  const notificaMp = (step) =>
    step(/^o Mercado Pago notifica o pagamento como "(.*)" no valor de R\$ (.*)$/, (statusMp, valor) => mundo.notificarMp(statusMp, brl(valor)));
  const aprovou = (step) => step('que o cliente aprovou o orçamento', () => mundo.useCases.aprovarOrcamento.execute(1));

  test('Orçamento aprovado e pago', ({ given, then, and, when }) => {
    contexto(given);
    then(/^um orçamento "(.*)" de R\$ (.*) é criado$/, (status, valor) => {
      expect(mundo.orcamento()).toMatchObject({ status, valorTotal: brl(valor) });
    });
    eventoPublicado(and);
    and('o cliente recebe o e-mail com os links de aprovar e recusar', () => {
      const [, links] = mundo.notificationService.enviarOrcamento.mock.calls[0];
      expect(links.aprovar).toContain('acao=aprovar');
      expect(links.recusar).toContain('acao=recusar');
    });
    when('o cliente aprova o orçamento', () => mundo.useCases.aprovarOrcamento.execute(1));
    orcamentoFica(then);
    and('o checkout do Mercado Pago é criado', () => {
      expect(mundo.deps.gateway.criarPreferencia).toHaveBeenCalledTimes(1);
      expect(mundo.pagamento()).toMatchObject({ status: 'PENDENTE', mpPreferenceId: 'pref-1' });
    });
    eventoPublicado(and);
    notificaMp(when);
    pagamentoFica(then);
    and(/^o evento "(.*)" é publicado com os serviços e peças da OS$/, (type) => {
      const [confirmado] = mundo.eventos(type);
      expect(confirmado.payload.servicos).toEqual([{ servicoId: 1, nome: 'Troca de óleo', quantidade: 1 }]);
      expect(confirmado.payload.pecas).toEqual([{ pecaId: 4, nome: 'Filtro', quantidade: 2 }]);
    });
  });

  test('Cliente recusa o orçamento', ({ given, when, then, and }) => {
    contexto(given);
    when('o cliente recusa o orçamento', () => mundo.useCases.recusarOrcamento.execute(1, 'achou caro'));
    orcamentoFica(then);
    eventoPublicado(and);
  });

  test('Pagamento rejeitado pelo Mercado Pago', ({ given, and, when, then }) => {
    contexto(given);
    aprovou(and);
    notificaMp(when);
    pagamentoFica(then);
    orcamentoFica(and);
    eventoPublicado(and);
  });

  test('Pagamento com valor diferente do orçamento não é confirmado', ({ given, and, when, then }) => {
    contexto(given);
    aprovou(and);
    notificaMp(when);
    pagamentoFica(then);
    and('nenhum evento de pagamento é publicado', () => {
      expect(mundo.db.outbox.filter((e) => e.type.startsWith('pagamento.'))).toHaveLength(0);
    });
  });

  test('Falha na execução estorna o pagamento', ({ given, and, when, then }) => {
    contexto(given);
    and('que o cliente aprovou e pagou o orçamento', async () => {
      await mundo.useCases.aprovarOrcamento.execute(1);
      await mundo.notificarMp('approved', 180);
      expect(mundo.pagamento().status).toBe('APROVADO');
    });
    when(/^o Execution publica "(.*)"$/, (type) => mundo.publicar(type, { osId: 42, motivo: 'Peça indisponível' }, 'execution-service'));
    then('o Mercado Pago recebe o pedido de estorno', () => {
      expect(mundo.deps.gateway.estornar).toHaveBeenCalledWith('9001', expect.objectContaining({ idempotencyKey: expect.stringMatching(/^estorno-/) }));
    });
    pagamentoFica(and);
    orcamentoFica(and);
    eventoPublicado(and);
  });
});
