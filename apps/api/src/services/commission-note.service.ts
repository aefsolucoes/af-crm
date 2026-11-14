import { prisma } from '../lib/prisma';

/* Nota de comissão (Fabio 14/11): "podemos receber mais de um processo pro banco e seria tudo incluso na mesma nota".
 *  - A equipe escolhe quem paga e anexa o PDF (nota fiscal ou demonstrativo do banco). A IA lê nº, data, total e — quando a nota lista — cliente por cliente.
 *  - O CRM propõe quais processos em aberto entram na nota e quanto é de cada um: pelo que a nota lista; senão, pelos processos daquele pagador cuja
 *    estimativa mais se aproxima do total, dividindo o total na proporção da estimativa (a soma bate exatamente com a nota).
 *  - Confirmada, o valor da nota substitui a estimativa pela % em cada processo, e a taxa efetiva (valor ÷ crédito) por banco e produto passa a ser
 *    a sugestão dos próximos clientes desse banco ("o CRM também aprende com isso"). */

export type Produto = 'HE' | 'FH' | 'OUTRO';
export const produtoDe = (product?: string | null): Produto => (/home equity/i.test(product || '') ? 'HE' : /financiamento/i.test(product || '') ? 'FH' : 'OUTRO');
const semAcento = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Banco de verdade do processo: "Credimorar (Inter)" → INTER; Credimorar no Home Equity → SANTANDER; "Inter" → INTER. Sem banco → null. */
export function bancoReal(product: string | null | undefined, payer: string | null | undefined): string | null {
  const dentro = /\(([^)]+)\)/.exec(payer || '')?.[1];
  const t = semAcento(String(dentro || payer || '')).toLowerCase().trim();
  if (!t) return null;
  if (/^credimorar$/.test(t)) return produtoDe(product) === 'HE' ? 'SANTANDER' : null;
  for (const [rx, k] of [[/inter\b/, 'INTER'], [/creditas/, 'CREDITAS'], [/santander/, 'SANTANDER'], [/bradesco/, 'BRADESCO'], [/itau/, 'ITAU'], [/caixa/, 'CAIXA'], [/brb/, 'BRB']] as Array<[RegExp, string]>) {
    if (rx.test(t)) return k;
  }
  return t.toUpperCase();
}
/** Quem paga a nota, sem o banco entre parênteses: "Credimorar (Bradesco)" → "Credimorar". */
export const pagadorRaiz = (payer?: string | null) => String(payer || '').replace(/\s*\(.*\)\s*$/, '').trim();
const mesmoPagador = (a?: string | null, b?: string | null) => !!a && !!b && semAcento(pagadorRaiz(a)).toLowerCase() === semAcento(pagadorRaiz(b)).toLowerCase();

const BANCO_NOME: Record<string, string> = { INTER: 'Inter', CREDITAS: 'Creditas', SANTANDER: 'Santander', BRADESCO: 'Bradesco', ITAU: 'Itaú', CAIXA: 'CAIXA', BRB: 'BRB' };
export const nomeDoBanco = (k: string) => BANCO_NOME[k] || k;

export interface TaxaAprendida { banco: string; produto: Produto; pct: number; processos: number; notas: number; ultimaNota: string | null }

/** Taxa efetiva por banco + produto, das notas confirmadas: soma do valor ÷ soma do crédito dos últimos 10 processos com nota. */
export async function taxasAprendidas(accountId: string): Promise<Map<string, TaxaAprendida>> {
  const notas = await prisma.commissionNote.findMany({ where: { accountId, status: { in: ['OPEN', 'RECEIVED'] } }, select: { id: true, number: true, issueDate: true, createdAt: true } });
  if (!notas.length) return new Map();
  const quando = new Map(notas.map((n) => [n.id, (n.issueDate || n.createdAt).getTime()]));
  const numero = new Map(notas.map((n) => [n.id, n.number]));
  const provs = await prisma.commissionProvision.findMany({ where: { accountId, noteId: { in: notas.map((n) => n.id) }, baseAmount: { gt: 0 } }, select: { noteId: true, product: true, payer: true, baseAmount: true, amount: true, receivedAmount: true } });
  const grupos = new Map<string, typeof provs>();
  for (const p of provs) {
    const banco = bancoReal(p.product, p.payer);
    if (!banco) continue;
    const k = `${produtoDe(p.product)}|${banco}`;
    grupos.set(k, [...(grupos.get(k) || []), p]);
  }
  const out = new Map<string, TaxaAprendida>();
  for (const [k, lista] of grupos) {
    const recentes = [...lista].sort((a, b) => (quando.get(b.noteId!) || 0) - (quando.get(a.noteId!) || 0)).slice(0, 10);
    const base = recentes.reduce((s, p) => s + p.baseAmount, 0);
    const valor = recentes.reduce((s, p) => s + (p.receivedAmount ?? p.amount), 0);
    if (!(base > 0) || !(valor > 0)) continue;
    const [produto, banco] = k.split('|') as [Produto, string];
    const maisNova = recentes[0]?.noteId || null;
    out.set(k, { banco, produto, pct: Math.round((valor / base) * 100 * 10_000) / 10_000, processos: recentes.length, notas: new Set(recentes.map((p) => p.noteId)).size, ultimaNota: maisNova ? numero.get(maisNova) || null : null });
  }
  return out;
}

