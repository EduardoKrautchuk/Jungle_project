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
- **Publisher da outbox**: ainda não existe. Os eventos ficam pendentes na tabela `outbox_messages` (Etapa 8).
- **`PENDING_REFERENCE`**: a resolução depende do worker da Etapa 9.
