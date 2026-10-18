const pool = require("../database/connection");

class ProcessedEventsRepository {
  /**
   * Registra o eventId como processado. Retorna false se ele já tinha sido
   * processado antes (mensagem duplicada), e o handler não deve fazer nada.
   */
  async registrar(eventId, type, db = pool) {
    const result = await db.query(
      `INSERT INTO processed_events (event_id, type)
       VALUES ($1, $2)
       ON CONFLICT (event_id) DO NOTHING`,
      [eventId, type]
    );
    return result.rowCount === 1;
  }
}

module.exports = new ProcessedEventsRepository();
