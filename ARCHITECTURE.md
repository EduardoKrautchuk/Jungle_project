# Arquitetura

## Visão geral

Quatro tipos de processo independentes compartilham o mesmo PostgreSQL. Qualquer um pode rodar em várias instâncias:

| Processo | Entrada | Responsabilidade |
|---|---|---|
| API (`bun run start`) | HTTP | Wallets, submissão de transações, consultas, reconciliação, health e métricas |
| Consumer (`bun run worker`) | `wager-transactions.fifo` | Mesmo caso de uso da API, com Inbox |
| Publisher (`bun run outbox:publisher`) | tabela `outbox_messages` | Publica eventos confirmados em `wager-events.fifo` |
| Worker de pendências (`bun run pending:worker`) | transações `PENDING_REFERENCE` | Reavalia referências fora de ordem |

Camadas em `src/`:

- **`domain/`**: `Money`, `Wallet`, `WalletLedgerEntry`, `WagerTransaction`, `InboxMessage` e `OutboxMessage`. Construtores privados, factories `create`/`open`/`enqueue`/`receive` e `rehydrate`, que reconstrói o estado persistido sem revalidar transições. Sem dependência de NestJS ou ORM.
- **`application/`**: casos de uso (`SubmitWagerTransaction`, `WagerSettlement`, `ResolvePendingReference`, `CreateWallet`, `PublishOutboxBatch`), eventos de integração e portas (`UnitOfWork`, repositórios, `Clock`, `IdGenerator`, `EventTransport`). As portas permitem testar regras em memória com fakes determinísticos.
- **`infrastructure/`**: MikroORM, SQS, HTTP, configuração, observabilidade e os módulos NestJS.

A regra financeira fica em um único lugar, `WagerSettlement.settle`, usado pela API, pelo consumer e pelo worker de pendências.

## ORM e mapeamento de `Money`

**MikroORM 7** com `EntitySchema`, sem decorators nas classes de domínio. Os mappers (`persistence/mappers.ts`) convertem registros em agregados via `rehydrate` e vice-versa. A Unit of Work usa `em.fork().transactional()` por operação; o Identity Map é desligado nas leituras (`disableIdentityMap`) para que cada transação leia o estado do banco, não um cache do processo.

**`Money`** usa `decimal.js` (precisão 40, `ROUND_HALF_EVEN`) e é imutável:

- a entrada é sempre string decimal com no máximo 2 casas; `NaN`, `Infinity`, notação científica, string vazia, negativos e números JSON são rejeitados;
- a serialização (`toJSON`) é sempre `{ "amount": "25.00", "currency": "BRL" }`, com escala 2;
- operações entre moedas diferentes lançam erro de domínio;
- o modelo é multimoeda; o desafio usa só `BRL`, e conflitos de moeda são testados.

No banco, o valor fica em um domínio `money_amount` (`numeric` com `CHECK scale(VALUE) = 2` e limite de ±999.999.999.999.999.999,99) e a moeda em coluna separada (`currency_code`, `^[A-Z]{3}$`). O MikroORM mapeia `money_amount` como `string`, então o valor nunca passa por `number` em nenhum ponto do caminho.

## Schema e constraints

As garantias de unicidade, imutabilidade e não negatividade estão no schema, não só no código:

