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
  'perfil de renda': { key: 'vinculo_1', kind: 'text' },
  // seção "SIMULAÇÃO — CRÉDITO COM GARANTIA"
  'imovel': { key: 'valor_imovel', kind: 'number' },
  'credito': { key: 'valor_credito', kind: 'number' },
  'prazo': { key: 'prazo_financ', kind: 'text' }, // TEXT: guarda "60 meses" como veio
  '1ª parcela estimada': { key: 'primeira_parcela', kind: 'number' },
};

// Ficha real (2026-09-25): "Imóvel: Residencial — R$ 500.000,00 (UF: DF)",
// "Entrada: R$ 100.000,00 | Prazo: 30 anos | SAC". Valor do crédito não vem
// na ficha (não calcula imóvel - entrada: regra é não inventar dado).
const HABITACAO_FIELDS: FieldMap = {
  'nome': { key: 'participante_1', kind: 'text' },
  'cpf': { key: 'cpf_1', kind: 'text' },
  'nascimento': { key: 'nascimento_1', kind: 'date' },
  'e-mail': { key: 'email_1', kind: 'text' },
  'email': { key: 'email_1', kind: 'text' },
  'celular': { key: 'telefone_1', kind: 'text' },
  'renda bruta': { key: 'renda_1', kind: 'number' },
  'perfil de renda': { key: 'vinculo_1', kind: 'text' },
  'imovel': { key: 'valor_imovel', kind: 'number' },
  'entrada': { key: 'valor_entrada', kind: 'number' },
  'prazo': { key: 'prazo_financ', kind: 'text' },
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
    // Esse marker SÓ bate quando o cliente já preencheu a proposta completa
    // (CPF, renda, valores etc. — ver HOME_EQUITY_FIELDS) — já tem o que
    // precisa pra pré-análise, não faz sentido nascer em Prospecção pra
    // alguém ter que mover na mão depois. "prospec" era o valor antigo.
    stageMarker: 'pre-analise', // casa "Pré-Análise", "Pré-Analise" etc. (norm() tira acento)
    fields: HOME_EQUITY_FIELDS,
  },
  {
    label: 'Consórcio',
    marker: 'tenho interesse no consorcio', // casa qualquer produto: "Consórcio Volkswagen", "Consórcio de Imóvel" etc.
    departmentName: 'Consórcio',
    // Continua em "prospec": o funil de Consórcio ainda não tem um estágio
    // de Pré-Análise (só "Prospecção") — mudar aqui sem esse estágio existir
    // faria o roteamento inteiro falhar (cai no fallback genérico, perdendo
    // o setor certo). Trocar pra 'pre-analise' quando o estágio for criado.
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
    // Mesmo raciocínio do Home Equity acima — ficha completa já veio.
    stageMarker: 'pre-analise',
    fields: HABITACAO_FIELDS,
  },
];

const SKIP_VALUES = new Set(['—', '-', '', 'nao informada', 'nao informado']);

/** "R$ 100 mil" / "R$ 1.508,38" / "120 meses" / "50000" -> "100000" /
 *  "1508.38" / "120" / "50000" (número puro, sem separador de milhar —
 *  convenção dos campos NUMBER, ver lead-sidebar.tsx normalizeForSave). */
export function parseMoneyOrNumber(raw: string): string | null {
  let s = raw.trim().toLowerCase();
  const isMil = /\bmil\b/.test(s);
  // "R$ 1,10 mi" / "1,5 milhão" — o formulário do site abrevia milhões assim
  // e isso virava 1.1 no card (achado real 2026-09-25).
  const isMilhao = /\b(mi|milh[aã]o|milh[oõ]es)\b/.test(s);
  s = s.replace(/r\$/g, '').replace(/\bmil\b/g, '').replace(/[^\d.,]/g, '').trim();
  if (!s) return null;
  let n: number;
  if (s.includes(',') && s.includes('.')) n = parseFloat(s.replace(/\./g, '').replace(',', '.'));
  else if (s.includes(',')) n = parseFloat(s.replace(',', '.'));
  else n = parseFloat(s);
  if (!Number.isFinite(n)) return null;
  if (isMil) n *= 1000;
  else if (isMilhao) n *= 1_000_000;
  return String(Math.round(n * 100) / 100);
}

/** Lê "Campo: valor" (pode ter mais de um por linha, separado por " | ") e
 *  devolve só os campos que ESSA campanha reconhece. Ignora cabeçalho de
 *  seção (emoji, sem dois-pontos) e placeholder ("—", "não informada"). */
