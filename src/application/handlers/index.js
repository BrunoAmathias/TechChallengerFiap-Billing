const EventTypes = require("../events/eventTypes");

/**
 * Eventos consumidos pelo Billing Service. As chaves também são as routing keys
 * que a fila billing-service.events escuta na exchange oficina.events.
 */
function criarHandlers({ gerarOrcamento, estornarPagamento }) {
  return {
    [EventTypes.OS_ABERTA]: (evento) => gerarOrcamento.execute(evento),
    [EventTypes.EXECUCAO_FALHOU]: (evento) => estornarPagamento.execute(evento)
  };
}

module.exports = { criarHandlers };
