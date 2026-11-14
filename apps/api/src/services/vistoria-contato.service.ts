import { prisma } from '../lib/prisma';

/**
 * CONTATO DA VISTORIA CONFIRMADO COM O CLIENTE — regra única de todos os pedidos de vistoria (Fabio 14/11, Deborah: o pedido do Inter saiu com a própria compradora
 * como contato num Financiamento, porque o campo estava vazio e o e-mail usava o cliente):
 *  "VISTORIA DE FH: o CRM precisa confirmar quem é o contato da vistoria — pode ser o vendedor, o corretor ou alguma outra pessoa que precise acompanhar o vistoriador.
 *   Apenas no HE seria a própria pessoa, mesmo assim também é necessário confirmar com o cliente."
 *
 *  - Nenhum pedido de vistoria sai sem o campo "Contato vistoria" com NOME e TELEFONE (Inter, Creditas, Santander HE/FH, CAIXA/SIOPI; no Itaú o formulário fica sem o contato).
 *    O campo vale quando veio do cliente (resposta à pergunta, cartão de contato, conversa) ou quando a equipe preencheu (já confirmou com ele). Não existe mais "vazio = o cliente".
 *  - Vazio: o CRM pergunta ao cliente. Financiamento: "o vendedor, o corretor ou outra pessoa?". Home Equity: sugere o próprio cliente, no número do card, e pede a confirmação.
 *    Conversa fechada (24 h): template "Olá, tudo bem?" e a pergunta sai na resposta (reply-pending).
 *  - A resposta é lida (onClientReplyContatoVistoria → lerContatoAgora) e vai pro campo. Pedido que a equipe mandou pelo botão sem o contato fica ARMADO
 *    (customFields._vistoriaArmada) e sai sozinho com o contato assim que ele chega (processVistoriasArmadas).
 *  - Sem resposta (Fabio 14/11: "pergunta novamente, apenas 2x; se não responder, manda push para a equipe"): a pergunta é repetida 2 vezes, a cada 24 h (07h–21h; conversa fechada =
 *    template de novo); 24 h depois da 2ª repetição sem resposta, push pra equipe + nota, e o CRM para de perguntar (processLembretesContato).
 * Estado da pergunta: customFields._vistoriaContatoAsk = { at, via: 'mensagem'|'template', por, fh, banco, lembretes?, lembreteAt?, equipeAvisadaAt?, respondidoAt?, fimAt? } (mesmo campo de antes da Creditas).
 */

type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | null | undefined;
type Cf = Record<string, any>;
export type Contato = { nome: string; telefone: string };

export const CONTATO_LABEL = 'contato da vistoria';
const REPETIR_PERGUNTA_MS = 3 * 86_400_000; // pedido de dados do Financiamento (com o contato) feito há menos de 3 dias = esperando a resposta
const CICLO_MAX_MS = 15 * 86_400_000; // pergunta mais velha que isso sem resposta: pergunta de novo do zero quando um pedido de vistoria precisar
const LEMBRETE_MS = 24 * 3_600_000; // intervalo entre a pergunta, as 2 repetições e o push pra equipe
const MAX_LEMBRETES = 2;
const LER_DEPOIS_MS = 60_000; // o cliente costuma responder em várias mensagens

const note = (leadId: string, content: string, userId?: string | null) => prisma.note.create({ data: { leadId, type: 'COMMENT', content, ...(userId ? { userId } : {}) } }).catch(() => {});
const push = (accountId: string, title: string, body: string, leadId: string) => { try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title, body, leadId }).catch(() => {}); } catch { /* aviso */ } };

const digitos = (v: unknown) => { let d = String(v ?? '').replace(/\D/g, ''); if (d.length >= 12 && d.startsWith('55')) d = d.slice(2); return d; };
export const fmtFone = (v: unknown) => { const d = digitos(v); return d.length >= 10 ? `(${d.slice(0, 2)}) ${d.slice(2, -4)}-${d.slice(-4)}` : String(v ?? '').trim(); };

