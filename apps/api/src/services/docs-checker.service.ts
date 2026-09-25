import { PrismaClient } from '@prisma/client';
import { getDocInfo } from './received-docs.service';
import { moveLeadToContracting } from './contracting.service';
import { sendOutboundWhatsApp } from './message.service';
import { logActivity } from './activity.service';

const prisma = new PrismaClient();

/* A IA confere se a documentação chegou completa (pedido do Fabio: a skill só
 * roda o crédito; documentação é da IA do CRM). Card em "Aguardando
 * Documentação" com a IA ligada: a cada mensagem do cliente, espera ele parar
 * de mandar arquivo, lê o que chegou (cache em customFields._docInfo, o
 * mesmo do organizador de pasta), compara com a lista de documentos certa
 * (Respostas Rápidas "Documentos ...") e, se estiver completo, leva o card pra
 * "Documentação Recebida" e avisa o cliente. Incompleto: não faz nada — a IA
 * de conversa continua atendendo normalmente. */

const CHECK_DELAY_MS = 90_000;
const pending = new Map<string, NodeJS.Timeout>();

export const DOCS_COMPLETE_MESSAGE = 'Recebi toda a documentação, obrigada! Já vou seguir com a análise. Se o banco achar necessário, pode pedir algum documento a mais, aí te aviso por aqui.';

function norm(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

type Io = Parameters<typeof moveLeadToContracting>[2];

export async function scheduleDocsCheck(accountId: string, leadId: string, io: Io): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { aiAutoReplyActive: true, stage: { select: { name: true } } } });
  if (!lead?.aiAutoReplyActive || !norm(lead.stage.name).includes('aguardando documentacao')) return;
  const previous = pending.get(leadId);
  if (previous) clearTimeout(previous);
  pending.set(leadId, setTimeout(() => {
    pending.delete(leadId);
    checkDocsComplete(accountId, leadId, io).catch((err) => console.error(`[Docs] Falha ao conferir documentação do lead ${leadId}:`, err?.message || err));
  }, CHECK_DELAY_MS));
}

const RULES = `Você confere se um cliente de crédito imobiliário já mandou TODA a documentação pedida. Responda SOMENTE com JSON:
{"complete": <true ou false>, "listaUsada": "<nome da lista>", "faltando": ["<item que falta>", ...]}

Como decidir:
0. Se a CONVERSA já tem uma lista de documentos enviada pela equipe pra esse cliente, ELA é a referência (vale mais que as listas abaixo).
1. Senão, escolha a lista certa entre as listas abaixo: Home Equity pessoa física → "Documentos Home Equity"; crédito no nome de empresa (PJ) → "Documentos comprador PJ"; Financiamento Habitacional → a lista do perfil de renda (empresário/autônomo/profissional liberal → empresário; assalariado/CLT → setor privado; servidor público → servidor público).
2. Documentos pessoais e de renda valem pra CADA participante listado.
3. Itens marcados "se usar" ou "se houver" não são obrigatórios.
4. RG ou CNH servem como documento de identificação; certidão de nascimento ou de casamento servem como comprovante de estado civil.
5. Cônjuges/companheiros: um comprovante de residência e uma certidão de casamento servem para os dois (moram juntos), a não ser que a conversa diga que moram em endereços diferentes.
6. Se o cliente disse na conversa que algo não se aplica a ele, considere.
7. Seja rigoroso: "complete": true só se tiver certeza de que todos os itens obrigatórios chegaram. Se houver arquivos que não puderam ser lidos e algum item obrigatório puder estar entre eles, responda false.`;

