import { prisma } from '../lib/prisma';
import { sendOutboundWhatsApp } from './message.service';
import { contractingAutoOn } from './contracting-auto.service';

type Io = Parameters<typeof sendOutboundWhatsApp>[0]['io'];

/**
 * TERMO DE QUITAÇÃO + ALIENAÇÃO FIDUCIÁRIA AINDA NA MATRÍCULA → PEDIR A AVERBAÇÃO (Fabio 21/10, caso Edson do Carmo: a matrícula mostrava a alienação fiduciária da Caixa vigente e o cliente mandou o termo de
 * quitação da Caixa: "o CRM precisa identificar isso e solicitar ao cliente que seja averbado na certidão de ônus"; regra que ele já tinha dado: o termo NÃO substitui a certidão de ônus — pergunta se a baixa
 * já foi averbada e, se não, a averbação pode andar junto com o processo do crédito).
 * Detecta pela leitura dos documentos (cf._docReview): um TERMO DE QUITAÇÃO e uma matrícula/certidão de ônus com gravame (alienação fiduciária/hipoteca) vigente. Uma vez por card:
 *  - IA do card ligada + janela de 24 h aberta + 07h–21h → manda a mensagem ao cliente;
 *  - senão → nota + push à equipe com o texto pronto (IA desligada nunca manda sozinha).
 * Se o termo cita uma matrícula diferente da certidão, a nota avisa a equipe pra conferir se é o mesmo imóvel. Só vale para termos recebidos a partir de QUITACAO_FROM (não mexe em cliente antigo).
 */

export const QUITACAO_FROM = new Date('2026-10-21T00:00:00Z');

const norm = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
const soDigitos = (s: unknown) => String(s ?? '').replace(/\D/g, '');

export function matriculaDivergenteText(atual: string, correta: string): string {
  return `A certidão de ônus que você mandou é da matrícula ${atual}, mas o termo de quitação cita a matrícula ${correta}. Provavelmente a certidão é antiga (pode ter havido transporte de matrícula, matrícula-mãe ou matrícula nova). Preciso de uma certidão atualizada da matrícula correta (nº ${correta}). Se quiser, eu emito pelo cartório digital pra você: é só me autorizar.`;
}

export function quitacaoAverbarText(credor: string, cartorio: string): string {
  return [
    `Vi que você mandou o termo de quitação${credor ? ` ${credor}` : ''}. Esse termo só autoriza o cartório a dar baixa na alienação fiduciária: pra valer no crédito, a baixa precisa estar averbada na matrícula do imóvel e aparecer na certidão de ônus.`,
    '',
    `Já foi averbada? Se ainda não, leve o termo ao Cartório de Registro de Imóveis${cartorio ? ` (${cartorio})` : ''} pra fazer a averbação — dá pra fazer junto com o processo do crédito. Quando sair, me manda a certidão de ônus atualizada mostrando a baixa.`,
  ].join('\n');
}

type Rev = { tipo?: string; gravame?: string; cartorio?: string; matricula?: string; resultado?: string };

/** Acha, nas leituras do card, o termo de quitação e a matrícula/certidão com gravame vigente. Pura (testável). */
export function acharQuitacao(reviews: Record<string, Rev>): { termoId: string; termo: Rev; mat: Rev } | null {
  const entradas = Object.entries(reviews || {});
  const termo = entradas.find(([, r]) => /QUITACAO/.test(norm(r?.tipo)));
  if (!termo) return null;
  const mats = entradas.filter(([, r]) => /MATRICULA|ONUS/.test(norm(r?.tipo)) && String(r?.gravame || '').trim() && !/CANCELAD|BAIXAD|BAIXA AVERBADA/.test(norm(r?.gravame)));
  if (!mats.length) return null;
  return { termoId: termo[0], termo: termo[1], mat: mats[mats.length - 1][1] };
}

async function marca(leadId: string, valor: Record<string, unknown>) {
  const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...((fresh?.customFields || {}) as Record<string, any>), _quitacaoAverbar: valor } as any } });
}

