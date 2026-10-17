const swaggerJSDoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Tech Challenger FIAP - Billing Service',
      version: '1.0.0',
      description: 'Orçamento, aprovação do cliente e pagamento (Mercado Pago) da oficina. Participa da saga coreografada via RabbitMQ.',
    },
    servers: [{ url: 'http://localhost:3001', description: 'Servidor de desenvolvimento' }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      schemas: {
        ItemOrcamento: {
          type: 'object',
          properties: {
            tipo: { type: 'string', enum: ['SERVICO', 'PECA'] },
            referenciaId: { type: 'integer' },
            descricao: { type: 'string' },
            quantidade: { type: 'integer' },
            valorUnitario: { type: 'number' },
            total: { type: 'number' },
          },
        },
        Pagamento: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            orcamentoId: { type: 'integer' },
            osId: { type: 'integer' },
            mpPreferenceId: { type: 'string' },
            mpPaymentId: { type: 'string', nullable: true },
            mpRefundId: { type: 'string', nullable: true },
            initPoint: { type: 'string' },
            status: { type: 'string', enum: ['PENDENTE', 'APROVADO', 'REJEITADO', 'EXPIRADO', 'ESTORNADO'] },
            valor: { type: 'number' },
          },
        },
        Orcamento: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            osId: { type: 'integer' },
            cliente: { type: 'object', properties: { nome: { type: 'string' }, email: { type: 'string' } } },
            itens: { type: 'array', items: { $ref: '#/components/schemas/ItemOrcamento' } },
            valorTotal: { type: 'number' },
            status: { type: 'string', enum: ['PENDENTE', 'APROVADO', 'RECUSADO', 'CANCELADO'] },
            motivo: { type: 'string', nullable: true },
            pagamento: { $ref: '#/components/schemas/Pagamento' },
          },
        },
      },
    },
  },
  apis: ['./src/interfaces/routes/*.js'],
};

module.exports = swaggerJSDoc(options);
