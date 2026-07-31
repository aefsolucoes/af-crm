// Espelho das permissões do backend (apps/api/src/lib/permissions.ts).
// Mantenha as duas listas em sincronia.

export const PERMISSION_KEYS = [
  'dashboard',
  'funnel_view',
  'funnel_manage',
  'inbox_view',
  'inbox_reply',
  'tasks',
  'salesbot',
  'templates',
  'automations',
  'finance',
  'users',
  'settings',
] as const;

export type PermissionKey = typeof PERMISSION_KEYS[number];
export type PermissionMap = Record<PermissionKey, boolean>;

export const PERMISSION_LABELS: Record<PermissionKey, { label: string; hint: string }> = {
  dashboard:     { label: 'Dashboard', hint: 'Ver o painel inicial' },
  funnel_view:   { label: 'Funil — ver', hint: 'Ver o funil de vendas' },
  funnel_manage: { label: 'Funil — mover/editar cards', hint: 'Arrastar, editar e excluir cards' },
  inbox_view:    { label: 'Inbox — ver', hint: 'Ver as conversas' },
  inbox_reply:   { label: 'Inbox — responder', hint: 'Enviar mensagens' },
  tasks:         { label: 'Tarefas', hint: 'Ver e gerenciar tarefas' },
  salesbot:      { label: 'SalesBot', hint: 'Criar/editar automações de mensagem' },
  templates:     { label: 'Templates', hint: 'Gerenciar modelos de mensagem' },
  automations:   { label: 'Automações', hint: 'Configurar regras' },
  finance:       { label: 'Financeiro', hint: 'Ver/gerenciar o financeiro' },
  users:         { label: 'Usuários', hint: 'Gerenciar a equipe' },
  settings:      { label: 'Configurações', hint: 'Acessar as configurações' },
};

function fill(value: boolean): PermissionMap {
  return PERMISSION_KEYS.reduce((acc, k) => { acc[k] = value; return acc; }, {} as PermissionMap);
}

export const ROLE_DEFAULTS: Record<string, PermissionMap> = {
  ADMIN: fill(true),
  MANAGER: { ...fill(true), settings: false },
  AGENT: {
    ...fill(false),
    dashboard: true,
    funnel_view: true,
    funnel_manage: true,
    inbox_view: true,
    inbox_reply: true,
    tasks: true,
  },
};

// Mapa de rota (prefixo) → permissão necessária. Usado para esconder itens do
// menu e barrar o acesso direto por URL.
export const ROUTE_PERMISSION: { prefix: string; perm: PermissionKey }[] = [
  { prefix: '/dashboard', perm: 'dashboard' },
  { prefix: '/funil', perm: 'funnel_view' },
  { prefix: '/inbox', perm: 'inbox_view' },
  { prefix: '/tarefas', perm: 'tasks' },
  { prefix: '/salesbot', perm: 'salesbot' },
  { prefix: '/templates', perm: 'templates' },
  { prefix: '/automacao', perm: 'automations' },
  { prefix: '/usuarios', perm: 'users' },
  { prefix: '/financeiro', perm: 'finance' },
  { prefix: '/configuracoes', perm: 'settings' },
];

// Admin sempre tudo; senão, permissões próprias ou o padrão do papel.
export function effectivePermissions(role: string, stored: unknown): PermissionMap {
  if (role === 'ADMIN') return fill(true);
  const source =
    stored && typeof stored === 'object' && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : (ROLE_DEFAULTS[role] || ROLE_DEFAULTS.AGENT);
  const out = {} as PermissionMap;
  for (const k of PERMISSION_KEYS) out[k] = !!(source as Record<string, unknown>)[k];
  return out;
}
