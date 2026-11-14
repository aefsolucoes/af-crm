import { PrismaClient } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { downloadDriveFileForVision } from './google.service';
import { isStickerAttachment, isDescritivoParcela } from './received-docs.service';
import { sendOutboundWhatsApp } from './message.service';
import { roundUpToThousand } from '../lib/text';


/* Imóvel com FINANCIAMENTO ATIVO (alienação fiduciária/hipoteca vigente na matrícula) — Fabio 15/10, Maria Antônia:
 *  "se na proposta ela colocou que há alienação, precisa solicitar um print do saldo devedor; esse saldo devedor deverá ser somado ao valor de empréstimo que ela
 *  pediu e rodada uma análise nesses valores. Informa ao cliente."
 *  1) Na conferência de documentos, a leitura da matrícula/ônus achou gravame vigente (`gravame`) E a proposta diz "Imóvel quitado: Não" → pede o print do saldo (1 vez).
 *  2) Poller (1 min): quando o cliente manda o print, lê o saldo, soma ao crédito pedido, grava o valor novo no card e pede a análise de novo.
 *  Estado no card: customFields._saldoDevedor = { askedAt, base (crédito pedido), declared (saldo que a proposta disse), doneAt, saldo, total, scanned[] }.
 *
 *  REGRA NOVA (Fabio 13/11, Fabricio Ferreira — o CRM disse que "o saldo é somado ao troco e eu refaço a análise"): "quando tem saldo devedor o CRM apenas subtrai o valor aprovado sobre o
 *  valor do saldo devedor para obter o troco do cliente e repassar para ele esse valor de troco e alterar o valor no card." Depois da aprovação: TROCO = APROVADO − SALDO, sem refazer a
 *  análise, sem somar e sem perguntar se o troco está correto; o print do saldo e o descritivo da parcela continuam sendo pedidos (o banco exige); "Valor do crédito" fica o aprovado.
 *  Saldo do print MAIOR que o aprovado: avisa o cliente que com esse saldo não dá pra seguir e marca o card como Perdido. */

type Io = Parameters<typeof sendOutboundWhatsApp>[0]['io'] | null;

const brl = (v: number) => `R$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Grava SÓ estas chaves do customFields, por SQL (corrida no customFields: nunca regravar o card inteiro). */
async function setCfKeys(leadId: string, keys: Record<string, unknown>): Promise<void> {
  for (const [k, v] of Object.entries(keys)) {
    await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), ARRAY[${k}]::text[], ${JSON.stringify(v)}::jsonb, true) WHERE id = ${leadId}`;
  }
}

/** "R$ 88.000,00" / "88000" / "88.000" → 88000 */
export function parseBrl(raw: string | undefined | null): number {
  const t = String(raw ?? '').replace(/[^\d.,]/g, '');
  if (!t) return 0;
  const n = t.includes(',') ? Number(t.replace(/\./g, '').replace(',', '.')) : (/\.\d{3}$/.test(t) ? Number(t.replace(/\./g, '')) : Number(t));
  return Number.isFinite(n) ? n : 0;
}

/** O que a proposta preenchida diz do financiamento do imóvel (null = não achou a proposta). */
export async function proposalFinancing(leadId: string): Promise<{ quitado: boolean | null; falta: number } | null> {
  const p = await prisma.message.findFirst({ where: { leadId, direction: 'INBOUND', content: { contains: 'Imóvel quitado', mode: 'insensitive' } }, orderBy: { createdAt: 'desc' }, select: { content: true } });
  if (!p?.content) return null;
  const q = p.content.match(/Im[óo]vel quitado:\s*([^\n]+)/i)?.[1]?.trim().toLowerCase() || '';
  const falta = parseBrl(p.content.match(/Valor que falta para quita[çc][ãa]o:\s*([^\n]+)/i)?.[1]);
  return { quitado: /^n[ãa]o/.test(q) ? false : /^sim/.test(q) ? true : null, falta };
}

/** SALDO REAL ACIMA DO LIMITE (Fabio 05/11, Fernanda Karita: declarou R$ 100 mil de saldo, o print mostrou R$ 139,4 mil num imóvel de R$ 200 mil — passa dos 60% — e o Inter
 *  aprovou a menor R$ 110 mil, que nem quitava; a IA estava desligada e ninguém avisou a cliente). O crédito primeiro QUITA o financiamento e o banco libera no máximo 60% do
 *  valor do imóvel: saldo acima disso, ou acima do valor APROVADO (Fabio 13/11: vale pra qualquer aprovação, não só a menor — o troco é aprovado − saldo e não se refaz a análise), não
 *  tem como seguir com este imóvel. Pura (testável). null = dá pra seguir. */
