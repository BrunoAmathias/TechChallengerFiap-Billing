/**
 * Gateway falso para desenvolvimento local e testes de ponta a ponta sem
 * credenciais do Mercado Pago (MERCADOPAGO_MODE=fake).
 *
 * O id do pagamento carrega o resultado: "fake-<orcamentoId>-<status MP>",
 * ex.: fake-12-approved, fake-12-rejected. O webhook é o mesmo do real.
 */
class FakeMercadoPagoGateway {
  constructor({ baseUrl = "http://localhost:3001" } = {}) {
    this.baseUrl = baseUrl;
    this.estornos = [];
  }

  async criarPreferencia(orcamento) {
    return {
      preferenceId: `fake-pref-${orcamento.id}`,
      initPoint: `${this.baseUrl}/fake-checkout?orcamento=${orcamento.id}`
    };
  }

  async buscarPagamento(paymentId) {
    const [, orcamentoId, status = "approved"] = String(paymentId).split("-");
    return {
      id: String(paymentId),
      status,
      statusDetail: status === "approved" ? "accredited" : "cc_rejected_other_reason",
      externalReference: orcamentoId,
      valor: null,
      raw: { id: paymentId, status, fake: true }
    };
  }

  async estornar(paymentId) {
    this.estornos.push(String(paymentId));
    return { refundId: `fake-refund-${paymentId}`, status: "approved" };
  }
}

module.exports = FakeMercadoPagoGateway;
