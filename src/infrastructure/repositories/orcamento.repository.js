const pool = require("../database/connection");

function mapear(linha) {
  if (!linha) return null;
  return {
    id: linha.id,
    osId: linha.os_id,
    cliente: linha.cliente,
    veiculo: linha.veiculo,
    itens: linha.itens,
    valorTotal: Number(linha.valor_total),
    status: linha.status,
    motivo: linha.motivo,
    createdAt: linha.created_at,
    updatedAt: linha.updated_at
  };
}

class OrcamentoRepository {
  async criar(orcamento, db = pool) {
    const result = await db.query(
      `INSERT INTO orcamentos (os_id, cliente, veiculo, itens, valor_total, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        orcamento.osId,
        orcamento.cliente,
        orcamento.veiculo,
        JSON.stringify(orcamento.itens),
        orcamento.valorTotal,
        orcamento.status
      ]
    );
    return mapear(result.rows[0]);
  }

  async buscarPorId(id, db = pool) {
    const result = await db.query(`SELECT * FROM orcamentos WHERE id = $1`, [id]);
    return mapear(result.rows[0]);
  }

  async buscarPorOsId(osId, db = pool) {
    const result = await db.query(`SELECT * FROM orcamentos WHERE os_id = $1`, [osId]);
    return mapear(result.rows[0]);
  }

  /** Lê com lock de linha até o fim da transação (evita aprovar e recusar ao mesmo tempo). */
  async buscarParaAtualizar(id, db) {
    const result = await db.query(`SELECT * FROM orcamentos WHERE id = $1 FOR UPDATE`, [id]);
    return mapear(result.rows[0]);
  }

  async atualizarStatus(id, status, motivo = null, db = pool) {
    const result = await db.query(
      `UPDATE orcamentos
       SET status = $1, motivo = COALESCE($2, motivo), updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [status, motivo, id]
    );
    return mapear(result.rows[0]);
  }
}

module.exports = new OrcamentoRepository();
module.exports.mapear = mapear;
