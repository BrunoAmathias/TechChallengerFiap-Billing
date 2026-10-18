const { GerarOrcamento, AprovarOrcamento, RecusarOrcamento, BuscarOrcamento, RESULTADO } = require('../../src/application/orcamento.service');
const {
  ProcessarWebhookPagamento,
  EstornarPagamento,
  ExpirarPagamentosPendentes,
  BuscarPagamento,
  RESULTADO: RESULTADO_PAG,
  itensParaExecucao
} = require('../../src/application/pagamento.service');
const { criarHandlers } = require('../../src/application/handlers');
const { NaoEncontradoError, TransicaoInvalidaError, GatewayPagamentoError } = require('../../src/domain/errors');
const { criarFakes, payloadOsAberta, evento } = require('./fakes');

const links = { baseUrl: 'https://billing.test', secret: 'segredo' };

function montar() {
  const { db, deps } = criarFakes();
  const notificationService = { enviarOrcamento: jest.fn().mockResolvedValue({ enviado: true }) };
  const osServiceClient = { buscarOs: jest.fn() };
  const useCases = {
    gerarOrcamento: new GerarOrcamento({ ...deps, notificationService, osServiceClient, links }),
    aprovarOrcamento: new AprovarOrcamento(deps),
    recusarOrcamento: new RecusarOrcamento(deps),
    buscarOrcamento: new BuscarOrcamento(deps),
    processarWebhook: new ProcessarWebhookPagamento(deps),
    estornarPagamento: new EstornarPagamento(deps),
    expirar: new ExpirarPagamentosPendentes({ ...deps, prazoMinutos: 30 }),
    buscarPagamento: new BuscarPagamento(deps)
  };
  return { db, deps, notificationService, osServiceClient, useCases, handlers: criarHandlers(useCases) };
}

async function comOrcamentoAprovado() {
  const ctx = montar();
  await ctx.handlers['os.aberta'](evento('os.aberta', payloadOsAberta()));
  await ctx.useCases.aprovarOrcamento.execute(1);
  ctx.db.outbox.length = 0;
  return ctx;
}

describe('GerarOrcamento (os.aberta)', () => {
  it('cria o orçamento PENDENTE, publica orcamento.gerado e envia o e-mail com os links', async () => {
    const { db, handlers, notificationService } = montar();
    const e = evento('os.aberta', payloadOsAberta());

    const r = await handlers['os.aberta'](e);

    expect(r.resultado).toBe(RESULTADO.CRIADO);
    expect(db.orcamentos[0]).toMatchObject({ osId: 42, status: 'PENDENTE', valorTotal: 180 });
    expect(db.outbox[0]).toMatchObject({
      type: 'orcamento.gerado',
      source: 'billing-service',
      correlationId: '42',
      causationId: e.eventId,
      payload: { osId: 42, orcamentoId: 1, valorTotal: 180, quantidadeItens: 2 }
    });
    expect(db.outbox[0].payload.linkAprovacao).toMatch(/^https:\/\/billing\.test\/orcamentos\/1\/decisao\?acao=aprovar&token=[0-9a-f]{64}$/);

    const [orcamento, linksEmail] = notificationService.enviarOrcamento.mock.calls[0];
    expect(orcamento.id).toBe(1);
    expect(linksEmail.recusar).toContain('acao=recusar');
  });

  it('publica orcamento.falhou quando a OS não pode ser orçada (sem e-mail para retry)', async () => {
    const { db, handlers, notificationService } = montar();

    const r = await handlers['os.aberta'](evento('os.aberta', payloadOsAberta({ servicos: [], pecas: [] })));

    expect(r.resultado).toBe(RESULTADO.FALHOU);
    expect(db.orcamentos).toHaveLength(0);
    expect(db.outbox[0]).toMatchObject({ type: 'orcamento.falhou', payload: { osId: 42, motivo: expect.stringMatching(/sem serviços/) } });
    expect(notificationService.enviarOrcamento).not.toHaveBeenCalled();
  });

  it('ignora evento duplicado e OS que já tem orçamento', async () => {
    const { db, handlers } = montar();
    const e = evento('os.aberta', payloadOsAberta());

    await handlers['os.aberta'](e);
    expect((await handlers['os.aberta'](e)).resultado).toBe(RESULTADO.DUPLICADO);
    expect((await handlers['os.aberta'](evento('os.aberta', payloadOsAberta()))).resultado).toBe(RESULTADO.JA_EXISTE);
    expect(db.orcamentos).toHaveLength(1);
    expect(db.outbox).toHaveLength(1);
  });

  it('busca o cliente no OS Service (GET /internal/os/:id) quando o evento não traz e-mail', async () => {
    const { db, handlers, osServiceClient } = montar();
    osServiceClient.buscarOs.mockResolvedValue({ cliente: { nome: 'Maria', email: 'maria@os.com' }, veiculo: { placa: 'XYZ' } });

    await handlers['os.aberta'](evento('os.aberta', payloadOsAberta({ cliente: { id: 1 }, veiculo: undefined })));

    expect(osServiceClient.buscarOs).toHaveBeenCalledWith(42);
    expect(db.orcamentos[0].cliente.email).toBe('maria@os.com');
    expect(db.orcamentos[0].veiculo.placa).toBe('XYZ');
  });

  it('não desfaz o orçamento quando o e-mail falha', async () => {
    const { db, handlers, notificationService } = montar();
    notificationService.enviarOrcamento.mockRejectedValue(new Error('SMTP fora'));

    const r = await handlers['os.aberta'](evento('os.aberta', payloadOsAberta()));

    expect(r.resultado).toBe(RESULTADO.CRIADO);
    expect(db.outbox[0].type).toBe('orcamento.gerado');
  });

  it('propaga erro inesperado para o retry do consumer', async () => {
    const { deps, handlers } = montar();
    deps.orcamentoRepository.criar.mockRejectedValueOnce(new Error('conexão perdida'));

    await expect(handlers['os.aberta'](evento('os.aberta', payloadOsAberta()))).rejects.toThrow('conexão perdida');
  });
});

