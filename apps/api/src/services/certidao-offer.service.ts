import { prisma } from '../lib/prisma';
import { createCertidaoRequest } from './certidao.service';

type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | null | undefined;

/**
 * ESCRITURA → MATRÍCULA → ONR (Fabio 20/10, Luiz Fernando). O cliente manda a escritura (traz o número da matrícula e o cartório) em vez da certidão de ônus/matrícula:
 *  1) a conferência dos documentos acha a matrícula e a cidade/UF na escritura (`certidaoFromDocs`);
 *  2) a IA SE OFERECE pra emitir pelo ONR ("custo entre R$ 40 e R$ 100, eu te mando o PIX") — UMA vez por matrícula (`maybeOfferCertidao`);
 *  3) QUANDO O CLIENTE ACEITA ("sim, pode"), é nesse momento que a extensão do ONR é acionada: cria o CertidaoRequest (`ensureCertidaoRequest`), a extensão pede no RI Digital, captura o PIX e o CRM manda o PIX ao cliente;
 *  4) recusa ("prefiro tirar no cartório") só anota. A A&F NUNCA emite sem esse OK (regra de 15/10).
 * O cartório vai como 'AUTO': a extensão escolhe o único cartório da cidade (se houver mais de um, ela avisa as opções e não conclui).
 */

const AUTORIZOU_EMISSAO = '🏛️ CLIENTE AUTORIZOU A EMISSÃO DA CERTIDÃO'; // mesmo marcador do docs-checker (a conferência lê)
const digits = (v: unknown) => String(v ?? '').replace(/\D/g, '');
const note = (leadId: string, content: string) => prisma.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});

/** Cidade e UF de um texto como "Ofício de Registro de Imóveis da Comarca de Itapema/SC" ou "…, Bairro Meia Praia, Itapema/SC". Pura (testável). */
export function cidadeUfDe(txt: string): { cidade: string; uf: string } | null {
  const m = /\/\s*([A-Z]{2})\b/.exec(String(txt || ''));
  if (!m) return null;
  let antes = String(txt).slice(0, m.index).replace(/[.\s]+$/, '');
  if (/\b(?:comarca|munic[ií]pio|cidade)\s+(?:de|do|da)\s+/i.test(antes)) antes = antes.replace(/^.*\b(?:comarca|munic[ií]pio|cidade)\s+(?:de|do|da)\s+/i, '');
  else { const reg = /^.*\b(?:im[óo]veis|registro|of[íi]cio|cart[óo]rio)\s+(?:de|do|da)\s+(.+)$/i.exec(antes); if (reg) antes = reg[1]; }
  antes = (antes.split(/[,;–-]/).pop() || '').trim().replace(/^(?:de|do|da)\s+/i, '');
  if (antes.length < 2 || antes.length > 40) return null;
  return { cidade: antes, uf: m[1] };
}

type Rev = { tipo?: string; resultado?: string; matricula?: string; cartorio?: string; endereco?: string; encerrada?: unknown };

/** O cliente já tem em mãos certidão de ônus/matrícula do cartório que vale? Pura. */
export function temCertidaoEmMaos(cf: Record<string, any>): boolean {
  const revs = Object.values((cf._docReview || {}) as Record<string, Rev>);
  return revs.some((r) => /^(MATRICULA|CERTIDAO DE ONUS)/.test(String(r?.tipo || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '')) && r.resultado !== 'PROBLEMA' && !r.encerrada);
}

/** Matrícula + cartório + cidade/UF lidos nos documentos do cliente (escritura, IPTU, cadastro). null se não der pra pedir. Pura. */
export function certidaoFromDocs(cf: Record<string, any>): { matricula: string; cartorio: string; cidade: string; uf: string } | null {
  const revs = (Object.values((cf._docReview || {}) as Record<string, Rev>) as Rev[]).filter((r) => r && r.resultado !== 'NAO_DOCUMENTO');
  const comMat = revs.filter((r) => digits(r.matricula).length >= 1 && digits(r.matricula).length <= 12);
  if (!comMat.length) return null;
  // prefere a escritura (traz matrícula + cartório); senão qualquer documento do imóvel que cite a matrícula
  const ordenado = [...comMat].sort((a, b) => (/ESCRITURA/.test(String(b.tipo)) ? 1 : 0) - (/ESCRITURA/.test(String(a.tipo)) ? 1 : 0));
  for (const r of ordenado) {
    const cu = cidadeUfDe(String(r.cartorio || '')) || cidadeUfDe(String(r.endereco || ''));
    if (cu) return { matricula: digits(r.matricula), cartorio: 'AUTO', cidade: cu.cidade, uf: cu.uf };
  }
  return null;
}