/** "Contato vistoria" do card → { nome, telefone } (só com nome E telefone com DDD). Pura. */
export function partirContato(texto: unknown): Contato | null {
  const t = String(texto ?? '').trim();
  if (!t) return null;
  const fone = (t.match(/(?:\+?55\s*)?\(?\d{2}\)?\s*9?\s*\d{4}[-\s.]?\d{4}/) || [])[0] || '';
  const tel = digitos(fone);
  const nome = t.replace(fone, '').replace(/[\-–—:|,;/]+/g, ' ').replace(/\b(tel|telefone|cel|celular|whats(app)?|fone)\b\.?/gi, ' ').replace(/\s+/g, ' ').replace(/^\(\s*\)$/, '').trim();
  if (tel.length < 10 || !nome.replace(/\([^)]*\)/g, '').trim()) return null; // só o papel ("(vendedor) — 6199…") não vale: precisa do nome
  return { nome: nome.slice(0, 60), telefone: tel };
}

/** Contato da vistoria já confirmado (campo do card com nome e telefone) ou null. */
export function contatoConfirmado(cf: Cf): Contato | null { return partirContato(cf?.contato_vistoria); }

/** Linhas "• Responsável…" / "• Telefone…" pros e-mails aos bancos. Pura. */
export function linhasDoContato(c: Contato): string[] {
  return [`• Responsável para receber o engenheiro: ${c.nome}`, `• Telefone para agendamento: ${fmtFone(c.telefone)}`];
}

/** Troca o bloco de contato ("CONTATO…" seguido das linhas "• …") de um e-mail já montado/revisado pela equipe. Sem o bloco, devolve null. Pura. */
export function trocarBlocoContato(body: string, linhas: string[]): string | null {
  const re = /(^|\n)(CONTATO[^\n]*)\n(?:[ \t]*•[^\n]*(?:\n|$))+/;
  if (!re.test(body)) return null;
  return body.replace(re, (_m, a, cab) => `${a}${cab}\n${linhas.join('\n')}\n`);
}

export function ehFinanciamento(departamento: string | null | undefined): boolean { return /habitacional/i.test(String(departamento || '')); }

/** Pergunta ao cliente (sem citar banco — Fabio 03/11). Pura. */
export function perguntaContato(p: { fh: boolean; nome?: string | null; foneCliente?: string | null; lembrete?: boolean }): string {
  const oi = p.nome ? `${p.nome}, ${p.lembrete ? 'só reforçando — p' : 'p'}` : (p.lembrete ? 'Só reforçando — p' : 'P');
  if (p.fh) return `${oi}ra agendar a vistoria do imóvel: quem vai acompanhar o engenheiro na visita — o vendedor, o corretor ou outra pessoa? Me passa o nome e o telefone dessa pessoa, por favor.`;
  const fone = digitos(p.foneCliente).length >= 10 ? fmtFone(p.foneCliente) : '';
  return fone
    ? `${oi}ra agendar a vistoria do imóvel: o engenheiro pode combinar a visita com você, no número ${fone}? Se for outra pessoa que vai acompanhar, me passa o nome e o telefone dela, por favor.`
    : `${oi}ra agendar a vistoria do imóvel: o engenheiro pode combinar a visita com você? Me confirma o melhor telefone pra ele ligar. Se for outra pessoa que vai acompanhar, me passa o nome e o telefone dela, por favor.`;
}

async function dadosDoLead(leadId: string) {
  return prisma.lead.findUnique({ where: { id: leadId }, select: { id: true, name: true, accountId: true, customFields: true, contact: { select: { phone: true } }, pipeline: { select: { department: { select: { name: true } } } } } });
}

async function patchAsk(leadId: string, patch: Record<string, unknown>) {
  const fresh = ((await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }))?.customFields || {}) as Cf;
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...fresh, _vistoriaContatoAsk: { ...(fresh._vistoriaContatoAsk || {}), ...patch } } as any } });
}

