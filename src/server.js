require('newrelic');
require('dotenv').config({ quiet: true });
const express = require('express');
const swaggerUi = require('swagger-ui-express');
const swaggerSpecs = require('./swagger.config');
const logger = require('./infrastructure/logger');
const correlationIdMiddleware = require('./interfaces/middlewares/correlationId.middleware');

const app = express();
app.disable("x-powered-by"); // não expõe a tecnologia do servidor no header X-Powered-By

app.use(correlationIdMiddleware);
app.use(express.json());
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpecs));

app.use(require('./interfaces/routes/health.routes'));
app.use(require('./interfaces/routes/orcamento.routes'));
app.use(require('./interfaces/routes/pagamento.routes'));

module.exports = app;

if (require.main === module) {
  // Falha cedo: sem estes valores o serviço consumiria eventos só para falhar.
  const faltando = ['DB_URL', 'JWT_SECRET'].filter((nome) => !process.env[nome]);
  if (process.env.MERCADOPAGO_MODE !== 'fake') {
    faltando.push(...['MP_ACCESS_TOKEN', 'MP_WEBHOOK_SECRET'].filter((nome) => !process.env[nome]));
  }
  if (faltando.length > 0) {
    logger.fatal({ faltando }, 'Configuração obrigatória ausente');
    process.exit(1);
  }

  const { iniciarMensageria } = require('./infrastructure/messaging');
  const { handlers, repositories, unitOfWork, useCases } = require('./container');
  const pool = require('./infrastructure/database/connection');

  if (process.env.RABBITMQ_URL) {
    app.locals.mensageria = iniciarMensageria({
      url: process.env.RABBITMQ_URL,
      handlers,
      outboxRepository: repositories.outboxRepository,
      unitOfWork
    });
  } else {
    logger.warn('RABBITMQ_URL não definido: mensageria desabilitada (eventos ficam no outbox)');
  }

  // Pagamentos sem confirmação no prazo viram pagamento.falhou (compensação)
  const expiracao = setInterval(() => {
    useCases.expirarPagamentos
      .execute()
      .then((total) => total > 0 && logger.info({ total }, 'Pagamentos pendentes expirados'))
      .catch((err) => logger.error({ err }, 'Erro ao expirar pagamentos pendentes'));
  }, Number(process.env.PAYMENT_EXPIRATION_CHECK_MS) || 60000);
  expiracao.unref();

  const port = Number(process.env.PORT) || 3000;
  const server = app.listen(port, () => {
    logger.info({ port }, `Billing Service rodando na porta ${port} (Swagger em /api-docs)`);
  });

  const encerrar = async (signal) => {
    logger.info({ signal }, 'Encerrando o Billing Service');
    clearInterval(expiracao);
    server.close();
    await app.locals.mensageria?.stop();
    await pool.end().catch(() => {});
    process.exit(0);
  };

  process.on('SIGTERM', encerrar);
  process.on('SIGINT', encerrar);
}