describe('AprovarOrcamento / RecusarOrcamento', () => {
  it('aprova: cria a preferência no MP, o pagamento PENDENTE e publica orcamento.aprovado', async () => {
    const { db, deps, handlers, useCases } = montar();
    await handlers['os.aberta'](evento('os.aberta', payloadOsAberta()));

    const r = await useCases.aprovarOrcamento.execute(1);

    expect(deps.gateway.criarPreferencia).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), { idempotencyKey: 'preferencia-orcamento-1' });
    expect(r.initPoint).toBe('https://mp.test/checkout/1');
    expect(db.orcamentos[0].status).toBe('APROVADO');
    expect(db.pagamentos[0]).toMatchObject({ orcamentoId: 1, osId: 42, status: 'PENDENTE', valor: 180, mpPreferenceId: 'pref-1' });
    expect(db.outbox.at(-1)).toMatchObject({ type: 'orcamento.aprovado', payload: { osId: 42, orcamentoId: 1, pagamentoId: 1 } });
  });

  it('aprovar de novo devolve o mesmo link sem nova preferência', async () => {
    const { deps, useCases } = await comOrcamentoAprovado();

    const r = await useCases.aprovarOrcamento.execute(1);

    expect(r.initPoint).toBe('https://mp.test/checkout/1');
    expect(deps.gateway.criarPreferencia).toHaveBeenCalledTimes(1);
  });

  it('não altera nada se o Mercado Pago falhar', async () => {
    const { db, deps, handlers, useCases } = montar();
    await handlers['os.aberta'](evento('os.aberta', payloadOsAberta()));
    deps.gateway.criarPreferencia.mockRejectedValue(new GatewayPagamentoError('MP fora'));

    await expect(useCases.aprovarOrcamento.execute(1)).rejects.toThrow(GatewayPagamentoError);
    expect(db.orcamentos[0].status).toBe('PENDENTE');
    expect(db.pagamentos).toHaveLength(0);
  });

  it('detecta recusa concorrente durante a criação da preferência', async () => {
    const { db, deps, handlers, useCases } = montar();
    await handlers['os.aberta'](evento('os.aberta', payloadOsAberta()));
    deps.gateway.criarPreferencia.mockImplementation(async () => {
      db.orcamentos[0].status = 'RECUSADO';
      return { preferenceId: 'p', initPoint: 'i' };
    });

    await expect(useCases.aprovarOrcamento.execute(1)).rejects.toThrow(TransicaoInvalidaError);
    expect(db.pagamentos).toHaveLength(0);
  });

  it('recusa: RECUSADO + orcamento.recusado; repetir não publica de novo', async () => {
    const { db, handlers, useCases } = montar();
    await handlers['os.aberta'](evento('os.aberta', payloadOsAberta()));

    await useCases.recusarOrcamento.execute(1, 'achou caro');
    await useCases.recusarOrcamento.execute(1, 'achou caro');

    expect(db.orcamentos[0]).toMatchObject({ status: 'RECUSADO', motivo: 'achou caro' });
    expect(db.outbox.filter((e) => e.type === 'orcamento.recusado')).toHaveLength(1);
    expect(db.outbox.at(-1).payload).toEqual({ osId: 42, orcamentoId: 1, motivo: 'achou caro' });
  });

  it('não recusa orçamento aprovado nem aprova orçamento recusado', async () => {
    const { useCases } = await comOrcamentoAprovado();
    await expect(useCases.recusarOrcamento.execute(1)).rejects.toThrow(TransicaoInvalidaError);

    const outro = montar();
    await outro.handlers['os.aberta'](evento('os.aberta', payloadOsAberta()));
    await outro.useCases.recusarOrcamento.execute(1);
    await expect(outro.useCases.aprovarOrcamento.execute(1)).rejects.toThrow(TransicaoInvalidaError);
  });

  it('404 para orçamento inexistente', async () => {
    const { useCases } = montar();
    await expect(useCases.aprovarOrcamento.execute(9)).rejects.toThrow(NaoEncontradoError);
    await expect(useCases.recusarOrcamento.execute(9)).rejects.toThrow(NaoEncontradoError);
    await expect(useCases.buscarOrcamento.porId(9)).rejects.toThrow(NaoEncontradoError);
    await expect(useCases.buscarOrcamento.porOs(9)).rejects.toThrow(NaoEncontradoError);
    await expect(useCases.buscarPagamento.execute(9)).rejects.toThrow(NaoEncontradoError);
  });

  it('consultas devolvem o orçamento com o pagamento', async () => {
    const { useCases } = await comOrcamentoAprovado();

    expect((await useCases.buscarOrcamento.porId(1)).pagamento.status).toBe('PENDENTE');
    expect((await useCases.buscarOrcamento.porOs(42)).id).toBe(1);
    expect((await useCases.buscarPagamento.execute(1)).orcamentoId).toBe(1);
  });
});