/** A pergunta já está feita (ou guardada pra sair na resposta) e esperando? Inclui o pedido de dados da vistoria do Financiamento (que já leva o contato junto). */
export function perguntaPendente(cf: Cf, agora = Date.now()): boolean {
  // Pergunta feita e ainda no ciclo (sem resposta, repetições, push pra equipe): não pergunta de novo do zero — quem repete é processLembretesContato; depois do push, a equipe cuida.
  const ask = cf._vistoriaContatoAsk || {};
  const at = ask.at ? Date.parse(String(ask.at)) : 0;
  if (at && !ask.respondidoAt && !ask.fimAt && agora - at < CICLO_MAX_MS) return true;
  if (Array.isArray(cf._replyPending) && cf._replyPending.some((x: any) => x?.label === CONTATO_LABEL)) return true;
  const dfh = cf._vistoriaDadosFh || {};
  if (dfh.askedAt && !dfh.completoAt && Array.isArray(dfh.itens) && dfh.itens.includes('contato') && agora - Date.parse(String(dfh.askedAt)) < REPETIR_PERGUNTA_MS) return true;
  return false;
}

/**
 * Pergunta ao cliente quem acompanha a vistoria (uma vez a cada 3 dias). Conversa aberta = mensagem; fechada = template "Olá, tudo bem?" + pergunta na resposta.
 * 'ja_tem' (campo completo) | 'mensagem' | 'template' | 'aguardando' (já perguntado). Erro de envio = exceção.
 */
export async function pedirContato(accountId: string, leadId: string, opts: { userId?: string | null; banco?: string; io?: Io } = {}): Promise<'ja_tem' | 'mensagem' | 'template' | 'aguardando'> {
  const lead = await dadosDoLead(leadId);
  if (!lead || lead.accountId !== accountId) throw new Error('Card não encontrado');
  const cf = (lead.customFields || {}) as Cf;
  if (contatoConfirmado(cf)) return 'ja_tem';
  if (perguntaPendente(cf)) return 'aguardando';
  const fh = ehFinanciamento(lead.pipeline?.department?.name);
  const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
  const nome = callableFirstName(cf.falando_com, cf.nome_social_1, cf.participante_1, lead.name);
  const texto = perguntaContato({ fh, nome, foneCliente: cf.telefone_1 || lead.contact?.phone });
  const userId = opts.userId || undefined;
  const marca = (via: string) => patchAsk(leadId, { at: new Date().toISOString(), via, por: opts.userId || 'CRM', fh, banco: opts.banco || null, lembretes: 0, lembreteAt: null, equipeAvisadaAt: null, respondidoAt: null, fimAt: null });
  const { whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  const { sendOutboundWhatsApp, sendOutboundWhatsAppTemplate } = require('./message.service') as typeof import('./message.service');
  const quem = fh ? 'o vendedor, o corretor ou outra pessoa' : 'o próprio cliente (confirmando) ou outra pessoa';
  if (await whatsappWindowOpen(leadId)) {
    const r = await sendOutboundWhatsApp({ accountId, leadId, content: texto, userId, io: opts.io as any });
    if (!r.success) throw new Error(`Não consegui perguntar ao cliente quem acompanha a vistoria: ${(r as any).error || 'erro'}`);
    await marca('mensagem');
    await note(leadId, `🏠 Perguntei ao cliente quem acompanha a vistoria${opts.banco ? ` (${opts.banco})` : ''} — ${quem} — com nome e telefone. A resposta vai pro campo "Contato vistoria" e o pedido de vistoria só sai com ela.`, opts.userId);
    return 'mensagem';
  }
  const t = await sendOutboundWhatsAppTemplate({ accountId, leadId, templateName: 'ola_tudo_bem', language: 'pt_BR', bodyParams: [], previewText: 'Olá, tudo bem?', userId, io: opts.io as any });
  if (!t.success) throw new Error(`A conversa está fechada e o template "Olá, tudo bem?" falhou: ${t.error}`);
  const { queueOnReply } = require('./reply-pending.service') as typeof import('./reply-pending.service');
  await queueOnReply(prisma, { leadId, label: CONTATO_LABEL, text: texto, noteText: `🏠 A janela de 24 h estava fechada — mandei o template "Olá, tudo bem?". Quando o cliente responder, sai a pergunta de quem acompanha a vistoria (${quem}, com nome e telefone); a resposta vai pro campo "Contato vistoria".` });
  await marca('template');
  return 'template';
}

export type Garantia = { ok: true; contato: Contato } | { ok: false; estado: 'perguntado' | 'aguardando' | 'fora_do_horario' | 'erro'; erro?: string };

/** Porteiro de todos os pedidos de vistoria: contato confirmado → ok; senão pergunta ao cliente (fluxo automático: só 07h–21h) e devolve o porquê de esperar. */
export async function garantirContatoVistoria(accountId: string, leadId: string, opts: { banco: string; userId?: string | null; io?: Io; respeitarHorario?: boolean }): Promise<Garantia> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cf = (lead?.customFields || {}) as Cf;
  const c = contatoConfirmado(cf);
  if (c) return { ok: true, contato: c };
  if (perguntaPendente(cf)) return { ok: false, estado: 'aguardando' };
  if (opts.respeitarHorario) {
    const { inNoticeWindow } = require('./approval-notice.service') as typeof import('./approval-notice.service');
    if (!inNoticeWindow()) return { ok: false, estado: 'fora_do_horario' };
  }
  try {
    const r = await pedirContato(accountId, leadId, { userId: opts.userId, banco: opts.banco, io: opts.io });
    if (r === 'ja_tem') { const f = contatoConfirmado(((await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }))?.customFields || {}) as Cf); if (f) return { ok: true, contato: f }; }
    return { ok: false, estado: r === 'aguardando' ? 'aguardando' : 'perguntado' };
  } catch (e: any) {
    return { ok: false, estado: 'erro', erro: String(e?.message || e) };
  }
}

