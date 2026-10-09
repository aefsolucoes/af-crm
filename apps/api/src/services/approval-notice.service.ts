import { PrismaClient } from '@prisma/client';
import { logActivity } from './activity.service';
import { callableFirstName } from '../lib/text';

/**
 * Aviso de crédito aprovado pra quem nunca falou no WhatsApp (Fabio 09/10,
 * Clarice: preencheu a proposta pelo site, foi aprovada no Inter e a conversa
 * estava fechada — texto comum não chega). Duas partes:
 *
 * 1. processApprovalNotices (a cada 2 min): card que entrou em "Aguardando
 *    Documentação" e cujo cliente NUNCA mandou mensagem no WhatsApp recebe o
 *    template credito_aprovado_condicoes ("seu crédito foi aprovado na
 *    pré-análise. Quer saber as condições?" + [Sim, quero saber] [Não tenho
 *    interesse]). Uma vez por card, das 8h às 20h, só com o template aprovado.
 *
 * 2. maybeSendApprovalOnYes: o cliente tocou em "Sim, quero saber" → manda o
 *    texto de aprovação no formato da equipe (✅ … 📋 Resumo da proposta …),
 *    montado com as opções de aprovação que a skill do Fabio grava nas NOTAS
 *    do card (ou, sem nota, com a aba Financiamento). Nunca inventa número:
 *    todo valor tem que estar escrito no card; se faltar, avisa a equipe pra
 *    mandar à mão (a conversa já está aberta nessa hora).
 */

const prisma = new PrismaClient();

export const APPROVAL_TEMPLATE = 'credito_aprovado_condicoes';
const YES_RE = /^sim,?\s*quero saber\b/i;
const RECENT_DAYS = 3;

function brasiliaHour(): number {
  return parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hourCycle: 'h23' }).format(new Date()), 10);
}

let running = false;
let tplCheck: { at: number; approved: boolean; body: string | null } | null = null;

async function approvalTemplate(accountId: string): Promise<{ approved: boolean; body: string | null }> {
  if (tplCheck && Date.now() - tplCheck.at < 15 * 60 * 1000) return tplCheck;
  const { listMetaTemplates } = require('./whatsapp.service') as typeof import('./whatsapp.service');
  const t: any = (await listMetaTemplates(accountId).catch(() => [])).find((x: any) => x.name === APPROVAL_TEMPLATE);
  tplCheck = { at: Date.now(), approved: t?.status === 'APPROVED', body: t?.components?.find((c: any) => c.type === 'BODY')?.text || null };
  return tplCheck;
}

/** Roda a cada 2 min (index.ts). */
export async function processApprovalNotices(io: any): Promise<void> {
  if (running) return;
  running = true;
  try {
    const h = brasiliaHour();
    if (h < 8 || h >= 20) return;
    const leads = await prisma.lead.findMany({
      where: {
        status: 'OPEN', archived: false, isGroup: false,
        stageEnteredAt: { gte: new Date(Date.now() - RECENT_DAYS * 86_400_000) },
        stage: { name: { startsWith: 'Aguardando Document', mode: 'insensitive' } },
      },
      select: { id: true, accountId: true, name: true, customFields: true, contact: { select: { name: true } } },
    });
    for (const l of leads) {
      const cf = (l.customFields || {}) as Record<string, any>;
      if (cf._aprovTemplateAt) continue;
      // Cliente que já falou no WhatsApp segue pelo atendimento normal.
      const spoke = await prisma.message.count({ where: { leadId: l.id, direction: 'INBOUND', channel: 'WHATSAPP' } });
      if (spoke > 0) continue;
      const tpl = await approvalTemplate(l.accountId);
      if (!tpl.approved) return; // ainda em análise na Meta — tenta na próxima rodada
      const nome = callableFirstName(cf.participante_1, l.name, l.contact?.name) || 'cliente';
      const previewText = `${(tpl.body || '').replace(/\{\{1\}\}/g, nome)}\n\n[Sim, quero saber]  [Não tenho interesse]`;
      const { sendOutboundWhatsAppTemplate } = require('./message.service') as typeof import('./message.service');
      const r = await sendOutboundWhatsAppTemplate({ accountId: l.accountId, leadId: l.id, templateName: APPROVAL_TEMPLATE, language: 'pt_BR', bodyParams: [nome], previewText, io });
      const fresh = (await prisma.lead.findUnique({ where: { id: l.id }, select: { customFields: true } }))?.customFields as Record<string, any> || {};
      if (r.success) {
        await prisma.lead.update({ where: { id: l.id }, data: { aiAutoReplyActive: true, customFields: { ...fresh, _aprovTemplateAt: new Date().toISOString() } } });
        console.log(`[Aprovação] ${l.name}: template "${APPROVAL_TEMPLATE}" enviado (cliente nunca falou no WhatsApp)`);
      } else {
        const fails = Number(fresh._aprovTemplateFails || 0) + 1;
        await prisma.lead.update({ where: { id: l.id }, data: { customFields: { ...fresh, _aprovTemplateFails: fails, ...(fails >= 3 ? { _aprovTemplateAt: 'falhou' } : {}) } } });
        console.error(`[Aprovação] ${l.name}: falha ao enviar o template (${fails}/3): ${r.error}`);
      }
    }
  } finally {
    running = false;
  }
}

