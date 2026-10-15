import { PrismaClient } from '@prisma/client';
import { downloadDriveFileForVision } from './google.service';
import { isStickerAttachment } from './received-docs.service';
import { sendOutboundWhatsApp } from './message.service';
import { roundUpTo5k } from '../lib/text';

const prisma = new PrismaClient();

/* Imóvel com FINANCIAMENTO ATIVO (alienação fiduciária/hipoteca vigente na matrícula) — Fabio 15/10, Maria Antônia:
 *  "se na proposta ela colocou que há alienação, precisa solicitar um print do saldo devedor; esse saldo devedor deverá ser somado ao valor de empréstimo que ela
 *  pediu e rodada uma análise nesses valores. Informa ao cliente."
 *  1) Na conferência de documentos, a leitura da matrícula/ônus achou gravame vigente (`gravame`) E a proposta diz "Imóvel quitado: Não" → pede o print do saldo (1 vez).
 *  2) Poller (1 min): quando o cliente manda o print, lê o saldo, soma ao crédito pedido, grava o valor novo no card e pede a análise de novo.
 *  Estado no card: customFields._saldoDevedor = { askedAt, base (crédito pedido), declared (saldo que a proposta disse), doneAt, saldo, total, scanned[] }. */

type Io = Parameters<typeof sendOutboundWhatsApp>[0]['io'] | null;

