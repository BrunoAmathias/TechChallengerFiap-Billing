const { createHmac, timingSafeEqual } = require("node:crypto");

const ACOES = ["aprovar", "recusar"];

/**
 * Links assinados do e-mail de orçamento: o cliente aprova ou recusa sem login.
 * O token é HMAC-SHA256 de "<orcamentoId>:<acao>" com APPROVAL_LINK_SECRET.
 */
function gerarToken(orcamentoId, acao, secret) {
  return createHmac("sha256", secret).update(`${orcamentoId}:${acao}`).digest("hex");
}

function tokenValido(orcamentoId, acao, token, secret) {
  if (!secret || !ACOES.includes(acao) || typeof token !== "string") return false;

  const esperado = Buffer.from(gerarToken(orcamentoId, acao, secret));
  const recebido = Buffer.from(token);
  return esperado.length === recebido.length && timingSafeEqual(esperado, recebido);
}

function gerarLinks(orcamentoId, { baseUrl, secret }) {
  if (!secret) throw new Error("APPROVAL_LINK_SECRET (ou JWT_SECRET) não configurado");

  const link = (acao) =>
    `${baseUrl}/orcamentos/${orcamentoId}/decisao?acao=${acao}&token=${gerarToken(orcamentoId, acao, secret)}`;
  return { aprovar: link("aprovar"), recusar: link("recusar") };
}

module.exports = { gerarToken, tokenValido, gerarLinks, ACOES };
