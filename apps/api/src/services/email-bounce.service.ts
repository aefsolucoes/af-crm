import { Resolver } from 'dns/promises';
import { prisma } from '../lib/prisma';

/**
 * E-MAIL INEXISTENTE NÃO RECEBE MAIS NADA (Fabio 09/11). O Titan suspendeu o comercial@ por excesso de devolução: 184 devoluções de só 79 endereços, um deles 12 vezes.
 * A devolução ("Undelivered Mail Returned to Sender") já entra na caixa pelo sync: daqui sai quem voltou e por quê, e todo envio consulta antes de sair.
 * INEXISTENTE: não sai mais nada, manual ou automático. CAIXA_CHEIA: pausa só os automáticos por 30 dias. Recusa por autenticação ou spam é problema do remetente, não do endereço: não barra.
 */
export type TipoDevolucao = 'INEXISTENTE' | 'CAIXA_CHEIA';

const PAUSA_CAIXA_CHEIA_MS = 30 * 86_400_000;
const DNS_TTL_MS = 3_600_000;

/** Por que o servidor recusou → o que fazer com o endereço. null = não barra. Pura. */
export function classificarDevolucao(motivo: string): TipoDevolucao | null {
  const t = motivo.replace(/\s+/g, ' ');
  if (/lacks SPF|SPF\/DKIM|DMARC|authenticat|\b5\.7\.\d|spam|blacklist|reputation/i.test(t)) return null;
  if (/out of storage|over quota|quota exceeded|mailbox.{0,30}full|insufficient.{0,20}storage|\b5\.2\.2\b/i.test(t)) return 'CAIXA_CHEIA';
  if (/\b5\.1\.(1|10|2|3)\b|\b5\.2\.1\b|user unknown|no such (user|recipient|mailbox)|does not exist|doesn.t exist|mailbox not found|mailbox unavailable|Host or domain name not found|Name service error|does not accept mail|loops back to myself|bad address|\b555[- ]5\.5\.2\b|recipient.{0,30}not found|(unknown|invalid) recipient|(account|mailbox|user|address).{0,50}(inactive|disabled)/i.test(t)) return 'INEXISTENTE';
  return null;
}

// Formato do relatório do servidor de envio: "<endereço>: motivo", com o motivo podendo quebrar em várias linhas. Conferido nas 184 devoluções reais (09/11).
const LINHA_DEVOLUCAO = /^<([^<>\s]+@[^<>\s]+)>(?:\s*\(expanded from <[^>]+>\))?:\s*([\s\S]*?)(?=\r?\n\s*\r?\n|\r?\n<[^<>\s]+@|$(?![\s\S]))/gm;

/** Endereços que voltaram num e-mail de devolução e o que fazer com cada um. Pura. */
export function lerDevolucao(texto: string): { address: string; kind: TipoDevolucao; detail: string }[] {
  const out = new Map<string, { address: string; kind: TipoDevolucao; detail: string }>();
  for (const m of texto.matchAll(LINHA_DEVOLUCAO)) {
    const kind = classificarDevolucao(m[2]);
    if (!kind) continue;
    const address = m[1].toLowerCase();
    out.set(address, { address, kind, detail: m[2].replace(/\s+/g, ' ').trim().slice(0, 300) });
  }
  return [...out.values()];
}

export async function registrarDevolucao(accountId: string, texto: string, quando: Date): Promise<void> {
  for (const d of lerDevolucao(texto)) {
    await prisma.emailBounce.upsert({
      where: { accountId_address: { accountId, address: d.address } },
      create: { accountId, address: d.address, kind: d.kind, detail: d.detail, lastAt: quando },
      update: { kind: d.kind, detail: d.detail, lastAt: quando },
    });
  }
}

/** Na subida do servidor, lê as devoluções que já estão nas caixas. Pode repetir: grava o mesmo resultado. */
export async function importarDevolucoes(): Promise<void> {
  const caixas = await prisma.emailAccount.findMany({ select: { id: true, accountId: true } });
  let lidas = 0;
  for (const c of caixas) {
    const rows = await prisma.emailMessage.findMany({
      where: { emailAccountId: c.id, folder: 'INBOX', fromAddress: { startsWith: 'mailer-daemon', mode: 'insensitive' } },
      orderBy: { date: 'asc' },
      select: { date: true, textBody: true },
    });
    for (const r of rows) {
      await registrarDevolucao(c.accountId, r.textBody || '', r.date);
      lidas++;
    }
  }
  if (lidas) console.log(`[Devolução e-mail] ${lidas} devoluções lidas na subida.`);
}