export function certidaoOfferText(nome: string | null, saudar: boolean, matricula: string): string {
  return `${saudar ? `Oi${nome ? `, ${nome}` : ''}! ` : ''}Recebi a escritura do imóvel e já identifiquei a matrícula (nº ${matricula}). A certidão de ônus/matrícula é essencial pro banco, e a A&F consegue emitir por meio digital, pelo ONR. Tem um custo pra você, entre R$ 40 e R$ 100, e eu te mando o PIX pra pagamento. Posso solicitar a certidão pra você? Se preferir tirar direto no cartório, sem problema.`;
}

async function carrega(leadId: string) {
  return prisma.lead.findUnique({ where: { id: leadId }, select: { id: true, name: true, accountId: true, aiAutoReplyActive: true, customFields: true, stage: { select: { name: true } }, pipeline: { select: { department: { select: { name: true } } } } } });
}
async function salvaOferta(leadId: string, patch: Record<string, unknown>) {
  const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cf = { ...((fresh?.customFields || {}) as Record<string, any>) };
  cf._certidaoOffer = { ...(cf._certidaoOffer || {}), ...patch };
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: cf as any } });
}

/** A IA oferece a emissão (uma vez por matrícula). Só Home Equity em "Aguardando Documentação", IA do card ligada, sem STOP TOTAL, 07h–21h e janela de 24 h aberta (senão tenta de novo na próxima conferência). */
export async function maybeOfferCertidao(accountId: string, leadId: string, io: Io): Promise<boolean> {
  const lead = await carrega(leadId);
  if (!lead || lead.accountId !== accountId) return false;
  const cf = (lead.customFields || {}) as Record<string, any>;
  if (cf._autoPaused || !lead.aiAutoReplyActive) return false;
  if (!/aguardando document/i.test((lead.stage?.name || '').normalize('NFD').replace(/[̀-ͯ]/g, ''))) return false;
  if (!/home equity/i.test(lead.pipeline?.department?.name || '')) return false;
  if (temCertidaoEmMaos(cf)) return false;
  const d = certidaoFromDocs(cf);
  if (!d) return false;
  const oferta = cf._certidaoOffer as { matricula?: string; at?: string } | undefined;
  if (oferta?.matricula === d.matricula) return false; // já ofereci (aceitou, recusou ou está esperando a resposta)
  const ativo = await prisma.certidaoRequest.findFirst({ where: { leadId, matricula: d.matricula, status: { notIn: ['CANCELLED', 'FAILED'] } }, select: { id: true } });
  if (ativo) return false;
  const { inNoticeWindow, whatsappWindowOpen, conversationActive } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  if (!inNoticeWindow() || !(await whatsappWindowOpen(leadId))) return false;
  const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
  const nome = callableFirstName(cf.participante_1, lead.name) || null;
  const texto = certidaoOfferText(nome, !(await conversationActive(leadId)), d.matricula);
  const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
  const r = await sendOutboundWhatsApp({ accountId, leadId, content: texto, io: (io || undefined) as any });
  if (!r.success) return false;
  await salvaOferta(leadId, { matricula: d.matricula, cidade: d.cidade, uf: d.uf, at: new Date().toISOString() });
  await note(leadId, `🏛️ O cliente mandou a escritura (matrícula ${d.matricula}, ${d.cidade}/${d.uf}) e não a certidão de ônus. Ofereci emitir pelo ONR (custo R$ 40 a R$ 100, PIX pra ele). Quando ele aceitar, a extensão do ONR é acionada sozinha.`);
  return true;
}