/** A taxa que vale pra um processo: a aprendida das notas desse banco e produto, quando existe; senão a da tabela. */
export function taxaComAprendizado(aprendidas: Map<string, TaxaAprendida>, product: string | null | undefined, payer: string | null | undefined, taxaTabela: number): { pct: number; aprendida: TaxaAprendida | null } {
  const banco = bancoReal(product, payer);
  const a = banco ? aprendidas.get(`${produtoDe(product)}|${banco}`) : undefined;
  return a ? { pct: a.pct, aprendida: a } : { pct: taxaTabela, aprendida: null };
}

// ── Leitura do arquivo pela IA ──────────────────────────────────────────────────────────────────────────────
export interface LeituraNota {
  numero: string | null;
  data: string | null; // AAAA-MM-DD
  valorTotal: number | null;
  emitente: string | null;
  tomador: string | null;
  itens: Array<{ cliente: string; cpf?: string | null; valor: number | null; credito?: number | null; candidatoId?: string | null }>;
  observacao: string | null;
}

const SYSTEM_LEITURA = `Você lê notas fiscais de serviço (NFS-e) e demonstrativos de comissão que bancos e correspondentes (Inter, Creditas, Credimorar, Santander, Bradesco, Itaú, CAIXA, BRB) pagam à A&F Consultoria de Crédito por processos de crédito (Home Equity e Financiamento Habitacional).
Extraia do documento:
- numero: número da nota (ou do demonstrativo), só o número;
- data: data de emissão no formato AAAA-MM-DD;
- valorTotal: valor total da nota/serviço em reais (número, ponto como separador decimal). Se houver valor bruto e líquido, use o BRUTO dos serviços (antes de retenções);
- emitente e tomador (nomes);
- itens: um por cliente/processo que o documento listar (na discriminação do serviço, numa tabela ou no demonstrativo): nome do cliente, CPF se tiver, valor da comissão daquele cliente e o valor do crédito/contrato se aparecer. Se o documento não lista clientes, itens = [].
Você recebe também a lista de PROCESSOS EM ABERTO do CRM (id, cliente, crédito, comissão estimada). Para cada item, preencha candidatoId com o id do processo do MESMO cliente (compare nome e sobrenome; ignore acentos e maiúsculas); se nenhum for do mesmo cliente, null. Nunca invente cliente que o documento não cita.
- observacao: uma frase curta com algo que a equipe deva saber (ex.: "nota sem discriminação dos clientes", "valor líquido após ISS diferente do bruto"), ou null.
Responda SOMENTE com um JSON: {"numero":…,"data":…,"valorTotal":…,"emitente":…,"tomador":…,"itens":[{"cliente":…,"cpf":…,"valor":…,"credito":…,"candidatoId":…}],"observacao":…}`;