describe('ProcessarWebhookPagamento', () => {
  const mp = (status, extra = {}) => ({ id: '9001', status, statusDetail: 'detalhe', externalReference: '1', raw: { status }, ...extra });

  it('approved → APROVADO + pagamento.confirmado com os itens para o Execution', async () => {
    const { db, deps, useCases } = await comOrcamentoAprovado();
    deps.gateway.buscarPagamento.mockResolvedValue(mp('approved'));

    const r = await useCases.processarWebhook.execute({ paymentId: '9001' });

    expect(r.resultado).toBe(RESULTADO_PAG.CONFIRMADO);
    expect(db.pagamentos[0]).toMatchObject({ status: 'APROVADO', mpPaymentId: '9001' });
    expect(db.outbox[0]).toMatchObject({
      type: 'pagamento.confirmado',
      payload: {
        osId: 42,
        orcamentoId: 1,
        pagamentoId: 1,
        mpPaymentId: '9001',
        valor: 180,
        servicos: [{ servicoId: 1, nome: 'Troca de óleo', quantidade: 1 }],
        pecas: [{ pecaId: 4, nome: 'Filtro', quantidade: 2 }]
      }
    });
  });

  it.each([
    ['valor diferente do orçamento', { valor: 1 }, { motivo: 'valor', esperado: 180, recebido: 1 }],
    ['moeda diferente de BRL', { valor: 180, moeda: 'USD' }, { motivo: 'moeda', esperado: 'BRL', recebido: 'USD' }]
  ])('não confirma pagamento aprovado com %s (fica PENDENTE, sem evento)', async (_caso, extra, divergencia) => {
    const { db, deps, useCases } = await comOrcamentoAprovado();
    deps.gateway.buscarPagamento.mockResolvedValue(mp('approved', extra));

    const r = await useCases.processarWebhook.execute({ paymentId: '9001' });

    expect(r.resultado).toBe(RESULTADO_PAG.VALOR_DIVERGENTE);
    expect(r.divergencia).toEqual(divergencia);
    expect(db.pagamentos[0].status).toBe('PENDENTE');
    expect(db.outbox).toHaveLength(0);
  });

  it('confirma quando valor (com tolerância de centavo) e moeda batem', async () => {
    const { db, deps, useCases } = await comOrcamentoAprovado();
    deps.gateway.buscarPagamento.mockResolvedValue(mp('approved', { valor: 180.004, moeda: 'BRL' }));

    expect((await useCases.processarWebhook.execute({ paymentId: '9001' })).resultado).toBe(RESULTADO_PAG.CONFIRMADO);
    expect(db.outbox[0].type).toBe('pagamento.confirmado');
  });

  it('notificação repetida não publica de novo', async () => {
    const { db, deps, useCases } = await comOrcamentoAprovado();
    deps.gateway.buscarPagamento.mockResolvedValue(mp('approved'));

    await useCases.processarWebhook.execute({ paymentId: '9001' });
    const r = await useCases.processarWebhook.execute({ paymentId: '9001' });

    expect(r.resultado).toBe(RESULTADO_PAG.DUPLICADO);
    expect(db.outbox).toHaveLength(1);
  });

  it('rejected → REJEITADO, orçamento CANCELADO e pagamento.falhou', async () => {
    const { db, deps, useCases } = await comOrcamentoAprovado();
    deps.gateway.buscarPagamento.mockResolvedValue(mp('rejected', { statusDetail: 'cc_rejected_insufficient_amount' }));

    const r = await useCases.processarWebhook.execute({ paymentId: '9001' });

    expect(r.resultado).toBe(RESULTADO_PAG.FALHOU);
    expect(db.pagamentos[0].status).toBe('REJEITADO');
    expect(db.orcamentos[0].status).toBe('CANCELADO');
    expect(db.outbox[0]).toMatchObject({ type: 'pagamento.falhou', payload: { osId: 42, motivo: expect.stringMatching(/insufficient_amount/) } });
  });

  it('pending/in_process não muda o pagamento nem publica evento', async () => {
    const { db, deps, useCases } = await comOrcamentoAprovado();
    deps.gateway.buscarPagamento.mockResolvedValue(mp('in_process'));

    const r = await useCases.processarWebhook.execute({ paymentId: '9001' });

    expect(r.resultado).toBe(RESULTADO_PAG.DUPLICADO);
    expect(db.outbox).toHaveLength(0);
  });

  it('refunded pelo painel do MP → ESTORNADO + pagamento.estornado', async () => {
    const { db, deps, useCases } = await comOrcamentoAprovado();
    deps.gateway.buscarPagamento.mockResolvedValueOnce(mp('approved')).mockResolvedValueOnce(mp('refunded'));

    await useCases.processarWebhook.execute({ paymentId: '9001' });
    const r = await useCases.processarWebhook.execute({ paymentId: '9001' });

    expect(r.resultado).toBe(RESULTADO_PAG.ESTORNADO);
    expect(db.outbox.at(-1)).toMatchObject({ type: 'pagamento.estornado', payload: { origem: 'mercadopago' } });
  });

  it('aprovado seguido de status inesperado só atualiza os dados', async () => {
    const { deps, useCases } = await comOrcamentoAprovado();
    deps.gateway.buscarPagamento.mockResolvedValueOnce(mp('approved')).mockResolvedValueOnce(mp('rejected'));

    await useCases.processarWebhook.execute({ paymentId: '9001' });
    const r = await useCases.processarWebhook.execute({ paymentId: '9001' });

    expect(r.resultado).toBe(RESULTADO_PAG.ATUALIZADO);
  });

  it('ignora pagamento sem external_reference e falha para orçamento desconhecido', async () => {
    const { deps, useCases } = await comOrcamentoAprovado();

    deps.gateway.buscarPagamento.mockResolvedValue(mp('approved', { externalReference: null }));
    expect((await useCases.processarWebhook.execute({ paymentId: 'x' })).resultado).toBe(RESULTADO_PAG.IGNORADO);

    deps.gateway.buscarPagamento.mockResolvedValue(mp('approved', { externalReference: '777' }));
    await expect(useCases.processarWebhook.execute({ paymentId: 'x' })).rejects.toThrow(NaoEncontradoError);
  });
});