| Garantia | Constraint |
|---|---|
| Uma wallet por player e moeda | `wallets_player_currency_uq` |
| Saldo nunca negativo | `wallets_balance_non_negative_ck`; `balance_before` e `balance_after` ≥ 0 no ledger |
| `version` começa em 1 | `wallets_version_ck` |
| Idempotência persistente | `wager_tx_provider_idempotency_uq (provider_id, idempotency_key)` e `wager_tx_provider_external_uq (provider_id, external_transaction_id)` |
| No máximo um lançamento por transação e wallet | `ledger_wallet_transaction_uq` |
| Aritmética do lançamento | `ledger_arithmetic_ck`: `balance_before ± amount = balance_after` |
| Ledger imutável | triggers `wallet_ledger_entries_no_update_delete` e `_no_truncate` rejeitam `UPDATE`, `DELETE` e `TRUNCATE` |
| Reversão única por referência e tipo | índice único parcial `wager_tx_single_reversal_uq (reference_transaction_id, kind)` para `REFUND`/`ROLLBACK` `PROCESSED` |
| Referência no mesmo provider, player, wallet, moeda e rodada | FK composta `wager_tx_reference_scope_fk` |
| Transação pertence à wallet, ao player e à moeda | FK composta `wager_tx_wallet_fk` sobre a coluna gerada `wallet_link_id`, que só fica nula nas rejeições `WALLET_NOT_FOUND`, `WALLET_PLAYER_MISMATCH` e `CURRENCY_MISMATCH`, para que essas rejeições possam ser persistidas |
| Coerência de estado | `processed_at` existe se e só se `PROCESSED`; `failure_code` existe se e só se `REJECTED`/`FAILED`; `REFUND`/`ROLLBACK` exigem referência; `BET`/`LOSS`/`OPENING` a proíbem; valor > 0, exceto `LOSS` |
| Inbox única por consumer e mensagem | `inbox_messages_pk (consumer_name, message_id)` |
| Outbox ordenável e com lease coerente | `publish_sequence` identity única; checks de lease completo e de estado terminal exclusivo |

Migrations versionadas em `src/infrastructure/persistence/migrations`, todas com `down`. O teste de migrations aplica todas, reverte uma a uma em ordem inversa, reaplica, e reverte as mais recentes com dados presentes.

## Estratégia transacional e concorrência

**Unidade de concorrência: a wallet.** Toda operação que altera saldo, ledger ou o estado de uma transação passa por `UnitOfWork.runWithWalletLock(walletId)`:

1. abre uma transação (`READ COMMITTED`) com `SET LOCAL lock_timeout = 5000`;
2. `SELECT … FROM wallets WHERE id = ? FOR NO KEY UPDATE`;
3. executa o caso de uso inteiro dentro dessa transação;
4. confirma com um único `COMMIT`.

Escolhas:

- **Lock pessimista por linha**, não lock global e não optimistic locking. Sob disputa intensa em uma hot wallet, o optimistic geraria muitos retries; o lock de linha serializa só aquela wallet, e wallets diferentes seguem em paralelo.
- **`FOR NO KEY UPDATE` em vez de `FOR UPDATE`**: os INSERTs em tabelas com FK para `wallets` adquirem `KEY SHARE`, que conflita com `FOR UPDATE` e produzia deadlocks entre processos. `FOR NO KEY UPDATE` é compatível com `KEY SHARE`, ainda exclui outro `FOR NO KEY UPDATE`, e eliminou os deadlocks.
- **`version`** é incrementada só quando o saldo muda, e o `UPDATE` da wallet confere a versão esperada como defesa adicional (`WHERE version = ?`).
- **`lock_timeout`**: uma espera maior que 5 s vira `ConcurrencyConflictError`, que é transitório (503 na API, retry no SQS e no worker), nunca erro de negócio.

**Ordem dos locks**, igual para todas as entradas:

```
API / SQS:  wallet (FOR NO KEY UPDATE) → inbox INSERT (só SQS) → wager_tx INSERT (claim)
            → wallet UPDATE → ledger INSERT → wager_tx UPDATE → outbox INSERT → inbox processed_at → COMMIT
Worker:     SELECT de candidatos (sem lock, fora de transação)
            → [nova transação] wallet (FOR NO KEY UPDATE) → releitura → mesmos passos do settlement → COMMIT
Publisher:  só outbox_messages, em statements curtos, sem transação aberta durante a rede
```

Toda linha de `wager_transactions`, `wallet_ledger_entries` e `wallets` só é alterada por quem detém o lock da wallet, e a referência pertence à mesma wallet por constraint, então não há ciclo de espera. Nenhum processo segura um lock de pendência, Inbox ou Outbox enquanto espera a wallet. Um processo que morre libera o lock quando a conexão cai.

**Atomicidade.** Inbox, transação, saldo, ledger e outbox participam da mesma transação SQL. Uma falha em qualquer ponto antes do `COMMIT` desfaz tudo, e isso é verificado com falhas reais injetadas em cada escrita (`test/system/commit-failures.spec.ts`).

**Cenário obrigatório (100.00, duas apostas de 80.00 simultâneas).** A segunda transação espera o lock, relê o saldo já debitado (20.00) e é rejeitada com `INSUFFICIENT_FUNDS`. Resultado: uma `PROCESSED`, uma `REJECTED`, saldo 20.00, um único débito.