/** MX = recebe; SO_A = não tem MX, só o registro A (o servidor de envio ainda tenta, mas é quase sempre erro de digitação: hotmqil.com); NAO = não recebe. */
type RecebeEmail = 'MX' | 'SO_A' | 'NAO';
const cacheDominio = new Map<string, { at: number; recebe: RecebeEmail }>();

/** O domínio recebe e-mail? Pega erro de digitação (gmail.como, hotmail.c) antes de virar devolução. DNS fora do ar não barra ninguém. */
async function dominioRecebeEmail(dominio: string): Promise<RecebeEmail> {
  const c = cacheDominio.get(dominio);
  if (c && Date.now() - c.at < DNS_TTL_MS) return c.recebe;
  const dns = new Resolver({ timeout: 3000, tries: 1 });
  let recebe: RecebeEmail = 'MX';
  try {
    // MX nulo (RFC 7505) vem com exchange vazio: o domínio declara que não recebe e-mail (gmail.co, gmail.com.br).
    const mx = await dns.resolveMx(dominio);
    recebe = mx.some((m) => m.exchange && m.exchange !== '.') ? 'MX' : 'NAO';
  } catch (e: any) {
    if (e?.code === 'ENOTFOUND') recebe = 'NAO';
    else if (e?.code === 'ENODATA') {
      // Sem MX, o servidor de envio tenta o próprio domínio (registro A).
      recebe = await dns.resolve4(dominio).then((a) => (a.length > 0 ? 'SO_A' : 'NAO'), (e2: any) => (['ENOTFOUND', 'ENODATA'].includes(e2?.code) ? 'NAO' : 'MX'));
    }
  }
  cacheDominio.set(dominio, { at: Date.now(), recebe });
  return recebe;
}

// ─── Travas do envio automático (Fabio 13/11) ────────────────────────────────
// A comercial@ foi suspensa de novo pelo mesmo motivo: o Titan aceita, por conta, só 5 devoluções por hora, 10 por dia e 20 em 3 dias
// (artigo da HostGator). Nas 72 h antes da suspensão de 09/11 foram 43: 26 da Microsoft recusando por falta de DMARC, 9 de endereço inexistente
// e 8 de caixa cheia, quase tudo de e-mail automático (boas-vindas do site, follow-ups, "pré-análise aprovada" a cada 3 dias).

/** Endereço com acento ou espaço: o Gmail recusa com 555 5.5.2 (ex.: "maurício…@gmail.com"). Pura. */
export function enderecoComCaractereInvalido(endereco: string): boolean {
  return /[^\x21-\x7e]/.test(endereco.trim());
}

/** Hotmail/Outlook/Live/MSN: a Microsoft recusa e-mail de domínio sem DMARC ("lacks SPF/DKIM/DMARC") e a recusa conta como devolução. Pura. */
export function dominioMicrosoft(dominio: string): boolean {
  return /^(hotmail|outlook|live|msn|windowslive)\.[a-z.]{2,7}$/i.test(dominio.trim());
}

const cacheDmarc = new Map<string, { at: number; tem: boolean }>();
/** O domínio de quem envia tem registro DMARC? Erro de DNS que não seja "não existe" não barra ninguém. */
async function temDmarc(dominio: string): Promise<boolean> {
  const c = cacheDmarc.get(dominio);
  if (c && Date.now() - c.at < DNS_TTL_MS) return c.tem;
  const dns = new Resolver({ timeout: 3000, tries: 1 });
  const tem = await dns.resolveTxt(`_dmarc.${dominio}`).then(
    (rs) => rs.some((partes) => /^v=DMARC1/i.test(partes.join('').trim())),
    (e: any) => !['ENOTFOUND', 'ENODATA'].includes(e?.code),
  );
  cacheDmarc.set(dominio, { at: Date.now(), tem });
  return tem;
}

/** Freio: devoluções que a caixa da empresa recebeu na janela → para os automáticos ANTES do limite do Titan (o resto da margem é pras devoluções
 *  de e-mails que já saíram e ainda não voltaram). O e-mail manual da equipe não para. */
