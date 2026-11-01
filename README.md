# Distributed Wagering Processor

Serviço financeiro de apostas em Bun, NestJS, MikroORM, PostgreSQL 17 e Amazon SQS (LocalStack em ambiente local).

## Pré-requisitos

- Bun 1.3+
- Docker com Docker Compose

Nenhuma conta AWS, AWS CLI ou PostgreSQL instalado no sistema operacional é necessário.

## Configuração

```bash
bun install
cp .env.example .env
```

O `.env.example` contém apenas valores locais. `AWS_ACCESS_KEY_ID=test` e `AWS_SECRET_ACCESS_KEY=test` são credenciais fictícias aceitas pelo LocalStack. Sem `SQS_ENDPOINT`, o SDK usa a cadeia padrão de credenciais da AWS.

## Infraestrutura local

```bash
bun run infra:up          # PostgreSQL + LocalStack, aguarda os healthchecks
bun run infra:status      # estado dos containers
bun run migration:up      # aplica migrations no banco de desenvolvimento
bun run sqs:check         # conectividade e profundidade das filas
bun run sqs:init          # recria/atualiza filas e redrive de forma idempotente
```

O LocalStack cria automaticamente, ao subir, `wager-transactions.fifo`, `wager-events.fifo` e as DLQs correspondentes com `maxReceiveCount=5` (script em `docker/localstack/init/ready.d`).

## Execução

```bash
bun run start             # API HTTP
bun run worker            # consumidor SQS (pode rodar em várias instâncias)
bun run outbox:publisher  # publica a Outbox em wager-events.fifo (várias instâncias)
bun run outbox:backlog    # estado da Outbox (pendentes, retry, publicados, dead-letter)
```

Worker e publisher encerram de forma controlada com `SIGTERM` ou `SIGINT`.

## Testes

```bash
bun run typecheck
bun run lint
bun test test/unit
bun run test:db           # integração, E2E, mensageria, outbox e concorrência, em sequência
```

As suítes `test:integration`, `test:e2e`, `test:messaging`, `test:outbox` e `test:concurrency` recriam o mesmo banco de testes e **devem rodar em sequência**. `test:messaging`, `test:outbox` e `test:concurrency` exigem o LocalStack ativo; cada teste cria filas próprias e as remove ao final.
