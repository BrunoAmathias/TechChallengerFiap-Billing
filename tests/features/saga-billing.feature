# language: pt
Funcionalidade: Orçamento e pagamento na saga (Billing Service)
  Como oficina
  Quero gerar o orçamento da OS, cobrar pelo Mercado Pago e estornar quando a execução falhar
  Para que o pagamento acompanhe o andamento da ordem de serviço

  Contexto:
    Dado que o OS Service publicou "os.aberta" com total de R$ 180,00 para "maria@email.com"

  Cenário: Orçamento aprovado e pago
    Então um orçamento "PENDENTE" de R$ 180,00 é criado
    E o evento "orcamento.gerado" é publicado
    E o cliente recebe o e-mail com os links de aprovar e recusar
    Quando o cliente aprova o orçamento
    Então o orçamento fica "APROVADO"
    E o checkout do Mercado Pago é criado
    E o evento "orcamento.aprovado" é publicado
    Quando o Mercado Pago notifica o pagamento como "approved" no valor de R$ 180,00
    Então o pagamento fica "APROVADO"
    E o evento "pagamento.confirmado" é publicado com os serviços e peças da OS

  Cenário: Cliente recusa o orçamento
    Quando o cliente recusa o orçamento
    Então o orçamento fica "RECUSADO"
    E o evento "orcamento.recusado" é publicado

  Cenário: Pagamento rejeitado pelo Mercado Pago
    Dado que o cliente aprovou o orçamento
    Quando o Mercado Pago notifica o pagamento como "rejected" no valor de R$ 180,00
    Então o pagamento fica "REJEITADO"
    E o orçamento fica "CANCELADO"
    E o evento "pagamento.falhou" é publicado

  Cenário: Pagamento com valor diferente do orçamento não é confirmado
    Dado que o cliente aprovou o orçamento
    Quando o Mercado Pago notifica o pagamento como "approved" no valor de R$ 1,00
    Então o pagamento fica "PENDENTE"
    E nenhum evento de pagamento é publicado

  Cenário: Falha na execução estorna o pagamento
    Dado que o cliente aprovou e pagou o orçamento
    Quando o Execution publica "execucao.falhou"
    Então o Mercado Pago recebe o pedido de estorno
    E o pagamento fica "ESTORNADO"
    E o orçamento fica "CANCELADO"
    E o evento "pagamento.estornado" é publicado
