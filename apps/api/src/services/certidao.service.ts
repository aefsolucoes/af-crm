import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { sendOutboundWhatsApp } from './message.service';
import { foraDoHorario } from './credit-analysis.service';

type Db = PrismaClient;
type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } };

/**
 * Certidão de matrícula (inteiro teor) pelo RI Digital/ONR, feita pela extensão "Certidão ONR" no Chrome do Fabio (16/10).
 * Fabio: "a própria extensão faça isso" — pedir, clicar em PIX, copiar o código e encaminhar ao cliente; depois baixar a certidão.
 *
 * Fluxo: CRM cria o pedido (REQUESTED) → extensão pega na fila (fase ORDER), preenche o portal, confere em "Detalhes" e conclui →
 * relata o protocolo (AWAITING_PAYMENT) → captura o código PIX na tela da ONR (leva de 30 s a 1 min) → o CRM manda ao cliente →
 * a extensão volta de tempos em tempos (fase COLLECT) a ver se a certidão saiu e devolve o PDF (ISSUED).
 * Se o pedido foi feito mas o PIX não foi capturado, a fase PIX tenta de novo SEM pedir outra certidão (cada pedido é uma cobrança nova).
 */

const REQUESTED_WARN_H = 6; // ninguém pegou (extensão/Chrome fechados): AVISA a equipe, mas não cancela — Fabio 19/10: sem limite, vale até o pedido sair
const WARN_MARK = 'sem atendimento';
const GIVE_UP_DAYS = 3; // pago e a certidão não saiu em 3 DIAS ÚTEIS: para de procurar e AVISA a equipe por push (Fabio 19/10: "FDS ninguém trabalha"; feriado não é descontado)
const RUNNING_TTL_MIN = 25; // pegou e sumiu (aba fechou) — o PIX demora até ~2 min, o pedido todo cabe folgado
const PIX_MAX_ATTEMPTS = 4; // tentativas de pegar o PIX de um pedido já feito
const CHECK_EVERY_MIN = 240; // 29/10 (Fabio): de 4 em 4 h depois que o PIX é encaminhado — antes: conferência da emissão de 5 em 5 h (Fabio 16/10); o e-mail "Resposta ao seu pedido" do RI Digital adianta (certidaoEmailArrived)
// Qualquer protocolo do RI Digital (P… do pedido, S… da certidão emitida ou formato novo): 1–3 letras + 6–16 dígitos + até 3 letras. Nunca travar por formato diferente.
const PROTO_SRC = '[A-Z]{1,3}\\d{6,16}[A-Z]{0,3}';
const PROTO_OK = new RegExp(`^${PROTO_SRC}$`);
const PROTO_IN_TEXT = () => new RegExp(`\\b${PROTO_SRC}\\b`, 'g');
const PAID_CHECK_EVERY_MIN = 240; // 29/10: 4 em 4 h — antes: depois do pagamento confirmado, confere a emissão de 5 em 5 h (Fabio 19/10); o e-mail do cartório adianta
const ACTIVE = ['FIND_WEB', 'FIND', 'FINDING', 'REQUESTED', 'RUNNING', 'AWAITING_PAYMENT']; // FIND/FINDING = achando o cartório no Mapa do ONR antes do pedido (Fabio 29/10)