## Estados das transações

```
PENDING ──► PROCESSED          (aplicada)
   │    ──► REJECTED           (regra de negócio)
   │    ──► FAILED             (reservado)
   └──► PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED
```

- Toda transação nasce `PENDING` dentro da transação SQL e sai dela já no estado final ou em `PENDING_REFERENCE`; `PENDING` nunca é visível depois do commit.
- `PROCESSED`, `REJECTED` e `FAILED` são terminais. Tentar transicionar um estado terminal lança `InvalidTransactionStateError` (erro de programação). As transições válidas estão em `WAGER_TRANSACTION_TRANSITIONS`.
- `PENDING_REFERENCE` é atualizada no lugar (mesmo `id`, `idempotencyKey` e `payloadHash`).
- `FAILED` existe no modelo e no schema, mas nenhum fluxo atual o produz: erros permanentes de infraestrutura no SQS vão para a DLQ, e na API viram 500 sem persistir a transação.
- `OPENING` é interno: criado por `POST /wallets` quando o saldo inicial é maior que zero, na mesma transação da wallet. A API e a fila rejeitam `kind = OPENING`.

### Regras por operação

| Operação | Saldo | Ledger | Referência aceita |
|---|---|---|---|
| `BET` | débito | 1 `DEBIT` | proibida |
| `WIN` | crédito | 1 `CREDIT` | opcional, só `BET` |
| `LOSS` | nenhum | nenhum | proibida |
| `REFUND` | crédito | 1 `CREDIT` | obrigatória, só `BET` |
| `ROLLBACK` | inverso da referência | 1 lançamento invertido | obrigatória: `BET`, `WIN` ou `REFUND` |

A referência é buscada por `(providerId, referenceExternalTransactionId)` e precisa ter o mesmo provider, player, wallet, moeda e rodada. Reversões exigem valor igual ao da referência e uma referência `PROCESSED`, e cada referência pode ser revertida no máximo uma vez por tipo.

Interpretações adotadas:

- uma referência que existe mas ainda está `PENDING_REFERENCE` é tratada como ausente (a reversão espera);
- `REFUND` e `ROLLBACK` concorrentes sobre a mesma referência: o primeiro aplica, o segundo é `ALREADY_REVERSED`;
- um crédito que ultrapassaria o limite representável é rejeitado com `BALANCE_LIMIT_EXCEEDED`.

## Taxonomia de `failureCode`

Toda rejeição persiste um código estável, devolvido na API e no evento `WagerTransactionRejected`:

| Código | Situação | O provedor deve |
|---|---|---|
| `INSUFFICIENT_FUNDS` | `BET` sem saldo | desistir ou reenviar com outro valor (nova operação) |
| `REVERSAL_WOULD_OVERDRAW` | `ROLLBACK` de `WIN`/`REFUND` deixaria saldo negativo | tratar manualmente; é distinto de aposta sem saldo, como pede o enunciado |
| `BALANCE_LIMIT_EXCEEDED` | crédito ultrapassaria o limite do saldo | tratar manualmente |
| `REFERENCE_NOT_FOUND` | referência não apareceu até esgotar as tentativas | reenviar com novo `externalTransactionId`, se a referência existir |
| `REFERENCE_NOT_PROCESSED` | referência existe mas foi rejeitada, ou nunca ficou terminal | desistir |
| `REFERENCE_MISMATCH` | referência de outro provider, player, wallet, moeda ou rodada | corrigir o payload |
| `INVALID_REFERENCE_KIND` | tipo de referência não permitido | corrigir o payload |
| `REVERSAL_AMOUNT_MISMATCH` | valor da reversão diferente da referência | corrigir o payload |
| `ALREADY_REVERSED` | referência já revertida por esse tipo | desistir (efeito já aplicado) |
| `CURRENCY_MISMATCH` | moeda diferente da wallet | corrigir o payload |
| `WALLET_NOT_FOUND` | wallet inexistente | corrigir o payload |
| `WALLET_PLAYER_MISMATCH` | wallet de outro player | corrigir o payload |
| `PROCESSING_FAILED` | reservado para `FAILED` | — |