const brl = (v: number) => `R$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "R$ 88.000,00" / "88000" / "88.000" → 88000 */
export function parseBrl(raw: string | undefined | null): number {
  const t = String(raw ?? '').replace(/[^\d.,]/g, '');
  if (!t) return 0;
  const n = t.includes(',') ? Number(t.replace(/\./g, '').replace(',', '.')) : (/\.\d{3}$/.test(t) ? Number(t.replace(/\./g, '')) : Number(t));
  return Number.isFinite(n) ? n : 0;
}

/** O que a proposta preenchida diz do financiamento do imóvel (null = não achou a proposta). */
async function proposalFinancing(leadId: string): Promise<{ quitado: boolean | null; falta: number } | null> {
  const p = await prisma.message.findFirst({ where: { leadId, direction: 'INBOUND', content: { contains: 'Imóvel quitado', mode: 'insensitive' } }, orderBy: { createdAt: 'desc' }, select: { content: true } });
  if (!p?.content) return null;
  const q = p.content.match(/Im[óo]vel quitado:\s*([^\n]+)/i)?.[1]?.trim().toLowerCase() || '';
  const falta = parseBrl(p.content.match(/Valor que falta para quita[çc][ãa]o:\s*([^\n]+)/i)?.[1]);
  return { quitado: /^n[ãa]o/.test(q) ? false : /^sim/.test(q) ? true : null, falta };
}

const BRT = -3 * 3_600_000;

/** Pede o print do saldo devedor (1 vez por card) — SÓ DEPOIS da aprovação (Fabio 15/10: "não precisa pedir isso, só pede após aprovar"): o card já está em Aguardando Documentação e a proposta diz
 *  "Imóvel quitado: Não". Chamado (a) pelo poller depois que o aviso de aprovação foi entregue e (b) pela conferência de documentos. Devolve true se MANDOU a mensagem ao cliente. */
export async function maybeAskSaldoDevedor(accountId: string, leadId: string, io: Io, opts: { docsReceived?: boolean; respectHours?: boolean } = {}): Promise<boolean> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, aiAutoReplyActive: true, customFields: true, stage: { select: { name: true } } } });
  if (!lead) return false;
  const cf = (lead.customFields || {}) as Record<string, any>;
  if (cf._saldoDevedor || cf._saldoNoteAt || cf._autoPaused) return false;
  if (!/aguardando documenta/i.test(lead.stage.name.normalize('NFD').replace(/[̀-ͯ]/g, ''))) return false; // antes da aprovação não pede
  const reviews = Object.values((cf._docReview || {}) as Record<string, any>) as { gravame?: string }[];
  const gravame = reviews.map((r) => r.gravame).filter(Boolean).slice(-1)[0] || '';

  const prop = await proposalFinancing(leadId);
  if (!prop) return false;
  const base = Number(cf.valor_credito) || Number(cf._lastRunValue) || 0;
  const declared = prop.falta || 0;
  if (prop.quitado !== false) {
    // A matrícula mostra financiamento ativo mas a proposta diz quitado (ou não diz): a equipe decide — não incomoda o cliente.
    if (gravame) {
      await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...cf, _saldoNoteAt: new Date().toISOString() } as any } });
      await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `⚠️ A matrícula mostra gravame vigente (${gravame}), mas a proposta diz que o imóvel está quitado/não informa saldo. Confirme com o cliente se ainda há saldo devedor — se houver, peça o print do saldo e some ao crédito pedido.` } }).catch(() => {});
    }
    return false;
  }

  // Precisa de mensagem livre: janela de 24 h aberta (e, quando é o poller, só das 07h às 21h).
  const lastIn = await prisma.message.findFirst({ where: { leadId, direction: 'INBOUND', channel: 'WHATSAPP' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  if (!lastIn || Date.now() - lastIn.createdAt.getTime() > 23 * 3_600_000) return false;
  if (opts.respectHours) { const h = new Date(Date.now() + BRT).getUTCHours(); if (h < 7 || h >= 21) return false; }

  // Quanto o cliente PRECISA receber (líquido): se o crédito pedido é maior que o saldo que ele disse dever, o pedido já incluía a quitação (João Henrique: pediu R$ 270 mil = R$ 240 mil de saldo + R$ 30 mil) —
  // o líquido é a diferença; senão o pedido já é o líquido (Maria: pediu R$ 50 mil com R$ 88 mil de saldo). O valor novo é sempre SALDO REAL (print) + LÍQUIDO.
  const trocoCard = Number(cf.troco) || 0; // "Troco" do card (veio da proposta nova ou foi digitado): vale mais que a dedução abaixo
  const liquido = trocoCard > 0 ? trocoCard : (declared > 0 && base > declared ? Math.round((base - declared) * 100) / 100 : base);
  const nome = String(cf.participante_1 || lead.name || '').trim().split(/\s+/)[0] || '';
  const { conversationActive } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  const abertura = opts.docsReceived ? `Recebi a documentação${nome ? `, ${nome}` : ''}, obrigada! 🙏\n\n` : ((await conversationActive(leadId)) ? '' : `Oi${nome ? `, ${nome}` : ''}! `);
  const texto = `${abertura}Como o imóvel ainda tem financiamento${declared ? ` (você informou que faltam ${brl(declared)} pra quitar)` : ''}, preciso de um *print do saldo devedor atualizado* (no app ou no site do banco). Esse saldo é *somado* ao valor que você precisa receber${liquido ? ` (${brl(liquido)})` : ''} e eu refaço a análise com o total — então o valor final da operação muda. Assim que você mandar, te aviso do resultado.`;
  const marker = { askedAt: new Date().toISOString(), base, liquido, declared, gravame };
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...cf, _saldoDevedor: marker, ...(liquido > 0 ? { troco: String(liquido) } : {}) } as any } }); // "Troco" = o que sobra pro cliente depois de quitar
  const sent = lead.aiAutoReplyActive ? await sendOutboundWhatsApp({ accountId, leadId, content: texto, io: io || undefined }) : { success: false, error: 'IA desligada no card' };
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🏦 Crédito aprovado e o imóvel tem financiamento ativo (proposta: faltam ${declared ? brl(declared) : '—'}${gravame ? `; matrícula: ${gravame}` : ''}). ${sent.success ? 'Pedi ao cliente o print do saldo devedor: o saldo será somado ao valor líquido que ele precisa' + (liquido ? ` (${brl(liquido)})` : '') + ' e a análise refeita com o total.' : lead.aiAutoReplyActive ? 'O pedido ao cliente não saiu — peça o print do saldo devedor.' : 'IA desligada: peça ao cliente o print do saldo devedor (será somado ao crédito pedido e a análise refeita).'}` } }).catch(() => {});
  return !!sent.success;
}

const SALDO_PROMPT = `Este arquivo foi enviado por um cliente que precisa comprovar o SALDO DEVEDOR do financiamento do imóvel (print de app/site do banco, extrato do financiamento, boleto de quitação). Responda SOMENTE com JSON:
{"ehSaldo": <true se o arquivo mostra o saldo devedor / valor para quitação do financiamento; false se for outra coisa>, "saldo": <número em reais, ex.: 85400.37 — o SALDO DEVEDOR TOTAL ATUAL (ou valor total pra quitação hoje); NÃO a parcela, NÃO o valor financiado original; null se não aparecer>, "banco": "<banco/credor ou vazio>", "data": "<data de referência do saldo se aparecer, ou vazio>"}`;

