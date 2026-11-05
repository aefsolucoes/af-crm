import { prisma } from '../lib/prisma';
import { registerManual, chooseAnalysis } from './credit-analysis.service';

/** BUSCAR PROPOSTAS NO PORTAL DO BANCO (Fabio 05/11: "tem como o CRM listar as propostas aprovadas e colocar para escolhermos?" — inclusive as feitas à mão,
 *  fora do CRM). A equipe pede no card; a extensão do banco procura no portal TODAS as propostas pelos CPFs do card (só leitura, não cria nada) e devolve a
 *  lista; o card mostra cada uma e "Escolher esta proposta" registra a aprovação no CRM (origem PORTAL, sem aviso automático ao cliente) e marca ⭐.
 *  Fica em customFields._buscaPortal[BANCO]. Por enquanto só o Inter (o portal tem busca por CPF). */

export const BUSCA_BANKS = ['INTER'];
const LEASE_MS = 10 * 60_000;

export type PropostaPortal = {
  numero: string; data?: string | null; nome?: string | null; cpf?: string | null; status?: string | null; produto?: string | null;
  aprovado?: boolean; valorPedido?: number | null; valorAprovado?: number | null; prazo?: number | null; taxa?: string | null; indexador?: string | null;
  cet?: number | null; primeira?: number | null; ultima?: number | null;
};

const digitos = (v: unknown) => String(v ?? '').replace(/\D/g, '');
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
const txt = (v: unknown, max = 120) => (v === null || v === undefined || v === '' ? null : String(v).slice(0, max));

async function gravar(leadId: string, bank: string, b: Record<string, any>): Promise<void> {
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_buscaPortal}', COALESCE("customFields"->'_buscaPortal', '{}'::jsonb) || jsonb_build_object(${bank}::text, ${JSON.stringify(b)}::jsonb), true) WHERE id = ${leadId}`;
}

function cpfsDoCard(cf: Record<string, any>): string[] {
  return Array.from(new Set([cf.cpf_1, cf.cpf_2, cf.cpf_3].map(digitos).filter((d) => d.length === 11)));
}

/** Equipe pede a busca. Devolve erro (texto) ou null. */
export async function pedirBuscaPortal(accountId: string, leadId: string, bank: string, por: string): Promise<string | null> {
  if (!BUSCA_BANKS.includes(bank)) return 'Busca no portal ainda só existe para o Inter';
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  if (!l) return 'Lead não encontrado';
  const cf = (l.customFields || {}) as Record<string, any>;
  // Com analise já rodada, o CPF de quem foi titular também vale (proposta no nome do 2º participante).
  const holders = await prisma.creditAnalysis.findMany({ where: { leadId, bank, holderCpf: { not: null } }, select: { holderCpf: true }, take: 20 });
  if (!cpfsDoCard(cf).length && !holders.length) return 'O card não tem CPF (campos CPF 1 / CPF 2) — sem CPF não dá pra procurar no portal';
  const atual = cf._buscaPortal?.[bank];
  if (atual && ['FILA', 'RODANDO'].includes(atual.status) && Date.now() - Date.parse(atual.inicio || atual.pedidoEm) < LEASE_MS) return 'Já tem uma busca em andamento nesse banco';
  await gravar(leadId, bank, { ...(atual || {}), status: 'FILA', pedidoEm: new Date().toISOString(), por, erro: null });
  return null;
}

