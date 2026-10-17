const { createHmac, timingSafeEqual } = require("node:crypto");
const { AssinaturaInvalidaError } = require("../../domain/errors");

/**
 * Valida o header x-signature das notificações do Mercado Pago.
 * Formato: "ts=<timestamp>,v1=<hmac>". O manifesto assinado (HMAC-SHA256 com
 * a chave secreta do webhook) é: "id:<data.id>;request-id:<x-request-id>;ts:<ts>;"
 * Partes ausentes são omitidas do manifesto, como na documentação do MP.
 */
function montarManifesto({ dataId, requestId, ts }) {
  let manifesto = "";
  if (dataId) {
    const id = /^[a-z0-9]+$/i.test(String(dataId)) ? String(dataId).toLowerCase() : String(dataId);
    manifesto += `id:${id};`;
  }
  if (requestId) manifesto += `request-id:${requestId};`;
  if (ts) manifesto += `ts:${ts};`;
  return manifesto;
}

function lerHeaderAssinatura(xSignature) {
  const partes = Object.fromEntries(
    String(xSignature || "")
      .split(",")
      .map((parte) => parte.split("=").map((v) => v?.trim()))
      .filter(([chave, valor]) => chave && valor)
  );
  return { ts: partes.ts, v1: partes.v1 };
}

function assinar(manifesto, secret) {
  return createHmac("sha256", secret).update(manifesto).digest("hex");
}

/** Aceita uma chave ou várias separadas por vírgula (rotação de chave, modos do painel). */
function listarSegredos(secret) {
  return (Array.isArray(secret) ? secret : String(secret || "").split(","))
    .map((s) => s.trim())
    .filter(Boolean);
}

function confere(esperadoHex, recebidoHex) {
  const esperado = Buffer.from(esperadoHex);
  const recebido = Buffer.from(recebidoHex);
  return esperado.length === recebido.length && timingSafeEqual(esperado, recebido);
}

function validarAssinatura({ xSignature, xRequestId, dataId, secret, toleranciaSegundos = 0, agora = Date.now() }) {
  const { ts, v1 } = lerHeaderAssinatura(xSignature);
  if (!ts || !v1) throw new AssinaturaInvalidaError("Header x-signature ausente ou malformado");

  const segredos = listarSegredos(secret);
  if (segredos.length === 0) throw new AssinaturaInvalidaError("Nenhuma chave de webhook configurada");

  const manifesto = montarManifesto({ dataId, requestId: xRequestId, ts });
  if (!segredos.some((s) => confere(assinar(manifesto, s), v1))) {
    throw new AssinaturaInvalidaError("Assinatura do webhook inválida");
  }

  if (toleranciaSegundos > 0) {
    const tsMs = Number(ts) > 1e12 ? Number(ts) : Number(ts) * 1000;
    if (Math.abs(agora - tsMs) > toleranciaSegundos * 1000) {
      throw new AssinaturaInvalidaError("Notificação fora da janela de tempo permitida");
    }
  }

  return true;
}

module.exports = { validarAssinatura, montarManifesto, lerHeaderAssinatura, assinar, listarSegredos };