async function readSaldo(accountId: string, att: { driveFileId: string | null; data?: Uint8Array | null; mimeType: string }): Promise<{ ehSaldo: boolean; saldo: number | null; banco: string; data: string } | undefined> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return undefined;
  const isPdf = att.mimeType === 'application/pdf';
  const isImage = /^image\/(jpeg|png|gif|webp)$/.test(att.mimeType);
  if (!isPdf && !isImage) return undefined;
  let buffer: Buffer;
  let mimeType = att.mimeType;
  try {
    if (att.data && att.data.length) buffer = Buffer.from(att.data);
    else if (att.driveFileId) ({ buffer, mimeType } = await downloadDriveFileForVision(accountId, att.driveFileId, att.mimeType));
    else return undefined;
  } catch { return undefined; }
  if (buffer.length > 10_000_000) return undefined;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-5', max_tokens: 4096,
      messages: [{ role: 'user', content: [{ type: isPdf ? 'document' : 'image', source: { type: 'base64', media_type: isPdf ? 'application/pdf' : mimeType, data: buffer.toString('base64') } }, { type: 'text', text: SALDO_PROMPT }] }],
    }),
  }).catch(() => null);
  if (!res || !res.ok) { if (res) console.error('[Saldo] Erro Anthropic:', res.status, (await res.text()).slice(0, 200)); return undefined; }
  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  try {
    const j = JSON.parse((data.content?.find((b) => b.type === 'text')?.text || '').match(/\{[\s\S]*\}/)?.[0] || '{}');
    const saldo = typeof j.saldo === 'number' ? j.saldo : parseBrl(j.saldo);
    return { ehSaldo: j.ehSaldo === true, saldo: saldo > 0 ? saldo : null, banco: String(j.banco || '').slice(0, 60), data: String(j.data || '').slice(0, 20) };
  } catch { return undefined; }
}

