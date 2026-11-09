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

const cacheDominio = new Map<string, { at: number; recebe: boolean }>();

/** O domínio recebe e-mail? Pega erro de digitação (gmail.como, hotmail.c) antes de virar devolução. DNS fora do ar não barra ninguém. */
async function dominioRecebeEmail(dominio: string): Promise<boolean> {
  const c = cacheDominio.get(dominio);
  if (c && Date.now() - c.at < DNS_TTL_MS) return c.recebe;
  const dns = new Resolver({ timeout: 3000, tries: 1 });
  let recebe = true;
  try {
    // MX nulo (RFC 7505) vem com exchange vazio: o domínio declara que não recebe e-mail (gmail.co, gmail.com.br).
    const mx = await dns.resolveMx(dominio);
    recebe = mx.some((m) => m.exchange && m.exchange !== '.');
  } catch (e: any) {
    if (e?.code === 'ENOTFOUND') recebe = false;
    else if (e?.code === 'ENODATA') {
      // Sem MX, o servidor de envio tenta o próprio domínio (registro A).
      recebe = await dns.resolve4(dominio).then((a) => a.length > 0, (e2: any) => !['ENOTFOUND', 'ENODATA'].includes(e2?.code));
    }
  }
  cacheDominio.set(dominio, { at: Date.now(), recebe });
  return recebe;
}

/** Motivo pra NÃO enviar a este endereço; null = pode enviar. */
export async function motivoBloqueioEmail(accountId: string, endereco: string, opts?: { automatico?: boolean }): Promise<string | null> {
  const address = endereco.trim().toLowerCase();
  const dominio = address.split('@')[1] || '';
  if (dominio && !(await dominioRecebeEmail(dominio))) return `o domínio ${dominio} não recebe e-mail`;
  const b = await prisma.emailBounce.findUnique({ where: { accountId_address: { accountId, address } } });
  if (!b) return null;
  // Escreveu pra gente depois da devolução: o endereço está funcionando de novo.
  const escreveu = await prisma.emailMessage.findFirst({
    where: { folder: 'INBOX', fromAddress: { equals: address, mode: 'insensitive' }, date: { gt: b.lastAt }, emailAccount: { accountId } },
    select: { id: true },
  });
  if (escreveu) {
    await prisma.emailBounce.delete({ where: { accountId_address: { accountId, address } } }).catch(() => {});
    return null;
  }
  if (b.kind === 'INEXISTENTE') return 'esse endereço já voltou como inexistente';
  if (opts?.automatico && Date.now() - b.lastAt.getTime() < PAUSA_CAIXA_CHEIA_MS) return 'a caixa desse endereço está cheia';
  return null;
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