export function saldoBloqueia(saldo: number, valorImovel: number, aprovado: number | null): { motivo: 'LIMITE_60' | 'APROVADO_NAO_COBRE'; limite: number } | null {
  if (!(saldo > 0)) return null;
  const limite = valorImovel > 0 ? Math.round(valorImovel * 0.6 * 100) / 100 : 0;
  if (limite > 0 && saldo > limite) return { motivo: 'LIMITE_60', limite };
  if (aprovado && aprovado > 0 && saldo > aprovado) return { motivo: 'APROVADO_NAO_COBRE', limite };
  return null;
}

/** Troco do cliente (Fabio 13/11): valor APROVADO − saldo devedor, em centavos. Pura (testável). */
export function trocoDoAprovado(aprovado: number, saldo: number): number {
  return Math.round((aprovado - saldo) * 100) / 100;
}

/** O aviso ao cliente (gentil, com a conta). Pura (testável). */
export function mensagemSaldoBloqueado(nome: string, saldo: number, valorImovel: number, b: { motivo: 'LIMITE_60' | 'APROVADO_NAO_COBRE'; limite: number }, aprovado: number | null, aMenor = false): string {
  const oi = `Recebi o saldo${nome ? `, ${nome}` : ''}! 🙏 Conferi aqui: o saldo pra quitar o financiamento é de ${brl(saldo)}.`;
  const porque = b.motivo === 'LIMITE_60'
    ? ` No crédito com garantia de imóvel, o banco libera no máximo 60% do valor do imóvel — no seu caso, até ${brl(b.limite)} (imóvel de ${brl(valorImovel)}). Como o crédito precisa primeiro quitar o financiamento e o saldo já passa desse limite, infelizmente com esse imóvel não é possível seguir agora.`
    : ` O valor aprovado foi de ${brl(aprovado || 0)}, que não chega a quitar o financiamento (faltariam ${brl(saldo - (aprovado || 0))})${aMenor ? ', e o banco não aprova um valor maior' : ''} — então, infelizmente, com esse saldo não é possível seguir.`;
  return `${oi}${porque} Se você tiver outro imóvel pra colocar em garantia, me avisa que eu vejo por ele.`;
}

