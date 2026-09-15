import { PrismaClient } from '@prisma/client';
import { searchKnowledge } from './knowledge.service';
import { parseMoneyOrNumber } from './campaign-detection.service';
import { logActivity } from './activity.service';

const prisma = new PrismaClient();

/**
 * "Cérebro" compartilhado entre as duas IAs que ajudam a responder cliente:
 * a que fala DIRETO com ele (ai-auto-reply.service.ts) e a que sugere pro
 * colaborador revisar antes de mandar (ai-reply-suggestion.service.ts).
 *
 * Usuário pediu explicitamente que fossem "a mesma IA" — antes eram dois
 * prompts mantidos à mão, que foram divergindo (a de auto-resposta ficou
 * mais hesitante que a de sugestão com o mesmo material disponível). Agora
 * as duas usam exatamente este mesmo material de contexto (Base de
 * Conhecimento, Respostas Rápidas, estilo do vendedor, escopo do setor) e
 * as mesmas regras de como responder (CORE_RULES) — só o que é
 * estruturalmente inevitável continua diferente em cada arquivo: a
 * auto-resposta precisa decidir quando chamar um humano (handoff) e agora
 * também pode mover o card de etapa/preencher dados extraídos da conversa
 * (ver applyAiExtractedActions) — a sugestão nunca precisou disso, porque
 * um vendedor sempre revisa e faz essas ações ele mesmo.
 */

export const CORE_RULES = `REGRAS OBRIGATÓRIAS:
- Responda com base no material de referência (Base de Conhecimento + Respostas Rápidas) e no histórico da conversa, abaixo — e use esse material com CONFIANÇA: se ele sustenta uma resposta, responda direto, sem hesitar. NUNCA invente valor, taxa, prazo, data, documento ou qualquer fato específico que não esteja claramente no material — mas se faltar só um dado específico pra completar a resposta, responda a parte que você tem certeza e avance a conversa (peça a informação que falta, ou marque o próximo passo) SEM inventar o dado que falta.
- Se a pergunta/objeção do cliente bater com uma das "Respostas Rápidas" abaixo, seja FIEL ao conteúdo dela — não invente uma lista ou explicação diferente. Pode adaptar o tom pra soar natural, mas o conteúdo (itens, valores, condições) tem que ser exatamente o que está lá.
- Foco em AVANÇAR o atendimento: entenda a última mensagem/objeção do cliente e responda contornando a objeção, reforçando o benefício certo pra esse cliente, conduzindo a conversa adiante (marcar um próximo passo, pedir um documento, agendar, confirmar interesse) — não só responda, empurre pra frente.
- Tom natural de conversa do dia a dia, como a pessoa normalmente escreve (ver estilo abaixo) — nunca pareça um roteiro decorado ou um robô. Português do Brasil, sem formalidade excessiva.
- Sem emoji, a menos que o estilo de escrita abaixo já use.
- Curto: 1 a 3 frases na maioria das vezes, do tamanho de uma mensagem de WhatsApp real (ou o tamanho da própria Resposta Rápida, quando usar uma).`;

export interface SharedAiContext {
  lead: {
    id: string;
    userId: string | null;
    user: { id: string; name: string } | null;
  };
  departmentId: string | undefined;
  historicoTexto: string;
  contextoTexto: string;
  respostasRapidasTexto: string;
  estiloTexto: string;
  escopoTexto: string;
}

/**
 * Monta todo o material de contexto compartilhado pras duas IAs, escopado
 * pelo lead/setor. `focusText` é o texto usado pra buscar na Base de
 * Conhecimento (a mensagem recebida, no auto-reply; a última mensagem do
 * cliente, na sugestão) — cada chamador decide como achar esse foco, essa
 * função só recebe o resultado. Retorna null se o lead não existir.
 */