export async function processQuitacaoAverbar(accountId: string, io: Io): Promise<void> {
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT l.id FROM "Lead" l
    JOIN "Pipeline" p ON p.id = l."pipelineId" JOIN "Department" d ON d.id = p."departmentId"
    WHERE l."accountId" = ${accountId} AND l.status = 'OPEN' AND l.archived = false AND l."isGroup" = false
      AND d.name ILIKE '%home equity%'
      AND NOT jsonb_exists(COALESCE(l."customFields", '{}'::jsonb), '_quitacaoAverbar')
      AND COALESCE(l."customFields"->>'_docReview', '') ILIKE '%QUITA%'
    LIMIT 20`;
  for (const { id } of ids) {
    try { await uma(accountId, id, io); } catch (e: any) { console.warn('[Quitação]', e?.message); }
  }
}

async function uma(accountId: string, leadId: string, io: Io): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { id: true, name: true, aiAutoReplyActive: true, customFields: true } });
  if (!lead) return;
  const cf = (lead.customFields || {}) as Record<string, any>;
  if (cf._autoPaused || cf._quitacaoAverbar) return;
  const achou = acharQuitacao((cf._docReview || {}) as Record<string, Rev>);
  if (!achou) return; // sem termo ou sem gravame vigente na matrícula: nada a pedir (tenta de novo quando chegar leitura nova)
  const termoAtt = await prisma.messageAttachment.findUnique({ where: { id: achou.termoId }, select: { createdAt: true } });
  if (!termoAtt || termoAtt.createdAt < QUITACAO_FROM) { await marca(leadId, { skip: 'termo anterior à regra', at: new Date().toISOString() }); return; }
  // a equipe ou a IA da conversa já tratou do assunto nos últimos dias
  const jaFalou = await prisma.message.count({ where: { leadId, direction: 'OUTBOUND', createdAt: { gte: new Date(Date.now() - 3 * 86_400_000) }, OR: [{ content: { contains: 'averbad', mode: 'insensitive' } }, { content: { contains: 'baixa da aliena', mode: 'insensitive' } }] } });
  if (jaFalou > 0) { await marca(leadId, { skip: 'a conversa já tratou da averbação', at: new Date().toISOString() }); return; }

  const credor = /CAIXA/.test(norm(achou.mat.gravame)) ? 'da Caixa' : '';
  const cartorioTxt = String(achou.termo.cartorio || achou.mat.cartorio || '').replace(/…$/, '').trim();
  const mTermo = soDigitos(achou.termo.matricula), mCert = soDigitos(achou.mat.matricula);
  const divergente = !!mTermo && !!mCert && mTermo !== mCert;
  let textoAverbar = quitacaoAverbarText(credor, cartorioTxt);
  let aviso = '';
  let gravaDivergencia = async (_comOferta: boolean): Promise<void> => {};
  if (divergente) {
    // cidade da comarca (do termo) + UF do imóvel (proposta do site): necessários pra pedir a certidão nova no ONR
    const prop = await prisma.message.findFirst({ where: { leadId, direction: 'INBOUND', content: { contains: 'Proposta preenchida no site' } }, orderBy: { createdAt: 'desc' }, select: { content: true } });
    const garantia = (/Im[oó]vel em garantia:\s*([^\n]+)/i.exec(prop?.content || '') || [])[1] || '';
    const uf = (/\/\s*([A-Za-z]{2})\s*$/.exec(garantia) || [])[1]?.toUpperCase() || '';
    const cidade = ((/comarca\s+(?:de|do|da)?\s*(.+)$/i.exec(cartorioTxt) || [])[1] || garantia.replace(/\s*\/\s*[A-Za-z]{2}\s*$/, '')).trim();
    // Só grava depois que o cliente foi avisado (ou a equipe): a oferta de emitir só vale a partir do momento em que a pergunta saiu.
    gravaDivergencia = async (comOferta: boolean) => {
      const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
      const cf2: Record<string, any> = { ...((fresh?.customFields || {}) as Record<string, any>) };
      cf2._matriculaDivergente = { atual: achou.mat.matricula, correta: achou.termo.matricula, cidade, uf, cartorio: cartorioTxt, at: new Date().toISOString() };
      if (comOferta && cidade && uf && !(cf2._certidaoOffer && (cf2._certidaoOffer as any).matricula === soDigitos(achou.termo.matricula))) cf2._certidaoOffer = { matricula: soDigitos(achou.termo.matricula), cidade, uf, at: new Date().toISOString() };
      await prisma.lead.update({ where: { id: leadId }, data: { customFields: cf2 as any } });
    };
    textoAverbar = `${matriculaDivergenteText(String(achou.mat.matricula), String(achou.termo.matricula))}\n\n${textoAverbar}`;
    aviso = `\n⚠️ A certidão do cliente é da matrícula ${achou.mat.matricula} e o termo cita a ${achou.termo.matricula} (provável: certidão antiga, transporte, matrícula-mãe ou matrícula nova). Precisa de certidão da matrícula correta${cidade && uf ? ` (${cidade}/${uf})` : ' (faltou cidade/UF: peça pelo botão da certidão)'}.`;
  }
  const texto = textoAverbar;
  const push = () => { try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title: '🏛️ Pedir averbação da quitação', body: `${lead.name}: termo de quitação enviado, alienação ainda na matrícula`, leadId }).catch(() => {}); } catch { /* aviso */ } };

  if (lead.aiAutoReplyActive && (await contractingAutoOn(accountId))) {
    const { inNoticeWindow, whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
    if (!inNoticeWindow() || !(await whatsappWindowOpen(leadId))) return; // tenta de novo no próximo minuto
    const r = await sendOutboundWhatsApp({ accountId, leadId, content: texto, io: io as any });
    if (!r.success) return;
    await gravaDivergencia(true);
    await marca(leadId, { askedAt: new Date().toISOString(), termoMatricula: achou.termo.matricula || '', certidaoMatricula: achou.mat.matricula || '' });
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🏛️ O cliente mandou o termo de quitação e a matrícula ainda mostra a alienação fiduciária (${achou.mat.gravame}). Pedi a ele que averbe a baixa no cartório e mande a certidão de ônus atualizada.${aviso}` } }).catch(() => {});
    return;
  }
  await gravaDivergencia(false);
  await marca(leadId, { teamAt: new Date().toISOString(), por: lead.aiAutoReplyActive ? 'equipe (automação da contratação desligada)' : 'equipe (IA do card desligada)', termoMatricula: achou.termo.matricula || '', certidaoMatricula: achou.mat.matricula || '' });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🏛️ O cliente mandou o termo de quitação e a matrícula ainda mostra a alienação fiduciária (${achou.mat.gravame}). ${lead.aiAutoReplyActive ? 'Passo manual (automação da contratação desligada)' : 'IA do card desligada'}: peça ao cliente que averbe a baixa no cartório e mande a certidão de ônus atualizada. Texto pronto:\n“${texto.replace(/\n+/g, ' ')}”${aviso}` } }).catch(() => {});
  push();
}
