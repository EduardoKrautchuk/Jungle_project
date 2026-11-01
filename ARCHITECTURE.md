# Arquitetura

## Autenticação

### Decisão

Autenticação não foi implementada. A seção 2 do `docs/CHALLENGE.md` deixa a escolha com o candidato, diz que autenticação não vale pontos e aceita não implementar desde que a decisão fique documentada e o ponto de extensão fique explícito no código. O tempo foi para correção financeira, concorrência e idempotência.

### Ponto de extensão

`src/infrastructure/http/auth/provider-auth.guard.ts` define o `ProviderAuthGuard`. Hoje ele é no-op: `canActivate` sempre retorna `true`.

O guard já está aplicado em `WalletsController` e `WageringController`. Os endpoints de health ficam sem guard, como pede o enunciado.

### Desenho que seria adotado

1. **Identity Provider externo** (Keycloak no Docker Compose), sem tabela própria de usuários.
2. **Credenciais por provedor**: cada provedor de jogos vira um client OAuth2 `client_credentials`.
3. **Validação do JWT no guard**: o `ProviderAuthGuard` valida assinatura via JWKS, `iss`, `aud` e expiração.
4. **Identidade como porta**: o guard publica a identidade do provedor autenticado por uma porta de aplicação, por exemplo um `ProviderIdentityPort`.
5. **Autorização na aplicação**: o caso de uso compara `providerId` do payload com o provedor autenticado e responde `403` se forem diferentes. As consultas por provedor seguem a mesma regra.
6. **Mensagens da fila**: são canal interno confiável. Mesmo assim, o `providerId` contido nelas continua sujeito às validações de domínio.

### Consequência

Sem autenticação, hoje qualquer cliente que alcance a API pode enviar transações em nome de qualquer `providerId`. O serviço não deve ser exposto fora de rede confiável até o guard ser implementado.

## Mensageria SQS

### Filas

| Fila | Tipo | Configuração |
|---|---|---|
| `wager-transactions.fifo` | FIFO | `ContentBasedDeduplication=false`, `VisibilityTimeout=30`, long polling de 20s, retenção de 4 dias, redrive para a DLQ com `maxReceiveCount=5` |
| `wager-transactions-dlq.fifo` | FIFO | retenção de 14 dias |

- **`MessageGroupId`**: o produtor deve usar o `walletId`, o que preserva a ordem por wallet.
- **`MessageDeduplicationId`**: é obrigatório e evita reenvios dentro da janela de 5 minutos do broker.
- **FIFO como otimização**: a deduplicação do FIFO é só uma otimização; a correção não depende dela (restrição 3 do enunciado). Inbox e idempotência persistente continuam sendo a garantia.

### Contrato da mensagem

O envelope segue a seção 10 do enunciado: `messageId`, `type` (`WagerTransactionRequested`), `occurredAt` e `data`. O campo `correlationId` é opcional e, quando ausente, vale o `messageId`.

- A validação é estrita: rejeita campo desconhecido, valor monetário que não seja string e timestamp inválido.
- Três identificadores são distintos e não se substituem:

  | Identificador | Uso |
  |---|---|
  | `messageId` lógico | chave da Inbox |
  | `MessageId` do SQS | apenas diagnóstico (`sourceMessageId` na DLQ) |
  | `data.idempotencyKey` | idempotência financeira |

- O hash da Inbox é SHA-256 do JSON canônico de `type` e `data`. Transporte, `occurredAt` e `correlationId` ficam fora do hash.

### Consumidor

`src/worker.ts` sobe um `WorkerModule` (persistência, casos de uso e mensageria) sem HTTP. O processamento segue estas regras:

