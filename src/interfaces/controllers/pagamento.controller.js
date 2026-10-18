const newrelic = require("newrelic");
const { useCases } = require("../../container");
const { validarAssinatura } = require("../../infrastructure/external/webhookSignature");
const { NaoEncontradoError, AssinaturaInvalidaError } = require("../../domain/errors");
const { responderErro } = require("../httpErrors");
const logger = require("../../infrastructure/logger");

class PagamentoController {
  async buscarPorId(req, res) {
    try {
      return res.status(200).json(await useCases.buscarPagamento.execute(req.params.id));
    } catch (err) {
      return responderErro(res, err);
    }
  }

  /**
   * POST /webhooks/mercadopago. O MP manda ?data.id=<id>&type=payment e um corpo
   * { type, action, data: { id } }. Responde 200 rápido para notificações que
   * não interessam; 5xx faz o MP reenviar.
   */
  async webhook(req, res) {
    const dataId = req.query["data.id"] ?? req.body?.data?.id;
    const tipo = req.query.type ?? req.body?.type ?? req.query.topic;
    // Dados não sensíveis: o hash v1 não revela a chave; a chave nunca é registrada
    const contexto = {
      query: req.query,
      bodyType: req.body?.type,
      bodyAction: req.body?.action,
      dataId,
      tipo,
      xSignature: req.get("x-signature") || null,
      xRequestId: req.get("x-request-id") || null
    };
    logger.info(contexto, "Webhook do Mercado Pago recebido");

    // Formato IPN legado (?topic=...&id=...): não segue a assinatura dos webhooks
    // e chega junto com o webhook equivalente. Responde 200 sem processar nada,
    // para o MP não ficar reenviando.
    if (req.query.topic && req.query["data.id"] === undefined && !req.body?.data?.id) {
      return res.status(200).json({ recebido: true, ignorado: `notificação IPN ${req.query.topic}` });
    }

    try {
      this.verificarAssinatura(req, dataId, contexto);

      if (tipo !== "payment" || !dataId) {
        return res.status(200).json({ recebido: true, ignorado: `notificação ${tipo || "sem tipo"}` });
      }

      const resultado = await useCases.processarWebhook.execute({ paymentId: String(dataId) });
      logger.info({ paymentId: dataId, resultado: resultado.resultado }, "Webhook do Mercado Pago processado");
      return res.status(200).json({ recebido: true, resultado: resultado.resultado });
    } catch (err) {
      if (err instanceof NaoEncontradoError) {
        logger.warn({ paymentId: dataId, err }, "Webhook de pagamento desconhecido ignorado");
        return res.status(200).json({ recebido: true, ignorado: err.message });
      }
      if (err instanceof AssinaturaInvalidaError) {
        logger.warn({ ...contexto, motivo: err.message }, "Webhook do Mercado Pago recusado");
      }
      return responderErro(res, err);
    }
  }

  /**
   * MP_WEBHOOK_SIGNATURE=enforce (padrão): assinatura inválida → 401.
   * MP_WEBHOOK_SIGNATURE=warn: assinatura inválida vira alerta e o aviso segue.
   * O modo warn não abre brecha porque o Billing nunca confia no corpo do aviso:
   * o status, o valor e a moeda vêm de GET /v1/payments/:id com o access token.
   * Use warn só no sandbox (contas de teste do MP assinam avisos automáticos com
   * uma chave diferente da exibida no painel).
   */
  verificarAssinatura(req, dataId, contexto) {
    const modoWarn = process.env.MP_WEBHOOK_SIGNATURE === "warn";
    const secret = process.env.MP_WEBHOOK_SECRET;

    try {
      if (secret) {
        validarAssinatura({
          xSignature: req.get("x-signature"),
          xRequestId: req.get("x-request-id"),
          dataId,
          secret,
          toleranciaSegundos: Number(process.env.MP_WEBHOOK_TOLERANCE_SECONDS) || 0
        });
      } else if (process.env.MERCADOPAGO_MODE !== "fake") {
        throw new AssinaturaInvalidaError("MP_WEBHOOK_SECRET não configurado");
      }
    } catch (err) {
      if (!modoWarn || !(err instanceof AssinaturaInvalidaError)) throw err;

      logger.warn({ ...contexto, motivo: err.message }, "Assinatura do webhook inválida aceita (MP_WEBHOOK_SIGNATURE=warn)");
      newrelic.recordCustomEvent("WebhookAssinaturaInvalida", {
        paymentId: String(dataId ?? ""),
        motivo: err.message,
        modo: "warn"
      });
    }
  }
}

module.exports = new PagamentoController();
