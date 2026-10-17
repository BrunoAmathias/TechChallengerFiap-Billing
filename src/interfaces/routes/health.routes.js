const express  = require("express");
const router = express.Router();
const healthController = require("../controllers/health.controller");
/********** Health Check **********/

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Readiness da API (banco e broker)
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: API pronta (status OK, ou DEGRADED com o broker fora)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: [OK, DEGRADED, DOWN]
 *                 checks:
 *                   type: object
 *                   properties:
 *                     database: { type: string, enum: [UP, DOWN] }
 *                     broker: { type: string, enum: [UP, DOWN, DISABLED] }
 *       503:
 *         description: Banco de dados indisponível
 */
router.get("/health", (req, res) => healthController.checkHealth(req, res));

/**
 * @swagger
 * /health/live:
 *   get:
 *     summary: Liveness da API (processo de pé)
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: Processo ativo
 */
router.get("/health/live", (req, res) => healthController.live(req, res));

module.exports = router;
