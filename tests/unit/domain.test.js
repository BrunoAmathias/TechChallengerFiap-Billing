const Orcamento = require('../../src/domain/orcamento');
const Pagamento = require('../../src/domain/pagamento');
const { OrcamentoInvalidoError, TransicaoInvalidaError } = require('../../src/domain/errors');
const { payloadOsAberta } = require('./fakes');

describe('Orcamento', () => {
  it('monta o orçamento a partir de os.aberta com serviços e peças', () => {
    const o = Orcamento.aPartirDaOs(payloadOsAberta());

    expect(o).toMatchObject({
      osId: 42,
      valorTotal: 180,
      status: 'PENDENTE',
      cliente: { nome: 'Maria', email: 'maria@email.com', documento: '52998224725' },
      veiculo: { placa: 'ABC1D23' }
    });
    expect(o.itens).toEqual([
      { tipo: 'SERVICO', referenciaId: 1, descricao: 'Troca de óleo', quantidade: 1, valorUnitario: 120, total: 120 },
      { tipo: 'PECA', referenciaId: 4, descricao: 'Filtro', quantidade: 2, valorUnitario: 30, total: 60 }
    ]);
  });

  it('calcula o total do item quando não vem no payload e aceita OS sem veículo/valorTotal', () => {
    const o = Orcamento.aPartirDaOs(payloadOsAberta({
      valorTotal: undefined,
      veiculo: undefined,
      pecas: [],
      servicos: [{ servicoId: 1, nome: 'Revisão', valorUnitario: 50.5, quantidade: 2 }]
    }));

    expect(o.valorTotal).toBe(101);
    expect(o.veiculo).toBeNull();
  });

  it.each([
    ['sem osId', { osId: undefined }, /identificador/],
    ['cliente sem e-mail', { cliente: { nome: 'X' } }, /e-mail/],
    ['sem itens', { servicos: [], pecas: [] }, /sem serviços ou peças/],
    ['item com valor inválido', { servicos: [{ servicoId: 1, valorUnitario: 'abc' }], pecas: [] }, /valor inválido/],
    ['total zero', { servicos: [{ servicoId: 1, valorUnitario: 0, total: 0 }], pecas: [], valorTotal: 0 }, /maior que zero/],
    ['valor divergente', { valorTotal: 999 }, /diverge/]
  ])('rejeita OS %s', (_caso, sobrescrita, mensagem) => {
    expect(() => Orcamento.aPartirDaOs(payloadOsAberta(sobrescrita))).toThrow(OrcamentoInvalidoError);
    expect(() => Orcamento.aPartirDaOs(payloadOsAberta(sobrescrita))).toThrow(mensagem);
  });

  it('rejeita payload ausente', () => {
    expect(() => Orcamento.aPartirDaOs(undefined)).toThrow(OrcamentoInvalidoError);
  });

  it('controla as transições de status', () => {
    expect(Orcamento.podeTransicionar('PENDENTE', 'APROVADO')).toBe(true);
    expect(Orcamento.podeTransicionar('PENDENTE', 'RECUSADO')).toBe(true);
    expect(Orcamento.podeTransicionar('APROVADO', 'CANCELADO')).toBe(true);
    expect(Orcamento.podeTransicionar('APROVADO', 'RECUSADO')).toBe(false);
    expect(Orcamento.podeTransicionar('RECUSADO', 'APROVADO')).toBe(false);
    expect(Orcamento.podeTransicionar('DESCONHECIDO', 'APROVADO')).toBe(false);
    expect(() => Orcamento.assertTransicao('CANCELADO', 'APROVADO')).toThrow(TransicaoInvalidaError);
    expect(Orcamento.STATUS.PENDENTE).toBe('PENDENTE');
  });
});

describe('Pagamento', () => {
  it.each([
    ['approved', 'APROVADO'],
    ['rejected', 'REJEITADO'],
    ['cancelled', 'REJEITADO'],
    ['refunded', 'ESTORNADO'],
    ['charged_back', 'ESTORNADO'],
    ['pending', 'PENDENTE'],
    ['in_process', 'PENDENTE'],
    ['status_novo_do_mp', 'PENDENTE']
  ])('status MP %s → %s', (mp, interno) => {
    expect(Pagamento.statusDoMercadoPago(mp)).toBe(interno);
  });

  it('identifica status finais', () => {
    expect(Pagamento.isFinal('REJEITADO')).toBe(true);
    expect(Pagamento.isFinal('EXPIRADO')).toBe(true);
    expect(Pagamento.isFinal('ESTORNADO')).toBe(true);
    expect(Pagamento.isFinal('APROVADO')).toBe(false);
    expect(Pagamento.STATUS.PENDENTE).toBe('PENDENTE');
  });
});