function parseFicha(text: string, fieldMap: FieldMap): Record<string, string> {
  const out: Record<string, string> = {};
  // Seção "2º PARTICIPANTE" repete os rótulos (Nome, CPF, Renda bruta...):
  // dentro dela os campos "_1" viram "_2" — antes sobrescreviam os dados do
  // participante 1. Qualquer outro cabeçalho de seção (*...* sem ":") sai dela.
  let secondParticipant = false;
  for (const rawLine of text.split('\n')) {
    const lineNorm = norm(rawLine.replace(/[*_~`]/g, ''));
    if (/(2[oº°]|segundo)\s*participante|2[oº°]\s*proponente/.test(lineNorm)) { secondParticipant = true; continue; }
    if (rawLine.includes('*') && !rawLine.includes(':')) secondParticipant = false;
    for (const part of rawLine.split('|')) {
      const idx = part.indexOf(':');
      if (idx < 1) continue;
      const label = norm(part.slice(0, idx).replace(/[*_~`]/g, ''));
      const value = part.slice(idx + 1).replace(/[*_~`]/g, '').trim();
      if (!label || !value) continue;
      if (SKIP_VALUES.has(norm(value))) continue;
      const field = fieldMap[label];
      if (!field) continue;
      const key = secondParticipant && field.key.endsWith('_1') ? field.key.replace(/_1$/, '_2') : field.key;
      if (secondParticipant && key === field.key) continue; // campo sem versão _2 (ex.: valor do imóvel) não vem dessa seção
      if (key.startsWith('prazo') && !/\d/.test(value)) continue; // "Prazo:  anos" (em branco no site)
      const parsed = field.kind === 'number' ? parseMoneyOrNumber(value) : value;
      if (parsed !== null && parsed !== '') out[key] = parsed;
    }
  }
  return out;
}

/** Formulário de proposta COMPLETO do site (marca da campanha + CPF) —
 *  usado pra preencher o card também quando o cliente já tinha conversa
 *  aberta (detectCampaignRoute só age na criação de um lead novo). */
export function parseProposalForm(text: string): { label: string; fields: Record<string, string> } | null {
  if (!text || !/cpf\s*:/i.test(text)) return null;
  const normalized = norm(text);
  const sig = CAMPAIGN_SIGNATURES.find((s) => normalized.includes(s.marker));
  if (!sig || !Object.keys(sig.fields).length) return null;
  const fields = parseFicha(text, sig.fields);
  return Object.keys(fields).length ? { label: sig.label, fields } : null;
}

/** Formulário completo chegou num lead que JÁ existe: leva o card pra etapa
 *  de pré-análise do setor do formulário, mas só se ele ainda está ANTES
 *  dela (Prospecção/Follow Up/Lead Sem Retorno) — nunca volta quem já está
 *  em Aprovado, Aguardando Documentação, contratação etc. Lead sem setor
 *  (Caixa de Entrada) vai pro funil do setor do formulário, igual a um
 *  contato novo. Lead de OUTRO setor fica onde está. */
export async function advanceLeadOnProposalForm(accountId: string, leadId: string, text: string): Promise<{ stageId: string; stageName: string } | null> {
  if (!text || !/cpf\s*:/i.test(text)) return null;
  const sig = CAMPAIGN_SIGNATURES.find((s) => norm(text).includes(s.marker));
  if (!sig) return null;

  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: { stage: true, pipeline: { include: { department: true, stages: { orderBy: { order: 'asc' } } } } },
  });
  if (!lead) return null;

  const { updateLeadStage } = require('./lead.service') as typeof import('./lead.service');

  if (!lead.pipeline.department) {
    const route = await detectCampaignRoute(accountId, text);
    if (!route) return null;
    const moved = await updateLeadStage(lead.id, accountId, route.stageId);
    return { stageId: route.stageId, stageName: moved.stage.name };
  }

  if (norm(lead.pipeline.department.name) !== norm(sig.departmentName)) return null;
  const target = lead.pipeline.stages.find((st) => norm(st.name).includes(sig.stageMarker) && !/aprovad/.test(norm(st.name)));
  if (!target || lead.stage.order >= target.order) return null;
  await updateLeadStage(lead.id, accountId, target.id);
  return { stageId: target.id, stageName: target.name };
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
