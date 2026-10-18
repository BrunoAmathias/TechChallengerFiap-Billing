process.env.MERCADOPAGO_MODE = 'fake';
process.env.APPROVAL_LINK_SECRET = 'links-integracao';

const pool = require('../../src/infrastructure/database/connection');
const { useCases, handlers } = require('../../src/container');
const { criarEvento } = require('../../src/application/events/eventFactory');

const osId = Number(Date.now().toString().slice(-7));

function evento(type, payload) {
  return { ...criarEvento(type, payload, { correlationId: payload.osId }), source: 'teste-integracao' };
}

const osAberta = (id) => ({
  osId: id,
  valorTotal: 180,
  cliente: { nome: 'Maria', email: 'maria@email.com', documento: '52998224725' },
  veiculo: { placa: 'ABC1D23', marca: 'VW', modelo: 'Gol' },
  servicos: [{ servicoId: 1, nome: 'Troca de óleo', quantidade: 1, valorUnitario: 120, total: 120 }],
  pecas: [{ pecaId: 4, nome: 'Filtro', quantidade: 2, valorUnitario: 30, total: 60 }]
});

async function outbox(id) {
  const { rows } = await pool.query('SELECT type, payload FROM outbox WHERE aggregate_id = $1 ORDER BY created_at', [String(id)]);
  return rows;
}

describe('Billing (integração com PostgreSQL)', () => {
  const ids = [osId, osId + 1, osId + 2];

  afterAll(async () => {
    await pool.query('DELETE FROM outbox WHERE aggregate_id = ANY($1)', [ids.map(String)]);
    await pool.query('DELETE FROM orcamentos WHERE os_id = ANY($1)', [ids]);
    await pool.end();
  });

  it('fluxo principal: os.aberta → aprovação → webhook aprovado → estorno', async () => {
    const gerado = await handlers['os.aberta'](evento('os.aberta', osAberta(osId)));
    expect(gerado.resultado).toBe('criado');

    const orcamento = await useCases.buscarOrcamento.porOs(osId);
    expect(orcamento).toMatchObject({ status: 'PENDENTE', valorTotal: 180, cliente: { email: 'maria@email.com' } });
    expect(orcamento.itens).toHaveLength(2);

    const aprovado = await useCases.aprovarOrcamento.execute(orcamento.id);
    expect(aprovado.pagamento).toMatchObject({ status: 'PENDENTE', valor: 180, mpPreferenceId: `fake-pref-${orcamento.id}` });

    const webhook = await useCases.processarWebhook.execute({ paymentId: `fake-${orcamento.id}-approved` });
    expect(webhook.resultado).toBe('confirmado');
    const repetido = await useCases.processarWebhook.execute({ paymentId: `fake-${orcamento.id}-approved` });
    expect(repetido.resultado).toBe('duplicado');

    const estorno = await handlers['execucao.falhou'](evento('execucao.falhou', { osId, motivo: 'sem peça' }));
    expect(estorno.resultado).toBe('estornado');

    const final = await useCases.buscarOrcamento.porId(orcamento.id);
    expect(final.status).toBe('CANCELADO');
    expect(final.pagamento).toMatchObject({
      status: 'ESTORNADO',
      mpPaymentId: `fake-${orcamento.id}-approved`,
      mpRefundId: `fake-refund-fake-${orcamento.id}-approved`
    });

    const eventos = await outbox(osId);
    expect(eventos.map((e) => e.type)).toEqual(['orcamento.gerado', 'orcamento.aprovado', 'pagamento.confirmado', 'pagamento.estornado']);
    expect(eventos[2].payload.payload.servicos).toEqual([{ servicoId: 1, nome: 'Troca de óleo', quantidade: 1 }]);
  });

  it('recusa e pagamento rejeitado publicam os eventos de compensação', async () => {
    await handlers['os.aberta'](evento('os.aberta', osAberta(osId + 1)));
    const o1 = await useCases.buscarOrcamento.porOs(osId + 1);
    await useCases.recusarOrcamento.execute(o1.id, 'achou caro');

    await handlers['os.aberta'](evento('os.aberta', osAberta(osId + 2)));
    const o2 = await useCases.buscarOrcamento.porOs(osId + 2);
    await useCases.aprovarOrcamento.execute(o2.id);
    await useCases.processarWebhook.execute({ paymentId: `fake-${o2.id}-rejected` });

    expect((await useCases.buscarOrcamento.porId(o1.id)).status).toBe('RECUSADO');
    expect((await useCases.buscarOrcamento.porId(o2.id))).toMatchObject({ status: 'CANCELADO', pagamento: { status: 'REJEITADO' } });
    expect((await outbox(osId + 1)).at(-1).type).toBe('orcamento.recusado');
    expect((await outbox(osId + 2)).at(-1).type).toBe('pagamento.falhou');
  });

  it('os.aberta repetido (mesmo eventId) e OS já orçada não duplicam o orçamento', async () => {
    const e = evento('os.aberta', osAberta(osId));

    expect((await handlers['os.aberta'](e)).resultado).toBe('ja_existe');
    expect((await handlers['os.aberta'](e)).resultado).toBe('duplicado');

    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM orcamentos WHERE os_id = $1', [osId]);
    expect(rows[0].n).toBe(1);
  });

  it('expira pagamento pendente fora do prazo', async () => {
    const id = osId + 3;
    ids.push(id);
    await handlers['os.aberta'](evento('os.aberta', osAberta(id)));
    const o = await useCases.buscarOrcamento.porOs(id);
    await useCases.aprovarOrcamento.execute(o.id);
    await pool.query(`UPDATE pagamentos SET created_at = NOW() - INTERVAL '2 days' WHERE orcamento_id = $1`, [o.id]);

    const expirados = await useCases.expirarPagamentos.execute();

    expect(expirados).toBeGreaterThanOrEqual(1);
    expect((await useCases.buscarOrcamento.porId(o.id))).toMatchObject({ status: 'CANCELADO', pagamento: { status: 'EXPIRADO' } });
    expect((await outbox(id)).at(-1)).toMatchObject({ type: 'pagamento.falhou' });
  });
});