- As mensagens de um lote são processadas em sequência dentro do mesmo `MessageGroupId`, e grupos diferentes rodam em paralelo.
- **Heartbeat de visibilidade**: enquanto uma mensagem é processada, a visibilidade é renovada a cada metade do `VisibilityTimeout`, sempre com o próprio `VisibilityTimeout` como valor fixo, que é a semântica do SQS. Se o worker morrer, a mensagem volta a ficar visível no máximo um timeout depois da última renovação.
- **Compatibilidade com LocalStack 4.4**: em filas FIFO, o `DeleteMessage` do LocalStack (`FifoQueue._pre_delete_checks`) considera o receipt handle expirado quando `agora − recebimento > último VisibilityTimeout`. A visibilidade em si segue a AWS (`agora + timeout`). Quando o delete falha exatamente com `InvalidParameterValue` e a mensagem "receipt handle has expired", o adapter faz um único `ChangeMessageVisibility` com valor igual ao tempo decorrido mais o timeout e repete o delete. Isso só acontece depois do commit, então a janela de atraso extra se limita ao intervalo entre essa chamada e o delete. Na AWS real esse caminho não é acionado.
- **Shutdown**: o long polling em andamento é cancelado, as mensagens em processamento são concluídas, e as que ainda não começaram voltam com visibilidade 0, tudo dentro de `SQS_SHUTDOWN_GRACE_MS`.

### Atomicidade Inbox + operação financeira

`SubmitWagerTransaction.executeMessage` usa o mesmo fluxo da API HTTP, mantendo a ordem de locks da Etapa 5B.1. Os passos são:

1. **Consulta prévia, sem lock**:
   - Se a Inbox já registra o mesmo `messageId` como processado, o resultado é `DUPLICATE_MESSAGE`.
   - Se registra o mesmo `messageId` com hash diferente, o resultado é `MESSAGE_PAYLOAD_MISMATCH`.
   - Se a operação financeira já existe (replay), a Inbox é registrada nessa mesma transação.
2. **Transação principal**, nesta ordem:
   1. `runWithWalletLock` trava a wallet com `FOR NO KEY UPDATE`.
   2. A Inbox é inserida com `ON CONFLICT DO NOTHING`. Se a linha já existir, o resultado é duplicata ou payload divergente.
   3. Claim.
   4. Settlement.
   5. Wallet.
   6. Ledger.
   7. Transação.
   8. Outbox.
   9. `processed_at` é gravado na Inbox.
   10. Commit único.

Uma linha da Inbox recebida mas ainda não processada é retomada na próxima entrega. Duas instâncias com a mesma mensagem lógica ficam serializadas pelo lock da wallet, ou pela chave primária da Inbox quando a wallet não existe.

### Confirmação e retry

| Situação | Ação |
|---|---|
| `PROCESSED`, `REJECTED` (regra de negócio), `PENDING_REFERENCE`, replay financeiro, duplicata na Inbox | `DeleteMessage` após o commit |
| Mensagem malformada (`MALFORMED_MESSAGE`), payload inválido (`VALIDATION_FAILED`), `IDEMPOTENCY_CONFLICT`, `MESSAGE_PAYLOAD_MISMATCH` | envio imediato para a DLQ com diagnóstico, seguido de `DeleteMessage` |
| `PERSISTENCE_CONCURRENCY_CONFLICT`, `PERSISTENCE_UNAVAILABLE`, `UNEXPECTED_ERROR` | `ChangeMessageVisibility` com backoff de `base × 2^(tentativa−1)`, limitado a `SQS_RETRY_MAX_SECONDS` |
| Erro retentável quando a tentativa atinge `maxReceiveCount` | DLQ manual com diagnóstico |
| Falha no `ReceiveMessage` | backoff exponencial de 1s até 30s, sem busy polling |

- **Diagnóstico na DLQ**: os atributos são `errorCode`, `consumerName`, `sourceMessageId`, `sourceReceiveCount` e `logicalMessageId`. O corpo original é preservado.
- **Redrive automático**: o redrive do broker continua como rede de segurança para workers que morrem antes de decidir.
- **Falha no `DeleteMessage` após o commit**: a mensagem reaparece e vira uma duplicata sem efeito.

### Observabilidade mínima

Logs JSON por linha, sem payload financeiro, com estes campos: `consumerName`, `sqsMessageId`, `messageId`, `correlationId`, `kind`, `providerId`, `walletId`, `receiveCount`, `result`, `errorCode`, `durationMs` e `transactionId`.

### Limitações conhecidas

- **LocalStack**: a versão 4.4 foi fixada porque as imagens mais recentes exigem token. A edição community não persiste filas; elas são recriadas pelo script de init a cada start.

## Publisher da Outbox

### Fluxo

