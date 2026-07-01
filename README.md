# AF CRM — A&F Soluções Financeiras

CRM completo com foco em vendas baseadas em mensagens (*Messenger-Based Sales*), inspirado no Kommo CRM.

> Sistema proprietário desenvolvido para a operação da A&F Soluções Financeiras, centralizando funil de vendas, atendimento multicanal e automação de follow-up em um único painel.

## Sumário

- [Funcionalidades](#funcionalidades)
- [Stack tecnológica](#stack-tecnológica)
- [Requisitos](#requisitos)
- [Instalação](#instalação)
- [Variáveis de ambiente](#variáveis-de-ambiente)
- [Estrutura do projeto](#estrutura-do-projeto)
- [Webhooks de integração](#webhooks-de-integração)
- [Comandos úteis](#comandos-úteis)
- [Agentes do Claude Code](#agentes-do-claude-code)
- [Solução de problemas](#solução-de-problemas)
- [Roadmap](#roadmap)

## Funcionalidades

- **Funil de Vendas (Kanban)** — Drag-and-drop com atualização otimista
- **Inbox Unificada** — WhatsApp, Instagram, Telegram, Web Chat e E-mail em tempo real via WebSocket
- **Detalhe do Lead** — Timeline completa, tarefas, notas e histórico de mensagens
- **SalesBot Editor** — Editor visual de fluxos de automação
- **Relatórios** — KPIs, gráficos de receita, conversão e performance por consultor
- **Gestão de Contatos e Tarefas**
- **Controle de acesso por papel** — Admin, Manager e Agent com permissões distintas

## Stack tecnológica

### Frontend
- Next.js 14 com App Router e TypeScript
- Tailwind CSS + design system A&F
- Zustand (estado global)
- TanStack Query (cache e sincronização)
- @dnd-kit (drag-and-drop no Kanban)
- Chart.js (gráficos)
- Socket.io-client (inbox em tempo real)

### Backend
- Node.js com Express e TypeScript
- Prisma ORM + PostgreSQL 15
- Redis 7 + BullMQ (filas)
- Socket.io (WebSocket)
- JWT + bcrypt (autenticação)

## Requisitos

| Ferramenta | Versão mínima |
|---|---|
| Node.js | 18+ |
| npm | 9+ |
| Docker e Docker Compose | qualquer versão recente |

> Verifique as versões instaladas com `node -v`, `npm -v` e `docker --version` antes de começar.

## Instalação

### 1. Clone e configure as variáveis de ambiente

```bash
git clone <url-do-repositorio> af-crm
cd af-crm
cp .env.example apps/api/.env
```

Edite `apps/api/.env` com suas configurações (o padrão já funciona para desenvolvimento local). Veja a seção [Variáveis de ambiente](#variáveis-de-ambiente) para detalhes de cada campo.

### 2. Suba o banco de dados e Redis

```bash
docker-compose up -d
```

Aguarde alguns segundos para os serviços iniciarem. Confirme que os containers estão saudáveis com `docker-compose ps`.

### 3. Instale as dependências

```bash
npm install
```

### 4. Configure o banco de dados

```bash
cd apps/api
npx prisma generate
npx prisma migrate dev --name init
```

### 5. Popule com dados de exemplo

```bash
npx ts-node prisma/seed.ts
```

Isso cria:
- 1 conta: **A&F Soluções Financeiras**
- 3 usuários com senha `af2026`:
  - `admin@af.com.br` (Admin)
  - `gerente@af.com.br` (Manager)
  - `agente@af.com.br` (Agent)
- 1 pipeline com 5 estágios
- 10 leads com valores variados
- 5 contatos, mensagens e 8 tarefas

> ⚠️ A senha padrão `af2026` é apenas para desenvolvimento local. Nunca use dados/senhas de seed em ambiente de produção — altere as credenciais antes de qualquer deploy.

### 6. Inicie o projeto

```bash
cd ../..   # voltar para a raiz
npm run dev
```

| Serviço | URL |
|---------|-----|
| Frontend | http://localhost:3000 |
| Backend API | http://localhost:3001 |
| Health check | http://localhost:3001/health |

## Variáveis de ambiente

Principais variáveis esperadas em `apps/api/.env` (consulte `.env.example` para a lista completa e valores padrão de desenvolvimento):

| Variável | Descrição |
|---|---|
| `DATABASE_URL` | String de conexão do PostgreSQL |
| `REDIS_URL` | String de conexão do Redis |
| `JWT_SECRET` | Chave usada para assinar os tokens de autenticação |
| `WHATSAPP_VERIFY_TOKEN` / `WHATSAPP_ACCESS_TOKEN` | Credenciais da WhatsApp Cloud API |
| `INSTAGRAM_ACCESS_TOKEN` | Credencial da Instagram Graph API |
| `TELEGRAM_BOT_TOKEN` | Token do bot no Telegram Bot API |

> Nunca commite o arquivo `.env` com credenciais reais. Mantenha `apps/api/.env` no `.gitignore` e use um gerenciador de segredos em produção.

## Estrutura do projeto

```
af-crm/
├── apps/
│   ├── web/          # Next.js 14 (frontend)
│   └── api/          # Express + Prisma (backend)
├── docker-compose.yml
└── .env.example
```

## Webhooks de integração

| Canal | Endpoint |
|-------|----------|
| WhatsApp Cloud API | `POST /api/webhooks/whatsapp` |
| Instagram Graph API | `POST /api/webhooks/instagram` |
| Telegram Bot API | `POST /api/webhooks/telegram` |

Configure as variáveis no `.env` para ativar cada integração. Cada canal exige que o endpoint correspondente esteja publicamente acessível (via domínio próprio ou túnel como ngrok em desenvolvimento) para receber os callbacks.

## Comandos úteis

```bash
# Ver logs do banco
docker-compose logs -f postgres

# Abrir Prisma Studio (UI do banco)
cd apps/api && npx prisma studio

# Resetar o banco
cd apps/api && npx prisma migrate reset

# Rodar seed novamente
cd apps/api && npx ts-node prisma/seed.ts

# Ver logs de todos os serviços do Docker
docker-compose logs -f

# Parar os serviços
docker-compose down
```

## Agentes do Claude Code

O projeto tem agentes especializados do [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) para desenvolvimento assistido, um por área do sistema. Eles ficam versionados em `.claude/agents/` e são compartilhados por todo o time.

| Agente | Área | Uso |
|---|---|---|
| `frontend-developer` | `apps/web` | Kanban, inbox, detalhe do lead, SalesBot Editor, relatórios |
| `backend-developer` | `apps/api` | Rotas Express, autenticação por papel, filas, eventos Socket.io |
| `database-architect` | Schema/Prisma | Modelagem, migrações, seed, performance de queries |
| `integrations-engineer` | Webhooks | WhatsApp Cloud API, Instagram Graph API, Telegram Bot API |
| `code-reviewer` | Revisão | Revisa mudanças por severidade (🔴🟡🟢), não edita código |
| `test-writer` | Testes | Testes unitários/integração pro backend e componentes críticos do frontend |

### Instalação

```bash
cp agents/*.md .claude/agents/
```

(Se a pasta `agents/` com as definições ainda não existir no repositório, peça as definições atualizadas antes de rodar o comando acima.)

### Uso

O Claude Code delega automaticamente com base na descrição de cada agente, ou você pode chamar explicitamente:

```
Use o agente backend-developer para criar a rota de reatribuição de lead entre consultores
```

Fluxo comum de trabalho: implementar (frontend/backend/database/integrations) → `code-reviewer` → `test-writer`, encadeando os agentes na mesma tarefa sem precisar reabrir contexto do zero a cada etapa.

## Solução de problemas

| Sintoma | Causa provável | Solução |
|---|---|---|
| API não conecta ao banco | Containers do Docker ainda subindo | Aguarde `docker-compose ps` mostrar status `healthy` e tente novamente |
| Erro do Prisma ao migrar | Client desatualizado após alterar o schema | Rode `npx prisma generate` antes de `migrate dev` |
| WebSocket não conecta no frontend | Backend não está rodando ou porta incorreta | Confirme que a API está ativa em `http://localhost:3001/health` |
| Webhook não recebe eventos | Endpoint não está publicamente acessível | Use um túnel (ex. ngrok) em desenvolvimento e configure a URL no provedor (Meta/Telegram) |

## Roadmap

- [ ] Testes automatizados (unitários e E2E)
- [ ] Pipeline de CI/CD
- [ ] Documentação da API (ex. Swagger/OpenAPI)
- [ ] Deploy em produção (infraestrutura a definir)
