import { prisma } from '../lib/prisma';

/**
 * RECADO PRA QUANDO O CLIENTE RESPONDER (Fabio 14/11, Cleci: "sim, pedir a ela" a certidão de casamento — com a janela de 24 h já fechada).
 * A equipe deixa um texto pronto no card (`_recadoAoAbrir` { texto, por, at, ia }) — pela Inbox, no campo de digitar com a janela fechada — e manda o template de atualização. Quando o cliente responde (a janela abre),
 * o CRM manda o texto UMA vez, 2 min depois da resposta dele (a IA responde primeiro), só 07h–21h. Sem resposta em 7 dias, o recado cai e a equipe é avisada.
 * Depois que sai, a IA do card fica ligada ou desligada como a equipe escolheu ao guardar (`ia`, Fabio 18/11).
 */

const ESPERA_IA_MS = 2 * 60_000;
const VALIDADE_MS = 7 * 86_400_000;

/** `docs`: sem resposta em `apos` horas, manda UMA vez o template de documentação da etapa do card (Fabio 14/11: "se ela não responder, mandar template de documentação conforme está o estágio dela"). */
/** `ia`: como a IA do card fica DEPOIS que o recado sai (Fabio 18/11: "opção de ligar ou desligar a IA em seguida"); sem `ia`, não mexe. */
type Recado = { texto?: string; por?: string; at?: string; ia?: IaDepois; docs?: { apos?: number; enviadoAt?: string } };
export type IaDepois = 'ligada' | 'desligada';

const apaga = (leadId: string) => prisma.$executeRaw`UPDATE "Lead" SET "customFields" = "customFields" - '_recadoAoAbrir' WHERE id = ${leadId}`;
const note = (leadId: string, content: string) => prisma.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});

/** Grava o recado no card (só a chave, por SQL). Editar = gravar de novo: o `at` e o lembrete de documentação do recado anterior continuam valendo. */
export async function guardarRecadoAoAbrir(leadId: string, texto: string, por: string, opts: { docsSemRespostaHoras?: number; ia?: IaDepois } = {}): Promise<void> {
  const atual = await lerRecado(leadId);
  const docs = opts.docsSemRespostaHoras && opts.docsSemRespostaHoras > 0 ? { apos: opts.docsSemRespostaHoras } : atual?.docs;
  const ia = opts.ia === 'ligada' || opts.ia === 'desligada' ? opts.ia : undefined;
  const v = JSON.stringify({ texto: texto.trim().slice(0, 1500), por, at: atual?.at || new Date().toISOString(), ...(ia ? { ia } : {}), ...(docs ? { docs } : {}) });
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_recadoAoAbrir}', ${v}::jsonb, true) WHERE id = ${leadId}`;
  const iaTxt = ia ? ` Depois de enviar, a IA fica ${ia.toUpperCase()}.` : '';
  await note(leadId, `📝 Recado ${atual?.texto ? 'editado' : 'guardado'} (por ${por}): sai sozinho pelo WhatsApp quando o cliente responder (a conversa de 24 h está fechada).${iaTxt}${docs && !docs.enviadoAt ? ` Sem resposta em ${docs.apos} h, vai o template de documentação da etapa do card.` : ''}\n\n${texto.trim()}`);
}

async function lerRecado(leadId: string): Promise<Recado | undefined> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  return ((lead?.customFields || {}) as Record<string, any>)._recadoAoAbrir as Recado | undefined;
}

/** A equipe cancelou o recado (botão na Inbox). */
export async function cancelarRecadoAoAbrir(leadId: string, por: string): Promise<boolean> {
  const atual = await lerRecado(leadId);
  if (!atual) return false;
  await apaga(leadId);
  await note(leadId, `🗑️ Recado guardado cancelado (por ${por}). Não foi enviado:\n\n${atual.texto || ''}`);
  return true;
}

/** Depois que o recado saiu: liga ou desliga a IA do card como a equipe escolheu ao guardar. Só o campo (sem a retomada de "IA ligada"):
 *  o recado acabou de sair, a IA responde quando o cliente escrever de novo. */
async function aplicaIaDepois(leadId: string, ia: IaDepois | undefined, io: any): Promise<string> {
  if (!ia) return '';
  const active = ia === 'ligada';
  const { count } = await prisma.lead.updateMany({ where: { id: leadId, aiAutoReplyActive: !active }, data: { aiAutoReplyActive: active } });
  if (count) io?.to(`lead:${leadId}`).emit('lead_ai_toggled', { leadId, active });
  return count ? ` IA ${active ? 'ligada' : 'desligada'} em seguida, como a equipe escolheu.` : ` A IA segue ${active ? 'ligada' : 'desligada'}, como a equipe escolheu.`;
}

/** Template de documentação conforme a etapa: com documentos já recebidos ou aguardando, o lembrete "segue aguardando os documentos… se estiver com dificuldade, me avise"
 *  (docs_lembrete_2 — o 1º, "pré-análise aprovada… aguardando a sua documentação", é o de quem ainda não mandou nada). Outra etapa: nenhum (null). */