/** Grava o bloqueio, avisa o cliente (só com `podeMandar`, IA ligada e janela aberta) e deixa nota + push pro responsável do card. */
async function avisarSaldoBloqueado(accountId: string, leadId: string, p: { saldo: number; valorImovel: number; aprovado: number | null; aMenor?: boolean; bloq: NonNullable<ReturnType<typeof saldoBloqueia>>; podeMandar: boolean; io: Io }): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, userId: true, aiAutoReplyActive: true, customFields: true, status: true, pipeline: { select: { departmentId: true } } } });
  if (!lead) return;
  const cf = (lead.customFields || {}) as Record<string, any>;
  const nome = String(cf.falando_com || cf.nome_social_1 || cf.participante_1 || lead.name || '').trim().split(/\s+/)[0] || '';
  const texto = mensagemSaldoBloqueado(nome.charAt(0).toUpperCase() + nome.slice(1).toLowerCase(), p.saldo, p.valorImovel, p.bloq, p.aprovado, !!p.aMenor);
  let enviado = false;
  let porQueNao = 'IA desligada neste card';
  if (p.podeMandar && lead.aiAutoReplyActive && !cf._autoPaused) {
    const lastIn = await prisma.message.findFirst({ where: { leadId, direction: 'INBOUND' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    if (lastIn && Date.now() - lastIn.createdAt.getTime() < 23 * 3_600_000) {
      const r = await sendOutboundWhatsApp({ accountId, leadId, content: texto, io: p.io || undefined });
      enviado = r.success;
      if (!r.success) porQueNao = `o envio falhou: ${(r as any).error || 'erro'}`;
    } else porQueNao = 'janela de 24 h fechada';
  } else if (!p.podeMandar) porQueNao = 'o saldo foi lido antes desta regra';
  else if (cf._autoPaused) porQueNao = 'card pausado';
  const bloqueio = { motivo: p.bloq.motivo, limite: p.bloq.limite, saldo: p.saldo, valorImovel: p.valorImovel, aprovado: p.aprovado, aMenor: !!p.aMenor, em: new Date().toISOString(), avisado: enviado };
  // Saldo MAIOR que o aprovado (Fabio 13/11: "diz ao cliente que com esse saldo não dá pra seguir… marca como perdido pois não tem como seguir"): avisado o cliente, o card vai pra Perdidos.
  // Sem aviso (IA desligada/janela fechada) quem fala com o cliente é a equipe — a nota pede pra avisar e marcar Perdido.
  const naoCobre = !!p.aprovado && p.aprovado > 0 && p.saldo > p.aprovado;
  if (!enviado && !lead.aiAutoReplyActive) await (require('./ia-pendencias.service') as typeof import('./ia-pendencias.service')).guardarPendenciaIa(leadId, 'saldoBloqueio', `avisar com jeito que com esse saldo não dá pra seguir — "${texto}"`);
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_saldoDevedor,bloqueio}', ${JSON.stringify(bloqueio)}::jsonb, true) WHERE id = ${leadId}`;
  const conta = p.bloq.motivo === 'LIMITE_60' ? `${brl(p.saldo)} passa de 60% do imóvel (${brl(p.valorImovel)} → limite ${brl(p.bloq.limite)})` : `${brl(p.saldo)} é maior que o aprovado${p.aMenor ? ' a menor' : ''} (${brl(p.aprovado || 0)})`;
  let perdido = false;
  if (enviado && naoCobre && lead.status === 'OPEN') {
    const lostReason = 'Saldo devedor do financiamento maior que o valor aprovado';
    try {
      const { updateLead } = require('./lead.service') as typeof import('./lead.service');
      const { moveLeadToPerdidos } = require('./named-pipeline.service') as typeof import('./named-pipeline.service');
      await updateLead(leadId, accountId, { status: 'LOST', lostReason } as any, p.io as any);
      await moveLeadToPerdidos({ accountId, leadId, departmentId: lead.pipeline?.departmentId, byName: 'Assistente IA', userId: null, motivo: lostReason, io: p.io as any });
      perdido = true;
    } catch (e: any) { console.error('[Saldo] não consegui marcar Perdido:', e?.message || e); }
  }
  const fim = perdido ? ' Card marcado como Perdido.' : naoCobre ? ' Depois de avisar, marque o card como Perdido.' : '';
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🚫 Saldo devedor acima do limite: ${conta}. Com este imóvel não dá pra seguir — a cobrança de documentos parou. ${enviado ? `Cliente avisado: "${texto}"` : `Cliente NÃO avisado (${porQueNao}). Mande: "${texto}"`}${fim}` } }).catch(() => {});
  try { const { sendPushToAccount } = require('./push.service') as typeof import('./push.service'); sendPushToAccount(accountId, { title: `🚫 ${lead.name}`.slice(0, 90), body: `Saldo devedor acima do limite — não dá pra seguir${enviado ? ` (cliente avisado${perdido ? ', card Perdido' : ''})` : '. Avise o cliente'}`, leadId }, [lead.userId]).catch(() => {}); } catch { /* push opcional */ }
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
      await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_saldoNoteAt}', ${JSON.stringify(new Date().toISOString())}::jsonb, true) WHERE id = ${leadId}`;
      await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `⚠️ A matrícula mostra gravame vigente (${gravame}), mas a proposta diz que o imóvel está quitado/não informa saldo. Confirme com o cliente se ainda há saldo devedor — se houver, peça o print do saldo e some ao crédito pedido.` } }).catch(() => {});
    }
    return false;
  }

  // Aprovação A MENOR (Fabio 26/10): o banco não aprova mais, então o saldo devedor é só informativo — não peço o print nem refaço a análise; o aviso de aprovação já traz quitação e troco (valor aprovado − saldo informado).
  const am = await (require('./approval-notice.service') as typeof import('./approval-notice.service')).aprovacaoAMenor(leadId);
  if (am.aMenor) {
    await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_saldoNoteAt}', ${JSON.stringify(new Date().toISOString())}::jsonb, true) WHERE id = ${leadId}`;
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `ℹ️ Aprovação A MENOR (${brl(am.valor)}): o banco não aprova mais, então o saldo devedor (${declared ? brl(declared) : 'informado na proposta'}) é só informativo — não pedi o print nem refiz a análise. O aviso de aprovação já mostra a quitação e o troco calculados (valor aprovado − saldo).` } }).catch(() => {});
    return false;
  }

  // Precisa de mensagem livre: janela de 24 h aberta (e, quando é o poller, só das 07h às 21h).
  const lastIn = await prisma.message.findFirst({ where: { leadId, direction: 'INBOUND', channel: 'WHATSAPP' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  if (!lastIn || Date.now() - lastIn.createdAt.getTime() > 23 * 3_600_000) return false;
  if (opts.respectHours) { const h = new Date(Date.now() + BRT).getUTCHours(); if (h < 7 || h >= 21) return false; }

  // TROCO = APROVADO − SALDO (Fabio 13/11): nada de somar o saldo, refazer a análise ou perguntar se o troco está certo — o print só confirma o saldo (e o banco exige o print e o descritivo).
  const aprovado = (await (require('./approval-notice.service') as typeof import('./approval-notice.service')).valorAprovadoParaTroco(leadId)).valor;
  const troco = aprovado > 0 && declared > 0 && aprovado > declared ? trocoDoAprovado(aprovado, declared) : 0;
  const nome = String(cf.participante_1 || lead.name || '').trim().split(/\s+/)[0] || '';
  const { conversationActive } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  const abertura = opts.docsReceived ? `Recebi a documentação${nome ? `, ${nome}` : ''}, obrigada! 🙏\n\n` : ((await conversationActive(leadId)) ? '' : `Oi${nome ? `, ${nome}` : ''}! `);
  // Fabio 30/10: além do print do saldo, o banco pede o DESCRITIVO DA PARCELA — o PDF com as últimas prestações que o próprio app do banco do financiamento gera.
  const texto = `${abertura}Como o imóvel ainda tem financiamento${declared ? ` (você informou que faltam ${brl(declared)} pra quitar)` : ''}, preciso de dois documentos do banco do financiamento:\n• um *print do saldo devedor atualizado* (no app ou no site do banco);\n• o *descritivo da parcela* em PDF — o extrato das prestações, que o próprio app do banco gera.\n\n${troco > 0 ? `O valor aprovado quita o financiamento e o que sobra é o seu troco: pelo saldo que você informou, ${brl(troco)}. Com o print eu confirmo o valor certinho.` : 'Com o print eu confiro o saldo e te aviso como fica o seu troco.'}`;
  const marker = { askedAt: new Date().toISOString(), base, liquido: troco || undefined, aprovado: aprovado || undefined, declared, gravame };
  // Só as chaves (corrida no customFields): o marcador e o "Troco" (= o que sobra pro cliente depois de quitar).
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_saldoDevedor}', ${JSON.stringify(marker)}::jsonb, true) WHERE id = ${leadId}`;
  if (troco > 0) await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set("customFields", '{troco}', ${JSON.stringify(String(troco))}::jsonb, true) WHERE id = ${leadId}`;
  const sent = lead.aiAutoReplyActive ? await sendOutboundWhatsApp({ accountId, leadId, content: texto, io: io || undefined }) : { success: false, error: 'IA desligada no card' };
  if (!lead.aiAutoReplyActive) await (require('./ia-pendencias.service') as typeof import('./ia-pendencias.service')).guardarPendenciaIa(leadId, 'saldoDevedorPedido', `pedir o print do saldo devedor e o descritivo da parcela — "${texto}"`);
  const conta = troco > 0 ? ` Troco = aprovado ${brl(aprovado)} − saldo informado ${brl(declared)} = ${brl(troco)} (gravado no card; a análise NÃO é refeita).` : aprovado > 0 ? ` O saldo informado não deixa troco com o aprovado de ${brl(aprovado)}: confiro quando o print chegar.` : ' Não achei o valor aprovado pra calcular o troco.';
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🏦 Crédito aprovado e o imóvel tem financiamento ativo (proposta: faltam ${declared ? brl(declared) : '—'}${gravame ? `; matrícula: ${gravame}` : ''}). ${sent.success ? 'Pedi ao cliente o print do saldo devedor e o descritivo da parcela (PDF do app do banco).' : lead.aiAutoReplyActive ? 'O pedido ao cliente não saiu — peça o print do saldo devedor e o descritivo da parcela.' : 'IA desligada: peça ao cliente o print do saldo devedor e o descritivo da parcela.'}${conta}` } }).catch(() => {});
  return !!sent.success;
}