/** Extensão: próximas buscas do banco (marca RODANDO por 10 min). */
export async function claimBuscas(accountId: string, bank: string, limit = 1): Promise<{ leadId: string; leadName: string; cpfs: string[]; nomes: string[] }[]> {
  if (!BUSCA_BANKS.includes(bank)) return [];
  const vencido = new Date(Date.now() - LEASE_MS).toISOString();
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND archived = false
      AND ("customFields"->'_buscaPortal'->${bank}->>'status' = 'FILA'
        OR ("customFields"->'_buscaPortal'->${bank}->>'status' = 'RODANDO' AND "customFields"->'_buscaPortal'->${bank}->>'inicio' < ${vencido}))
    ORDER BY "customFields"->'_buscaPortal'->${bank}->>'pedidoEm' ASC LIMIT ${limit}`;
  const out: { leadId: string; leadName: string; cpfs: string[]; nomes: string[] }[] = [];
  for (const { id } of rows) {
    const l = await prisma.lead.findUnique({ where: { id }, select: { name: true, customFields: true } });
    if (!l) continue;
    const cf = (l.customFields || {}) as Record<string, any>;
    const holders = await prisma.creditAnalysis.findMany({ where: { leadId: id, bank, holderCpf: { not: null } }, select: { holderCpf: true }, take: 20 });
    const cpfs = Array.from(new Set([...cpfsDoCard(cf), ...holders.map((h) => digitos(h.holderCpf)).filter((d) => d.length === 11)]));
    await gravar(id, bank, { ...(cf._buscaPortal?.[bank] || {}), status: 'RODANDO', inicio: new Date().toISOString() });
    out.push({ leadId: id, leadName: l.name, cpfs, nomes: [cf.participante_1, cf.participante_2, l.name].map((x) => String(x || '').trim()).filter(Boolean) });
  }
  return out;
}

/** Extensão devolve o que achou no portal. */
export async function resultadoBusca(accountId: string, leadId: string, bank: string, body: { propostas?: any[]; erro?: string; amostra?: string }): Promise<void> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  if (!l) return;
  const atual = ((l.customFields || {}) as Record<string, any>)._buscaPortal?.[bank] || {};
  if (body.erro) {
    await gravar(leadId, bank, { ...atual, status: 'ERRO', fim: new Date().toISOString(), erro: String(body.erro).slice(0, 300), amostra: txt(body.amostra, 1500) });
    return;
  }
  const propostas: PropostaPortal[] = (Array.isArray(body.propostas) ? body.propostas : []).slice(0, 40).map((p: any) => ({
    numero: digitos(p.numero).slice(0, 20), data: txt(p.data, 30), nome: txt(p.nome, 80), cpf: digitos(p.cpf).slice(0, 11) || null, status: txt(p.status), produto: txt(p.produto, 60),
    aprovado: p.aprovado === true, valorPedido: num(p.valorPedido), valorAprovado: num(p.valorAprovado), prazo: num(p.prazo), taxa: txt(p.taxa, 60), indexador: txt(p.indexador, 30),
    cet: num(p.cet), primeira: num(p.primeira), ultima: num(p.ultima),
  })).filter((p) => p.numero);
  propostas.sort((a, b) => Number(b.numero) - Number(a.numero));
  await gravar(leadId, bank, { ...atual, status: 'FEITO', fim: new Date().toISOString(), erro: null, propostas, amostra: txt(body.amostra, 1500) });
  const aprov = propostas.filter((p) => p.aprovado);
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🔎 Busca no portal do ${bank === 'INTER' ? 'Inter' : bank}: ${propostas.length} proposta(s) deste cliente${aprov.length ? `, ${aprov.length} aprovada(s)` : ''}.${propostas.length ? `\n${propostas.map((p) => `• nº ${p.numero}${p.data ? ` (${p.data})` : ''}${p.nome ? ` — ${p.nome}` : ''}: ${p.status || '—'}${p.valorAprovado ? ` — aprovado R$ ${p.valorAprovado.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` : p.valorPedido ? ` — pedido R$ ${p.valorPedido.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` : ''}`).join('\n')}` : ''}\nPra seguir com uma delas: aba Financiamento do card → "Escolher esta proposta".` } }).catch(() => {});
}

/** "Escolher esta proposta" numa proposta achada no portal: usa a análise do CRM com o mesmo número, se já existir aprovada; senão registra (origem PORTAL) e marca ⭐. */
export async function escolherDoPortal(accountId: string, leadId: string, bank: string, numero: string, user: { id: string; nome?: string }): Promise<{ ok: true; analysisId: string } | { erro: string }> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  if (!l) return { erro: 'Lead não encontrado' };
  const p = ((((l.customFields || {}) as Record<string, any>)._buscaPortal?.[bank]?.propostas || []) as PropostaPortal[]).find((x) => x.numero === digitos(numero));
  if (!p) return { erro: 'Proposta não está na última busca do portal — busque de novo' };
  if (!p.aprovado || !p.valorAprovado) return { erro: 'Essa proposta não está aprovada no portal' };
  let row = await prisma.creditAnalysis.findFirst({ where: { leadId, bank, proposalNumber: { in: [p.numero, numero] }, status: { in: ['APPROVED', 'CONDITIONAL'] }, approvedValue: p.valorAprovado }, orderBy: { createdAt: 'desc' }, select: { id: true } });
  if (!row) {
    const r = await registerManual(prisma as any, {
      accountId, userId: user.id, leadId, bank, status: 'APPROVED', source: 'PORTAL', kind: 'CHECK',
      detail: `Proposta ${p.numero} encontrada no portal do ${bank === 'INTER' ? 'Inter' : bank} (busca de propostas${p.data ? `, cadastrada em ${p.data}` : ''}) e escolhida por ${user.nome || 'alguém da equipe'}${p.nome ? `. Titular: ${p.nome}` : ''}.`,
      result: { proposalNumber: p.numero, approvedValue: p.valorAprovado, termMonths: p.prazo, rate: p.taxa, indexer: p.indexador, firstInstallment: p.primeira, lastInstallment: p.ultima, holderCpf: p.cpf || undefined },
    });
    row = { id: r.id };
  }
  await chooseAnalysis(prisma as any, { accountId, id: row.id, userName: user.nome });
  return { ok: true, analysisId: row.id };
}
