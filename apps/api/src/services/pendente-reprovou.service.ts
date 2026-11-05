import { prisma } from '../lib/prisma';

/** BANCO "AINDA EM ANÁLISE" QUE REPROVOU DEPOIS DO AVISO (Fabio 05/11, Paloma: "o CRM falou que estava aguardando o Inter, mas o Inter reprovou e ele não informou a cliente").
 *  O aviso de aprovação diz "⏳ Ainda em análise: X. Se sair uma condição melhor, te aviso por aqui." — o aviso novo só saía quando X APROVAVA (a assinatura do aviso é feita das
 *  aprovações). Agora, quando TODOS os bancos citados nesse último aviso terminam sem aprovar, o cliente recebe uma mensagem curta: saiu o resultado, não aprovou, a aprovação que
 *  ele já tem continua valendo. Quem ainda não escolheu recebe também "Você deseja seguir com o crédito aprovado?" (quem reclamou do valor entra na regra de 1 dia → Perdidos).
 *  Uma vez por aviso (`_pendReprovou.aviso`). Conversa fechada: template de atualização + recado na resposta. IA desligada: nota + push. */

const NOMES: Record<string, string> = { INTER: 'Inter', CREDITAS: 'Creditas', CREDIMORAR: 'Santander' };
const BANCO_DO_NOME: Record<string, string> = { inter: 'INTER', creditas: 'CREDITAS', santander: 'CREDIMORAR' };
type Io = { to: (room: string) => { emit: (ev: string, data: unknown) => void } } | null | undefined;

/** Bancos da linha "⏳ Ainda em análise: Inter e Santander." de um aviso. Pura. */
export function pendentesDoAviso(texto: string): string[] {
  const m = /Ainda em an[aá]lise:\s*([^\n.]+)/i.exec(String(texto || ''));
  if (!m) return [];
  return Array.from(new Set(m[1].split(/\s*(?:,|\be\b)\s*/i).map((n) => BANCO_DO_NOME[n.trim().toLowerCase()]).filter(Boolean)));
}

