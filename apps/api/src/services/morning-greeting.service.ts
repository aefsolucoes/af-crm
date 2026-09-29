import { PrismaClient } from '@prisma/client';

/**
 * Bom dia das 08h (Fabio 28/09): cliente que falou com a assistente virtual
 * durante a noite (20h–08h) recebe às 08h "Bom dia, Fulano! Aqui é a Andreia,
 * da A&F. Em que posso te ajudar?". Roda a cada poucos minutos entre 08h e
 * 10h; cada card recebe no máximo uma vez (não manda se já saiu qualquer
 * mensagem pra ele depois das 08h). Só com a IA ligada no card, card aberto
 * e dentro da janela de 24h do WhatsApp (senão a Meta recusa texto livre).
 */

const prisma = new PrismaClient();

function spHour(d: Date) {
  return parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hourCycle: 'h23' }).format(d), 10);
}

export async function sendMorningGreetings(io: any) {
  const now = new Date();
  const hour = spHour(now);
  if (hour < 8 || hour >= 10) return;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(now); // AAAA-MM-DD
  const today8 = new Date(`${today}T08:00:00-03:00`);
  const yesterday20 = new Date(today8.getTime() - 12 * 60 * 60 * 1000);

  const intros = await prisma.message.findMany({
    where: { direction: 'OUTBOUND', channel: 'WHATSAPP', createdAt: { gte: yesterday20, lt: today8 }, content: { contains: 'assistente virtual' } },
    select: { leadId: true },
    distinct: ['leadId'],
  });
  if (!intros.length) return;

  const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
  for (const { leadId } of intros) {
    try {
      const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { accountId: true, name: true, status: true, aiAutoReplyActive: true, customFields: true } });
      if (!lead || lead.status !== 'OPEN' || !lead.aiAutoReplyActive) continue;
      const alreadyToday = await prisma.message.findFirst({ where: { leadId, direction: 'OUTBOUND', channel: 'WHATSAPP', createdAt: { gte: today8 } }, select: { id: true } });
      if (alreadyToday) continue;
      const lastIn = await prisma.message.findFirst({ where: { leadId, direction: 'INBOUND', channel: 'WHATSAPP' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
      if (!lastIn || now.getTime() - lastIn.createdAt.getTime() > 23.5 * 60 * 60 * 1000) {
        console.log(`[Bom dia] ${lead.name}: fora da janela de 24h do WhatsApp — não mandou`);
        continue;
      }
      const cf = (lead.customFields || {}) as Record<string, unknown>;
      const raw = String(cf.participante_1 || lead.name || '').trim().split(/\s+/)[0] || '';
      const nome = raw && !raw.startsWith('+') ? raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase() : '';
      const content = `Bom dia${nome ? `, ${nome}` : ''}! Aqui é a Andreia, da A&F. Em que posso te ajudar?`;
      const sent = await sendOutboundWhatsApp({ accountId: lead.accountId, leadId, content, io });
      console.log(`[Bom dia] ${lead.name}: ${sent.success ? 'enviado' : 'falhou — ' + sent.error}`);
    } catch (err: any) {
      console.error('[Bom dia] erro:', err?.message);
    }
  }
}