/** Cria o pedido no ONR (a extensão pega na fila): chamado quando o cliente aceitou. Uma vez por matrícula. */
export async function ensureCertidaoRequest(accountId: string, leadId: string): Promise<{ created: boolean; why?: string }> {
  const lead = await carrega(leadId);
  if (!lead || lead.accountId !== accountId) return { created: false, why: 'lead não encontrado' };
  const cf = (lead.customFields || {}) as Record<string, any>;
  const d = certidaoFromDocs(cf);
  if (!d) return { created: false, why: 'não achei matrícula e cidade/UF nos documentos' };
  const existente = await prisma.certidaoRequest.findFirst({ where: { leadId, matricula: d.matricula, status: { notIn: ['CANCELLED', 'FAILED'] } }, select: { id: true } });
  if (existente) return { created: false, why: 'já existe pedido pra esta matrícula' };
  try {
    const out = await createCertidaoRequest(prisma, { accountId, leadId, uf: d.uf, cidade: d.cidade, cartorio: d.cartorio, matricula: d.matricula, source: 'AI' });
    return { created: !out.duplicate };
  } catch (e: any) {
    await note(leadId, `⚠️ O cliente autorizou a emissão da certidão, mas não consegui criar o pedido no ONR: ${e?.message || e}. Peça pelo botão da certidão no card.`);
    return { created: false, why: String(e?.message || e) };
  }
}

/** Mensagem do cliente depois da oferta: aceitou? Aceitou → autorização anotada + extensão do ONR acionada. Roda a cada texto inbound, mas só gasta IA enquanto há oferta esperando resposta. */
export async function checkCertidaoAcceptance(accountId: string, leadId: string, text: string, io: Io): Promise<void> {
  const clean = String(text || '').trim();
  if (!clean || clean.length > 400) return;
  const lead = await carrega(leadId);
  if (!lead || lead.accountId !== accountId) return;
  const cf = (lead.customFields || {}) as Record<string, any>;
  const of = cf._certidaoOffer as { matricula?: string; at?: string; acceptedAt?: string; declinedAt?: string } | undefined;
  if (!of?.at || of.acceptedAt || of.declinedAt || cf._autoPaused) return;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-5', max_tokens: 1000,
      system: 'A atendente de um correspondente bancário ofereceu ao cliente emitir a certidão de ônus/matrícula do imóvel pelo ONR (custo de R$ 40 a R$ 100, com PIX). Leia a RESPOSTA do cliente e classifique. Responda SÓ JSON: {"r":"SIM"|"NAO"|"INDEFINIDO"}. SIM = aceitou/autorizou (ex.: "pode", "sim", "pode emitir", "ok", "manda o pix"). NAO = recusou ou prefere tirar sozinho no cartório. INDEFINIDO = pergunta, dúvida, assunto diferente ou resposta que não decide.',
      messages: [{ role: 'user', content: `OFERTA: emitir a certidão da matrícula ${of.matricula} pelo ONR (R$ 40 a R$ 100, PIX).\nRESPOSTA DO CLIENTE: ${clean}` }],
    }),
  }).catch(() => null);
  if (!res?.ok) return;
  const d: any = await res.json().catch(() => null);
  const raw = String(d?.content?.find((b: any) => b.type === 'text')?.text || '');
  let r = 'INDEFINIDO';
  try { r = String(JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{}').r || 'INDEFINIDO').toUpperCase(); } catch { /* indefinido */ }
  if (r === 'NAO') {
    await salvaOferta(leadId, { declinedAt: new Date().toISOString() });
    await note(leadId, `🏛️ O cliente NÃO quer que a A&F emita a certidão ("${clean.slice(0, 120)}"): ele prefere tirar direto no cartório. Nada foi pedido no ONR.`);
    return;
  }
  if (r !== 'SIM') return;
  await salvaOferta(leadId, { acceptedAt: new Date().toISOString() });
  await note(leadId, `${AUTORIZOU_EMISSAO} — o cliente aceitou a oferta ("${clean.slice(0, 120)}"): a A&F emite pelo ONR (custo de R$ 40 a R$ 100 pra ele, PIX enviado a ele).`);
  const out = await ensureCertidaoRequest(accountId, leadId);
  if (out.created) io?.to(`account_${accountId}`).emit('certidao_updated', { leadId });
  else if (out.why) console.warn(`[Certidão] ${lead.name}: aceitou, mas o pedido não foi criado — ${out.why}`);
}
