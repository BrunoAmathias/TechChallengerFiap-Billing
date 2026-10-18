const newrelic = require("newrelic");
const Orcamento = require("../domain/orcamento");
const Pagamento = require("../domain/pagamento");
const { NaoEncontradoError } = require("../domain/errors");
const EventTypes = require("./events/eventTypes");
const { criarEvento } = require("./events/eventFactory");
const logger = require("../infrastructure/logger");

const { STATUS } = Pagamento;

const MOEDA = "BRL";
const TOLERANCIA_VALOR = 0.01;

/**
 * Confere o pagamento do MP com o esperado pelo Billing. O valor/moeda nulos
 * (gateway fake) não são verificados. Retorna null se estiver tudo certo.
 */
function verificarValor(pagamento, pagamentoMp) {
  if (pagamentoMp.moeda != null && pagamentoMp.moeda !== MOEDA) {
    return { motivo: "moeda", esperado: MOEDA, recebido: String(pagamentoMp.moeda) };
  }
  if (pagamentoMp.valor != null && Math.abs(Number(pagamentoMp.valor) - Number(pagamento.valor)) > TOLERANCIA_VALOR) {
    return { motivo: "valor", esperado: Number(pagamento.valor), recebido: Number(pagamentoMp.valor) };
  }
  return null;
}

const RESULTADO = Object.freeze({
  VALOR_DIVERGENTE: "valor_divergente",
  CONFIRMADO: "confirmado",
  FALHOU: "falhou",
  ESTORNADO: "estornado",
  ATUALIZADO: "atualizado",
  IGNORADO: "ignorado",
  DUPLICADO: "duplicado"
});

function itensParaExecucao(orcamento) {
  const itens = orcamento?.itens || [];
  return {
    servicos: itens
      .filter((i) => i.tipo === "SERVICO")
      .map((i) => ({ servicoId: i.referenciaId, nome: i.descricao, quantidade: i.quantidade })),
    pecas: itens
      .filter((i) => i.tipo === "PECA")
      .map((i) => ({ pecaId: i.referenciaId, nome: i.descricao, quantidade: i.quantidade }))
  };
}

/**
 * Webhook do Mercado Pago: o corpo da notificação só traz o id; o status real
 * vem de GET /v1/payments/:id. external_reference = id do orçamento.
 *
 * PENDENTE → APROVADO  publica pagamento.confirmado (com os itens para o Execution)
 * PENDENTE → REJEITADO publica pagamento.falhou e cancela o orçamento
 * Notificações repetidas ou atrasadas (mesmo status / status final) são ignoradas.
 */
class ProcessarWebhookPagamento {
  constructor({ pagamentoRepository, orcamentoRepository, outboxRepository, unitOfWork, gateway }) {
    this.pagamentoRepository = pagamentoRepository;
    this.orcamentoRepository = orcamentoRepository;
    this.outboxRepository = outboxRepository;
    this.unitOfWork = unitOfWork;
    this.gateway = gateway;
  }