1. A operação financeira grava wallet, ledger, transação e evento em `outbox_messages` num único commit.
2. Um processo separado (`bun run outbox:publisher`) reivindica eventos já confirmados e os envia para `wager-events.fifo`.
3. Depois do envio, o publisher registra `published_at` e o `transport_message_id` no PostgreSQL.

Não existe commit distribuído entre PostgreSQL e SQS. A entrega é at-least-once, e os consumidores devem deduplicar pelo `eventId`.

### Filas de saída

| Fila | Uso |
|---|---|
| `wager-events.fifo` | eventos de integração. Separada de `wager-transactions.fifo`, de modo que nenhum evento é interpretado como comando |
| `wager-events-dlq.fifo` | DLQ com redrive após 5 recebimentos, para consumidores downstream que não conseguem processar um evento |

Falhas do próprio publisher não vão para essa DLQ: ficam auditadas na tabela.

### Mensagem SQS

- O corpo é exatamente o `payload` persistido, ou seja, o envelope `IntegrationEvent` com `eventId`, `eventType`, `aggregateId`, `correlationId`, `causationId`, `occurredAt`, `version` e `data`.
- O evento nunca é reconstruído a partir do estado atual da wallet.
- `MessageGroupId` = `group_key`, uma coluna gerada a partir de `payload.data.walletId`, com fallback para `aggregate_id`.
- `MessageDeduplicationId` = `eventId`.
- Atributos: `eventId`, `eventType`, `eventVersion` e `correlationId`.
- **Validação antes do envio**: confere identificadores contra a linha, valida o timestamp e a versão, exige que todo `amount` seja string decimal, e limita o corpo a 256 KiB e o `group_key` ao formato aceito pelo SQS.

### Migration `Migration20261102120000_add_outbox_publication_lease`

Migration reversível e compatível com linhas existentes. Adiciona:

- `publish_sequence`: identity, gerada no INSERT. Dentro de uma wallet, a ordem dos INSERTs segue a ordem de commit, porque o lock da wallet serializa as transações.
- `group_key`: coluna gerada.
- `lease_owner`, `lease_token` e `lease_expires_at`.
- `last_attempt_at`, `last_error`, `dead_lettered_at` e `transport_message_id`.
- Constraints de lease completo e estados terminais exclusivos.
- Índice parcial `(group_key, publish_sequence)` sobre as linhas não publicadas.

### Claim

O claim é um único statement SQL, sem transação aberta durante a chamada de rede:

1. **Seleção das cabeças**: só a mensagem mais antiga não publicada de cada `group_key` pode ser escolhida, e apenas se estiver vencida (`next_attempt_at <= now()`) e sem lease ativo. As cabeças são travadas com `FOR UPDATE SKIP LOCKED` e há um limite de `OUTBOX_MAX_GROUPS` grupos.
2. **Lease**: até `OUTBOX_MAX_PER_GROUP` mensagens de cada grupo escolhido recebem `lease_owner`, um `lease_token` aleatório e `lease_expires_at = now() + lease`. O relógio de referência é o do PostgreSQL.
3. **Envio**: os grupos são enviados em paralelo; dentro de um grupo, em sequência e com `SendMessage` individual. Um erro interrompe o grupo e libera o lease do restante.
4. **Confirmação, retry e dead-letter**: só valem com `WHERE lease_token = ?` (fencing). Um publisher que perdeu o lease não consegue confirmar.
5. **Orçamento de lease**: antes de cada envio, o publisher confere quanto resta do lease e, se não houver margem para um envio completo, devolve o restante do grupo.

### Recuperação

- **Lease expirado**: a mensagem volta a ser elegível e o novo dono registra `outbox.lease_recovered` com o `previousOwner`.
- **Processo morto antes do `SendMessage`**: nada foi enviado; outro publisher envia depois que o lease expira.
- **Processo morto ou PostgreSQL indisponível depois do `SendMessage`**: o evento é reenviado com o mesmo `eventId`. A deduplicação FIFO elimina a cópia dentro de 5 minutos; fora dessa janela, quem garante é a deduplicação do consumidor.
- **Timeout local**: a SDK do publisher usa `maxAttempts = 1`, e o retry fica sob controle da Outbox.

### Retries

