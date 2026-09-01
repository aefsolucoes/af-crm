import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Roteamento automático de lead vindo de ficha de campanha (o site da A&F
 * manda uma mensagem de WhatsApp formatada com "Campo: valor" quando alguém
 * preenche uma proposta). Detecta o tipo de campanha pela frase de abertura,
 * lê os campos da ficha e devolve pra onde o lead deve nascer — em vez da
 * Caixa de Entrada genérica.
 *
 * SÓ atua na criação de um lead NOVO (1ª mensagem de um contato) — nunca em
 * conversa já existente, pra não mover ninguém sem querer no meio do
 * atendimento.
 *
 * Cadastro de novas campanhas: adicionar um item em CAMPAIGN_SIGNATURES, com
 * o mapa de campos DESSA campanha (o mesmo rótulo "Prazo" significa coisas
 * diferentes em fichas diferentes — Home Equity guarda texto solto
 * (prazo_financ), Consórcio guarda só o número de meses (prazo_consorcio) —
 * por isso o mapa é por campanha, não global).
 */

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function norm(s: string): string {
  return stripAccents(s).toLowerCase().trim();
}

type FieldKind = 'text' | 'number' | 'date';
type FieldMap = Record<string, { key: string; kind: FieldKind }>;

interface CampaignSignature {
  /** Nome só para log/depuração. */
  label: string;
  /** Substring (já normalizada) que precisa aparecer na mensagem pra classificar. */
  marker: string;
  /** Nome EXATO do Department (mesma string usada em funil-.../page.tsx). */
  departmentName: string;
  /** Substring (normalizada) que precisa aparecer no NOME do estágio-alvo. */
  stageMarker: string;
  /** Rótulo da ficha (normalizado) -> key do FieldDefinition (prisma/seed.ts).
   *  Match é EXATO no rótulo inteiro depois de normalizar — de propósito:
   *  "nome" não pode casar com "nome da mãe" por conter a palavra. */
  fields: FieldMap;
}

const HOME_EQUITY_FIELDS: FieldMap = {
  'nome': { key: 'participante_1', kind: 'text' },
  'cpf': { key: 'cpf_1', kind: 'text' },
  'nascimento': { key: 'nascimento_1', kind: 'date' },
  'e-mail': { key: 'email_1', kind: 'text' },
  'email': { key: 'email_1', kind: 'text' },
  'celular': { key: 'telefone_1', kind: 'text' },
  'renda bruta': { key: 'renda_1', kind: 'number' },
  // seção "SIMULAÇÃO — CRÉDITO COM GARANTIA"
  'imovel': { key: 'valor_imovel', kind: 'number' },
  'credito': { key: 'valor_credito', kind: 'number' },
  'prazo': { key: 'prazo_financ', kind: 'text' }, // TEXT: guarda "60 meses" como veio
  '1ª parcela estimada': { key: 'primeira_parcela', kind: 'number' },
};

const CONSORCIO_FIELDS: FieldMap = {
  'nome': { key: 'participante_1', kind: 'text' },
  'cpf': { key: 'cpf_1', kind: 'text' },
  'renda bruta mensal': { key: 'renda_1', kind: 'number' },
  'credito desejado': { key: 'credito_consorcio', kind: 'number' },
  'prazo': { key: 'prazo_consorcio', kind: 'number' }, // NUMBER aqui: só "120", sem "meses"
  'parcela ate a contemplacao': { key: 'parcela_consorcio', kind: 'number' },
  // "Endereço" e "Parcela após a contemplação" ficam de fora: não existe campo
  // pra endereço completo nem pra 2ª parcela no card — regra é não inventar
  // campo que não existe.
};

const CAMPAIGN_SIGNATURES: CampaignSignature[] = [
  {
    label: 'Home Equity — Crédito com Garantia de Imóvel',
    marker: 'proposta de credito com garantia de imovel',
    departmentName: 'Home Equity',
    stageMarker: 'prospec', // casa "Prospecção", "Prospecção Home Equity" etc.
    fields: HOME_EQUITY_FIELDS,
  },
  {
    label: 'Consórcio',
    marker: 'tenho interesse no consorcio', // casa qualquer produto: "Consórcio Volkswagen", "Consórcio de Imóvel" etc.
    departmentName: 'Consórcio',
    stageMarker: 'prospec',
    fields: CONSORCIO_FIELDS,
  },
  {
    label: 'Financiamento Habitacional',
    marker: 'proposta de financiamento habitacional',
    // Nome do Department padrão da conta (department.service.ts,
    // DEFAULT_DEPARTMENTS) — mesma string usada em funil-habitacao/page.tsx.
    // Diferente de Home Equity, esse setor já existe por padrão em toda conta.
    departmentName: 'Financiamento Habitacional',
    stageMarker: 'prospec',
    // Só roteamento por enquanto — pedido não veio com o texto completo da
    // ficha, então sem mapa de campos (não dá pra adivinhar rótulo sem
    // exemplo real). Adicionar aqui do mesmo jeito que HOME_EQUITY_FIELDS/
    // CONSORCIO_FIELDS assim que tiver uma mensagem de exemplo.
    fields: {},
  },
];