interface ApprovalOption { instituicao: string; valor: string; prazo?: string; taxa?: string; primeiraParcela?: string; ultimaParcela?: string }

/** Os dígitos de um valor ("R$ 6.289,96" → "628996") aparecem no texto de onde ele veio? */
function appearsIn(value: string | undefined, source: string): boolean {
  if (!value) return true;
  const d = value.replace(/\D/g, '');
  if (!d) return true;
  return source.replace(/\D/g, ' ').split(/\s+/).some((tok) => tok.includes(d)) || source.replace(/[^\d]/g, '').includes(d);
}

/** Lê as opções aprovadas nas notas (Claude extrai; o código confere cada número). */
async function optionsFromNotes(leadId: string): Promise<ApprovalOption[] | null> {
  const notes = await prisma.note.findMany({
    where: { leadId, createdAt: { gte: new Date(Date.now() - 45 * 86_400_000) } },
    orderBy: { createdAt: 'asc' },
    select: { content: true },
  });
  const relevant = notes.map((n) => n.content).filter((c) => /aprov/i.test(c) && /R\$\s?\d/.test(c) && !/^(Estágio:|🤖|Lead migrado|📁|Resposta automática|Movido)/.test(c));
  if (!relevant.length) return null;
  const source = relevant.join('\n\n---\n\n');
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 4096,
      system: `Você lê notas internas de um correspondente bancário sobre a análise de crédito de um cliente e extrai as opções de crédito APROVADAS (ignore bancos reprovados, em análise ou pré-qualificados). Copie os valores EXATAMENTE como estão escritos nas notas (não calcule, não arredonde, não invente). Se a nota mais recente corrigir uma anterior, vale a mais recente. Responda SÓ com JSON: {"options":[{"instituicao":"Banco Inter","valor":"R$ 400.000,00","prazo":"240 meses","taxa":"1,19% a.m. + IPCA","primeiraParcela":"R$ 6.289,96","ultimaParcela":"R$ 5.508,12"}]} — o campo "taxa" é CURTO: só a taxa principal, sem CET e sem explicação, MAS SEMPRE com o indexador quando a nota citar um (IPCA, TR etc.) — ex.: "1,19% a.m. + IPCA" ou "21,70% a.a. (≈1,65% a.m.)"; nunca omita "+ IPCA" quando a nota diz que a taxa é indexada; campo sem informação na nota: omita. Nenhuma opção aprovada: {"options":[]}.`,
      messages: [{ role: 'user', content: source.slice(0, 12000) }],
    }),
  }).catch(() => null);
  if (!res?.ok) return null;
  const data: any = await res.json().catch(() => null);
  const raw = String(data?.content?.find((b: any) => b.type === 'text')?.text || '');
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let parsed: any;
  try { parsed = JSON.parse(m[0]); } catch { return null; }
  const options: ApprovalOption[] = (parsed.options || []).filter((o: any) => o?.instituicao && o?.valor);
  // Trava contra número inventado: todo valor tem que estar escrito nas notas.
  for (const o of options) {
    for (const v of [o.valor, o.prazo, o.taxa, o.primeiraParcela, o.ultimaParcela]) {
      if (!appearsIn(v, source)) return null;
    }
  }
  return options.length ? options : null;
}

function money(v: unknown): string | undefined {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : undefined;
}

