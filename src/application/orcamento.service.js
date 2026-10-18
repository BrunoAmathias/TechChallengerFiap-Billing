const newrelic = require("newrelic");
const Orcamento = require("../domain/orcamento");
const Pagamento = require("../domain/pagamento");
const { NaoEncontradoError, OrcamentoInvalidoError } = require("../domain/errors");
const EventTypes = require("./events/eventTypes");
const { criarEvento } = require("./events/eventFactory");
const { gerarLinks } = require("./linkAprovacao");
const logger = require("../infrastructure/logger");

const { STATUS } = Orcamento;

const RESULTADO = Object.freeze({
  CRIADO: "criado",
  FALHOU: "falhou",
  DUPLICADO: "duplicado",
  JA_EXISTE: "ja_existe"
});

/**
 * os.aberta → cria o orçamento PENDENTE e publica orcamento.gerado.
 * Se os dados da OS não permitem orçar, publica orcamento.falhou (compensação
 * no OS Service). O e-mail ao cliente sai depois do commit; falha no envio é
 * registrada mas não desfaz o orçamento (o link também fica na API).
 */
class GerarOrcamento {
  constructor({ orcamentoRepository, outboxRepository, processedEventsRepository, unitOfWork, notificationService, osServiceClient, links }) {
    this.orcamentoRepository = orcamentoRepository;
    this.outboxRepository = outboxRepository;
    this.processedEventsRepository = processedEventsRepository;
    this.unitOfWork = unitOfWork;
    this.notificationService = notificationService;
    this.osServiceClient = osServiceClient;
    this.links = links;
  }

  async completarDadosDaOs(payload) {
    if (payload?.cliente?.email || !this.osServiceClient || !payload?.osId) return payload;

    const os = await this.osServiceClient.buscarOs(payload.osId);
    return { ...payload, cliente: os.cliente, veiculo: payload.veiculo ?? os.veiculo };
  }

  async execute(evento) {
    const payload = await this.completarDadosDaOs(evento.payload);
    const opcoes = { correlationId: evento.correlationId, causationId: evento.eventId };

    const resultado = await this.unitOfWork.run(async (tx) => {
      const novo = await this.processedEventsRepository.registrar(evento.eventId, evento.type, tx);
      if (!novo) return { resultado: RESULTADO.DUPLICADO };

      const existente = await this.orcamentoRepository.buscarPorOsId(payload.osId, tx);
      if (existente) return { resultado: RESULTADO.JA_EXISTE, orcamento: existente };

      let dados;
      try {
        dados = Orcamento.aPartirDaOs(payload);
      } catch (err) {
        if (!(err instanceof OrcamentoInvalidoError)) throw err;

        await this.outboxRepository.adicionar(
          criarEvento(EventTypes.ORCAMENTO_FALHOU, { osId: Number(payload.osId), motivo: err.message }, opcoes),
          tx
        );
        return { resultado: RESULTADO.FALHOU, motivo: err.message };
      }

      const orcamento = await this.orcamentoRepository.criar(dados, tx);
      const links = gerarLinks(orcamento.id, this.links);

      await this.outboxRepository.adicionar(
        criarEvento(
          EventTypes.ORCAMENTO_GERADO,
          {
            osId: orcamento.osId,
            orcamentoId: orcamento.id,
            valorTotal: orcamento.valorTotal,
            quantidadeItens: orcamento.itens.length,
            linkAprovacao: links.aprovar
          },
          opcoes
        ),
        tx
      );

      return { resultado: RESULTADO.CRIADO, orcamento, links };
    });

    if (resultado.resultado === RESULTADO.CRIADO) {
      await this.enviarEmail(resultado.orcamento, resultado.links);
    } else if (resultado.resultado === RESULTADO.FALHOU) {
      newrelic.recordCustomEvent("SagaCompensacao", {
        osId: String(evento.correlationId),
        evento: EventTypes.ORCAMENTO_FALHOU,
        servico: "billing-service",
        motivo: String(resultado.motivo)
      });
    }

    return resultado;
  }

  async enviarEmail(orcamento, links) {
    try {
      await this.notificationService.enviarOrcamento(orcamento, links);
    } catch (err) {
      newrelic.recordCustomEvent("FalhaIntegracao", {
        osId: String(orcamento.osId),
        sistema: "Email",
        mensagem: String(err.message)
      });
      logger.error({ err, orcamentoId: orcamento.id }, "Falha ao enviar o e-mail do orçamento");
    }
  }
}

