class DomainError extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
  }
}

/** Transição de status não permitida (HTTP 409). */
class TransicaoInvalidaError extends DomainError {}

/** Recurso inexistente (HTTP 404). */
class NaoEncontradoError extends DomainError {}

/** Dados da OS não permitem gerar o orçamento (vira orcamento.falhou). */
class OrcamentoInvalidoError extends DomainError {}

/** Falha ao falar com o Mercado Pago (HTTP 502 / retry no consumer). */
class GatewayPagamentoError extends DomainError {
  constructor(message, cause) {
    super(message);
    this.cause = cause;
  }
}

/** Assinatura do webhook inválida (HTTP 401). */
class AssinaturaInvalidaError extends DomainError {}

module.exports = {
  DomainError,
  TransicaoInvalidaError,
  NaoEncontradoError,
  OrcamentoInvalidoError,
  GatewayPagamentoError,
  AssinaturaInvalidaError
};
