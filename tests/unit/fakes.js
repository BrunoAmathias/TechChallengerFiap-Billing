const { criarEvento } = require('../../src/application/events/eventFactory');

/** Banco em memória do Billing para os testes de casos de uso. */
function criarFakes() {
  const db = { orcamentos: [], pagamentos: [], outbox: [], processados: new Set() };
  let seqOrc = 0;
  let seqPag = 0;

  const orcamentoRepository = {
    criar: jest.fn(async (o) => {
      const novo = { ...o, id: ++seqOrc, motivo: null };
      db.orcamentos.push(novo);
      return { ...novo };
    }),
    buscarPorId: jest.fn(async (id) => {
      const o = db.orcamentos.find((x) => x.id === Number(id));
      return o ? { ...o } : null;
    }),
    buscarPorOsId: jest.fn(async (osId) => {
      const o = db.orcamentos.find((x) => x.osId === Number(osId));
      return o ? { ...o } : null;
    }),
    buscarParaAtualizar: jest.fn(async (id) => orcamentoRepository.buscarPorId(id)),
    atualizarStatus: jest.fn(async (id, status, motivo) => {
      const o = db.orcamentos.find((x) => x.id === Number(id));
      Object.assign(o, { status, motivo: motivo ?? o.motivo });
      return { ...o };
    })
  };

  const pagamentoRepository = {
    criar: jest.fn(async (p) => {
      const novo = { mpPaymentId: null, mpRefundId: null, ...p, id: ++seqPag };
      db.pagamentos.push(novo);
      return { ...novo };
    }),
    buscarPorId: jest.fn(async (id) => {
      const p = db.pagamentos.find((x) => x.id === Number(id));
      return p ? { ...p } : null;
    }),
    buscarPorOrcamentoId: jest.fn(async (orcamentoId) => {
      const p = db.pagamentos.find((x) => x.orcamentoId === Number(orcamentoId));
      return p ? { ...p } : null;
    }),
    buscarPorOrcamentoParaAtualizar: jest.fn(async (orcamentoId) => pagamentoRepository.buscarPorOrcamentoId(orcamentoId)),
    buscarPorOsParaAtualizar: jest.fn(async (osId) => {
      const p = db.pagamentos.find((x) => x.osId === Number(osId));
      return p ? { ...p } : null;
    }),
    atualizar: jest.fn(async (id, { status, mpPaymentId, mpRefundId }) => {
      const p = db.pagamentos.find((x) => x.id === Number(id));
      Object.assign(p, { status, mpPaymentId: mpPaymentId ?? p.mpPaymentId, mpRefundId: mpRefundId ?? p.mpRefundId });
      return { ...p };
    }),
    buscarPendentesExpirados: jest.fn(async () => db.pagamentos.filter((p) => p.status === 'PENDENTE').map((p) => ({ ...p })))
  };

  const deps = {
    orcamentoRepository,
    pagamentoRepository,
    outboxRepository: { adicionar: jest.fn(async (e) => db.outbox.push(e)) },
    processedEventsRepository: {
      registrar: jest.fn(async (eventId) => {
        if (db.processados.has(eventId)) return false;
        db.processados.add(eventId);
        return true;
      })
    },
    unitOfWork: { run: jest.fn((fn) => fn({ tx: true })) },
    gateway: {
      criarPreferencia: jest.fn(async (o) => ({ preferenceId: `pref-${o.id}`, initPoint: `https://mp.test/checkout/${o.id}` })),
      buscarPagamento: jest.fn(),
      estornar: jest.fn(async (id) => ({ refundId: `refund-${id}`, status: 'approved' }))
    }
  };

  return { db, deps };
}

function payloadOsAberta(sobrescrita = {}) {
  return {
    osId: 42,
    valorTotal: 180,
    cliente: { id: 1, nome: 'Maria', email: 'maria@email.com', documento: '52998224725' },
    veiculo: { id: 3, placa: 'ABC1D23', marca: 'VW', modelo: 'Gol' },
    servicos: [{ servicoId: 1, nome: 'Troca de óleo', quantidade: 1, valorUnitario: 120, total: 120 }],
    pecas: [{ pecaId: 4, nome: 'Filtro', quantidade: 2, valorUnitario: 30, total: 60 }],
    ...sobrescrita
  };
}

function evento(type, payload, source = 'os-service') {
  return { ...criarEvento(type, payload, { correlationId: payload.osId }), source };
}

module.exports = { criarFakes, payloadOsAberta, evento };
