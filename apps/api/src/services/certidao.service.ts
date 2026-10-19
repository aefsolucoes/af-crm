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
const RUNNING_TTL_MIN = 25; // pegou e sumiu (aba fechou) — o PIX demora até ~2 min, o pedido todo cabe folgado
const PIX_MAX_ATTEMPTS = 4; // tentativas de pegar o PIX de um pedido já feito
const CHECK_EVERY_MIN = 300; // conferência da emissão de 5 em 5 h (Fabio 16/10); o e-mail "Resposta ao seu pedido" do RI Digital adianta (certidaoEmailArrived)
const PAID_CHECK_EVERY_MIN = 300; // depois do pagamento confirmado, confere a emissão de 5 em 5 h (Fabio 19/10); o e-mail do cartório adianta
const ACTIVE = ['REQUESTED', 'RUNNING', 'AWAITING_PAYMENT'];

export const onlyDigits = (v: unknown) => String(v ?? '').replace(/\D/g, '');
const brl = (cents: number | null | undefined) => `R$ ${((cents || 0) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const BRT_MS = 3 * 3600_000;
const brDate = (d: Date) => { const b = new Date(d.getTime() - BRT_MS); return `${String(b.getUTCDate()).padStart(2, '0')}/${String(b.getUTCMonth() + 1).padStart(2, '0')}`; };
const sameBrDay = (a: Date, b: Date) => brDate(a) === brDate(b) && Math.abs(a.getTime() - b.getTime()) < 36 * 3600_000;

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

const note = (db: Db, leadId: string, content: string, userId?: string | null) =>
  db.note.create({ data: { leadId, type: 'COMMENT', content, userId: userId || undefined } }).catch(() => {});
const emitUpdate = (io: Io | undefined, accountId: string, leadId: string, id: string) => io?.to(`account_${accountId}`).emit('certidao_updated', { id, leadId });

// ── Pedido ───────────────────────────────────────────────────────────────────────────────────
export async function createCertidaoRequest(db: Db, p: { accountId: string; leadId: string; uf: string; cidade: string; cartorio: string; matricula: string; userId?: string; source?: 'USER' | 'AI'; sendPix?: boolean; clientIntro?: string }) {
  const uf = String(p.uf || '').trim().toUpperCase();
  const matricula = onlyDigits(p.matricula);
  if (!/^[A-Z]{2}$/.test(uf)) throw new Error('UF inválida (use a sigla, ex.: PA)');
  if (matricula.length < 1 || matricula.length > 12) throw new Error('Número de matrícula inválido');
  if (!String(p.cidade || '').trim() || !String(p.cartorio || '').trim()) throw new Error('Informe a cidade e o cartório (ex.: Belém / 02º - BELÉM)');
  const lead = await db.lead.findFirst({ where: { id: p.leadId, accountId: p.accountId }, select: { id: true } });
  if (!lead) throw new Error('Lead não encontrado');
  // Cada pedido é uma cobrança nova no portal: nunca cria outro enquanto houver um andando pra mesma matrícula do mesmo cliente.
  const ativo = await db.certidaoRequest.findFirst({ where: { accountId: p.accountId, leadId: p.leadId, matricula, status: { in: ACTIVE } }, orderBy: { createdAt: 'desc' } });
  if (ativo) return { request: ativo, duplicate: true };
  const request = await db.certidaoRequest.create({
    data: { accountId: p.accountId, leadId: p.leadId, uf, cidade: p.cidade.trim(), cartorio: p.cartorio.trim(), matricula, source: p.source || 'USER', requestedById: p.userId, sendPix: p.sendPix !== false, clientIntro: p.clientIntro?.trim() || null },
  });
  await note(db, p.leadId, `🏛️ Certidão de matrícula nº ${matricula} (${p.cartorio.trim()}/${uf}) pedida pelo CRM — a extensão "Certidão ONR" faz o pedido no RI Digital e o PIX ${request.sendPix ? 'vai direto ao cliente' : 'fica guardado aqui'}.`, p.userId);
  return { request, duplicate: false };
}

export async function listCertidoes(db: Db, p: { accountId: string; leadId?: string; limit?: number }) {
  return db.certidaoRequest.findMany({
    where: { accountId: p.accountId, ...(p.leadId ? { leadId: p.leadId } : {}) },
    orderBy: { createdAt: 'desc' }, take: Math.min(p.limit || 30, 100),
    select: { id: true, leadId: true, uf: true, cidade: true, cartorio: true, matricula: true, status: true, source: true, sendPix: true, protocolo: true, numeroRegistral: true, valorCents: true, pixExpiresAt: true, pixSentAt: true, paidAt: true, paidVia: true, detail: true, pdfName: true, driveUrl: true, attempts: true, createdAt: true, startedAt: true, finishedAt: true },
  });
}

/** Pedidos que ficaram sem dono: o que já tem protocolo vira "aguardando pagamento" (a fase PIX acha o código); o que não tem NÃO é refeito sozinho (pode já existir no portal e cobrar de novo). */
async function expireStuck(db: Db, accountId: string) {
  const agora = Date.now();
  const rodando = await db.certidaoRequest.findMany({ where: { accountId, status: 'RUNNING', startedAt: { lt: new Date(agora - RUNNING_TTL_MIN * 60_000) } }, select: { id: true, leadId: true, protocolo: true, matricula: true } });
  for (const r of rodando) {
    if (r.protocolo) await db.certidaoRequest.updateMany({ where: { id: r.id, status: 'RUNNING' }, data: { status: 'AWAITING_PAYMENT', nextCheckAt: null, detail: 'A extensão parou antes de pegar o PIX; vai tentar de novo pelo protocolo.' } });
    else {
      const u = await db.certidaoRequest.updateMany({ where: { id: r.id, status: 'RUNNING' }, data: { status: 'FAILED', finishedAt: new Date(), detail: 'A extensão parou no meio do pedido, antes do protocolo. Confira em "Visualizar Pedidos" do RI Digital se o pedido chegou a ser criado antes de pedir de novo (cada pedido é uma cobrança).' } });
      if (u.count) await note(db, r.leadId, `⚠️ A certidão da matrícula ${r.matricula} NÃO foi concluída: a extensão parou no meio do pedido. Confira no RI Digital se o pedido existe antes de pedir de novo.`);
    }
  }
  const velhos = await db.certidaoRequest.findMany({ where: { accountId, status: 'REQUESTED', createdAt: { lt: new Date(agora - REQUESTED_WARN_H * 3600_000) }, OR: [{ detail: null }, { detail: { not: { contains: WARN_MARK } } }] }, select: { id: true, leadId: true, matricula: true } });
  for (const r of velhos) {
    const u = await db.certidaoRequest.updateMany({ where: { id: r.id, status: 'REQUESTED' }, data: { detail: `Pedido ${WARN_MARK} há mais de ${REQUESTED_WARN_H} h: abra o Chrome com a extensão "Certidão ONR" (logada no CRM) que ela pega sozinha. Continua na fila, sem limite.` } });
    if (u.count) {
      await note(db, r.leadId, `⚠️ O pedido da certidão da matrícula ${r.matricula} está parado há mais de ${REQUESTED_WARN_H} h: a extensão "Certidão ONR" não pegou (Chrome fechado ou sem login no CRM). Continua na fila — assim que ela abrir, faz o pedido.`);
      pushAll(accountId, '⚠️ Pedido de certidão parado', `${await leadNameOf(db, r.leadId)} — matrícula ${r.matricula}: abra o Chrome com a extensão Certidão ONR`, r.leadId);
    }
  }
}

export type CertidaoJob = { id: string; phase: 'ORDER' | 'PIX' | 'COLLECT'; leadId: string; leadName: string; uf: string; cidade: string; cartorio: string; matricula: string; protocolo: string | null; numeroRegistral: string | null };

/** A extensão pergunta "tem serviço?" (a cada minuto). Devolve UM trabalho por vez — ela usa o navegador inteiro pra isso. */
export async function claimCertidao(db: Db, p: { accountId: string }): Promise<CertidaoJob | null> {
  await expireStuck(db, p.accountId);
  await retryCertidaoDrive(db, p.accountId).catch((e) => console.warn('[Certidão] reenvio ao Drive falhou:', e?.message));
  const now = new Date();
  const toJob = async (r: { id: string; leadId: string; uf: string; cidade: string; cartorio: string; matricula: string; protocolo: string | null; numeroRegistral: string | null }, phase: CertidaoJob['phase']): Promise<CertidaoJob> => {
    const lead = await db.lead.findUnique({ where: { id: r.leadId }, select: { name: true } });
    return { id: r.id, phase, leadId: r.leadId, leadName: lead?.name || 'Sem nome', uf: r.uf, cidade: r.cidade, cartorio: r.cartorio, matricula: r.matricula, protocolo: r.protocolo, numeroRegistral: r.numeroRegistral };
  };
  // 1) pedido novo
  const novos = await db.certidaoRequest.findMany({ where: { accountId: p.accountId, status: 'REQUESTED' }, orderBy: { createdAt: 'asc' }, take: 3 });
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
  // 3) SÓ com o pagamento CONFIRMADO (comprovante do cliente ou e-mail do cartório): confere se a certidão saiu (07h–21h). Sem pagamento não há o que procurar (Fabio 19/10).
  if (foraDoHorario()) return null;
  const aguardando = await db.certidaoRequest.findMany({ where: { accountId: p.accountId, status: 'AWAITING_PAYMENT', pixCode: { not: null }, paidAt: { not: null }, OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: now } }] }, orderBy: { createdAt: 'asc' }, take: 3 });
  for (const r of aguardando) {
    const c = await db.certidaoRequest.updateMany({ where: { id: r.id, status: 'AWAITING_PAYMENT', pixCode: { not: null } }, data: { nextCheckAt: new Date(now.getTime() + PAID_CHECK_EVERY_MIN * 60_000) } });
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
  | { event: 'ordered'; protocolo: string; numeroRegistral?: string; valorCents?: number }
  | { event: 'pix'; code: string; expiresAt?: string; valorCents?: number }
  | { event: 'status'; portalStatus?: string; detail?: string }
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
  } else if (d.event === 'ordered') {
    const protocolo = String(d.protocolo || '').trim();
    if (!/^P\d{8,14}D$/i.test(protocolo)) throw new Error('protocolo inválido');
    out = await db.certidaoRequest.update({ where: { id: r.id }, data: { status: 'AWAITING_PAYMENT', protocolo, numeroRegistral: d.numeroRegistral ? String(d.numeroRegistral).slice(0, 40) : r.numeroRegistral, valorCents: Number.isInteger(d.valorCents) ? d.valorCents : r.valorCents, detail: 'Pedido feito no RI Digital; pegando o código PIX.', nextCheckAt: null } });
    await note(db, r.leadId, `🏛️ Certidão da matrícula ${r.matricula} pedida no RI Digital — protocolo ${protocolo}${out.valorCents ? `, ${brl(out.valorCents)}` : ''}. Falta o pagamento do PIX.`, r.requestedById);
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
    }
  } else if (d.event === 'status') {
    out = await db.certidaoRequest.update({ where: { id: r.id }, data: { detail: String(d.detail || (d.portalStatus ? `No portal: ${d.portalStatus}` : r.detail || '')).slice(0, 400) } });
  } else if (d.event === 'issued_manual') {
    // A certidão saiu, mas a extensão não conseguiu mandar o PDF ao CRM (ficou na pasta Downloads do Chrome do Fabio): fecha o pedido e avisa a equipe.
    out = await db.certidaoRequest.update({ where: { id: r.id }, data: { status: 'ISSUED', finishedAt: new Date(), nextCheckAt: null, detail: String(d.reason || 'Certidão emitida; PDF fora do CRM.').slice(0, 400) } });
    await note(db, r.leadId, `📄 Certidão da matrícula ${r.matricula} EMITIDA (protocolo ${out.protocolo || '—'}), mas o PDF NÃO ficou no CRM: ${String(d.reason || '').slice(0, 200)}. Baixe em "Visualizar Pedidos" do RI Digital.`, r.requestedById);
  } else if (d.event === 'failed') {
    const reason = String(d.reason || 'a extensão não conseguiu').slice(0, 500);
    if (r.protocolo) {
      // pedido existe no portal: não é falha do pedido, só desta tentativa (a fase PIX/COLLECT tenta de novo)
      out = await db.certidaoRequest.update({ where: { id: r.id }, data: { detail: `Última tentativa: ${reason}` } });
      if (!r.pixCode && r.attempts >= PIX_MAX_ATTEMPTS) await note(db, r.leadId, `⚠️ Não consegui pegar o PIX do pedido ${r.protocolo} (${PIX_MAX_ATTEMPTS} tentativas): ${reason}. Abra "Visualizar Pedidos" no RI Digital e clique no ícone do PIX.`, r.requestedById);
    } else {
      out = await db.certidaoRequest.update({ where: { id: r.id }, data: { status: 'FAILED', finishedAt: new Date(), detail: reason } });
      await note(db, r.leadId, `⚠️ A certidão da matrícula ${r.matricula} NÃO foi pedida: ${reason}`, r.requestedById);
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
export async function saveCertidaoToDrive(db: Db, r: { accountId: string; leadId: string; matricula: string }, pdf: Buffer): Promise<{ ok: true; fileId: string; fileUrl: string; folderUrl: string; fileName: string } | { ok: false; reason: string }> {
  try {
    const { createFolder, uploadFile, extractFolderId, findFolderByNameUnderRoot, folderLink } = await import('./google.service');
    const lead = await db.lead.findUnique({ where: { id: r.leadId }, select: { name: true, customFields: true } });
    if (!lead) return { ok: false, reason: 'card não encontrado' };
    const link = String(((lead.customFields || {}) as Record<string, unknown>).link_pasta_drive || '').trim();
    let clientFolderId = link ? extractFolderId(link) : '';
    if (!clientFolderId) clientFolderId = (await findFolderByNameUnderRoot(r.accountId, lead.name))?.folderId || '';
    if (!clientFolderId) return { ok: false, reason: 'não achei a pasta do cliente no Drive' };
    const imovel = await createFolder(r.accountId, 'IMOVEL', clientFolderId);
    const fileName = `CERTIDAO DE ONUS - MATRICULA ${r.matricula} (inteiro teor).pdf`.replace(/[\\/:*?"<>|]/g, ' ');
    const up = await uploadFile(r.accountId, { name: fileName, mimeType: 'application/pdf', data: pdf, parentId: imovel.id });
    return { ok: true, fileId: up.id, fileUrl: up.webViewLink || folderLink(imovel.id), folderUrl: folderLink(imovel.id), fileName };
  } catch (err: any) {
    return { ok: false, reason: String(err?.message || err).slice(0, 160) };
  }
}

/** A extensão achou a certidão pronta e devolve o PDF: vai pro Drive (e só pra lá); a equipe é avisada por push. */
export async function finishCertidao(db: Db, p: { accountId: string; id: string; pdf: Buffer; pdfName?: string; io?: Io }) {
  const r = await db.certidaoRequest.findFirst({ where: { id: p.id, accountId: p.accountId } });
  if (!r) throw new Error('Pedido de certidão não encontrado');
  if (r.status === 'ISSUED') return r;
  const nome = await leadNameOf(db, r.leadId);
  const drive = await saveCertidaoToDrive(db, r, p.pdf);
  let out;
  if (drive.ok) {
    out = await db.certidaoRequest.update({ where: { id: r.id }, data: { status: 'ISSUED', pdf: null, pdfName: drive.fileName, driveFileId: drive.fileId, driveUrl: drive.fileUrl, finishedAt: new Date(), detail: 'Certidão emitida e salva no Drive (pasta IMOVEL).', nextCheckAt: null } });
    await note(db, r.leadId, `📄 Certidão da matrícula ${r.matricula} EMITIDA (protocolo ${out.protocolo || '—'}) e salva no Drive, subpasta IMOVEL:\n${drive.fileUrl}`, r.requestedById);
    pushAll(p.accountId, '📄 Certidão emitida e salva no Drive', `${nome} — matrícula ${r.matricula} (pasta IMOVEL)`, r.leadId);
  } else {
    const name = (p.pdfName || `Certidao matricula ${r.matricula}.pdf`).replace(/[\\/:*?"<>|]/g, ' ').slice(0, 120);
    out = await db.certidaoRequest.update({ where: { id: r.id }, data: { status: 'ISSUED', pdf: p.pdf, pdfName: name, finishedAt: new Date(), detail: `Certidão emitida, mas NÃO subiu pro Drive (${drive.reason}); o CRM tenta de novo a cada 10 min.`, nextCheckAt: new Date(Date.now() + 10 * 60_000) } });
    await note(db, r.leadId, `⚠️ Certidão da matrícula ${r.matricula} EMITIDA, mas NÃO consegui salvar no Drive (${drive.reason}). O CRM guarda o PDF só de passagem e tenta de novo a cada 10 minutos.`, r.requestedById);
    pushAll(p.accountId, '⚠️ Certidão emitida, mas NÃO foi pro Drive', `${nome} — matrícula ${r.matricula}: ${drive.reason}. Vou tentar de novo.`, r.leadId);
  }
  emitUpdate(p.io, p.accountId, r.leadId, r.id);
  return out;
}

/** PDFs que não subiram pro Drive (Drive fora do ar, pasta não achada): tenta de novo (chamada a cada minuto pela fila da extensão); ao subir, zera os bytes do banco. */
export async function retryCertidaoDrive(db: Db, accountId: string): Promise<void> {
  const rows = await db.certidaoRequest.findMany({ where: { accountId, status: 'ISSUED', pdf: { not: null }, driveUrl: null, OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: new Date() } }] }, take: 3 });
  for (const r of rows) {
    const drive = await saveCertidaoToDrive(db, r, Buffer.from(r.pdf!));
    if (!drive.ok) { await db.certidaoRequest.update({ where: { id: r.id }, data: { nextCheckAt: new Date(Date.now() + 10 * 60_000) } }); continue; }
    await db.certidaoRequest.update({ where: { id: r.id }, data: { pdf: null, pdfName: drive.fileName, driveFileId: drive.fileId, driveUrl: drive.fileUrl, nextCheckAt: null, detail: 'Certidão salva no Drive (pasta IMOVEL).' } });
    await note(db, r.leadId, `📁 Agora sim: a certidão da matrícula ${r.matricula} foi salva no Drive, subpasta IMOVEL:\n${drive.fileUrl}`, r.requestedById);
    pushAll(accountId, '📄 Certidão salva no Drive', `${await leadNameOf(db, r.leadId)} — matrícula ${r.matricula} (pasta IMOVEL)`, r.leadId);
  }
}

/** Pagamento da certidão CONFIRMADO (comprovante do cliente, e-mail do cartório ou a equipe): só a partir daqui a extensão vai buscar a certidão — sem pagamento não há o que procurar. */
export async function markCertidaoPaid(db: Db, p: { accountId: string; id: string; via: 'PROOF' | 'EMAIL' | 'MANUAL'; io?: Io }) {
  const r = await db.certidaoRequest.findFirst({ where: { id: p.id, accountId: p.accountId } });
  if (!r || r.status !== 'AWAITING_PAYMENT') return null;
  if (r.paidAt) return r;
  const how = p.via === 'PROOF' ? 'pelo comprovante que o cliente mandou' : p.via === 'EMAIL' ? 'pelo e-mail do cartório (RI Digital)' : 'pela equipe';
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
  await note(db, p.leadId, `⚠️ O cliente mandou um comprovante, mas NÃO confirmei o pagamento da certidão (matrícula ${r0.matricula}): ${motivo}. Se estiver certo, confirme à mão (POST /api/certidoes/${r0.id}/paid).`);
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
  const protos = [...new Set(`${p.subject || ''} ${p.text || ''}`.match(/\bP\d{8,14}D\b/g) || [])];
  if (!protos.length) return 0;
  const rows = await db.certidaoRequest.findMany({ where: { accountId: p.accountId, status: 'AWAITING_PAYMENT', protocolo: { in: protos } }, select: { id: true, paidAt: true } });
  for (const r of rows) {
    if (!r.paidAt) await markCertidaoPaid(db, { accountId: p.accountId, id: r.id, via: 'EMAIL' });
    else await db.certidaoRequest.update({ where: { id: r.id }, data: { nextCheckAt: new Date(), detail: 'O cartório respondeu (e-mail do RI Digital); a extensão vai baixar a certidão.' } });
  }
  return rows.length;
}
