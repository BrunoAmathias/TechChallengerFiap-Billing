const {
  NaoEncontradoError,
  TransicaoInvalidaError,
  GatewayPagamentoError,
  AssinaturaInvalidaError
} = require("../domain/errors");
const logger = require("../infrastructure/logger");

function statusDoErro(err) {
  if (err instanceof NaoEncontradoError) return 404;
  if (err instanceof TransicaoInvalidaError) return 409;
  if (err instanceof AssinaturaInvalidaError) return 401;
  if (err instanceof GatewayPagamentoError) return 502;
  return 500;
}

/** Responde o erro com o status HTTP do tipo de erro de domínio. */
function responderErro(res, err) {
  const status = statusDoErro(err);
  if (status >= 500) logger.error({ err }, "Erro ao processar requisição");
  return res.status(status).json({ error: err.message });
}

module.exports = { statusDoErro, responderErro };
