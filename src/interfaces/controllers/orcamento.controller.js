const { useCases, links } = require("../../container");
const { tokenValido } = require("../../application/linkAprovacao");
const { responderErro } = require("../httpErrors");

class OrcamentoController {
  async buscarPorId(req, res) {
    try {
      return res.status(200).json(await useCases.buscarOrcamento.porId(req.params.id));
    } catch (err) {
      return responderErro(res, err);
    }
  }

  async buscarPorOs(req, res) {
    try {
      return res.status(200).json(await useCases.buscarOrcamento.porOs(req.params.osId));
    } catch (err) {
      return responderErro(res, err);
    }
  }

  async aprovar(req, res) {
    try {
      const { orcamento, pagamento, initPoint } = await useCases.aprovarOrcamento.execute(req.params.id);
      return res.status(200).json({ orcamento, pagamento, initPoint });
    } catch (err) {
      return responderErro(res, err);
    }
  }

  async recusar(req, res) {
    try {
      return res.status(200).json(await useCases.recusarOrcamento.execute(req.params.id, req.body?.motivo ?? null));
    } catch (err) {
      return responderErro(res, err);
    }
  }

  /**
   * Link do e-mail (GET, sem login): aprovar redireciona para o checkout do
   * Mercado Pago; recusar confirma a recusa.
   */
  async decisao(req, res) {
    const { id } = req.params;
    const { acao, token } = req.query;

    if (!tokenValido(id, acao, token, links.secret)) {
      return res.status(401).json({ error: "Link de aprovação inválido" });
    }

    try {
      if (acao === "aprovar") {
        const { initPoint } = await useCases.aprovarOrcamento.execute(id);
        return res.redirect(302, initPoint);
      }

      await useCases.recusarOrcamento.execute(id, "Recusado pelo cliente via link do e-mail");
      return res.status(200).json({ mensagem: "Orçamento recusado. A ordem de serviço será cancelada." });
    } catch (err) {
      return responderErro(res, err);
    }
  }
}

module.exports = new OrcamentoController();