/** Texto pra equipe quando o pedido não sai por falta do contato (toast do botão / nota). Pura. */
export function textoEsperandoContato(g: Exclude<Garantia, { ok: true }>, banco: string, armado: boolean): string {
  const sai = armado ? ` Quando ele responder, o pedido ao ${banco} sai sozinho com esse contato.` : ` Quando ele responder, o CRM segue com o pedido ao ${banco}.`;
  const jaConfirmou = ' Se você já confirmou com ele, preencha o campo "Contato vistoria" do card (nome e telefone) e envie de novo.';
  if (g.estado === 'perguntado') return `O contato da vistoria ainda não foi confirmado com o cliente: perguntei agora a ele quem acompanha o engenheiro (nome e telefone).${sai}${jaConfirmou}`;
  if (g.estado === 'aguardando') return `O contato da vistoria ainda não foi confirmado: o cliente já foi perguntado e não respondeu.${sai}${jaConfirmou}`;
  if (g.estado === 'fora_do_horario') return `O contato da vistoria ainda não foi confirmado: o CRM pergunta ao cliente no horário (07h–21h).${sai}${jaConfirmou}`;
  return `O contato da vistoria ainda não foi confirmado e não consegui perguntar ao cliente (${g.erro || 'erro'}).${jaConfirmou}`;
}

// ─── Leitura da resposta ───

const SYSTEM_RESPOSTA = `Você lê uma conversa de WhatsApp entre a equipe de uma correspondente bancária e o cliente. A equipe perguntou quem vai acompanhar o engenheiro na VISTORIA do imóvel (nome e telefone). Leia SÓ o que o cliente respondeu a isso e responda SOMENTE com JSON:
{"respondeu": true|false, "quem": "cliente"|"outra"|null, "nome": null, "telefone": null, "papel": "vendedor|corretor|inquilino|parente|proprietario|outro|null"}
Regras:
- "quem":"cliente" quando o próprio cliente vai acompanhar ("sim", "pode", "pode ser comigo", "eu mesmo", "pode ligar nesse número", "eu acompanho"). Se ele der outro telefone pra ele mesmo, ponha em "telefone".
- "quem":"outra" quando indicar outra pessoa (vendedor, corretor, esposa, inquilino, irmão…). "nome" e "telefone" dessa pessoa SÓ se estiverem escritos (cartão de contato compartilhado aparece como "[contato compartilhado: Nome — número]"). Telefone só dígitos com DDD.
- Mensagem que não responde à pergunta da vistoria (cumprimento, documento, outro assunto) = {"respondeu": false}. Nunca invente nome nem telefone.`;

