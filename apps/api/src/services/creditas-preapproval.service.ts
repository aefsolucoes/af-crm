import { PrismaClient, EmailMessage, EmailAccount } from '@prisma/client';
import { parseScrCases } from './creditas-scr.service';

/**
 * "Crédito Pré Aprovado" por E-MAIL da Creditas (Jonatas) vira APROVAÇÃO da Creditas no CRM (Fabio 19/10, Maria Selmi: a pré-aprovação chegou por e-mail em 16/10, ficou ligada ao card
 * e ninguém a transformou em aprovação — o card continuou "em análise" por 3 dias). O e-mail segue sempre o mesmo modelo (valor total, valor líquido, prazo, taxa, 1ª/2ª parcelas…).
 * Registrada a aprovação, vale o fluxo normal: aviso ao cliente (só com a IA do card ligada; senão o botão "Avisar cliente"), lista de documentos, etc.
 */
const prisma = new PrismaClient();
type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | null | undefined;

const brl = (s: string | undefined): number | null => {
  const m = /R\$\s*([\d.]+,\d{2})/.exec(s || '');
  return m ? Number(m[1].replace(/\./g, '').replace(',', '.')) : null;
};
const fmt = (v: number | null) => (v == null ? '' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));

export interface PreApproval {
  creditasId?: string; cpf?: string; name?: string;
  total: number | null; liquido: number; prazo: number;
  taxaMes?: string; taxaAno?: string; cet?: string; indexador?: string; sistema?: string; carencia?: string; tipoTaxa?: string;
  primeira: number | null; segunda: number | null;
}

/** Lê o e-mail "Crédito Pré Aprovado". null = não é esse e-mail (ou faltam os números essenciais: líquido e prazo). Pura. */
export function parsePreApproval(subject: string | null | undefined, text: string): PreApproval | null {
  const flat = String(text || '').replace(/\r/g, '');
  const isPre = /pr[eé][-\s]?aprovad/i.test(subject || '') || /cr[eé]dito do seu cliente foi pr[eé][-\s]?aprovado/i.test(flat);
  if (!isPre) return null;
  const line = (rx: RegExp) => (rx.exec(flat) || [])[1]?.trim();
  const liquido = brl(line(/Valor l[ií]quido a liberar ao cliente:\s*([^\n]*)/i)) ?? brl(line(/Valor do Financiamento L[ií]quido:\s*([^\n]*)/i));
  const prazo = Number(line(/\bPrazo:\s*(\d+)/i) || 0);
  if (!liquido || !prazo) return null;
  const taxa = /Taxa de Juros:\s*([\d.,]+%\s*a\.m\.?)(?:\s*\/\s*([\d.,]+%\s*a\.a\.?))?/i.exec(flat);
  const cet = /Custo Efetivo Total \(CET\):\s*([\d.,]+%\s*a\.m\.?)/i.exec(flat);
  const par = /1[ªa]\/2[ªa] parcelas:+\s*(R\$\s*[\d.,]+)\s*\/\s*(R\$\s*[\d.,]+)/i.exec(flat);
  const caso = parseScrCases(`${subject || ''}\n${flat}`)[0];
  return {
    creditasId: caso?.creditasId, cpf: caso?.cpf, name: caso?.name?.replace(/^Cr[eé]dito Pr[eé][-\s]?Aprovado\s*-?\s*/i, '').trim(),
    total: brl(line(/Valor total do financiamento:\s*([^\n]*)/i)), liquido, prazo,
    taxaMes: taxa?.[1]?.replace(/a\.m\.?$/i, 'a.m.'), taxaAno: taxa?.[2]?.replace(/a\.a\.?$/i, 'a.a.'), cet: cet?.[1]?.replace(/a\.m\.?$/i, 'a.m.'),
    indexador: line(/Indexador:\s*([^\n]*)/i), sistema: line(/Sistema de Amortiza[cç][aã]o:\s*([^\n]*)/i), carencia: line(/Per[ií]odo de car[eê]ncia:\s*([^\n]*)/i), tipoTaxa: line(/Tipo de taxa:\s*([^\n]*)/i),
    primeira: brl(par?.[1]), segunda: brl(par?.[2]),
  };
}