Uma transação `REJECTED` não altera saldo nem gera lançamento, mas fica persistida e auditável, com evento publicado.

## Idempotência e `payloadHash`

- O header `Idempotency-Key` é obrigatório e é a fonte da verdade; o default recomendado é `"{providerId}:{externalTransactionId}"`. Na fila, a chave vem em `data.idempotencyKey`.
- **`payloadHash`** = SHA-256 (hex) do JSON canônico dos campos de negócio `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money.amount`, `money.currency` e `referenceExternalTransactionId`. No JSON canônico as chaves ficam ordenadas por code point, sem espaços, e campos ausentes são omitidos. O header, a correlação e os metadados de transporte não entram no hash.
- **Claim**: o INSERT da transação usa as constraints únicas `(provider_id, idempotency_key)` e `(provider_id, external_transaction_id)`. Se a linha já existe:
  - mesma chave e mesmo hash: **replay**, que devolve o resultado persistido (`status`, `failureCode`, saldo observado na aplicação) com `idempotentReplay: true`;
  - mesma chave com outro hash, ou mesmo `externalTransactionId` com outra chave: **conflito** (`IDEMPOTENCY_CONFLICT`), nunca replay.
- Antes do lock, uma leitura sem lock atende replays conhecidos sem disputar a wallet. O claim dentro do lock garante a unicidade entre processos.
- **Replay de pendências**: enquanto `PENDING_REFERENCE`, o replay devolve 202 com o mesmo corpo. Depois da resolução, devolve o estado final (200 ou 422), estável a partir daí. O 202 significa "aceito, processamento pendente", não um resultado; congelá-lo esconderia o desfecho do provedor.
- **Depois do esgotamento** a transação é terminal: mesma chave dá replay 422; mesmo `externalTransactionId` com outra chave dá 409; uma operação nova exige novo `externalTransactionId`.

Nenhuma garantia de idempotência depende de memória do processo ou da deduplicação do SQS.

## Mapa de status HTTP

| Situação | Status | Corpo |
|---|---|---|
| Transação `PROCESSED` (inclusive replay) | 200 | `{ transactionId, status, balance, idempotentReplay }` |
| Wallet criada | 201 | wallet |
| Aceita com processamento pendente (`PENDING_REFERENCE`) | 202 | transação |
| Payload ou query inválidos, ou `Idempotency-Key` ausente | 400 | `VALIDATION_FAILED` com `details`, ou `MALFORMED_REQUEST` |
| Wallet ou transação inexistente na consulta | 404 | `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND` |
| Conflito de idempotência | 409 | `IDEMPOTENCY_CONFLICT` |
| Wallet duplicada para player e moeda | 409 | `WALLET_ALREADY_EXISTS` |
| Rejeição por regra de negócio | 422 | transação com `status: REJECTED` e `failureCode` |
| Wallet ocupada (`lock_timeout`) | 503 + `Retry-After: 1` | `CONCURRENCY_CONFLICT` |
| PostgreSQL indisponível | 503 + `Retry-After: 5` | `SERVICE_UNAVAILABLE` |
| Erro inesperado | 500 | `INTERNAL_ERROR` |

Os 503 são seguros para reenviar com a mesma chave. Na submissão, os 4xx não mudam com reenvio. Uma submissão para wallet inexistente é uma rejeição de negócio persistida (422 `WALLET_NOT_FOUND`), não um 404. O mesmo mapeamento vale para todos os endpoints.

## Mensageria SQS

### Filas

| Fila | Configuração |
|---|---|
| `wager-transactions.fifo` | `ContentBasedDeduplication=false`, `VisibilityTimeout=30`, long polling de 20 s, redrive para a DLQ com `maxReceiveCount=5` |
| `wager-transactions-dlq.fifo` | retenção de 14 dias |
| `wager-events.fifo` / `wager-events-dlq.fifo` | eventos de integração, separados dos comandos |

O produtor deve usar `MessageGroupId = walletId` (ordem por wallet) e um `MessageDeduplicationId`. A ordenação e a deduplicação FIFO são otimizações: a correção vem da Inbox e da idempotência no PostgreSQL, como demonstram os testes que espalham a mesma operação em grupos e deduplication ids distintos.

### Contrato