  async execute({ paymentId }) {
    const pagamentoMp = await this.gateway.buscarPagamento(paymentId);
    const orcamentoId = Number(pagamentoMp.externalReference);

    if (!orcamentoId) {
      return { resultado: RESULTADO.IGNORADO, motivo: "pagamento sem external_reference" };
    }

    return this.unitOfWork.run(async (tx) => {
      const pagamento = await this.pagamentoRepository.buscarPorOrcamentoParaAtualizar(orcamentoId, tx);
      if (!pagamento) throw new NaoEncontradoError(`Pagamento do orçamento ${orcamentoId} não encontrado`);

      const novoStatus = Pagamento.statusDoMercadoPago(pagamentoMp.status);
      const dadosMp = { mpPaymentId: pagamentoMp.id, raw: pagamentoMp.raw };

      if (Pagamento.isFinal(pagamento.status) || pagamento.status === novoStatus) {
        return { resultado: RESULTADO.DUPLICADO, pagamento };
      }

      const opcoes = { correlationId: pagamento.osId };

      if (pagamento.status === STATUS.PENDENTE && novoStatus === STATUS.APROVADO) {
        const divergencia = verificarValor(pagamento, pagamentoMp);
        if (divergencia) {
          // Não confirma: o pagamento segue PENDENTE e nenhum evento é publicado
          logger.warn({ pagamentoId: pagamento.id, mpPaymentId: pagamentoMp.id, ...divergencia }, "Pagamento aprovado com valor/moeda divergente do orçamento");
          newrelic.recordCustomEvent("PagamentoDivergente", {
            osId: String(pagamento.osId),
            pagamentoId: String(pagamento.id),
            mpPaymentId: String(pagamentoMp.id),
            ...divergencia
          });
          return { resultado: RESULTADO.VALOR_DIVERGENTE, pagamento, divergencia };
        }

        const atualizado = await this.pagamentoRepository.atualizar(pagamento.id, { status: STATUS.APROVADO, ...dadosMp }, tx);
        const orcamento = await this.orcamentoRepository.buscarPorId(orcamentoId, tx);

        await this.outboxRepository.adicionar(
          criarEvento(
            EventTypes.PAGAMENTO_CONFIRMADO,
            {
              osId: pagamento.osId,
              orcamentoId,
              pagamentoId: pagamento.id,
              mpPaymentId: pagamentoMp.id,
              valor: pagamento.valor,
              ...itensParaExecucao(orcamento)
            },
            opcoes
          ),
          tx
        );
        return { resultado: RESULTADO.CONFIRMADO, pagamento: atualizado };
      }

      if (pagamento.status === STATUS.PENDENTE && novoStatus === STATUS.REJEITADO) {
        const atualizado = await this.pagamentoRepository.atualizar(pagamento.id, { status: STATUS.REJEITADO, ...dadosMp }, tx);
        const motivo = `Pagamento ${pagamentoMp.status} (${pagamentoMp.statusDetail || "sem detalhe"})`;

        await this.orcamentoRepository.atualizarStatus(orcamentoId, Orcamento.STATUS.CANCELADO, motivo, tx);
        await this.outboxRepository.adicionar(
          criarEvento(EventTypes.PAGAMENTO_FALHOU, { osId: pagamento.osId, orcamentoId, pagamentoId: pagamento.id, motivo }, opcoes),
          tx
        );
        return { resultado: RESULTADO.FALHOU, pagamento: atualizado };
      }

      if (pagamento.status === STATUS.APROVADO && novoStatus === STATUS.ESTORNADO) {
        // estorno feito direto no painel do Mercado Pago
        const atualizado = await this.pagamentoRepository.atualizar(pagamento.id, { status: STATUS.ESTORNADO, ...dadosMp }, tx);
        await this.outboxRepository.adicionar(
          criarEvento(
            EventTypes.PAGAMENTO_ESTORNADO,
            { osId: pagamento.osId, orcamentoId, pagamentoId: pagamento.id, valor: pagamento.valor, origem: "mercadopago" },
            opcoes
          ),
          tx
        );
        return { resultado: RESULTADO.ESTORNADO, pagamento: atualizado };
      }

      const atualizado = await this.pagamentoRepository.atualizar(pagamento.id, { status: pagamento.status, ...dadosMp }, tx);
      return { resultado: RESULTADO.ATUALIZADO, pagamento: atualizado };
    });
  }
}

/**
 * Compensação de execucao.falhou: estorna o pagamento aprovado no Mercado Pago
 * e publica pagamento.estornado. A chamada ao MP acontece dentro da transação
 * (com lock do pagamento) e usa o eventId como chave de idempotência: se o
 * commit falhar, a nova tentativa não gera um segundo estorno.
 */
class EstornarPagamento {
  constructor({ pagamentoRepository, orcamentoRepository, outboxRepository, processedEventsRepository, unitOfWork, gateway }) {
    this.pagamentoRepository = pagamentoRepository;
    this.orcamentoRepository = orcamentoRepository;
    this.outboxRepository = outboxRepository;
    this.processedEventsRepository = processedEventsRepository;
    this.unitOfWork = unitOfWork;
    this.gateway = gateway;
  }