export async function lerNotaComIA(arquivo: Buffer, mime: string, candidatos: Array<{ id: string; cliente: string; credito: number; estimado: number; pagador: string | null }>): Promise<LeituraNota | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !arquivo.length || arquivo.length > 15_000_000) return null;
  const ehPdf = /pdf/i.test(mime) || arquivo.subarray(0, 5).toString() === '%PDF-';
  const imagem = /^image\/(png|jpe?g|gif|webp)$/i.test(mime) ? mime.toLowerCase().replace('jpg', 'jpeg') : null;
  if (!ehPdf && !imagem) return null;
  const bloco = ehPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: arquivo.toString('base64') } }
    : { type: 'image', source: { type: 'base64', media_type: imagem, data: arquivo.toString('base64') } };
  const lista = candidatos.map((c) => `- ${c.id} | ${c.cliente} | crédito R$ ${c.credito.toFixed(2)} | estimado R$ ${c.estimado.toFixed(2)}${c.pagador ? ` | paga: ${c.pagador}` : ''}`).join('\n');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 8192,
      system: SYSTEM_LEITURA,
      messages: [{ role: 'user', content: [bloco, { type: 'text', text: `PROCESSOS EM ABERTO NO CRM:\n${lista || '(nenhum)'}` }] }],
    }),
  }).catch(() => null);
  if (!res || !res.ok) { console.warn('[Nota comissão] leitura falhou:', res?.status); return null; }
  const data = (await res.json().catch(() => null)) as { content?: { type: string; text?: string }[]; stop_reason?: string } | null;
  const texto = data?.content?.filter((c) => c.type === 'text').map((c) => c.text || '').join('') || '';
  try {
    const j = JSON.parse(texto.match(/\{[\s\S]*\}/)?.[0] || '');
    const num = (v: unknown) => { const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[^\d.,-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null; };
    const ids = new Set(candidatos.map((c) => c.id));
    return {
      numero: j.numero ? String(j.numero).trim().slice(0, 40) : null,
      data: /^\d{4}-\d{2}-\d{2}$/.test(String(j.data || '')) ? String(j.data) : null,
      valorTotal: num(j.valorTotal),
      emitente: j.emitente ? String(j.emitente).slice(0, 120) : null,
      tomador: j.tomador ? String(j.tomador).slice(0, 120) : null,
      itens: (Array.isArray(j.itens) ? j.itens : []).slice(0, 60).map((i: any) => ({
        cliente: String(i?.cliente || '').slice(0, 120), cpf: i?.cpf ? String(i.cpf).slice(0, 20) : null, valor: num(i?.valor), credito: num(i?.credito),
        candidatoId: i?.candidatoId && ids.has(String(i.candidatoId)) ? String(i.candidatoId) : null,
      })).filter((i: { cliente: string }) => i.cliente),
      observacao: j.observacao ? String(j.observacao).slice(0, 300) : null,
    };
  } catch {
    console.warn('[Nota comissão] JSON ilegível', data?.stop_reason, texto.slice(0, 200));
    return null;
  }
}

// ── Proposta de quais processos entram e quanto é de cada um ───────────────────────────────────────────────
export interface Candidato { id: string; kind: 'PROVISION' | 'SUGGESTION'; leadId: string; cliente: string; produto: string | null; pagador: string | null; credito: number; estimado: number; etapa: string }

/** Divide `total` na proporção de `pesos` (centavos exatos: a última parcela fica com a sobra do arredondamento). */
export function dividirProporcional(total: number, pesos: number[]): number[] {
  const soma = pesos.reduce((s, p) => s + p, 0);
  if (!(soma > 0)) return pesos.map(() => 0);
  const partes = pesos.map((p) => Math.round((total * p) / soma * 100) / 100);
  const dif = Math.round((total - partes.reduce((s, p) => s + p, 0)) * 100) / 100;
  if (partes.length) partes[partes.length - 1] = Math.round((partes[partes.length - 1] + dif) * 100) / 100;
  return partes;
}

/** Subconjunto dos processos cuja estimativa soma mais perto do total da nota (até 18 processos do mesmo pagador; acima disso, todos). */
export function melhorSubconjunto(total: number, estimados: number[]): number[] {
  const n = estimados.length;
  if (!n) return [];
  if (n > 18) return estimados.map((_, i) => i);
  let melhor: number[] = [], melhorDif = Infinity;
  for (let mask = 1; mask < 1 << n; mask++) {
    let s = 0;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) s += estimados[i];
    const dif = Math.abs(s - total);
    if (dif < melhorDif - 0.005) { melhorDif = dif; melhor = []; for (let i = 0; i < n; i++) if (mask & (1 << i)) melhor.push(i); }
  }
  return melhor;
}

/** Proposta: itens que a IA ligou a um processo levam o valor da nota; sem itens, o subconjunto do pagador que mais se aproxima, dividido na proporção. */
export function proporItens(leitura: LeituraNota | null, total: number, payer: string, candidatos: Candidato[]): Array<{ id: string; amount: number; motivo: string }> {
  const ligados = (leitura?.itens || []).filter((i) => i.candidatoId);
  if (ligados.length) {
    const vistos = new Set<string>();
    const out: Array<{ id: string; amount: number; motivo: string }> = [];
    for (const i of ligados) {
      if (vistos.has(i.candidatoId!)) continue;
      vistos.add(i.candidatoId!);
      const c = candidatos.find((x) => x.id === i.candidatoId);
      out.push({ id: i.candidatoId!, amount: i.valor ?? c?.estimado ?? 0, motivo: `a nota cita ${i.cliente}` });
    }
    // Itens sem valor na nota: dividem o que sobrar do total, na proporção da estimativa.
    const semValor = out.filter((o) => !(o.amount > 0) || !(leitura?.itens || []).find((i) => i.candidatoId === o.id && i.valor));
    if (semValor.length && total > 0) {
      const comValor = out.filter((o) => !semValor.includes(o)).reduce((s, o) => s + o.amount, 0);
      const resto = Math.max(0, total - comValor);
      const partes = dividirProporcional(resto, semValor.map((o) => candidatos.find((c) => c.id === o.id)?.estimado || 1));
      semValor.forEach((o, k) => { o.amount = partes[k]; o.motivo += ' (sem valor por cliente: dividido pela estimativa)'; });
    }
    return out;
  }
  if (!(total > 0)) return [];
  // Santander do Home Equity é pago pela Credimorar: nota "Santander" casa com os processos "Credimorar" do HE.
  const casa = (c: Candidato) => mesmoPagador(c.pagador, payer) || (/santander/i.test(payer) && /^credimorar$/i.test(pagadorRaiz(c.pagador)) && produtoDe(c.produto) === 'HE');
  const doPagador = candidatos.filter((c) => casa(c) && c.estimado > 0);
  const idx = melhorSubconjunto(total, doPagador.map((c) => c.estimado));
  const escolhidos = idx.map((i) => doPagador[i]);
  const partes = dividirProporcional(total, escolhidos.map((c) => c.estimado));
  return escolhidos.map((c, k) => ({ id: c.id, amount: partes[k], motivo: 'a nota não lista os clientes: escolhi os processos desse pagador que somam mais perto do total' }));
}

