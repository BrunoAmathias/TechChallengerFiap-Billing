const pool = require("../database/connection");

class OutboxRepository {
  /** Grava o evento (envelope completo) na mesma transação do negócio. */
  async adicionar(evento, db = pool) {
    await db.query(
      `INSERT INTO outbox (id, aggregate_id, type, payload)
       VALUES ($1, $2, $3, $4)`,
      [evento.eventId, String(evento.correlationId), evento.type, evento]
    );
  }

  /**
   * Busca eventos pendentes travando as linhas. SKIP LOCKED permite várias
   * réplicas publicando ao mesmo tempo sem pegar o mesmo evento.
   */
  async buscarPendentes(limite, db) {
    const result = await db.query(
      `SELECT id, type, payload, attempts
       FROM outbox
       WHERE published_at IS NULL
       ORDER BY created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [limite]
    );
    return result.rows;
  }

  async marcarPublicado(id, db) {
    await db.query(`UPDATE outbox SET published_at = NOW() WHERE id = $1`, [id]);
  }

  async registrarFalha(id, mensagem, db) {
    await db.query(
      `UPDATE outbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1`,
      [id, String(mensagem).slice(0, 1000)]
    );
  }

  async contarPendentes(db = pool) {
    const result = await db.query(`SELECT COUNT(*)::int AS total FROM outbox WHERE published_at IS NULL`);
    return result.rows[0].total;
  }
}

module.exports = new OutboxRepository();
