const nodemailer = require("nodemailer");
const logger = require("../logger");

function formatarMoeda(valor) {
  return Number(valor).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

/**
 * Envio de e-mails do Billing (orçamento para aprovação). Sem SMTP
 * configurado, o e-mail é registrado apenas em log.
 */
class NotificationService {
  constructor({ env = process.env, transportFactory = nodemailer.createTransport } = {}) {
    this.env = env;
    this.transportFactory = transportFactory;
    this.transport = null;
  }

  getTransport() {
    const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM } = this.env;

    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !SMTP_FROM) return null;

    if (!this.transport) {
      this.transport = this.transportFactory({
        host: SMTP_HOST,
        port: Number(SMTP_PORT || 587),
        secure: SMTP_SECURE === "true",
        auth: { user: SMTP_USER, pass: SMTP_PASS }
      });
    }
    return this.transport;
  }

  montarEmailOrcamento(orcamento, links) {
    const linhas = orcamento.itens
      .map((i) => `- ${i.descricao} (${i.quantidade}x): ${formatarMoeda(i.total)}`)
      .join("\n");

    const subject = `Orçamento da OS #${orcamento.osId}: ${formatarMoeda(orcamento.valorTotal)}`;
    const body = [
      `Olá, ${orcamento.cliente.nome || "cliente"}!`,
      "",
      `O orçamento da sua ordem de serviço #${orcamento.osId}${orcamento.veiculo?.placa ? ` (veículo ${orcamento.veiculo.placa})` : ""} está pronto:`,
      "",
      linhas,
      "",
      `Total: ${formatarMoeda(orcamento.valorTotal)}`,
      "",
      `Aprovar e pagar: ${links.aprovar}`,
      `Recusar: ${links.recusar}`
    ].join("\n");

    return { subject, body };
  }

  async enviarOrcamento(orcamento, links) {
    const { subject, body } = this.montarEmailOrcamento(orcamento, links);
    return this.enviarEmail(orcamento.cliente.email, subject, body);
  }

  async enviarEmail(to, subject, body) {
    const transport = this.getTransport();

    if (!transport) {
      logger.info({ email: { to, subject, body } }, "SMTP não configurado: e-mail registrado apenas em log");
      return { enviado: false, fallback: true };
    }

    const info = await transport.sendMail({ from: this.env.SMTP_FROM, to, subject, text: body });
    return { enviado: true, messageId: info.messageId };
  }
}

module.exports = NotificationService;
