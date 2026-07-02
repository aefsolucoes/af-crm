export type TemplateCategory = 'vendas' | 'suporte' | 'cobranca' | 'boas_vindas' | 'follow_up' | 'geral';

export interface MessageTemplate {
  id: string;
  name: string;
  category: TemplateCategory;
  body: string;
  variables: string[];
  createdAt: string;
}

const STORAGE_KEY = 'af_templates';

export const CATEGORY_META: Record<TemplateCategory, { label: string; color: string }> = {
  vendas: { label: 'Vendas', color: 'bg-blue-100 text-blue-700' },
  suporte: { label: 'Suporte', color: 'bg-purple-100 text-purple-700' },
  cobranca: { label: 'Cobrança', color: 'bg-orange-100 text-orange-700' },
  boas_vindas: { label: 'Boas-vindas', color: 'bg-green-100 text-green-700' },
  follow_up: { label: 'Follow-up', color: 'bg-yellow-100 text-yellow-700' },
  geral: { label: 'Geral', color: 'bg-slate-100 text-slate-600' },
};

export function extractVariables(text: string): string[] {
  const matches = text.match(/\{\{([^}]+)\}\}/g) || [];
  return [...new Set(matches.map(m => m.replace(/\{\{|\}\}/g, '').trim()))];
}

export function fillTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{([^}]+)\}\}/g, (_, key) => vars[key.trim()] || `{{${key.trim()}}}`);
}

const DEFAULT_TEMPLATES: MessageTemplate[] = [
  {
    id: 't1',
    name: 'Boas-vindas inicial',
    category: 'boas_vindas',
    body: 'Olá, {{nome}}! 👋\n\nSeja bem-vindo(a) à *A&F Soluções Financeiras*!\n\nEstou aqui para ajudá-lo(a) a conquistar seus objetivos financeiros. Como posso ajudá-lo(a) hoje?',
    variables: ['nome'],
    createdAt: '2024-01-01',
  },
  {
    id: 't2',
    name: 'Follow-up de proposta',
    category: 'follow_up',
    body: 'Olá, {{nome}}! 😊\n\nPassando para verificar se teve a oportunidade de analisar a proposta que enviamos sobre *{{produto}}*.\n\nFicou com alguma dúvida? Estou à disposição!\n\nAtenciosamente,\n{{agente}}',
    variables: ['nome', 'produto', 'agente'],
    createdAt: '2024-01-10',
  },
  {
    id: 't3',
    name: 'Confirmação de reunião',
    category: 'vendas',
    body: '📅 *Confirmação de Reunião*\n\nOlá, {{nome}}!\n\nConfirmamos sua reunião para *{{data}}* às *{{horario}}*.\n\nLocal/Link: {{local}}\n\nEm caso de necessidade de reagendamento, entre em contato conosco.\n\nAté lá! 🤝',
    variables: ['nome', 'data', 'horario', 'local'],
    createdAt: '2024-01-15',
  },
  {
    id: 't4',
    name: 'Lembrete de pagamento',
    category: 'cobranca',
    body: 'Olá, {{nome}}!\n\nGostaríamos de lembrá-lo(a) que sua parcela no valor de *R$ {{valor}}* vence em *{{vencimento}}*.\n\nPara evitar juros e multas, efetue o pagamento até a data de vencimento.\n\nChave PIX: {{chave_pix}}\n\nDúvidas? Estamos à disposição.',
    variables: ['nome', 'valor', 'vencimento', 'chave_pix'],
    createdAt: '2024-02-01',
  },
];

export function getTemplates(): MessageTemplate[] {
  if (typeof window === 'undefined') return DEFAULT_TEMPLATES;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_TEMPLATES));
    return DEFAULT_TEMPLATES;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return DEFAULT_TEMPLATES;
  }
}

export function saveTemplates(templates: MessageTemplate[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
}
