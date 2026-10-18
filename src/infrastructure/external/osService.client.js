const { NaoEncontradoError } = require("../../domain/errors");

/**
 * Cliente da API interna do OS Service (somente consulta, REST síncrono).
 * Usado quando o evento não traz um dado necessário (ex.: e-mail do cliente).
 */
class OsServiceClient {
  constructor({ baseUrl, serviceToken, timeoutMs = 3000, fetchImpl = globalThis.fetch }) {
    this.baseUrl = baseUrl;
    this.serviceToken = serviceToken;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  async buscarOs(osId) {
    if (!this.baseUrl) throw new Error("OS_SERVICE_URL não configurado");

    const resposta = await this.fetch(`${this.baseUrl}/internal/os/${encodeURIComponent(osId)}`, {
      headers: { "x-service-token": this.serviceToken || "", accept: "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs)
    });

    if (resposta.status === 404) throw new NaoEncontradoError(`OS ${osId} não encontrada no OS Service`);
    if (!resposta.ok) throw new Error(`OS Service respondeu ${resposta.status} para a OS ${osId}`);

    return resposta.json();
  }
}

module.exports = OsServiceClient;
