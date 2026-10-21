import { prisma } from '../lib/prisma';
import { createCertidaoRequest } from './certidao.service';

type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | null | undefined;

/**
 * ESCRITURA → MATRÍCULA → ONR (Fabio 20/10, Luiz Fernando). O cliente manda a escritura (traz o número da matrícula e o cartório) em vez da certidão de ônus/matrícula:
 *  1) a conferência dos documentos acha a matrícula e a cidade/UF na escritura (`certidaoFromDocs`);
 *  2) a IA SE OFERECE pra emitir pelo ONR ("é essencial pra solicitar a vistoria; posso emitir por aqui, pelo cartório digital?" — sem custo e sem nome de empresa) — UMA vez por matrícula (`maybeOfferCertidao`);
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

const ORDINAIS: Record<string, number> = { primeiro: 1, segundo: 2, terceiro: 3, quarto: 4, quinto: 5, sexto: 6, setimo: 7, oitavo: 8, nono: 9, decimo: 10 };
/** Número do cartório ("1º Ofício", "2º Registro de Imóveis", "Segundo Ofício") escrito na escritura; null se for o cartório único da comarca. Pura (testável). */
export function numeroDoCartorio(txt: string): number | null {
  const t = String(txt || '');
  const a = /\b(\d{1,2})\s*[º°ª]/.exec(t) || /\b(\d{1,2})\s*o?\s+(?:of[íi]cio|cart[óo]rio|registro|servi[çc]o)/i.exec(t);
  if (a) return parseInt(a[1], 10);
  const w = /\b(primeiro|segundo|terceiro|quarto|quinto|sexto|s[ée]timo|oitavo|nono|d[ée]cimo)\b/i.exec(t.normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
  return w ? ORDINAIS[w[1].toLowerCase()] || null : null;
}

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
    if (cu) {
      // O nome do cartório vem NA ESCRITURA (Fabio 20/10): usa o número dele ("1º Ofício") pra a extensão achar o cartório na lista do portal; sem número (cartório único) vai 'AUTO'.
      const n = numeroDoCartorio(String(r.cartorio || ''));
      return { matricula: digits(r.matricula), cartorio: n ? `${n}º - ${cu.cidade.toUpperCase()}` : 'AUTO', cidade: cu.cidade, uf: cu.uf };
    }
  }
  return null;
}

