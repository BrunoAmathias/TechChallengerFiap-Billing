const express = require("express");
const router = express.Router();
const authMiddleware = require("../middlewares/auth.middleware");
const PagamentoController = require("../controllers/pagamento.controller");

/**
 * @swagger
 * /pagamentos/{id}:
 *   get:
 *     summary: Busca um pagamento
 *     tags: [Pagamentos]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Pagamento
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Pagamento' }
 *       404: { description: Pagamento não encontrado }
 */
router.get("/pagamentos/:id", authMiddleware, (req, res) => PagamentoController.buscarPorId(req, res));

/**
 * @swagger
 * /webhooks/mercadopago:
 *   post:
 *     summary: Notificações de pagamento do Mercado Pago
 *     description: |
 *       Valida o header x-signature (HMAC-SHA256 com MP_WEBHOOK_SECRET) e consulta o
 *       pagamento real em GET /v1/payments/:id antes de publicar pagamento.confirmado
 *       ou pagamento.falhou.
 *     tags: [Pagamentos]
 *     parameters:
 *       - in: query
 *         name: data.id
 *         schema: { type: string }
 *       - in: query
 *         name: type
 *         schema: { type: string, example: payment }
 *       - in: header
 *         name: x-signature
 *         schema: { type: string, example: "ts=1704908010,v1=618c8534..." }
 *       - in: header
 *         name: x-request-id
 *         schema: { type: string }
 *     responses:
 *       200: { description: Notificação recebida }
 *       401: { description: Assinatura inválida }
 *       502: { description: Falha ao consultar o Mercado Pago (o MP reenvia) }
 */
router.post("/webhooks/mercadopago", (req, res) => PagamentoController.webhook(req, res));

module.exports = router;