| Situação | Tratamento |
|---|---|
| Falha transitória (rede, timeout, throttling, 5xx) | `attempts+1`, `next_attempt_at = now() + backoff`, com backoff de 1s, 2s, 4s… até 300s e jitter que reduz o atraso em até 20%. `last_error` guarda o código |
| Erro de configuração (fila inexistente, credencial inválida) | Retry com o mesmo backoff, sem descartar o evento |
| Evento rejeitado pelo SQS ou envelope inválido | `dead_lettered_at` preenchido e `last_error` com o código. O grupo segue para o evento seguinte |
| PostgreSQL indisponível no claim | Ciclo com backoff exponencial até `OUTBOX_ERROR_BACKOFF_MAX_MS` |
| Ciclo sem eventos elegíveis | Espera `OUTBOX_IDLE_POLL_MS`, sem busy polling |

### Ordenação

- **Mesma wallet**: a ordem de publicação segue `publish_sequence`. O `SKIP LOCKED` não quebra essa ordem, porque só a cabeça de cada grupo é elegível, e enquanto ela não for publicada ou ir para dead-letter nenhum outro publisher pega os eventos seguintes.
- **Wallets diferentes**: publicadas em paralelo.
- **Retry da cabeça**: bloqueia apenas a sua wallet até ser publicada; as outras wallets seguem.
- **Dead-letter**: um evento em dead-letter deixa de bloquear a wallet, então o consumidor pode ver uma lacuna na sequência dessa wallet.

### Operação

- `bun run outbox:backlog` mostra, para o banco de desenvolvimento, eventos pendentes, vencidos, em retry, com lease ativo ou expirado, publicados e em dead-letter, além da idade do pendente mais antigo. Use `-- --test` para o banco de testes.
- A API HTTP não inicia o publisher.

## Resolução de `PENDING_REFERENCE`

### Fluxo

Um `REFUND`, `ROLLBACK` ou `WIN` com referência que chega antes dela é gravado como `PENDING_REFERENCE` com `next_reference_attempt_at = agora + 1s` e o evento `WagerTransactionPendingReference`. O worker independente `bun run pending:worker` reavalia essas transações:

1. **Seleção sem lock**: um `SELECT` comum, fora de transação explícita, lista os candidatos vencidos (`status = PENDING_REFERENCE AND next_reference_attempt_at <= now`). Cada instância ordena por `next_reference_attempt_at, md5(id || workerId)`, o que espalha o trabalho entre instâncias.
2. **Resolução**: para cada candidato, `runWithWalletLock(walletId)`, exatamente o mesmo caminho da API e do consumidor SQS. Dentro desse lock:
   1. relê a transação pendente;
   2. faz o fencing: só segue se o status ainda for `PENDING_REFERENCE`, `reference_attempts` for igual ao valor visto na seleção e a transação estiver vencida; caso contrário, `SKIPPED`;
   3. chama `WagerSettlement.settle`, a mesma regra financeira da entrada, que resolve a referência por `(providerId, referenceExternalTransactionId)`, valida, confere reversão prévia e aplica wallet, ledger, transação e outbox;
   4. se a referência continua ausente, faz `reference_attempts+1` e `next_reference_attempt_at = agora + min(base × 2^tentativas, máximo)`;
   5. ao atingir `PENDING_REFERENCE_MAX_ATTEMPTS`, rejeita com `REFERENCE_NOT_FOUND` (ou `REFERENCE_NOT_PROCESSED`, se a referência existe mas nunca ficou terminal) e grava `WagerTransactionRejected` na outbox no mesmo commit.
3. **Identidade**: a transação original é atualizada no lugar (mesmo `id`, `idempotencyKey`, `payloadHash` e referência), e os eventos herdam o `correlationId` e o `causationId` do evento original da transação.

### Replay de operações aceitas como pendentes

O enunciado define dois comportamentos de replay:

- "requisição idêntica → mesma resposta, `idempotentReplay: true`" (seção 9);
- "repetir uma operação já processada retorna o resultado original, incluindo o saldo observado naquele momento" (regra 7).

Ele também pede que interpretações adicionais sejam documentadas. A interpretação adotada é que o replay devolve sempre o estado atual persistido da transação:

| Momento do reenvio | HTTP | Corpo |
|---|---|---|
| Enquanto `PENDING_REFERENCE` | 202 | idêntico ao original, com `idempotentReplay: true` |
| Depois da resolução | 200 | `PROCESSED` com o saldo observado na liquidação, estável em reenvios seguintes |
| Depois de rejeição ou esgotamento | 422 | `REJECTED` com o `failureCode` (por exemplo `REFERENCE_NOT_FOUND`), também estável |

O 202 significa "aceite com processamento pendente", não um resultado. Congelar a resposta em 202 esconderia o desfecho do provedor e contradiria a regra 7 depois que a operação foi processada. `GET /wagering/transactions/:id` mostra o mesmo estado.

**Pelo SQS** a semântica é a mesma: o mesmo `messageId` é `DUPLICATE_MESSAGE`, e um novo `messageId` com a mesma operação é `REPLAYED`. Em ambos os casos a mensagem é confirmada sem novo efeito financeiro.

**Depois do esgotamento** a transação é terminal:

| Reenvio | Resultado |
|---|---|
| Mesmo `externalTransactionId` com a mesma chave | Replay 422 |
| Mesmo `externalTransactionId` com outra chave | 409 `IDEMPOTENCY_CONFLICT`, pela unicidade `(providerId, externalTransactionId)` |
| Novo `externalTransactionId` com nova chave | Operação nova, que pode ser processada |

### Ordem dos locks

```
API / SQS:  wallet (FOR NO KEY UPDATE) → inbox (PK) → wager_tx INSERT (FK: KEY SHARE na wallet já travada)
            → wallet UPDATE → ledger INSERT → wager_tx UPDATE (FK: KEY SHARE na referência, mesma wallet) → outbox INSERT
Worker:     SELECT de candidatos (sem lock, sem transação aberta)
            → [nova transação] wallet (FOR NO KEY UPDATE) → releitura → wallet UPDATE → ledger INSERT
            → wager_tx UPDATE → outbox INSERT
Publisher:  apenas outbox_messages, em statements curtos
```

- Toda linha de `wager_transactions`, `wallet_ledger_entries` e `wallets` é alterada só por quem detém o lock da wallet, e a referência pertence à mesma wallet por constraint. Não há ciclo possível.
- O worker não tem fase de claim nem lease: ele nunca segura um lock de pendência enquanto espera a wallet (comprovado com `pg_locks` no teste G).
- Um processo morto libera o lock da wallet quando a conexão cai, e a pendência continua elegível. Por isso não há claims a recuperar.

### Retries e esgotamento

- **Padrão**: `PENDING_REFERENCE_BASE_DELAY_MS=1000`, `PENDING_REFERENCE_MAX_DELAY_MS=300000` e `PENDING_REFERENCE_MAX_ATTEMPTS=12`. A janela total fica em torno de 23 minutos (1s, 2s, 4s… até 300s), o suficiente para atrasos normais de provedor sem deixar pendências eternas.
- **Erros operacionais** (`lock_timeout`, deadlock, PostgreSQL indisponível): fazem rollback e não consomem tentativa. A pendência continua vencida e é retomada no ciclo seguinte; o worker espera `PENDING_WORKER_IDLE_POLL_MS` quando nenhum candidato avançou.
- **Referência de outro provider**: nunca é encontrada, porque a busca é feita com o próprio provider. A transação expira como `REFERENCE_NOT_FOUND`.

### DLQ e mecanismos distintos

| Mecanismo | Papel |
|---|---|
| `PENDING_REFERENCE` (PostgreSQL) | Estado de negócio, resolvido pelo worker |
| Inbox | Deduplicação de entrega. Não é alterada pelo worker |
| Mensagem SQS de entrada | Confirmada assim que a pendência é gravada |
| DLQ de entrada | Recebe só mensagens malformadas, conflitantes ou com retries técnicos esgotados. Pendências esgotadas não vão para ela: viram `REJECTED` com um evento auditável |
| Outbox e fila de eventos | Publicam o `WagerTransactionRejected` final |

Replay administrativo da DLQ está fora do escopo. Reenviar a mesma mensagem preserva a idempotência pelo `messageId` e pela `idempotencyKey`.

### Operação

`bun run pending:backlog` mostra pendências totais, vencidas, em retry, esgotadas, resolvidas após retry, o número máximo de tentativas e a idade da pendência mais antiga. Use `-- --test` para o banco de testes.
