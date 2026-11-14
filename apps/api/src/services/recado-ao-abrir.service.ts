import { prisma } from '../lib/prisma';

/**
 * RECADO PRA QUANDO O CLIENTE RESPONDER (Fabio 14/11, Cleci: "sim, pedir a ela" a certidão de casamento — com a janela de 24 h já fechada).
 * A equipe deixa um texto pronto no card (`_recadoAoAbrir` { texto, por, at }) e manda o template de atualização. Quando o cliente responde (a janela abre),
 * o CRM manda o texto UMA vez, 2 min depois da resposta dele (a IA responde primeiro), só 07h–21h. Sem resposta em 7 dias, o recado cai e a equipe é avisada.
 */

const ESPERA_IA_MS = 2 * 60_000;
const VALIDADE_MS = 7 * 86_400_000;

type Recado = { texto?: string; por?: string; at?: string };

const note = (leadId: string, content: string) => prisma.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});

/** Grava o recado no card (só a chave, por SQL). */
export async function guardarRecadoAoAbrir(leadId: string, texto: string, por: string): Promise<void> {
  const v = JSON.stringify({ texto: texto.trim().slice(0, 1500), por, at: new Date().toISOString() });
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_recadoAoAbrir}', ${v}::jsonb, true) WHERE id = ${leadId}`;
  await note(leadId, `📝 Recado guardado (por ${por}): sai sozinho pelo WhatsApp quando o cliente responder (a conversa de 24 h está fechada):\n\n${texto.trim()}`);
}

const apaga = (leadId: string) => prisma.$executeRaw`UPDATE "Lead" SET "customFields" = "customFields" - '_recadoAoAbrir' WHERE id = ${leadId}`;

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
        continue;
      }
      const resposta = await prisma.message.findFirst({ where: { leadId: id, direction: 'INBOUND', channel: 'WHATSAPP', deleted: false, createdAt: { gt: desde } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
      if (!resposta || Date.now() - resposta.createdAt.getTime() < ESPERA_IA_MS) continue; // ainda não respondeu, ou a IA ainda está respondendo
      if (!an.inNoticeWindow() || !(await an.whatsappWindowOpen(id))) continue;
      await apaga(id); // antes de mandar: nunca sai duas vezes
      const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
      const out = await sendOutboundWhatsApp({ accountId, leadId: id, content: r.texto, io });
      await note(id, out.success
        ? `📨 Recado da equipe enviado ao cliente (ele respondeu e a conversa abriu): "${r.texto.slice(0, 300)}"`
        : `⚠️ O cliente respondeu, mas o recado guardado não saiu (${out.error}). Mande à mão:\n\n${r.texto}`);
    } catch (e: any) { console.warn('[Recado ao abrir]', e?.message); }
  }
}