  async execute(evento) {
    const osId = Number(evento.payload?.osId ?? evento.correlationId);
    const motivo = evento.payload?.motivo ? `Falha na execução: ${evento.payload.motivo}` : "Falha na execução";

    const resultado = await this.unitOfWork.run(async (tx) => {
      const novo = await this.processedEventsRepository.registrar(evento.eventId, evento.type, tx);
      if (!novo) return { resultado: RESULTADO.DUPLICADO };

      const pagamento = await this.pagamentoRepository.buscarPorOsParaAtualizar(osId, tx);
      const orcamento = await this.orcamentoRepository.buscarPorOsId(osId, tx);

      if (orcamento && Orcamento.podeTransicionar(orcamento.status, Orcamento.STATUS.CANCELADO)) {
        await this.orcamentoRepository.atualizarStatus(orcamento.id, Orcamento.STATUS.CANCELADO, motivo, tx);
      }

      if (!pagamento || pagamento.status !== STATUS.APROVADO) {
        return { resultado: RESULTADO.IGNORADO, motivo: "sem pagamento aprovado para estornar" };
      }

      const estorno = await this.gateway.estornar(pagamento.mpPaymentId, { idempotencyKey: `estorno-${evento.eventId}` });
      const atualizado = await this.pagamentoRepository.atualizar(
        pagamento.id,
        { status: STATUS.ESTORNADO, mpRefundId: estorno.refundId },
        tx
      );

      await this.outboxRepository.adicionar(
        criarEvento(
          EventTypes.PAGAMENTO_ESTORNADO,
          {
            osId,
            orcamentoId: pagamento.orcamentoId,
            pagamentoId: pagamento.id,
            valor: pagamento.valor,
            mpRefundId: estorno.refundId,
            motivo
          },
          { correlationId: osId, causationId: evento.eventId }
        ),
        tx
      );

      return { resultado: RESULTADO.ESTORNADO, pagamento: atualizado };
    });

    if (resultado.resultado === RESULTADO.ESTORNADO) {
      newrelic.recordCustomEvent("SagaCompensacao", {
        osId: String(osId),
        evento: String(evento.type),
        servico: "billing-service",
        acao: "EstornoMercadoPago",
        valor: Number(resultado.pagamento.valor)
      });
    }

    return resultado;
  }
}

/** Pagamentos não concluídos no prazo viram EXPIRADO e publicam pagamento.falhou. */
class ExpirarPagamentosPendentes {
  constructor({ pagamentoRepository, orcamentoRepository, outboxRepository, unitOfWork, prazoMinutos = 1440, lote = 50 }) {
    this.pagamentoRepository = pagamentoRepository;
    this.orcamentoRepository = orcamentoRepository;
    this.outboxRepository = outboxRepository;
    this.unitOfWork = unitOfWork;
    this.prazoMinutos = prazoMinutos;
    this.lote = lote;
  }

  async execute() {
    return this.unitOfWork.run(async (tx) => {
      const expirados = await this.pagamentoRepository.buscarPendentesExpirados(this.prazoMinutos, this.lote, tx);
      const motivo = `Pagamento não concluído em ${this.prazoMinutos} minutos`;

      for (const pagamento of expirados) {
        await this.pagamentoRepository.atualizar(pagamento.id, { status: STATUS.EXPIRADO }, tx);
        await this.orcamentoRepository.atualizarStatus(pagamento.orcamentoId, Orcamento.STATUS.CANCELADO, motivo, tx);
        await this.outboxRepository.adicionar(
          criarEvento(
            EventTypes.PAGAMENTO_FALHOU,
            { osId: pagamento.osId, orcamentoId: pagamento.orcamentoId, pagamentoId: pagamento.id, motivo },
            { correlationId: pagamento.osId }
          ),
          tx
        );
      }

      return expirados.length;
    });
  }
}

class BuscarPagamento {
  constructor({ pagamentoRepository }) {
    this.pagamentoRepository = pagamentoRepository;
  }

  async execute(id) {
    const pagamento = await this.pagamentoRepository.buscarPorId(id);
    if (!pagamento) throw new NaoEncontradoError(`Pagamento ${id} não encontrado`);
    return pagamento;
  }
}

module.exports = {
  ProcessarWebhookPagamento,
  EstornarPagamento,
  ExpirarPagamentosPendentes,
  BuscarPagamento,
  RESULTADO,
  itensParaExecucao,
  verificarValor
};
