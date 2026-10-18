/** Tipos de evento da saga. O tipo também é a routing key na exchange oficina.events. */
module.exports = Object.freeze({
  // OS Service
  OS_ABERTA: 'os.aberta',
  OS_CANCELADA: 'os.cancelada',
  OS_ENTREGUE: 'os.entregue',

  // Billing Service
  ORCAMENTO_GERADO: 'orcamento.gerado',
  ORCAMENTO_APROVADO: 'orcamento.aprovado',
  ORCAMENTO_RECUSADO: 'orcamento.recusado',
  ORCAMENTO_FALHOU: 'orcamento.falhou',
  PAGAMENTO_CONFIRMADO: 'pagamento.confirmado',
  PAGAMENTO_FALHOU: 'pagamento.falhou',
  PAGAMENTO_ESTORNADO: 'pagamento.estornado',

  // Execution Service
  EXECUCAO_STATUS_ATUALIZADO: 'execucao.status_atualizado',
  EXECUCAO_FINALIZADA: 'execucao.finalizada',
  EXECUCAO_FALHOU: 'execucao.falhou'
});
