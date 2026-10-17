const pool = require("./connection");

/**
 * Executa `fn(client)` dentro de uma transação. Tudo o que os repositórios
 * gravarem com esse `client` (OS, histórico, estoque, outbox, eventos
 * processados) é confirmado ou desfeito junto.
 */
class UnitOfWork {
  constructor(dbPool = pool) {
    this.pool = dbPool;
  }

  async run(fn) {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = new UnitOfWork();
module.exports.UnitOfWork = UnitOfWork;