describe('EstornarPagamento (execucao.falhou)', () => {
  async function comPagamentoAprovado() {
    const ctx = await comOrcamentoAprovado();
    ctx.deps.gateway.buscarPagamento.mockResolvedValue({ id: '9001', status: 'approved', externalReference: '1', raw: {} });
    await ctx.useCases.processarWebhook.execute({ paymentId: '9001' });
    ctx.db.outbox.length = 0;
    return ctx;
  }

  it('estorna no MP com idempotência pelo eventId, cancela o orçamento e publica pagamento.estornado', async () => {
    const { db, deps, handlers } = await comPagamentoAprovado();
    const e = evento('execucao.falhou', { osId: 42, motivo: 'peça indisponível' }, 'execution-service');

    const r = await handlers['execucao.falhou'](e);

    expect(r.resultado).toBe(RESULTADO_PAG.ESTORNADO);
    expect(deps.gateway.estornar).toHaveBeenCalledWith('9001', { idempotencyKey: `estorno-${e.eventId}` });
    expect(db.pagamentos[0]).toMatchObject({ status: 'ESTORNADO', mpRefundId: 'refund-9001' });
    expect(db.orcamentos[0].status).toBe('CANCELADO');
    expect(db.outbox[0]).toMatchObject({
      type: 'pagamento.estornado',
      causationId: e.eventId,
      payload: { osId: 42, valor: 180, mpRefundId: 'refund-9001', motivo: 'Falha na execução: peça indisponível' }
    });
  });

  it('evento repetido não estorna duas vezes', async () => {
    const { deps, handlers } = await comPagamentoAprovado();
    const e = evento('execucao.falhou', { osId: 42 }, 'execution-service');

    await handlers['execucao.falhou'](e);
    expect((await handlers['execucao.falhou'](e)).resultado).toBe(RESULTADO_PAG.DUPLICADO);
    expect(deps.gateway.estornar).toHaveBeenCalledTimes(1);
  });

  it('sem pagamento aprovado: só cancela o orçamento', async () => {
    const { db, deps, handlers } = await comOrcamentoAprovado();

    const r = await handlers['execucao.falhou'](evento('execucao.falhou', { osId: 42 }, 'execution-service'));

    expect(r.resultado).toBe(RESULTADO_PAG.IGNORADO);
    expect(deps.gateway.estornar).not.toHaveBeenCalled();
    expect(db.orcamentos[0].status).toBe('CANCELADO');
    expect(db.outbox).toHaveLength(0);
  });

  it('falha no MP propaga para o retry', async () => {
    const { deps, handlers } = await comPagamentoAprovado();
    deps.gateway.estornar.mockRejectedValue(new GatewayPagamentoError('MP fora'));

    await expect(handlers['execucao.falhou'](evento('execucao.falhou', { osId: 42 }, 'execution-service'))).rejects.toThrow('MP fora');
  });
});

describe('ExpirarPagamentosPendentes', () => {
  it('expira pagamentos pendentes, cancela o orçamento e publica pagamento.falhou', async () => {
    const { db, useCases } = await comOrcamentoAprovado();

    const total = await useCases.expirar.execute();

    expect(total).toBe(1);
    expect(db.pagamentos[0].status).toBe('EXPIRADO');
    expect(db.orcamentos[0].status).toBe('CANCELADO');
    expect(db.outbox[0]).toMatchObject({ type: 'pagamento.falhou', payload: { osId: 42, motivo: 'Pagamento não concluído em 30 minutos' } });
  });
});

describe('itensParaExecucao', () => {
  it('lida com orçamento ausente', () => {
    expect(itensParaExecucao(null)).toEqual({ servicos: [], pecas: [] });
  });
});
