const { MercadoPagoConfig, Preference, Payment, PaymentRefund } = require("mercadopago");
const { GatewayPagamentoError } = require("../../domain/errors");

/**
 * Adaptador do SDK oficial do Mercado Pago (v2).
 * - criarPreferencia: Checkout Pro (external_reference = id do orçamento)
 * - buscarPagamento: GET /v1/payments/:id (fonte da verdade do webhook)
 * - estornar: reembolso total (compensação de execucao.falhou)
 */
class MercadoPagoGateway {
  constructor({ accessToken, notificationUrl, backUrl, sandbox = true, timeoutMs = 5000 }) {
    if (!accessToken) throw new Error("MP_ACCESS_TOKEN não configurado");

    // retries: 1 = sem retentativa interna. O SDK repete inclusive erros 4xx
    // (com backoff), o que travaria a requisição; o retry fica com o consumer
    // da fila e com o próprio Mercado Pago, que reenvia o webhook.
    this.client = new MercadoPagoConfig({ accessToken, options: { timeout: timeoutMs, retries: 1 } });
    this.notificationUrl = notificationUrl;
    this.backUrl = backUrl;
    this.sandbox = sandbox;
  }

  async criarPreferencia(orcamento, { idempotencyKey } = {}) {
    try {
      const body = {
        items: orcamento.itens.map((item) => ({
          id: `${item.tipo}-${item.referenciaId}`,
          title: item.descricao,
          quantity: item.quantidade,
          unit_price: item.valorUnitario,
          currency_id: "BRL"
        })),
        payer: { email: orcamento.cliente.email, name: orcamento.cliente.nome },
        external_reference: String(orcamento.id),
        metadata: { os_id: orcamento.osId, orcamento_id: orcamento.id },
        statement_descriptor: "OFICINA"
      };

      if (this.notificationUrl) body.notification_url = this.notificationUrl;
      if (this.backUrl) {
        body.back_urls = { success: this.backUrl, failure: this.backUrl, pending: this.backUrl };
      }

      const resposta = await new Preference(this.client).create({ body, requestOptions: { idempotencyKey } });

      return {
        preferenceId: resposta.id,
        initPoint: this.sandbox ? resposta.sandbox_init_point || resposta.init_point : resposta.init_point
      };
    } catch (err) {
      throw new GatewayPagamentoError(`Falha ao criar preferência no Mercado Pago: ${err.message}`, err);
    }
  }

  async buscarPagamento(paymentId) {
    try {
      const pagamento = await new Payment(this.client).get({ id: paymentId });
      return {
        id: String(pagamento.id),
        status: pagamento.status,
        statusDetail: pagamento.status_detail,
        externalReference: pagamento.external_reference,
        valor: pagamento.transaction_amount,
        moeda: pagamento.currency_id,
        raw: pagamento
      };
    } catch (err) {
      throw new GatewayPagamentoError(`Falha ao consultar o pagamento ${paymentId} no Mercado Pago: ${err.message}`, err);
    }
  }

  async estornar(paymentId, { idempotencyKey } = {}) {
    try {
      const refund = await new PaymentRefund(this.client).total({ payment_id: paymentId, requestOptions: { idempotencyKey } });
      return { refundId: String(refund.id), status: refund.status };
    } catch (err) {
      throw new GatewayPagamentoError(`Falha ao estornar o pagamento ${paymentId} no Mercado Pago: ${err.message}`, err);
    }
  }
}

module.exports = MercadoPagoGateway;
