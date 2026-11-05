import { prisma } from '../lib/prisma';

/** PROPOSTA QUE NÃO CHEGOU (Fabio 05/11, Fernando: "não preencheu a proposta e foi movido para Pré-Análise; o CRM precisa checar o e-mail ou a proposta na conversa do
 *  WhatsApp; caso não ache, avise o cliente que não recebeu, se poderia encaminhá-la novamente, e confirme se ele clicou em 'Encaminhar proposta pelo WhatsApp'").
 *  Card na Pré-Análise há 20 min sem proposta na conversa, sem proposta registrada no card, sem análise de banco e sem e-mail com a proposta → avisa o cliente
 *  (conversa aberta: na hora; fechada: template de atualização e o recado sai quando ele responder). Achou só no e-mail → nota + push pra equipe. Uma vez por card. */

const MARCAS = ['Proposta preenchida no site', 'PROPOSTA RECEBIDA', 'Preenchi a proposta', 'Proposta manual'];
const ESPERA_MS = 20 * 60_000;
const LINK = { he: 'https://aefsolucoesfinanceiras.com.br/proposta-manual-home-equity', fh: 'https://aefsolucoesfinanceiras.com.br/proposta-manual' };
type Io = { to: (room: string) => { emit: (ev: string, data: unknown) => void } } | null | undefined;

export function textoPropostaNaoRecebida(nome: string, fh: boolean): string {
  return `Oi, ${nome}! Conferi aqui e a sua proposta não chegou pra gente 😕 Às vezes o envio não completa. Consegue preencher de novo por este link?\n${fh ? LINK.fh : LINK.he}\n\nE uma dúvida: no final do formulário, você chegou a clicar no botão *Encaminhar proposta pelo WhatsApp*? É ele que confirma o envio pra gente.`;
}

/** A proposta do cliente está em algum lugar? conversa (marcas), card (proposta registrada), análise de banco ou e-mail. 'EMAIL' = só no e-mail. */
export async function ondeEstaAProposta(leadId: string): Promise<'CONVERSA' | 'CARD' | 'ANALISE' | 'EMAIL' | null> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true, contact: { select: { phone: true, email: true } } } });
  if (!l) return null;
  const cf = (l.customFields || {}) as Record<string, any>;
  if (await prisma.message.findFirst({ where: { leadId, deleted: false, direction: 'INBOUND', OR: MARCAS.map((m) => ({ content: { contains: m } })) }, select: { id: true } })) return 'CONVERSA';
  if (cf._propostaManual?.texto) return 'CARD';
  if (await prisma.creditAnalysis.findFirst({ where: { leadId, dryRun: false, source: { not: 'AI_SIM' } }, select: { id: true } })) return 'ANALISE';
  const dig = String(l.contact?.phone || cf.telefone_1 || '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
  const fone = dig.length >= 10 ? [dig.slice(-9), `${dig.slice(-9, -4)}-${dig.slice(-4)}`, `${dig.slice(-8, -4)}-${dig.slice(-4)}`] : [];
  const email = String(l.contact?.email || cf.email_1 || '').trim().toLowerCase();
  const cpf = String(cf.cpf_1 || '').replace(/\D/g, '');
  const quem = [...fone, ...(email.includes('@') ? [email] : []), ...(cpf.length === 11 ? [cpf, `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`] : [])];
  const desde = new Date(Date.now() - 60 * 86_400_000);
  const porEmail = await prisma.emailMessage.findFirst({
    where: {
      date: { gte: desde },
      AND: [
        // Só o e-mail de PROPOSTA do site (assunto começa com 🏠 e não é "sem proposta" — o mesmo critério do site-proposal-email); o nosso "Sua simulação…" tem a palavra
        // "proposta" e dava falso positivo (Fernando 05/11).
        { subject: { startsWith: '🏠' } },
        { NOT: { subject: { contains: 'sem proposta', mode: 'insensitive' } } },
        { OR: [{ leadId }, ...quem.map((q) => ({ textBody: { contains: q } }))] },
      ],
    },
    select: { id: true },
  }).catch(() => null);
  return porEmail ? 'EMAIL' : null;
}

