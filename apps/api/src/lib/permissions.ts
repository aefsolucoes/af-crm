// Definição central das permissões ("caixinhas") do CRM. Usada para gatear as
// rotas (middleware requirePermission) e as ações do assistente. O front tem uma
// cópia equivalente em apps/web/lib/permissions.ts — mantenha as duas em sincronia.

export const PERMISSION_KEYS = [
  'dashboard',     // ver o painel inicial
  'funnel_view',   // ver o funil de vendas
  'funnel_manage', // criar/mover/editar/excluir cards
  'inbox_view',    // ver as conversas
  'inbox_reply',   // enviar mensagens
  'tasks',         // ver e gerenciar tarefas
  'salesbot',      // criar/editar automações de mensagem
  'templates',     // gerenciar modelos de mensagem
  'automations',   // configurar regras/automações
  'finance',       // ver/gerenciar o financeiro
  'users',         // gerenciar a equipe (criar/editar/excluir, tirar acesso)
  'settings',      // acessar configurações (QR Code, campos, etc.)
  'browser_agent', // usar o Agente de Navegador (IA controla o Chrome de verdade)
] as const;

export type PermissionKey = typeof PERMISSION_KEYS[number];
export type PermissionMap = Record<PermissionKey, boolean>;

function fill(value: boolean): PermissionMap {
  return PERMISSION_KEYS.reduce((acc, k) => { acc[k] = value; return acc; }, {} as PermissionMap);
}

// Padrões por papel, usados quando o usuário não tem permissões próprias salvas.
export const ROLE_DEFAULTS: Record<string, PermissionMap> = {
  ADMIN: fill(true),
  // browser_agent fica de fora do "MANAGER tem quase tudo" de propósito — é
  // automação com efeito real fora do CRM (clica/digita em sites de
  // terceiros), risco diferente do resto. Só Admin por padrão; liberar pra
  // um Manager específico é decisão manual em Usuários.
  MANAGER: { ...fill(true), settings: false, browser_agent: false },
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

// Permissões efetivas: Admin sempre tem tudo (evita travar a conta); senão, usa
// as permissões próprias do usuário, ou o padrão do papel. Garante todas as chaves.
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
