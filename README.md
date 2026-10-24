# TechChallengerFiap-Billing — Billing Service

Microsserviço de **orçamento, aprovação e pagamento** da oficina. Faz parte da saga coreografada com o OS Service e o Execution Service (RabbitMQ) e integra com o **Mercado Pago** (Checkout Pro, webhook e estorno).

| | |
|---|---|
| Banco | PostgreSQL (Neon, database `billing_db`), só deste serviço |
| Mensageria | RabbitMQ: consome `os.aberta` e `execucao.falhou`; publica `orcamento.*` e `pagamento.*` |
| Stack | Node 20, Express 5, pg, node-pg-migrate, amqplib, mercadopago v2, nodemailer, pino, New Relic, Jest |
| Observabilidade | New Relic (`oficina-billing`): trace distribuído pela saga, evento `SagaEvento` por evento consumido e logs ligados ao trace ([detalhes](https://github.com/BrunoAmathias/TechChallengerFiap-Application/blob/Dev/docs/observabilidade.md)) |
| Documentação geral | Visão do sistema, arquitetura e ADRs no [repo Application](https://github.com/BrunoAmathias/TechChallengerFiap-Application/blob/Dev/README.md) |

## Responsabilidades

1. **Gerar orçamento:** ao receber `os.aberta`, cria o orçamento PENDENTE, publica `orcamento.gerado` e envia o e-mail com os links assinados de aprovar e recusar. Se a OS não puder ser orçada, publica `orcamento.falhou`.
2. **Aprovação:** cria a preferência no Mercado Pago, devolve o link de pagamento (`initPoint`) e publica `orcamento.aprovado`. A recusa publica `orcamento.recusado`.
3. **Pagamento:** o webhook valida a assinatura, consulta o pagamento real no MP e publica `pagamento.confirmado` ou `pagamento.falhou`. Pagamentos não concluídos no prazo expiram (`pagamento.falhou`).
4. **Estorno (compensação):** ao receber `execucao.falhou`, faz o reembolso no MP e publica `pagamento.estornado`.

Os contratos completos dos eventos estão em [docs/eventos.md](docs/eventos.md).

## Endpoints

| Método | Rota | Auth | Descrição |
|---|---|---|---|
| GET | `/orcamentos/:id` | JWT | Orçamento com o pagamento |
| GET | `/orcamentos/os/:osId` | JWT | Orçamento de uma OS |
| POST | `/orcamentos/:id/aprovar` | JWT | Aprova e devolve o `initPoint` do Mercado Pago |
| POST | `/orcamentos/:id/recusar` | JWT | Recusa (`{ motivo }` opcional) |
| GET | `/orcamentos/:id/decisao?acao=aprovar\|recusar&token=` | link assinado | Link do e-mail. Aprovar redireciona (302) ao checkout |
| GET | `/pagamentos/:id` | JWT | Pagamento |
| POST | `/webhooks/mercadopago` | `x-signature` | Notificações do Mercado Pago |
| GET | `/health` · `/health/live` | – | Readiness (banco e broker) e liveness |
| GET | `/api-docs` | – | Swagger |

O JWT é o mesmo do OS Service e da Lambda de login (`JWT_SECRET` compartilhado).

## Arquitetura

```text
src/
├── domain/            Orcamento e Pagamento (estados e regras), erros
├── application/       casos de uso (orcamento.service, pagamento.service), handlers da saga, eventos
├── infrastructure/
│   ├── database/      pg (connection) + unitOfWork (transação)
│   ├── repositories/  orcamentos, pagamentos, outbox, processed_events
│   ├── messaging/     RabbitMQ: conexão, topologia (retry/DLQ), consumer, outbox publisher
│   └── external/      Mercado Pago (real e fake), assinatura do webhook, OS Service, e-mail
└── interfaces/        rotas, controllers, middlewares (JWT, correlationId)
```

Cada mudança de estado grava o evento na tabela `outbox` na mesma transação (Transactional Outbox). Os consumers são idempotentes (`processed_events`).

## Como rodar

```bash
cp .env.example .env          # MERCADOPAGO_MODE=fake roda sem credenciais do MP
docker compose up -d db rabbitmq
npm install
DB_URL=postgresql://postgres:postgres@localhost:5434/billing_db npm run migrate:up
npm run dev                   # http://localhost:3001/api-docs
```

Para pagar de verdade no sandbox, configure `MERCADOPAGO_MODE=real`, `MP_ACCESS_TOKEN` (credencial de teste), `MP_WEBHOOK_SECRET` (assinatura secreta do webhook no painel do MP) e uma `PUBLIC_BASE_URL` acessível pelo MP.

### Testes

```bash
npm run test:unit             # só unitários (rápido)
npm run test:coverage         # todos os testes + cobertura mínima de 80% (o mesmo do CI)
npm run test:integration      # exige Postgres (DB_URL) com as migrations aplicadas
```

O Mercado Pago é mockado com `nock` no nível HTTP, então o SDK real é exercitado.

## CI/CD e qualidade

| Workflow | Quando roda | O que faz |
|---|---|---|
| `.github/workflows/ci.yml` | PR para `Dev`, `Homolog` e `main`; push em `Dev` e `Homolog` | `npm ci`, lint, migrations num Postgres de serviço, testes com cobertura, SonarCloud + Quality Gate, `docker build` |
| `.github/workflows/cd.yml` | push na `main` (merge do PR) ou manual | roda o CI inteiro; build e push da imagem no ECR (`billing-service:<sha>`); cria o Secret `billing-secret` a partir dos GitHub Secrets; `kubectl kustomize` com a imagem nova; rollout e smoke test do `/health` |

**Qualidade exigida no CI** (o job `ci` falha se qualquer item falhar):
- ESLint (`npm run lint`);
- testes unitários, BDD e de integração (Postgres de serviço no CI) com **cobertura mínima de 80%** em linhas, branches, funções e statements (`coverageThreshold` do `jest.config.js`);
- cenários **BDD** em português (`tests/features/*.feature`, jest-cucumber), rodados junto com os demais testes;
- **SonarCloud** (projeto `BrunoAmathias_TechChallengerFiap-Billing`) com `sonar.qualitygate.wait=true`, **só na `main`** (dentro do CD, antes do deploy): o plano da organização no SonarCloud não libera resultados nem Quality Gate de outras branches. Quality Gate reprovado **impede o deploy**.

```bash
npm run lint
npm run test:bdd
DB_URL=postgresql://... npm run migrate:up && npm run test:coverage   # todos os testes, inclusive integração
```

### Cobertura de testes

[![Quality Gate](https://sonarcloud.io/api/project_badges/measure?project=BrunoAmathias_TechChallengerFiap-Billing&metric=alert_status)](https://sonarcloud.io/summary/overall?id=BrunoAmathias_TechChallengerFiap-Billing)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=BrunoAmathias_TechChallengerFiap-Billing&metric=coverage)](https://sonarcloud.io/component_measures?id=BrunoAmathias_TechChallengerFiap-Billing&metric=coverage)
[![Bugs](https://sonarcloud.io/api/project_badges/measure?project=BrunoAmathias_TechChallengerFiap-Billing&metric=bugs)](https://sonarcloud.io/summary/overall?id=BrunoAmathias_TechChallengerFiap-Billing)
[![Vulnerabilities](https://sonarcloud.io/api/project_badges/measure?project=BrunoAmathias_TechChallengerFiap-Billing&metric=vulnerabilities)](https://sonarcloud.io/summary/overall?id=BrunoAmathias_TechChallengerFiap-Billing)

Resultado de `npm run test:coverage` (todos os testes: unitários, BDD e integração com PostgreSQL), medido em 24/10/2026. O mínimo exigido pelo `jest.config.js` é 80% em todas as métricas:

| Testes | Statements | Branches | Funções | Linhas |
|---|---|---|---|---|
| 142 (10 suítes) | 96,11% | 85,32% | 90,52% | 96,99% |

- **Relatório no SonarCloud** (atualizado a cada deploy da `main`): [sonarcloud.io/summary/overall?id=BrunoAmathias_TechChallengerFiap-Billing](https://sonarcloud.io/summary/overall?id=BrunoAmathias_TechChallengerFiap-Billing).
- **Relatório local por arquivo:** depois de `npm run test:coverage`, abra `coverage/lcov-report/index.html`.
- **No CI:** a etapa "Testes ... com cobertura mínima de 80%" do job `ci` (aba Actions) mostra o resumo e falha se alguma métrica ficar abaixo de 80%.

### Secrets e variáveis do repositório (GitHub → Settings → Secrets and variables → Actions)

| Nome | Tipo | Uso |
|---|---|---|
| `DB_URL`, `JWT_SECRET`, `APPROVAL_LINK_SECRET`, `PUBLIC_BASE_URL`, `NEW_RELIC_LICENSE_KEY` | secret | conteúdo do `billing-secret` |
| `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET` | secret | Mercado Pago (obrigatórios fora do modo `fake`) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | secret (opcional) | e-mail do orçamento |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` | secret | push no ECR e deploy no EKS |
| `SONAR_TOKEN` | secret | análise no SonarCloud (sem ele, o CI só avisa e segue) |
| `ECR_REPOSITORY` | variable (opcional) | padrão `billing-service` |
| `MERCADOPAGO_MODE` | variable (opcional) | `real` (padrão) ou `fake` |
| `MP_WEBHOOK_SIGNATURE` | variable (opcional) | `enforce` (padrão, produção) ou `warn` (só sandbox com contas de teste do MP; ver `docs/eventos.md`) |

O namespace `billing` e os Secrets `rabbitmq` e `service-auth` são criados pelo Terraform do repo `TechChallengerFiap-K8s`; o CD só confere que existem.

### Proteção das branches main e Homolog

Ruleset "Main" do GitHub nas branches `main` e `Homolog`: PR obrigatório, check `ci` obrigatório e com a branch atualizada (lint, testes e cobertura mínima de 80%; o Quality Gate do Sonar é verificado no CD, antes do deploy), sem push direto, force push ou exclusão. A configuração é feita pelo script do repo Application, com um token de administração do repositório:

```bash
export GH_TOKEN=<token fine-grained com "Administration: Read and write">
./scripts/proteger-branch-main.sh BrunoAmathias/TechChallengerFiap-Billing
```

## Deploy

Os manifests ficam em `k8s/` (Kustomize, namespace `billing`): Deployment com initContainer de migrations, Service, HPA, ConfigMap e Ingress no ALB compartilhado (`group.name: oficina`; paths `/orcamentos`, `/pagamentos` e `/webhooks/mercadopago`).

| Secret no cluster | Origem |
|---|---|
| `billing-secret` (`DB_URL`, `JWT_SECRET`, `APPROVAL_LINK_SECRET`, `PUBLIC_BASE_URL`, `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`, `SMTP_*`, `NEW_RELIC_LICENSE_KEY`) | gerado pelo CD a partir dos GitHub Secrets |
| `rabbitmq` (`RABBITMQ_URL`) e `service-auth` (`SERVICE_TOKEN`) | Terraform do repo `TechChallengerFiap-K8s` |