O envelope segue o enunciado (`messageId`, `type = WagerTransactionRequested`, `occurredAt`, `data`, e `correlationId` opcional, que vale o `messageId` quando ausente). A validação é estrita: rejeita campo desconhecido, valor monetário que não seja string e timestamp inválido. Três identificadores não se substituem: `messageId` lógico (chave da Inbox), `MessageId` do SQS (só diagnóstico) e `data.idempotencyKey` (idempotência financeira). O hash da Inbox é SHA-256 do JSON canônico de `type` e `data`.

### Consumer

- Reutiliza `SubmitWagerTransaction`, o mesmo caso de uso da API.
- **Inbox** por `(consumerName, messageId)`, gravada na mesma transação da operação financeira. Mesmo `messageId` já processado: `DUPLICATE_MESSAGE`. Mesmo `messageId` com outro hash: `MESSAGE_PAYLOAD_MISMATCH`. Novo `messageId` para operação já conhecida: `REPLAYED`, sem novo efeito.
- **Ack somente depois do commit.**
- Mensagens do mesmo grupo são processadas em sequência; grupos diferentes, em paralelo.
- **Heartbeat**: a visibilidade é renovada a cada metade do `VisibilityTimeout`, sempre com o timeout fixo. Se o worker morre, a mensagem reaparece no máximo um timeout depois da última renovação.
- **SIGTERM**: cancela o long polling, conclui as mensagens em andamento e devolve as não iniciadas com visibilidade 0, dentro de `SQS_SHUTDOWN_GRACE_MS`.
- **Compatibilidade com LocalStack 4.4**: em filas FIFO, o `DeleteMessage` do LocalStack considera o receipt handle expirado quando o tempo desde o recebimento passa do último `VisibilityTimeout`, mesmo com renovações. Quando o delete falha exatamente com esse erro, o adapter faz um único `ChangeMessageVisibility` e repete o delete. Isso ocorre só depois do commit e não é acionado na AWS real.

### Classificação de erros

| Situação | Ação |
|---|---|
| `PROCESSED`, `REJECTED`, `PENDING_REFERENCE`, replay, duplicata | `DeleteMessage` |
| `MALFORMED_MESSAGE`, `VALIDATION_FAILED`, `IDEMPOTENCY_CONFLICT`, `MESSAGE_PAYLOAD_MISMATCH` (permanentes) | envio imediato para a DLQ com diagnóstico, depois `DeleteMessage` |
| `PERSISTENCE_CONCURRENCY_CONFLICT`, `PERSISTENCE_UNAVAILABLE`, `UNEXPECTED_ERROR` (transitórios) | `ChangeMessageVisibility` com backoff `base × 2^(tentativa−1)`, limitado a `SQS_RETRY_MAX_SECONDS` |
| Transitório na tentativa `maxReceiveCount` | DLQ com diagnóstico |
| Falha no `ReceiveMessage` | backoff de 1 s a 30 s, sem busy polling |

A DLQ recebe o corpo original e os atributos `errorCode`, `consumerName`, `sourceMessageId`, `sourceReceiveCount` e `logicalMessageId`. O redrive do broker continua como rede de segurança para workers que morrem antes de decidir. Uma falha no `DeleteMessage` depois do commit só causa uma reentrega, que vira `DUPLICATE_MESSAGE`.

## Transactional Outbox

O evento é gravado em `outbox_messages` na mesma transação da operação financeira, então nunca é publicado antes do commit. O publisher é um processo separado.

**Eventos**: `WagerTransactionProcessed` (inclusive `LOSS`), `WagerTransactionRejected`, `WalletBalanceChanged` (somente quando o saldo muda) e `WagerTransactionPendingReference`. Cada um é uma subclasse de `IntegrationEvent` com `eventType` e `version` no tipo. O envelope persistido (`eventId`, `eventType`, `aggregateId`, `correlationId`, `causationId`, `occurredAt`, `version`, `data`) é exatamente o corpo publicado; `data` carrega `MoneyProps`, nunca `Money`.

**Claim com lease.** O publisher não segura transação durante a chamada de rede:

