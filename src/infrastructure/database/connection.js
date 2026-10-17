const { Pool } = require('pg');
const logger = require('../logger');

/**
 * Monta a connection string a partir de DB_URL (preferencial) ou das
 * variáveis DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD.
 */
function buildConnectionString(env = process.env) {
  if (env.DB_URL) return env.DB_URL;
  if (!env.DB_HOST) return undefined;

  const user = encodeURIComponent(env.DB_USER || 'postgres');
  const password = encodeURIComponent(env.DB_PASSWORD || '');
  const port = env.DB_PORT || '5432';
  return `postgresql://${user}:${password}@${env.DB_HOST}:${port}/${env.DB_NAME || 'oficina'}`;
}

function buildSslConfig(env = process.env) {
  if (env.DB_SSL === 'false') return false;
  return { rejectUnauthorized: false };
}

const pool = new Pool({
  connectionString: buildConnectionString(),
  ssl: buildSslConfig()
});

pool.on('error', (error) => {
  logger.error({ err: error }, 'Erro inesperado no pool do PostgreSQL');
});

if (process.env.NODE_ENV !== 'test') {
  pool.query('SELECT NOW()')
    .then(() => logger.info('PostgreSQL conectado'))
    .catch((error) => logger.error({ err: error }, 'Erro ao conectar ao PostgreSQL'));
}

module.exports = pool;
module.exports.buildConnectionString = buildConnectionString;
module.exports.buildSslConfig = buildSslConfig;