const SALDO_PROMPT = `Este arquivo foi enviado por um cliente que precisa comprovar o SALDO DEVEDOR do financiamento do imóvel (print de app/site do banco, extrato do financiamento, boleto de quitação). Responda SOMENTE com JSON:
{"ehSaldo": <true se o arquivo mostra o saldo devedor / valor para quitação do financiamento; false se for outra coisa>, "saldo": <número em reais, ex.: 85400.37 — o SALDO DEVEDOR TOTAL ATUAL (ou valor total pra quitação hoje); NÃO a parcela, NÃO o valor financiado original, NÃO saldo de FGTS nem "diferença de pagamento" (o DESCRITIVO DA PARCELA — lista das prestações pagas — só vale aqui se mostrar escrito o saldo devedor do contrato); null se não aparecer>, "banco": "<banco/credor ou vazio>", "data": "<data de referência do saldo se aparecer, ou vazio>"}`;

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
  // 1b) Print pedido NA CONVERSA (IA ou equipe), não por este fluxo (Fabio 27/10, Fernanda Karita: a IA pediu o print do saldo, a cliente mandou o do app e ninguém leu — a conferência
  // ainda cobrou de novo). Marca o pedido a partir dessa mensagem; o leitor abaixo pega os arquivos que chegaram depois.
  const naConversa = await prisma.$queryRaw<{ id: string; at: Date }[]>`
    SELECT l.id, max(m."createdAt") AS at FROM "Lead" l JOIN "Stage" s ON s.id = l."stageId" JOIN "Message" m ON m."leadId" = l.id
    WHERE l."accountId" = ${accountId} AND l.status = 'OPEN' AND l.archived = false AND s.name ILIKE 'Aguardando Doc%'
      AND (l."customFields"->>'_saldoDevedor') IS NULL AND coalesce(l."customFields"->>'_autoPaused', '') = ''
      AND m.direction = 'OUTBOUND' AND m.content ILIKE '%saldo devedor%' AND (m.content ILIKE '%print%' OR m.content ILIKE '%tela%') AND m."createdAt" > now() - interval '3 days'
    GROUP BY l.id LIMIT 10`;
  for (const c of naConversa) {
    try {
      const chegou = await prisma.messageAttachment.count({ where: { leadId: c.id, message: { direction: 'INBOUND' }, createdAt: { gt: c.at } } });
      if (!chegou) continue;
      const f = await prisma.lead.findUnique({ where: { id: c.id }, select: { customFields: true } });
      const cff = { ...((f?.customFields || {}) as Record<string, any>) };
      if (cff._saldoDevedor) continue;
      const prop = await proposalFinancing(c.id).catch(() => null);
      cff._saldoDevedor = { askedAt: new Date(c.at).toISOString(), base: Number(cff.valor_credito) || Number(cff._lastRunValue) || 0, liquido: Number(cff.troco) || undefined, declared: prop?.falta || 0, viaConversa: true };
      await prisma.lead.update({ where: { id: c.id }, data: { customFields: cff as any } });
      await prisma.note.create({ data: { leadId: c.id, type: 'COMMENT', content: '🏦 O print do saldo devedor foi pedido na conversa e o cliente mandou arquivo depois: a IA vai ler o saldo nesses arquivos.' } }).catch(() => {});
    } catch (e: any) { console.error(`[Saldo] pedido na conversa ${c.id}:`, e?.message || e); }
  }
  // 1c) Saldo lido ANTES da regra do limite (Fabio 05/11, Fernanda Karita): confere 1x. Aqui NUNCA manda nada ao cliente sozinho (o print chegou há dias) — nota + push com a mensagem pronta.
  const semLimite = await prisma.$queryRaw<{ id: string; saldo: string; valor_imovel: string | null }[]>`SELECT id, "customFields"->'_saldoDevedor'->>'saldo' AS saldo, "customFields"->>'valor_imovel' AS valor_imovel FROM "Lead" WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false AND ("customFields"->'_saldoDevedor'->>'saldo') IS NOT NULL AND ("customFields"->'_saldoDevedor'->>'limiteVisto') IS NULL LIMIT 10`;
  for (const c of semLimite) {
    try {
      await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set("customFields", '{_saldoDevedor,limiteVisto}', 'true'::jsonb, true) WHERE id = ${c.id}`;
      const am = await (require('./approval-notice.service') as typeof import('./approval-notice.service')).valorAprovadoParaTroco(c.id);
      const saldo = Number(c.saldo) || 0, valorImovel = parseBrl(c.valor_imovel);
      const bloq = saldoBloqueia(saldo, valorImovel, am.valor || null);
      if (bloq) await avisarSaldoBloqueado(accountId, c.id, { saldo, valorImovel, aprovado: am.valor || null, aMenor: am.aMenor, bloq, podeMandar: false, io });
    } catch (e: any) { console.error(`[Saldo] limite ${c.id}:`, e?.message || e); }
  }
  // 1d) Bloqueio revisto (Fabio 05/11, Fernanda Karita: o imóvel passou de R$ 200 mil pra R$ 300 mil e o card continuava "não dá pra seguir"): com o valor do imóvel ou a
  // aprovação de agora o saldo cabe → tira o bloqueio (a cobrança de documentos e a IA voltam ao normal) e avisa a equipe.
  const bloqueados = await prisma.$queryRaw<{ id: string; saldo: string; valor_imovel: string | null }[]>`SELECT id, "customFields"->'_saldoDevedor'->'bloqueio'->>'saldo' AS saldo, "customFields"->>'valor_imovel' AS valor_imovel FROM "Lead" WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false AND ("customFields"->'_saldoDevedor'->'bloqueio') IS NOT NULL LIMIT 20`;
  for (const c of bloqueados) {
    try {
      const am = await (require('./approval-notice.service') as typeof import('./approval-notice.service')).valorAprovadoParaTroco(c.id);
      const saldo = Number(c.saldo) || 0, valorImovel = parseBrl(c.valor_imovel);
      if (saldoBloqueia(saldo, valorImovel, am.valor || null)) continue;
      await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = "customFields" #- '{_saldoDevedor,bloqueio}' WHERE id = ${c.id}`;
      await prisma.note.create({ data: { leadId: c.id, type: 'COMMENT', content: `🔓 Saldo devedor voltou a caber: ${brl(saldo)}${valorImovel ? ` com o imóvel de ${brl(valorImovel)} (limite de 60% = ${brl(Math.round(valorImovel * 0.6 * 100) / 100)})` : ''}${am.valor ? ` e o aprovado de ${brl(am.valor)}` : ''}. O bloqueio saiu: a cobrança de documentos e a IA voltam ao normal.` } }).catch(() => {});
    } catch (e: any) { console.error(`[Saldo] rever bloqueio ${c.id}:`, e?.message || e); }
  }
  // 2) Quem já foi pedido: lê o print que chegar.
  const rows = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false AND ("customFields"->'_saldoDevedor'->>'askedAt') IS NOT NULL AND ("customFields"->'_saldoDevedor'->>'doneAt') IS NULL LIMIT 10`;
  for (const { id } of rows) {
    try { await processOne(accountId, id, io); } catch (e: any) { console.error(`[Saldo] ${id}:`, e?.message || e); }
  }
}

/** Crédito a analisar quando o TROCO muda (Fabio 21/10): saldo + troco. Antes do print o saldo é o que a proposta declarou e o crédito é a soma redonda no milhar (a proposta já traz o total, sem folga: 240 mil + 30 mil = 270 mil);
 *  depois do print vale a regra de sempre (saldo real + troco + folga, milhar inteiro). Pura (testável). */
export function creditoComTroco(saldo: number, troco: number, jaLeuPrint: boolean): number {
  const bruto = Math.round((saldo + troco) * 100) / 100;
  return jaLeuPrint ? roundUpToThousand(bruto) : Math.ceil(bruto / 1000) * 1000;
}

/** O cliente CORRIGIU o troco na conversa (a IA gravou `troco` no card). ANTES da aprovação: ajusta o valor do crédito (saldo + troco) e, se a análise já rodou com o valor antigo, refaz
 *  nos bancos. DEPOIS da aprovação (Fabio 13/11): o troco é sempre aprovado − saldo — volta o card pra essa conta, não refaz nada e avisa a equipe (mais troco = nova proposta, a equipe decide). */
export async function aplicarTrocoCorrigido(accountId: string, leadId: string, novoTroco: number, io: Io): Promise<void> {
  if (!(novoTroco > 0)) return;
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { id: true, name: true, customFields: true } });
  if (!lead) return;
  const cf = { ...((lead.customFields || {}) as Record<string, any>) };
  if (cf._autoPaused) return;
  const st = cf._saldoDevedor as (Record<string, any> | undefined);
  const saldo = Number(st?.saldo) || Number(cf.saldo_devedor) || 0;
  const trocoAntes = Number(st?.liquido) || 0;
  // Já APROVADO (Fabio 13/11): o troco é aprovado − saldo — não refaz a análise nem mexe no "Valor do crédito"; o card volta pro troco da conta.
  const amT = await (require('./approval-notice.service') as typeof import('./approval-notice.service')).valorAprovadoParaTroco(leadId);
  if (amT.valor > 0) {
    const trocoCerto = saldo > 0 ? trocoDoAprovado(amT.valor, saldo) : 0;
    if (trocoCerto > 0 && Math.abs(trocoCerto - novoTroco) >= 0.01) await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set("customFields", '{troco}', ${JSON.stringify(String(trocoCerto))}::jsonb, true) WHERE id = ${leadId}`;
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `💸 O cliente disse que precisa de ${brl(novoTroco)} de troco. Com o crédito já aprovado, o troco é o aprovado − saldo${saldo > 0 ? `: ${brl(amT.valor)} − ${brl(saldo)} = ${brl(trocoCerto)} (é o que fica no card)` : ' (o card ainda não tem o saldo devedor)'}. Não refiz a análise nem mudei o "Valor do crédito"${amT.aMenor ? ' — a aprovação é a menor e o banco não aprova mais' : ''}. Mais troco seria uma nova proposta: a equipe decide.` } }).catch(() => {});
    try { const { sendPushToAccount } = require('./push.service') as typeof import('./push.service'); sendPushToAccount(accountId, { title: `💸 ${lead.name}`.slice(0, 90), body: `Cliente quer ${brl(novoTroco)} de troco — o aprovado dá ${trocoCerto > 0 ? brl(trocoCerto) : 'outro valor'}. A equipe decide.`, leadId }).catch(() => {}); } catch { /* push opcional */ }
    return;
  }
  if (!(saldo > 0)) {
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `💸 O cliente corrigiu o troco para ${brl(novoTroco)}, mas o card não tem o saldo devedor pra recalcular o valor do crédito. Ajuste "Valor do crédito" (saldo + troco) à mão.` } }).catch(() => {});
    return;
  }
  const total = creditoComTroco(saldo, novoTroco, !!st?.doneAt);
  const antes = Number(cf.valor_credito) || 0;
  // Só as chaves (corrida no customFields).
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(jsonb_set(COALESCE("customFields", '{}'::jsonb), '{troco}', ${JSON.stringify(String(novoTroco))}::jsonb, true), '{valor_credito}', ${JSON.stringify(String(total))}::jsonb, true) WHERE id = ${leadId}`;
  if (st) await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set("customFields", '{_saldoDevedor,liquido}', ${JSON.stringify(novoTroco)}::jsonb, true) WHERE id = ${leadId}`;
  const linhaValor = Math.abs(total - antes) < 1 ? `o crédito segue ${brl(total)}` : `crédito a analisar ${antes ? brl(antes) : '—'} → ${brl(total)} (saldo ${brl(saldo)} + troco ${brl(novoTroco)}${st?.doneAt ? ' + folga' : ''})`;
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `💸 O cliente corrigiu o troco${trocoAntes ? ` (${brl(trocoAntes)} → ${brl(novoTroco)})` : ` para ${brl(novoTroco)}`}: ${linhaValor}.` } }).catch(() => {});
  if (Math.abs(total - antes) < 1) return;
  await refazAnaliseComValorNovo(accountId, leadId, total, io);
}