export const FREIO_DEVOLUCOES = [
  { ms: 3_600_000, max: 3, rotulo: 'na última hora', limiteTitan: 5 },
  { ms: 86_400_000, max: 7, rotulo: 'nas últimas 24 h', limiteTitan: 10 },
  { ms: 3 * 86_400_000, max: 15, rotulo: 'nos últimos 3 dias', limiteTitan: 20 },
] as const;
/** Teto de e-mails automáticos por hora: a devolução chega ~1 min depois do envio (sync de 1 em 1 min), então um lote grande passaria do limite antes do freio ver. */
export const MAX_AUTOMATICOS_POR_HORA = 20;

/** Qual janela do freio estourou, dadas as datas das devoluções; null = pode enviar. Pura. */
export function freioEstourado(datasDevolucao: Date[], agora = Date.now()): (typeof FREIO_DEVOLUCOES)[number] & { n: number } | null {
  for (const f of FREIO_DEVOLUCOES) {
    const n = datasDevolucao.filter((d) => agora - d.getTime() < f.ms).length;
    if (n >= f.max) return { ...f, n };
  }
  return null;
}

const enviosAutomaticos = new Map<string, number[]>(); // por conta do CRM: horário de cada e-mail automático liberado (memória; zera no deploy)
const cacheFreio = new Map<string, { at: number; motivo: string | null }>();
const avisoFreio = new Map<string, number>();

async function motivoFreio(accountId: string): Promise<string | null> {
  const c = cacheFreio.get(accountId);
  if (c && Date.now() - c.at < 30_000) return c.motivo;
  const desde = new Date(Date.now() - FREIO_DEVOLUCOES[FREIO_DEVOLUCOES.length - 1].ms);
  const rows = await prisma.emailMessage.findMany({
    where: { folder: 'INBOX', fromAddress: { startsWith: 'mailer-daemon', mode: 'insensitive' }, date: { gte: desde }, emailAccount: { accountId, userId: null } },
    select: { date: true },
  });
  const f = freioEstourado(rows.map((r) => r.date));
  const motivo = f ? `envio automático pausado: ${f.n} e-mails devolvidos ${f.rotulo} (o Titan suspende a caixa com ${f.limiteTitan})` : null;
  cacheFreio.set(accountId, { at: Date.now(), motivo });
  if (motivo && Date.now() - (avisoFreio.get(accountId) || 0) > 6 * 3_600_000) {
    avisoFreio.set(accountId, Date.now());
    console.warn(`[E-mail] Freio de devoluções: ${motivo}`);
    avisarAdmins(accountId, '✋ E-mail automático pausado', `${f!.n} e-mails voltaram ${f!.rotulo}. O CRM parou os automáticos pra comercial@ não ser suspensa de novo; volta sozinho quando as devoluções baixarem.`);
  }
  return motivo;
}

function avisarAdmins(accountId: string, title: string, body: string): void {
  prisma.user.findMany({ where: { accountId, role: 'ADMIN' }, select: { id: true } })
    .then((us) => (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title, body }, us.map((u) => u.id)))
    .catch(() => {});
}

/** Cabe mais um automático nesta hora? Reserva a vaga. */
function reservarEnvioAutomatico(accountId: string): boolean {
  const agora = Date.now();
  const lista = (enviosAutomaticos.get(accountId) || []).filter((t) => agora - t < 3_600_000);
  if (lista.length >= MAX_AUTOMATICOS_POR_HORA) {
    enviosAutomaticos.set(accountId, lista);
    return false;
  }
  lista.push(agora);
  enviosAutomaticos.set(accountId, lista);
  return true;
}

/** Devoluções por caixa cheia desse endereço desde a última vez que ele escreveu pra gente. */
async function devolucoesCaixaCheia(accountId: string, address: string): Promise<number> {
  const ultimaDele = await prisma.emailMessage.findFirst({
    where: { folder: 'INBOX', fromAddress: { equals: address, mode: 'insensitive' }, emailAccount: { accountId } },
    orderBy: { date: 'desc' }, select: { date: true },
  });
  const rows = await prisma.emailMessage.findMany({
    where: {
      folder: 'INBOX', fromAddress: { startsWith: 'mailer-daemon', mode: 'insensitive' }, emailAccount: { accountId },
      textBody: { contains: `<${address}>`, mode: 'insensitive' }, ...(ultimaDele ? { date: { gt: ultimaDele.date } } : {}),
    },
    select: { textBody: true },
  });
  return rows.filter((r) => lerDevolucao(r.textBody || '').some((d) => d.address === address && d.kind === 'CAIXA_CHEIA')).length;
}

