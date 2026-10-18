const express = require("express");
const router = express.Router();
const authMiddleware = require("../middlewares/auth.middleware");
const OrcamentoController = require("../controllers/orcamento.controller");

/**
 * @swagger
 * tags:
 *   - name: Orçamentos
 *     description: Orçamento gerado a partir da OS e decisão do cliente
 */

/**
 * @swagger
 * /orcamentos/{id}:
 *   get:
 *     summary: Busca um orçamento (com o pagamento, se houver)
 *     tags: [Orçamentos]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Orçamento
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Orcamento' }
 *       404: { description: Orçamento não encontrado }
 */
router.get("/orcamentos/:id", authMiddleware, (req, res) => OrcamentoController.buscarPorId(req, res));

/**
 * @swagger
 * /orcamentos/os/{osId}:
 *   get:
 *     summary: Busca o orçamento de uma ordem de serviço
 *     tags: [Orçamentos]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: osId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Orçamento
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Orcamento' }
 *       404: { description: Nenhum orçamento para a OS }
 */
router.get("/orcamentos/os/:osId", authMiddleware, (req, res) => OrcamentoController.buscarPorOs(req, res));

/**
 * @swagger
 * /orcamentos/{id}/aprovar:
 *   post:
 *     summary: Aprova o orçamento e cria o checkout no Mercado Pago
 *     description: Publica orcamento.aprovado. Repetir a chamada devolve o mesmo link de pagamento.
 *     tags: [Orçamentos]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Orçamento aprovado e link de pagamento (initPoint)
 *       404: { description: Orçamento não encontrado }
 *       409: { description: Orçamento recusado ou cancelado }
 *       502: { description: Falha no Mercado Pago }
 */
router.post("/orcamentos/:id/aprovar", authMiddleware, (req, res) => OrcamentoController.aprovar(req, res));

/**
 * @swagger
 * /orcamentos/{id}/recusar:
 *   post:
 *     summary: Recusa o orçamento (a OS é cancelada e o estoque devolvido)
 *     tags: [Orçamentos]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               motivo: { type: string, example: Achou caro }
 *     responses:
 *       200: { description: Orçamento recusado }
 *       404: { description: Orçamento não encontrado }
 *       409: { description: Orçamento já aprovado ou cancelado }
 */
router.post("/orcamentos/:id/recusar", authMiddleware, (req, res) => OrcamentoController.recusar(req, res));

/**
 * @swagger
 * /orcamentos/{id}/decisao:
 *   get:
 *     summary: Link do e-mail para o cliente aprovar ou recusar sem login
 *     tags: [Orçamentos]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: acao
 *         required: true
 *         schema: { type: string, enum: [aprovar, recusar] }
 *       - in: query
 *         name: token
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       302: { description: Aprovado, redireciona para o checkout do Mercado Pago }
 *       200: { description: Recusado }
 *       401: { description: Link inválido }
 */
router.get("/orcamentos/:id/decisao", (req, res) => OrcamentoController.decisao(req, res));

module.exports = router;
