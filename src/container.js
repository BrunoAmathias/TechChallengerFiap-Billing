/**
 * Composition root do Billing Service.
 */
const orcamentoRepository = require("./infrastructure/repositories/orcamento.repository");
const pagamentoRepository = require("./infrastructure/repositories/pagamento.repository");
const outboxRepository = require("./infrastructure/repositories/outbox.repository");
const processedEventsRepository = require("./infrastructure/repositories/processedEvents.repository");
const unitOfWork = require("./infrastructure/database/unitOfWork");
const MercadoPagoGateway = require("./infrastructure/external/mercadoPago.gateway");
const FakeMercadoPagoGateway = require("./infrastructure/external/fakeMercadoPago.gateway");
const OsServiceClient = require("./infrastructure/external/osService.client");
const NotificationService = require("./infrastructure/external/notification.service");
const logger = require("./infrastructure/logger");

const { GerarOrcamento, AprovarOrcamento, RecusarOrcamento, BuscarOrcamento } = require("./application/orcamento.service");
const {
  ProcessarWebhookPagamento,
  EstornarPagamento,
  ExpirarPagamentosPendentes,
  BuscarPagamento
} = require("./application/pagamento.service");
const { criarHandlers } = require("./application/handlers");

const env = process.env;
const publicBaseUrl = env.PUBLIC_BASE_URL || `http://localhost:${env.PORT || 3000}`;

/**
 * notification_url enviada em cada preferência. "painel" não envia nenhuma: o
 * Mercado Pago usa o webhook configurado em Suas integrações, cujos avisos vêm
 * assinados com a chave do painel. Os avisos da notification_url da preferência
 * chegam também no formato IPN e não validaram com essa chave nos testes.
 */
function urlDeNotificacao() {
  if (env.MP_NOTIFICATION_URL === "painel") return undefined;
  return env.MP_NOTIFICATION_URL || `${publicBaseUrl}/webhooks/mercadopago`;
}

function criarGateway() {
  if (env.MERCADOPAGO_MODE === "fake") {
    logger.warn("MERCADOPAGO_MODE=fake: usando gateway de pagamento simulado");
    return new FakeMercadoPagoGateway({ baseUrl: publicBaseUrl });
  }

  return new MercadoPagoGateway({
    accessToken: env.MP_ACCESS_TOKEN,
    notificationUrl: urlDeNotificacao(),
    backUrl: env.MP_BACK_URL,
    sandbox: env.MP_SANDBOX !== "false"
  });
}

/** O gateway real exige credenciais, então só é criado quando usado. */
let gatewayInstance = null;
const gateway = new Proxy(
  {},
  {
    get(_alvo, prop) {
      gatewayInstance = gatewayInstance || criarGateway();
      const valor = gatewayInstance[prop];
      return typeof valor === "function" ? valor.bind(gatewayInstance) : valor;
    }
  }
);

const osServiceClient = new OsServiceClient({ baseUrl: env.OS_SERVICE_URL, serviceToken: env.SERVICE_TOKEN });
const notificationService = new NotificationService();
const links = { baseUrl: publicBaseUrl, secret: env.APPROVAL_LINK_SECRET || env.JWT_SECRET };

const deps = {
  orcamentoRepository,
  pagamentoRepository,
  outboxRepository,
  processedEventsRepository,
  unitOfWork,
  gateway
};

const useCases = {
  gerarOrcamento: new GerarOrcamento({ ...deps, notificationService, osServiceClient, links }),
  aprovarOrcamento: new AprovarOrcamento(deps),
  recusarOrcamento: new RecusarOrcamento(deps),
  buscarOrcamento: new BuscarOrcamento(deps),
  processarWebhook: new ProcessarWebhookPagamento(deps),
  estornarPagamento: new EstornarPagamento(deps),
  expirarPagamentos: new ExpirarPagamentosPendentes({
    ...deps,
    prazoMinutos: Number(env.PAYMENT_EXPIRATION_MINUTES) || 1440
  }),
  buscarPagamento: new BuscarPagamento(deps)
};

const handlers = criarHandlers(useCases);

module.exports = { useCases, handlers, repositories: { outboxRepository }, unitOfWork, links };