export function certidaoOfferText(nome: string | null, saudar: boolean, matricula: string): string {
  // Texto do Fabio (21/10): SEM nome de empresa nem de pessoa, SEM custo (se o cliente perguntar: varia de região pra região, em torno de R$ 40 a R$ 100), diz que a certidão é essencial pra SOLICITAR A VISTORIA
  // e pergunta primeiro se o cliente TEM a certidão, ou se pode emitir pelo cartório digital.
  return `${saudar ? `Oi${nome ? `, ${nome}` : ''}! ` : ''}Recebi a escritura do imóvel e já identifiquei o número da matrícula (nº ${matricula}), porém não recebi a certidão de ônus/matrícula, ela é essencial para que possamos solicitar a vistoria. Você teria ela aí ou posso emitir ela por aqui, através do cartório digital?`;
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
  if (cf._docsCheckDue) return false; // ele ainda está mandando documento: a conferência (que roda depois) é quem faz a oferta
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
  await note(leadId, `🏛️ O cliente mandou a escritura (matrícula ${d.matricula}, ${d.cidade}/${d.uf}) e não a certidão de ônus. Ofereci emitir pelo cartório digital (ONR); o PIX vai ao cliente. Quando ele aceitar, a extensão do ONR é acionada sozinha.`);
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

/** Opções de cartório que a extensão listou ao falhar ("… (opções: 1º OFÍCIO - X | 2º OFÍCIO - X)"). Pura (testável). */
export function opcoesDeCartorio(reason: string): string[] {
  const m = /\(op[cç][õo]es:\s*(.+?)\)\s*(?:—|-|$)/i.exec(String(reason || ''));
  if (!m) return [];
  return m[1].split('|').map((x) => x.trim()).filter((x) => x && !/selecione|^-+$/i.test(x));
}

/** A extensão não soube qual cartório pedir (a escritura não diz e a cidade tem mais de um): CONFIRMA COM O CLIENTE (Fabio 20/10: "pode confirmar com o cliente também se não souber"). Uma vez por matrícula. */
export async function askClientCartorio(accountId: string, req: { id: string; leadId: string; matricula: string; cidade: string; uf: string }, reason: string, io: Io): Promise<boolean> {
  const opcoes = opcoesDeCartorio(reason);
  if (opcoes.length < 2 || opcoes.length > 12) return false;
  const lead = await carrega(req.leadId);
  if (!lead || lead.accountId !== accountId) return false;
  const cf = (lead.customFields || {}) as Record<string, any>;
  const antes = cf._certidaoCartorio as { matricula?: string; askedAt?: string } | undefined;
  if (antes?.matricula === req.matricula && antes?.askedAt) return false;
  if (cf._autoPaused || !lead.aiAutoReplyActive) return false;
  const { inNoticeWindow, whatsappWindowOpen, conversationActive } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  if (!inNoticeWindow() || !(await whatsappWindowOpen(req.leadId))) return false;
  const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
  const nome = callableFirstName(cf.participante_1, lead.name) || null;
  const saud = (await conversationActive(req.leadId)) ? '' : `Oi${nome ? `, ${nome}` : ''}! `;
  const texto = `${saud}Pra pedir a certidão da matrícula ${req.matricula} preciso saber o cartório de registro de imóveis. Em ${req.cidade} o portal tem estas opções:\n${opcoes.map((o) => `• ${o}`).join('\n')}\n\nNa sua escritura ou matrícula aparece qual deles? Se não souber, sem problema, é só me avisar.`;
  const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
  const r = await sendOutboundWhatsApp({ accountId, leadId: req.leadId, content: texto, io: (io || undefined) as any });
  if (!r.success) return false;
  const fresh = await prisma.lead.findUnique({ where: { id: req.leadId }, select: { customFields: true } });
  const c2 = { ...((fresh?.customFields || {}) as Record<string, any>), _certidaoCartorio: { requestId: req.id, matricula: req.matricula, cidade: req.cidade, uf: req.uf, opcoes, askedAt: new Date().toISOString() } };
  await prisma.lead.update({ where: { id: req.leadId }, data: { customFields: c2 as any } });
  await note(req.leadId, `🏛️ A escritura não diz qual é o cartório de ${req.cidade} (o portal tem ${opcoes.length}). Perguntei ao cliente qual aparece na escritura/matrícula; com a resposta o pedido é refeito sozinho.`);
  return true;
}

/** Resposta do cliente à pergunta do cartório: escolheu uma opção → refaz o pedido no ONR com ela; "não sei" → avisa a equipe. */
async function respondeCartorio(accountId: string, leadId: string, text: string, pend: { requestId?: string; matricula: string; cidade: string; uf: string; opcoes: string[] }, io: Io): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-5', max_tokens: 1000,
      system: 'O cliente respondeu qual é o cartório de registro de imóveis do imóvel dele. Escolha, entre as OPÇÕES numeradas, a que a resposta indica. Responda SÓ JSON: {"opcao": <número da opção, ou 0 se a resposta não indica nenhuma>, "naoSei": <true se o cliente disse que não sabe/não lembra>}. Se a resposta for pergunta ou outro assunto: {"opcao":0,"naoSei":false}.',
      messages: [{ role: 'user', content: `OPÇÕES:\n${pend.opcoes.map((o, i) => `${i + 1}) ${o}`).join('\n')}\n\nRESPOSTA DO CLIENTE: ${text}` }],
    }),
  }).catch(() => null);
  if (!res?.ok) return;
  const d: any = await res.json().catch(() => null);
  let j: any = {};
  try { j = JSON.parse(String(d?.content?.find((b: any) => b.type === 'text')?.text || '').match(/\{[\s\S]*\}/)?.[0] || '{}'); } catch { /* indefinido */ }
  const idx = Number(j.opcao) || 0;
  const salva = async (patch: Record<string, unknown>) => {
    const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
    const c = { ...((fresh?.customFields || {}) as Record<string, any>) };
    c._certidaoCartorio = { ...(c._certidaoCartorio || {}), ...patch };
    await prisma.lead.update({ where: { id: leadId }, data: { customFields: c as any } });
  };
  if (idx >= 1 && idx <= pend.opcoes.length) {
    const escolhido = pend.opcoes[idx - 1];
    await salva({ answeredAt: new Date().toISOString(), escolhido });
    try {
      const out = await createCertidaoRequest(prisma, { accountId, leadId, uf: pend.uf, cidade: pend.cidade, cartorio: escolhido, matricula: pend.matricula, source: 'AI' });
      await note(leadId, `🏛️ O cliente confirmou o cartório: ${escolhido}. Pedido refeito no ONR${out.duplicate ? ' (já havia um andando)' : ''}.`);
      io?.to(`account_${accountId}`).emit('certidao_updated', { leadId });
    } catch (e: any) { await note(leadId, `⚠️ O cliente confirmou o cartório (${escolhido}), mas não consegui refazer o pedido: ${e?.message || e}.`); }
  } else if (j.naoSei === true) {
    await salva({ answeredAt: new Date().toISOString(), naoSei: true });
    await note(leadId, `⚠️ O cliente NÃO sabe qual é o cartório (${pend.cidade}/${pend.uf}). Confira na escritura/matrícula (nome do cartório de registro) e peça a certidão pelo card.`);
    try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title: '🏛️ Cartório da certidão', body: 'O cliente não sabe qual é o cartório — confira na escritura', leadId }).catch(() => {}); } catch { /* push é só aviso */ }
  }
}