function lembreteDaEtapa(etapa: string, jaMandouDocs: boolean): number | null {
  if (!/aguardando document|documenta[cç][aã]o recebida/i.test(etapa)) return null;
  return jaMandouDocs || /recebida/i.test(etapa) ? 1 : 0;
}

async function mandaTemplateDocs(accountId: string, leadId: string, r: Recado, io: any): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, customFields: true, stage: { select: { name: true } } } });
  if (!lead) return;
  const cf = (lead.customFields || {}) as Record<string, any>;
  const jaMandou = await prisma.messageAttachment.count({ where: { leadId, message: { direction: 'INBOUND' } } });
  const i = lembreteDaEtapa(lead.stage?.name || '', jaMandou > 0);
  // marca antes de mandar: nunca sai duas vezes
  const marca = JSON.stringify({ ...(r.docs || {}), enviadoAt: new Date().toISOString() });
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set("customFields", '{_recadoAoAbrir,docs}', ${marca}::jsonb, true) WHERE id = ${leadId} AND jsonb_exists(COALESCE("customFields", '{}'::jsonb), '_recadoAoAbrir')`;
  if (i === null) { await note(leadId, `⚠️ O cliente não respondeu ao recado e a etapa do card ("${lead.stage?.name || '?'}") não tem template de documentação: nada foi mandado.`); return; }
  const { LEMBRETES } = require('./docs-loop.service') as typeof import('./docs-loop.service');
  const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
  const nome = callableFirstName(cf.falando_com, cf.nome_social_1, cf.participante_1, lead.name) || 'tudo bem';
  const l = LEMBRETES[i];
  const preview = `${l.texto(nome)}\n\n${l.botoes.map((b) => `[${b}]`).join('  ')}`;
  const { sendOutboundWhatsAppTemplate } = require('./message.service') as typeof import('./message.service');
  const t = await sendOutboundWhatsAppTemplate({ accountId, leadId, templateName: l.template, language: 'pt_BR', bodyParams: [nome], previewText: preview, io });
  await note(leadId, t.success
    ? `📄 O cliente não respondeu ao template de atualização: mandei o template de documentação da etapa (${l.template}). O recado guardado continua valendo e sai quando ele responder.`
    : `⚠️ O cliente não respondeu e o template de documentação (${l.template}) não saiu: ${(t as any).error}.`);
}

export async function processRecadosAoAbrir(accountId: string, io: any): Promise<void> {
  const an = require('./approval-notice.service') as typeof import('./approval-notice.service');
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND archived = false AND "isGroup" = false
      AND jsonb_exists(COALESCE("customFields", '{}'::jsonb), '_recadoAoAbrir') LIMIT 30`;
  for (const { id } of ids) {
    try {
      const lead = await prisma.lead.findUnique({ where: { id }, select: { status: true, customFields: true } });
      const r = ((lead?.customFields || {}) as Record<string, any>)._recadoAoAbrir as Recado | undefined;
      if (!lead || !r?.texto || !r.at) { await apaga(id); continue; }
      const desde = new Date(r.at);
      if (lead.status !== 'OPEN' || Date.now() - desde.getTime() > VALIDADE_MS) {
        await apaga(id);
        await note(id, `⚠️ O recado guardado não saiu: ${lead.status !== 'OPEN' ? 'o card não está mais aberto' : 'o cliente não respondeu em 7 dias'}. Texto:\n\n${r.texto}`);
        io?.to(`lead:${id}`).emit('lead_updated', { leadId: id });
        continue;
      }
      const resposta = await prisma.message.findFirst({ where: { leadId: id, direction: 'INBOUND', channel: 'WHATSAPP', deleted: false, createdAt: { gt: desde } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
      if (!resposta) { // ainda não respondeu: depois do prazo, o template de documentação da etapa (uma vez, 07h–21h, com a conversa ainda fechada)
        if (r.docs?.apos && !r.docs.enviadoAt && Date.now() - desde.getTime() >= r.docs.apos * 3_600_000 && an.inNoticeWindow() && !(await an.whatsappWindowOpen(id))) await mandaTemplateDocs(accountId, id, r, io);
        continue;
      }
      if (Date.now() - resposta.createdAt.getTime() < ESPERA_IA_MS) continue; // a IA ainda está respondendo
      if (!an.inNoticeWindow() || !(await an.whatsappWindowOpen(id))) continue;
      await apaga(id); // antes de mandar: nunca sai duas vezes
      const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
      const out = await sendOutboundWhatsApp({ accountId, leadId: id, content: r.texto, io });
      const iaTxt = out.success ? await aplicaIaDepois(id, r.ia, io) : '';
      await note(id, out.success
        ? `📨 Recado da equipe enviado ao cliente (ele respondeu e a conversa abriu): "${r.texto.slice(0, 300)}"${iaTxt}`
        : `⚠️ O cliente respondeu, mas o recado guardado não saiu (${out.error}). Mande à mão:\n\n${r.texto}`);
      io?.to(`lead:${id}`).emit('lead_updated', { leadId: id }); // a Inbox relê o card: o aviso do recado guardado some
    } catch (e: any) { console.warn('[Recado ao abrir]', e?.message); }
  }
}