async function chamarHaiku(system: string, texto: string): Promise<any | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 400, system, messages: [{ role: 'user', content: texto }] }),
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  try { return JSON.parse((data.content?.find((b) => b.type === 'text')?.text || '').match(/\{[\s\S]*\}/)?.[0] || ''); } catch { return null; }
}

const lendo = new Map<string, NodeJS.Timeout>();

/** Hook da mensagem recebida (whatsapp.service): pergunta feita e campo ainda vazio → lê a resposta 60 s depois da última mensagem. */
export async function onClientReplyContatoVistoria(accountId: string, leadId: string, io?: Io): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cf = (lead?.customFields || {}) as Cf;
  const ask = cf._vistoriaContatoAsk;
  if (!ask?.at || ask.respondidoAt || contatoConfirmado(cf)) return;
  if (Date.now() - Date.parse(String(ask.at)) > 15 * 86_400_000) return;
  const t = lendo.get(leadId);
  if (t) clearTimeout(t);
  lendo.set(leadId, setTimeout(() => { lendo.delete(leadId); lerContatoAgora(accountId, leadId, io).catch((e: any) => console.warn('[Contato vistoria] leitura:', e?.message)); }, LER_DEPOIS_MS));
}

/** Grava o "Contato vistoria" se ainda não há um completo (vazio, só "Corretor", só o papel com telefone…). */
async function gravarCampo(leadId: string, texto: string): Promise<boolean> {
  const fresh = ((await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }))?.customFields || {}) as Cf;
  if (contatoConfirmado(fresh)) return false;
  const n = await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{contato_vistoria}', to_jsonb(${texto}::text), true) WHERE id = ${leadId}`;
  return n > 0;
}

export async function lerContatoAgora(accountId: string, leadId: string, io?: Io): Promise<void> {
  const lead = await dadosDoLead(leadId);
  if (!lead) return;
  const cf = (lead.customFields || {}) as Cf;
  const ask = cf._vistoriaContatoAsk;
  if (!ask?.at || contatoConfirmado(cf)) return;
  const msgs = await prisma.message.findMany({ where: { leadId, channel: 'WHATSAPP', callWaCallId: null, createdAt: { gte: new Date(Date.parse(String(ask.at)) - 60_000) } }, orderBy: { createdAt: 'asc' }, take: 40, select: { direction: true, content: true, sharedContactName: true, sharedContactPhone: true } });
  if (!msgs.some((m) => m.direction === 'INBOUND')) return;
  const nomeCliente = String(cf.participante_1 || lead.name || '').trim();
  const foneCliente = digitos(cf.telefone_1 || lead.contact?.phone);
  const conversa = msgs.map((m) => `${m.direction === 'INBOUND' ? 'CLIENTE' : 'EQUIPE'}: ${String(m.content || '').slice(0, 600)}${m.sharedContactPhone ? ` [contato compartilhado: ${m.sharedContactName || 'sem nome'} — ${m.sharedContactPhone}]` : ''}`).join('\n').slice(-8000);
  const r = await chamarHaiku(SYSTEM_RESPOSTA, `Cliente: ${nomeCliente}${foneCliente ? ` (telefone ${foneCliente})` : ''}\n\n${conversa}`);
  if (!r?.respondeu || !r.quem) return;
  const papel = r.papel && r.papel !== 'null' && r.papel !== 'outro' ? String(r.papel) : '';
  let texto = '';
  if (r.quem === 'cliente') {
    const tel = digitos(r.telefone).length >= 10 ? digitos(r.telefone) : foneCliente;
    if (tel.length >= 10 && nomeCliente) texto = `${nomeCliente} (o próprio cliente) — ${fmtFone(tel)}`;
  } else if (r.quem === 'outra') {
    const tel = digitos(r.telefone);
    if (r.nome && tel.length >= 10) texto = `${String(r.nome).trim().slice(0, 60)}${papel ? ` (${papel})` : ''} — ${fmtFone(tel)}`;
    else {
      // Disse só QUEM ("o corretor") ou faltou o telefone: pede o que falta (vistoria-caixa.pedirNomeTelefoneContato — não repete em 12 h).
      const vc = require('./vistoria-caixa.service') as typeof import('./vistoria-caixa.service');
      await vc.pedirNomeTelefoneContato(accountId, leadId, String(r.nome || (papel ? `o ${papel}` : '')).trim(), io as any).catch((e: any) => console.warn('[Contato vistoria] nome/telefone:', e?.message));
      return;
    }
  }
  if (!texto) return;
  const gravou = await gravarCampo(leadId, texto);
  await patchAsk(leadId, { respondidoAt: new Date().toISOString() });
  if (!gravou) return;
  await note(leadId, `🏠 O cliente respondeu quem acompanha a vistoria: ${texto} — gravei no campo "Contato vistoria".`);
  io?.to(`lead:${leadId}`).emit('lead_updated', { leadId });
  await liberarArmada(accountId, leadId, io).catch((e: any) => console.warn('[Vistoria armada]', e?.message));
}