1. um único statement escolhe a mensagem mais antiga não publicada de cada `group_key` (o `walletId`), vencida e sem lease ativo, com `FOR UPDATE SKIP LOCKED`;
2. grava `lease_owner`, um `lease_token` aleatório e `lease_expires_at` pelo relógio do PostgreSQL;
3. envia com `SendMessage` (`MessageGroupId = group_key`, `MessageDeduplicationId = eventId`): grupos em paralelo, eventos de um grupo em sequência;
4. confirma, reagenda ou faz dead-letter só com `WHERE lease_token = ?` (fencing), então um publisher que perdeu o lease não consegue confirmar.

O lease foi escolhido em vez de manter a transação aberta durante o envio para que uma rede lenta não segure locks nem conexões; o custo é a coluna de lease e o fencing. O lease padrão é de 60 s (`OUTBOX_LEASE_MS`), e a configuração exige que seja maior que duas vezes o timeout de envio (`SQS_REQUEST_TIMEOUT_MS`), para que um envio em andamento não perca o lease. Esse valor também limita quanto tempo os eventos de um publisher morto esperam até outro assumir.

**Ordem**: dentro de uma wallet, os eventos são publicados na ordem de `publish_sequence` (identity gerada no INSERT, que segue a ordem de commit porque o lock da wallet serializa as transações). Só a cabeça de cada grupo é elegível. Wallets diferentes seguem em paralelo.

**Falhas**:

| Situação | Tratamento |
|---|---|
| Falha transitória de rede, timeout, throttling ou 5xx | `attempts+1`, backoff de 1 s, 2 s, 4 s… até 300 s com até 20% de jitter; bloqueia só a sua wallet |
| Erro de configuração (fila inexistente, credencial) | retry com o mesmo backoff, sem descartar o evento |
| Evento rejeitado pelo SQS ou envelope inválido | `dead_lettered_at` e `last_error` na tabela; a wallet segue para o evento seguinte |
| Processo morto antes do envio | o lease expira (até 60 s por padrão) e outro publisher envia |
| Processo morto ou PostgreSQL indisponível depois do envio | reenvio com o mesmo `eventId`; a deduplicação FIFO elimina a cópia em 5 minutos, e depois disso o consumidor deduplica pelo `eventId` |

A entrega é **at-least-once**: nenhum evento confirmado é perdido, e duplicatas sempre carregam o mesmo `eventId`.

## Recuperação de referências fora de ordem

Um `REFUND`, `ROLLBACK` ou `WIN` com referência que chega antes dela é gravado como `PENDING_REFERENCE` com `next_reference_attempt_at = agora + 1 s` e o evento `WagerTransactionPendingReference`. A mensagem SQS de entrada é confirmada nesse momento.

O worker (`bun run pending:worker`):

1. seleciona candidatos vencidos com um `SELECT` comum, sem lock e fora de transação; cada instância ordena por `md5(id || workerId)` para espalhar o trabalho;
2. para cada candidato, entra em `runWithWalletLock(walletId)`, o mesmo caminho da API;
3. relê a transação e só continua se ainda estiver `PENDING_REFERENCE`, com o mesmo número de tentativas e vencida (fencing contra outro worker);
4. chama `WagerSettlement.settle`, que resolve, valida e aplica a referência;
5. se a referência continua ausente, faz `reference_attempts+1` e reagenda com `min(base × 2^tentativas, máximo)`;
6. ao atingir `PENDING_REFERENCE_MAX_ATTEMPTS`, rejeita com `REFERENCE_NOT_FOUND` (ou `REFERENCE_NOT_PROCESSED`) e grava `WagerTransactionRejected` no mesmo commit.

**Padrão**: base de 1 s, máximo de 300 s e 12 tentativas, uma janela de cerca de 23 minutos. É suficiente para atrasos normais de provedor sem deixar pendências eternas. Erros operacionais (lock timeout, PostgreSQL indisponível) fazem rollback e não consomem tentativa. Os eventos herdam o `correlationId` do evento original da transação. Não há lease nem claim de pendência, então nada precisa ser recuperado quando um worker morre.

## Observabilidade

### Logs

Todos os processos escrevem JSON por linha no stdout (`JsonLinesLog`), com `timestamp`, `level`, `component` e `event`.

