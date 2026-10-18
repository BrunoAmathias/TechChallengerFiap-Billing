const { OrcamentoInvalidoError, TransicaoInvalidaError } = require("./errors");

const STATUS_ORCAMENTO = Object.freeze({
  PENDENTE: "PENDENTE",
  APROVADO: "APROVADO",
  RECUSADO: "RECUSADO",
  CANCELADO: "CANCELADO"
});

/**
 * PENDENTE → APROVADO (cliente aprova) → CANCELADO (pagamento falhou/expirou ou execução falhou)
 * PENDENTE → RECUSADO (cliente recusa)
 */
const TRANSICOES = Object.freeze({
  PENDENTE: ["APROVADO", "RECUSADO", "CANCELADO"],
  APROVADO: ["CANCELADO"],
  RECUSADO: [],
  CANCELADO: []
});

function arredondar(valor) {
  return Math.round(Number(valor) * 100) / 100;
}

class Orcamento {
  static get STATUS() {
    return STATUS_ORCAMENTO;
  }

  static podeTransicionar(de, para) {
    return (TRANSICOES[de] || []).includes(para);
  }

  static assertTransicao(de, para) {
    if (!this.podeTransicionar(de, para)) {
      throw new TransicaoInvalidaError(`Orçamento ${de} não pode ir para ${para}`);
    }
  }

  /**
   * Monta o orçamento a partir do payload de os.aberta. O valor total é
   * recalculado pelos itens; divergência com o valor da OS é erro de geração.
   */
  static aPartirDaOs(payload) {
    const { osId, cliente, veiculo, servicos = [], pecas = [], valorTotal } = payload || {};

    if (!osId) throw new OrcamentoInvalidoError("OS sem identificador");
    if (!cliente?.email) throw new OrcamentoInvalidoError("Cliente sem e-mail para envio do orçamento");

    const itens = [
      ...servicos.map((s) => ({
        tipo: "SERVICO",
        referenciaId: s.servicoId,
        descricao: s.nome,
        quantidade: Number(s.quantidade || 1),
        valorUnitario: arredondar(s.valorUnitario),
        total: arredondar(s.total ?? s.valorUnitario * (s.quantidade || 1))
      })),
      ...pecas.map((p) => ({
        tipo: "PECA",
        referenciaId: p.pecaId,
        descricao: p.nome,
        quantidade: Number(p.quantidade || 1),
        valorUnitario: arredondar(p.valorUnitario),
        total: arredondar(p.total ?? p.valorUnitario * (p.quantidade || 1))
      }))
    ];

    if (itens.length === 0) throw new OrcamentoInvalidoError("OS sem serviços ou peças para orçar");
    if (itens.some((i) => Number.isNaN(i.total) || i.total < 0)) {
      throw new OrcamentoInvalidoError("Item do orçamento com valor inválido");
    }

    const total = arredondar(itens.reduce((soma, i) => soma + i.total, 0));
    if (total <= 0) throw new OrcamentoInvalidoError("Valor total do orçamento deve ser maior que zero");
    if (valorTotal != null && Math.abs(arredondar(valorTotal) - total) > 0.01) {
      throw new OrcamentoInvalidoError(`Valor da OS (${valorTotal}) diverge da soma dos itens (${total})`);
    }

    return {
      osId: Number(osId),
      cliente: { nome: cliente.nome, email: cliente.email, documento: cliente.documento ?? null },
      veiculo: veiculo ? { placa: veiculo.placa, marca: veiculo.marca, modelo: veiculo.modelo } : null,
      itens,
      valorTotal: total,
      status: STATUS_ORCAMENTO.PENDENTE
    };
  }
}

module.exports = Orcamento;
module.exports.STATUS_ORCAMENTO = STATUS_ORCAMENTO;
