import { prisma } from '../lib/prisma';

// ─── "Já assinou?" antes da janela de 24 h fechar (Fabio 13/11: "sempre que encaminhar esse documento [autorização USECASA], o CRM deve encaminhar uma msg perguntando se já
// assinou antes de fechar a janela e dentro do período que a gente atende"). Vale pra vistoria do Santander no Home Equity e no Financiamento.
// Quando: o documento pra assinar foi mandado há 2 h ou mais, o PDF assinado ainda não voltou e a conversa fecha em breve — o lembrete sai no último horário de atendimento
// (07h–20h30, Brasília) antes de a janela fechar, com folga de 2 h. Uma vez por janela (a resposta do cliente abre outra), no máximo 3. Automação da contratação desligada
// ou IA do card desligada: nada vai ao cliente — nota + push pra equipe lembrar, com o texto pronto.

const BRT_MS = -3 * 3_600_000;
const INICIO_MIN = 7 * 60;       // 07:00
const FIM_MIN = 20 * 60 + 30;    // 20:30 (o aviso ao cliente vai até 21h)
const MAX_LEMBRETES = 3;

/** O último instante ≤ t dentro do horário de atendimento (07:00–20:30, Brasília). */
export function ultimoHorarioAntes(t: number): number {
  const local = new Date(t + BRT_MS);
  const min = local.getUTCHours() * 60 + local.getUTCMinutes();
  const dia = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  if (min >= INICIO_MIN && min <= FIM_MIN) return t;
  const alvoDia = min > FIM_MIN ? dia : dia - 86_400_000; // depois das 20:30 → 20:30 do mesmo dia; antes das 07:00 → 20:30 da véspera
  return alvoDia + FIM_MIN * 60_000 - BRT_MS;
}

/** Hora de mandar o lembrete pra uma janela que fecha em `fecha` (pura, testável): o último horário de atendimento antes de (fecha − 2 h), com 90 min de antecedência. */
export function horaDoLembrete(fecha: number): number {
  return ultimoHorarioAntes(fecha - 2 * 3_600_000) - 90 * 60_000;
}

export const textoLembreteAssinatura = (nome: string, oQue: string) =>
  `${nome ? `${nome}, c` : 'C'}onseguiu assinar ${oQue} pelo gov.br? Assim que assinar, é só me mandar o PDF assinado por aqui. 😊`;

export async function lembrarAssinaturaGovBr(p: {
  accountId: string; leadId: string; leadName: string; nome: string;
  /** quando o documento pra assinar foi mandado */
  pedidoAt: string;
  /** "a autorização" / "a autorização e a declaração de saúde" */
  oQue: string;
  estado: { lembreteDe?: string; lembretes?: number };
  salvar: (patch: { lembreteDe: string; lembretes: number; lembreteAt: string }) => Promise<unknown>;
  io?: any;
}): Promise<void> {
  if ((p.estado.lembretes || 0) >= MAX_LEMBRETES) return;
  if (Date.now() - Date.parse(p.pedidoAt) < 2 * 3_600_000) return; // acabou de receber o documento
  const ultimaIn = await prisma.message.findFirst({ where: { leadId: p.leadId, direction: 'INBOUND', channel: 'WHATSAPP', deleted: false }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  if (!ultimaIn) return;
  const marca = ultimaIn.createdAt.toISOString();
  if (p.estado.lembreteDe === marca) return; // já lembrou nesta janela
  const fecha = ultimaIn.createdAt.getTime() + 24 * 3_600_000;
  if (Date.now() >= fecha - 15 * 60_000) return; // a janela já fechou (ou está fechando): só template
  if (Date.now() < horaDoLembrete(fecha)) return; // ainda dá tempo: espera chegar perto do fim
  const { inNoticeWindow } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  if (!inNoticeWindow()) return;
  const lead = await prisma.lead.findUnique({ where: { id: p.leadId }, select: { aiAutoReplyActive: true, userId: true, customFields: true } });
  if (!lead || (lead.customFields as any)?._autoPaused) return;
  const texto = textoLembreteAssinatura(p.nome, p.oQue);
  const lembretes = (p.estado.lembretes || 0) + 1;
  const { contractingAutoOn } = require('./contracting-auto.service') as typeof import('./contracting-auto.service');
  const auto = await contractingAutoOn(p.accountId, p.leadId);
  if (!auto || !lead.aiAutoReplyActive) {
    await p.salvar({ lembreteDe: marca, lembretes, lembreteAt: new Date().toISOString() });
    await prisma.note.create({ data: { leadId: p.leadId, type: 'COMMENT', content: `✍️ Santander: o cliente ainda não devolveu ${p.oQue} assinada e a conversa do WhatsApp fecha em breve. ${!lead.aiAutoReplyActive ? 'A IA do card está desligada' : 'A automação da contratação está desligada'}, então o CRM NÃO mandou o lembrete — mande você:\n“${texto}”` } }).catch(() => {});
    try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(p.accountId, { title: `✍️ ${p.leadName}: lembrar de assinar`, body: 'A conversa fecha em breve e o documento do Santander não voltou assinado — texto pronto na anotação.', leadId: p.leadId }, lead.userId ? [lead.userId] : undefined).catch(() => {}); } catch { /* aviso */ }
    return;
  }
  const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
  const r = await sendOutboundWhatsApp({ accountId: p.accountId, leadId: p.leadId, content: texto, io: p.io });
  if (!r.success) return; // tenta no próximo minuto
  await p.salvar({ lembreteDe: marca, lembretes, lembreteAt: new Date().toISOString() });
  await prisma.note.create({ data: { leadId: p.leadId, type: 'COMMENT', content: `✍️ Santander: perguntei ao cliente se já assinou ${p.oQue} pelo gov.br (a conversa fechava em breve; ${lembretes}º lembrete).` } }).catch(() => {});
}
