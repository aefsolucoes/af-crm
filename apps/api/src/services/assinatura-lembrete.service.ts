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

// ─── Conversa FECHADA (Fabio 14/11: "quando fechar a conversa devemos criar um template de utilidade para encaminhar ao cliente de 2 em 2 dias ou para quando ele falar que irá
// encaminhar em uma data, agendar e cobrar ele naquela data ou horário; caso ele não mande, a gente aguardar 2 dias e reencaminhar o template solicitando a documentação") ───
//  • o cliente disse QUANDO assina/manda ("amanhã", "sexta", "dia 20", "às 16h") → cobra nessa hora (07h–21h): conversa aberta = texto; fechada = template;
//  • sem prazo combinado e a conversa fechada → template de utilidade a cada 2 dias (contados do fechamento, do último template ou da cobrança combinada), no máximo MAX_TEMPLATES;
//  • automação da contratação ou IA do card desligada / template ainda não aprovado pela Meta → nota + push pra equipe (no mesmo ritmo), com o que mandar.

/** Template de utilidade (Meta) da cobrança da assinatura — {{1}} = primeiro nome; {{2}} = "a autorização" / "a autorização e a declaração de saúde". */
export const ASSINATURA_TEMPLATE = 'assinatura_govbr_pendente';
export const ASSINATURA_TEMPLATE_BODY = 'Oi {{1}}, tudo bem? Para seguirmos com a vistoria do imóvel no Santander, ainda falta assinar pelo gov.br {{2}} que te enviamos. Assim que assinar, é só nos mandar o PDF assinado por aqui.'; // botões: "Já assinei" / "Tenho uma dúvida"
const COBRANCA_MS = 2 * 86_400_000;
const MAX_TEMPLATES = 5;
const JANELA_MS = 24 * 3_600_000;

export type CobrancaAss = {
  tplAt?: string; tpls?: number; equipeAt?: string; fimNotaAt?: string;
  /** prazo dito pelo cliente: quando cobrar, o que ele disse e a mensagem (createdAt) de onde saiu */
  prazo?: { at: string; said: string; de: string; cobradoAt?: string };
};

const textoTemplate = (nome: string, oQue: string) => ASSINATURA_TEMPLATE_BODY.replace('{{1}}', nome).replace('{{2}}', oQue);
const nomeDoTemplate = (nome: string, leadName: string) => { const n = (nome || String(leadName || '').trim().split(/\s+/)[0] || '').trim(); return n ? n.charAt(0).toUpperCase() + n.slice(1).toLowerCase() : 'cliente'; };

let tplCache: { at: number; ok: boolean } | null = null;
async function templateAprovado(accountId: string): Promise<boolean> {
  if (tplCache && Date.now() - tplCache.at < 10 * 60_000) return tplCache.ok;
  try {
    const { listMetaTemplates } = require('./whatsapp.service') as typeof import('./whatsapp.service');
    const t = (await listMetaTemplates(accountId)).find((x: any) => x.name === ASSINATURA_TEMPLATE && x.language === 'pt_BR');
    tplCache = { at: Date.now(), ok: t?.status === 'APPROVED' };
  } catch { tplCache = { at: Date.now(), ok: false }; }
  return tplCache.ok;
}

const PRAZO_RX = /\b(hoje|amanh[ãa]|depois de amanh[ãa]|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo|semana que vem|pr[óo]xima semana|fim de semana|final de semana|fim do m[êe]s|dia \d{1,2}|\d{1,2}\/\d{1,2}|mais tarde|[àa] noite|[àa] tarde|de manh[ãa])\b/i;
const ACAO_RX = /(assin|mand|envi|encaminh|fa[çc]o|fazer|consigo|resolv|vejo|providenci|retorn)/i;
const NEGA_RX = /(n[ãa]o (tenho|quero|vou) (mais )?(interesse|seguir|continuar)|desist|cancel)/i;

/** O cliente disse QUANDO assina/manda? Lê as mensagens de texto dele depois do pedido (as mais novas primeiro); `jaLido` = a última de onde já saiu um prazo. */
export async function prazoDoCliente(leadId: string, desde: string, jaLido?: string): Promise<CobrancaAss['prazo'] | null> {
  const { TIME_RX, promisedAt } = require('./docs-checker.service') as typeof import('./docs-checker.service');
  const corte = new Date(Math.max(Date.parse(desde), jaLido ? Date.parse(jaLido) + 1 : 0));
  const msgs = await prisma.message.findMany({ where: { leadId, direction: 'INBOUND', channel: 'WHATSAPP', deleted: false, createdAt: { gt: corte } }, orderBy: { createdAt: 'desc' }, take: 6, select: { content: true, createdAt: true } });
  for (const m of msgs) {
    const t = String(m.content || '').trim();
    if (!t || t.length > 300 || t.startsWith('📎') || NEGA_RX.test(t)) continue;
    if (!(TIME_RX.test(t) || PRAZO_RX.test(t))) continue;
    if (!ACAO_RX.test(t) && t.length > 30) continue; // resposta curta só com o prazo ("amanhã", "sexta à noite") vale; frase longa precisa falar de assinar/mandar
    return { at: promisedAt(t, m.createdAt).toISOString(), said: t.slice(0, 120), de: m.createdAt.toISOString() };
  }
  return null;
}

