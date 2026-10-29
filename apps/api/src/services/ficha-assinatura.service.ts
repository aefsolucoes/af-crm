import { prisma } from '../lib/prisma';

/* Ficha do BRB pra assinar (Fabio 29/10: "o BRB precisa assinar agora"; a CAIXA só na contratação). A equipe manda o template de Utilidade
 * `assinatura_ficha_cadastral` ("o banco está solicitando a sua assinatura na ficha cadastral… posso te enviar?") pra reabrir a conversa;
 * na 1ª resposta do cliente o CRM manda a ficha da subpasta FORMULARIOS da pasta do Drive + como assinar pelo gov.br. */

const MARCA_TEMPLATE = 'assinatura na ficha cadastral';
const norm = (s: string) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const INSTRUCOES = `Para assinar pelo gov.br (é gratuito):
1️⃣ Acesse assinador.iti.br e entre com a sua conta gov.br (nível prata ou ouro)
2️⃣ Envie este PDF, clique onde a assinatura deve ficar e assine
3️⃣ Baixe o arquivo assinado e me mande de volta por aqui

Qualquer dúvida, é só me chamar. 😊`;

/** true = tratou (a resposta foi só "pode enviar"/"sim": a IA não responde por cima). */
export async function maybeSendFichaParaAssinar(accountId: string, leadId: string, text: string, io?: any): Promise<boolean> {
  const tpl = await prisma.message.findFirst({ where: { leadId, direction: 'OUTBOUND', content: { contains: MARCA_TEMPLATE }, createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  if (!tpl) return false;
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true } });
  const cf = (lead?.customFields || {}) as Record<string, any>;
  if (cf._fichaAssinar?.enviadaEm && Date.parse(cf._fichaAssinar.enviadaEm) > tpl.createdAt.getTime()) return false; // já mandou depois desse pedido
  const curto = /^(pode( enviar| mandar)?|sim|ok|claro|manda|envia|pode sim|por favor)\b/.test(norm(text)) && norm(text).length <= 40;
  const avisarEquipe = async (motivo: string) => {
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `⚠️ O cliente respondeu ao pedido de assinatura da ficha cadastral, mas ${motivo}. Mande a ficha à mão.` } }).catch(() => {});
    const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
    sendPushToAccount(accountId, { title: `${lead?.name || 'Cliente'}: mandar a ficha pra assinar`, body: motivo, leadId }).catch(() => {});
  };
  const link = String(cf.link_pasta_drive || '').trim();
  if (!link) { await avisarEquipe('o card não tem a pasta do Drive'); return false; }
  const google = await import('./google.service');
  const pastas = await google.listFolders(accountId, google.extractFolderId(link));
  const form = pastas.find((f: any) => norm(f.name) === 'formularios');
  if (!form) { await avisarEquipe('não achei a pasta FORMULARIOS no Drive do cliente'); return false; }
  const arquivos = (await google.listAllFilesInFolderTree(accountId, form.id, 0)).filter((f) => /pdf/.test(f.mimeType));
  const ficha = arquivos.find((f) => /ficha/i.test(f.name) && /brb/i.test(f.name)) || arquivos.find((f) => /ficha/i.test(f.name));
  if (!ficha) { await avisarEquipe('não achei a ficha (PDF) na pasta FORMULARIOS'); return false; }
  const buffer = await google.downloadDriveFile(accountId, ficha.id, ficha.mimeType);
  const { sendOutboundMedia, sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
  const r = await sendOutboundMedia({ accountId, leadId, buffer, fileName: ficha.name, mimeType: 'application/pdf', caption: 'Ficha cadastral do banco para você assinar.', io });
  if (!r.success) { await avisarEquipe(`o envio do PDF falhou (${r.error})`); return false; }
  await new Promise((res) => setTimeout(res, 1500));
  await sendOutboundWhatsApp({ accountId, leadId, content: INSTRUCOES, io });
  const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...((fresh?.customFields || {}) as Record<string, unknown>), _fichaAssinar: { enviadaEm: new Date().toISOString(), fileId: ficha.id, nome: ficha.name } } as any } });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `✍️ Ficha cadastral (${ficha.name}) enviada ao cliente pra assinar pelo gov.br. Quando voltar assinada, guardar em FORMULARIOS ASSINADOS.` } }).catch(() => {});
  return curto;
}

/** Mensagem guardada pra sair na PRÓXIMA resposta do cliente (Fabio 29/10, Jézer: janela fechada → template de atualização; quando ele responder,
 *  vai o recado de verdade). Estado no card: `_msgNaResposta` = { texto, desde, por }. true = mandou (a IA não responde por cima). */
export async function maybeSendMensagemNaResposta(accountId: string, leadId: string, io?: any): Promise<boolean> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  const cf = (lead?.customFields || {}) as Record<string, any>;
  const m = cf._msgNaResposta;
  if (!m?.texto || !m?.desde) return false;
  const { _msgNaResposta, ...resto } = cf;
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: resto as any } }); // antes de enviar: nunca manda duas vezes
  if (Date.now() - Date.parse(m.desde) > 7 * 86_400_000) return false; // recado velho: descarta
  const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
  const r = await sendOutboundWhatsApp({ accountId, leadId, content: String(m.texto), userId: m.userId || undefined, io });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: r.success ? `✉️ Recado guardado enviado quando o cliente respondeu: "${String(m.texto).slice(0, 300)}"` : `⚠️ O cliente respondeu, mas o recado guardado não saiu (${(r as any).error}). Mande à mão: "${String(m.texto).slice(0, 300)}"` } }).catch(() => {});
  return !!r.success;
}