export async function buildSharedAiContext(
  accountId: string,
  leadId: string,
  focusText: string,
  opts: { historyTake?: number; historyRoleLabels?: { inbound: string; outbound: string } } = {}
): Promise<SharedAiContext | null> {
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, accountId },
    include: { pipeline: { include: { department: true } }, user: { select: { id: true, name: true } } },
  });
  if (!lead) return null;

  const historyTake = opts.historyTake ?? 12;
  const inboundLabel = opts.historyRoleLabels?.inbound ?? 'Cliente';
  const outboundLabel = opts.historyRoleLabels?.outbound ?? 'Atendente';

  const recent = await prisma.message.findMany({
    where: { leadId },
    orderBy: { createdAt: 'desc' },
    take: historyTake,
  });
  const ordered = recent.reverse();
  const historicoTexto = ordered.length
    ? ordered.map((m) => `${m.direction === 'INBOUND' ? inboundLabel : outboundLabel}: ${m.content}`).join('\n')
    : '(sem histórico anterior)';

  // Escopo de produtos deste setor — trata o setor do CARD como o produto
  // correto do cliente, mesmo com palavreado ambíguo (ex.: "crédito com
  // garantia de imóvel" pode soar como Home Equity mesmo num card de
  // Financiamento Habitacional) — evita a IA trocar de produto sozinha.
  const department = lead.pipeline?.department;
  const escopo = department?.aiScope?.trim() || department?.name || null;
  const escopoTexto = escopo
    ? `Este atendimento já está classificado no setor "${department?.name}" — os produtos deste setor são: ${escopo}. Trate isso como o produto CORRETO do cliente, mesmo que a mensagem dele use um termo ambíguo que pareça outro produto da empresa — não troque de produto por conta própria. Só se a mensagem for GENUINAMENTE sobre outra linha de negócio da empresa (fora dessa lista) é que isso deve ser tratado como fora de escopo.`
    : '(este atendimento não tem um setor/produto definido — sem restrição de escopo)';

  // Combina documentos do Drive (busca por similaridade) com entradas
  // manuais da Base de Conhecimento (sempre incluídas, escopadas por
  // setor) — ver searchKnowledge em knowledge.service.ts.
  const hits = focusText.trim() ? await searchKnowledge(accountId, focusText, 5, department?.id) : [];
  const contextoTexto = hits.length
    ? hits.map((h, i) => `[${i + 1}] ${h.content}`).join('\n\n')
    : '(nenhum material relevante encontrado na Base de Conhecimento para esta pergunta — se a dúvida depender de um fato específico, não invente)';

  // Respostas Rápidas do setor deste lead + as "compartilhadas" (sem
  // setor) — mesmo critério usado na tela de Respostas Rápidas.
  const templates = await prisma.messageTemplate.findMany({
    where: {
      accountId,
      ...(department?.id ? { OR: [{ departmentId: department.id }, { departmentId: null }] } : {}),
    },
    orderBy: { name: 'asc' },
  });
  const respostasRapidasTexto = templates.length
    ? templates.map((t) => `- "${t.name}": ${t.body}`).join('\n')
    : '(nenhuma resposta rápida cadastrada)';

  // Estilo de escrita de quem normalmente atende esse cliente — usa
  // mensagens reais que ELE mandou (sentByUserId), nunca as da própria IA,
  // pra imitar só o TOM, nunca o conteúdo/fatos de outra conversa.
  let estiloTexto = '(sem exemplos suficientes — escreva de forma natural e não robótica)';
  if (lead.userId) {
    const exemplos = await prisma.message.findMany({
      where: { direction: 'OUTBOUND', sentByUserId: lead.userId },
      orderBy: { createdAt: 'desc' },
      take: 30,
    }).catch(() => []);
    const escolhidos = exemplos
      .map((m) => m.content.trim())
      .filter((c) => c.length >= 8 && c.length <= 300)
      .slice(0, 6);
    if (escolhidos.length) estiloTexto = escolhidos.map((c) => `- "${c}"`).join('\n');
  }

  return {
    lead: { id: lead.id, userId: lead.userId, user: lead.user },
    departmentId: department?.id,
    historicoTexto,
    contextoTexto,
    respostasRapidasTexto,
    estiloTexto,
    escopoTexto,
  };
}

