# Distributed Wagering Processor

Serviço financeiro de apostas em Bun, NestJS, MikroORM, PostgreSQL 17 e Amazon SQS (LocalStack em ambiente local). Processa `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK` por HTTP e por fila, com idempotência persistente, ledger imutável, Inbox e Outbox transacionais, e permanece correto com várias instâncias de cada processo.

Decisões, garantias e limitações estão em [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Pré-requisitos

- Bun 1.3+
- Docker com Docker Compose

Não são necessários conta AWS, AWS CLI nem PostgreSQL instalado no sistema operacional.

## Instalação

```bash
bun install
cp .env.example .env
```

## Variáveis de ambiente

O `.env.example` contém só valores locais. `AWS_ACCESS_KEY_ID=test` e `AWS_SECRET_ACCESS_KEY=test` são credenciais fictícias aceitas pelo LocalStack. Sem `SQS_ENDPOINT`, o SDK usa a cadeia padrão de credenciais da AWS.

| Grupo | Variáveis principais | Observação |
|---|---|---|
| API | `PORT` (padrão 3000) | |
| PostgreSQL | `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_USER`, `DATABASE_PASSWORD`, `DATABASE_NAME`, `DATABASE_TEST_NAME`, `DATABASE_POOL_MIN/MAX` | `DATABASE_TEST_NAME` é o banco usado pelas suítes de teste |
| SQS | `SQS_ENDPOINT`, `AWS_REGION`, `SQS_WAGER_QUEUE_NAME`, `SQS_WAGER_DLQ_NAME`, `SQS_EVENTS_QUEUE_NAME`, `SQS_EVENTS_DLQ_NAME`, `SQS_MAX_RECEIVE_COUNT`, `SQS_VISIBILITY_TIMEOUT_SECONDS`, `SQS_RETRY_BASE_SECONDS`, `SQS_RETRY_MAX_SECONDS` | As URLs são resolvidas pelo nome quando `*_URL` está vazio |
| Outbox | `OUTBOX_LEASE_MS`, `OUTBOX_MAX_GROUPS`, `OUTBOX_MAX_PER_GROUP`, `OUTBOX_IDLE_POLL_MS` | `OUTBOX_PUBLISHER_ID` padrão: `hostname:pid` |
| Pendências | `PENDING_REFERENCE_MAX_ATTEMPTS`, `PENDING_REFERENCE_BASE_DELAY_MS`, `PENDING_REFERENCE_MAX_DELAY_MS`, `PENDING_WORKER_BATCH_SIZE` | `PENDING_WORKER_ID` padrão: `hostname:pid` |
| Métricas dos workers | `METRICS_PORT` | Vazio desativa; definir por processo (cada instância precisa de uma porta própria) |

Toda configuração é validada na partida; um valor inválido encerra o processo com a lista de problemas.

## Infraestrutura local

```bash
bun run infra:up          # PostgreSQL + LocalStack, aguarda os healthchecks
bun run infra:status      # estado dos containers
bun run sqs:check         # conectividade e profundidade das filas
bun run sqs:init          # cria as filas que faltam e reaplica atributos e redrive (idempotente)
```

As portas ficam presas a `127.0.0.1`: PostgreSQL em `55432` e LocalStack em `54566`. Se alguma estiver ocupada, altere `DATABASE_PORT` ou `LOCALSTACK_PORT` no `.env`. Ao trocar `LOCALSTACK_PORT`, ajuste também `SQS_ENDPOINT`. Os dados do PostgreSQL ficam no volume `jungle_gaming_pg_data` e sobrevivem a reinícios.

Ao subir, o LocalStack cria `wager-transactions.fifo`, `wager-events.fifo` e as DLQs correspondentes, com `maxReceiveCount=5` (`docker/localstack/init/ready.d`). O container do PostgreSQL cria também o banco de testes (`docker/postgres/init`).

## Migrations

```bash
bun run migration:up      # aplica no banco de desenvolvimento
bun run migration:status
bun run migration:down    # reverte a última migration
```

## Execução

Cada comando é um processo independente e pode rodar em várias instâncias ao mesmo tempo:

```bash
bun run start             # API HTTP em http://localhost:3000
bun run worker            # consumidor de wager-transactions.fifo
bun run outbox:publisher  # publica a Outbox em wager-events.fifo
bun run pending:worker    # resolve PENDING_REFERENCE
```

Exemplo com três instâncias de cada worker, cada uma com métricas próprias:

```bash
for i in 1 2 3; do METRICS_PORT=910$i bun run worker & done
for i in 1 2 3; do METRICS_PORT=920$i bun run outbox:publisher & done
for i in 1 2 3; do METRICS_PORT=930$i bun run pending:worker & done
```

Para várias APIs, use `PORT` distintos. Workers e publisher encerram de forma controlada com `SIGTERM` ou `SIGINT`.

Diagnóstico operacional:

```bash
bun run outbox:backlog    # pendentes, em retry, com lease, publicados, dead-letter
bun run pending:backlog   # pendências de referência por estado
```

## Exemplos HTTP

```bash
# Criar wallet (o saldo inicial vira uma transação OPENING com lançamento CREDIT)
curl -s -X POST localhost:3000/wallets \
  -H 'Content-Type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"100.00","currency":"BRL"}}'

# Submeter uma aposta (use o id retornado acima)
curl -s -X POST localhost:3000/wagering/transactions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:tx-1' \
  -H 'X-Correlation-Id: demo-1' \
  -d '{"providerId":"provider-a","externalTransactionId":"tx-1","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<walletId>","roundId":"round-1","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'

# Reenviar a mesma requisição devolve o resultado original com "idempotentReplay": true

curl -s localhost:3000/wallets/<walletId>
curl -s 'localhost:3000/wallets/<walletId>/ledger?limit=50'
curl -s localhost:3000/wagering/transactions/<transactionId>
curl -s localhost:3000/providers/provider-a/wagering/transactions/tx-1
curl -s -X POST localhost:3000/wallets/<walletId>/reconciliation

curl -s localhost:3000/health/live
curl -s localhost:3000/health/ready   # PostgreSQL e SQS
curl -s localhost:3000/metrics        # formato texto do Prometheus
```

Mensagem equivalente pela fila (o `MessageGroupId` deve ser o `walletId`):

```bash
docker exec jungle_gaming_localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id <walletId> --message-deduplication-id msg-1 \
  --message-body '{"messageId":"msg-1","type":"WagerTransactionRequested","occurredAt":"2026-11-01T12:00:00.000Z","data":{"providerId":"provider-a","externalTransactionId":"tx-2","idempotencyKey":"provider-a:tx-2","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<walletId>","roundId":"round-1","gameId":"fortune-chimp","kind":"BET","money":{"amount":"10.00","currency":"BRL"}}}'
```

## Testes

```bash
bun run typecheck
bun run lint
bunx prettier --check "src/**/*.ts" "test/**/*.ts"
bun test test/unit        # unidade, sem dependências externas
bun run test:db           # todas as suítes com PostgreSQL e LocalStack reais, em sequência
```

`test:db` executa, nesta ordem, `test:integration`, `test:e2e`, `test:messaging`, `test:outbox`, `test:pending`, `test:concurrency` e `test:system`. Essas suítes recriam o mesmo banco de testes e **devem rodar em sequência**, nunca em paralelo. As que usam SQS exigem o LocalStack ativo; cada teste cria filas próprias e as remove ao final. Nenhuma suíte toca o banco de desenvolvimento.

| Suíte | Conteúdo |
|---|---|
| `test/unit` | Money, Wallet, WagerTransaction, ledger, regras de reversão, idempotência, outbox, métricas |
| `test:integration` | migrations up/down, constraints do schema, repositórios, locks, health |
| `test:e2e` | API completa com PostgreSQL real, replay de pendências, logs e `/metrics` |
| `test:messaging` | consumer SQS: Inbox, redelivery, retry, DLQ, heartbeat, shutdown |
| `test:outbox` | publisher: claim, lease, ordem, retry, dead-letter, recuperação |
| `test:pending` | resolução de `PENDING_REFERENCE`, backoff, esgotamento |
| `test:concurrency` | processos Bun independentes (≥ 3) via HTTP, SQS, publishers e workers, com SIGKILL e SIGTERM |
| `test:system` | os quatro tipos de processo juntos (até 15 PIDs) e matriz de falhas antes do commit |

## Resumo das evidências

Todas as suítes passam contra PostgreSQL 17 e LocalStack 4.4 reais; as de concorrência e de sistema foram executadas várias vezes seguidas sem falhas. Principais resultados verificados pelos testes:

- **Mesma aposta 50 vezes em paralelo** (25 por HTTP e 25 por SQS, 3 APIs e 3 consumers): uma transação, um débito, saldo 75.00.
- **Duas apostas de 80.00 sobre 100.00**: uma `PROCESSED`, outra `REJECTED`/`INSUFFICIENT_FUNDS`, saldo 20.00, um débito, inclusive alternando a ordem e repetindo as requisições.
- **Processo morto depois do commit e antes do ack, ou antes da resposta HTTP**: a reentrega é `DUPLICATE_MESSAGE` e o retry HTTP devolve o resultado original; nenhum movimento duplicado.
- **Falha em cada escrita da transação** (claim, wallet, ledger, transação, outbox, inbox e o próprio `COMMIT`, injetada por triggers): rollback completo e retry aplicado uma vez.
- **SIGKILL de uma API, um consumer, um publisher e um worker no meio da carga**, com substitutos: todas as wallets terminam no saldo esperado, sem lease preso nem Inbox aberta.
- **Reversão antes da referência**: `PENDING_REFERENCE`, depois `PROCESSED` pelo worker; replays não alteram saldo.
- **Publishers concorrentes**: cada evento publicado, em ordem por wallet, com o mesmo `eventId` em reenvios.
- **Invariante final**: em todos os testes com banco, saldo materializado igual ao saldo reconstruído pelo ledger e reconciliação com diferença 0.00. Nenhum deadlock novo no PostgreSQL durante as execuções.
