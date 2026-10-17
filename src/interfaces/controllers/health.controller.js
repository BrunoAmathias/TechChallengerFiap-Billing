const pool = require("../../infrastructure/database/connection");

class HealthK8sController {
  /** Liveness: o processo está de pé (não depende de banco nem broker). */
  async live(req, res) {
    return res.status(200).json({ status: "OK", timestamp: new Date().toISOString() });
  }

  /**
   * Readiness: banco obrigatório (503 se fora). O broker é reportado, mas sem
   * ele a API continua atendendo: os eventos ficam no outbox até a reconexão.
   */
  async checkHealth(req, res) {
    const checks = { database: "UP", broker: "DISABLED" };

    try {
      await pool.query("SELECT 1");
    } catch {
      checks.database = "DOWN";
    }

    const mensageria = req.app.locals.mensageria;
    if (mensageria) {
      checks.broker = mensageria.isConnected() ? "UP" : "DOWN";
    }

    let status = "OK";
    if (checks.database === "DOWN") status = "DOWN";
    else if (checks.broker === "DOWN") status = "DEGRADED";

    return res.status(status === "DOWN" ? 503 : 200).json({
      status,
      checks,
      timestamp: new Date().toISOString()
    });
  }
}

module.exports = new HealthK8sController();