/** Monta os blocos de contexto no MESMO formato/ordem pras duas IAs. */
export function buildContextBlocks(ctx: SharedAiContext): string {
  return `--- ESCOPO DE ATENDIMENTO (produto deste chat) ---
${ctx.escopoTexto}

--- ESTILO DE ESCRITA DE QUEM ATENDE ESTE CLIENTE (${ctx.lead.user?.name || 'sem responsável definido'}) ---
Imite só o TOM e o jeito de escrever destes exemplos reais que ele(a) já mandou pra outros clientes — NUNCA reaproveite o conteúdo/fatos deles, que são de outras conversas:
${ctx.estiloTexto}

--- BASE DE CONHECIMENTO (material de referência) ---
${ctx.contextoTexto}

--- RESPOSTAS RÁPIDAS (modelos prontos da equipe — use o conteúdo fielmente quando bater) ---
${ctx.respostasRapidasTexto}

--- HISTÓRICO RECENTE DESTA CONVERSA ---
${ctx.historicoTexto}`;
}

// ─── Ações que só a IA de auto-resposta pode tomar (mover etapa / ────────
// ─── preencher dados do card) — a Sugerir resposta nunca faz isso        ─
// sozinha, porque um humano sempre revisa e mexe no card ele mesmo.

/** Campos "fixos" da aba Principal (lead-sidebar.tsx) — não vêm de
 *  FieldDefinition, por isso ficam hardcoded aqui (mesmo critério já usado
 *  em site-lead.service.ts pros campos conhecidos). */
const BUILTIN_LEAD_FIELDS: { key: string; label: string }[] = [
  { key: 'participante_1', label: 'Nome do participante 1' },
  { key: 'participante_2', label: 'Nome do participante 2' },
  { key: 'telefone_1', label: 'Telefone do participante 1' },
  { key: 'telefone_2', label: 'Telefone do participante 2' },
  { key: 'cpf_1', label: 'CPF do participante 1' },
  { key: 'cpf_2', label: 'CPF do participante 2' },
  { key: 'nascimento_1', label: 'Data de nascimento do participante 1' },
  { key: 'nascimento_2', label: 'Data de nascimento do participante 2' },
  { key: 'renda_1', label: 'Renda do participante 1' },
  { key: 'renda_2', label: 'Renda do participante 2' },
  { key: 'email_1', label: 'E-mail do participante 1' },
  { key: 'email_2', label: 'E-mail do participante 2' },
  { key: 'vinculo_1', label: 'Tipo de vínculo do participante 1 (ex.: CLT, autônomo)' },
  { key: 'vinculo_2', label: 'Tipo de vínculo do participante 2' },
];

/** Campos numéricos — passam por parseMoneyOrNumber ("R$ 100 mil" → número
 *  puro) antes de gravar. Mesmo critério de site-lead.service.ts. */
const NUMBER_FIELD_KEYS = new Set([
  'valor_avaliacao', 'valor_imovel', 'valor_credito', 'valor_entrada',
  'primeira_parcela', 'ultima_parcela', 'renda_1', 'renda_2',
  'credito_consorcio', 'parcela_consorcio', 'prazo_consorcio',
]);

/** Texto listando todos os campos que a IA pode preencher no card — os
 *  fixos da aba Principal + os que a própria conta cadastrou (Financiamento/
 *  Consórcio/abas customizadas), buscados de FieldDefinition pra sempre
 *  refletir o que a conta realmente tem hoje. */
export async function buildFillableFieldsText(accountId: string): Promise<string> {
  const defs = await prisma.fieldDefinition.findMany({ where: { accountId }, orderBy: [{ tab: 'asc' }, { order: 'asc' }] });
  const builtinText = BUILTIN_LEAD_FIELDS.map((f) => `- "${f.key}": ${f.label}`).join('\n');
  const customText = defs.map((d) => `- "${d.key}" (aba ${d.tab}): ${d.name}`).join('\n');
  return [builtinText, customText].filter(Boolean).join('\n');
}