export async function processPropostaNaoRecebida(accountId: string, io?: Io): Promise<void> {
  const { inNoticeWindow, whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  if (!inNoticeWindow()) return; // 07h–21h
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT l.id FROM "Lead" l JOIN "Stage" s ON s.id = l."stageId"
    WHERE l."accountId" = ${accountId} AND l.status = 'OPEN' AND l.archived = false AND l."isGroup" = false
      AND s.name ILIKE 'pr_-an_lise%' AND l."stageEnteredAt" < ${new Date(Date.now() - ESPERA_MS)} AND l."stageEnteredAt" > ${new Date(Date.now() - 30 * 86_400_000)}
      AND COALESCE(l."customFields"->'_propNaoRecebida'->>'v', '') <> '2' AND COALESCE(l."customFields"->>'_autoPaused', '') = ''
    ORDER BY l."stageEnteredAt" DESC LIMIT 5`;
  for (const { id } of rows) {
    const lead = await prisma.lead.findUnique({ where: { id }, select: { id: true, name: true, aiAutoReplyActive: true, customFields: true, pipeline: { select: { department: { select: { name: true } } } } } });
    if (!lead) continue;
    const marca = (v: Record<string, unknown>) => prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_propNaoRecebida}', ${JSON.stringify({ ...v, v: '2', at: new Date().toISOString() })}::jsonb, true) WHERE id = ${id}`;
    const onde = await ondeEstaAProposta(id);
    if (onde && onde !== 'EMAIL') { await marca({ status: 'TEM', onde }); continue; }
    const nota = (content: string) => prisma.note.create({ data: { leadId: id, type: 'COMMENT', content } }).catch(() => {});
    const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
    if (onde === 'EMAIL') {
      await marca({ status: 'EMAIL' });
      await nota('📧 Card na Pré-Análise sem a proposta na conversa, mas achei um e-mail com proposta deste cliente (pelo telefone/e-mail/CPF). Confira o e-mail e registre a proposta no card pra análise rodar.');
      sendPushToAccount(accountId, { title: `📧 ${lead.name}: proposta só no e-mail`, body: 'Está na Pré-Análise sem a proposta na conversa — achei no e-mail. Confira e registre.', leadId: id }).catch(() => {});
      continue;
    }
    const cf = (lead.customFields || {}) as Record<string, any>;
    const fh = /habitacional/i.test(lead.pipeline?.department?.name || '');
    const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
    const nome = callableFirstName(cf.falando_com, cf.participante_1, lead.name) || String(lead.name || '').trim().split(/\s+/)[0] || 'tudo bem';
    const texto = textoPropostaNaoRecebida(nome, fh);
    if (!lead.aiAutoReplyActive) {
      await marca({ status: 'EQUIPE' });
      const { guardarPendenciaIa } = require('./ia-pendencias.service') as typeof import('./ia-pendencias.service');
      await guardarPendenciaIa(id, 'propostaNaoRecebida', 'a proposta do cliente não chegou (nem na conversa nem no e-mail): avisar que não recebemos, pedir pra preencher de novo pelo link e perguntar se ele clicou em "Encaminhar proposta pelo WhatsApp"');
      await nota(`📋 Card na Pré-Análise e a proposta NÃO chegou (nem na conversa nem no e-mail). A IA deste card está desligada: não avisei o cliente. Sugestão de mensagem:\n"${texto}"`);
      sendPushToAccount(accountId, { title: `📋 ${lead.name}: proposta não chegou`, body: 'Está na Pré-Análise sem proposta. IA desligada — avise o cliente (sugestão na anotação).', leadId: id }).catch(() => {});
      continue;
    }
    if (await whatsappWindowOpen(id)) {
      const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
      const r = await sendOutboundWhatsApp({ accountId, leadId: id, content: texto, io: io as any });
      await marca({ status: r.success ? 'AVISADO' : 'FALHOU', via: 'texto' });
      await nota(r.success ? '📋 A proposta deste cliente não chegou (nem na conversa nem no e-mail): avisei e pedi pra encaminhar de novo, perguntando se ele clicou em "Encaminhar proposta pelo WhatsApp".' : `📋 A proposta não chegou e a mensagem ao cliente não saiu (${(r as any).error}). Mande à mão: "${texto}"`);
      continue;
    }
    // Conversa fechada: template de atualização reabre; o recado sai quando ele responder.
    const tpl = fh ? 'atualizacao_processo_habitacional' : 'atualizacao_processo_credito';
    const { sendOutboundWhatsAppTemplate } = require('./message.service') as typeof import('./message.service');
    const t = await sendOutboundWhatsAppTemplate({ accountId, leadId: id, templateName: tpl, language: 'pt_BR', bodyParams: [nome], previewText: `Oi ${nome}, tudo bem? Temos uma atualização sobre o seu processo de ${fh ? 'financiamento habitacional' : 'crédito com garantia de imóvel'}. Responda esta mensagem para que a gente possa te passar os detalhes.`, io: io as any });
    if (t.success) await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_msgNaResposta}', ${JSON.stringify({ texto, desde: new Date().toISOString(), por: 'proposta não recebida' })}::jsonb, true) WHERE id = ${id}`;
    await marca({ status: t.success ? 'TEMPLATE' : 'FALHOU', via: 'template' });
    await nota(t.success ? '📋 A proposta deste cliente não chegou (nem na conversa nem no e-mail) e a conversa estava fechada: mandei o template de atualização; quando ele responder, sai o pedido pra encaminhar a proposta de novo (perguntando se clicou em "Encaminhar proposta pelo WhatsApp").' : `📋 A proposta não chegou e o template não saiu (${t.error}). Avise o cliente à mão: "${texto}"`);
  }
}
