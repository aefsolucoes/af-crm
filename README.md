# AF CRM — A&F Soluções Financeiras

CRM completo com foco em vendas baseadas em mensagens (Messenger-Based Sales), inspirado no Kommo CRM.

## Funcionalidades

- **Funil de Vendas (Kanban)** — Drag-and-drop com atualização otimista
- **Inbox Unificada** — WhatsApp, Instagram, Telegram, Web Chat e E-mail em tempo real via WebSocket
- **Detalhe do Lead** — Timeline completa, tarefas, notas e histórico de mensagens
- **SalesBot Editor** — Editor visual de fluxos de automação
- **Relatórios** — KPIs, gráficos de receita, conversão e performance por consultor
- **Gestão de Contatos e Tarefas**

## Requisitos

- Node.js 18+
- Docker e Docker Compose
- npm 9+

## Instalação

### 1. Clone e configure as variáveis de ambiente

```bash
cp .env.example apps/api/.env
```

Edite `apps/api/.env` com suas configurações (o padrão já funciona para desenvolvimento local).

### 2. Suba o banco de dados e Redis

```bash
docker-compose up -d
```

Aguarde alguns segundos para os serviços iniciarem.

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

## Estrutura do projeto

```
af-crm/
├── apps/
│   ├── web/          # Next.js 14 (frontend)
│   └── api/          # Express + Prisma (backend)
├── docker-compose.yml
└── .env.example
```

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

## Webhooks de integração

| Canal | Endpoint |
|-------|----------|
| WhatsApp Cloud API | `POST /api/webhooks/whatsapp` |
| Instagram Graph API | `POST /api/webhooks/instagram` |
| Telegram Bot API | `POST /api/webhooks/telegram` |

Configure as variáveis no `.env` para ativar cada integração.

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
```