/** Poller (1 min): cards que esperam o print do saldo devedor — lê o que o cliente mandou, soma ao crédito pedido e refaz a análise. */
export async function processSaldoDevedor(accountId: string, io: Io): Promise<void> {
  // 1) Aprovados (condições já entregues, card em Aguardando Documentação) cujo imóvel tem financiamento pela proposta: pede o print do saldo.
  const pedir = await prisma.$queryRaw<{ id: string }[]>`
    SELECT l.id FROM "Lead" l JOIN "Stage" s ON s.id = l."stageId"
    WHERE l."accountId" = ${accountId} AND l.status = 'OPEN' AND l.archived = false AND s.name ILIKE 'Aguardando Doc%'
      AND (l."customFields"->>'_saldoDevedor') IS NULL AND (l."customFields"->>'_saldoNoteAt') IS NULL AND (l."customFields"->>'_autoNoticeAt') IS NOT NULL
      AND EXISTS (SELECT 1 FROM "Message" m WHERE m."leadId" = l.id AND m.direction = 'INBOUND' AND m.content ILIKE '%quitado: n_o%')
      AND EXISTS (SELECT 1 FROM "Message" m WHERE m."leadId" = l.id AND m.direction = 'OUTBOUND' AND m.content ILIKE '%Crédito aprovado!%')
    LIMIT 10`;
  for (const { id } of pedir) {
    try { await maybeAskSaldoDevedor(accountId, id, io, { respectHours: true }); } catch (e: any) { console.error(`[Saldo] pedido ${id}:`, e?.message || e); }
  }
  // 2) Quem já foi pedido: lê o print que chegar.
  const rows = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false AND ("customFields"->'_saldoDevedor'->>'askedAt') IS NOT NULL AND ("customFields"->'_saldoDevedor'->>'doneAt') IS NULL LIMIT 10`;
  for (const { id } of rows) {
    try { await processOne(accountId, id, io); } catch (e: any) { console.error(`[Saldo] ${id}:`, e?.message || e); }
  }
}

async function processOne(accountId: string, leadId: string, io: Io): Promise<void> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, aiAutoReplyActive: true, customFields: true } });
  if (!lead) return;
  const cf = { ...((lead.customFields || {}) as Record<string, any>) };
  const st = { ...(cf._saldoDevedor || {}) } as { askedAt: string; base: number; liquido?: number; declared: number; scanned?: string[]; doneAt?: string; warnedAt?: string };
  if (!st.askedAt || st.doneAt || cf._autoPaused) return;
  const scanned = new Set<string>(st.scanned || []);
  const atts = (await prisma.messageAttachment.findMany({
    where: { leadId, message: { direction: 'INBOUND' }, createdAt: { gt: new Date(st.askedAt), lt: new Date(Date.now() - 60_000) } },
    orderBy: { createdAt: 'asc' }, select: { id: true, driveFileId: true, data: true, mimeType: true, fileName: true },
  })).filter((a) => !/^(audio|video)\//.test(a.mimeType) && !isStickerAttachment(a) && !scanned.has(a.id));
  if (!atts.length) return;

  let achou: { saldo: number; banco: string; data: string } | null = null;
  const lidos: string[] = [];
  for (const a of atts) {
    const r = await readSaldo(accountId, a);
    if (r === undefined) continue; // não deu pra ler agora: tenta na próxima rodada
    lidos.push(a.id);
    if (r.ehSaldo && r.saldo) { achou = { saldo: r.saldo, banco: r.banco, data: r.data }; break; }
  }
  st.scanned = [...scanned, ...lidos];

  const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cf2 = { ...((fresh?.customFields || {}) as Record<string, any>) };

  if (!achou) {
    if (lidos.length && !st.warnedAt) {
      st.warnedAt = new Date().toISOString();
      await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `⚠️ O cliente mandou ${lidos.length > 1 ? 'arquivos' : 'um arquivo'} depois do pedido do saldo devedor, mas a IA não achou o saldo. Abra a conversa, veja o valor, atualize "Valor do crédito" (= saldo + ${st.liquido || st.base ? brl(st.liquido || st.base) : 'valor líquido que ele precisa'}) e peça a análise de novo.` } }).catch(() => {});
      try { const { sendPushToAccount } = require('./push.service') as typeof import('./push.service'); sendPushToAccount(accountId, { title: lead.name, body: 'Conferir o print do saldo devedor', leadId }).catch(() => {}); } catch { /* push opcional */ }
    }
    await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...cf2, _saldoDevedor: st } as any } });
    return;
  }

  const base = st.liquido || st.base || Number(cf2.valor_credito) || 0; // valor LÍQUIDO que o cliente precisa receber
  const total = roundUpTo5k(Math.round((achou.saldo + base) * 100) / 100); // saldo + troco, arredondado pra cima em múltiplos de R$ 5 mil
  st.doneAt = new Date().toISOString();
  (st as any).saldo = achou.saldo; (st as any).total = total;
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...cf2, saldo_devedor: String(achou.saldo), troco: String(base), valor_credito: String(total), _saldoDevedor: st } as any } });
  let r: { created?: number } = {};
  try {
    const { createRequests } = require('./credit-analysis.service') as typeof import('./credit-analysis.service');
    r = await createRequests(prisma as any, { accountId, leadIds: [leadId], banks: ['INTER', 'CREDITAS', 'CREDIMORAR'], dryRun: false, kind: 'RUN', force: true });
  } catch (e: any) { console.error('[Saldo] não consegui pedir a análise:', e?.message); }
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🏦 Saldo devedor lido no print: ${brl(achou.saldo)}${achou.banco ? ` (${achou.banco})` : ''}${achou.data ? `, ref. ${achou.data}` : ''}. Valor líquido que o cliente precisa ${base ? brl(base) : '—'} + saldo (${brl(achou.saldo)}) = ${brl(Math.round((achou.saldo + base) * 100) / 100)}, arredondado pra cima (múltiplo de R$ 5 mil) = ${brl(total)}: "Valor do crédito" atualizado e ${r.created ? `análise pedida de novo (${r.created} banco${r.created > 1 ? 's' : ''})` : 'análise já em andamento'}. O resultado anterior não vale pro valor novo.` } }).catch(() => {});
  if (lead.aiAutoReplyActive) {
    const nome = String(cf2.participante_1 || lead.name || '').trim().split(/\s+/)[0] || '';
    await sendOutboundWhatsApp({ accountId, leadId, content: `Recebi o saldo, ${nome ? nome : 'obrigada'}! 🙏 Saldo de ${brl(achou.saldo)}${base ? ` + ${brl(base)} que você precisa receber` : ''} → vou analisar ${brl(total)} (arredondei pra dar margem aos custos). Já refiz o pedido de análise com esse valor e te aviso o resultado por aqui.`, io: io || undefined }).catch(() => {});
  }
}