/** O valor do crédito mudou (troco corrigido pelo cliente OU editado pela equipe): se a análise já rodou com o valor antigo, refaz nos 3 bancos; se ainda não rodou, a análise automática já parte do valor novo. */
export async function refazAnaliseComValorNovo(accountId: string, leadId: string, total: number, io: Io): Promise<void> {
  const rodou = await prisma.creditAnalysis.count({ where: { leadId, dryRun: false } });
  if (!rodou) return;
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  if (((lead?.customFields || {}) as Record<string, any>)._autoPaused) return;
  const setting = await prisma.creditAutoSetting.findUnique({ where: { accountId }, select: { enabled: true } });
  if (!setting?.enabled) { await prisma.note.create({ data: { leadId, type: 'COMMENT', content: '⚠️ A análise automática está desligada: refaça a análise nos bancos com o valor novo (aba Análise de Crédito).' } }).catch(() => {}); return; }
  try {
    const { createRequests } = require('./credit-analysis.service') as typeof import('./credit-analysis.service');
    const r = await createRequests(prisma as any, { accountId, leadIds: [leadId], banks: ['INTER', 'CREDITAS', 'CREDIMORAR'], dryRun: false, kind: 'RUN', force: true, alignApproval: true });
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🔁 Refiz a análise com o valor novo (${brl(total)}): o resultado antigo não vale pro troco corrigido. ${r.created ? `${r.created} pedido(s) na fila das extensões.` : 'Nada novo foi pedido (já havia análise em andamento).'}` } }).catch(() => {});
    io?.to?.(`account_${accountId}`)?.emit?.('new_conversation', { leadId });
  } catch (e: any) { console.error('[Troco] não consegui refazer a análise:', e?.message); }
}

/** Rótulo do arquivo de onde saiu o saldo: o DESCRITIVO DA PARCELA que também mostra o saldo continua DESCRITIVO (a conferência cobra os dois — Fabio 30/10). */
const rotuloSaldo = (antes?: string) => (antes && isDescritivoParcela(antes.split('|')[0]) ? antes : 'SALDO DEVEDOR|');

async function processOne(accountId: string, leadId: string, io: Io): Promise<void> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, aiAutoReplyActive: true, customFields: true, stage: { select: { name: true } } } });
  if (!lead) return;
  // Fabio 26/10: "enquanto isso o CRM já pode finalizar cobrando os documentos" — o fim da mensagem manda o cliente ir providenciando a documentação (só enquanto o card ainda espera documentos).
  const aindaSemDocs = /aguardando document/i.test((lead.stage?.name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
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
  let achouAtt = '';
  const lidos: string[] = [];
  for (const a of atts) {
    const r = await readSaldo(accountId, a);
    if (r === undefined) continue; // não deu pra ler agora: tenta na próxima rodada
    lidos.push(a.id);
    if (r.ehSaldo && r.saldo) { achou = { saldo: r.saldo, banco: r.banco, data: r.data }; achouAtt = a.id; break; }
  }
  st.scanned = [...scanned, ...lidos];

  const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cf2 = { ...((fresh?.customFields || {}) as Record<string, any>) };

  if (!achou) {
    if (lidos.length && !st.warnedAt) {
      st.warnedAt = new Date().toISOString();
      await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `⚠️ O cliente mandou ${lidos.length > 1 ? 'arquivos' : 'um arquivo'} depois do pedido do saldo devedor, mas a IA não achou o saldo. Abra a conversa, veja o valor e atualize "Saldo devedor" e "Troco" no card (troco = valor aprovado − saldo; a análise não é refeita).` } }).catch(() => {});
      try { const { sendPushToAccount } = require('./push.service') as typeof import('./push.service'); sendPushToAccount(accountId, { title: lead.name, body: 'Conferir o print do saldo devedor', leadId }).catch(() => {}); } catch { /* push opcional */ }
    }
    await setCfKeys(leadId, { _saldoDevedor: st });
    return;
  }

  // TROCO = APROVADO − SALDO DO PRINT (Fabio 13/11): nunca soma o saldo nem refaz a análise; o "Valor do crédito" fica o aprovado. Saldo acima do limite de 60% ou do aprovado
  // (Fabio 05/11 e 13/11): com este imóvel não dá pra seguir — o cliente é avisado (e, saldo maior que o aprovado, o card vai pra Perdidos).
  const am = await (require('./approval-notice.service') as typeof import('./approval-notice.service')).valorAprovadoParaTroco(leadId);
  const valorImovel = parseBrl(String(cf2.valor_imovel ?? ''));
  const bloq = saldoBloqueia(achou.saldo, valorImovel, am.valor || null);
  const troco = am.valor > 0 ? trocoDoAprovado(am.valor, achou.saldo) : 0;
  st.doneAt = new Date().toISOString();
  Object.assign(st, { saldo: achou.saldo, attachmentId: achouAtt, limiteVisto: true, ...(am.valor > 0 ? { aprovado: am.valor, trocoReal: troco } : {}), ...(am.aMenor ? { aMenor: true } : {}) });
  await setCfKeys(leadId, { saldo_devedor: String(achou.saldo), ...(!bloq && troco > 0 ? { troco: String(troco) } : {}), _saldoDevedor: st });
  // O print fica na PASTA DO CLIENTE com o nome "SALDO DEVEDOR" (única captura de tela que vai pra lá).
  if (achouAtt) await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set("customFields", '{_docInfo}', COALESCE("customFields"->'_docInfo', '{}'::jsonb) || jsonb_build_object(${achouAtt}::text, ${rotuloSaldo(cf2._docInfo?.[achouAtt])}::text), true) WHERE id = ${leadId}`;
  if (cf2._driveOrganizedAt) { try { const { organizeLeadDocsNow } = require('./received-docs.service') as typeof import('./received-docs.service'); await organizeLeadDocsNow(leadId); } catch (e: any) { console.error('[Saldo] não reorganizei a pasta:', e?.message || e); } }
  if (bloq) {
    await avisarSaldoBloqueado(accountId, leadId, { saldo: achou.saldo, valorImovel, aprovado: am.valor || null, aMenor: am.aMenor, bloq, podeMandar: true, io });
    return;
  }
  const lido = `🏦 Saldo devedor lido no print: ${brl(achou.saldo)}${achou.banco ? ` (${achou.banco})` : ''}${achou.data ? `, ref. ${achou.data}` : ''}.`;
  if (!(am.valor > 0)) {
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `${lido} Não achei o valor aprovado pra calcular o troco (aprovado − saldo): confira, atualize "Troco" no card e passe o valor ao cliente.` } }).catch(() => {});
    try { const { sendPushToAccount } = require('./push.service') as typeof import('./push.service'); sendPushToAccount(accountId, { title: lead.name, body: 'Saldo devedor lido — calcular o troco (aprovado − saldo)', leadId }).catch(() => {}); } catch { /* push opcional */ }
    return;
  }
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `${lido} Troco = aprovado ${brl(am.valor)} − saldo ${brl(achou.saldo)} = ${brl(troco)}: "Saldo devedor" e "Troco" atualizados no card; o "Valor do crédito" segue o aprovado e a análise NÃO foi refeita (Fabio 13/11).` } }).catch(() => {});
  // Cliente MANDANDO documento agora (Fabio 14/11, Fabricio: mandou 19 fotos e o print do saldo junto, e ouviu "já pode ir providenciando a documentação que te enviei"):
  // com conferência agendada ou outro arquivo nas últimas 24 h, a mensagem não cobra documento — a conferência é que diz o que falta.
  const outrosArquivos = await prisma.messageAttachment.count({ where: { leadId, message: { direction: 'INBOUND' }, createdAt: { gte: new Date(Date.now() - 24 * 3600_000) }, NOT: [{ mimeType: { startsWith: 'audio/' } }, { mimeType: { startsWith: 'video/' } }], ...(achouAtt ? { id: { not: achouAtt } } : {}) } }).catch(() => 0);
  const cobraDocs = aindaSemDocs && !cf2._docsCheckDue && !outrosArquivos;
  const nome = String(cf2.participante_1 || lead.name || '').trim().split(/\s+/)[0] || '';
  const texto = `Recebi o saldo${nome ? `, ${nome}` : ''}! 🙏 O saldo pra quitar o financiamento é de ${brl(achou.saldo)}. Com o valor aprovado de ${brl(am.valor)}, o seu troco fica em ${brl(troco)} (valor aproximado — o final é confirmado na formalização).${cobraDocs ? ' Já pode ir providenciando a documentação que te enviei, assim a gente adianta o processo. 😉' : ''}`;
  if (!lead.aiAutoReplyActive) await (require('./ia-pendencias.service') as typeof import('./ia-pendencias.service')).guardarPendenciaIa(leadId, 'saldoDevedorLido', `avisar que recebeu o saldo e qual é o troco — "${texto}"`);
  else await sendOutboundWhatsApp({ accountId, leadId, content: texto, io: io || undefined }).catch(() => {});
}