/** Grava a aprovação da Creditas a partir do e-mail. Devolve 'criada' | 'ja-existe' | 'portal-tem' (a leitura do portal já traz os números — vale ela). Idempotente (o e-mail chega em 2 caixas). */
export async function registerPreApproval(p: { accountId: string; leadId: string; leadName: string; row: Pick<EmailMessage, 'date' | 'subject' | 'textBody' | 'htmlBody'>; io?: Io }): Promise<'criada' | 'ja-existe' | 'portal-tem' | 'nao-e-pre-aprovacao'> {
  const text = p.row.textBody || '';
  const pre = parsePreApproval(p.row.subject, text);
  if (!pre) return 'nao-e-pre-aprovacao';
  const since = new Date(Date.now() - 45 * 86_400_000);
  const existentes = await prisma.creditAnalysis.findMany({ where: { leadId: p.leadId, bank: 'CREDITAS', dryRun: false, createdAt: { gte: since } }, select: { status: true, approvedValue: true, netValue: true, proposalNumber: true, source: true } });
  if (pre.creditasId && existentes.some((r) => r.source === 'EMAIL' && r.proposalNumber === pre.creditasId && r.netValue != null && Math.abs((r.netValue || 0) - pre.liquido) < 1)) return 'ja-existe';
  if (existentes.some((r) => r.source !== 'EMAIL' && r.status === 'APPROVED' && r.approvedValue != null)) return 'portal-tem';
  const dia = p.row.date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  const taxa = pre.taxaMes ? `${pre.taxaMes}${pre.indexador ? ` + ${pre.indexador}` : ''}${pre.tipoTaxa ? `, ${pre.tipoTaxa.toLowerCase()}` : ''}` : '';
  const conditions = [
    `Creditas (pré-aprovação enviada por e-mail em ${dia}): crédito aprovado ${fmt(pre.total)}`.replace('aprovado ', 'aprovado '),
    `valor líquido do contrato ${fmt(pre.liquido)} (já descontados IOF, tarifa de cadastro e custas)`,
    `prazo ${pre.prazo} meses`,
    pre.primeira ? `1ª parcela ${fmt(pre.primeira)}` : '',
    taxa ? `juros ${taxa}` : '',
    pre.cet ? `CET ${pre.cet}` : '',
    pre.carencia ? `carência ${pre.carencia}` : '',
    pre.sistema ? `amortização ${pre.sistema}` : '',
  ].filter(Boolean).join('; ');
  const lead = await prisma.lead.findUnique({ where: { id: p.leadId }, select: { customFields: true } });
  const cf = (lead?.customFields || {}) as Record<string, any>;
  const holderName = pre.name && pre.name.length > 3 ? pre.name : String(cf.participante_1 || p.leadName);
  await prisma.creditAnalysis.create({
    data: {
      accountId: p.accountId, leadId: p.leadId, bank: 'CREDITAS', status: 'APPROVED', kind: 'RUN', source: 'EMAIL', dryRun: false,
      detail: `RESULTADO: pré-aprovada pela Creditas (e-mail do Jonatas de ${dia}${pre.creditasId ? `, ID ${pre.creditasId}` : ''}). CONDIÇÕES — ${conditions}.`,
      proposalNumber: pre.creditasId || null, approvedValue: pre.total ?? pre.liquido, netValue: pre.liquido, termMonths: pre.prazo,
      rate: pre.taxaMes ? `${pre.taxaMes}${pre.indexador ? ` + ${pre.indexador}` : ''}` : null, indexer: pre.indexador || null, firstInstallment: pre.primeira, lastInstallment: null, conditions,
      holderName, holderCpf: pre.cpf || String(cf.cpf_1 || '').replace(/\D/g, '') || null,
      requestedValue: Number(String(cf.valor_credito ?? '').replace(/[^\d.]/g, '')) || null, startedAt: p.row.date, finishedAt: new Date(),
    },
  });
  await prisma.note.create({ data: { leadId: p.leadId, type: 'COMMENT', content: `✅ A Creditas PRÉ-APROVOU por e-mail (${dia}${pre.creditasId ? `, ID ${pre.creditasId}` : ''}): ${conditions}. Registrei como aprovação da Creditas.` } }).catch(() => {});
  p.io?.to(`account_${p.accountId}`).emit('credit_analysis_updated', { leadId: p.leadId });
  return 'criada';
}

/** Procura, nos e-mails da Creditas ligados ao card (últimos 30 dias), a pré-aprovação ainda não registrada e registra. true = registrou alguma. */
export async function backfillPreApprovals(accountId: string, leadId: string, io?: Io): Promise<boolean> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true } });
  if (!lead) return false;
  const rows = await prisma.emailMessage.findMany({
    where: { leadId, fromAddress: { contains: 'creditas', mode: 'insensitive' }, date: { gte: new Date(Date.now() - 30 * 86_400_000) }, OR: [{ subject: { contains: 'aprovad', mode: 'insensitive' } }, { textBody: { contains: 'pré-aprovado', mode: 'insensitive' } }] },
    orderBy: { date: 'asc' }, select: { date: true, subject: true, textBody: true, htmlBody: true },
  });
  let feito = false;
  for (const row of rows) if ((await registerPreApproval({ accountId, leadId, leadName: lead.name, row, io })) === 'criada') feito = true;
  return feito;
}

export type { EmailAccount };