/** Só avalia (não move nem manda nada). null = nada pra avaliar. */
export async function evaluateDocs(accountId: string, leadId: string): Promise<{ leadName: string; complete: boolean; listaUsada?: string; faltando: string[]; receivedText: string } | null> {
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, accountId },
    include: { stage: true, pipeline: { include: { department: true } } },
  });
  if (!lead) return null;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const atts = (await prisma.messageAttachment.findMany({
    where: { leadId, message: { direction: 'INBOUND' } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, driveFileId: true, data: true, mimeType: true, fileName: true },
  })).filter((a) => !/^(audio|video)\//.test(a.mimeType));
  if (!atts.length) return null;

  const info = await getDocInfo(accountId, leadId, atts);
  const received = atts.map((a) => info[a.id]).filter((d): d is NonNullable<typeof d> => !!d);
  if (!received.length) return null;
  const counts: Record<string, number> = {};
  for (const d of received) {
    const k = d.holder ? `${d.type} — de ${d.holder}` : d.type;
    counts[k] = (counts[k] || 0) + 1;
  }
  const receivedText = Object.entries(counts).map(([t, n]) => (n > 1 ? `${t} (${n} arquivos)` : t)).join('\n');
  const unread = atts.filter((a) => info[a.id] === undefined).map((a) => a.fileName);

  const lists = await prisma.messageTemplate.findMany({
    where: {
      accountId,
      name: { startsWith: 'Documentos', mode: 'insensitive' },
      OR: [{ departmentId: lead.pipeline.departmentId }, { departmentId: null }],
    },
    select: { name: true, body: true },
  });
  if (!lists.length) return null;

  const cf = (lead.customFields || {}) as Record<string, string>;
  const participants = [
    cf.participante_1 && `1) ${cf.participante_1}${cf.vinculo_1 ? ` — ${cf.vinculo_1}` : ''}`,
    cf.participante_2 && `2) ${cf.participante_2}${cf.vinculo_2 ? ` — ${cf.vinculo_2}` : ''}`,
  ].filter(Boolean).join('\n') || `1) ${lead.name}`;
  const history = (await prisma.message.findMany({
    where: { leadId, callWaCallId: null }, orderBy: { createdAt: 'desc' }, take: 25, select: { content: true, direction: true },
  })).reverse().map((m) => `${m.direction === 'INBOUND' ? 'Cliente' : 'Atendente'}: ${(m.content || '').replace(/\s+/g, ' ').slice(0, 200)}`).join('\n');

  const prompt = `Setor/produto: ${lead.pipeline.department?.name || '?'}
Participantes:
${participants}

LISTAS DE DOCUMENTOS:
${lists.map((l) => `--- ${l.name} ---\n${l.body}`).join('\n\n')}

DOCUMENTOS RECEBIDOS (lidos dos arquivos que o cliente mandou; "de FULANO" = titular do documento):
${receivedText}
${unread.length ? `\nArquivos que não puderam ser lidos: ${unread.length}` : ''}

CONVERSA RECENTE:
${history}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 4000, system: RULES, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) {
    console.error('[Docs] Erro Anthropic:', res.status, (await res.text()).slice(0, 200));
    return null;
  }
  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  const raw = data.content?.find((b) => b.type === 'text')?.text || '';
  let verdict: { complete?: boolean; listaUsada?: string; faltando?: string[] } = {};
  try { verdict = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{}'); } catch { return null; }
  return { leadName: lead.name, complete: verdict.complete === true, listaUsada: verdict.listaUsada, faltando: verdict.faltando || [], receivedText };
}

async function checkDocsComplete(accountId: string, leadId: string, io: Io): Promise<void> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, aiAutoReplyActive: true, stage: { select: { name: true } } } });
  if (!lead || !lead.aiAutoReplyActive || !norm(lead.stage.name).includes('aguardando documentacao')) return;

  const verdict = await evaluateDocs(accountId, leadId);
  if (!verdict) return;
  const { receivedText } = verdict;
  if (!verdict.complete) {
    console.log(`[Docs] ${lead.name} (${leadId}): ainda falta — ${verdict.faltando.join('; ') || 'sem detalhe'}`);
    return;
  }

  const moved = await moveLeadToContracting(accountId, leadId, io, 'a IA conferiu que a documentação chegou completa');
  if (!moved) {
    console.warn(`[Docs] ${lead.name} (${leadId}): documentação completa, mas o funil de contratação do setor não foi encontrado`);
    return;
  }
  const sent = await sendOutboundWhatsApp({ accountId, leadId, content: DOCS_COMPLETE_MESSAGE, io: io || undefined });
  if (!sent.success) console.error(`[Docs] ${lead.name}: aviso ao cliente não foi enviado:`, sent.error);

  await prisma.note.create({
    data: {
      leadId,
      type: 'COMMENT',
      content: [
        `🤖 A IA conferiu a documentação (lista "${verdict.listaUsada || '?'}") e considerou completa:`,
        receivedText,
        '',
        `Card movido para "${moved.pipelineName}" (${moved.stageName}).${sent.success ? ' Cliente avisado de que o banco pode pedir algum documento a mais.' : ''}`,
      ].join('\n'),
    },
  });
  logActivity({
    accountId, userId: null, userName: 'Assistente IA', action: 'lead_stage_changed', leadId, leadName: lead.name,
    summary: `conferiu a documentação completa e moveu pra "${moved.stageName}" (${moved.pipelineName})`,
  });
  console.log(`[Docs] ${lead.name} (${leadId}): documentação completa → ${moved.pipelineName} / ${moved.stageName}`);
}