const lista = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} e ${xs[xs.length - 1]}` : xs[0] || '');

/** Texto ao cliente. Pura. */
export function textoPendenteReprovou(nome: string, reprovaram: string[], aprovados: string[], perguntar: boolean, pergunta: string): string {
  const art = (b: string) => `${b === 'CREDITAS' ? 'da' : 'do'} ${NOMES[b] || b}`; // "da Creditas", "do Inter"
  const um = reprovaram.length === 1;
  const vale = aprovados.length > 1 ? `As aprovações ${lista(aprovados.map(art))} continuam valendo` : `A aprovação ${art(aprovados[0])} continua valendo`;
  return `${nome ? `${nome}, s` : 'S'}aiu o resultado ${lista(reprovaram.map(art))}: desta vez ${um ? 'não aprovou' : 'não aprovaram'}. ${vale} pra seguir.${perguntar ? `\n\n${pergunta}` : ''}`;
}

export async function processPendenteReprovou(accountId: string, io?: Io): Promise<void> {
  const { inNoticeWindow, whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  if (!inNoticeWindow()) return; // 07h–21h
  const { bankVerdict } = require('./credit-auto.service') as typeof import('./credit-auto.service');
  // Avisos com banco pendente dos últimos 3 dias (o que veio antes disso não é retomado do nada).
  const avisos = await prisma.$queryRaw<{ leadId: string }[]>`
    SELECT DISTINCT m."leadId" FROM "Message" m JOIN "Lead" l ON l.id = m."leadId"
    WHERE l."accountId" = ${accountId} AND l.status = 'OPEN' AND l.archived = false AND l."isGroup" = false
      AND m.direction = 'OUTBOUND' AND m.deleted = false AND m."createdAt" > ${new Date(Date.now() - 3 * 86_400_000)}
      AND m.content LIKE '%Resumo da proposta%' AND m.content LIKE '%Ainda em an_lise:%'
      AND COALESCE(l."customFields"->>'_autoPaused', '') = ''
    LIMIT 40`;
  for (const { leadId } of avisos) {
    // Vale o ÚLTIMO aviso de aprovação: se saiu outro depois (outro banco aprovou), é ele que manda.
    const ultimo = await prisma.message.findFirst({ where: { leadId, direction: 'OUTBOUND', deleted: false, content: { contains: 'Resumo da proposta' } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    if (!ultimo) continue;
    const lote = await prisma.message.findMany({ where: { leadId, direction: 'OUTBOUND', deleted: false, content: { contains: 'Resumo da proposta' }, createdAt: { gte: new Date(ultimo.createdAt.getTime() - 3 * 60_000) } }, select: { content: true } });
    const pend = Array.from(new Set(lote.flatMap((m) => pendentesDoAviso(m.content || ''))));
    if (!pend.length) continue;
    const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { id: true, name: true, aiAutoReplyActive: true, customFields: true, pipeline: { select: { department: { select: { name: true } } } } } });
    if (!lead || /habitacional/i.test(lead.pipeline?.department?.name || '')) continue;
    const cf = (lead.customFields || {}) as Record<string, any>;
    const chave = ultimo.createdAt.toISOString();
    if (cf._pendReprovou?.aviso === chave) continue;
    const rows = await prisma.creditAnalysis.findMany({ where: { leadId, dryRun: false, createdAt: { gte: new Date(Date.now() - 45 * 86_400_000) } }, orderBy: { createdAt: 'desc' }, select: { bank: true, kind: true, status: true, detail: true, source: true, createdAt: true, updatedAt: true, chosen: true } });
    const vered = pend.map((b) => bankVerdict(rows as any, b));
    if (vered.includes('PENDING') || vered.includes('POS')) continue; // ainda analisando, ou aprovou (aí sai o aviso de "mais um banco")
    const marca = (v: Record<string, unknown>) => prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_pendReprovou}', ${JSON.stringify({ ...v, aviso: chave, bancos: pend, at: new Date().toISOString() })}::jsonb, true) WHERE id = ${leadId}`;
    // Reprovação antiga (o aviso é recente mas o resultado já tinha saído há dias): não manda nada fora de hora.
    const ultimaNeg = Math.max(...pend.map((b) => rows.find((r) => r.bank === b && r.source !== 'AI_SIM')?.updatedAt.getTime() || 0));
    if (Date.now() - ultimaNeg > 2 * 86_400_000) { await marca({ status: 'ANTIGO' }); continue; }
    // Alguém já contou ao cliente (IA respondendo "e o Inter?", ou a equipe).
    const nomesRx = pend.map((b) => NOMES[b]).join('|');
    const disseRx = new RegExp(`\\b(${nomesRx})\\b[^.!?\\n]{0,80}(n[ãa]o (foi )?aprov|reprov|n[ãa]o (conseguiu|deu|liberou)|negad)`, 'i');
    const depois = await prisma.message.findMany({ where: { leadId, direction: 'OUTBOUND', deleted: false, createdAt: { gt: ultimo.createdAt } }, select: { content: true }, take: 30 });
    const jaDisse = depois.some((m) => disseRx.test(m.content || ''));
    if (jaDisse) { await marca({ status: 'JA_DITO' }); continue; }
    const aprovados = Array.from(new Set(rows.filter((r) => ['APPROVED', 'CONDITIONAL'].includes(r.status) && r.source !== 'PORTAL' && bankVerdict(rows as any, r.bank) === 'POS').map((r) => r.bank)));
    if (!aprovados.length) { await marca({ status: 'SEM_APROVADO' }); continue; } // sem aprovação nenhuma é a negativa normal (sendRejectionNotice)
    const escolheu = rows.some((r) => r.chosen);
    const hesitou = !escolheu && !!(await prisma.message.findMany({ where: { leadId, direction: 'INBOUND', deleted: false, createdAt: { gt: ultimo.createdAt } }, select: { content: true }, take: 20 }).then((ms) => {
      const { HESITA_RX } = require('./ai-auto-reply.service') as typeof import('./ai-auto-reply.service');
      return ms.some((m) => HESITA_RX.test(m.content || ''));
    }));
    const { SEGUIR_APROVADO_Q } = require('./ai-auto-reply.service') as typeof import('./ai-auto-reply.service');
    const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
    const nome = callableFirstName(cf.falando_com, cf.participante_1, lead.name) || String(lead.name || '').trim().split(/\s+/)[0] || '';
    const texto = textoPendenteReprovou(nome, pend, aprovados, !escolheu, SEGUIR_APROVADO_Q);
    const nota = (content: string) => prisma.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});
    const bancosNeg = lista(pend.map((b) => NOMES[b]));
    if (!lead.aiAutoReplyActive) {
      await marca({ status: 'EQUIPE' });
      const { guardarPendenciaIa } = require('./ia-pendencias.service') as typeof import('./ia-pendencias.service');
      await guardarPendenciaIa(leadId, 'pendenteReprovou', `o aviso de aprovação disse que o ${bancosNeg} ainda estava em análise e ele não aprovou: contar ao cliente que não aprovou e que a aprovação que ele tem continua valendo`);
      await nota(`⏳ O aviso de aprovação disse "Ainda em análise: ${bancosNeg}" e ${pend.length > 1 ? 'eles não aprovaram' : 'ele não aprovou'}. A IA deste card está desligada: não avisei o cliente. Sugestão de mensagem:\n"${texto}"`);
      const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
      sendPushToAccount(accountId, { title: `⏳ ${lead.name}: ${bancosNeg} não aprovou`, body: 'O aviso dizia "ainda em análise". IA desligada — avise o cliente (sugestão na anotação).', leadId }).catch(() => {});
      continue;
    }
    const gravarSeguir = () => (hesitou ? prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_seguirAprovadoAt}', to_jsonb(${new Date().toISOString()}::text), true) WHERE id = ${leadId}` : Promise.resolve(0));
    if (await whatsappWindowOpen(leadId)) {
      const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
      const r = await sendOutboundWhatsApp({ accountId, leadId, content: texto, io: io as any });
      await marca({ status: r.success ? 'AVISADO' : 'FALHOU', via: 'texto' });
      if (r.success) await gravarSeguir();
      await nota(r.success ? `⏳ O aviso de aprovação dizia "Ainda em análise: ${bancosNeg}" e ${pend.length > 1 ? 'eles não aprovaram' : 'ele não aprovou'}: avisei o cliente que a aprovação que ele tem continua valendo${escolheu ? '' : ` e perguntei "${SEGUIR_APROVADO_Q}"`}.` : `⏳ ${bancosNeg} não aprovou depois do aviso e a mensagem ao cliente não saiu (${(r as any).error}). Mande à mão: "${texto}"`);
      continue;
    }
    const { sendOutboundWhatsAppTemplate } = require('./message.service') as typeof import('./message.service');
    const t = await sendOutboundWhatsAppTemplate({ accountId, leadId, templateName: 'atualizacao_processo_credito', language: 'pt_BR', bodyParams: [nome || 'tudo bem'], previewText: `Oi ${nome}, tudo bem? Temos uma atualização sobre o seu processo de crédito com garantia de imóvel. Responda esta mensagem para que a gente possa te passar os detalhes.`, io: io as any });
    if (t.success) await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_msgNaResposta}', ${JSON.stringify({ texto, desde: new Date().toISOString(), por: 'banco em análise não aprovou' })}::jsonb, true) WHERE id = ${leadId}`;
    await marca({ status: t.success ? 'TEMPLATE' : 'FALHOU', via: 'template' });
    await nota(t.success ? `⏳ ${bancosNeg} não aprovou depois do aviso de aprovação e a conversa estava fechada: mandei o template de atualização; quando o cliente responder, sai o recado de que a aprovação que ele tem continua valendo.` : `⏳ ${bancosNeg} não aprovou depois do aviso e o template não saiu (${t.error}). Avise o cliente à mão: "${texto}"`);
  }
}