function normalize(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

export interface AiExtractedAction {
  moveToStage?: string | null;
  extractedFields?: Record<string, string> | null;
  /** Motivo da perda, se a IA decidiu marcar o lead como Perdido — string
   *  não-vazia = marca; ausente/vazio = não mexe no status. */
  markLost?: string | null;
}

/** Aplica o que a IA de auto-resposta decidiu (opcional): mover o card pra
 *  uma das etapas permitidas, preencher campos que o cliente mencionou na
 *  conversa, e/ou marcar como Perdido (status, não etapa — mesma ação do
 *  botão "Marcar Perdido" já existente). Nunca lança erro pro chamador —
 *  cada ação é independente e fire-and-forget, igual o resto do fluxo de
 *  mensagem recebida. */
export async function applyAiExtractedActions(
  accountId: string,
  leadId: string,
  action: AiExtractedAction,
  io?: { to: (room: string) => { emit: (event: string, payload: unknown) => void } }
): Promise<void> {
  try {
    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      select: { id: true, name: true, pipelineId: true, customFields: true },
    });
    if (!lead) return;

    // Marcar como Perdido — separado de moveToStage de propósito: é o
    // STATUS do lead (Aberto/Ganho/Perdido), não a etapa do funil, e exige
    // motivo (mesma regra do botão "Marcar Perdido" na tela). Usuário
    // definiu o critério: só quando o cliente recusa EXPLICITAMENTE (ver
    // regra exata no prompt de ai-auto-reply.service.ts) — nunca por
    // silêncio (isso é "Lead Sem Retorno", abaixo).
    if (action.markLost && action.markLost.trim()) {
      const { updateLead } = require('./lead.service') as typeof import('./lead.service');
      await updateLead(lead.id, accountId, { status: 'LOST', lostReason: action.markLost.trim() });
      logActivity({
        accountId, userId: null, userName: 'Assistente IA', action: 'lead_status_changed',
        leadId: lead.id, leadName: lead.name, summary: `marcou o card como Perdido: "${action.markLost.trim()}"`,
      });
    }

    // Mover etapa — só estes valores são aceitos (usuário definiu esse
    // alcance explicitamente: nada de Fechado/Aprovado sozinha, Perdido é
    // tratado acima como status, não como etapa). Resolve o nome DENTRO do
    // funil onde o lead já está — mesmo critério de move_stage_by_name em
    // automation.service.ts.
    if (action.moveToStage) {
      const ALLOWED = ['prospeccao', 'follow up', 'lead sem retorno', 'pre-analise', 'pre analise'];
      const target = normalize(action.moveToStage);
      const isAllowed = ALLOWED.some((a) => target.includes(a) || a.includes(target));
      if (isAllowed) {
        const stages = await prisma.stage.findMany({ where: { pipelineId: lead.pipelineId } });
        const match = stages.find((s) => { const n = normalize(s.name); return n.includes(target) || target.includes(n); });
        if (match) {
          const { updateLeadStage } = require('./lead.service') as typeof import('./lead.service');
          await updateLeadStage(lead.id, accountId, match.id);
          logActivity({
            accountId, userId: null, userName: 'Assistente IA', action: 'lead_stage_changed',
            leadId: lead.id, leadName: lead.name, summary: `moveu o card pra "${match.name}", com base na conversa`,
          });
          if (io) io.to(`lead:${leadId}`).emit('lead_moved', { leadId, stageId: match.id });
        }
      }
    }

    // Preencher dados extraídos da conversa — só chaves conhecidas
    // (buildFillableFieldsText), nunca sobrescreve com vazio.
    if (action.extractedFields && Object.keys(action.extractedFields).length) {
      const patch: Record<string, string> = {};
      for (const [k, v] of Object.entries(action.extractedFields)) {
        if (v === undefined || v === null) continue;
        const raw = String(v).trim();
        if (!raw) continue;
        const parsed = NUMBER_FIELD_KEYS.has(k) ? parseMoneyOrNumber(raw) : raw;
        if (parsed !== null && parsed !== '') patch[k] = parsed;
      }
      if (Object.keys(patch).length) {
        const customFields = { ...((lead.customFields as any) || {}), ...patch };
        await prisma.lead.update({ where: { id: lead.id }, data: { customFields } });
        logActivity({
          accountId, userId: null, userName: 'Assistente IA', action: 'lead_edited',
          leadId: lead.id, leadName: lead.name, summary: `preencheu dados do card a partir da conversa (${Object.keys(patch).join(', ')})`,
        });
      }
    }
  } catch (err) {
    console.error('[AI] Erro ao aplicar ações extraídas (mover etapa/preencher campos):', err);
  }
}