/** Sem nota de aprovação: usa a aba Financiamento do card (o que a skill preenche). */
async function optionFromCard(leadId: string): Promise<ApprovalOption[] | null> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { value: true, customFields: true } });
  const cf = (l?.customFields || {}) as Record<string, any>;
  const valor = money(cf.valor_aprovado) || money(cf.valor_credito) || money(l?.value);
  if (!cf.instituicao || !valor || !cf.primeira_parcela) return null;
  return [{
    instituicao: String(cf.instituicao),
    valor,
    prazo: cf.prazo_financ ? String(cf.prazo_financ) : undefined,
    taxa: cf.taxa_efetiva ? String(cf.taxa_efetiva) : undefined,
    primeiraParcela: money(cf.primeira_parcela),
    ultimaParcela: money(cf.ultima_parcela),
  }];
}

export function renderApprovalText(options: ApprovalOption[]): string {
  const block = (o: ApprovalOption) => [
    '📋 Resumo da proposta:',
    `🏦 Instituição: ${o.instituicao}`,
    `💰 Valor aprovado: ${o.valor}`,
    o.prazo && `📅 Prazo: ${o.prazo}`,
    o.taxa && `📈 Taxa de juros: ${o.taxa}`,
    o.primeiraParcela && `💵 1ª parcela: ${o.primeiraParcela}`,
    o.ultimaParcela && `💵 Última parcela: ${o.ultimaParcela}`,
  ].filter(Boolean).join('\n');
  const head = options.length > 1 ? `✅ Consegui ${options.length} opções de aprovação pra você escolher!` : '✅ Crédito aprovado!';
  return `${head}\n\n${options.map(block).join('\n\n')}\n\nAgora vamos para a próxima etapa do processo!`;
}

/** Texto de aprovação montado pro card (notas primeiro, aba Financiamento
 *  depois); null se faltar dado. Usado no envio e pra conferir sem enviar. */
export async function buildApprovalText(leadId: string): Promise<{ text: string; source: 'notas' | 'card' } | null> {
  // Duas tentativas nas notas antes de cair na aba Financiamento: a leitura
  // pode variar e a trava de números descarta resposta com valor que não
  // está escrito na nota.
  const fromNotes = (await optionsFromNotes(leadId).catch(() => null)) || (await optionsFromNotes(leadId).catch(() => null));
  if (fromNotes) return { text: renderApprovalText(fromNotes), source: 'notas' };
  const fromCard = await optionFromCard(leadId).catch(() => null);
  return fromCard ? { text: renderApprovalText(fromCard), source: 'card' } : null;
}

/** Cliente tocou em "Sim, quero saber" no template de aprovação. true = tratou. */
export async function maybeSendApprovalOnYes(accountId: string, leadId: string, text: string, io: any): Promise<boolean> {
  if (!YES_RE.test(text.trim())) return false;
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { id: true, name: true, userId: true } });
  if (!lead) return false;
  const built = await buildApprovalText(leadId);
  if (!built) {
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: '⚠️ O cliente tocou em "Sim, quero saber" (crédito aprovado), mas não achei as condições de aprovação nas notas nem na aba Financiamento. Mande as condições à mão — a conversa está aberta.' } }).catch(() => {});
    const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
    sendPushToAccount(accountId, { title: `${lead.name}: quer saber as condições`, body: 'Tocou em "Sim, quero saber" — mande as condições de aprovação.', leadId }).catch(() => {});
    io?.to(lead.userId ? `user_${lead.userId}` : `account_${accountId}`).emit('ai_handoff', { leadId, leadName: lead.name, reason: 'Cliente quer saber as condições da aprovação — mande à mão (não achei as condições no card).' });
    return true;
  }
  const content = built.text;
  const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
  const sent = await sendOutboundWhatsApp({ accountId, leadId, content, io });
  if (sent.success) {
    await prisma.lead.update({ where: { id: leadId }, data: { aiAutoReplyActive: true } }).catch(() => {});
    logActivity({ accountId, userId: null, userName: 'Assistente IA', action: 'ai_replied', leadId, leadName: lead.name, summary: `mandou as condições de aprovação (dados ${built.source === 'notas' ? 'das notas' : 'do card'}) — cliente tocou em "Sim, quero saber"` });
    console.log(`[Aprovação] ${lead.name}: condições enviadas (dados ${built.source === 'notas' ? 'das notas' : 'do card'})`);
  }
  return true;
}