/** Mensagem do cliente depois da oferta: aceitou? Aceitou → autorização anotada + extensão do ONR acionada. Roda a cada texto inbound, mas só gasta IA enquanto há oferta esperando resposta. */
export async function checkCertidaoAcceptance(accountId: string, leadId: string, text: string, io: Io): Promise<void> {
  const clean = String(text || '').trim();
  if (!clean || clean.length > 400) return;
  const lead = await carrega(leadId);
  if (!lead || lead.accountId !== accountId) return;
  const cf = (lead.customFields || {}) as Record<string, any>;
  const pend = cf._certidaoCartorio as { requestId?: string; matricula: string; cidade: string; uf: string; opcoes: string[]; askedAt?: string; answeredAt?: string } | undefined;
  if (pend?.askedAt && !pend.answeredAt && !cf._autoPaused) { await respondeCartorio(accountId, leadId, clean, pend, io); return; }
  const of = cf._certidaoOffer as { matricula?: string; at?: string; acceptedAt?: string; declinedAt?: string } | undefined;
  if (!of?.at || of.acceptedAt || of.declinedAt || cf._autoPaused) return;
  if (Date.now() - new Date(of.at).getTime() > 7 * 86_400_000) return; // oferta velha: não gasta IA lendo toda mensagem
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-5', max_tokens: 1000,
      system: 'A atendente de um correspondente bancário perguntou ao cliente se ele tem a certidão de ônus/matrícula do imóvel ou se pode emitir pelo cartório digital (ONR). Leia a RESPOSTA do cliente e classifique. Responda SÓ JSON: {"r":"SIM"|"NAO"|"TEM"|"INDEFINIDO"}. SIM = aceitou que se emita (ex.: "pode", "sim", "pode emitir", "ok", "manda o pix"). TEM = disse que TEM a certidão e vai mandar. NAO = recusou ou prefere tirar sozinho no cartório. INDEFINIDO = pergunta (inclusive sobre o custo), dúvida, assunto diferente ou resposta que não decide.',
      messages: [{ role: 'user', content: `OFERTA: emitir a certidão da matrícula ${of.matricula} pelo cartório digital (ONR).\nRESPOSTA DO CLIENTE: ${clean}` }],
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
  if (r === 'TEM') {
    const jaAvisou = !!(cf._certidaoOffer as any)?.temAt;
    await salvaOferta(leadId, { temAt: new Date().toISOString() }); // a oferta continua valendo: se depois ele pedir pra emitir, vale
    if (!jaAvisou) await note(leadId, `🏛️ O cliente diz que TEM a certidão de ônus/matrícula e vai mandar ("${clean.slice(0, 120)}"). Nada foi pedido no ONR; se ele não mandar, a oferta de emitir continua valendo.`);
    return;
  }
  if (r !== 'SIM') return;
  await salvaOferta(leadId, { acceptedAt: new Date().toISOString() });
  await note(leadId, `${AUTORIZOU_EMISSAO} — o cliente aceitou a oferta ("${clean.slice(0, 120)}"): a emissão pelo ONR foi autorizada (o PIX vai ao cliente).`);
  const out = await ensureCertidaoRequest(accountId, leadId);
  if (out.created) io?.to(`account_${accountId}`).emit('certidao_updated', { leadId });
  else if (out.why) console.warn(`[Certidão] ${lead.name}: aceitou, mas o pedido não foi criado — ${out.why}`);
}


/** Cliente comprou o imóvel e AINDA NÃO transferiu/registrou a escritura no nome dele (Fabio 21/10, Luiz: "ele informou que não transferiu ainda"): o dono na matrícula é o VENDEDOR — a conferência NÃO pergunta de quem é o imóvel
 *  (ele já explicou) e não trava por isso. Marca `_transferenciaPendente` e dá o assunto da "pergunta do dono" por resolvido. Pura no regex (testável). */
export const TRANSFERENCIA_PENDENTE_RX = /\b(?:ainda\s+)?n[aã]o\s+(?:registrei|transferi|averbei|passei\s+(?:pro|para\s+o)\s+meu\s+nome|fiz\s+(?:o\s+)?(?:registro|transfer[eê]ncia))|ainda\s+consta\s+o\s+antigo\s+propriet[aá]rio|n[aã]o\s+(?:est[aá]|foi)\s+(?:registrad[oa]|transferid[oa])\s+(?:no|em)\s+meu\s+nome|escritura\s+(?:ainda\s+)?n[aã]o\s+(?:foi\s+)?registrada/i;
export async function marcarTransferenciaPendente(accountId: string, leadId: string, text: string): Promise<void> {
  const t = String(text || '').trim();
  if (!t || t.length > 600 || !TRANSFERENCIA_PENDENTE_RX.test(t)) return;
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true, stage: { select: { name: true } } } });
  if (!lead) return;
  const cf = { ...((lead.customFields || {}) as Record<string, any>) };
  if (cf._transferenciaPendente) return;
  cf._transferenciaPendente = { at: new Date().toISOString(), disse: t.slice(0, 160) };
  cf._donoResolvedAt = new Date().toISOString();
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: cf as any } });
  await note(leadId, `🏠 O cliente disse que AINDA NÃO transferiu/registrou a escritura no nome dele ("${t.slice(0, 120)}"): o dono na matrícula é o vendedor. Não pergunto mais de quem é o imóvel e isso não trava a documentação — o registro precisa sair antes da liberação do valor.`);
}