// ─── Pedido armado pelo botão (sai quando o contato chega) ───

export type VistoriaArmada = { banco: 'INTER' | 'CREDITAS'; at: string; userId: string; to: string; cc?: string; subject: string; body: string; replyToId?: string | null; attachDriveFileIds?: string[] };

export async function armarVistoria(leadId: string, a: Omit<VistoriaArmada, 'at'>): Promise<void> {
  const fresh = ((await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }))?.customFields || {}) as Cf;
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...fresh, _vistoriaArmada: { ...a, at: new Date().toISOString() } } as any } });
}

async function desarmar(leadId: string) {
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = "customFields" - '_vistoriaArmada' WHERE id = ${leadId}`;
}

/** Contato chegou: manda o pedido que a equipe tinha mandado pelo botão, com o bloco CONTATO trocado. Devolve se enviou. */
export async function liberarArmada(accountId: string, leadId: string, io?: Io): Promise<boolean> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  const cf = (lead?.customFields || {}) as Cf;
  const a = cf._vistoriaArmada as VistoriaArmada | undefined;
  if (!a) return false;
  const c = contatoConfirmado(cf);
  if (!c) return false;
  const jaFoi = a.banco === 'INTER' ? cf._vistoriaRequestedAt && Date.parse(String(cf._vistoriaRequestedAt)) > Date.parse(a.at) : cf._vistoriaCreditasAt && Date.parse(String(cf._vistoriaCreditasAt)) > Date.parse(a.at);
  if (jaFoi) { await desarmar(leadId); return false; }
  await desarmar(leadId); // antes de enviar: duas leituras seguidas não mandam duas vezes
  const quem = (await prisma.user.findUnique({ where: { id: a.userId }, select: { name: true } }))?.name || 'a equipe';
  try {
    if (a.banco === 'INTER') {
      const vi = require('./vistoria-inter.service') as typeof import('./vistoria-inter.service');
      const corpo = trocarBlocoContato(a.body, vi.linhasContatoInter(c, cf)) || (await vi.vistoriaPreview(accountId, leadId)).body;
      await vi.solicitarVistoria({ accountId, userId: a.userId, leadId, to: a.to, cc: a.cc || '', subject: a.subject, body: corpo, replyToId: a.replyToId || null, attachDriveFileIds: a.attachDriveFileIds || [], io: io as any });
    } else {
      const vc = require('./vistoria-creditas.service') as typeof import('./vistoria-creditas.service');
      const corpo = trocarBlocoContato(a.body, vc.linhasContatoCreditas(c)) || (await vc.vistoriaCreditasPreview(accountId, leadId)).body;
      await vc.solicitarVistoriaCreditas({ accountId, userId: a.userId, leadId, to: a.to, cc: a.cc || '', subject: a.subject, body: corpo, replyToId: a.replyToId || null, attachDriveFileIds: a.attachDriveFileIds || [], io: io as any });
    }
    await note(leadId, `📨 O contato da vistoria chegou (${cf.contato_vistoria}): o pedido de vistoria ao ${a.banco === 'INTER' ? 'Inter' : 'Creditas'} que ${quem} tinha mandado saiu agora, com esse contato.`);
    return true;
  } catch (e: any) {
    await note(leadId, `⚠️ O contato da vistoria chegou, mas o pedido ao ${a.banco === 'INTER' ? 'Inter' : 'Creditas'} que ${quem} tinha mandado não saiu: ${e?.message || e}. Envie de novo pelo botão do card.`);
    push(accountId, '⚠️ Vistoria não saiu', `${a.banco === 'INTER' ? 'Inter' : 'Creditas'}: ${String(e?.message || e).slice(0, 120)}`, leadId);
    return false;
  }
}

/** Outro fluxo já perguntou o contato junto com mais coisas (pedido de dados da vistoria do Financiamento): entra no mesmo ciclo — leitura da resposta, 2 repetições e push. */
export async function marcarPerguntaFeita(leadId: string, p: { banco?: string; fh?: boolean; via?: string }): Promise<void> {
  await patchAsk(leadId, { at: new Date().toISOString(), via: p.via || 'mensagem', por: 'CRM', fh: p.fh ?? true, banco: p.banco || null, lembretes: 0, lembreteAt: null, equipeAvisadaAt: null, respondidoAt: null, fimAt: null });
}

/** Sem resposta à pergunta do contato (Fabio 14/11): repete 2x, a cada 24 h, no horário (07h–21h); 24 h depois da 2ª, push pra equipe e o CRM para. Pura nos dados: o que fazer agora. */
export function proximoPassoContato(ask: Cf, agora = Date.now()): 'nada' | 'lembrete' | 'equipe' {
  if (!ask?.at || ask.respondidoAt || ask.fimAt || ask.equipeAvisadaAt) return 'nada';
  const at = Date.parse(String(ask.at));
  if (!at || agora - at > CICLO_MAX_MS) return 'nada';
  const ultima = ask.lembreteAt ? Date.parse(String(ask.lembreteAt)) : at;
  if (agora - ultima < LEMBRETE_MS) return 'nada';
  return (Number(ask.lembretes) || 0) < MAX_LEMBRETES ? 'lembrete' : 'equipe';
}

async function lembrarContato(accountId: string, leadId: string, io?: Io): Promise<void> {
  const lead = await dadosDoLead(leadId);
  if (!lead || lead.accountId !== accountId) return;
  const cf = (lead.customFields || {}) as Cf;
  const ask = (cf._vistoriaContatoAsk || {}) as Cf;
  if (contatoConfirmado(cf)) { await patchAsk(leadId, { respondidoAt: ask.respondidoAt || new Date().toISOString() }); return; }
  // O pedido de vistoria já saiu depois da pergunta (a equipe resolveu de outro jeito): encerra o ciclo.
  const depois = (v: unknown) => !!v && Date.parse(String(v)) > Date.parse(String(ask.at));
  if (!cf._vistoriaArmada && (depois(cf._vistoriaRequestedAt) || depois(cf._vistoriaCreditasAt))) { await patchAsk(leadId, { fimAt: new Date().toISOString() }); return; }
  if (cf._autoPaused) return;
  const passo = proximoPassoContato(ask);
  if (passo === 'nada') return;
  const banco = ask.banco ? ` (${ask.banco})` : '';
  if (passo === 'equipe') {
    await patchAsk(leadId, { equipeAvisadaAt: new Date().toISOString() });
    await note(leadId, `🏠 O cliente não respondeu quem acompanha a vistoria${banco}: perguntei e repeti ${MAX_LEMBRETES}x, sem resposta. Falem com ele e preencham o campo "Contato vistoria" (nome e telefone)${cf._vistoriaArmada ? ' — o pedido de vistoria que está esperando sai sozinho quando o campo for preenchido' : ''}. O CRM não pergunta mais.`);
    push(accountId, '🏠 Sem o contato da vistoria', `${lead.name}: o cliente não respondeu quem acompanha a vistoria (perguntado ${MAX_LEMBRETES + 1}x)`, leadId);
    return;
  }
  const { inNoticeWindow, whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  if (!inNoticeWindow()) return;
  const fh = ask.fh ?? ehFinanciamento(lead.pipeline?.department?.name);
  const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
  const nome = callableFirstName(cf.falando_com, cf.nome_social_1, cf.participante_1, lead.name);
  const texto = perguntaContato({ fh, nome, foneCliente: cf.telefone_1 || lead.contact?.phone, lembrete: true });
  const n = (Number(ask.lembretes) || 0) + 1;
  const { sendOutboundWhatsApp, sendOutboundWhatsAppTemplate } = require('./message.service') as typeof import('./message.service');
  if (await whatsappWindowOpen(leadId)) {
    const r = await sendOutboundWhatsApp({ accountId, leadId, content: texto, io: io as any });
    if (!r.success) { console.warn('[Contato vistoria] repetição:', (r as any).error); return; }
    await patchAsk(leadId, { lembretes: n, lembreteAt: new Date().toISOString() });
    await note(leadId, `🏠 O cliente ainda não disse quem acompanha a vistoria${banco}: perguntei de novo (${n}ª de ${MAX_LEMBRETES} repetições).`);
    return;
  }
  const t = await sendOutboundWhatsAppTemplate({ accountId, leadId, templateName: 'ola_tudo_bem', language: 'pt_BR', bodyParams: [], previewText: 'Olá, tudo bem?', io: io as any });
  if (!t.success) { console.warn('[Contato vistoria] template da repetição:', t.error); return; }
  const { queueOnReply } = require('./reply-pending.service') as typeof import('./reply-pending.service');
  await queueOnReply(prisma, { leadId, label: CONTATO_LABEL, text: texto, noteText: `🏠 O cliente ainda não disse quem acompanha a vistoria${banco} e a janela de 24 h está fechada: mandei o template "Olá, tudo bem?" de novo (${n}ª de ${MAX_LEMBRETES} repetições); a pergunta sai quando ele responder.` });
  await patchAsk(leadId, { lembretes: n, lembreteAt: new Date().toISOString() });
}

/** A cada 2 min: repetições da pergunta / push pra equipe (lembrarContato). */
export async function processLembretesContato(io?: Io): Promise<void> {
  const rows = await prisma.$queryRaw<{ id: string; accountId: string }[]>`
    SELECT id, "accountId" FROM "Lead"
     WHERE archived = false AND status = 'OPEN'
       AND COALESCE("customFields"->'_vistoriaContatoAsk'->>'at', '') <> ''
       AND COALESCE("customFields"->'_vistoriaContatoAsk'->>'respondidoAt', '') = ''
       AND COALESCE("customFields"->'_vistoriaContatoAsk'->>'fimAt', '') = ''
       AND COALESCE("customFields"->'_vistoriaContatoAsk'->>'equipeAvisadaAt', '') = ''
     LIMIT 50`;
  for (const r of rows) {
    try { await lembrarContato(r.accountId, r.id, io); } catch (e: any) { console.warn('[Contato vistoria] lembrete:', e?.message); }
  }
}

/** A cada 2 min (index.ts): pedido armado cujo contato já chegou (campo preenchido pela equipe ou pela leitura) → sai; e as repetições da pergunta sem resposta. */
export async function processVistoriasArmadas(io?: Io): Promise<void> {
  await processLembretesContato(io).catch((e: any) => console.warn('[Contato vistoria] lembretes:', e?.message));
  const rows = await prisma.$queryRaw<{ id: string; accountId: string }[]>`
    SELECT id, "accountId" FROM "Lead" WHERE archived = false AND jsonb_exists(COALESCE("customFields", '{}'::jsonb), '_vistoriaArmada') LIMIT 30`;
  for (const r of rows) {
    try { await liberarArmada(r.accountId, r.id, io); } catch (e: any) { console.warn('[Vistoria armada]', e?.message); }
  }
}