const SKIP_VALUES = new Set(['—', '-', '', 'nao informada', 'nao informado']);

/** "R$ 100 mil" / "R$ 1.508,38" / "120 meses" / "50000" -> "100000" /
 *  "1508.38" / "120" / "50000" (número puro, sem separador de milhar —
 *  convenção dos campos NUMBER, ver lead-sidebar.tsx normalizeForSave). */
function parseMoneyOrNumber(raw: string): string | null {
  let s = raw.trim().toLowerCase();
  const isMil = /\bmil\b/.test(s);
  s = s.replace(/r\$/g, '').replace(/\bmil\b/g, '').replace(/[^\d.,]/g, '').trim();
  if (!s) return null;
  let n: number;
  if (s.includes(',') && s.includes('.')) n = parseFloat(s.replace(/\./g, '').replace(',', '.'));
  else if (s.includes(',')) n = parseFloat(s.replace(',', '.'));
  else n = parseFloat(s);
  if (!Number.isFinite(n)) return null;
  if (isMil) n *= 1000;
  return String(n);
}

/** Lê "Campo: valor" (pode ter mais de um por linha, separado por " | ") e
 *  devolve só os campos que ESSA campanha reconhece. Ignora cabeçalho de
 *  seção (emoji, sem dois-pontos) e placeholder ("—", "não informada"). */
function parseFicha(text: string, fieldMap: FieldMap): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    for (const part of rawLine.split('|')) {
      const idx = part.indexOf(':');
      if (idx < 1) continue;
      const label = norm(part.slice(0, idx).replace(/[*_~`]/g, ''));
      const value = part.slice(idx + 1).replace(/[*_~`]/g, '').trim();
      if (!label || !value) continue;
      if (SKIP_VALUES.has(norm(value))) continue;
      const field = fieldMap[label];
      if (!field) continue;
      const parsed = field.kind === 'number' ? parseMoneyOrNumber(value) : value;
      if (parsed !== null && parsed !== '') out[field.key] = parsed;
    }
  }
  return out;
}

export interface CampaignRoute {
  signature: string;
  pipelineId: string;
  stageId: string;
  fields: Record<string, string>;
}

/** Se `text` bater com uma campanha conhecida E existir um estágio
 *  correspondente na conta, devolve pra onde o lead deve nascer + os campos
 *  já lidos da ficha. Sem match (campanha não reconhecida, ou setor/estágio
 *  não existe nessa conta) devolve null — quem chama cai no roteamento
 *  normal, sem quebrar nada. */
export async function detectCampaignRoute(accountId: string, text: string): Promise<CampaignRoute | null> {
  if (!text) return null;
  const normalized = norm(text);
  const sig = CAMPAIGN_SIGNATURES.find((s) => normalized.includes(s.marker));
  if (!sig) return null;

  const dept = await prisma.department.findFirst({
    where: { accountId, name: { equals: sig.departmentName, mode: 'insensitive' } },
    select: { id: true },
  });
  if (!dept) {
    console.warn(`[Campanha] "${sig.label}" detectada, mas o setor "${sig.departmentName}" não existe nesta conta.`);
    return null;
  }

  const pipelines = await prisma.pipeline.findMany({
    where: { accountId, departmentId: dept.id },
    include: { stages: { orderBy: { order: 'asc' } } },
  });
  for (const p of pipelines) {
    const stage = p.stages.find((st) => norm(st.name).includes(sig.stageMarker));
    if (stage) {
      return { signature: sig.label, pipelineId: p.id, stageId: stage.id, fields: parseFicha(text, sig.fields) };
    }
  }
  console.warn(`[Campanha] "${sig.label}" detectada, mas nenhum funil do setor "${sig.departmentName}" tem estágio com "${sig.stageMarker}" no nome.`);
  return null;
}
