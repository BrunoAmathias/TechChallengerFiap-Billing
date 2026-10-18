const pool = require("../database/connection");

function mapear(linha) {
  if (!linha) return null;
  return {
    id: linha.id,
    orcamentoId: linha.orcamento_id,
    osId: linha.os_id,
    mpPreferenceId: linha.mp_preference_id,
    mpPaymentId: linha.mp_payment_id,
    mpRefundId: linha.mp_refund_id,
    initPoint: linha.init_point,
    status: linha.status,
    valor: Number(linha.valor),
    createdAt: linha.created_at,
    updatedAt: linha.updated_at
  };
}

class PagamentoRepository {
  async criar({ orcamentoId, osId, mpPreferenceId, initPoint, valor, status }, db = pool) {
    const result = await db.query(
      `INSERT INTO pagamentos (orcamento_id, os_id, mp_preference_id, init_point, valor, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [orcamentoId, osId, mpPreferenceId, initPoint, valor, status]
    );
    return mapear(result.rows[0]);
  }

  async buscarPorId(id, db = pool) {
    const result = await db.query(`SELECT * FROM pagamentos WHERE id = $1`, [id]);
    return mapear(result.rows[0]);
  }

  async buscarPorOrcamentoId(orcamentoId, db = pool) {
    const result = await db.query(`SELECT * FROM pagamentos WHERE orcamento_id = $1`, [orcamentoId]);
    return mapear(result.rows[0]);
  }

  async buscarPorOrcamentoParaAtualizar(orcamentoId, db) {
    const result = await db.query(`SELECT * FROM pagamentos WHERE orcamento_id = $1 FOR UPDATE`, [orcamentoId]);
    return mapear(result.rows[0]);
  }

  async buscarPorOsParaAtualizar(osId, db) {
    const result = await db.query(`SELECT * FROM pagamentos WHERE os_id = $1 FOR UPDATE`, [osId]);
    return mapear(result.rows[0]);
  }

  async atualizar(id, { status, mpPaymentId = null, mpRefundId = null, raw = null }, db = pool) {
    const result = await db.query(
      `UPDATE pagamentos
       SET status = $1,
           mp_payment_id = COALESCE($2, mp_payment_id),
           mp_refund_id = COALESCE($3, mp_refund_id),
           raw = COALESCE($4, raw),
           updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [status, mpPaymentId, mpRefundId, raw, id]
    );
    return mapear(result.rows[0]);
  }

  /** Pagamentos sem confirmação há mais de `minutos` (travados para expirar). */
  async buscarPendentesExpirados(minutos, limite, db) {
    const result = await db.query(
      `SELECT * FROM pagamentos
       WHERE status = 'PENDENTE' AND created_at < NOW() - ($1 || ' minutes')::interval
       ORDER BY created_at
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [String(minutos), limite]
    );
    return result.rows.map(mapear);
  }
}

module.exports = new PagamentoRepository();
module.exports.mapear = mapear;