/** Motivo pra NÃO enviar a este endereço; null = pode enviar. `automatico`: e-mail que o CRM manda sozinho (passa pelas travas de 13/11 e conta no teto por hora). */
export async function motivoBloqueioEmail(accountId: string, endereco: string, opts?: { automatico?: boolean }): Promise<string | null> {
  const address = endereco.trim().toLowerCase();
  const dominio = address.split('@')[1] || '';
  if (enderecoComCaractereInvalido(address)) return 'o endereço tem acento ou espaço, e o servidor do cliente recusa';
  if (dominio) {
    const recebe = await dominioRecebeEmail(dominio);
    if (recebe === 'NAO' || (recebe === 'SO_A' && opts?.automatico)) return `o domínio ${dominio} não recebe e-mail`;
  }
  const b = await prisma.emailBounce.findUnique({ where: { accountId_address: { accountId, address } } });
  if (b) {
    // Escreveu pra gente depois da devolução: o endereço está funcionando de novo.
    const escreveu = await prisma.emailMessage.findFirst({
      where: { folder: 'INBOX', fromAddress: { equals: address, mode: 'insensitive' }, date: { gt: b.lastAt }, emailAccount: { accountId } },
      select: { id: true },
    });
    if (escreveu) {
      await prisma.emailBounce.delete({ where: { accountId_address: { accountId, address } } }).catch(() => {});
    } else {
      if (b.kind === 'INEXISTENTE') return 'esse endereço já voltou como inexistente';
      if (opts?.automatico && Date.now() - b.lastAt.getTime() < PAUSA_CAIXA_CHEIA_MS) return 'a caixa desse endereço está cheia';
      // Caixa que voltou cheia 2 vezes é abandonada (um endereço recebeu 11 vezes o "pré-análise aprovada" com a caixa cheia): vale como inexistente.
      const n = await devolucoesCaixaCheia(accountId, address);
      if (n >= 2) return `a caixa desse endereço voltou cheia ${n} vezes; peça outro e-mail ao cliente`;
    }
  }
  if (!opts?.automatico) return null;
  // Sem DMARC no nosso domínio, a Microsoft recusa e a recusa conta como devolução (26 das 43 que suspenderam a conta). Volta sozinho quando o DMARC existir.
  const nosso = (process.env.SMTP_USER || '').split('@')[1]?.toLowerCase();
  if (nosso && dominioMicrosoft(dominio) && !(await temDmarc(nosso))) return `a Microsoft recusa e-mail de ${nosso} enquanto o domínio não tiver DMARC`;
  const freio = await motivoFreio(accountId);
  if (freio) return freio;
  if (!reservarEnvioAutomatico(accountId)) return `envio automático pausado: ${MAX_AUTOMATICOS_POR_HORA} e-mails automáticos na última hora`;
  return null;
}

/** O cliente já recebeu um e-mail com esse assunto? Lembrete que repete (a cada 3 dias, loop de documentos/Follow Up) vai por e-mail só na 1ª vez
 *  (Fabio 13/11) — o WhatsApp continua repetindo. Os dois envios gravam a conversa como "📧 assunto\n\ncorpo". */
export async function emailJaEnviado(leadId: string, subject: string): Promise<boolean> {
  const s = subject.trim();
  if (!s) return false;
  const m = await prisma.message.findFirst({
    where: { leadId, direction: 'OUTBOUND', channel: 'EMAIL', content: { startsWith: `📧 ${s}\n` } },
    select: { id: true },
  });
  return !!m;
}

/** Dos endereços pedidos, os que não podem receber → motivo. */
export async function enderecosBarrados(accountId: string, enderecos: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const e of new Set(enderecos)) {
    const motivo = await motivoBloqueioEmail(accountId, e);
    if (motivo) out.set(e, motivo);
  }
  return out;
}