/** Processos que podem entrar numa nota: provisões em aberto sem nota (ou já desta nota) + concluídos com comissão sugerida e sem provisão. */
export async function candidatosDaNota(accountId: string, noteId?: string): Promise<Candidato[]> {
  const provs = await prisma.commissionProvision.findMany({
    where: { accountId, status: 'OPEN', OR: [{ noteId: null }, ...(noteId ? [{ noteId }] : [])] },
    orderBy: { createdAt: 'asc' },
  });
  const leads = await prisma.lead.findMany({ where: { id: { in: provs.map((p) => p.leadId) } }, select: { id: true, status: true, pipeline: { select: { name: true } }, stage: { select: { name: true } } } });
  const onde = new Map(leads.map((l) => [l.id, l]));
  const out: Candidato[] = provs
    .filter((p) => { const l = onde.get(p.leadId); return !(l && (l.status === 'LOST' || /perdid/i.test(l.pipeline.name))); }) // Perdidos não pagam
    .map((p) => { const l = onde.get(p.leadId); return { id: p.id, kind: 'PROVISION' as const, leadId: p.leadId, cliente: p.leadName, produto: p.product, pagador: p.payer, credito: p.baseAmount, estimado: p.estimatedAmount ?? p.amount, etapa: l ? `${l.pipeline.name} · ${l.stage.name}` : 'Card removido' }; });
  const comProvisao = new Set((await prisma.commissionProvision.findMany({ where: { accountId }, select: { leadId: true } })).map((p) => p.leadId));
  const sugs = await prisma.commissionSuggestion.findMany({ where: { accountId, status: 'PENDING' }, orderBy: { createdAt: 'asc' } });
  const sl = await prisma.lead.findMany({ where: { id: { in: sugs.map((s) => s.leadId) } }, select: { id: true, name: true, pipeline: { select: { name: true, department: { select: { name: true } } } }, stage: { select: { name: true } } } });
  const sm = new Map(sl.map((l) => [l.id, l]));
  for (const s of sugs) {
    if (comProvisao.has(s.leadId)) continue;
    const l = sm.get(s.leadId);
    if (!l) continue;
    out.push({ id: `sug:${s.id}`, kind: 'SUGGESTION', leadId: s.leadId, cliente: l.name, produto: l.pipeline.department?.name || null, pagador: null, credito: s.baseAmount, estimado: s.suggestedAmount, etapa: `${l.pipeline.name} · ${l.stage.name}` });
  }
  return out;
}

/** Depois de confirmar uma nota: as provisões ESTIMADAS (sem nota e sem % digitada por uma pessoa) do mesmo banco e produto passam pra taxa aprendida. */
export async function reestimarPelasNotas(accountId: string): Promise<string[]> {
  const aprendidas = await taxasAprendidas(accountId);
  if (!aprendidas.size) return [];
  const abertas = await prisma.commissionProvision.findMany({ where: { accountId, status: 'OPEN', noteId: null, rateLocked: false } });
  const mudou: string[] = [];
  for (const p of abertas) {
    const { aprendida } = taxaComAprendizado(aprendidas, p.product, p.payer, p.ratePct);
    if (!aprendida || Math.abs(aprendida.pct - p.ratePct) < 0.0001 || !(p.baseAmount > 0)) continue;
    const amount = Math.round(p.baseAmount * aprendida.pct) / 100;
    await prisma.commissionProvision.update({ where: { id: p.id }, data: { ratePct: aprendida.pct, amount } });
    mudou.push(`${p.leadName}: ${p.ratePct}% → ${aprendida.pct}% (R$ ${p.amount.toFixed(2)} → R$ ${amount.toFixed(2)})`);
  }
  return mudou;
}