export const onlyDigits = (v: unknown) => String(v ?? '').replace(/\D/g, '');
const brl = (cents: number | null | undefined) => `R$ ${((cents || 0) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const BRT_MS = 3 * 3600_000;
const brDate = (d: Date) => { const b = new Date(d.getTime() - BRT_MS); return `${String(b.getUTCDate()).padStart(2, '0')}/${String(b.getUTCMonth() + 1).padStart(2, '0')}`; };
const sameBrDay = (a: Date, b: Date) => brDate(a) === brDate(b) && Math.abs(a.getTime() - b.getTime()) < 36 * 3600_000;

/** Hora de Brasília (0–23). */
const horaBrt = (d = new Date()) => new Date(d.getTime() - BRT_MS).getUTCHours();
/** O PIX do RI Digital vence no MESMO DIA às 23:59 (Fernanda 29/10: pedido às 23:54, PIX valia 5 min). Fabio 30/10: o CRM só faz pedido novo das 07h às 20h; depois, fica na fila até as 07h. */
export const CERTIDAO_PEDIDO_DAS = 7, CERTIDAO_PEDIDO_ATE = 20;
export const podePedirCertidaoAgora = (d = new Date()) => { const h = horaBrt(d); return h >= CERTIDAO_PEDIDO_DAS && h < CERTIDAO_PEDIDO_ATE; };
/** Início do expediente (07h BRT) do dia de hoje, em UTC. */
const inicioExpedienteHoje = (d = new Date()) => { const b = new Date(d.getTime() - BRT_MS); return Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate(), CERTIDAO_PEDIDO_DAS) + BRT_MS; };

function firstName(full: string | null | undefined): string {
  const w = String(full || '').trim().split(/\s+/)[0] || '';
  return w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : 'Olá';
}

/** Código "Pix Copia e Cola" de verdade (EMV do Banco Central): começa em 000201, tem o domínio do PIX e fecha com o CRC (4 hex após "6304"). Pura (testável). */
export function looksLikePix(code: unknown): boolean {
  const c = String(code || '').trim();
  return c.length >= 80 && c.length <= 700 && /^000201/.test(c) && /BR\.GOV\.BCB\.PIX/i.test(c) && /6304[0-9A-F]{4}$/i.test(c);
}

/** Valor do PIX (campo 54 do EMV) em centavos, quando legível. Pura (testável). */
export function pixAmountCents(code: string): number | null {
  const c = String(code || '').trim();
  for (let i = 0; i + 4 <= c.length;) { // TLV do EMV: tag(2) + tamanho(2) + valor
    const tag = c.slice(i, i + 2), len = parseInt(c.slice(i + 2, i + 4), 10);
    if (!Number.isFinite(len)) return null;
    if (tag === '54') {
      const v = parseFloat(c.slice(i + 4, i + 4 + len));
      return Number.isFinite(v) ? Math.round(v * 100) : null;
    }
    i += 4 + len;
  }
  return null;
}

// ── Link assinado do PDF (vai na nota do card; abre sem login) ────────────────────────────────
const sigKey = () => process.env.JWT_SECRET || 'certidao';
export function signCertidaoLink(id: string, days = 30): string {
  const exp = Date.now() + days * 86400_000;
  const sig = crypto.createHmac('sha256', sigKey()).update(`${id}.${exp}`).digest('hex').slice(0, 32);
  return `${process.env.PUBLIC_API_URL || 'https://af-crm-production.up.railway.app'}/api/certidoes/${id}/pdf?exp=${exp}&sig=${sig}`;
}
export function validCertidaoSig(id: string, exp: unknown, sig: unknown): boolean {
  const e = Number(exp);
  if (!Number.isFinite(e) || e < Date.now() || typeof sig !== 'string') return false;
  const ok = crypto.createHmac('sha256', sigKey()).update(`${id}.${e}`).digest('hex').slice(0, 32);
  return ok.length === sig.length && crypto.timingSafeEqual(Buffer.from(ok), Buffer.from(sig));
}

/** Soma `n` dias ÚTEIS (sábado e domingo, em Brasília, não contam). Pura (testável). */
export function addBusinessDays(from: Date, n: number): Date {
  const d = new Date(from.getTime());
  let added = 0;
  while (added < n) {
    d.setTime(d.getTime() + 86400_000);
    const wd = new Date(d.getTime() - 3 * 3600_000).getUTCDay(); // dia da semana em Brasília
    if (wd !== 0 && wd !== 6) added++;
  }
  return d;
}

const note = (db: Db, leadId: string, content: string, userId?: string | null) =>
  db.note.create({ data: { leadId, type: 'COMMENT', content, userId: userId || undefined } }).catch(() => {});
const emitUpdate = (io: Io | undefined, accountId: string, leadId: string, id: string) => io?.to(`account_${accountId}`).emit('certidao_updated', { id, leadId });

// ── Pedido ───────────────────────────────────────────────────────────────────────────────────
export async function createCertidaoRequest(db: Db, p: { accountId: string; leadId: string; uf: string; cidade: string; cartorio: string; matricula?: string; pedidoPor?: 'MATRICULA' | 'ENDERECO'; endereco?: EnderecoCertidao | null; userId?: string; source?: 'USER' | 'AI' | 'MAPA'; sendPix?: boolean; clientIntro?: string }) {
  const uf = String(p.uf || '').trim().toUpperCase();
  const porEndereco = p.pedidoPor === 'ENDERECO';
  const matricula = porEndereco ? '' : onlyDigits(p.matricula);
  if (!/^[A-Z]{2}$/.test(uf)) throw new Error('UF inválida (use a sigla, ex.: PA)');
  if (!porEndereco && (matricula.length < 1 || matricula.length > 12)) throw new Error('Número de matrícula inválido');
  let endereco: EnderecoCertidao | null = null;
  if (porEndereco) {
    const e = { ...(p.endereco || {}) } as EnderecoCertidao;
    const cep = onlyDigits(e.cep);
    if (cep.length !== 8) throw new Error('Pedido por endereço precisa do CEP do imóvel (8 dígitos)');
    if (!((e.logradouro && e.numero) || (e.loteamento && e.quadra && e.lote))) throw new Error('Pedido por endereço precisa da rua e do número (ou loteamento, quadra e lote)');
    // "Avenida Avenida João Paulo da Silva" no portal (Fernanda 29/10): o tipo veio também no começo da rua — tira do logradouro.
    const TIPO_RX = /^(rua|r\.|avenida|av\.?|alameda|al\.|travessa|tv\.|estrada|est\.|rodovia|rod\.|pra[cç]a|p[cç]\.|largo|viela)\s+/i;
    if (e.logradouro && TIPO_RX.test(e.logradouro.trim())) {
      const tipoNaRua = e.logradouro.trim().match(TIPO_RX)![1];
      e.logradouro = e.logradouro.trim().replace(TIPO_RX, '').trim();
      const tipo = /^av/i.test(tipoNaRua) ? 'Avenida' : /^r(ua|\.)/i.test(tipoNaRua) ? 'Rua' : /^al/i.test(tipoNaRua) ? 'Alameda' : /^tv|^trav/i.test(tipoNaRua) ? 'Travessa' : /^est/i.test(tipoNaRua) ? 'Estrada' : /^rod/i.test(tipoNaRua) ? 'Rodovia' : /^p/i.test(tipoNaRua) ? 'Praça' : tipoNaRua.charAt(0).toUpperCase() + tipoNaRua.slice(1).toLowerCase();
      e.tipoLogradouro = tipo; // o que está escrito na rua vale mais que o tipo padrão ("Rua") do leitor
    }
    endereco = { ...e, cep: `${cep.slice(0, 5)}-${cep.slice(5)}`, complemento: e.complemento?.slice(0, 30), bloco: e.bloco?.slice(0, 30) };
  }
  if (!String(p.cidade || '').trim() || !String(p.cartorio || '').trim()) throw new Error('Informe a cidade e o cartório (ex.: Belém / 02º - BELÉM)');
  const lead = await db.lead.findFirst({ where: { id: p.leadId, accountId: p.accountId }, select: { id: true } });
  if (!lead) throw new Error('Lead não encontrado');
  // Cada pedido é uma cobrança nova no portal: nunca cria outro enquanto houver um andando pra mesma matrícula (ou, por endereço, pro mesmo imóvel) do mesmo cliente.
  const ativo = await db.certidaoRequest.findFirst({ where: { accountId: p.accountId, leadId: p.leadId, ...(porEndereco ? { pedidoPor: 'ENDERECO' } : { matricula }), status: { in: ACTIVE }, ...(p.source === 'MAPA' ? {} : { NOT: { source: 'MAPA' } }) }, orderBy: { createdAt: 'desc' } });
  if (ativo) return { request: ativo, duplicate: true, agendado: false };
  // Mapa do portal (Fabio 29/10, Alexandro: o "3º Ofício de Brasília" fica em ÁGUAS CLARAS no RI Digital): corrige cidade/cartório antes da extensão tentar.
  let cidade = p.cidade.trim(), cartorio = p.cartorio.trim(), ajuste = '';
  try {
    const r = (require('./ri-cartorios.service') as typeof import('./ri-cartorios.service')).resolverCartorio(uf, cidade, cartorio);
    if (r) { ajuste = ` Ajustado pelo mapa do RI Digital: ${r.motivo} (era "${cartorio}" / ${cidade}).${r.semCertidaoDigital ? ' ⚠️ Esse cartório não aparece com Certidão Digital no portal.' : ''}`; cidade = r.cidade; cartorio = r.cartorio; }
  } catch { /* sem mapa: segue como veio */ }
  // Cidade com vários cartórios e pedido por endereço sem cartório: usa o cartório que já deu certo nessa região (cartorio-regiao.service).
  if (porEndereco && /^auto$/i.test(cartorio) && endereco) {
    try {
      const ap = await (require('./cartorio-regiao.service') as typeof import('./cartorio-regiao.service')).cartorioAprendido(p.accountId, { uf, cidade, cep: endereco.cep, bairro: endereco.bairro });
      if (ap) { cartorio = ap.cartorio; ajuste += ` Cartório escolhido pelo que o CRM já aprendeu da região (${ap.por}): ${ap.cartorio}.`; }
    } catch { /* segue AUTO */ }
  }
  // Fabio 29/10: 1º ACHA o cartório (Mapa do ONR pelo endereço, grava no card), DEPOIS pede a certidão. Só quando é por endereço, sem cartório e a cidade tem vários no portal.
  let precisaAchar = false;
  if (porEndereco && /^auto$/i.test(cartorio)) {
    try { const c = (require('./ri-cartorios.service') as typeof import('./ri-cartorios.service')).consultarCartorios(uf, cidade) as any; precisaAchar = Array.isArray(c?.naCidade) && c.naCidade.length > 1; } catch { /* sem mapa: segue */ }
    if (precisaAchar) ajuste += ' Antes do pedido, o CRM acha o cartório pela pesquisa nas fontes oficiais e grava no card.';
  }
  if (p.source === 'MAPA' && !precisaAchar) return { request: null as any, duplicate: true, agendado: false }; // só consulta e não precisa do mapa: nada a fazer
  const request = await db.certidaoRequest.create({
    data: { ...(precisaAchar ? { status: 'FIND_WEB' } : {}), accountId: p.accountId, leadId: p.leadId, uf, cidade, cartorio, matricula, pedidoPor: porEndereco ? 'ENDERECO' : 'MATRICULA', endereco: (endereco as any) ?? undefined, source: p.source || 'USER', requestedById: p.userId, sendPix: p.sendPix !== false, clientIntro: p.clientIntro?.trim() || null },
  });
  if (precisaAchar) void acharCartorioPelaWeb(db, request.id);
  if (p.source === 'MAPA') { await note(db, p.leadId, `🗺️ O cliente não tem matrícula nem cartório nos documentos: o CRM vai achar o cartório do imóvel no Mapa do ONR pelo endereço (${enderecoTexto(endereco)}, ${cidade}/${uf}) e gravar no card. NÃO é pedido de certidão (nada é cobrado).`, p.userId); return { request, duplicate: false, agendado: false }; }
  const oQue = porEndereco ? `pelo ENDEREÇO do imóvel (${enderecoTexto(endereco)}, ${cidade}/${uf} — o cliente não sabe a matrícula)` : `de matrícula nº ${matricula} (${cartorio === 'AUTO' ? cidade : cartorio}/${uf})`;
  const agendado = !podePedirCertidaoAgora();
  await note(db, p.leadId, `🏛️ Certidão ${oQue} pedida pelo CRM — a extensão "Certidão ONR" faz o pedido no RI Digital e o PIX ${request.sendPix ? 'vai direto ao cliente' : 'fica guardado aqui'}.${agendado ? ` ⏰ Fora do horário de pedido (${CERTIDAO_PEDIDO_DAS}h–${CERTIDAO_PEDIDO_ATE}h): o PIX do cartório vence no mesmo dia, então o pedido sai às ${String(CERTIDAO_PEDIDO_DAS).padStart(2, '0')}h.` : ''}${ajuste}`, p.userId);
  return { request, duplicate: false, agendado };
}

/** 1º tenta a PESQUISA NA WEB (Claude + fontes oficiais, ~20 s); achou com confiança alta → mesmo caminho do "cartorio_found" (card, nota, região, fila do pedido). Senão o pedido vai pra fase FIND (Mapa do ONR pela extensão). */
async function acharCartorioPelaWeb(db: Db, id: string): Promise<void> {
  try {
    const r = await db.certidaoRequest.findUnique({ where: { id } });
    if (!r || r.status !== 'FIND_WEB') return;
    const e = (r.endereco || {}) as EnderecoCertidao;
    const achado = await (require('./cartorio-regiao.service') as typeof import('./cartorio-regiao.service')).cartorioPelaWeb({ uf: r.uf, cidade: r.cidade, endereco: `${e.tipoLogradouro || ''} ${e.logradouro || ''}, ${e.numero || ''}`.trim(), bairro: e.bairro, cep: e.cep });
    const atual = await db.certidaoRequest.findUnique({ where: { id }, select: { status: true } });
    if (atual?.status !== 'FIND_WEB') return;
    const cfLead = ((await db.lead.findUnique({ where: { id: r.leadId }, select: { customFields: true } }))?.customFields || {}) as Record<string, any>;
    if (achado?.irregular && cfLead._certidaoIrregular?.resposta !== 'SIM') {
      // Fabio 30/10: área irregular pode não ter matrícula — não pede (cada pedido é cobrança) e a equipe confirma com o cliente.
      await db.certidaoRequest.update({ where: { id }, data: { status: 'FAILED', finishedAt: new Date(), detail: `Não pedi: o endereço parece estar em ÁREA IRREGULAR — ${achado.motivo}`.slice(0, 400) } });
      const cartorioAchado = achado.numero ? `${String(achado.numero).padStart(2, '0')}º - ${r.cidade.toUpperCase()}` : 'AUTO';
      const como = await (require('./certidao-offer.service') as typeof import('./certidao-offer.service')).askImovelRegular(r.accountId, r.leadId, { uf: r.uf, cidade: r.cidade, cartorio: cartorioAchado, endereco: e, sendPix: r.sendPix, userId: r.requestedById || undefined, motivo: achado.motivo }).catch(() => 'FAILED' as const);
      const perguntou = como !== 'FAILED';
      const comoTxt = como === 'ASKED' ? 'Perguntei ao cliente' : como === 'TEMPLATE' ? 'Conversa fechada: mandei o template e a pergunta sai quando o cliente responder —' : 'Fora do horário: pergunto ao cliente no primeiro horário —';
      await note(db, r.leadId, `⚠️ Certidão pelo endereço NÃO foi pedida: a pesquisa indica que o imóvel fica em ÁREA IRREGULAR e pode não ter matrícula (${achado.motivo}${achado.fonte ? ` — ${achado.fonte}` : ''}). ${perguntou ? `${comoTxt} se o imóvel tem matrícula registrada: se ele confirmar, o CRM pede a certidão sozinho.` : 'NÃO consegui perguntar ao cliente (o template falhou): pergunte se o imóvel tem matrícula registrada.'}`, r.requestedById);
      pushAll(r.accountId, '⚠️ Imóvel em área irregular?', `${await leadNameOf(db, r.leadId)}: certidão não pedida — ${perguntou ? 'perguntei ao cliente se tem matrícula' : 'pergunte ao cliente se tem matrícula'}`, r.leadId);
    } else if (achado?.numero) {
      const cartorio = `${String(achado.numero).padStart(2, '0')}º - ${r.cidade.toUpperCase()}`;
      await reportCertidao(db, { accountId: r.accountId, id, data: { event: 'cartorio_found', cidade: r.cidade, cartorio, origem: `Pesquisa na web — ${achado.cartorio} (confiança ${achado.confianca}): ${achado.motivo} (${achado.fonte})` } as any });
    } else {
      // Mapa do ONR pela extensão DESLIGADO (Fabio 29/10 21h): sem resposta da pesquisa, o pedido para e a equipe informa o cartório.
      await db.certidaoRequest.update({ where: { id }, data: { status: 'FAILED', finishedAt: new Date(), detail: 'Não achei o cartório pela pesquisa nas fontes oficiais. Diga o cartório ao Jarvis ("pede a certidão… cartório 11º") e peça de novo.' } });
      await note(db, r.leadId, '⚠️ Certidão pelo endereço NÃO foi pedida: a pesquisa nas fontes oficiais não fechou qual cartório atende o imóvel. Informe o cartório e peça de novo.', r.requestedById);
    }
  } catch (err: any) {
    console.warn('[Certidão] pesquisa do cartório na web:', err?.message);
    await db.certidaoRequest.updateMany({ where: { id, status: 'FIND_WEB' }, data: { status: 'FAILED', finishedAt: new Date(), detail: 'A pesquisa do cartório deu erro. Informe o cartório e peça de novo.' } }).catch(() => {});
  }
}

export async function listCertidoes(db: Db, p: { accountId: string; leadId?: string; limit?: number }) {
  return db.certidaoRequest.findMany({
    where: { accountId: p.accountId, ...(p.leadId ? { leadId: p.leadId } : {}) },
    orderBy: { createdAt: 'desc' }, take: Math.min(p.limit || 30, 100),
    select: { id: true, leadId: true, uf: true, cidade: true, cartorio: true, matricula: true, status: true, source: true, sendPix: true, protocolo: true, numeroRegistral: true, valorCents: true, pixExpiresAt: true, pixSentAt: true, paidAt: true, paidVia: true, detail: true, pdfName: true, driveUrl: true, files: true, attempts: true, createdAt: true, startedAt: true, finishedAt: true },
  });
}

/** Pedidos que ficaram sem dono: o que já tem protocolo vira "aguardando pagamento" (a fase PIX acha o código); o que não tem NÃO é refeito sozinho (pode já existir no portal e cobrar de novo). */
async function expireStuck(db: Db, accountId: string) {
  const agora = Date.now();
  await db.certidaoRequest.updateMany({ where: { accountId, status: 'FIND_WEB', createdAt: { lt: new Date(agora - 5 * 60_000) } }, data: { status: 'FAILED', finishedAt: new Date(), detail: 'A pesquisa do cartório não respondeu em 5 min. Informe o cartório e peça de novo.' } }).catch(() => {});
  // Achando o cartório há mais de 10 min (extensão fechada/travou): falha com motivo — dá pra pedir de novo.
  await db.certidaoRequest.updateMany({ where: { accountId, status: 'FINDING', startedAt: { lt: new Date(agora - 10 * 60_000) } }, data: { status: 'FAILED', finishedAt: new Date(), detail: 'A extensão não respondeu ao procurar o cartório no Mapa do ONR (10 min). Peça de novo.' } }).catch(() => {});
  const rodando = await db.certidaoRequest.findMany({ where: { accountId, status: 'RUNNING', startedAt: { lt: new Date(agora - RUNNING_TTL_MIN * 60_000) } }, select: { id: true, leadId: true, protocolo: true, matricula: true } });
  for (const r of rodando) {
    if (r.protocolo) await db.certidaoRequest.updateMany({ where: { id: r.id, status: 'RUNNING' }, data: { status: 'AWAITING_PAYMENT', nextCheckAt: null, detail: 'A extensão parou antes de pegar o PIX; vai tentar de novo pelo protocolo.' } });
    else {
      const u = await db.certidaoRequest.updateMany({ where: { id: r.id, status: 'RUNNING' }, data: { status: 'FAILED', finishedAt: new Date(), detail: 'A extensão parou no meio do pedido, antes do protocolo. Confira em "Visualizar Pedidos" do RI Digital se o pedido chegou a ser criado antes de pedir de novo (cada pedido é uma cobrança).' } });
      if (u.count) await note(db, r.leadId, `⚠️ A certidão ${qualCertidao(r)} NÃO foi concluída: a extensão parou no meio do pedido. Confira no RI Digital se o pedido existe antes de pedir de novo.`);
    }
  }
  const pagos = await db.certidaoRequest.findMany({ where: { accountId, status: 'AWAITING_PAYMENT', paidAt: { not: null } }, select: { id: true, leadId: true, matricula: true, protocolo: true, paidAt: true } });
  const vencidos = pagos.filter((r) => addBusinessDays(r.paidAt!, GIVE_UP_DAYS).getTime() < agora);
  for (const r of vencidos) {
    const u = await db.certidaoRequest.updateMany({ where: { id: r.id, status: 'AWAITING_PAYMENT' }, data: { status: 'FAILED', finishedAt: new Date(), nextCheckAt: null, detail: `A certidão não saiu em ${GIVE_UP_DAYS} dias úteis depois do pagamento; parei de procurar.` } });
    if (u.count) {
      await note(db, r.leadId, `⚠️ A certidão ${qualCertidao(r)}${r.protocolo ? ` (protocolo ${r.protocolo})` : ''} NÃO saiu em ${GIVE_UP_DAYS} dias úteis depois do pagamento — parei de procurar. Confira a tela do ONR/RI Digital e fale com o cartório.`);
      pushAll(accountId, '⚠️ Certidão não saiu em 3 dias úteis', `${await leadNameOf(db, r.leadId)} — matrícula ${r.matricula}: confira o ONR`, r.leadId);
    }
  }
  // Pedido da noite espera as 07h (podePedirCertidaoAgora): o tempo parado só conta a partir do início do horário de pedido de hoje.
  const velhos = !podePedirCertidaoAgora() ? [] : (await db.certidaoRequest.findMany({ where: { accountId, status: 'REQUESTED', createdAt: { lt: new Date(agora - REQUESTED_WARN_H * 3600_000) }, OR: [{ detail: null }, { detail: { not: { contains: WARN_MARK } } }] }, select: { id: true, leadId: true, matricula: true, createdAt: true } }))
    .filter((r) => agora - Math.max(r.createdAt.getTime(), inicioExpedienteHoje()) > REQUESTED_WARN_H * 3600_000);
  for (const r of velhos) {
    const u = await db.certidaoRequest.updateMany({ where: { id: r.id, status: 'REQUESTED' }, data: { detail: `Pedido ${WARN_MARK} há mais de ${REQUESTED_WARN_H} h: abra o Chrome com a extensão "Certidão ONR" (logada no CRM) que ela pega sozinha. Continua na fila, sem limite.` } });
    if (u.count) {
      await note(db, r.leadId, `⚠️ O pedido da certidão ${qualCertidao(r)} está parado há mais de ${REQUESTED_WARN_H} h: a extensão "Certidão ONR" não pegou (Chrome fechado ou sem login no CRM). Continua na fila — assim que ela abrir, faz o pedido.`);
      pushAll(accountId, '⚠️ Pedido de certidão parado', `${await leadNameOf(db, r.leadId)} — matrícula ${r.matricula}: abra o Chrome com a extensão Certidão ONR`, r.leadId);
    }
  }
}

/** Endereço do imóvel pro pedido por endereço (campos da tela "Pesquisa Por Endereço" do RI Digital). */
export type EnderecoCertidao = { cep: string; tipoLogradouro?: string; logradouro?: string; numero?: string; complemento?: string; bloco?: string; bairro?: string; loteamento?: string; quadra?: string; lote?: string; contribuinte?: string; observacao?: string };
export type CertidaoJob = { id: string; phase: 'FIND' | 'ORDER' | 'PIX' | 'COLLECT'; leadId: string; leadName: string; uf: string; cidade: string; cartorio: string; matricula: string; protocolo: string | null; numeroRegistral: string | null; pedidoPor: 'MATRICULA' | 'ENDERECO'; endereco: EnderecoCertidao | null };
/** "da matrícula 123" ou "do imóvel na Rua X, 50" — pras notas. */
export const qualCertidao = (r: { matricula: string; pedidoPor?: string | null; endereco?: unknown }) => (r.pedidoPor === 'ENDERECO' ? `do imóvel (${enderecoTexto(r.endereco as EnderecoCertidao)})` : `da matrícula ${r.matricula}`);
/** "Rua X, 50 — CEP 11449-140" (pra notas e mensagens). */
export function enderecoTexto(e: EnderecoCertidao | null | undefined): string {
  if (!e) return '';
  const rua = e.loteamento ? `Loteamento ${e.loteamento}${e.quadra ? `, quadra ${e.quadra}` : ''}${e.lote ? `, lote ${e.lote}` : ''}` : `${[e.tipoLogradouro, e.logradouro].filter(Boolean).join(' ')}${e.numero ? `, ${e.numero}` : ''}${e.complemento ? ` ${e.complemento}` : ''}`;
  return `${rua}${e.bairro ? ` — ${e.bairro}` : ''}${e.cep ? ` — CEP ${e.cep}` : ''}`.trim();
}

/** A extensão pergunta "tem serviço?" (a cada minuto). Devolve UM trabalho por vez — ela usa o navegador inteiro pra isso. */
/** PIX da certidão vencido sem pagamento: push pro colaborador (quem pediu; sem ele, a conta), nota no card e o pedido sai da conferência (FAILED). */
async function avisarPixVencidos(db: Db, accountId: string) {
  const vencidos = await db.certidaoRequest.findMany({ where: { accountId, status: 'AWAITING_PAYMENT', paidAt: null, pixCode: { not: null }, pixExpiresAt: { lt: new Date() } }, take: 10 });
  for (const r of vencidos) {
    const c = await db.certidaoRequest.updateMany({ where: { id: r.id, status: 'AWAITING_PAYMENT', paidAt: null }, data: { status: 'FAILED', finishedAt: new Date(), nextCheckAt: null, forceCheck: false, detail: `PIX vencido sem pagamento (venceu em ${r.pixExpiresAt?.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}).` } });
    if (!c.count) continue;
    const lead = await db.lead.findUnique({ where: { id: r.leadId }, select: { name: true, customFields: true, stage: { select: { name: true } } } });
    const cf = (lead?.customFields || {}) as Record<string, any>;
    // Fabio 30/10: PIX que foi ao cliente e venceu → o CRM pede de novo UMA vez (PIX novo vai ao cliente no horário de pedido); o 2º que vencer só avisa a equipe.
    const podeRefazer = !!r.pixSentAt && r.sendPix && !r.retryOfId && !cf._autoPaused && !/perdid|ganho|conclu/i.test(lead?.stage?.name || '');
    let refeito = false;
    if (podeRefazer) {
      try {
        const out = await createCertidaoRequest(db, { accountId, leadId: r.leadId, uf: r.uf, cidade: r.cidade, cartorio: r.cartorio, matricula: r.matricula, pedidoPor: r.pedidoPor === 'ENDERECO' ? 'ENDERECO' : 'MATRICULA', endereco: (r.endereco as EnderecoCertidao | null) || null, source: r.source === 'USER' ? 'USER' : 'AI', userId: r.requestedById || undefined, sendPix: true, clientIntro: 'o PIX anterior da certidão venceu, então gerei um novo' });
        if (!out.duplicate && out.request) { await db.certidaoRequest.update({ where: { id: out.request.id }, data: { retryOfId: r.id } }); refeito = true; }
      } catch (e: any) { console.warn('[Certidão] refazer PIX vencido:', e?.message); }
    }
    await note(db, r.leadId, refeito
      ? `⏰ O PIX da certidão${r.protocolo ? ` (protocolo ${r.protocolo})` : ''}${r.valorCents ? ` de ${brl(r.valorCents)}` : ''} VENCEU sem pagamento. O CRM pediu de novo (1 vez só): o PIX novo vai ao cliente ${podePedirCertidaoAgora() ? 'em seguida' : `às ${String(CERTIDAO_PEDIDO_DAS).padStart(2, '0')}h`}.`
      : `⏰ O PIX da certidão${r.protocolo ? ` (protocolo ${r.protocolo})` : ''}${r.valorCents ? ` de ${brl(r.valorCents)}` : ''} VENCEU sem pagamento${r.retryOfId ? ' pela 2ª vez' : ''}. O CRM parou de conferir esse pedido; se o cliente ainda precisar, peça a certidão de novo (gera PIX novo).`, r.requestedById);
    if (refeito) continue;
    try {
      (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title: '⏰ PIX da certidão venceu', body: `${lead?.name || 'Cliente'}: o PIX${r.valorCents ? ` de ${brl(r.valorCents)}` : ''} venceu sem pagamento${r.retryOfId ? ' (2ª vez)' : ''} — peça a certidão de novo se ainda precisar`, leadId: r.leadId }, r.requestedById ? [r.requestedById] : undefined).catch(() => {});
    } catch { /* push é só aviso */ }
  }
}

/** Fabio 30/10: às 20h pergunta ao cliente que ainda não confirmou se deu certo o pagamento do PIX que vence HOJE (1 vez; PIX enviado há mais de 1 h). */
async function lembrarPixHoje(db: Db, accountId: string, io?: Io) {
  const agora = new Date();
  const h = horaBrt(agora);
  if (h < 20 || h >= 22) return;
  const rows = await db.certidaoRequest.findMany({ where: { accountId, status: 'AWAITING_PAYMENT', paidAt: null, paidClaimedAt: null, pixRemindedAt: null, pixCode: { not: null }, pixSentAt: { lt: new Date(agora.getTime() - 3600_000) }, pixExpiresAt: { gt: agora } }, take: 10 });
  for (const r of rows) {
    if (!r.pixExpiresAt || !sameBrDay(r.pixExpiresAt, agora)) continue;
    const c = await db.certidaoRequest.updateMany({ where: { id: r.id, pixRemindedAt: null }, data: { pixRemindedAt: agora } });
    if (!c.count) continue;
    const lead = await db.lead.findUnique({ where: { id: r.leadId }, select: { name: true, customFields: true } });
    if (((lead?.customFields || {}) as any)._autoPaused) continue;
    const texto = `${firstName(lead?.name)}, deu certo o pagamento do PIX da certidão${r.valorCents ? ` (${brl(r.valorCents)})` : ''}? Ele vale só até hoje às 23h59. Se já pagou, me avisa por aqui, por favor.`;
    const out = await sendOutboundWhatsApp({ accountId, leadId: r.leadId, content: texto, userId: r.requestedById || undefined, io });
    await note(db, r.leadId, out.success ? `⏰ Perguntei ao cliente se deu certo o pagamento do PIX da certidão (vence hoje às 23h59).` : `⚠️ Não consegui perguntar ao cliente sobre o pagamento do PIX da certidão que vence hoje (${out.error || 'WhatsApp'}).`, r.requestedById);
  }
}

/** Poller do servidor (5 em 5 min): lembrete das 18h e PIX vencido (refaz 1x) — não depende do Chrome com a extensão estar aberto. */
export async function processCertidaoPix(db: Db, io?: Io) {
  const contas = await db.certidaoRequest.findMany({ where: { status: 'AWAITING_PAYMENT', paidAt: null, pixCode: { not: null } }, distinct: ['accountId'], select: { accountId: true } });
  await (require('./certidao-offer.service') as typeof import('./certidao-offer.service')).processIrregularPendentes().catch((e: any) => console.warn('[Certidão] área irregular pendente:', e?.message));
  for (const { accountId } of contas) {
    await lembrarPixHoje(db, accountId, io).catch((e) => console.warn('[Certidão] lembrete PIX:', e?.message));
    await avisarPixVencidos(db, accountId).catch((e) => console.warn('[Certidão] PIX vencido:', e?.message));
  }
}

export async function claimCertidao(db: Db, p: { accountId: string }): Promise<CertidaoJob | null> {
  await expireStuck(db, p.accountId);
  await retryCertidaoDrive(db, p.accountId).catch((e) => console.warn('[Certidão] reenvio ao Drive falhou:', e?.message));
  const now = new Date();
  const toJob = async (r: { id: string; leadId: string; uf: string; cidade: string; cartorio: string; matricula: string; protocolo: string | null; numeroRegistral: string | null; pedidoPor: string; endereco: unknown }, phase: CertidaoJob['phase']): Promise<CertidaoJob> => {
    const lead = await db.lead.findUnique({ where: { id: r.leadId }, select: { name: true } });
    return { id: r.id, phase, leadId: r.leadId, leadName: lead?.name || 'Sem nome', uf: r.uf, cidade: r.cidade, cartorio: r.cartorio, matricula: r.matricula, protocolo: r.protocolo, numeroRegistral: r.numeroRegistral, pedidoPor: r.pedidoPor === 'ENDERECO' ? 'ENDERECO' : 'MATRICULA', endereco: (r.endereco as EnderecoCertidao | null) || null };
  };
  // 0) achar o cartório no Mapa do ONR (antes do pedido)
  const achar = await db.certidaoRequest.findMany({ where: { accountId: p.accountId, status: 'FIND' }, orderBy: { createdAt: 'asc' }, take: 3 });
  for (const r of achar) {
    const c = await db.certidaoRequest.updateMany({ where: { id: r.id, status: 'FIND' }, data: { status: 'FINDING', startedAt: now, detail: 'A extensão está procurando o cartório no Mapa do ONR pelo endereço.' } });
    if (c.count) return toJob(r, 'FIND');
  }
  // 1) pedido novo — só das 07h às 20h (o PIX vence no mesmo dia às 23:59): fora disso fica na fila
  const novos = podePedirCertidaoAgora() ? await db.certidaoRequest.findMany({ where: { accountId: p.accountId, status: 'REQUESTED' }, orderBy: { createdAt: 'asc' }, take: 3 }) : [];
  for (const r of novos) {
    const c = await db.certidaoRequest.updateMany({ where: { id: r.id, status: 'REQUESTED' }, data: { status: 'RUNNING', startedAt: now, detail: 'A extensão pegou o pedido e está preenchendo o portal.' } });
    if (c.count) return toJob(r, 'ORDER');
  }
  // 2) pedido feito, PIX ainda não capturado
  const semPix = await db.certidaoRequest.findMany({ where: { accountId: p.accountId, status: 'AWAITING_PAYMENT', protocolo: { not: null }, pixCode: null, attempts: { lt: PIX_MAX_ATTEMPTS }, OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: now } }] }, orderBy: { createdAt: 'asc' }, take: 3 });
  for (const r of semPix) {
    const c = await db.certidaoRequest.updateMany({ where: { id: r.id, status: 'AWAITING_PAYMENT', pixCode: null, attempts: r.attempts }, data: { attempts: { increment: 1 }, nextCheckAt: new Date(now.getTime() + 4 * 60_000), startedAt: now } });
    if (c.count) return toJob(r, 'PIX');
  }
  // PIX VENCIDO sem pagamento (Fabio 29/10): avisa o colaborador em push e para de conferir esse pedido (fica FAILED — dá pra pedir de novo).
  await avisarPixVencidos(db, p.accountId).catch((e) => console.warn('[Certidão] PIX vencido:', e?.message));
  // 3) Pagamento CONFIRMADO (comprovante, e-mail do cartório, equipe) ou consulta pedida (cliente disse que pagou / botão do card): confere no portal.
  // Fabio 30/10: PIX não pago NÃO é conferido de 4 em 4 h — às 20h a IA pergunta ao cliente se deu certo e só consulta quando ele diz que pagou.
  if (foraDoHorario()) return null;
  // (botão "Buscar certidão agora" = forceCheck: uma busca avulsa mesmo sem pagamento confirmado)
  const aguardando = await db.certidaoRequest.findMany({ where: { accountId: p.accountId, status: 'AWAITING_PAYMENT', protocolo: { not: null }, AND: [{ OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: now } }] }, { OR: [{ pixCode: { not: null }, paidAt: { not: null } }, { forceCheck: true }] }] }, orderBy: { createdAt: 'asc' }, take: 3 });
  for (const r of aguardando) {
    const c = await db.certidaoRequest.updateMany({ where: { id: r.id, status: 'AWAITING_PAYMENT' }, data: { forceCheck: false, nextCheckAt: new Date(now.getTime() + PAID_CHECK_EVERY_MIN * 60_000) } });
    if (c.count) return toJob(r, 'COLLECT');
  }
  // Pedido JÁ EMITIDO que a equipe mandou baixar de novo (botão do card): pega os arquivos que faltavam (o ONR devolve matrícula + certidão de ônus).
  const reabaixar = await db.certidaoRequest.findMany({ where: { accountId: p.accountId, status: 'ISSUED', protocolo: { not: null }, forceCheck: true }, orderBy: { createdAt: 'asc' }, take: 3 });
  for (const r of reabaixar) {
    const c = await db.certidaoRequest.updateMany({ where: { id: r.id, status: 'ISSUED', forceCheck: true }, data: { forceCheck: false } });
    if (c.count) return toJob(r, 'COLLECT');
  }
  return null;
}

async function sendPixToClient(db: Db, r: { id: string; accountId: string; leadId: string; pixCode: string | null; valorCents: number | null; pixExpiresAt: Date | null; clientIntro: string | null; requestedById: string | null; source: string }, io?: Io): Promise<{ ok: boolean; error?: string }> {
  if (!r.pixCode) return { ok: false, error: 'sem código' };
  const lead = await db.lead.findUnique({ where: { id: r.leadId }, select: { name: true } });
  const valor = r.valorCents ? ` (${brl(r.valorCents)})` : '';
  const validade = r.pixExpiresAt ? (sameBrDay(r.pixExpiresAt, new Date()) ? `válido até hoje (${brDate(r.pixExpiresAt)})` : `válido até ${brDate(r.pixExpiresAt)}`) : 'válido por pouco tempo';
  const intro = r.clientIntro || 'segue o PIX da certidão da matrícula';
  const texto = `${firstName(lead?.name)}, ${intro}${valor}, ${validade}. O código está na mensagem logo abaixo, é só copiar e colar no app do seu banco (opção "Pix Copia e Cola").\n\nQuando o pagamento cair, o cartório emite a certidão em até 4 horas úteis e a gente segue com a sua análise. Me avisa por aqui assim que pagar, tá?`;
  const a = await sendOutboundWhatsApp({ accountId: r.accountId, leadId: r.leadId, content: texto, userId: r.requestedById || undefined, io });
  if (!a.success) return { ok: false, error: a.error };
  const b = await sendOutboundWhatsApp({ accountId: r.accountId, leadId: r.leadId, content: r.pixCode, userId: r.requestedById || undefined, io });
  return b.success ? { ok: true } : { ok: false, error: b.error };
}

export type CertidaoEvent =
  | { event: 'step'; detail?: string }
  | { event: 'cartorio_found'; cidade: string; cartorio: string; origem?: string }
  | { event: 'ordered'; protocolo: string; numeroRegistral?: string; valorCents?: number }
  | { event: 'pix'; code: string; expiresAt?: string; valorCents?: number }
  | { event: 'status'; portalStatus?: string; detail?: string; paid?: boolean }
  | { event: 'issued_manual'; reason?: string }
  | { event: 'failed'; reason: string };

/** A extensão conta o que aconteceu. */
export async function reportCertidao(db: Db, p: { accountId: string; id: string; data: CertidaoEvent & Record<string, any>; io?: Io }) {
  const r = await db.certidaoRequest.findFirst({ where: { id: p.id, accountId: p.accountId } });
  if (!r) throw new Error('Pedido de certidão não encontrado');
  const d = p.data;
  let out = r;
  if (d.event === 'step') {
    out = await db.certidaoRequest.update({ where: { id: r.id }, data: { detail: String(d.detail || '').slice(0, 400) } });
  } else if (d.event === 'cartorio_found') {
    // O cartório da escritura não fica na cidade dela no portal (DF: cada Ofício numa região): a extensão achou em outra cidade do estado e memorizou.
    const cidade = String(d.cidade || '').trim().slice(0, 80), cartorio = String(d.cartorio || '').trim().slice(0, 120);
    if (!cidade || !cartorio) throw new Error('cidade/cartório vazios');
    const achando = r.status === 'FINDING' || r.status === 'FIND' || r.status === 'FIND_WEB';
    out = await db.certidaoRequest.update({ where: { id: r.id }, data: { cidade, cartorio, ...(achando ? (r.source === 'MAPA' ? { status: 'LOOKUP_DONE', finishedAt: new Date() } : { status: 'REQUESTED', startedAt: null }) : {}), detail: achando ? (r.source === 'MAPA' ? `Só consulta: cartório ${cartorio} gravado no card.` : `Cartório achado no Mapa do ONR: ${cartorio}. Agora a extensão faz o pedido no RI Digital.`) : `Cartório achado no portal: ${cartorio} (${cidade}).` } });
    const doMapa = /^(Mapa do ONR|Pesquisa na web)/i.test(String(d.origem || ''));
    if (doMapa) {
      // Achado pelo Mapa do ONR (endereço → cartório): o CRM grava NA HORA a região (CEP + bairro → cartório), sem esperar a certidão sair (Fabio 29/10: "esse conhecimento deve ir pro CRM também").
      const e = (r.endereco || {}) as any;
      await (require('./cartorio-regiao.service') as typeof import('./cartorio-regiao.service')).aprenderCartorio(r.accountId, { uf: r.uf, cidade, cartorio, cep: e.cep, bairro: e.bairro }).catch(() => {});
      // E vai pro CARD do cliente: campo "Cartório de registro" (cartorio_registro), se ainda estiver vazio (Fabio 29/10: "quando achar, coloca no card do cliente").
      try {
        const lead = await db.lead.findUnique({ where: { id: r.leadId }, select: { customFields: true } });
        const cf = { ...((lead?.customFields || {}) as Record<string, any>) };
        if (!String(cf.cartorio_registro || '').trim()) {
          const txt = /(\d{1,2})\s*[º°ª]?\s*(?:Oficial de\s+|Of[íi]cio de\s+)?Registro de Im[óo]veis (?:da Comarca )?(?:de|do|da) [^.(:]+/i.exec(String(d.origem || ''));
          cf.cartorio_registro = (txt ? txt[0] : cartorio).replace(/\s+-\s+[A-Z]{2}\s*$/, '').trim().slice(0, 120);
          await db.lead.update({ where: { id: r.leadId }, data: { customFields: cf as any } });
        }
      } catch { /* o card é bônus */ }
      await note(db, r.leadId, `🗺️ Certidão: ${/^Pesquisa/i.test(String(d.origem)) ? 'a pesquisa nas fontes oficiais' : 'o Mapa do ONR'} diz que o imóvel é do ${cartorio} (${String(d.origem).replace(/^(Mapa do ONR|Pesquisa na web)\s*—\s*/i, '')}). O CRM guardou pra região (CEP ${String(e.cep || '').slice(0, 5)} / ${e.bairro || '—'}).`, r.requestedById);
    } else await note(db, r.leadId, `🏛️ Certidão: o cartório "${String(d.origem || r.cartorio)}" fica no portal como ${cartorio} (cidade ${cidade}). A extensão memorizou pra próxima vez.`, r.requestedById);
  } else if (d.event === 'ordered') {
    const protocolo = String(d.protocolo || '').trim();
    if (!PROTO_OK.test(protocolo.toUpperCase())) throw new Error('protocolo inválido');
    out = await db.certidaoRequest.update({ where: { id: r.id }, data: { status: 'AWAITING_PAYMENT', protocolo, numeroRegistral: d.numeroRegistral ? String(d.numeroRegistral).slice(0, 40) : r.numeroRegistral, valorCents: Number.isInteger(d.valorCents) ? d.valorCents : r.valorCents, detail: 'Pedido feito no RI Digital; pegando o código PIX.', nextCheckAt: null } });
    await note(db, r.leadId, `🏛️ Certidão ${qualCertidao(r)} pedida no RI Digital — protocolo ${protocolo}${out.valorCents ? `, ${brl(out.valorCents)}` : ''}. Falta o pagamento do PIX.`, r.requestedById);
  } else if (d.event === 'pix') {
    const code = String(d.code || '').trim();
    if (!looksLikePix(code)) throw new Error('o código recebido não parece um PIX Copia e Cola');
    const valorCents = pixAmountCents(code) ?? (Number.isInteger(d.valorCents) ? d.valorCents : r.valorCents);
    // Conferência de segurança: o PIX tem que ser do valor do pedido (ONR é o recebedor; qualquer outro valor é sinal de tela errada)
    if (r.valorCents && valorCents && Math.abs(r.valorCents - valorCents) > 1) throw new Error(`o PIX é de ${brl(valorCents)}, mas o pedido é de ${brl(r.valorCents)} — não enviei ao cliente`);
    const exp = d.expiresAt ? new Date(d.expiresAt) : null;
    out = await db.certidaoRequest.update({ where: { id: r.id }, data: { status: 'AWAITING_PAYMENT', pixCode: code, valorCents, pixExpiresAt: exp && !isNaN(exp.getTime()) ? exp : r.pixExpiresAt, detail: 'PIX capturado.', nextCheckAt: new Date(Date.now() + CHECK_EVERY_MIN * 60_000) } });
    if (out.sendPix && !out.pixSentAt) {
      const s = await sendPixToClient(db, out, p.io);
      if (s.ok) {
        out = await db.certidaoRequest.update({ where: { id: r.id }, data: { pixSentAt: new Date(), detail: 'PIX enviado ao cliente; aguardando o pagamento e a emissão.' } });
        await note(db, r.leadId, `💸 PIX da certidão (${brl(out.valorCents)}) enviado ao cliente — protocolo ${out.protocolo}.`, r.requestedById);
      } else {
        out = await db.certidaoRequest.update({ where: { id: r.id }, data: { detail: `PIX capturado, mas NÃO consegui mandar ao cliente: ${s.error}` } });
        await note(db, r.leadId, `⚠️ O PIX da certidão (${brl(out.valorCents)}, protocolo ${out.protocolo}) foi gerado, mas o envio ao cliente falhou: ${s.error}. Código para mandar à mão:\n${code}`, r.requestedById);
      }
    } else if (!out.sendPix) {
      await note(db, r.leadId, `💸 PIX da certidão (${brl(out.valorCents)}, protocolo ${out.protocolo}) gerado e guardado no CRM — não foi enviado ao cliente (pedido sem envio automático). Código:\n${code}`, r.requestedById);
      // Quem pediu fica com o PIX pra encaminhar (Jarvis "deixa o PIX no chat"): avisa no celular/navegador.
      if (r.requestedById) {
        const lead = await db.lead.findUnique({ where: { id: r.leadId }, select: { name: true } });
        try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(r.accountId, { title: '💸 PIX da certidão pronto', body: `${lead?.name || 'Cliente'}: ${brl(out.valorCents)} — peça ao assistente "o PIX da certidão" pra copiar (está também nas anotações do card)`, leadId: r.leadId }, [r.requestedById]).catch(() => {}); } catch { /* push é só aviso */ }
      }
    }
  } else if (d.event === 'status') {
    out = await db.certidaoRequest.update({ where: { id: r.id }, data: { detail: String(d.detail || (d.portalStatus ? `No portal: ${d.portalStatus}` : r.detail || '')).slice(0, 400) } });
    // Fabio 30/10: cliente pagou e não avisou → a extensão vê no portal (botão do PIX sumiu / coluna Pagamento preenchida) e o CRM confirma sozinho.
    if (d.paid === true && !r.paidAt && r.status === 'AWAITING_PAYMENT') out = (await markCertidaoPaid(db, { accountId: p.accountId, id: r.id, via: 'PORTAL', io: p.io })) || out;
    else if (!r.paidAt && r.paidClaimedAt && r.status === 'AWAITING_PAYMENT') {
      if (Date.now() - r.paidClaimedAt.getTime() < 2 * 3600_000) out = await db.certidaoRequest.update({ where: { id: r.id }, data: { forceCheck: true, nextCheckAt: new Date(Date.now() + 30 * 60_000) } });
      else {
        out = await db.certidaoRequest.update({ where: { id: r.id }, data: { paidClaimedAt: null } });
        await note(db, r.leadId, `⚠️ O cliente disse que pagou o PIX da certidão${r.protocolo ? ` (protocolo ${r.protocolo})` : ''}, mas em 2 horas o pagamento não apareceu no RI Digital nem chegou o e-mail do cartório. Peça o comprovante ao cliente.`, r.requestedById);
        pushAll(p.accountId, '⚠️ Pagamento da certidão não apareceu', `${await leadNameOf(db, r.leadId)}: disse que pagou, mas o portal não mostra — peça o comprovante`, r.leadId);
      }
    }
  } else if (d.event === 'issued_manual') {
    // A certidão saiu, mas a extensão não conseguiu mandar o PDF ao CRM (ficou na pasta Downloads do Chrome do Fabio): fecha o pedido e avisa a equipe.
    out = await db.certidaoRequest.update({ where: { id: r.id }, data: { status: 'ISSUED', finishedAt: new Date(), nextCheckAt: null, detail: String(d.reason || 'Certidão emitida; PDF fora do CRM.').slice(0, 400) } });
    void (require('./cartorio-regiao.service') as typeof import('./cartorio-regiao.service')).aprenderDoPedido(r.id);
    await note(db, r.leadId, `📄 Certidão ${qualCertidao(r)} EMITIDA (protocolo ${out.protocolo || '—'}), mas o PDF NÃO ficou no CRM: ${String(d.reason || '').slice(0, 200)}. Baixe em "Visualizar Pedidos" do RI Digital.`, r.requestedById);
  } else if (d.event === 'failed') {
    const reason = String(d.reason || 'a extensão não conseguiu').slice(0, 500);
    if (r.protocolo) {
      // pedido existe no portal: não é falha do pedido, só desta tentativa (a fase PIX/COLLECT tenta de novo)
      out = await db.certidaoRequest.update({ where: { id: r.id }, data: { detail: `Última tentativa: ${reason}` } });
      if (!r.pixCode && r.attempts >= PIX_MAX_ATTEMPTS) await note(db, r.leadId, `⚠️ Não consegui pegar o PIX do pedido ${r.protocolo} (${PIX_MAX_ATTEMPTS} tentativas): ${reason}. Abra "Visualizar Pedidos" no RI Digital e clique no ícone do PIX.`, r.requestedById);
    } else {
      out = await db.certidaoRequest.update({ where: { id: r.id }, data: { status: 'FAILED', finishedAt: new Date(), detail: reason } });
      await note(db, r.leadId, `⚠️ A certidão ${qualCertidao(r)} NÃO foi pedida: ${reason}`, r.requestedById);
      // A escritura não dizia qual é o cartório (ou o nome não bateu) e a cidade tem mais de um: confirma com o cliente (Fabio 20/10).
      if (/cart[óo]rios? no portal|n[ãa]o existe em/i.test(reason)) {
        try { await (require('./certidao-offer.service') as typeof import('./certidao-offer.service')).askClientCartorio(p.accountId, { id: r.id, leadId: r.leadId, matricula: r.matricula, cidade: r.cidade, uf: r.uf, endereco: r.pedidoPor === 'ENDERECO' ? enderecoTexto(r.endereco as any) : '' }, reason, p.io as any); } catch (e: any) { console.warn('[Certidão] pergunta do cartório:', e?.message); }
      }
    }
  }
  emitUpdate(p.io, p.accountId, r.leadId, r.id);
  return out;
}

const pushAll = (accountId: string, title: string, body: string, leadId: string) => {
  try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title, body, leadId }).catch(() => {}); } catch { /* push é só aviso */ }
};
const leadNameOf = async (db: Db, leadId: string) => (await db.lead.findUnique({ where: { id: leadId }, select: { name: true } }))?.name || 'Cliente';

/**
 * Guarda a certidão emitida na pasta do cliente no Drive, subpasta IMOVEL (mesma convenção do organizador de documentos:
 * documento do imóvel vai pra IMOVEL). A pasta vem do campo "Pasta no Drive" do card; sem ele, procura pelo nome do cliente.
 * O CRM NÃO guarda o PDF (Fabio 19/10): se o Drive falhar, os bytes ficam só de passagem e são reenviados até subir (retryCertidaoDrive).
 */
export async function saveCertidaoToDrive(db: Db, r: { accountId: string; leadId: string; matricula: string }, pdf: Buffer, nomeDoArquivo?: string): Promise<{ ok: true; fileId: string; fileUrl: string; folderUrl: string; fileName: string } | { ok: false; reason: string }> {
  try {
    const { createFolder, uploadFile, extractFolderId, findFolderByNameUnderRoot, folderLink } = await import('./google.service');
    const lead = await db.lead.findUnique({ where: { id: r.leadId }, select: { name: true, customFields: true, stage: { select: { name: true } } } });
    if (!lead) return { ok: false, reason: 'card não encontrado' };
    // Card já no registro/pagamento ao vendedor: é a certidão PÓS-REGISTRO (Fabio 29/10: "renomear a ônus para ônus pós registro").
    if (!nomeDoArquivo && /registro em cart|pagamento ao vendedor/i.test(lead.stage?.name || '')) nomeDoArquivo = `CERTIDAO DE ONUS POS REGISTRO - MATRICULA ${r.matricula}.pdf`;
    const link = String(((lead.customFields || {}) as Record<string, unknown>).link_pasta_drive || '').trim();
    let clientFolderId = link ? extractFolderId(link) : '';
    if (!clientFolderId) clientFolderId = (await findFolderByNameUnderRoot(r.accountId, lead.name))?.folderId || '';
    if (!clientFolderId) return { ok: false, reason: 'não achei a pasta do cliente no Drive' };
    const imovel = await createFolder(r.accountId, 'IMOVEL', clientFolderId);
    const fileName = (nomeDoArquivo || `CERTIDAO DE ONUS - MATRICULA ${r.matricula} (inteiro teor).pdf`).replace(/[\\/:*?"<>|]/g, ' ');
    const up = await uploadFile(r.accountId, { name: fileName, mimeType: 'application/pdf', data: pdf, parentId: imovel.id });
    return { ok: true, fileId: up.id, fileUrl: up.webViewLink || folderLink(imovel.id), folderUrl: folderLink(imovel.id), fileName };
  } catch (err: any) {
    return { ok: false, reason: String(err?.message || err).slice(0, 160) };
  }
}

export type CertidaoFile = { name: string; driveFileId?: string | null; driveUrl?: string | null; sha?: string; size: number; at: string };
const shaOf = (b: Buffer | Uint8Array) => crypto.createHash('sha1').update(b).digest('hex');
const isPdf = (b: Buffer) => b.length >= 1000 && b.subarray(0, 5).toString('latin1') === '%PDF-';

/**
 * A extensão achou a certidão pronta e devolve o(s) arquivo(s) do pedido (Fabio 23/10: o ONR devolve DOIS arquivos — matrícula e certidão de ônus — e o CRM só guardava o primeiro).
 * Cada arquivo vai pro Drive (pasta IMOVEL); todos ficam listados em `files`. Arquivo repetido (mesmo conteúdo) é ignorado, então dá pra buscar de novo sem duplicar: só o que é NOVO
 * é conferido pela IA e encaminhado ao cliente. A equipe é avisada por push.
 */
export async function finishCertidaoFiles(db: Db, p: { accountId: string; id: string; files: { buffer: Buffer; name?: string }[]; io?: Io }) {
  const r = await db.certidaoRequest.findFirst({ where: { id: p.id, accountId: p.accountId } });
  if (!r) throw new Error('Pedido de certidão não encontrado');
  const entradas = p.files.filter((f) => isPdf(f.buffer));
  if (!entradas.length) throw new Error('nenhum dos arquivos é um PDF');
  const nome = await leadNameOf(db, r.leadId);

  // arquivos que o pedido já tem (o 1º salvo antes deste recurso entra sem sha: calcula baixando do Drive só se precisar)
  let files: CertidaoFile[] = Array.isArray(r.files) ? [...(r.files as unknown as CertidaoFile[])] : [];
  if (!files.length && r.driveFileId) files.push({ name: r.pdfName || 'certidao.pdf', driveFileId: r.driveFileId, driveUrl: r.driveUrl, size: 0, at: (r.finishedAt || r.updatedAt).toISOString() });
  for (const f of files) {
    if (f.sha || !f.driveFileId) continue;
    try { const { downloadDriveFile } = await import('./google.service'); const buf = await downloadDriveFile(r.accountId, f.driveFileId, 'application/pdf'); f.sha = shaOf(buf); f.size = buf.length; } catch { /* sem sha: não deduplica esse */ }
  }
  const novos = entradas
    .map((e) => ({ ...e, sha: shaOf(e.buffer) }))
    .filter((e, i, arr) => arr.findIndex((x) => x.sha === e.sha) === i && !files.some((f) => f.sha === e.sha));
  if (!novos.length) return { row: r, novos: 0 };

  const totalNoPortal = files.length + novos.length;
  const nomeDe = (orig: string | undefined, i: number) => {
    if (totalNoPortal === 1) return undefined; // nome padrão de sempre
    const base = (orig || '').replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]/g, ' ').trim();
    return `CERTIDAO - MATRICULA ${r.matricula} - ${base || `arquivo ${files.length + i + 1}`}.pdf`;
  };
  const salvos: (CertidaoFile & { buffer: Buffer })[] = [];
  let falha = '';
  for (let i = 0; i < novos.length; i++) {
    const d = await saveCertidaoToDrive(db, r, novos[i].buffer, nomeDe(novos[i].name, i));
    if (d.ok) salvos.push({ name: d.fileName, driveFileId: d.fileId, driveUrl: d.fileUrl, sha: novos[i].sha, size: novos[i].buffer.length, at: new Date().toISOString(), buffer: novos[i].buffer });
    else falha = d.reason;
  }

  let out;
  if (salvos.length) {
    const todos: CertidaoFile[] = [...files, ...salvos.map(({ buffer: _b, ...f }) => f)];
    const primeiro = todos[0];
    out = await db.certidaoRequest.update({ where: { id: r.id }, data: { status: 'ISSUED', files: todos as any, pdf: null, pdfName: primeiro.name, driveFileId: primeiro.driveFileId || null, driveUrl: primeiro.driveUrl || null, finishedAt: r.finishedAt || new Date(), detail: `Certidão emitida e salva no Drive (pasta IMOVEL) — ${todos.length} arquivo${todos.length > 1 ? 's' : ''}.`, nextCheckAt: null, forceCheck: false } });
    void (require('./cartorio-regiao.service') as typeof import('./cartorio-regiao.service')).aprenderDoPedido(r.id);
    await note(db, r.leadId, `📄 Certidão ${qualCertidao(r)} EMITIDA (protocolo ${out.protocolo || '—'}) — ${salvos.length > 1 ? `${salvos.length} arquivos novos salvos` : '1 arquivo novo salvo'} no Drive, subpasta IMOVEL:\n${salvos.map((f) => `• ${f.name}: ${f.driveUrl}`).join('\n')}${falha ? `\n⚠️ Outro arquivo NÃO subiu pro Drive (${falha}) — baixe do ONR.` : ''}`, r.requestedById);
    pushAll(p.accountId, '📄 Certidão emitida e salva no Drive', `${nome} — matrícula ${r.matricula} (${salvos.length > 1 ? `${salvos.length} arquivos, ` : ''}pasta IMOVEL)`, r.leadId);
  } else {
    // Drive fora do ar / pasta não achada: guarda o 1º PDF só de passagem (como sempre) e tenta de novo a cada 10 min
    const nomeTrans = (novos[0].name || `Certidao matricula ${r.matricula}.pdf`).replace(/[\\/:*?"<>|]/g, ' ').slice(0, 120);
    out = await db.certidaoRequest.update({ where: { id: r.id }, data: { status: 'ISSUED', pdf: novos[0].buffer, pdfName: nomeTrans, finishedAt: new Date(), detail: `Certidão emitida, mas NÃO subiu pro Drive (${falha}); o CRM tenta de novo a cada 10 min.`, nextCheckAt: new Date(Date.now() + 10 * 60_000) } });
    void (require('./cartorio-regiao.service') as typeof import('./cartorio-regiao.service')).aprenderDoPedido(r.id);
    await note(db, r.leadId, `⚠️ Certidão ${qualCertidao(r)} EMITIDA, mas NÃO consegui salvar no Drive (${falha}). O CRM guarda o PDF só de passagem e tenta de novo a cada 10 minutos.`, r.requestedById);
    pushAll(p.accountId, '⚠️ Certidão emitida, mas NÃO foi pro Drive', `${nome} — matrícula ${r.matricula}: ${falha}. Vou tentar de novo.`, r.leadId);
  }
  emitUpdate(p.io, p.accountId, r.leadId, r.id);
  // Em segundo plano (não segura a extensão): a IA lê o(s) arquivo(s) NOVO(S), confere o dono do imóvel e avisa/encaminha ao cliente (certidao-followup.service).
  const lista = salvos.length ? salvos : novos.map((n) => ({ name: n.name || `Certidao matricula ${r.matricula}.pdf`, buffer: n.buffer }));
  import('./certidao-followup.service').then((m) => m.afterCertidaoSaved(db, { accountId: p.accountId, requestId: r.id, leadId: r.leadId, matricula: r.matricula, pdf: lista[0].buffer, extras: lista.slice(1).map((x) => ({ buffer: x.buffer, name: x.name })), primaryName: lista[0].name, io: p.io })).catch((e) => console.error('[Certidão] conferência/envio ao cliente falhou:', e?.message));
  return { row: out, novos: novos.length };
}

/** Compatível com a extensão antiga: um PDF só. */
export async function finishCertidao(db: Db, p: { accountId: string; id: string; pdf: Buffer; pdfName?: string; io?: Io }) {
  const r = await finishCertidaoFiles(db, { accountId: p.accountId, id: p.id, files: [{ buffer: p.pdf, name: p.pdfName }], io: p.io });
  return r.row;
}

/** PDFs que não subiram pro Drive (Drive fora do ar, pasta não achada): tenta de novo (chamada a cada minuto pela fila da extensão); ao subir, zera os bytes do banco. */
export async function retryCertidaoDrive(db: Db, accountId: string): Promise<void> {
  const rows = await db.certidaoRequest.findMany({ where: { accountId, status: 'ISSUED', pdf: { not: null }, driveUrl: null, OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: new Date() } }] }, take: 3 });
  for (const r of rows) {
    const drive = await saveCertidaoToDrive(db, r, Buffer.from(r.pdf!));
    if (!drive.ok) { await db.certidaoRequest.update({ where: { id: r.id }, data: { nextCheckAt: new Date(Date.now() + 10 * 60_000) } }); continue; }
    await db.certidaoRequest.update({ where: { id: r.id }, data: { pdf: null, pdfName: drive.fileName, driveFileId: drive.fileId, driveUrl: drive.fileUrl, nextCheckAt: null, detail: 'Certidão salva no Drive (pasta IMOVEL).' } });
    await note(db, r.leadId, `📁 Agora sim: a certidão ${qualCertidao(r)} foi salva no Drive, subpasta IMOVEL:\n${drive.fileUrl}`, r.requestedById);
    pushAll(accountId, '📄 Certidão salva no Drive', `${await leadNameOf(db, r.leadId)} — matrícula ${r.matricula} (pasta IMOVEL)`, r.leadId);
  }
}

/** Botão "Buscar certidão agora" do card: a extensão vai ao portal já no próximo minuto (dentro de 07h–21h), mesmo sem pagamento confirmado, e o PDF achado vai pro Drive. */
export async function requestCollectNow(db: Db, p: { accountId: string; id: string; io?: Io }): Promise<{ queuedUntilMorning: boolean }> {
  const r = await db.certidaoRequest.findFirst({ where: { id: p.id, accountId: p.accountId } });
  if (!r) throw new Error('Pedido de certidão não encontrado');
  if (!['AWAITING_PAYMENT', 'ISSUED'].includes(r.status) || !r.protocolo) throw new Error('Só dá pra buscar um pedido que já foi feito no portal (aguardando a emissão ou já emitido, pra baixar os arquivos de novo)');
  await db.certidaoRequest.update({ where: { id: r.id }, data: { forceCheck: true, nextCheckAt: new Date(), detail: r.status === 'ISSUED' ? 'Busca dos arquivos pedida pela equipe; a extensão baixa de novo e só o que for novo vai pro Drive e pro cliente.' : 'Busca imediata pedida pela equipe; a extensão vai ao portal no próximo minuto.' } });
  emitUpdate(p.io, p.accountId, r.leadId, r.id);
  return { queuedUntilMorning: foraDoHorario() };
}

/**
 * Pedido que já foi feito E pago no portal fora do CRM (ex.: a equipe pediu à mão): adota o número que está no RI Digital (P… do pedido ou S… da certidão emitida),
 * marca como pago e manda a extensão buscar já — o PDF vai pra pasta do cliente no Drive. Não faz nada no portal além de procurar.
 */
export async function adoptCertidaoProtocol(db: Db, p: { accountId: string; id: string; protocolo: string; io?: Io }) {
  const protocolo = String(p.protocolo || '').trim().toUpperCase();
  if (!PROTO_OK.test(protocolo)) throw new Error('Protocolo inválido (ex.: S26100543707D)');
  const r = await db.certidaoRequest.findFirst({ where: { id: p.id, accountId: p.accountId } });
  if (!r) throw new Error('Pedido de certidão não encontrado');
  if (r.status === 'ISSUED') throw new Error('Esse pedido já foi emitido');
  const out = await db.certidaoRequest.update({ where: { id: r.id }, data: { status: 'AWAITING_PAYMENT', protocolo, paidAt: new Date(), paidVia: 'MANUAL', forceCheck: true, nextCheckAt: new Date(), finishedAt: null, pixCode: r.pixCode || 'ADOTADO', detail: `Pedido ${protocolo} adotado (feito e pago fora do CRM); a extensão vai buscar a certidão no portal.` } });
  await note(db, r.leadId, `📥 Certidão ${qualCertidao(r)} ligada ao pedido ${protocolo} do RI Digital (feito e pago fora do CRM). A extensão "Certidão ONR" vai buscar o PDF e salvar na pasta do cliente no Drive.`);
  emitUpdate(p.io, p.accountId, r.leadId, r.id);
  return out;
}

/** Pagamento da certidão CONFIRMADO (comprovante do cliente, e-mail do cartório ou a equipe): só a partir daqui a extensão vai buscar a certidão — sem pagamento não há o que procurar. */
export async function markCertidaoPaid(db: Db, p: { accountId: string; id: string; via: 'PROOF' | 'EMAIL' | 'MANUAL' | 'PORTAL'; io?: Io }) {
  const r = await db.certidaoRequest.findFirst({ where: { id: p.id, accountId: p.accountId } });
  if (!r || r.status !== 'AWAITING_PAYMENT') return null;
  if (r.paidAt) return r;
  const how = p.via === 'PROOF' ? 'pelo comprovante que o cliente mandou' : p.via === 'EMAIL' ? 'pelo e-mail do cartório (RI Digital)' : p.via === 'PORTAL' ? 'na lista de pedidos do RI Digital (o cliente pagou sem avisar)' : 'pela equipe';
  const out = await db.certidaoRequest.update({ where: { id: r.id }, data: { paidAt: new Date(), paidVia: p.via, nextCheckAt: new Date(), detail: `Pagamento confirmado ${how}; a extensão vai buscar a certidão.` } });
  await note(db, r.leadId, `✅ Pagamento da certidão (matrícula ${r.matricula}${r.protocolo ? `, protocolo ${r.protocolo}` : ''}) CONFIRMADO ${how}. A extensão "Certidão ONR" vai buscar a certidão no portal.`);
  pushAll(p.accountId, '💸 Pagamento da certidão confirmado', `${await leadNameOf(db, r.leadId)} — matrícula ${r.matricula}`, r.leadId);
  emitUpdate(p.io, p.accountId, r.leadId, r.id);
  return out;
}

/**
 * O cliente mandou uma foto/arquivo depois de receber o PIX da certidão: se for o COMPROVANTE desse PIX (pagamento efetuado, valor do pedido, favorecido ONR),
 * confirma o pagamento (Fabio 19/10: "ele pode confirmar através do comprovante de pagamento, igual ao do Pedro"). Qualquer dúvida: não confirma e avisa a equipe.
 */
export async function checkPaymentProof(db: Db, p: { accountId: string; leadId: string; att: { id: string; fileName?: string | null; mimeType: string; data?: Buffer | Uint8Array | null; driveFileId?: string | null }; io?: Io }): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const isPdf = p.att.mimeType === 'application/pdf';
  if (!apiKey || (!isPdf && !/^image\//.test(p.att.mimeType))) return;
  const pend = await db.certidaoRequest.findMany({ where: { accountId: p.accountId, leadId: p.leadId, status: 'AWAITING_PAYMENT', paidAt: null, pixSentAt: { not: null } }, orderBy: { createdAt: 'desc' }, take: 3 });
  if (!pend.length) return;
  let buffer: Buffer; let mime = p.att.mimeType;
  if (p.att.data && p.att.data.length) buffer = Buffer.from(p.att.data);
  else if (p.att.driveFileId) ({ buffer, mimeType: mime } = await (await import('./google.service')).downloadDriveFileForVision(p.accountId, p.att.driveFileId, p.att.mimeType));
  else return;
  if (buffer.length > 8 * 1024 * 1024) return;
  if (!isPdf && !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mime)) return;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5', max_tokens: 300,
      messages: [{ role: 'user', content: [
        { type: isPdf ? 'document' : 'image', source: { type: 'base64', media_type: isPdf ? 'application/pdf' : mime, data: buffer.toString('base64') } },
        { type: 'text', text: 'Este arquivo é um COMPROVANTE de pagamento (PIX ou transferência)? Responda SOMENTE um JSON, sem markdown: {"comprovante": true|false, "efetuado": true|false, "valor": "67.36" ou null, "favorecido": "nome de quem recebeu" ou null}. "efetuado" é false se o pagamento está agendado, pendente, com erro ou se for só a tela com o QR code/código copia e cola. "comprovante" é false para qualquer outro tipo de documento ou foto. Valor com ponto decimal, sem R$.' },
      ] }],
    }),
  });
  if (!res.ok) return;
  const data = await res.json() as { content: { type: string; text?: string }[] };
  const raw = data.content?.find((b) => b.type === 'text')?.text || '';
  let j: { comprovante?: boolean; efetuado?: boolean; valor?: string | null; favorecido?: string | null } = {};
  try { j = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{}'); } catch { return; }
  if (!j.comprovante) return;
  const cents = j.valor ? Math.round(parseFloat(String(j.valor).replace(',', '.')) * 100) : NaN;
  const fav = String(j.favorecido || '');
  const favOk = !fav || /\bONR\b|OPERADOR NACIONAL|REGISTRO|RI ?DIGITAL/i.test(fav);
  const alvo = pend.find((r) => r.valorCents && Number.isFinite(cents) && Math.abs(r.valorCents - cents) <= 1);
  if (j.efetuado && alvo && favOk) { await markCertidaoPaid(db, { accountId: p.accountId, id: alvo.id, via: 'PROOF', io: p.io }); return; }
  const r0 = pend[0];
  const motivo = !j.efetuado ? 'o pagamento não aparece como efetuado' : !alvo ? `o valor (${Number.isFinite(cents) ? brl(cents) : 'ilegível'}) não bate com o do PIX (${brl(r0.valorCents)})` : `o favorecido ("${fav}") não parece ser a ONR`;
  await db.certidaoRequest.update({ where: { id: r0.id }, data: { paidClaimedAt: new Date(), forceCheck: true, nextCheckAt: new Date() } }).catch(() => {});
  await note(db, p.leadId, `⚠️ O cliente mandou um comprovante, mas NÃO confirmei o pagamento da certidão (matrícula ${r0.matricula}): ${motivo}. Vou conferir no RI Digital; se estiver certo, confirme à mão (POST /api/certidoes/${r0.id}/paid).`);
}

/** O cliente DISSE que pagou ("paguei", "fiz o pix", "já tá pago") — Fabio 30/10: só aí a extensão consulta o RI Digital (o e-mail do cartório também confirma). */
export const DISSE_QUE_PAGOU_RX = /\b(j[aá]\s+)?(paguei|pago|efetuei|transferi|fiz\s+o\s+(pix|pagamento))\b|\bpix\s+(feito|pago|enviado)\b|\bpagamento\s+(feito|efetuado|realizado)\b|\bdeu\s+certo\b/i;
export async function checkPaidClaim(db: Db, p: { accountId: string; leadId: string; text: string; io?: Io }): Promise<void> {
  const t = String(p.text || '').trim();
  if (!t || t.length > 300 || !DISSE_QUE_PAGOU_RX.test(t) || /n[aã]o\s+(deu|consegui|paguei|foi)|ainda\s+n[aã]o|vou\s+pagar/i.test(t)) return;
  const r = await db.certidaoRequest.findFirst({ where: { accountId: p.accountId, leadId: p.leadId, status: 'AWAITING_PAYMENT', paidAt: null, pixSentAt: { not: null } }, orderBy: { createdAt: 'desc' } });
  if (!r || (r.paidClaimedAt && Date.now() - r.paidClaimedAt.getTime() < 2 * 3600_000)) return;
  await db.certidaoRequest.update({ where: { id: r.id }, data: { paidClaimedAt: new Date(), forceCheck: true, nextCheckAt: new Date(), detail: 'O cliente disse que pagou: a extensão vai conferir no RI Digital.' } });
  await note(db, r.leadId, `💸 O cliente disse que pagou o PIX da certidão (“${t.slice(0, 120)}”). A extensão vai conferir no RI Digital agora (e o e-mail do cartório também confirma).`, r.requestedById);
  emitUpdate(p.io, p.accountId, r.leadId, r.id);
}

export async function cancelCertidao(db: Db, p: { accountId: string; id: string; userId?: string }) {
  const r = await db.certidaoRequest.findFirst({ where: { id: p.id, accountId: p.accountId } });
  if (!r) throw new Error('Pedido de certidão não encontrado');
  if (!['REQUESTED', 'RUNNING'].includes(r.status) || r.protocolo) throw new Error('Só dá pra cancelar pedido que ainda não foi feito no portal');
  return db.certidaoRequest.update({ where: { id: r.id }, data: { status: 'CANCELLED', finishedAt: new Date(), detail: 'Cancelado pela equipe.' } });
}

/**
 * E-mail do RI Digital (contatori@ridigital.org.br) "Resposta ao seu pedido de certidão digital" = o cartório respondeu, logo o pedido foi pago (Fabio 16/10: "pode ser quando um e-mail desse cartório chegar").
 * Acha o pedido pelo protocolo no assunto/corpo, confirma o pagamento (se ainda não estava) e libera a conferência na hora (a extensão baixa o PDF no próximo minuto, dentro de 07h–21h).
 */
export async function certidaoEmailArrived(db: Db, p: { accountId: string; subject?: string | null; text?: string | null }): Promise<number> {
  if (!/resposta ao seu pedido/i.test(p.subject || '')) return 0;
  const protos = [...new Set(`${p.subject || ''} ${p.text || ''}`.match(PROTO_IN_TEXT()) || [])];
  if (!protos.length) return 0;
  const rows = await db.certidaoRequest.findMany({ where: { accountId: p.accountId, status: 'AWAITING_PAYMENT', protocolo: { in: protos } }, select: { id: true, paidAt: true } });
  for (const r of rows) {
    if (!r.paidAt) await markCertidaoPaid(db, { accountId: p.accountId, id: r.id, via: 'EMAIL' });
    else await db.certidaoRequest.update({ where: { id: r.id }, data: { nextCheckAt: new Date(), detail: 'O cartório respondeu (e-mail do RI Digital); a extensão vai baixar a certidão.' } });
  }
  return rows.length;
}