| Componente | Eventos principais | Campos |
|---|---|---|
| `http-api` | `http.request` (uma linha por requisição), `wallet.reconciliation`, `http.unexpected_error` | `operation`, `method`, `statusCode`, `correlationId`, `transactionId`, `walletId`, `providerId`, `kind`, `result`, `errorCode`, `idempotentReplay`, `durationMs` |
| `wager-consumer` | `message.processed`, `message.retry_scheduled`, `message.dead_lettered` | `messageId`, `sqsMessageId`, `correlationId`, `transactionId`, `walletId`, `providerId`, `receiveCount`, `result`, `errorCode`, `durationMs` |
| `outbox-publisher` | `outbox.published`, `outbox.retry_scheduled`, `outbox.dead_lettered`, `outbox.lease_recovered` | `eventId`, `eventType`, `aggregateId`, `correlationId`, `attempt`, `result`, `errorCode`, `durationMs` |
| `pending-reference-worker` | `pending.resolution`, `pending.resolution_failed` | `transactionId`, `walletId`, `providerId`, `attempt`, `result`, `failureCode`, `durationMs` |

Os logs não incluem valores monetários, saldos, `playerId`, `Idempotency-Key` nem payloads completos. A API devolve e registra o `X-Correlation-Id` (recebido ou gerado).

### Métricas

As métricas são derivadas dos mesmos eventos de log, em um único ponto (`MeteredLog`), para que cada ocorrência seja contada exatamente uma vez. O formato é o texto do Prometheus, sem servidor Prometheus nem dependências novas.

**Contadores e histogramas locais ao processo**, expostos em `GET /metrics` da API e, nos workers, em `http://127.0.0.1:$METRICS_PORT/metrics` quando `METRICS_PORT` está definido:

| Métrica | Labels | Cobre |
|---|---|---|
| `wagering_operations_total` | `source` (`http`, `sqs`, `pending_worker`, `outbox_publisher`), `result` | transações por status/resultado |
| `wagering_duplicates_total` | `source`, `kind` (`idempotent_replay`, `inbox_duplicate`) | duplicatas detectadas |
| `wagering_retries_total` | `component`, `reason` | retries de SQS, publisher e pendências |
| `wagering_dead_letters_total` | `component`, `reason` | mensagens na DLQ e eventos em dead-letter |
| `wagering_lock_conflicts_total` | `source` | conflitos de lock (`lock_timeout`) |
| `wagering_operation_duration_seconds` | `source` | latência de processamento (histograma) |
| `wagering_reconciliations_total` | `result` (`consistent`, `divergent`) | divergências de reconciliação |

Esses valores vivem em memória, são **de cada processo** e **zeram quando o processo reinicia**. Não representam o sistema inteiro: uma visão global exige coletar todas as instâncias e somar no coletor (por exemplo `sum by (...)` no Prometheus).

**Gauges globais**, calculados a cada `GET /metrics` da API a partir das fontes de verdade, e portanto iguais em qualquer instância:

| Métrica | Fonte |
|---|---|
| `wagering_transactions{status}` | `count(*)` por status em `wager_transactions` |
| `wagering_outbox_pending_events`, `wagering_outbox_lag_seconds`, `wagering_outbox_dead_lettered_events` | `outbox_messages` (o lag é a idade do evento pendente mais antigo) |
| `wagering_sqs_queue_messages{queue}` | `ApproximateNumberOfMessages` das quatro filas, incluindo as DLQs |
| `wagering_metrics_source_up{source}` | 1 quando a fonte respondeu dentro do timeout de 2 s |

### Reconciliação

`POST /wallets/:id/reconciliation` compara o saldo materializado com a soma do ledger. Uma divergência não é corrigida: é devolvida na resposta (`consistent: false`, `difference`), registrada em log `warn` e contada em `wagering_reconciliations_total{result="divergent"}`.

### Health checks

- `GET /health/live`: processo vivo, sem tocar dependências.
- `GET /health/ready`: `SELECT 1` no PostgreSQL e `GetQueueAttributes` na fila de comandos, em paralelo, cada um com timeout de 2 s. Responde 200 com `{ postgres: "up", sqs: "up" }`, ou 503 indicando qual dependência está fora. O healthcheck nunca cria filas.
- Health e métricas não exigem autenticação.

Comandos de diagnóstico: `bun run outbox:backlog` e `bun run pending:backlog`.

## Autenticação

