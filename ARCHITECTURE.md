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