const quando = (iso: string) => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export async function lembrarAssinaturaGovBr(p: {
  accountId: string; leadId: string; leadName: string; nome: string;
  /** quando o documento pra assinar foi mandado */
  pedidoAt: string;
  /** "a autorização" / "a autorização e a declaração de saúde" */
  oQue: string;
  estado: { lembreteDe?: string; lembretes?: number; lembreteAt?: string; cobrancaAss?: CobrancaAss };
  salvar: (patch: { lembreteDe?: string; lembretes?: number; lembreteAt?: string; cobrancaAss?: CobrancaAss }) => Promise<unknown>;
  io?: any;
}): Promise<void> {
  if (Date.now() - Date.parse(p.pedidoAt) < 2 * 3_600_000) return; // acabou de receber o documento
  const lead = await prisma.lead.findUnique({ where: { id: p.leadId }, select: { aiAutoReplyActive: true, userId: true, customFields: true } });
  if (!lead || (lead.customFields as any)?._autoPaused) return;
  const ultimaIn = await prisma.message.findFirst({ where: { leadId: p.leadId, direction: 'INBOUND', channel: 'WHATSAPP', deleted: false }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  const fecha = (ultimaIn ? ultimaIn.createdAt.getTime() : Date.parse(p.pedidoAt)) + JANELA_MS;
  const aberta = !!ultimaIn && Date.now() < fecha - 15 * 60_000;
  const { inNoticeWindow } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  const { contractingAutoOn } = require('./contracting-auto.service') as typeof import('./contracting-auto.service');
  const cob: CobrancaAss = { ...(p.estado.cobrancaAss || {}) };
  const avisaEquipe = async (oQueFazer: string, motivo: string) => {
    await prisma.note.create({ data: { leadId: p.leadId, type: 'COMMENT', content: `✍️ Santander: o cliente ainda não devolveu ${p.oQue} assinada. ${motivo}, então o CRM NÃO mandou — ${oQueFazer}` } }).catch(() => {});
    try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(p.accountId, { title: `✍️ ${p.leadName}: cobrar a assinatura`, body: `O documento do Santander não voltou assinado — ${motivo.toLowerCase()}.`, leadId: p.leadId }, lead.userId ? [lead.userId] : undefined).catch(() => {}); } catch { /* aviso */ }
  };
  const motivoSemEnvio = async (): Promise<string | null> => {
    if (!lead.aiAutoReplyActive) return 'A IA do card está desligada';
    if (!(await contractingAutoOn(p.accountId, p.leadId))) return 'A automação da contratação está desligada';
    return null;
  };
  /** Template da cobrança (conversa fechada). true = resolvido (mandou ou avisou a equipe). */
  const mandarTemplate = async (porque: string): Promise<boolean> => {
    const motivo = (await motivoSemEnvio()) || (!(await templateAprovado(p.accountId)) ? `O template "${ASSINATURA_TEMPLATE}" ainda não foi aprovado pela Meta` : null);
    const nomeT = nomeDoTemplate(p.nome, p.leadName);
    const preview = textoTemplate(nomeT, p.oQue);
    if (motivo) { cob.equipeAt = new Date().toISOString(); await avisaEquipe(`a conversa está fechada: mande um template pedindo a assinatura (${porque}). Texto do template:\n“${preview}”`, motivo); return true; }
    const { sendOutboundWhatsAppTemplate } = require('./message.service') as typeof import('./message.service');
    const r = await sendOutboundWhatsAppTemplate({ accountId: p.accountId, leadId: p.leadId, templateName: ASSINATURA_TEMPLATE, language: 'pt_BR', bodyParams: [nomeT, p.oQue], previewText: preview, io: p.io });
    if (!r.success) { console.warn(`[Assinatura] template não saiu (${p.leadId}): ${r.error}`); return false; }
    cob.tplAt = new Date().toISOString(); cob.tpls = (cob.tpls || 0) + 1;
    await prisma.note.create({ data: { leadId: p.leadId, type: 'COMMENT', content: `✍️ Santander: a conversa estava fechada — mandei o template "${ASSINATURA_TEMPLATE}" pedindo ${p.oQue} assinada (${porque}; ${cob.tpls}º).` } }).catch(() => {});
    return true;
  };

  // 1) O cliente disse quando assina/manda: guarda o prazo (a mensagem mais nova vale).
  const novo = await prazoDoCliente(p.leadId, p.pedidoAt, cob.prazo?.de);
  if (novo) {
    cob.prazo = novo;
    await p.salvar({ cobrancaAss: cob });
    await prisma.note.create({ data: { leadId: p.leadId, type: 'COMMENT', content: `⏰ Santander: o cliente disse quando assina/manda ${p.oQue} ("${novo.said}"). O CRM cobra em ${quando(novo.at)}${Date.parse(novo.at) < fecha ? ' pela conversa' : ' (com a conversa fechada, pelo template)'}; se não vier, reenvia o template a cada 2 dias.` } }).catch(() => {});
  }

  // 2) Chegou a hora combinada: cobra (texto com a conversa aberta; template com ela fechada).
  if (cob.prazo && !cob.prazo.cobradoAt) {
    if (Date.now() < Date.parse(cob.prazo.at) || !inNoticeWindow()) return; // espera a hora (e o horário 07h–21h); nada de lembrete por cima do combinado
    let resolvido = false;
    if (aberta) {
      const texto = textoLembreteAssinatura(p.nome, p.oQue);
      const motivo = await motivoSemEnvio();
      if (motivo) { cob.equipeAt = new Date().toISOString(); await avisaEquipe(`chegou a hora que ele combinou ("${cob.prazo.said}"); mande você:\n“${texto}”`, motivo); resolvido = true; }
      else {
        const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
        const r = await sendOutboundWhatsApp({ accountId: p.accountId, leadId: p.leadId, content: texto, io: p.io });
        if (r.success) { resolvido = true; await prisma.note.create({ data: { leadId: p.leadId, type: 'COMMENT', content: `✍️ Santander: cobrei a assinatura na hora que o cliente combinou ("${cob.prazo.said}").` } }).catch(() => {}); }
      }
    } else resolvido = await mandarTemplate(`hora combinada com o cliente: "${cob.prazo.said}"`);
    if (!resolvido) return; // tenta no próximo minuto
    cob.prazo = { ...cob.prazo, cobradoAt: new Date().toISOString() };
    await p.salvar({ cobrancaAss: cob });
    return;
  }

  // 3) Conversa aberta: "já assinou?" antes de fechar (13/11).
  if (aberta) { await lembreteAntesDeFechar(p, ultimaIn!.createdAt, fecha, lead, avisaEquipe, motivoSemEnvio); return; }

  // 4) Conversa fechada: template a cada 2 dias (do fechamento, do último template/aviso ou da cobrança combinada).
  const base = Math.max(fecha, cob.tplAt ? Date.parse(cob.tplAt) : 0, cob.equipeAt ? Date.parse(cob.equipeAt) : 0, cob.prazo?.cobradoAt ? Date.parse(cob.prazo.cobradoAt) : 0);
  if (Date.now() < base + COBRANCA_MS || !inNoticeWindow()) return;
  if ((cob.tpls || 0) >= MAX_TEMPLATES) {
    if (!cob.fimNotaAt) {
      cob.fimNotaAt = new Date().toISOString();
      await p.salvar({ cobrancaAss: cob });
      await avisaEquipe(`já foram ${MAX_TEMPLATES} templates sem resposta: ligue pro cliente ou combine outro caminho.`, 'O limite de cobranças automáticas chegou');
    }
    return;
  }
  if (await mandarTemplate(cob.tplAt || cob.equipeAt ? 'mais 2 dias sem a assinatura' : 'a conversa fechou sem a assinatura')) await p.salvar({ cobrancaAss: cob });
}

async function lembreteAntesDeFechar(
  p: Parameters<typeof lembrarAssinaturaGovBr>[0], ultimaIn: Date, fecha: number,
  lead: { aiAutoReplyActive: boolean; userId: string | null },
  avisaEquipe: (oQueFazer: string, motivo: string) => Promise<void>, motivoSemEnvio: () => Promise<string | null>,
): Promise<void> {
  if ((p.estado.lembretes || 0) >= MAX_LEMBRETES) return;
  const marca = ultimaIn.toISOString();
  if (p.estado.lembreteDe === marca) return; // já lembrou nesta janela
  if (Date.now() < horaDoLembrete(fecha)) return; // ainda dá tempo: espera chegar perto do fim
  const { inNoticeWindow } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  if (!inNoticeWindow()) return;
  const texto = textoLembreteAssinatura(p.nome, p.oQue);
  const lembretes = (p.estado.lembretes || 0) + 1;
  const motivo = await motivoSemEnvio();
  if (motivo) {
    await p.salvar({ lembreteDe: marca, lembretes, lembreteAt: new Date().toISOString() });
    await avisaEquipe(`a conversa do WhatsApp fecha em breve; mande você:\n“${texto}”`, motivo);
    return;
  }
  const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
  const r = await sendOutboundWhatsApp({ accountId: p.accountId, leadId: p.leadId, content: texto, io: p.io });
  if (!r.success) return; // tenta no próximo minuto
  await p.salvar({ lembreteDe: marca, lembretes, lembreteAt: new Date().toISOString() });
  await prisma.note.create({ data: { leadId: p.leadId, type: 'COMMENT', content: `✍️ Santander: perguntei ao cliente se já assinou ${p.oQue} pelo gov.br (a conversa fechava em breve; ${lembretes}º lembrete).` } }).catch(() => {});
}