**Decisão de escopo: não implementada.** O enunciado deixa a escolha com o candidato, diz que autenticação não vale pontos e aceita não implementar se a decisão ficar documentada e o ponto de extensão explícito. O tempo foi para correção financeira, concorrência e idempotência.

**Ponto de extensão**: `ProviderAuthGuard` (`src/infrastructure/http/auth/provider-auth.guard.ts`), hoje no-op, já aplicado em `WalletsController` e `WageringController`. Health e métricas ficam sem guard.

**Desenho que seria adotado**:

1. Keycloak no Docker Compose como Identity Provider, sem tabela própria de usuários;
2. cada provedor de jogos como client OAuth2 `client_credentials`;
3. o guard valida o JWT (assinatura via JWKS, `iss`, `aud`, expiração);
4. a identidade do provedor é exposta por uma porta de aplicação (`ProviderIdentityPort`);
5. o caso de uso compara `providerId` do payload com o provedor autenticado e responde 403 se diferirem;
6. mensagens da fila são canal interno confiável, mas o `providerId` delas continua sujeito às validações de domínio.

**Consequência**: hoje qualquer cliente que alcance a API pode agir em nome de qualquer `providerId`. O serviço não deve ser exposto fora de rede confiável sem o guard.

## Limitações conhecidas

- **Métricas locais por processo**: contadores e histogramas zeram ao reiniciar e precisam ser agregados externamente. O endpoint dos workers escuta só em `127.0.0.1`. Os gauges globais fazem `count(*)` por status a cada coleta, o que fica caro com tabelas muito grandes.
- **Outbox at-least-once**: reenvios fora da janela de 5 minutos da deduplicação FIFO chegam duplicados ao consumidor, sempre com o mesmo `eventId`.
- **Retry sem limite no publisher**: uma falha transitória permanente é retentada a cada 300 s indefinidamente e bloqueia só a wallet afetada. Um evento em dead-letter deixa uma lacuna na sequência daquela wallet.
- **Ordem FIFO por wallet**: depende de o produtor usar `MessageGroupId = walletId`; a correção financeira não depende disso.
- **Pendência esgotada é terminal**: reenviar exige novo `externalTransactionId`.
- **Hot wallet**: sob disputa intensa, a API pode devolver 503 retentável por `lock_timeout`; o cliente precisa reenviar.
- **`FAILED` não é produzido** por nenhum fluxo atual.
- **LocalStack 4.4 fixado**: imagens mais recentes exigem token. A edição community não persiste filas; o script de init as recria a cada start.
- **Sem replay administrativo da DLQ** nem teste de carga (`test:load`).
- **Sem autenticação** (ver seção acima).
- **Orquestração**: o Docker Compose sobe PostgreSQL e LocalStack; a API e os workers rodam com Bun no host.

## Estratégia de testes

| Nível | Infraestrutura | Foco |
|---|---|---|
| Unidade | fakes em memória das portas | regras de domínio, Money, transições, idempotência, publicação, métricas |
| Integração e E2E | PostgreSQL real | constraints, migrations, locks, API completa, logs e métricas |
| Mensageria, Outbox, pendências | PostgreSQL e LocalStack reais | Inbox, retry, DLQ, heartbeat, lease, ordem, backoff |
| Concorrência e sistema | processos Bun independentes | ≥ 3 instâncias, SIGKILL e SIGTERM, falhas antes e depois do commit |

Nenhum teste fora da unidade substitui PostgreSQL ou SQS por mocks. Os testes multiprocesso e de sistema verificam, ao final de cada cenário:

- saldo igual ao ledger e cadeia de lançamentos contínua;
- `version` igual ao número de lançamentos;
- nenhum lançamento duplicado e no máximo uma reversão por referência;
- um evento terminal por transação;
- reconciliação consistente;
- nenhum deadlock novo em `pg_stat_database`.

As falhas antes do commit são injetadas por triggers no banco de testes, inclusive um `CONSTRAINT TRIGGER DEFERRABLE` que falha no próprio `COMMIT`. As falhas depois do commit usam SIGKILL entre o commit e a resposta HTTP, entre o commit e o `DeleteMessage`, e entre o `SendMessage` e a confirmação da outbox. As indisponibilidades de rede usam proxies TCP.