/**
 * Cliente aprova: cria a preferência no Mercado Pago (fora da transação; a
 * chave de idempotência evita preferência duplicada em nova tentativa) e grava
 * APROVADO + pagamento PENDENTE + orcamento.aprovado na mesma transação.
 */
class AprovarOrcamento {
  constructor({ orcamentoRepository, pagamentoRepository, outboxRepository, unitOfWork, gateway }) {
    this.orcamentoRepository = orcamentoRepository;
    this.pagamentoRepository = pagamentoRepository;
    this.outboxRepository = outboxRepository;
    this.unitOfWork = unitOfWork;
    this.gateway = gateway;
  }

  async execute(id) {
    const orcamento = await this.orcamentoRepository.buscarPorId(id);
    if (!orcamento) throw new NaoEncontradoError(`Orçamento ${id} não encontrado`);

    if (orcamento.status === STATUS.APROVADO) {
      const pagamento = await this.pagamentoRepository.buscarPorOrcamentoId(id);
      return { orcamento, pagamento, initPoint: pagamento?.initPoint };
    }

    Orcamento.assertTransicao(orcamento.status, STATUS.APROVADO);

    const preferencia = await this.gateway.criarPreferencia(orcamento, { idempotencyKey: `preferencia-orcamento-${id}` });

    return this.unitOfWork.run(async (tx) => {
      const atual = await this.orcamentoRepository.buscarParaAtualizar(id, tx);
      Orcamento.assertTransicao(atual.status, STATUS.APROVADO);

      const aprovado = await this.orcamentoRepository.atualizarStatus(id, STATUS.APROVADO, null, tx);
      const pagamento = await this.pagamentoRepository.criar(
        {
          orcamentoId: aprovado.id,
          osId: aprovado.osId,
          mpPreferenceId: preferencia.preferenceId,
          initPoint: preferencia.initPoint,
          valor: aprovado.valorTotal,
          status: Pagamento.STATUS.PENDENTE
        },
        tx
      );

      await this.outboxRepository.adicionar(
        criarEvento(
          EventTypes.ORCAMENTO_APROVADO,
          { osId: aprovado.osId, orcamentoId: aprovado.id, pagamentoId: pagamento.id, valorTotal: aprovado.valorTotal },
          { correlationId: aprovado.osId }
        ),
        tx
      );

      return { orcamento: aprovado, pagamento, initPoint: preferencia.initPoint };
    });
  }
}

class RecusarOrcamento {
  constructor({ orcamentoRepository, outboxRepository, unitOfWork }) {
    this.orcamentoRepository = orcamentoRepository;
    this.outboxRepository = outboxRepository;
    this.unitOfWork = unitOfWork;
  }

  async execute(id, motivo = null) {
    return this.unitOfWork.run(async (tx) => {
      const orcamento = await this.orcamentoRepository.buscarParaAtualizar(id, tx);
      if (!orcamento) throw new NaoEncontradoError(`Orçamento ${id} não encontrado`);
      if (orcamento.status === STATUS.RECUSADO) return orcamento;

      Orcamento.assertTransicao(orcamento.status, STATUS.RECUSADO);

      const recusado = await this.orcamentoRepository.atualizarStatus(id, STATUS.RECUSADO, motivo, tx);
      await this.outboxRepository.adicionar(
        criarEvento(
          EventTypes.ORCAMENTO_RECUSADO,
          { osId: recusado.osId, orcamentoId: recusado.id, motivo },
          { correlationId: recusado.osId }
        ),
        tx
      );
      return recusado;
    });
  }
}

class BuscarOrcamento {
  constructor({ orcamentoRepository, pagamentoRepository }) {
    this.orcamentoRepository = orcamentoRepository;
    this.pagamentoRepository = pagamentoRepository;
  }

  async porId(id) {
    const orcamento = await this.orcamentoRepository.buscarPorId(id);
    if (!orcamento) throw new NaoEncontradoError(`Orçamento ${id} não encontrado`);
    return this.comPagamento(orcamento);
  }

  async porOs(osId) {
    const orcamento = await this.orcamentoRepository.buscarPorOsId(osId);
    if (!orcamento) throw new NaoEncontradoError(`Nenhum orçamento para a OS ${osId}`);
    return this.comPagamento(orcamento);
  }

  async comPagamento(orcamento) {
    const pagamento = await this.pagamentoRepository.buscarPorOrcamentoId(orcamento.id);
    return { ...orcamento, pagamento };
  }
}

module.exports = {
  GerarOrcamento,
  AprovarOrcamento,
  RecusarOrcamento,
  BuscarOrcamento,
  RESULTADO
};
