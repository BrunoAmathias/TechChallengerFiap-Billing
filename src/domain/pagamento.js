const STATUS_PAGAMENTO = Object.freeze({
  PENDENTE: "PENDENTE",
  APROVADO: "APROVADO",
  REJEITADO: "REJEITADO",
  EXPIRADO: "EXPIRADO",
  ESTORNADO: "ESTORNADO"
});

/**
 * Status do Mercado Pago (GET /v1/payments/:id) → status interno.
 * pending / in_process / authorized continuam PENDENTE (aguardam novo webhook).
 */
const MAPA_STATUS_MP = Object.freeze({
  approved: STATUS_PAGAMENTO.APROVADO,
  rejected: STATUS_PAGAMENTO.REJEITADO,
  cancelled: STATUS_PAGAMENTO.REJEITADO,
  refunded: STATUS_PAGAMENTO.ESTORNADO,
  charged_back: STATUS_PAGAMENTO.ESTORNADO,
  pending: STATUS_PAGAMENTO.PENDENTE,
  in_process: STATUS_PAGAMENTO.PENDENTE,
  in_mediation: STATUS_PAGAMENTO.PENDENTE,
  authorized: STATUS_PAGAMENTO.PENDENTE
});

class Pagamento {
  static get STATUS() {
    return STATUS_PAGAMENTO;
  }

  static statusDoMercadoPago(statusMp) {
    return MAPA_STATUS_MP[statusMp] ?? STATUS_PAGAMENTO.PENDENTE;
  }

  /** Status finais não mudam mais com webhooks atrasados. */
  static isFinal(status) {
    return [STATUS_PAGAMENTO.REJEITADO, STATUS_PAGAMENTO.EXPIRADO, STATUS_PAGAMENTO.ESTORNADO].includes(status);
  }
}

module.exports = Pagamento;
module.exports.STATUS_PAGAMENTO = STATUS_PAGAMENTO;
