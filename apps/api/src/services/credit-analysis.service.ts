import type { PrismaClient, Prisma } from '@prisma/client';
import { whyNotRun } from './credit-not-run';

/**
 * Aba "Análise de Crédito" (Fabio 14/10). As extensões do Chrome dele (Inter,
 * Creditas, Credimorar/Santander) rodam a análise nos portais dos bancos;
 * aqui o CRM guarda o retorno, mostra numa aba, dispara novas análises (fila
 * que a extensão busca) e registra a proposta ESCOLHIDA pra cada cliente —
 * escolha manual por enquanto. Cada função recebe `db` (cliente do Prisma ou
 * transação) pra poder ser testada dentro de uma transação desfeita no final.
 *
 * Uma linha por execução (lead × banco):
 *   REQUESTED (pedida pelo CRM) → RUNNING (extensão pegou) → SENT (enviada, resultado ainda
 *   não lido) → APPROVED | REJECTED | FAILED | CHECK (conferir no portal) | INCOMPLETE | TEST.
 * A extensão só manda status + texto (+ número da proposta/valor quando consegue ler); os
 * números completos de aprovação (valor aprovado, taxa, prazo, parcelas) vêm do formulário
 * de resultado da aba ou da skill do Fabio.
 */

type Db = PrismaClient | Prisma.TransactionClient;
export const BANKS: Record<string, { label: string; instituicao: string }> = {
  INTER: { label: 'Banco Inter', instituicao: 'Inter' },
  CREDITAS: { label: 'Creditas', instituicao: 'Creditas' },
  CREDIMORAR: { label: 'Santander (Credimorar)', instituicao: 'Santander' },
};
export const BANK_KEYS = Object.keys(BANKS);

/** Status em português que as extensões já usam (recordHistory) → status do CRM. */
export const EXTENSION_STATUS: Record<string, string> = {
  enviando: 'RUNNING', enviado: 'SENT', aprovado: 'APPROVED', rejeitado: 'REJECTED',
  falhou: 'FAILED', verificar: 'CHECK', incompleto: 'INCOMPLETE', teste: 'TEST', condicional: 'CONDITIONAL',
};
const ALL_STATUS = new Set(['REQUESTED', 'RUNNING', 'SENT', 'APPROVED', 'CONDITIONAL', 'REJECTED', 'FAILED', 'CHECK', 'INCOMPLETE', 'TEST']);
const FINAL = new Set(['APPROVED', 'CONDITIONAL', 'REJECTED', 'FAILED', 'CHECK', 'INCOMPLETE', 'TEST']);
const ACTIVE = ['REQUESTED', 'RUNNING'];
/** Bancos cuja extensão sabe só CONFERIR uma proposta já enviada (sem criar outra). */
export const CHECK_BANKS = ['INTER', 'CREDIMORAR', 'CREDITAS'];
const CREDITAS_MAX_AGE_MS = 60 * 3_600_000; // e desiste de conferir sozinho 60 h depois da 1ª conferência (cobre 2 noites sem leitura)
const BRT_MS = 3 * 3_600_000; // Brasília = UTC-3 (sem horário de verão)
const CHECK_MAX_TRIES = 18; // 18 conferências de 10 min = ~3 h; passou disso, fica pra conferir à mão
const CREDITAS_EXTRA_TRIES = 144; // Creditas demora (horas): depois das ~3 h segue de 10 em 10 min por mais 24 h (144 conferências)
const REAL_SENT = ['SENT', 'APPROVED', 'CONDITIONAL', 'REJECTED', 'CHECK']; // já foi rodada de verdade nesse banco
const STALE_ACTIVE_MS = 25 * 60 * 1000; // pedido/execução parado há mais que isso não bloqueia um novo
const STUCK_RUNNING_MS = 8 * 60 * 1000; // rodando há mais que isso sem NENHUM passo novo da extensão = parou (Fabio 14/10: antes eram 30 min e travava a fila; 5 min pareceu curto, ficou 8; cada passo da extensão leva < 3 min)
const REPORT_REUSE_MS = 12 * 60 * 60 * 1000; // relatório da extensão continua a execução aberta das últimas 12 h

export interface ResultFields {
  proposalNumber?: string | null;
  holderCpf?: string | null;
  approvedValue?: number | null;
  netValue?: number | null;
  termMonths?: number | null;
  rate?: string | null;
  indexer?: string | null;
  firstInstallment?: number | null;
  lastInstallment?: number | null;
  conditions?: string | null;
}
const RESULT_KEYS: (keyof ResultFields)[] = ['proposalNumber', 'holderCpf', 'approvedValue', 'netValue', 'termMonths', 'rate', 'indexer', 'firstInstallment', 'lastInstallment', 'conditions'];

const brl = (n: number | null | undefined) => (n == null ? '' : n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));

function pickResult(input: Record<string, any>): ResultFields {
  const out: ResultFields = {};
  const num = (v: any) => { const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[^\d.,-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')); return Number.isFinite(n) && n > 0 ? n : null; };
  if ('proposalNumber' in input) out.proposalNumber = input.proposalNumber ? String(input.proposalNumber).slice(0, 40) : null;
  if ('holderCpf' in input) { const d = String(input.holderCpf || '').replace(/\D/g, ''); out.holderCpf = d.length === 11 ? d : null; }
  if ('approvedValue' in input) out.approvedValue = num(input.approvedValue);
  if ('netValue' in input) out.netValue = num(input.netValue);
  if ('termMonths' in input) { const t = num(input.termMonths); out.termMonths = t ? Math.round(t) : null; }
  if ('rate' in input) out.rate = input.rate ? String(input.rate).slice(0, 120) : null;
  if ('indexer' in input) out.indexer = input.indexer ? String(input.indexer).slice(0, 40) : null;
  if ('firstInstallment' in input) out.firstInstallment = num(input.firstInstallment);
  if ('lastInstallment' in input) out.lastInstallment = num(input.lastInstallment);
  if ('conditions' in input) out.conditions = input.conditions ? String(input.conditions).slice(0, 2000) : null;
  return out;
}

/** Qual participante do card é o titular de uma análise (1 = 1º, 2 = 2º). Pelo CPF gravado quando há; senão pelo NOME, que o portal abrevia ou muda:
 *  não vale "um contém o outro" ("Douglas Rafael Santos" contém "Rafael Santos" e jogava o resultado do Douglas na coluna do Rafael — Fabio 15/10).
 *  Vence o nome mais parecido (palavras em comum ÷ palavras de cada um); empate ou nenhum parecido = 1º participante. Pura (testável). */
export function whichParticipant(card: { name1?: string | null; name2?: string | null; cpf1?: string | null; cpf2?: string | null }, holder?: string | null, holderCpf?: string | null): 1 | 2 {
  const dig = (v?: string | null) => String(v || '').replace(/\D/g, '');
  const hc = dig(holderCpf), c1 = dig(card.cpf1), c2 = dig(card.cpf2);
  if (hc.length === 11) { if (c2.length === 11 && hc === c2) return 2; if (c1.length === 11 && hc === c1) return 1; }
  const tok = (t?: string | null) => normName(t || '').split(' ').filter((w) => w && !['de', 'da', 'do', 'dos', 'das', 'e'].includes(w));
  const h = tok(holder), t1 = tok(card.name1), t2 = tok(card.name2);
  if (!h.length || !t2.length) return 1;
  const score = (t: string[]) => {
    if (!t.length) return 0;
    const inter = h.filter((w) => t.includes(w)).length;
    return inter ? inter / (h.length + t.length - inter) : 0; // Jaccard
  };
  return score(t2) > score(t1) ? 2 : 1;
}

/** Última análise de cada banco separada por PARTICIPANTE: o resultado do 2º participante (rodado no nome dele) aparece junto do
 *  do 1º, em vez de um esconder o outro. `rows` vem do mais novo pro mais antigo. */
function latestByParticipant(rows: any[], cf: Record<string, any>, leadName?: string | null): { p1: Record<string, any>; p2: Record<string, any> } {
  const card = { name1: String(cf.participante_1 || leadName || ''), name2: String(cf.participante_2 || ''), cpf1: cf.cpf_1, cpf2: cf.cpf_2 };
  const p1Rows: any[] = [], p2Rows: any[] = [];
  for (const a of rows) (whichParticipant(card, a.holderName, a.holderCpf) === 2 ? p2Rows : p1Rows).push(a);
  return { p1: latestPerBank(p1Rows), p2: latestPerBank(p2Rows) };
}

const RESULTADO_DECISIVO = new Set(['APPROVED', 'CONDITIONAL', 'REJECTED']);
/** Última análise de cada banco (`rows` do mais novo pro mais antigo). Uma releitura (CONFERÊNCIA) que ainda está na fila, rodando, falhou ou não conseguiu ler NÃO esconde um
 *  resultado que já existia (Fabio 14/10: "mostra que falhou no Inter, sendo que foi aprovado no nome da Larissa"). Rodada nova de verdade (RUN) continua valendo. */
export function latestPerBank(rows: any[]): Record<string, any> {
  const temDecisivo = new Set(rows.filter((r) => RESULTADO_DECISIVO.has(r.status)).map((r) => r.bank));
  const jaEnviado = new Set(rows.filter((r) => r.status === 'SENT').map((r) => r.bank));
  const out: Record<string, any> = {};
  for (const a of rows) {
    if (out[a.bank]) continue;
    if (a.kind === 'CHECK' && !RESULTADO_DECISIVO.has(a.status) && temDecisivo.has(a.bank)) continue;
    if (a.kind === 'CHECK' && a.status === 'FAILED' && jaEnviado.has(a.bank)) continue; // leitura que falhou não esconde a proposta já enviada ("Em análise")
    out[a.bank] = a;
  }
  for (const a of rows) if (!out[a.bank]) out[a.bank] = a;
  // APROVAÇÃO NÃO SOME POR RODADA DE TESTE (Fabio 21/10: "mostrar a proposta aprovada a qual o cliente irá seguir — ele pediu 55 mil, foi recusada e o painel não mostra a aprovada"): se o banco já aprovou, uma rodada
  // MAIS NOVA que falhou ou foi reprovada em OUTRA proposta (valor/prazo/renda diferentes, "Não conformidade") não esconde a aprovação. Só a vira reprovação quando a MESMA proposta aprovada passa a reprovada
  // (o banco mudou de ideia). Rodada em andamento (na fila/rodando) continua aparecendo.
  const positivo = (st: string) => st === 'APPROVED' || st === 'CONDITIONAL';
  for (const bank of Object.keys(out)) {
    const cur = out[bank];
    if (positivo(cur.status) || cur.status === 'REQUESTED' || cur.status === 'RUNNING') continue;
    const ap = rows.find((r) => r.bank === bank && positivo(r.status) && r.approvedValue && !r.dryRun && r.source !== 'AI_SIM');
    if (!ap) continue;
    const virou = ap.proposalNumber && rows.some((r) => r.bank === bank && r.proposalNumber === ap.proposalNumber && r.status === 'REJECTED' && new Date(r.createdAt).getTime() > new Date(ap.createdAt).getTime());
    if (!virou) out[bank] = ap;
  }
  // CADASTRO DIVERGENTE (Fabio 25/10: "preciso que a análise do Santander apareça Cadastro Divergente, ao invés de Falhou"): o Santander aceita a proposta mas devolve na lista o status "Cadastro Divergente"
  // (nome/CPF/nascimento não batem) — a extensão grava "não reconheci o status…: Cadastro Divergente" e as conferências seguintes dizem só "não achei o cliente na lista". A tela mostra o rótulo
  // "Cadastro divergente" enquanto a ÚLTIMA rodada (RUN) do banco foi divergente e nada decisivo ou mais novo veio depois.
  for (const bank of Object.keys(out)) {
    const cur = out[bank];
    if (RESULTADO_DECISIVO.has(cur.status) || cur.status === 'REQUESTED' && cur.kind === 'RUN') continue;
    if (cadastroDivergenteDoBanco(rows, bank)) out[bank] = { ...cur, cadDiv: true };
  }
  return out;
}

const RX_CAD_DIV = /cadastro\s+diverg/i;
/** A rodada mais recente (RUN) deste banco acusou "Cadastro Divergente" e nada decisivo/mais novo veio depois? `rows` do mais novo pro mais antigo. Pura (testável). */
export function cadastroDivergenteDoBanco(rows: { bank: string; kind?: string; status: string; detail?: string | null; conditions?: string | null; source?: string; createdAt: Date | string }[], bank: string): boolean {
  const doBanco = rows.filter((r) => r.bank === bank && r.source !== 'AI_SIM');
  const ultimaRun = doBanco.find((r) => (r.kind || 'RUN') === 'RUN');
  if (!ultimaRun || !RX_CAD_DIV.test(`${ultimaRun.detail || ''} ${ultimaRun.conditions || ''}`)) return false;
  const t = new Date(ultimaRun.createdAt).getTime();
  return !doBanco.some((r) => RESULTADO_DECISIVO.has(r.status) && new Date(r.createdAt).getTime() >= t);
}

const normName = (s: string) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const HOLDER_RE = /titular(?:\s+na\s+an[aá]lise)?\s*:\s*([^.(+;|\n]+?)\s*(?=[(+.;|\n]|$)/i;

/** "Titular na análise: Sandra Regina (2º participante: Silas…)." / "iniciando… — titular: Sandra + 2º participante: …" → "Sandra Regina". */
/** Documentos que o Santander pede pra seguir com o valor aprovado a menor — a extensão escreve `[DOCUMENTOS (perfil de renda X): a ; b]` no detalhe. */
export function parseDocumentosExigidos(detail?: string | null): { perfil: string; itens: string[] } | null {
  const m = /\[DOCUMENTOS(?:\s*\(perfil de renda ([^)]*)\))?:\s*([^\]]+)\]/i.exec(String(detail || ''));
  if (!m) return null;
  const itens = m[2].split(/\s*;\s*/).map((t) => t.trim()).filter(Boolean).map(friendlyDocName);
  return itens.length ? { perfil: (m[1] || '').trim().toLowerCase(), itens } : null;
}

/** "Declaração De Imposto De Renda Pessoa Física (IRPF) - Ultimo Exercício E Extrato…" → frase normal (IRPF continua maiúsculo). */
function friendlyDocName(t: string): string {
  const low = t.toLowerCase().replace(/\bultimo\b/g, 'último').replace(/\birpf\b/g, 'IRPF');
  return low.charAt(0).toUpperCase() + low.slice(1);
}

export function parseHolder(detail?: string | null): string | null {
  const m = HOLDER_RE.exec(String(detail || ''));
  const name = m ? m[1].trim() : '';
  return name.length >= 3 ? name : null;
}

/** Em nome de quem a análise foi feita: o que o texto da extensão diz; senão, o 2º participante quando a inversão está ligada
 *  pra esse banco; senão null (titular normal). */
async function resolveHolder(db: Db, leadId: string, bank: string, detail?: string | null): Promise<string | null> {
  const parsed = parseHolder(detail);
  if (parsed) return parsed;
  const [lead, ov] = await Promise.all([
    db.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }),
    db.creditOverride.findFirst({ where: { leadId, bank }, select: { data: true } }),
  ]);
  const p2 = String(((lead?.customFields || {}) as Record<string, any>).participante_2 || '').trim();
  return ov && (ov.data as any)?.inverter === true && p2 ? p2 : null;
}

const brNumber = (t: string) => Number(t.replace(/\./g, '').replace(',', '.'));

/** Frases "ATENÇÃO: …" idênticas repetidas pela extensão (tentativas de ajuste de valor) viram uma só, com "(×N)". Pura. */
export function dedupeAvisos(text: string): string {
  const t = String(text || '');
  const vezes = new Map<string, number>();
  for (const m of t.matchAll(/ATEN[ÇC][ÃA]O:.*?\.(?=\s|$)/g)) vezes.set(m[0], (vezes.get(m[0]) || 0) + 1);
  const vistos = new Set<string>();
  return t.replace(/ATEN[ÇC][ÃA]O:.*?\.(?=\s|$)\s*/g, (frase) => {
    const k = frase.trim();
    if (vistos.has(k)) return '';
    vistos.add(k);
    const n = vezes.get(k) || 1;
    return n > 1 ? `${k} (×${n}) ` : frase;
  });
}

/** O Credimorar devolve as condições do Santander como texto ("CONDIÇÕES — Santander: libera + R$ 150.000,00; prazo 120 Meses;
 *  1ª parcela R$ 3.735,50; última R$ 1.281,81; CET 22,96% a.a.; taxa efetiva 21,70% a.a.; …"). Aqui vira número (valor, prazo,
 *  parcelas, taxa) pra preencher a análise e, depois, o card. */
export function parseSantanderConditions(text: string): ResultFields {
  const t = String(text || '').replace(/\s+/g, ' ');
  const out: ResultFields = {};
  const liberado = /(?:valor\s+)?liberado\s*:?\s*R\$\s*([\d.]+,\d{2})/i.exec(t);
  const libera = liberado || /libera\s*\+?\s*R\$\s*([\d.]+,\d{2})/i.exec(t); if (libera) out.approvedValue = brNumber(libera[1]);
  const prazo = /prazo\s*(\d+)\s*meses/i.exec(t); if (prazo) out.termMonths = Number(prazo[1]);
  const p1 = /1[ªa]\s*parcela\s*R\$\s*([\d.]+,\d{2})/i.exec(t); if (p1) out.firstInstallment = brNumber(p1[1]);
  const pu = /[úu]ltima\s*R\$\s*([\d.]+,\d{2})/i.exec(t); if (pu) out.lastInstallment = brNumber(pu[1]);
  // Taxa MENSAL = taxa NOMINAL anual ÷ 12 (ex.: 19,80% a.a. → 1,65% a.m.), que acumulada em 12 meses dá a EFETIVA (1,0165^12 − 1 = 21,70% a.a.) — é a taxa de verdade cobrada por mês e a que se compara com
  // o "x% a.m." do Inter e de outros bancos. Dividir a efetiva por 12 (1,81%) SUPERESTIMA a mensal (22/10: o CRM passou a usar isso por engano e voltou). Sem a nominal, deriva da efetiva anual.
  const fmt = (n: number) => `${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}% a.m.`;
  const nominal = /taxa nominal\s*([\d.]+,\d{1,2})\s*%\s*a\.a\./i.exec(t);
  const efetiva = /taxa efetiva\s*([\d.]+,\d{1,2})\s*%\s*a\.a\./i.exec(t);
  if (nominal) out.rate = fmt(brNumber(nominal[1]) / 12);
  else if (efetiva) out.rate = fmt((Math.pow(1 + brNumber(efetiva[1]) / 100, 1 / 12) - 1) * 100);
  return out;
}

/** Nota automática no card quando a análise termina aprovada/reprovada. O formato de
 *  aprovada tem "aprovad…" e "R$ …" de propósito: approval-notice.service lê notas assim
 *  pra montar o texto "✅ Crédito aprovado! Resumo da proposta". */
export function analysisNote(a: { bank: string; status: string; detail?: string | null; dryRun?: boolean; holder?: string | null } & ResultFields): string {
  const label = BANKS[a.bank]?.label || a.bank;
  const test = a.dryRun ? ' [modo teste]' : '';
  const nome = a.holder ? ` 👤 Aprovado no nome de ${a.holder} (2º participante da proposta).` : '';
  if (a.status === 'APPROVED') {
    const parts = [
      `Banco: ${label}`,
      a.approvedValue ? `Valor aprovado: ${brl(a.approvedValue)}` : '',
      a.netValue ? `Valor líquido do contrato: ${brl(a.netValue)} (já descontados IOF, tarifa de cadastro e custas)` : '',
      a.termMonths ? `Prazo: ${a.termMonths} meses` : '',
      a.rate ? `Taxa: ${a.rate}${a.indexer && !new RegExp(a.indexer, 'i').test(a.rate) ? ` + ${a.indexer}` : ''}` : (a.indexer ? `Indexador: ${a.indexer}` : ''),
      a.firstInstallment ? `1ª parcela: ${brl(a.firstInstallment)}` : '',
      a.lastInstallment ? `Última parcela: ${brl(a.lastInstallment)}` : '',
      a.proposalNumber ? `Proposta nº ${a.proposalNumber}` : '',
    ].filter(Boolean);
    return `✅ Análise de crédito${test} — ${/aprovad[oa] a menor/i.test(a.detail || '') ? 'APROVADO A MENOR' : 'APROVADO'} no ${label}.${nome} ${parts.join(' · ')}${a.conditions ? `\nCondições: ${a.conditions}` : ''}${a.detail && !a.approvedValue ? `\n${a.detail}` : ''}`;
  }
  if (a.status === 'CONDITIONAL') {
    return `📄 Análise de crédito${test} — APROVADO CONDICIONAL no ${label}${a.proposalNumber ? ` (proposta nº ${a.proposalNumber})` : ''}: o banco pede documentação para seguir.${nome}${a.detail ? ` ${a.detail}` : ''}`;
  }
  return `❌ Análise de crédito${test} — REPROVADO no ${label}${a.proposalNumber ? ` (proposta nº ${a.proposalNumber})` : ''}.${a.detail ? ` ${a.detail}` : ''}`;
}

/** Pede a análise de N clientes em N bancos (`kind` RUN), ou só a CONFERÊNCIA do resultado de uma proposta já enviada
 *  (`kind` CHECK — a extensão acha o cliente pelo CPF na lista do portal; não cria proposta nova). Pedido de RUN para quem JÁ foi
 *  rodado nesse banco vira só uma CONSULTA da proposta (CHECK), a não ser que venha `force` (ex.: depois de ajustar valores). A extensão busca os pedidos (claimQueue). */
/** Idade (anos completos) a partir de "DD/MM/AAAA" ou "AAAA-MM-DD"; null se não der pra ler. */
export function ageOf(raw: unknown, now = new Date()): number | null {
  const t = String(raw ?? '').trim();
  const br = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const [d, m, y] = br ? [Number(br[1]), Number(br[2]), Number(br[3])] : iso ? [Number(iso[3]), Number(iso[2]), Number(iso[1])] : [0, 0, 0];
  if (!y || y < 1900) return null;
  let a = now.getFullYear() - y;
  if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) a--;
  return a;
}

/** Texto do motivo se NENHUM participante com nascimento conhecido está na faixa do Inter (18–69 anos); null = pode rodar. */
async function interAgeBlock(db: Db, leadId: string): Promise<string | null> {
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { name: true, customFields: true } });
  const cf = (lead?.customFields || {}) as Record<string, any>;
  const people = [
    { name: String(cf.participante_1 || lead?.name || ''), age: ageOf(cf.nascimento_1) },
    ...(cf.cpf_2 || cf.participante_2 ? [{ name: String(cf.participante_2 || '2º participante'), age: ageOf(cf.nascimento_2) }] : []),
  ];
  if (people.some((x) => x.age === null || (x.age >= 18 && x.age <= 69))) return null; // sem data de nascimento = não sabe; alguém na faixa = a extensão escolhe
  return `idade fora da faixa do Inter (18 a 69 anos): ${people.map((x) => `${x.name} (${x.age} anos)`).join(', ')}.`;
}

/** Santander/Credimorar: idade + prazo não pode passar de 80 anos (o portal recusa com "Não conformidade! … Prazo máximo para esse cliente é de N meses"; Nelson, 78 anos, 24/09/1948: 23 meses).
 *  Prazo máximo (meses) = 80 anos − idade em meses − 1. Com o prazo MÍNIMO do Home Equity (60 meses), ninguém com 75 anos ou mais passa. Texto do motivo se NENHUM participante com nascimento conhecido
 *  consegue ao menos 60 meses; null = pode rodar (sem nascimento = não sabe; alguém dentro = a extensão escolhe o titular). */
export function santanderMaxTermMonths(birth: unknown, now = new Date()): number | null {
  const t = String(birth ?? '').trim();
  const br = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const [d, m, y] = br ? [Number(br[1]), Number(br[2]), Number(br[3])] : iso ? [Number(iso[3]), Number(iso[2]), Number(iso[1])] : [0, 0, 0];
  if (!y || y < 1900) return null;
  let meses = (now.getFullYear() - y) * 12 + (now.getMonth() + 1 - m);
  if (now.getDate() < d) meses--;
  return 80 * 12 - meses - 1;
}
const PRAZO_MINIMO_HOME_EQUITY = 60;
type AgePerson = { name: string; age: number | null; max: number | null };

/** Santander e Creditas: idade + prazo ≤ 80 anos (Fabio 19/10: "a Creditas é a mesma regra do Santander").
 *  NÃO barra quem só tem prazo menor — a extensão roda com o MAIOR prazo que a idade permite ("sempre ajustar pra tentar aprovar"; Santander: prazo 172 pra quem tem 65 anos).
 *  Só barra (sem abrir o portal) quando NENHUM participante alcança nem o prazo mínimo do Home Equity (60 meses). Sem nascimento = não sabe, roda. */
export function ageTermBlockText(bankLabel: string, people: AgePerson[]): string | null {
  if (people.some((x) => x.max === null || x.max >= PRAZO_MINIMO_HOME_EQUITY)) return null;
  return `idade + prazo acima de 80 anos no ${bankLabel} (o prazo mínimo é ${PRAZO_MINIMO_HOME_EQUITY} meses): ${people.map((x) => `${x.name} (${x.age} anos: prazo máximo ${x.max} meses)`).join(', ')}.`;
}

async function agePeople(db: Db, leadId: string): Promise<AgePerson[]> {
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { name: true, customFields: true } });
  const cf = (lead?.customFields || {}) as Record<string, any>;
  return [
    { name: String(cf.participante_1 || lead?.name || ''), age: ageOf(cf.nascimento_1), max: santanderMaxTermMonths(cf.nascimento_1) },
    ...(cf.cpf_2 || cf.participante_2 ? [{ name: String(cf.participante_2 || '2º participante'), age: ageOf(cf.nascimento_2), max: santanderMaxTermMonths(cf.nascimento_2) }] : []),
  ];
}

const ageTermBlock = async (db: Db, leadId: string, bankLabel: string) => ageTermBlockText(bankLabel, await agePeople(db, leadId));

/** CREDITAS: o próprio portal recusa na tela "O Pagador não pode ter mais de 75 anos" e "O cônjuge não pode ter mais de 75 anos" (José Roberto 76/74 e Maria Celma, 20/10): vale para CADA pessoa da proposta
 *  (pagador + cônjuge), então um participante acima de 75 já barra a Creditas — trocar o titular não resolve. Sem nascimento = não sabe, roda. */
export function creditasAgeBlockText(people: AgePerson[]): string | null {
  const velhos = people.filter((x) => x.age !== null && x.age > 75);
  if (!velhos.length) return null;
  return `a Creditas não aceita participante com mais de 75 anos (pagador e cônjuge): ${velhos.map((x) => `${x.name} (${x.age} anos)`).join(', ')}.`;
}
const creditasAgeBlock = async (db: Db, leadId: string) => { const people = await agePeople(db, leadId); return creditasAgeBlockText(people) || ageTermBlockText('Creditas', people); };

/** TITULAR PELA IDADE (Fabio 19/10): se o titular do banco NÃO pode rodar ali (Inter: fora de 18–69; Santander/Creditas: nem o prazo mínimo) e o 2º participante pode, inverte antes de rodar
 *  (as extensões não escolhem sozinhas: rodava o titular de 72 anos e o portal recusava). Banco que já aprovou alguém não é mexido (vale o titular da aprovação). */
export function holderNeedsSwap(first: AgePerson, second: AgePerson, ok: (x: AgePerson) => boolean): boolean {
  return !ok(first) && ok(second);
}
async function alignHolderByAge(db: Db, accountId: string, leadId: string, bank: 'INTER' | 'CREDIMORAR' | 'CREDITAS'): Promise<void> {
  const approved = await db.creditAnalysis.findFirst({ where: { leadId, bank, dryRun: false, status: { in: ['APPROVED', 'CONDITIONAL'] } }, select: { id: true } });
  if (approved) return;
  const people = await agePeople(db, leadId);
  if (people.length < 2) return;
  const ov = await db.creditOverride.findFirst({ where: { leadId, bank }, select: { data: true } });
  const inverted = (ov?.data as any)?.inverter === true;
  const ok = (x: AgePerson) => bank === 'INTER' ? (x.age === null || (x.age >= 18 && x.age <= 69)) : (x.max === null || x.max >= PRAZO_MINIMO_HOME_EQUITY);
  const [first, second] = inverted ? [people[1], people[0]] : [people[0], people[1]];
  if (!holderNeedsSwap(first, second, ok)) return;
  await setOverrides(db, { accountId, leadId, banks: [bank], data: { inverter: !inverted }, merge: true, userName: 'Análise automática (idade)' }).catch(() => {});
}

/** SEMPRE TENTAR NO MESMO CPF QUE APROVOU O CLIENTE (Fabio 15/10): ao rodar de novo (valor novo, saldo devedor…), cada banco que já aprovou alguém usa de titular o MESMO CPF dessa aprovação —
 *  senão a nova análise vai pro outro participante e perde a aprovação que já existia. Ajusta a inversão de titular por banco; só escreve (e anota) quando muda. */
async function alignHoldersWithApproval(db: Db, accountId: string, leadId: string): Promise<void> {
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cf = (lead?.customFields || {}) as Record<string, any>;
  const dig = (v: unknown) => String(v ?? '').replace(/\D/g, '');
  const cpf1 = dig(cf.cpf_1), cpf2 = dig(cf.cpf_2);
  if (cpf1.length !== 11 || cpf2.length !== 11 || cpf1 === cpf2) return;
  for (const bank of BANK_KEYS) {
    const ap = await db.creditAnalysis.findFirst({ where: { leadId, bank, dryRun: false, status: { in: ['APPROVED', 'CONDITIONAL'] }, holderCpf: { not: null } }, orderBy: { createdAt: 'desc' }, select: { holderCpf: true } });
    const holder = dig(ap?.holderCpf);
    if (holder !== cpf1 && holder !== cpf2) continue;
    const ov = await db.creditOverride.findFirst({ where: { leadId, bank }, select: { data: true } });
    const invertido = (ov?.data as any)?.inverter === true;
    const querInvertido = holder === cpf2;
    if (invertido === querInvertido) continue;
    await setOverrides(db, { accountId, leadId, banks: [bank], data: { inverter: querInvertido }, merge: true, userName: 'Análise automática (mesmo CPF da aprovação)' }).catch(() => {});
  }
}

/** Proposta registrada SÓ no card (campos "Instituição" + "Nº da proposta"), sem nenhuma análise no CRM — cliente aprovado antes da aba Análise de Crédito ou tocado à mão (Fabio 26/10, Pedro Francisco).
 *  Devolve o banco e o número pra uma CONFERÊNCIA ler a proposta no portal. Pura (testável). */
export function propostaDoCard(cf: Record<string, any>): { bank: string; numero: string } | null {
  const numero = String(cf?.num_proposta || '').replace(/\D/g, '');
  const inst = String(cf?.instituicao || '');
  if (numero.length < 5 || !inst) return null;
  const hits = [/inter/i.test(inst) && 'INTER', /creditas/i.test(inst) && 'CREDITAS', /santander|credimorar/i.test(inst) && 'CREDIMORAR'].filter(Boolean) as string[];
  return hits.length === 1 ? { bank: hits[0], numero } : null;
}

export async function createRequests(db: Db, p: { accountId: string; userId?: string; leadIds: string[]; banks: string[]; dryRun: boolean; kind?: 'RUN' | 'CHECK'; force?: boolean; source?: string; alignApproval?: boolean; queueIfBusy?: boolean }) {
  const wantedKind = p.kind === 'CHECK' ? 'CHECK' : 'RUN';
  const banks = p.banks.filter((b) => BANK_KEYS.includes(b) && (wantedKind === 'RUN' || CHECK_BANKS.includes(b)));
  const leads = await db.lead.findMany({ where: { id: { in: p.leadIds }, accountId: p.accountId }, select: { id: true } });
  let created = 0, skipped = 0, queuedBehind = 0;
  const consulted: string[] = [];
  for (const l of leads) {
    const createdBefore = created;
    const cfPedido = ((await db.lead.findUnique({ where: { id: l.id }, select: { customFields: true } }))?.customFields || {}) as Record<string, any>;
    const pedidoNaRodada = Number(String(cfPedido.valor_credito ?? '').replace(/[^\d.]/g, '')) || null; // card no momento do pedido
    // "Sempre tentar no MESMO CPF que aprovou o cliente" vale SÓ quando o CLIENTE pede a nova análise (outro valor/prazo, saldo devedor corrigido, proposta preenchida de novo) — Fabio 21/10.
    // Rodada manual da equipe (botão de um participante, ajuste) e automáticas (cascata, retentativa, cobrança) respeitam o titular que já está escolhido; antes a regra trocava o titular
    // por cima do clique ("pedi o 1º participante e puxou pro nome do 2º").
    if (wantedKind === 'RUN' && !p.dryRun && p.force && p.alignApproval) await alignHoldersWithApproval(db, p.accountId, l.id).catch(() => {});
    for (const bank of banks) {
      const open = await db.creditAnalysis.findFirst({
        where: { leadId: l.id, bank, status: { in: ACTIVE }, updatedAt: { gt: new Date(Date.now() - STALE_ACTIVE_MS) } },
        select: { id: true, kind: true, status: true },
      });
      if (open) {
        // "Rodar de novo" clicado por uma PESSOA com a extensão ocupada (Fabio 21/10): em vez de descartar o pedido ("já tem uma análise rodando"), ele entra NA FILA e roda quando a extensão terminar.
        // Só rodada manual (queueIfBusy): as automáticas continuam sem duplicar proposta. Pedido de rodar já esperando na fila, não duplica; conferência marcada vira a nova rodada.
        if (!(wantedKind === 'RUN' && p.queueIfBusy && !p.dryRun)) { skipped++; continue; }
        const jaNaFila = await db.creditAnalysis.findFirst({ where: { leadId: l.id, bank, kind: 'RUN', status: 'REQUESTED', dryRun: false }, select: { id: true } });
        if (jaNaFila) { skipped++; continue; }
        if (open.kind === 'CHECK' && open.status === 'REQUESTED') {
          await db.creditAnalysis.updateMany({ where: { id: open.id, status: 'REQUESTED' }, data: { status: 'CHECK', finishedAt: new Date(), detail: 'Conferência encerrada: nova rodada pedida por uma pessoa.' } });
        } else if (open.status === 'RUNNING') queuedBehind++; // a extensão está nesse banco agora: o pedido espera ela terminar
      }
      // Já foi rodada nesse banco? Então só consulta a proposta (não cria de novo), a menos que seja pra rodar de novo de propósito.
      let kind: 'RUN' | 'CHECK' = wantedKind;
      if (kind === 'RUN' && !p.force && CHECK_BANKS.includes(bank)) {
        const done = await db.creditAnalysis.findFirst({ where: { leadId: l.id, bank, dryRun: false, status: { in: REAL_SENT }, createdAt: { gt: new Date(Date.now() - 60 * 86_400_000) } }, select: { id: true } });
        if (done) { kind = 'CHECK'; if (!consulted.includes(bank)) consulted.push(bank); }
      }
      // Idade fora da faixa do Inter (18 a 69 anos — o portal recusa com "Parâmetro inválido", Admir 15/10): se NENHUM participante do card está na faixa, nem abre fila: NÃO RODEI direto.
      // (Com 1 participante na faixa a extensão decide quem é o titular — não barra aqui.)
      if ((bank === 'INTER' || bank === 'CREDIMORAR' || bank === 'CREDITAS') && kind === 'RUN' && !p.dryRun) await alignHolderByAge(db, p.accountId, l.id, bank).catch(() => {});
      if (bank === 'INTER' && kind === 'RUN' && !p.dryRun) {
        const idade = await interAgeBlock(db, l.id);
        if (idade) {
          await db.creditAnalysis.create({ data: { accountId: p.accountId, leadId: l.id, bank, status: 'FAILED', kind, requestedValue: pedidoNaRodada, detail: `NÃO RODEI: ${idade}`, dryRun: false, source: p.source || 'EXTENSION', requestedById: p.userId || null, finishedAt: new Date() } });
          created++;
          continue;
        }
      }
      if ((bank === 'CREDIMORAR' || bank === 'CREDITAS') && kind === 'RUN' && !p.dryRun) {
        const idade = bank === 'CREDITAS' ? await creditasAgeBlock(db, l.id) : await ageTermBlock(db, l.id, 'Santander');
        if (idade) {
          await db.creditAnalysis.create({ data: { accountId: p.accountId, leadId: l.id, bank, status: 'FAILED', kind, requestedValue: pedidoNaRodada, detail: `NÃO RODEI: ${idade}`, dryRun: false, source: p.source || 'EXTENSION', requestedById: p.userId || null, finishedAt: new Date() } });
          created++;
          continue;
        }
      }
      const prev = kind === 'CHECK' ? await db.creditAnalysis.findFirst({ where: { leadId: l.id, bank, proposalNumber: { not: null } }, orderBy: { createdAt: 'desc' }, select: { proposalNumber: true, holderCpf: true, holderName: true, requestedValue: true } }) : null;
      const doCard = kind === 'CHECK' && !prev?.proposalNumber ? propostaDoCard(cfPedido) : null; // sem análise com número: usa a proposta anotada no card
      const prevNumber = prev?.proposalNumber || (doCard && doCard.bank === bank ? doCard.numero : null);
      await db.creditAnalysis.create({ data: { accountId: p.accountId, leadId: l.id, bank, status: 'REQUESTED', kind, requestedValue: kind === 'CHECK' ? (prev?.requestedValue ?? null) : pedidoNaRodada, proposalNumber: prevNumber, holderCpf: prev?.holderCpf || null, holderName: prev?.holderName || null, dryRun: kind === 'CHECK' ? false : p.dryRun, source: p.source || 'EXTENSION', requestedById: p.userId || null } });
      created++;
    }
    // Guarda o crédito pedido NESTA rodada (15/10, Rafaela): se o cliente preencher a proposta de novo com OUTRO valor, o resultado antigo não vale e a análise é refeita (campaign-detection).
    if (wantedKind === 'RUN' && !p.dryRun && created > createdBefore) {
      const f = await db.lead.findUnique({ where: { id: l.id }, select: { customFields: true } });
      const cf = { ...((f?.customFields || {}) as Record<string, any>) };
      const v = Number(cf.valor_credito);
      if (v > 0) { cf._lastRunValue = v; await db.lead.update({ where: { id: l.id }, data: { customFields: cf as any } }).catch(() => {}); }
    }
  }
  return { created, skipped, queuedBehind, consulted, banks, leads: leads.length, kind: wantedKind };
}

/** A extensão do banco pergunta: "tem pedido pra mim?". Marca como RUNNING o que entregar. Pedidos de só conferir
 *  (CHECK) só vão pra extensão que avisa saber fazer isso (`caps` inclui "check") — uma versão antiga trataria
 *  como pedido normal e criaria proposta duplicada no banco. */
/** Qual cliente a fila libera agora (Fabio 14/10: "um por um", na ORDEM DE ENTRADA NA PRÉ-ANÁLISE — `leadOrderAt`): o que já tem análise RODANDO (termina primeiro);
 *  sem nenhum rodando, o que entrou há mais tempo entre os que têm pedido esperando. Pura (testável). Só entram pedidos de RODAR (RUN) de pessoa/automático:
 *  conferências (CHECK) e leituras da IA da conversa não travam nem são travadas. Pedido esperando há mais de 30 min (extensão fora do ar) não segura a fila. */
export function pickActiveLead(open: Array<{ leadId: string; bank?: string; status: string; requestedAt: Date; leadOrderAt: Date }>, now = Date.now(), alive: (bank?: string) => boolean = () => false): string | null {
  // Pedido velho só deixa de segurar a fila se a extensão do banco dele sumiu: se ela está viva, ele esperou na fila de verdade (atrás de outro cliente) e NÃO pode
  // perder a vez por isso (Mauricio Rodrigues esperava desde 15:47 e foi ultrapassado por um card que entrou depois, 14/10).
  const vivos = open.filter((o) => o.status === 'RUNNING' || now - o.requestedAt.getTime() < 30 * 60_000 || alive(o.bank));
  if (!vivos.length) return null;
  const byAge = (a: { leadOrderAt: Date }, b: { leadOrderAt: Date }) => a.leadOrderAt.getTime() - b.leadOrderAt.getTime();
  const rodando = vivos.filter((o) => o.status === 'RUNNING').sort(byAge);
  return (rodando[0] || [...vivos].sort(byAge)[0]).leadId;
}

// A extensão de cada banco consulta a fila de ~1 em 1 min: quem consultou nos últimos 3 min está viva. Logo depois de o servidor reiniciar ninguém consultou ainda: vale como viva.
const BOOT_AT = Date.now();
const lastPollAt = new Map<string, number>();
const bankAlive = (accountId: string, bank?: string) => !!bank && (Date.now() - BOOT_AT < 5 * 60_000 || Date.now() - (lastPollAt.get(`${accountId}:${bank}`) || 0) < 3 * 60_000);

/** Card PAUSADO pelo botão da tela (Fabio 14/10, "pausar apenas aquele cliente"): customFields._autoPaused.
 *  ATENÇÃO (15/10): o filtro por caminho JSON do Prisma (`path: ['_autoPaused'], equals: true`) devolve NULL — e não "falso" — pra card que NUNCA teve essa chave, e dentro de um NOT
 *  isso tirava da fila TODO pedido automático de card não pausado (Maria, Arlan, Gabriela esperando 4 h). Por isso os ids pausados/travados vêm de SQL (null-safe) e entram como `leadId in [...]`. */
const pausedLeadIds = async (db: Db, accountId: string) => (await db.$queryRaw<{ id: string }[]>`SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND "customFields"->>'_autoPaused' = 'true'`).map((r) => r.id);
/** Fora da fila: pedido AUTOMÁTICO (sem requestedById) de card pausado. O que uma PESSOA pediu na tela (Rodar/Conferir) continua valendo. */
const notPausedAuto = (pausedIds: string[]) => ({ NOT: { AND: [{ requestedById: null }, { leadId: { in: pausedIds } }] } });
/** TRAVA da consulta do Creditas (Fabio 15/10): a Creditas pediu a Autorização SCR Bacen assinada e o cliente ainda não devolveu/enviamos — ler o portal a cada 10 min não adianta.
 *  As conferências AUTOMÁTICAS do Creditas desse card ficam paradas até o SCR ser enviado à Creditas; "Conferir resultado" pedido por uma pessoa passa. */
const scrLockedLeadIds = async (db: Db, accountId: string) => (await db.$queryRaw<{ id: string }[]>`SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND "customFields"->'_scrCreditas'->>'status' IN ('PENDING', 'ASKED', 'SENDING')`).map((r) => r.id);
const notScrLocked = (lockedIds: string[]) => ({ NOT: { AND: [{ bank: 'CREDITAS' }, { kind: 'CHECK' }, { requestedById: null }, { leadId: { in: lockedIds } }] } });

export async function claimQueue(db: Db, p: { accountId: string; bank: string; limit?: number; caps?: string[] }) {
  if (!BANK_KEYS.includes(p.bank)) return [];
  lastPollAt.set(`${p.accountId}:${p.bank}`, Date.now());
  const canCheck = !!p.caps?.includes('check');
  // Em PAUSA GERAL só sai da fila o que uma pessoa pediu (requestedById): reconferências e pedidos automáticos ficam parados.
  await expireStuck(db, { accountId: p.accountId }); // execução parada não segura a fila: aqui (e não só ao abrir a tela) é o que a destrava
  const liberado = !!(await liberadoAte(db, p.accountId));
  if (foraDoHorario() && !liberado) return []; // extensões paradas fora de 07h–22h: a fila espera (inclusive o que uma pessoa pediu) — salvo liberação manual
  const paused = !!(await db.creditAutoSetting.findUnique({ where: { accountId: p.accountId }, select: { paused: true } }))?.paused;
  const NOT_PAUSED_AUTO = notPausedAuto(await pausedLeadIds(db, p.accountId));
  // Fora do horário de trabalho (07h–22h, Brasília) NADA roda sozinho (Fabio 16/10: "parece que os sistemas não funcionam de madrugada"): as rodadas e conferências automáticas esperam até as 7h;
  // só o que uma PESSOA pediu na tela sai da fila. O que estiver em execução às 21h termina normalmente.
  const noturno = foraDoHorario() && !liberado;
  const NOT_SCR_LOCKED = notScrLocked(await scrLockedLeadIds(db, p.accountId));
  // "Um cliente por vez": os pedidos de RODAR de outros clientes esperam o cliente atual terminar em todos os bancos.
  const abertos = await db.creditAnalysis.findMany({
    where: { accountId: p.accountId, kind: 'RUN', status: { in: ['REQUESTED', 'RUNNING'] }, source: { notIn: ['AI', 'AI_SIM'] }, OR: [{ notBefore: null }, { notBefore: { lte: new Date() } }], ...NOT_PAUSED_AUTO },
    select: { leadId: true, bank: true, status: true, requestedAt: true, lead: { select: { createdAt: true, stageEnteredAt: true, status: true, stage: { select: { name: true } } } } },
  });
  // Ordem da fila = quando o card ENTROU na Pré-Análise (card que está nela: stageEnteredAt); fora dela (ex.: card rodado à mão em outra etapa), a data de criação.
  const ordem = (l?: { createdAt: Date; stageEnteredAt: Date | null; status: string; stage: { name: string } | null } | null) =>
    (l && l.status === 'OPEN' && /^pré-an/i.test(l.stage?.name || '') && l.stageEnteredAt) || l?.createdAt || new Date(0);
  // "Um cliente por vez" ignora o pedido de banco que está esperando LOGIN: senão o cliente preso nele segura a fila dos outros (27/10).
  const paraPick = (lista: typeof abertos) => lista.filter((a) => !loginNeededFor(p.accountId, a.bank)).map((a) => ({ leadId: a.leadId, bank: a.bank, status: a.status, requestedAt: a.requestedAt, leadOrderAt: ordem(a.lead) }));
  let ativo = pickActiveLead(paraPick(abertos), Date.now(), (b) => bankAlive(p.accountId, b));
  // 27/10 (madrugada parada): o cliente da vez (Welma, só com pedido no Inter) segurava a Creditas, que não tinha nada dele pra fazer — e o Inter não pegava. Se o cliente da vez NÃO tem
  // pedido de rodar neste banco, o banco atende o próximo da fila que tem (a trava do navegador continua garantindo uma extensão por vez). Fabio: "não pode travar a fila por conta de um".
  if (ativo && !abertos.some((a) => a.leadId === ativo && a.bank === p.bank && a.status === 'REQUESTED')) {
    const doBanco = pickActiveLead(paraPick(abertos.filter((a) => a.bank === p.bank)), Date.now(), (b) => bankAlive(p.accountId, b));
    if (doBanco) ativo = doBanco;
  }
  const rows = await db.creditAnalysis.findMany({
    where: {
      accountId: p.accountId, bank: p.bank, status: 'REQUESTED', ...(canCheck ? {} : { kind: 'RUN' }),
      AND: [
        ...(ativo ? [{ OR: [{ kind: 'CHECK' }, { source: { in: ['AI', 'AI_SIM'] } }, { leadId: ativo }] }] : []),
        { OR: [{ notBefore: null }, { notBefore: { lte: new Date() } }] },
        NOT_PAUSED_AUTO,
        NOT_SCR_LOCKED,
        // Em pausa geral: só o pedido de pessoa; a leitura (CHECK, só leitura) pedida pela IA da conversa também passa.
        ...(paused ? [{ OR: [{ requestedById: { not: null } }, { source: 'AI', kind: 'CHECK' }] }] : []),
        ...(noturno ? [{ requestedById: { not: null } }] : []),
      ],
    },
    orderBy: { requestedAt: 'asc' }, take: p.limit || 3,
    select: { id: true, leadId: true, dryRun: true, kind: true, proposalNumber: true, requestedAt: true, lead: { select: { name: true } } },
  });
  const claimed: typeof rows = [];
  for (const r of rows) {
    const u = await db.creditAnalysis.updateMany({ where: { id: r.id, status: 'REQUESTED' }, data: { status: 'RUNNING', startedAt: new Date() } });
    if (u.count === 1) claimed.push(r);
  }
  return claimed.map((r) => ({ id: r.id, leadId: r.leadId, leadName: r.lead?.name || '', dryRun: r.dryRun, kind: r.kind, proposalNumber: r.proposalNumber, requestedAt: r.requestedAt }));
}

/** O nome do titular da análise só importa pro cliente quando NÃO é o do 1º participante do card (ex.: inversão). */
async function holderIfSecond(db: Db, leadId: string, holderName?: string | null): Promise<string | null> {
  if (!holderName) return null;
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { name: true, customFields: true } });
  const main = String(((lead?.customFields || {}) as Record<string, any>).participante_1 || lead?.name || '');
  // Nome do portal costuma vir abreviado ("Rafaela Andrade" x "Rafaela Aparecida de Andrade"): mesma pessoa se o 1º e o último nome batem (antes virava "2º participante" sem existir 2º).
  const t = (x: string) => normName(x).split(' ').filter((w) => w && !['de', 'da', 'do', 'dos', 'das', 'e'].includes(w));
  const a = t(holderName), b = t(main);
  return a.length && b.length && a[0] === b[0] && a[a.length - 1] === b[b.length - 1] ? null : (normName(holderName) !== normName(main) ? holderName : null);
}

/** O resultado de um banco MUDOU para o mesmo participante (aprovou e depois reprovou com o valor alterado — ou o contrário): fica gravado numa anotação do card (Fabio 15/10). */
async function noteVerdictFlip(db: Db, row: { id: string; leadId: string; bank: string; status: string; holderName?: string | null; holderCpf?: string | null; approvedValue?: number | null; netValue?: number | null; requestedValue?: number | null; dryRun: boolean; createdAt: Date }): Promise<void> {
  const positivo = (st: string) => st === 'APPROVED' || st === 'CONDITIONAL';
  if (row.dryRun || !(positivo(row.status) || row.status === 'REJECTED')) return;
  const norm1 = (t?: string | null) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().split(/\s+/)[0] || '';
  const mesmo = (r: { holderName?: string | null; holderCpf?: string | null }) => (row.holderCpf && r.holderCpf ? row.holderCpf === r.holderCpf : norm1(row.holderName) === norm1(r.holderName));
  const antes = await db.creditAnalysis.findMany({ where: { leadId: row.leadId, bank: row.bank, dryRun: false, id: { not: row.id }, status: { in: ['APPROVED', 'CONDITIONAL', 'REJECTED'] }, createdAt: { lt: row.createdAt } }, orderBy: { createdAt: 'desc' }, take: 8 });
  const ant = antes.find(mesmo);
  if (!ant || positivo(ant.status) === positivo(row.status)) return;
  const brlN = (n?: number | null) => (n ? n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '—');
  const dia = (d: Date) => d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
  const rotulo = (r: { status: string; approvedValue?: number | null; netValue?: number | null }) => (positivo(r.status) ? `APROVADO ${brlN(r.netValue || r.approvedValue)}` : 'REPROVADO');
  const quem = row.holderName ? ` no nome de ${row.holderName}` : '';
  const banco = BANKS[row.bank]?.label || row.bank;
  await db.note.create({ data: { leadId: row.leadId, type: 'COMMENT', content: `🔁 ${banco}${quem}: o resultado MUDOU. Antes: ${rotulo(ant)} (pedido ${brlN(ant.requestedValue)}, ${dia(ant.createdAt)}) → agora: ${rotulo(row)} (pedido ${brlN(row.requestedValue)}, ${dia(row.createdAt)}). O resultado anterior continua registrado na aba Análise de Crédito (Resultados anteriores).` } });
}


/** Card que a própria análise FECHOU como reprovado/desqualificado (Perdidos) e depois um banco APROVOU (rodada refeita — prazo máximo, novo valor, troco…): reabre sozinho (Fabio 21/10, Paulino:
 *  "se o cliente aprovar, o CRM precisa alterar o card pra Aguardando Documentação e encaminhar a proposta de aprovação"). Volta pra Pré-Análise do funil de vendas do setor e deixa o fluxo normal fazer o resto:
 *  o aviso de aprovação (com IA do card ligada) manda a proposta e MOVE pra Aguardando Documentação. Só mexe em card perdido por reprovação/desqualificação — nunca no que a equipe marcou Perdido por outro motivo. */
async function reabrirSeAprovouDepoisDaNegativa(db: Db, row: { leadId: string; bank: string; dryRun: boolean }): Promise<void> {
  if (row.dryRun) return;
  const lead = await db.lead.findUnique({ where: { id: row.leadId }, select: { id: true, name: true, status: true, lostReason: true, customFields: true, pipeline: { select: { departmentId: true, department: { select: { name: true } } } } } });
  if (!lead || lead.status !== 'LOST') return;
  if (!/reprov|desqualific|n[aã]o aprov/i.test(lead.lostReason || '')) return;
  if (!/home equity/i.test(lead.pipeline?.department?.name || '')) return;
  const sales = await db.pipeline.findFirst({ where: { departmentId: lead.pipeline!.departmentId, name: { contains: 'Vendas', mode: 'insensitive' } }, select: { id: true, name: true, stages: { orderBy: { order: 'asc' }, select: { id: true, name: true } } } });
  const pre = sales?.stages.find((st) => /^pr[ée]-an/i.test(st.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '')) || /^pre-an/i.test(st.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '')));
  if (!sales || !pre) { await db.note.create({ data: { leadId: lead.id, type: 'COMMENT', content: `✅ ${BANKS[row.bank]?.label || row.bank} APROVOU depois da negativa, mas não achei a Pré-Análise do funil de vendas pra reabrir o card: reabra e avise o cliente.` } }).catch(() => {}); return; }
  const cf = { ...((lead.customFields || {}) as Record<string, any>) };
  for (const k of ['_noticeAt', '_noticeKind', '_rejHeldAt', '_rejDecision', '_rejDecisionBy', '_rejQuestionAt', '_autoCloseAfterNotice', '_autoCloseTriedAt', '_autoNoticeSig', '_autoNoticeAt', '_autoHeldSig']) delete cf[k];
  cf._reopenedOnApproval = new Date().toISOString();
  if (!cf._autoStartedAt) cf._autoStartedAt = new Date().toISOString();
  await db.lead.update({ where: { id: lead.id }, data: { status: 'OPEN', archived: false, lostReason: null, rejectedAt: null, pipelineId: sales.id, stageId: pre.id, stageEnteredAt: new Date(), customFields: cf as any } });
  await db.note.create({ data: { leadId: lead.id, type: 'STAGE_CHANGE', content: `Movido do funil "Perdidos" para "${sales.name}" (${pre.name}) — ${BANKS[row.bank]?.label || row.bank} aprovou depois da negativa` } }).catch(() => {});
  await db.note.create({ data: { leadId: lead.id, type: 'COMMENT', content: `🔓 Card REABERTO sozinho: ${BANKS[row.bank]?.label || row.bank} APROVOU depois de o cliente ter recebido a negativa. Voltou pra "${pre.name}"; o aviso da aprovação (com a proposta) sai pelo fluxo normal e leva o card pra Aguardando Documentação — com a IA do card ligada; senão use o botão "Avisar cliente".` } }).catch(() => {});
  try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount((await db.lead.findUnique({ where: { id: lead.id }, select: { accountId: true } }))!.accountId, { title: '🔓 Card reaberto: aprovou', body: `${lead.name}: ${BANKS[row.bank]?.label || row.bank} aprovou depois da negativa`, leadId: lead.id }).catch(() => {}); } catch { /* push é só aviso */ }
}

/** Santander "Ação pendente — Contatar Consultor" (Fabio 20/10, Luiz Fernando): a proposta NÃO passou na análise automática e o banco liberou a ANÁLISE MANUAL. A extensão escolhe "Análise manual" e lê os
 *  documentos que o portal pede (marcador "ANÁLISE MANUAL ABERTA" + "[DOCUMENTOS (perfil de renda X): a ; b]" no detalhe). Aqui o CRM avisa a equipe e PEDE os documentos ao cliente, explicando que não passou
 *  na análise automática. O "Enviar" no portal é SEMPRE manual (regra do Fabio, confirmada 20/10). Uma vez por proposta; se o cliente não pôde ser avisado agora (IA do card desligada, janela de 24 h fechada, fora das 07h–21h),
 *  tenta de novo na próxima leitura da extensão. */
const SANTANDER_MANUAL = /AN[ÁA]LISE MANUAL ABERTA/i;
const docDoPortal = (t: string): string => {
  const x = t.replace(/\s*\(obrigat[oó]rio\)\s*$/i, '').trim();
  if (/holerite/i.test(x)) return 'Os 3 últimos holerites (contracheques)';
  if (/irpf|imposto de renda/i.test(x)) return 'Declaração de Imposto de Renda (IRPF) do último exercício + extrato da conta corrente dos últimos 3 meses';
  return x;
};
export function santanderManualClientText(nome: string | null, saudar: boolean, itens: string[]): string {
  const lista = itens.length ? itens : ['Os documentos de comprovação de renda'];
  return `${saudar ? `Oi${nome ? `, ${nome}` : ''}! ` : ''}Sobre o seu crédito: a proposta não passou na análise automática do Santander, mas o banco liberou a *análise manual* (feita por um analista), que é o caminho pra conseguir uma resposta. Pra encaminhar ao banco, preciso que você me envie por aqui:\n${lista.map((i) => `• ${i}`).join('\n')}\n\nAssim que eu receber, encaminho ao banco e te aviso o retorno. 😊`;
}
async function santanderManualFlow(db: Db, row: { leadId: string; bank: string; dryRun: boolean; detail?: string | null; proposalNumber?: string | null; accountId: string }): Promise<void> {
  if (row.dryRun || row.bank !== 'CREDIMORAR' || !SANTANDER_MANUAL.test(row.detail || '')) return;
  const lead = await db.lead.findUnique({ where: { id: row.leadId }, select: { id: true, name: true, accountId: true, aiAutoReplyActive: true, status: true, customFields: true } });
  if (!lead || lead.status !== 'OPEN') return;
  const cf = { ...((lead.customFields || {}) as Record<string, any>) };
  const numero = row.proposalNumber || (/proposta\s+(\d{6,})/i.exec(row.detail || '') || [])[1] || 'sem-numero';
  const st = (cf._santanderManual || {}) as { proposta?: string; teamAt?: string; askedAt?: string };
  if (st.proposta === numero && st.askedAt) return; // já pedi os documentos ao cliente desta proposta
  const itens = (parseDocumentosExigidos(row.detail)?.itens || []).map(docDoPortal);
  const salvar = async (patch: Record<string, any>) => {
    const fresh = await db.lead.findUnique({ where: { id: lead.id }, select: { customFields: true } });
    const c = { ...((fresh?.customFields || {}) as Record<string, any>) };
    c._santanderManual = { ...(c._santanderManual || {}), proposta: numero, ...patch };
    await db.lead.update({ where: { id: lead.id }, data: { customFields: c as any } });
  };
  const { inNoticeWindow, whatsappWindowOpen, conversationActive } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
  const nome = callableFirstName(cf.falando_com, cf.participante_1, lead.name) || null;
  const texto = santanderManualClientText(nome, !(await conversationActive(lead.id)), itens);
  // Equipe: nota + push, uma vez por proposta.
  if (st.proposta !== numero || !st.teamAt) {
    await db.note.create({ data: { leadId: lead.id, type: 'COMMENT', content: `🏦 Santander: a proposta${numero !== 'sem-numero' ? ` ${numero}` : ''} NÃO passou na análise automática ("Enviar Documentos" / Ação pendente) e foi liberada pra ANÁLISE MANUAL. A extensão escolheu "Análise manual" no portal e NÃO clicou em "Enviar".${itens.length ? ` Documentos que o portal pede: ${itens.join('; ')}.` : ''} Depois que o cliente mandar: anexe no portal, escreva o "Comentário de defesa" e clique em ENVIAR (o envio é sempre manual).` } }).catch(() => {});
    const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
    sendPushToAccount(lead.accountId, { title: '🏦 Santander pede análise manual', body: `${lead.name}: não passou na análise automática — documentos pedidos ao cliente`, leadId: lead.id }).catch(() => {});
    await salvar({ teamAt: new Date().toISOString() });
  }
  // Cliente: só com a IA do card ligada, sem STOP TOTAL, dentro das 07h–21h e com a janela de 24 h aberta (senão fica o texto pronto na nota).
  const motivo = cf._autoPaused ? 'o card está em STOP TOTAL' : !lead.aiAutoReplyActive ? 'a IA deste card está desligada' : !inNoticeWindow() ? 'fora do horário dos avisos (07h–21h)' : !(await whatsappWindowOpen(lead.id)) ? 'a janela de 24 h do WhatsApp está fechada' : '';
  if (motivo) {
    if (!st.askedAt && !(cf._santanderManual as any)?.heldNoteFor) {
      await db.note.create({ data: { leadId: lead.id, type: 'COMMENT', content: `⏳ Santander (análise manual): NÃO pedi os documentos ao cliente agora — ${motivo}. ${motivo.includes('janela') || motivo.includes('IA') ? 'Chame o cliente e mande:' : 'Tento de novo na próxima leitura; se preferir, mande você:'}\n\n${texto}` } }).catch(() => {});
      await salvar({ heldNoteFor: numero });
    }
    return;
  }
  const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
  const r = await sendOutboundWhatsApp({ accountId: lead.accountId, leadId: lead.id, content: texto });
  if (!r.success) { console.warn(`[Santander manual] ${lead.name}: pedido de documentos não saiu — ${(r as any).error}`); return; }
  await salvar({ askedAt: new Date().toISOString() });
  await db.note.create({ data: { leadId: lead.id, type: 'COMMENT', content: `📨 Santander (análise manual): pedi os documentos ao cliente explicando que a proposta não passou na análise automática.${itens.length ? ` Pedido: ${itens.join('; ')}.` : ''}` } }).catch(() => {});
}

/** Quais bancos ainda estão "em jogo" pra este cliente (informativo) e se a COMPROVAÇÃO DE RENDA continua necessária. ATENÇÃO (Fabio 20/10, caso Luiz Fernando): a dispensa de renda foi dita pra ESSE cliente
 *  ("a documentação de renda foi solicitada pro Santander; como ele não vai seguir pelo Santander, seria pelo Inter") — NÃO é regra geral (a regra de 17/10 continua: renda na lista). Por isso a renda só é
 *  dispensada quando o card tem a marca explícita `_rendaDispensada` (a equipe/IA põe caso a caso). Em jogo = banco com aprovação (a última decisão não é reprovação) ou com proposta enviada e ainda sem
 *  resultado — a análise manual do Santander ("Enviar Documentos") NÃO conta, e `cf._bancosFora` (bancos descartados pelo cliente/equipe) tira o banco. */
export async function bancosEmJogo(db: Db, leadId: string): Promise<{ emJogo: string[]; rendaNecessaria: boolean; texto: string }> {
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cf = (lead?.customFields || {}) as Record<string, any>;
  const fora: string[] = Array.isArray(cf._bancosFora) ? cf._bancosFora : [];
  const rows = await db.creditAnalysis.findMany({ where: { leadId, dryRun: false, createdAt: { gte: new Date(Date.now() - 45 * 86_400_000) } }, orderBy: { createdAt: 'desc' }, select: { bank: true, kind: true, status: true, detail: true, source: true } });
  const nomes: Record<string, string> = { INTER: 'Inter', CREDITAS: 'Creditas', CREDIMORAR: 'Santander' };
  const emJogo: string[] = [];
  const partes: string[] = [];
  for (const b of ['INTER', 'CREDITAS', 'CREDIMORAR']) {
    const meus = rows.filter((r) => r.bank === b && r.source !== 'AI_SIM');
    if (fora.includes(b)) { partes.push(`${nomes[b]}: descartado pelo cliente/equipe`); continue; }
    const dec = meus.filter((r) => ['APPROVED', 'CONDITIONAL', 'REJECTED'].includes(r.status) && !(r.source === 'AI_CHANGE' && r.status === 'REJECTED'));
    if (dec.length) {
      if (dec[0].status !== 'REJECTED') { emJogo.push(b); partes.push(`${nomes[b]}: aprovado`); } else partes.push(`${nomes[b]}: reprovado`);
      continue;
    }
    const ult = meus.find((r) => !(r.kind === 'CHECK' && r.status === 'CHECK'));
    if (!ult) { partes.push(`${nomes[b]}: não rodou`); continue; }
    if (/AN[ÁA]LISE MANUAL ABERTA|ENVIAR DOCUMENTOS/i.test(ult.detail || '')) { partes.push(`${nomes[b]}: pediu análise manual com documentos (fora do jogo, a menos que o cliente queira seguir por ele)`); continue; }
    if (['SENT', 'REQUESTED', 'RUNNING'].includes(ult.status)) { emJogo.push(b); partes.push(`${nomes[b]}: em análise`); } else partes.push(`${nomes[b]}: sem resultado (falha/não rodou)`);
  }
  // RENDA SÓ QUANDO O BANCO PEDE (Fabio 27/10: "solicitar renda apenas quando o banco solicitar, essa era regra" — Milena e Fernanda, aprovadas no Inter, receberam pedido de holerite/IR
  // sem o banco ter pedido). Necessária só se a resposta de algum banco aprovado pediu documento de renda, ou se a equipe marcou `_rendaExigida` no card.
  const rendaNecessaria = !cf._rendaDispensada && (!!cf._rendaExigida || bancoPediuRenda(rows.filter((r) => ['APPROVED', 'CONDITIONAL'].includes(r.status)).map((r) => r.detail || '')));
  return { emJogo, rendaNecessaria, texto: partes.join('; ') };
}

/** Algum banco pediu documento de RENDA (contracheque, extrato, IR, DECORE, pró-labore…) na resposta da análise? Pura. */
export const RX_DOC_RENDA = /comprovante de renda|comprova[cç][aã]o de renda|contracheque|holerite|extrato[s]? banc|imposto de renda|\bIRPF\b|declara[cç][aã]o de renda|DECORE|pr[oó][- ]?labore/i;
export function bancoPediuRenda(textos: string[]): boolean {
  return textos.some((t) => RX_DOC_RENDA.test(String(t || '')));
}

/** O banco pediu DE NOVO / não aceitou a certidão de ônus/matrícula que o cliente já mandou (Fabio 15/10: "o próprio CRM faz essa parte: anota e lê"). Lê o resultado da análise (ex.: Inter "Documentos
 *  pendentes: Certidão de ônus…" ou texto de recusa), anota no card com o marcador "🏛️ CERTIDÃO RECUSADA PELO BANCO" (a conferência de documentos lê esse marcador) e avisa o cliente UMA vez,
 *  oferecendo emitir uma nova pelo ONR (R$ 40–100, com o OK dele). Só quando o cliente JÁ mandou matrícula/ônus — se ainda não mandou, é só documento pendente normal. */
const CERTIDAO_MARCADOR = '🏛️ CERTIDÃO RECUSADA PELO BANCO';
async function flagCertidaoRecusada(db: Db, row: { id: string; leadId: string; bank: string; dryRun: boolean; detail?: string | null; accountId: string }): Promise<void> {
  const det = String(row.detail || '');
  if (row.dryRun || !det) return;
  const pend = (det.match(/Documentos pendentes:\s*([\s\S]*)$/i) || [])[1] || '';
  const recusa = /(certid[aã]o|matr[ií]cula|[oô]nus)[^.]{0,90}(n[aã]o aceit|recus|inv[aá]lid|vencid|antig|simples consulta)/i.test(det) || /(n[aã]o aceit|recus|pend[eê]ncia)[^.]{0,90}(certid[aã]o|matr[ií]cula|[oô]nus)/i.test(det);
  if (!(/(certid[aã]o|matr[ií]cula|[oô]nus)/i.test(pend) || recusa)) return;
  const lead = await db.lead.findUnique({ where: { id: row.leadId }, select: { name: true, aiAutoReplyActive: true, customFields: true } });
  const cf = (lead?.customFields || {}) as Record<string, any>;
  const jaMandou = Object.values((cf._docReview || {}) as Record<string, any>).some((r: any) => /^(MATRICULA|CERTIDAO DE ONUS)/.test(String(r?.tipo || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()) && r?.resultado !== 'NAO_DOCUMENTO');
  if (!jaMandou) return; // cliente ainda não mandou: é pendência comum, a cobrança normal cuida
  const recente = await db.note.findFirst({ where: { leadId: row.leadId, content: { startsWith: CERTIDAO_MARCADOR }, createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } }, select: { id: true } });
  if (recente) return;
  const banco = BANKS[row.bank]?.label || row.bank;
  const trecho = String((recusa ? det.match(/[^.]{0,80}(certid[aã]o|matr[ií]cula|[oô]nus)[^.]{0,120}/i)?.[0] : pend) || det).replace(/\s+/g, ' ').trim().slice(0, 220);
  await db.note.create({ data: { leadId: row.leadId, type: 'COMMENT', content: `${CERTIDAO_MARCADOR} — ${banco} não aceitou (ou pediu de novo) a certidão de ônus/matrícula que o cliente enviou: ${trecho}. A A&F oferece emitir uma nova pelo ONR (custo de R$ 40 a R$ 100 pro cliente, só com o OK dele).` } });
  try {
    const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
    const last = await db.message.findFirst({ where: { leadId: row.leadId, direction: 'INBOUND', channel: 'WHATSAPP' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    const aberta = !!last && Date.now() - last.createdAt.getTime() < 23 * 3_600_000;
    if (lead?.aiAutoReplyActive && aberta && !cf._autoPaused) {
      await sendOutboundWhatsApp({ accountId: row.accountId, leadId: row.leadId, content: `Sobre a matrícula/certidão do imóvel que você enviou: o banco não aceitou essa versão (por ser só consulta ou antiga). Pra seguir, preciso de uma nova certidão. Posso emitir ela por aqui, através do cartório digital?` });
    } else {
      await db.note.create({ data: { leadId: row.leadId, type: 'COMMENT', content: '⚠️ Não avisei o cliente da certidão recusada (IA desligada, card parado ou janela do WhatsApp fechada) — avise e peça o OK pra emitir uma nova (R$ 40–100).' } });
    }
  } catch (e: any) { console.error('[Certidão recusada] aviso ao cliente:', e?.message || e); }
}

async function applyUpdate(db: Db, row: { id: string; accountId: string; leadId: string; bank: string; status: string; dryRun: boolean }, data: { status?: string; detail?: string | null; holderName?: string | null } & ResultFields) {
  let next = data.status && ALL_STATUS.has(data.status) ? data.status : row.status;
  // Creditas: "A proposta foi negada — Cliente com proposta em andamento na Creditas" é o MESMO caso do "CPF já possui proposta ativa" (não é reprovação de crédito): vira falha por regra (Desqualificado).
  if (row.bank === 'CREDITAS' && /Cliente com proposta em andamento na Creditas/i.test(String(data.detail || '')) && !/CPF j[aá] possui uma proposta ativa/i.test(String(data.detail || ''))) {
    data = { ...data, status: 'FAILED', detail: `CPF já possui uma proposta ativa na Creditas — ${String(data.detail || '').replace(/^RESULTADO:\s*/i, '')}` };
    next = 'FAILED';
  }
  // Aprovação confirmada DEPOIS sem os números (conferência que só leu a lista, leitura da API do banco que falhou): herda os números da leitura anterior da MESMA proposta —
  // senão o aviso de aprovação ficava esperando "os números" que já existiam (Inter: Alexandre, Jézer, Antenor — 3 aprovadas sem valor gravado).
  if ((next === 'APPROVED' || next === 'CONDITIONAL') && !row.dryRun && data.approvedValue == null) {
    const cur = await db.creditAnalysis.findUnique({ where: { id: row.id }, select: { approvedValue: true, proposalNumber: true, holderCpf: true } });
    if (cur && cur.approvedValue == null) {
      const numero = (data.proposalNumber as string | null | undefined) || cur.proposalNumber || null;
      const ant = await db.creditAnalysis.findFirst({
        where: { leadId: row.leadId, bank: row.bank, dryRun: false, id: { not: row.id }, approvedValue: { not: null }, status: { in: ['APPROVED', 'CONDITIONAL'] }, ...(numero ? { proposalNumber: numero } : cur.holderCpf ? { holderCpf: cur.holderCpf } : {}) },
        orderBy: { createdAt: 'desc' },
      });
      if (ant) {
        const herdados: Record<string, unknown> = {};
        for (const k of RESULT_KEYS) { if (!(k in data) || (data as any)[k] == null) (herdados as any)[k] = (ant as any)[k]; }
        data = { ...data, ...(herdados as any) };
      }
    }
  }
  // Creditas: "Este CPF já possui uma proposta ativa … NÃO está na lista de Propostas da nossa conta" (Fabio 15/10, Arlan): não tem como rodar → vira FALHA POR REGRA ("Desqualificado"), não "Conferir".
  if (row.bank === 'CREDITAS' && (next === 'CHECK' || next === 'FAILED') && /CPF j[aá] possui uma proposta ativa na Creditas/i.test(String(data.detail || ''))) next = 'FAILED';
  // Aprovação MUITO acima do que o cliente pediu (mais de 1,5×; Fabio 15/10, Gabriela: pediu R$ 50 mil e a conferência do Creditas trouxe R$ 1,6 milhão em 161 meses — era OUTRA proposta ativa do
  // mesmo CPF no portal): não vale pra este card. No Creditas vira "CPF com proposta ativa" (Desqualificado); nos outros, volta pra conferir à mão.
  if (!row.dryRun && (next === 'APPROVED' || next === 'CONDITIONAL')) {
    const lead = await db.lead.findUnique({ where: { id: row.leadId }, select: { customFields: true } });
    const cfv = (lead?.customFields || {}) as Record<string, any>;
    const toN = (v: any) => { const t = String(v ?? '').replace(/[^\d.,]/g, ''); const n = t.includes(',') ? Number(t.replace(/\./g, '').replace(',', '.')) : (/\.\d{3}$/.test(t) ? Number(t.replace(/\./g, '')) : Number(t)); return Number.isFinite(n) ? n : 0; };
    const pedido = toN(cfv._lastRunValue) || toN(cfv.valor_credito);
    // Compara o que o cliente RECEBE (líquido do Creditas, já sem IOF/tarifa/custas) com o pedido; o valor bruto do Creditas vem MAIOR por causa dessas custas (+8% a +22% nos casos reais), então
    // sem o líquido a margem é maior (1,8×) pra não barrar aprovação legítima. Caso do erro (Gabriela): 30× o pedido.
    const aprovado = Number(data.netValue) || Number(data.approvedValue) || 0;
    const fator = row.bank === 'CREDITAS' && !Number(data.netValue) ? 1.8 : 1.5;
    if (pedido > 0 && aprovado > pedido * fator) {
      const lido = `${brl(Number(data.netValue) || Number(data.approvedValue))}${data.termMonths ? ` em ${data.termMonths} meses` : ''}`;
      next = row.bank === 'CREDITAS' ? 'FAILED' : 'CHECK';
      data = {
        ...data, status: next, proposalNumber: null, approvedValue: null, netValue: null, termMonths: null, rate: null, indexer: null, firstInstallment: null, lastInstallment: null, conditions: null,
        detail: row.bank === 'CREDITAS'
          ? `CPF já possui uma proposta ativa na Creditas — a conferência trouxe ${lido}, que não é o pedido deste card (${brl(pedido)}). Resultado descartado; confira no portal.`
          : `RESULTADO DESCARTADO: o portal devolveu ${lido}, muito acima do pedido deste card (${brl(pedido)}) — provavelmente outra proposta do mesmo CPF. Confira no portal.`,
      };
    }
  }
  const becameFinal = FINAL.has(next) && !FINAL.has(row.status);
  // Saiu da fila do navegador compartilhado e começou a rodar de verdade: o relógio do teto de duração recomeça agora.
  let resetStart = false;
  let novoSteps: Array<{ s: string; t: string }> | null = null;
  if ((next === 'RUNNING' && data.detail !== undefined) || becameFinal) {
    const prevRow = await db.creditAnalysis.findUnique({ where: { id: row.id }, select: { detail: true, steps: true } });
    if (next === 'RUNNING' && !/^na fila/i.test(String(data.detail || ''))) resetStart = /^na fila/i.test(String(prevRow?.detail || ''));
    // Linha do tempo: só registra quando o passo MUDA (a extensão repete o mesmo passo a cada poucos segundos).
    const lista = (Array.isArray(prevRow?.steps) ? (prevRow!.steps as any[]) : []) as Array<{ s: string; t: string }>;
    const rotulo = becameFinal ? `FIM ${next}` : String(data.detail || '').replace(/\s+/g, ' ').slice(0, 90).replace(/\(há \d+ min\)/, '');
    if (rotulo && (!lista.length || lista[lista.length - 1].s !== rotulo)) novoSteps = [...lista, { s: rotulo, t: new Date().toISOString() }].slice(-80);
  }
  const updated = await db.creditAnalysis.update({
    where: { id: row.id },
    data: {
      ...(data.status && ALL_STATUS.has(data.status) ? { status: next } : {}),
      ...(data.detail !== undefined ? { detail: data.detail ? String(data.detail).slice(0, 4000) : null } : {}),
      ...Object.fromEntries(RESULT_KEYS.filter((k) => k in data).map((k) => [k, (data as any)[k]])),
      ...(resetStart ? { startedAt: new Date() } : {}),
      ...(novoSteps ? { steps: novoSteps as any } : {}),
      ...(data.holderName ? { holderName: data.holderName } : {}),
      ...(becameFinal ? { finishedAt: new Date() } : {}),
    },
  });
  // Grava NOME e CPF de QUEM foi analisado em toda linha real (aprovada, reprovada, enviada, conferir, falha) — a tela separa os participantes por eles; antes só a aprovada tinha CPF,
  // e "Douglas Rafael Santos" caía na coluna do "Rafael Santos" (Fabio 15/10). Também é por esse CPF que o PDF da simulação é buscado no portal (Juan Reppucci, 14/10).
  if (!updated.dryRun && (!updated.holderCpf || !updated.holderName) && !['REQUESTED', 'RUNNING'].includes(next)) {
    const id = await resolveHolderIdentity(db, updated);
    const patch: Record<string, string> = {};
    if (!updated.holderCpf && id.cpf) patch.holderCpf = id.cpf;
    if (!updated.holderName && id.name) patch.holderName = id.name;
    if (Object.keys(patch).length) { await db.creditAnalysis.update({ where: { id: updated.id }, data: patch }).catch(() => {}); Object.assign(updated, patch); }
  }
  // Nota automática só na primeira vez que vira aprovada/reprovada (modo teste não escreve no card).
  if (becameFinal && !updated.dryRun && (next === 'APPROVED' || next === 'CONDITIONAL' || next === 'REJECTED')) {
    const holder = await holderIfSecond(db, row.leadId, updated.holderName);
    await db.note.create({ data: { leadId: row.leadId, type: 'COMMENT', content: analysisNote({ ...updated, status: next, holder }) } });
  }
  // PROBLEMA que pede a atenção da equipe (Fabio 17/10, Mauricio no Inter: "Simulação — Requer ação — Encontramos um problema. Entre em contato com seu consultor"): vai pro card, uma vez por
  // problema (mesmo banco e mesmo texto) a cada 12 h — antes só aparecia dentro da aba Análise de Crédito.
  // Falha OBJETIVA do banco/imóvel (idade + prazo, valor mínimo, terreno…): o card passa a DIZER isso (Fabio 17/10: o cliente barrado por idade ficava só na aba, parecendo "em análise").
  if (becameFinal && !updated.dryRun && next === 'FAILED' && /N[ÃA]O RODEI|n[aã]o conformidade|recusou antes de consultar/i.test(updated.detail || '')) {
    const label = BANKS[updated.bank]?.label || updated.bank;
    const quem = updated.holderName ? ` (${updated.holderName})` : '';
    const motivo = String(updated.detail || '').replace(/Titular na análise:[^.]*\.\s*/i, '').replace(/^"[^"]*":\s*/, '').replace(/^NÃO RODEI:\s*/i, '').replace(/\s+/g, ' ').trim().slice(0, 320);
    const conteudo = `🚫 ${label} NÃO analisa este cliente${quem}: ${motivo}`;
    const ja = await db.note.findFirst({ where: { leadId: row.leadId, content: conteudo, createdAt: { gt: new Date(Date.now() - 12 * 3_600_000) } }, select: { id: true } });
    if (!ja) await db.note.create({ data: { leadId: row.leadId, type: 'COMMENT', content: conteudo } }).catch(() => {});
  }
  if (becameFinal && !updated.dryRun && next === 'CHECK') {
    const label = BANKS[updated.bank]?.label || updated.bank;
    const txt = String(updated.detail || '').replace(/Titular na análise:[^.]*\.\s*/i, '').replace(/^conferir:\s*/i, '').replace(/\s+/g, ' ').trim().slice(0, 360);
    if (txt) {
      const conteudo = `⚠️ ${label} pede atenção da equipe${updated.proposalNumber ? ` (proposta nº ${updated.proposalNumber})` : ''}: ${txt}${/PROBLEMA NO INTER|ERRO DO PORTAL INTER/i.test(txt) ? '\nSe continuar assim, o CRM pede a sua autorização pra escrever à Vania (Inter).' : ''}`;
      const ja = await db.note.findFirst({ where: { leadId: row.leadId, content: conteudo, createdAt: { gt: new Date(Date.now() - 12 * 3_600_000) } }, select: { id: true } });
      if (!ja) await db.note.create({ data: { leadId: row.leadId, type: 'COMMENT', content: conteudo } }).catch(() => {});
    }
  }
  // Creditas: CPF com proposta ativa que NÃO é nossa → observação no card (precisa acionar o gestor).
  if (becameFinal && !updated.dryRun && /acionar manualmente o gestor/i.test(updated.detail || '')) {
    await db.note.create({ data: { leadId: row.leadId, type: 'COMMENT', content: '⚠️ Creditas: este CPF já possui uma proposta ativa que NÃO está na nossa conta — precisa acionar manualmente o gestor da Creditas (contato executivo Home).' } });
  }
  if (becameFinal && !updated.dryRun) await finishProposalChange(db, updated.leadId).catch((e: any) => console.error('[IA] nova proposta com outro prazo/valor:', e?.message));
  if (becameFinal) await noteVerdictFlip(db, updated as any).catch((e: any) => console.error('[Mudança de resultado]', e?.message || e));
  await flagCertidaoRecusada(db, updated as any).catch((e: any) => console.error('[Certidão recusada]', e?.message || e));
  if (becameFinal && !updated.dryRun && (next === 'APPROVED' || next === 'CONDITIONAL')) await reabrirSeAprovouDepoisDaNegativa(db, updated as any).catch((e: any) => console.error('[Reabrir ao aprovar]', e?.message || e));
  await santanderManualFlow(db, updated as any).catch((e: any) => console.error('[Santander manual]', e?.message || e));
  return { row: updated, becameFinal };
}

/** QUEM foi analisado (nome e CPF do participante do card), pelo CPF gravado, senão pelo nome do titular da análise (nome mais parecido — ver whichParticipant),
 *  senão pela inversão ligada pro banco; sem nada disso, o 1º participante. Fabio 15/10: "precisa puxar por nome e CPF". */
export async function resolveHolderIdentity(db: Db, row: { leadId: string; holderCpf?: string | null; holderName?: string | null; detail?: string | null; bank?: string }): Promise<{ who: 1 | 2; name: string; cpf: string | null }> {
  const lead = await db.lead.findUnique({ where: { id: row.leadId }, select: { name: true, customFields: true } });
  const cf = (lead?.customFields || {}) as Record<string, any>;
  const dig = (v: unknown) => String(v ?? '').replace(/\D/g, '');
  const card = { name1: String(cf.participante_1 || lead?.name || ''), name2: String(cf.participante_2 || ''), cpf1: dig(cf.cpf_1), cpf2: dig(cf.cpf_2) };
  const nome = row.holderName || parseHolder(row.detail) || '';
  let who: 1 | 2 = 1;
  if (row.holderCpf || nome) who = whichParticipant(card, nome, row.holderCpf);
  else if (row.bank) {
    const ov = await db.creditOverride.findFirst({ where: { leadId: row.leadId, bank: row.bank }, select: { data: true } });
    if ((ov?.data as any)?.inverter === true && card.cpf2.length === 11) who = 2;
  }
  const cpf = row.holderCpf || (who === 2 ? card.cpf2 : card.cpf1);
  return { who, name: nome || (who === 2 ? card.name2 : card.name1), cpf: cpf.length === 11 ? cpf : null };
}

/** CPF (só dígitos) de quem foi analisado (ver resolveHolderIdentity). */
export async function resolveHolderCpf(db: Db, row: { leadId: string; holderCpf?: string | null; holderName?: string | null; detail?: string | null; bank?: string }): Promise<string | null> {
  return (await resolveHolderIdentity(db, row)).cpf;
}

type AnalysisRow = NonNullable<Awaited<ReturnType<Db['creditAnalysis']['findFirst']>>>;

/** Horário de trabalho das EXTENSÕES dos bancos: 07h às 22h (Brasília). Fora dele elas ficam PARADAS — nada sai da fila, nem pedido de pessoa (Fabio 19/10: "passou disso ficam
 *  paradas, porque talvez os sistemas do banco não funcionem"; a sessão do Credimorar vencia de madrugada e o CRM ficava tentando e marcando "Falhou"). O que estiver rodando às 22h termina.
 *  Os AVISOS ao cliente continuam só das 07h às 21h (approval-notice.service.ts). */
export const EXT_HORA_INICIO = 7;
export const EXT_HORA_FIM = 22;
/** Liberação manual fora do horário (Fabio 26/10: "pode liberar agora"): até `afterHoursUntil` as extensões pegam a fila também de madrugada. null = sem liberação. */
export async function liberadoAte(db: Db, accountId: string): Promise<Date | null> {
  const s = await db.creditAutoSetting.findUnique({ where: { accountId }, select: { afterHoursUntil: true } }).catch(() => null);
  return s?.afterHoursUntil && s.afterHoursUntil.getTime() > Date.now() ? s.afterHoursUntil : null;
}
export function foraDoHorario(ms = Date.now()): boolean {
  const h = new Date(ms - BRT_MS).getUTCHours();
  return h < EXT_HORA_INICIO || h >= EXT_HORA_FIM;
}
/** Empurra um horário que cai fora de 07h–22h (Brasília) pras 7h seguintes. Pura (testável). */
export function pushOutOfQuiet(ms: number): Date {
  if (!foraDoHorario(ms)) return new Date(ms);
  const b = new Date(ms - BRT_MS);
  return new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCHours() >= EXT_HORA_FIM ? b.getUTCDate() + 1 : b.getUTCDate(), EXT_HORA_INICIO, 0, 0) + BRT_MS);
}

/** Minutos de espera ANTES da n-ésima conferência depois do envio (n=1 é a primeira). Fabio 15/10: Inter e Creditas conferem 3 vezes de 3 em 3 min (o resultado às vezes sai na hora);
 *  depois o Inter segue de 10 em 10 min e o Creditas "aumenta": 10 min, 20 min e de 30 em 30 min (aprovação real do Creditas leva horas). Santander: 10 em 10. Pura (testável). */
export function checkGapMin(bank: string, n: number): number {
  if ((bank === 'INTER' || bank === 'CREDITAS') && n <= 3) return 3;
  if (bank === 'CREDITAS') return n === 4 ? 10 : n === 5 ? 20 : 30;
  return 10;
}
/** Quando a n-ésima conferência pode rodar: o intervalo do banco, mas só dentro de 07h–22h (fora disso espera até as 7h). Pura (testável). */
export function nextCheckAt(bank: string, n: number, from = Date.now()): Date {
  return pushOutOfQuiet(from + checkGapMin(bank, n) * 60_000);
}

/** Depois de cada relato: (1) conferência que ainda não achou resultado volta pra fila — de 10 em 10 min (18 vezes, ~3 h; Creditas segue por mais 24 h) — pra termos certeza do resultado real; (2) rodada que terminou "enviada" (resultado ainda
 *  não saiu) agenda essa conferência sozinha. Passou do limite, fica "conferir" pra olhar à mão. */
async function afterReport(db: Db, row: AnalysisRow): Promise<AnalysisRow> {
  if (row.dryRun) return row;
  if (row.kind === 'CHECK' && row.source === 'AI') return row; // leitura pontual pedida pela IA da conversa: não vira laço de reconferência
  const paused = !!(await db.creditAutoSetting.findUnique({ where: { accountId: row.accountId }, select: { paused: true } }))?.paused;
  if (row.kind === 'CHECK' && (row.status === 'SENT' || row.status === 'CHECK')) {
    if (paused) return db.creditAnalysis.update({ where: { id: row.id }, data: { status: 'CHECK', attempt: CHECK_MAX_TRIES, detail: `Conferência automática PAUSADA (pausa geral ligada). Use "Conferir" pra ler de novo. ${String(row.detail || '').slice(0, 300)}` } });
    // Cadastro divergente (Santander): ler a lista de 10 em 10 min não adianta — o cliente não aparece até o cadastro ser corrigido. Para as conferências; o CRM pergunta ao cliente e refaz a análise quando ele corrige.
    const rodada = await db.creditAnalysis.findFirst({ where: { leadId: row.leadId, bank: row.bank, kind: 'RUN', dryRun: false, source: { not: 'AI_SIM' } }, orderBy: { createdAt: 'desc' }, select: { detail: true, conditions: true } });
    if (rodada && RX_CAD_DIV.test(`${rodada.detail || ''} ${rodada.conditions || ''}`)) {
      return db.creditAnalysis.update({ where: { id: row.id }, data: { status: 'CHECK', attempt: CHECK_MAX_TRIES, detail: 'Cadastro divergente: parei de conferir a lista do banco até o cadastro ser corrigido (o CRM pergunta ao cliente e refaz a análise quando ele corrigir).' } });
    }
    const creditas = row.bank === 'CREDITAS';
    const maxTries = CHECK_MAX_TRIES + (creditas ? CREDITAS_EXTRA_TRIES : 0);
    const velho = creditas && Date.now() - row.createdAt.getTime() > CREDITAS_MAX_AGE_MS; // Creditas: o limite é o tempo (60 h), não a contagem
    if (row.attempt < maxTries && !velho) {
      const attempt = row.attempt + 1;
      const quando = nextCheckAt(row.bank, attempt);
      const em = Math.max(1, Math.round((quando.getTime() - Date.now()) / 60_000));
      const proxima = em >= 120 ? `às ${new Date(quando.getTime() - BRT_MS).toISOString().slice(11, 16)} (só das 7h às 22h)` : `em ${em} min`;
      return db.creditAnalysis.update({
        where: { id: row.id },
        data: {
          status: 'REQUESTED', notBefore: quando, attempt, finishedAt: null,
          detail: `Conferindo — conferência ${attempt}${creditas ? '' : ` de ${maxTries}`}, próxima ${proxima}. Última leitura: ${String(row.detail || '').replace(/^Conferindo[^:]*:\s*(Última leitura:\s*)?/i, '').slice(0, 300)}`,
        },
      });
    }
    return db.creditAnalysis.update({ where: { id: row.id }, data: { status: 'CHECK', detail: `Sem resultado depois de ${creditas ? 'mais de 60 h' : `${maxTries} conferências`}: confira no portal. ${String(row.detail || '').slice(0, 300)}` } });
  }
  if (row.kind === 'RUN' && row.status === 'SENT' && CHECK_BANKS.includes(row.bank) && !paused && !RX_CAD_DIV.test(`${row.detail || ''} ${row.conditions || ''}`)) {
    const open = await db.creditAnalysis.findFirst({ where: { leadId: row.leadId, bank: row.bank, kind: 'CHECK', status: { in: ACTIVE } }, select: { id: true } });
    if (!open) {
      await db.creditAnalysis.create({
        data: { accountId: row.accountId, leadId: row.leadId, bank: row.bank, status: 'REQUESTED', kind: 'CHECK', attempt: 1, notBefore: nextCheckAt(row.bank, 1), proposalNumber: row.proposalNumber, dryRun: false, source: 'EXTENSION', holderName: row.holderName, holderCpf: row.holderCpf, detail: `Conferindo — 1ª conferência em ${checkGapMin(row.bank, 1)} min (depois ${row.bank === 'CREDITAS' ? '3 em 3 min nas 3 primeiras, 10 min, 20 min e de 30 em 30 min' : row.bank === 'INTER' ? '3 em 3 min nas 3 primeiras e de 10 em 10 min' : 'de 10 em 10 min'}; só das 7h às 21h).` },
      });
    }
  }
  return row;
}

/** Relato da extensão: status (já em inglês do CRM) + texto + números que ela conseguir ler. */
export async function reportAnalysis(db: Db, p: { accountId: string; requestId?: string; leadId: string; bank: string; status: string; detail?: string; result?: Record<string, any> }) {
  if (!BANK_KEYS.includes(p.bank)) throw new Error('banco desconhecido');
  const lead = await db.lead.findFirst({ where: { id: p.leadId, accountId: p.accountId }, select: { id: true, customFields: true } });
  if (!lead) throw new Error('card não encontrado');
  let row = p.requestId ? await db.creditAnalysis.findFirst({ where: { id: p.requestId, accountId: p.accountId, leadId: p.leadId } }) : null;
  if (!row) {
    // Sem pedido: continua a execução aberta mais recente desse cliente neste banco (as extensões
    // também rodam sozinhas nos cards novos da Pré-Análise); senão cria uma.
    row = await db.creditAnalysis.findFirst({
      where: { accountId: p.accountId, leadId: p.leadId, bank: p.bank, status: { in: ['REQUESTED', 'RUNNING', 'SENT'] }, updatedAt: { gt: new Date(Date.now() - REPORT_REUSE_MS) } },
      orderBy: { createdAt: 'desc' },
    });
  }
  // Cliente com STOP TOTAL: passo/falha de uma execução AUTOMÁTICA que ainda está rodando na extensão não vira registro nenhum — o CRM só manda ela parar (`cancel` na resposta).
  // Execução pedida por uma PESSOA na tela (requestedById) continua valendo; resultado de verdade (aprovado/reprovado) e "enviada" também são gravados.
  if ((lead.customFields as any)?._autoPaused && !['APPROVED', 'CONDITIONAL', 'REJECTED', 'SENT'].includes(p.status) && (!row || !row.requestedById)) {
    return (row ? Object.assign(row, { cancelled: true }) : { id: '', leadId: p.leadId, status: 'FAILED', cancelled: true }) as any;
  }
  if (!row) {
    row = await db.creditAnalysis.create({ data: { accountId: p.accountId, leadId: p.leadId, bank: p.bank, status: 'RUNNING', source: 'EXTENSION', startedAt: new Date(), dryRun: p.status === 'TEST' } });
  }
  // Rodada CANCELADA pela pausa do cliente (setLeadAutoPause): a extensão ainda manda passo/falha da execução que está sendo derrubada — ignora e manda ela parar (`cancelled`).
  // Resultado de verdade (aprovado/reprovado) e "enviada" (a proposta chegou a ser enviada antes do corte) ainda valem.
  if (row.status === 'FAILED' && /pausada pelo usu[aá]rio/i.test(row.detail || '') && !['APPROVED', 'CONDITIONAL', 'REJECTED', 'SENT'].includes(p.status)) return Object.assign(row, { cancelled: true }) as typeof row;
  // Relato atrasado (ex.: um "passo" que chegou depois do resultado) não pode desfazer um resultado final.
  if (FINAL.has(row.status) && !FINAL.has(p.status)) return row;
  // Aprovado "condicionado" (Inter pede documentos; Santander "Aprovado Condicional") é um status próprio: aprovou, mas falta algo.
  const status = p.status === 'APPROVED' && /condicion/i.test(p.detail || '') ? 'CONDITIONAL' : p.status;
  // 26/10 (Adiene): o aviso "não aceitou o financiamento de R$ X; rodei com R$ Y" repetiu 9 vezes, o texto foi cortado ANTES das condições e a aprovação ficou só com o valor
  // (sem prazo, parcela e taxa). Agora: avisos repetidos viram um só, as condições também são lidas do campo `conditions`, e número nulo vindo da extensão não apaga o que o texto trouxe.
  const detail = p.detail == null ? p.detail : dedupeAvisos(p.detail);
  const numbers = p.bank === 'CREDIMORAR' ? parseSantanderConditions(`${detail || ''} ${(p.result && p.result.conditions) || ''}`) : {};
  const holderName = parseHolder(detail) || row.holderName || (FINAL.has(status) ? await resolveHolder(db, p.leadId, p.bank, null) : null);
  const vindo = pickResult(p.result || {});
  for (const k of Object.keys(numbers) as (keyof ResultFields)[]) if (vindo[k] == null) delete vindo[k];
  const { row: updated } = await applyUpdate(db, row, { status, detail: detail ?? null, holderName, ...numbers, ...vindo });
  return afterReport(db, updated);
}

/** Edição à mão (formulário "Registrar resultado" da aba): muda status e/ou os números. */
export async function updateAnalysis(db: Db, p: { accountId: string; id: string; patch: Record<string, any> }) {
  const row = await db.creditAnalysis.findFirst({ where: { id: p.id, accountId: p.accountId } });
  if (!row) throw new Error('análise não encontrada');
  const { row: updated } = await applyUpdate(db, row, {
    ...(p.patch.status ? { status: String(p.patch.status) } : {}),
    ...('detail' in p.patch ? { detail: p.patch.detail } : {}),
    ...pickResult(p.patch),
  });
  return updated;
}

/** Registra à mão uma análise (ex.: o Inter que o Fabio/skill leu no portal). */
export async function registerManual(db: Db, p: { accountId: string; userId?: string; leadId: string; bank: string; status: string; detail?: string; result?: Record<string, any> }) {
  if (!BANK_KEYS.includes(p.bank)) throw new Error('banco desconhecido');
  if (!ALL_STATUS.has(p.status)) throw new Error('status inválido');
  const lead = await db.lead.findFirst({ where: { id: p.leadId, accountId: p.accountId }, select: { id: true } });
  if (!lead) throw new Error('card não encontrado');
  const row = await db.creditAnalysis.create({
    data: { accountId: p.accountId, leadId: p.leadId, bank: p.bank, status: 'RUNNING', source: 'MANUAL', requestedById: p.userId || null, startedAt: new Date() },
  });
  const { row: updated } = await applyUpdate(db, row, { status: p.status, detail: p.detail ?? null, holderName: await resolveHolder(db, p.leadId, p.bank, p.detail), ...pickResult(p.result || {}) });
  return updated;
}

/** Escolhe a proposta do cliente (manual): marca como escolhida e preenche a aba Financiamento do card. */
export async function chooseAnalysis(db: Db, p: { accountId: string; id: string; userName?: string }) {
  const row = await db.creditAnalysis.findFirst({ where: { id: p.id, accountId: p.accountId } });
  if (!row) throw new Error('análise não encontrada');
  if (row.status !== 'APPROVED' && row.status !== 'CONDITIONAL') throw new Error('só dá pra escolher uma proposta aprovada');
  const lead = await db.lead.findUnique({ where: { id: row.leadId }, select: { id: true, value: true, customFields: true } });
  if (!lead) throw new Error('card não encontrado');
  await db.creditAnalysis.updateMany({ where: { leadId: row.leadId, chosen: true }, data: { chosen: false } });
  await db.creditAnalysis.update({ where: { id: row.id }, data: { chosen: true } });

  const cf = { ...((lead.customFields || {}) as Record<string, any>) };
  const before = { valor: cf.valor_credito, instituicao: cf.instituicao };
  const b = BANKS[row.bank];
  const fill: Record<string, any> = { instituicao: b?.instituicao || row.bank };
  if (row.proposalNumber) fill.num_proposta = row.proposalNumber;
  if (row.termMonths) fill.prazo_financ = `${row.termMonths} meses`;
  if (row.rate) fill.taxa_efetiva = row.rate;
  if (row.indexer) fill.indexador = row.indexer;
  if (row.firstInstallment) fill.primeira_parcela = String(row.firstInstallment);
  if (row.lastInstallment) fill.ultima_parcela = String(row.lastInstallment);
  if (row.approvedValue) {
    fill.valor_credito = String(row.approvedValue);
    if (before.valor && Number(before.valor) !== row.approvedValue) fill._valorPedido = before.valor; // guarda o que o cliente pediu
  }
  await db.lead.update({
    where: { id: lead.id },
    data: { customFields: { ...cf, ...fill } as any, ...(row.approvedValue ? { value: row.approvedValue } : {}) },
  });
  const campos = Object.keys(fill).filter((k) => !k.startsWith('_')).join(', ');
  await db.note.create({
    data: {
      leadId: lead.id, type: 'COMMENT',
      content: `⭐ Proposta escolhida: ${b?.label || row.bank}${row.approvedValue ? ` — ${brl(row.approvedValue)}` : ''}${(await holderIfSecond(db, row.leadId, row.holderName)) ? `, no nome de ${row.holderName} (2º participante)` : ''}${p.userName ? ` (por ${p.userName})` : ''}. A aba Financiamento do card foi preenchida com ela (${campos}).${before.valor && row.approvedValue && Number(before.valor) !== row.approvedValue ? ` Valor pedido antes: ${brl(Number(before.valor))}.` : ''}`,
    },
  });
  return { ok: true, filled: Object.keys(fill).filter((k) => !k.startsWith('_')) };
}

/** Execução que ficou "rodando" sem a extensão dar sinal (Chrome fechado, janela fechada) vira "falhou". */
/** Texto da falha de uma execução que sumiu: diz POR QUÊ (o que aconteceu) e em que etapa parou, e o que fazer. */
function orphanDetail(why: string, lastDetail?: string | null): string {
  const ult = String(lastDetail || '').replace(/\s+/g, ' ').replace(/^Titular na análise:[^.]*\.\s*/i, '').slice(0, 220);
  return `${why}${ult ? ` Última etapa registrada: "${ult}".` : ' Não chegou a registrar nenhuma etapa.'} Nada foi concluído: peça de novo (se a proposta já tinha sido enviada ao banco, use "Conferir").`;
}

// Teto de duração de UMA análise de rodar (Fabio 14/10: "não podemos deixar esse tanto de tempo com um cliente"): a Maria Antônia ficou 27 min no Inter repetindo
// "preencher CPF" — a extensão seguia mandando passos, então o limite de "sem passo novo" nunca disparava. Tempos reais (5 dias): Inter p90 8 min, Creditas p50 4,5 min,
// Santander p90 15 min / máx. 21 min (inclui esperar o navegador compartilhado). Estourou: vira falha e a retentativa automática refaz (como CONFERIR se a proposta já foi enviada).
const MAX_RUN_MIN: Record<string, number> = { INTER: 15, CREDITAS: 15, CREDIMORAR: 6 }; // Santander 6 min por ordem do Fabio (14/10); 4 de 13 rodadas boas dos últimos 5 dias passaram disso

async function expireStuck(db: Db, where: { accountId: string; leadId?: string }) {
  const rows = await db.creditAnalysis.findMany({ where: { ...where, status: 'RUNNING', updatedAt: { lt: new Date(Date.now() - STUCK_RUNNING_MS) } }, select: { id: true, detail: true } });
  for (const r of rows) {
    await db.creditAnalysis.updateMany({
      where: { id: r.id, status: 'RUNNING' },
      data: { status: 'FAILED', finishedAt: new Date(), detail: orphanDetail('A extensão ficou mais de 8 minutos sem andar para o passo seguinte (janela do banco sem foco, portal que não respondeu, Chrome fechado, computador dormiu ou extensão recarregada).', r.detail) },
    });
  }
  // Teto de duração (independe de a extensão ainda mandar passos).
  const longos = await db.creditAnalysis.findMany({ where: { ...where, status: 'RUNNING', kind: 'RUN', startedAt: { lt: new Date(Date.now() - 15 * 60_000) } }, select: { id: true, bank: true, startedAt: true, detail: true } });
  for (const r of longos) {
    // "na fila: esperando a extensão X terminar de usar o navegador" é ESPERA, não execução (Eduardo 14/10: o Inter foi reprovado por "15 min rodando" depois de 13 min esperando o Creditas liberar o navegador).
    // Esperando, o teto é outro: 45 min no total; o relógio de execução recomeça quando a extensão volta a andar (ver applyUpdate).
    const esperando = /^na fila/i.test(String(r.detail || ''));
    const teto = esperando ? 45 : (MAX_RUN_MIN[r.bank] || 15);
    if (!r.startedAt || Date.now() - r.startedAt.getTime() < teto * 60_000) continue;
    await db.creditAnalysis.updateMany({
      where: { id: r.id, status: 'RUNNING' },
      data: { status: 'FAILED', finishedAt: new Date(), detail: orphanDetail(`Esta análise passou de ${teto} minutos rodando (o limite de um cliente por banco). O portal ou a janela provavelmente travou.`, r.detail) },
    });
  }
}

/** A extensão acabou de (re)iniciar: o que ela tinha em execução se perdeu (recarregar a extensão, o Chrome reiniciar ou o service
 *  worker ser encerrado derruba a execução). Falha na hora, com o motivo, em vez de esperar 30 min. */
export async function releaseOrphans(db: Db, p: { accountId: string; bank: string }) {
  const rows = await db.creditAnalysis.findMany({ where: { accountId: p.accountId, bank: p.bank, status: 'RUNNING' }, select: { id: true, detail: true, kind: true } });
  for (const r of rows) {
    // Conferência (só leitura) que se perdeu NÃO falha: volta pra fila e a extensão lê de novo (Douglas, 15/10: a conferência do Creditas morreu na recarga da extensão e a proposta ficou sem
    // ninguém olhando). Só a rodada de RODAR (que pode ter deixado rascunho no banco) fica como falha.
    if (r.kind === 'CHECK') {
      await db.creditAnalysis.updateMany({ where: { id: r.id, status: 'RUNNING' }, data: { status: 'REQUESTED', startedAt: null, notBefore: null, detail: 'A extensão foi recarregada no meio da conferência — vai ler o resultado de novo.' } });
      continue;
    }
    await db.creditAnalysis.updateMany({
      where: { id: r.id, status: 'RUNNING' },
      data: { status: 'FAILED', finishedAt: new Date(), detail: orphanDetail('A extensão foi recarregada ou reiniciada no meio desta execução (recarregar a extensão no Chrome, reiniciar o Chrome ou o Chrome encerrar a extensão).', r.detail) },
    });
  }
  releaseLock(p.accountId, p.bank);
  return rows.length;
}

/** Quadro da aba: clientes do Home Equity em Pré-Análise (e quem teve análise nas últimas 3 semanas) × bancos. */
export async function board(db: Db, p: { accountId: string; scopeDepartmentIds: string[] }) {
  await expireStuck(db, { accountId: p.accountId });
  const since = new Date(Date.now() - 90 * 86_400_000);
  const recent = await db.creditAnalysis.findMany({ where: { accountId: p.accountId, createdAt: { gte: since } }, select: { leadId: true } });
  const recentIds = Array.from(new Set(recent.map((r) => r.leadId)));
  const deptScope = p.scopeDepartmentIds.length ? { OR: [{ departmentId: { in: p.scopeDepartmentIds } }, { departmentId: null }] } : {};
  const leads = await db.lead.findMany({
    where: {
      accountId: p.accountId, archived: false, isGroup: false,
      pipeline: { AND: [deptScope, { department: { name: { contains: 'Home Equity', mode: 'insensitive' } } }] },
      OR: [{ status: 'OPEN', stage: { name: { startsWith: 'Pré-An', mode: 'insensitive' } } }, ...(recentIds.length ? [{ id: { in: recentIds } }] : [])],
    },
    select: {
      id: true, name: true, value: true, status: true, customFields: true, stageEnteredAt: true, aiAutoReplyActive: true,
      stage: { select: { name: true } }, pipeline: { select: { name: true } },
      creditAnalyses: { orderBy: { createdAt: 'desc' }, take: 60 },
      creditOverrides: { select: { bank: true, data: true } },
    },
    orderBy: { updatedAt: 'desc' },
    take: 300,
  });
  // Quando o card ENTROU na Pré-Análise (Fabio 14/10: "quero data e hora que o card entrou"): se está nela agora, é o `stageEnteredAt`; se já saiu
  // (aprovado/reprovado/movido), a anotação "Estágio: … → "Pré-Analise"" mais recente.
  const preNotes = await db.note.findMany({
    where: { leadId: { in: leads.map((l) => l.id) }, type: 'STAGE_CHANGE', content: { contains: '→ "Pré-An', mode: 'insensitive' } },
    orderBy: { createdAt: 'desc' }, select: { leadId: true, createdAt: true },
  });
  const preNoteAt = new Map<string, Date>();
  for (const n of preNotes) if (!preNoteAt.has(n.leadId)) preNoteAt.set(n.leadId, n.createdAt);
  const autoSetting = await db.creditAutoSetting.findUnique({ where: { accountId: p.accountId }, select: { enabled: true, enabledAt: true, paused: true } });
  return leads.map((l) => {
    const cf = (l.customFields || {}) as Record<string, any>;
    const preAnaliseAt = (l.status === 'OPEN' && /^pré-an/i.test(l.stage?.name || '') && l.stageEnteredAt) || preNoteAt.get(l.id) || null;
    const latest: Record<string, any> = latestPerBank(l.creditAnalyses); // já vem do mais novo pro mais antigo
    const byPart = latestByParticipant(l.creditAnalyses, cf, l.name);
    // Por que NÃO rodou (banco × participante sem análise): a tela mostra a frase no lugar de "Nenhuma análise ainda".
    const card = { name1: String(cf.participante_1 || l.name || ''), name2: String(cf.participante_2 || ''), cpf1: cf.cpf_1, cpf2: cf.cpf_2 };
    const inPre = l.status === 'OPEN' && /^pré-an/i.test(l.stage?.name || '');
    const porParticipante = (who: 1 | 2) => l.creditAnalyses.filter((a) => !a.dryRun && whichParticipant(card, a.holderName, a.holderCpf) === who);
    const notRun: Record<string, { p1?: string; p2?: string }> = {};
    for (const bk of BANK_KEYS) {
      const mk = (who: 1 | 2) => whyNotRun({ who, bank: bk, cf, inPre, stageEnteredAt: l.stageEnteredAt || null, settings: autoSetting, otherRows: porParticipante(who === 1 ? 2 : 1).filter((a) => a.bank === bk) });
      const o: { p1?: string; p2?: string } = {};
      if (!byPart.p1[bk] && !(card.name2 ? false : l.creditAnalyses.some((a) => a.bank === bk))) o.p1 = mk(1);
      if (card.name2 && !byPart.p2[bk]) o.p2 = mk(2);
      if (o.p1 || o.p2) notRun[bk] = o;
    }
    return {
      rejectionPending: (require('./credit-auto.service') as typeof import('./credit-auto.service')).rejectionPendingOf(l.creditAnalyses, { status: l.status, stage: l.stage?.name, aiOn: l.aiAutoReplyActive, paused: !!cf._autoPaused }),
      notRun,
      latestP1: byPart.p1,
      latestP2: byPart.p2,
      id: l.id,
      name: String(cf.participante_1 || l.name),
      stage: l.stage?.name || '',
      status: l.status,
      requested: { creditValue: Number(cf.valor_credito) || Number(l.value) || 0, propertyValue: Number(cf.valor_imovel) || 0, term: cf.prazo_financ || null },
      // Dados do card pra mostrar ao lado dos ajustes (a extensão lê a proposta na conversa; o card costuma bater).
      card: {
        name1: String(cf.participante_1 || l.name || ''), name2: String(cf.participante_2 || ''),
        cpf1: cf.cpf_1 ? String(cf.cpf_1) : '', cpf2: cf.cpf_2 ? String(cf.cpf_2) : '',
        income1: cf.renda_1 ? String(cf.renda_1) : '', income2: cf.renda_2 ? String(cf.renda_2) : '',
        propertyValue: cf.valor_imovel ? String(cf.valor_imovel) : '', creditValue: cf.valor_credito ? String(cf.valor_credito) : '',
        term: cf.prazo_financ ? String(cf.prazo_financ) : '',
      },
      overrides: Object.fromEntries(l.creditOverrides.map((o) => [o.bank, o.data])),
      inPre: l.status === 'OPEN' && /^pré-an/i.test(l.stage?.name || ''),
      autoPaused: !!cf._autoPaused,
      scr: cf._scrCreditas ? { status: cf._scrCreditas.status, at: cf._scrCreditas.at || null, askedAt: cf._scrCreditas.askedAt || null, sentAt: cf._scrCreditas.sentAt || null, creditasId: cf._scrCreditas.creditasId || null, holderName: cf._scrCreditas.holderName || null, holderCpf: cf._scrCreditas.holderCpf || null } : null,
      preAnaliseAt,
      ran: l.creditAnalyses.length > 0,
      lastRunAt: l.creditAnalyses[0]?.createdAt || null,
      latest,
      history: l.creditAnalyses,
      verdicts: buildVerdicts(l.creditAnalyses),
      chosenId: l.creditAnalyses.find((a) => a.chosen)?.id || null,
    };
  });
}

/** Resultados FINAIS (aprovou/reprovou) de cada banco por participante, do mais antigo ao mais novo, com o crédito pedido em cada um — pra ver "aprovou R$ 50 mil, depois com R$ 138 mil reprovou". */
function buildVerdicts(rows: Array<{ id: string; bank: string; status: string; dryRun: boolean; holderName: string | null; holderCpf: string | null; approvedValue: number | null; netValue: number | null; requestedValue: number | null; createdAt: Date; finishedAt: Date | null }>) {
  const positivo = (st: string) => st === 'APPROVED' || st === 'CONDITIONAL';
  const fin = rows.filter((r) => !r.dryRun && (positivo(r.status) || r.status === 'REJECTED')).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const first = (t?: string | null) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().split(/\s+/)[0] || 'titular';
  const lastByKey = new Map<string, (typeof fin)[number]>();
  const out: Array<{ id: string; bank: string; holderName: string | null; status: string; approvedValue: number | null; netValue: number | null; requestedValue: number | null; at: Date; flip: boolean }> = [];
  for (const r of fin) {
    const key = `${r.bank}|${r.holderCpf || first(r.holderName)}`;
    const prev = lastByKey.get(key);
    const igual = prev && prev.status === r.status && prev.approvedValue === r.approvedValue && prev.netValue === r.netValue && prev.requestedValue === r.requestedValue;
    if (igual) continue; // leitura repetida do mesmo resultado
    out.push({ id: r.id, bank: r.bank, holderName: r.holderName, status: r.status, approvedValue: r.approvedValue, netValue: r.netValue, requestedValue: r.requestedValue, at: r.finishedAt || r.createdAt, flip: !!prev && positivo(prev.status) !== positivo(r.status) });
    lastByKey.set(key, r);
  }
  return out.slice(-16);
}

/** "Conferir resultado" (Fabio 15/10): a extensão lê AGORA o resultado de uma proposta já enviada (cliente "Em análise"), sem esperar os 10 min da conferência automática e sem criar proposta nova.
 *  Adianta a conferência que já está na fila (notBefore = agora) ou cria uma; fica como pedido de PESSOA, então vale até com pausa geral ou cliente parado. */
export async function expediteCheck(db: Db, p: { accountId: string; leadId: string; bank: string; userId?: string }): Promise<{ mode: 'adiantada' | 'criada' | 'lendo'; detail: string }> {
  if (!BANK_KEYS.includes(p.bank) || !CHECK_BANKS.includes(p.bank)) throw new Error('banco inválido');
  const lead = await db.lead.findFirst({ where: { id: p.leadId, accountId: p.accountId }, select: { id: true } });
  if (!lead) throw new Error('card não encontrado');
  const abertas = await db.creditAnalysis.findMany({ where: { leadId: p.leadId, bank: p.bank, status: { in: ACTIVE } }, select: { id: true, kind: true, status: true } });
  if (abertas.some((a) => a.kind === 'CHECK' && a.status === 'RUNNING')) return { mode: 'lendo', detail: 'a extensão já está lendo o resultado agora' };
  const check = abertas.find((a) => a.kind === 'CHECK' && a.status === 'REQUESTED');
  if (check) {
    await db.creditAnalysis.update({ where: { id: check.id }, data: { notBefore: null, requestedById: p.userId || null } });
    return { mode: 'adiantada', detail: 'a conferência que estava marcada foi adiantada: a extensão lê na próxima consulta à fila (até ~1 min)' };
  }
  const out = await createRequests(db, { accountId: p.accountId, userId: p.userId, leadIds: [p.leadId], banks: [p.bank], dryRun: false, kind: 'CHECK' });
  if (!out.created) throw new Error('não deu pra pedir a conferência (nenhuma proposta enviada nesse banco?)');
  return { mode: 'criada', detail: 'conferência pedida: a extensão lê na próxima consulta à fila (até ~1 min)' };
}

/** STOP TOTAL só deste cliente (Fabio 14/10): derruba as rodadas em andamento, para conferências/refações/avisos/fechamento e a IA; o que uma PESSOA pedir continua valendo. Retomar volta tudo (inclusive a IA, se estava ligada). */
export async function setLeadAutoPause(db: Db, p: { accountId: string; leadId: string; paused: boolean; userId?: string; userName?: string }) {
  const lead = await db.lead.findFirst({ where: { id: p.leadId, accountId: p.accountId }, select: { id: true, customFields: true } });
  if (!lead) throw new Error('card não encontrado');
  const cf = { ...((lead.customFields || {}) as Record<string, any>) };
  const aiAntes = (await db.lead.findUnique({ where: { id: lead.id }, select: { aiAutoReplyActive: true } }))?.aiAutoReplyActive;
  if (p.paused) { cf._autoPaused = new Date().toISOString(); if (cf._autoPausedAiWas === undefined) cf._autoPausedAiWas = !!aiAntes; } else delete cf._autoPaused;
  const voltaIa = !p.paused && cf._autoPausedAiWas === true; // retomar devolve a IA do card ao estado de antes
  if (!p.paused) delete cf._autoPausedAiWas;
  await db.lead.update({ where: { id: lead.id }, data: { customFields: cf as any, ...(p.paused ? { aiAutoReplyActive: false } : voltaIa ? { aiAutoReplyActive: true } : {}) } });
  // Pausar NO MEIO do processo: as rodadas de RODAR que estão executando são derrubadas (a extensão recebe `cancel` no próximo passo e tira a aba do banco do meio do formulário).
  // Fica FAILED com "RODADA ANULADA" (a refação automática não mexe nisso); ao retomar a equipe decide: "Conferir" (se a proposta chegou a ser enviada) ou "Rodar de novo".
  // Conferências (só leitura) em andamento terminam sozinhas.
  let interrompidas = 0;
  if (p.paused) {
    const r = await db.creditAnalysis.updateMany({
      where: { leadId: lead.id, kind: 'RUN', status: 'RUNNING' },
      data: { status: 'FAILED', finishedAt: new Date(), detail: 'RODADA ANULADA: pausada pelo usuário no meio do processo. O banco pode ter ficado com um rascunho/proposta incompleta — ao retomar, use "Conferir" (se a proposta chegou a ser enviada) ou "Rodar de novo".' },
    });
    interrompidas = r.count;
    // Conferências (só leitura) que estavam rodando voltam pra fila (o relato delas é ignorado enquanto o cliente estiver parado) e continuam quando retomar.
    await db.creditAnalysis.updateMany({ where: { leadId: lead.id, kind: 'CHECK', status: 'RUNNING' }, data: { status: 'REQUESTED', startedAt: null } });
  }
  await db.note.create({ data: { leadId: lead.id, type: 'COMMENT', content: p.paused ? `⏹️ STOP TOTAL só pra este cliente${p.userName ? ` por ${p.userName}` : ''}${interrompidas ? ` — ${interrompidas} rodada(s) em andamento foram interrompidas no meio` : ''}: nada roda, refaz, confere, avisa nem responde sozinho (nem a IA) e o card não é movido sozinho até retomar.` : `▶️ Cliente RETOMADO${p.userName ? ` por ${p.userName}` : ''}: o automático volta a valer${voltaIa ? ' (a IA do card voltou a ficar ligada)' : ''}.` } }).catch(() => {});
  return { paused: p.paused, interrompidas };
}

// ─── Ajustes do cliente na análise (inverter titular, valores, renda, prazo) ───
export interface OverrideData {
  valorImovel?: string; valorEmprestimo?: string; renda?: string; prazo?: string; rendaParticipante?: string; inverter?: boolean;
}
const OVERRIDE_TEXT_KEYS = ['valorImovel', 'valorEmprestimo', 'renda', 'prazo', 'rendaParticipante'] as const;

/** Só as chaves conhecidas, texto curto, vazio some. */
export function cleanOverride(input: Record<string, any> | null | undefined): OverrideData {
  const out: OverrideData = {};
  for (const k of OVERRIDE_TEXT_KEYS) {
    const v = input?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') out[k] = String(v).trim().slice(0, 40);
  }
  if (input?.inverter === true) out.inverter = true;
  return out;
}

export async function getOverride(db: Db, p: { accountId: string; leadId: string; bank: string }) {
  const row = await db.creditOverride.findFirst({ where: { accountId: p.accountId, leadId: p.leadId, bank: p.bank } });
  return row ? (row.data as OverrideData) : null;
}

const OVERRIDE_LABEL: Record<string, string> = {
  valorImovel: 'valor do imóvel', valorEmprestimo: 'valor do financiamento', renda: 'renda', prazo: 'prazo', rendaParticipante: 'renda do 2º participante',
};

/** Grava (ou apaga, se ficar vazio) o ajuste do cliente nos bancos escolhidos. `merge` soma ao que já existe. */
export async function setOverrides(db: Db, p: { accountId: string; userId?: string; userName?: string; leadId: string; banks: string[]; data: Record<string, any>; merge?: boolean }) {
  const banks = p.banks.filter((b) => BANK_KEYS.includes(b));
  if (!banks.length) throw new Error('escolha pelo menos um banco');
  const lead = await db.lead.findFirst({ where: { id: p.leadId, accountId: p.accountId }, select: { id: true } });
  if (!lead) throw new Error('card não encontrado');
  const touched: string[] = [];
  for (const bank of banks) {
    const existing = await db.creditOverride.findFirst({ where: { leadId: p.leadId, bank } });
    const base = p.merge && existing ? (existing.data as Record<string, any>) : {};
    const next = cleanOverride({ ...base, ...p.data }); // inverter:false (desfazer) some aqui, só o true é guardado
    const empty = Object.keys(next).length === 0;
    if (empty) { if (existing) await db.creditOverride.delete({ where: { id: existing.id } }); continue; }
    if (existing) await db.creditOverride.update({ where: { id: existing.id }, data: { data: next as any, updatedById: p.userId || null } });
    else await db.creditOverride.create({ data: { accountId: p.accountId, leadId: p.leadId, bank, data: next as any, updatedById: p.userId || null } });
    touched.push(bank);
  }
  // Nota no card, pra ficar registrado o que foi mudado (sem a palavra "aprov" de propósito: não confunde o aviso de crédito aprovado).
  const first = touched[0] ? await db.creditOverride.findFirst({ where: { leadId: p.leadId, bank: touched[0] } }) : null;
  const d = (first?.data || {}) as OverrideData;
  const parts = [
    ...OVERRIDE_TEXT_KEYS.filter((k) => d[k]).map((k) => `${OVERRIDE_LABEL[k]}: ${d[k]}`),
    d.inverter ? 'titular e 2º participante invertidos' : '',
  ].filter(Boolean);
  const where = banks.map((b) => BANKS[b].label).join(', ');
  await db.note.create({
    data: {
      leadId: p.leadId, type: 'COMMENT',
      content: touched.length
        ? `✏️ Ajuste para a análise de crédito (${where})${p.userName ? ` por ${p.userName}` : ''}: ${parts.join(' · ')}. Vale na próxima vez que a análise rodar.`
        : `✏️ Ajustes da análise de crédito removidos (${where})${p.userName ? ` por ${p.userName}` : ''}.`,
    },
  });
  return { ok: true, banks: touched };
}

/** Bloco "Análises de crédito" dentro do card: último resultado de cada banco + histórico. */
export async function leadAnalyses(db: Db, p: { accountId: string; leadId: string; scopeDepartmentIds: string[] }) {
  const lead = await db.lead.findFirst({
    where: { id: p.leadId, accountId: p.accountId },
    select: { id: true, name: true, status: true, aiAutoReplyActive: true, stage: { select: { name: true } }, customFields: true, pipeline: { select: { name: true, departmentId: true, department: { select: { name: true } } } } },
  });
  if (!lead) return null;
  const deptId = lead.pipeline?.departmentId;
  if (p.scopeDepartmentIds.length && deptId && !p.scopeDepartmentIds.includes(deptId)) return null;
  await expireStuck(db, { accountId: p.accountId, leadId: p.leadId });
  const history = await db.creditAnalysis.findMany({ where: { leadId: p.leadId }, orderBy: { createdAt: 'desc' }, take: 30 });
  const latest: Record<string, any> = latestPerBank(history);
  const cf = (lead.customFields || {}) as Record<string, any>;
  const overrides = await db.creditOverride.findMany({ where: { leadId: p.leadId }, select: { bank: true, data: true } });
  // PROPOSTA QUE O CLIENTE VAI SEGUIR (Fabio 21/10, caso Edson do Carmo: aprovado R$ 50 mil no Santander, pediu R$ 55 mil, a nova rodada foi recusada e o card mostrava "Reprovado", sem a aprovação):
  // a escolhida (⭐) ou, sem escolha, a aprovada do único banco que aprovou. Depois da aprovação (Aguardando Documentação em diante) a tela mostra SÓ ela; as outras análises ficam atrás de um botão.
  const aprovadas = await db.creditAnalysis.findMany({ where: { leadId: p.leadId, dryRun: false, status: { in: ['APPROVED', 'CONDITIONAL'] }, approvedValue: { not: null }, source: { not: 'AI_SIM' } }, orderBy: { createdAt: 'desc' }, take: 12 });
  const bancosAprov = Array.from(new Set(aprovadas.map((r) => r.bank)));
  const baseSeguida = aprovadas.find((r) => r.chosen) || (bancosAprov.length === 1 ? aprovadas[0] : null) || null;
  // da mesma proposta, a leitura mais completa (a conferência posterior às vezes traz só valor e prazo; a da rodada traz taxa e parcelas)
  const followed = baseSeguida ? (aprovadas.find((r) => r.bank === baseSeguida.bank && r.proposalNumber === baseSeguida.proposalNumber && !!r.firstInstallment) || baseSeguida) : null;
  const posAprovacao = /aguardando documenta|fechado|documenta[cç][aã]o recebida|vistoria|an[aá]lise jur|registro em cart|pagamento|cr[eé]dito aprovado|cr[eé]dito em an/i.test(lead.stage?.name || '') || /contrata/i.test(lead.pipeline?.name || '');
  return {
    followed, onlyFollowed: !!followed && posAprovacao, autoPaused: !!cf._autoPaused,
    eligible: /home equity/i.test(lead.pipeline?.department?.name || ''),
    rejectionPending: (require('./credit-auto.service') as typeof import('./credit-auto.service')).rejectionPendingOf(history, { status: lead.status, stage: lead.stage?.name, aiOn: lead.aiAutoReplyActive, paused: !!(lead.customFields as any)?._autoPaused }),
    latest, ...(() => { const bp = latestByParticipant(history, cf, lead.name); return { latestP1: bp.p1, latestP2: bp.p2 }; })(), history, chosenId: history.find((a) => a.chosen)?.id || null,
    overrides: Object.fromEntries(overrides.map((o) => [o.bank, o.data])),
    participants: { name1: String(cf.participante_1 || lead.name || ''), name2: String(cf.participante_2 || ''), inverted: overrides.some((o) => (o.data as any)?.inverter === true) },
    cardProposal: propostaDoCard(cf),
  };
}

// ─── Métricas pro Dashboard (Fabio 14/10: aprovados por banco, tempo até o resultado, taxa de aprovação) ───
const DECIDED_OK = new Set(['APPROVED', 'CONDITIONAL']);
const PENDING = new Set(['REQUESTED', 'RUNNING', 'SENT', 'CHECK']);

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Métricas por mês e por banco. Conta UMA vez cada cliente×banco (o resultado mais recente já decidido; senão a linha mais
 *  recente) — refazer a análise do mesmo cliente no mesmo banco não infla os números. Teste e extensões em modo teste ficam de fora.
 *  Taxa de aprovação = aprovadas ÷ (aprovadas + reprovadas); "aprovada" inclui a condicional (o banco pede documentos).
 *  Tempo até o resultado = da 1ª solicitação do cliente naquele banco até o resultado final. */
export async function creditMetrics(db: Db, p: { accountId: string; scopeDepartmentIds: string[]; departmentId?: string; months: number }) {
  const monthKey = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' }).format(d);
  const [cy, cm] = monthKey(new Date()).split('-').map(Number);
  const keys: string[] = [];
  for (let i = p.months - 1; i >= 0; i--) {
    const y = cy + Math.floor((cm - 1 - i) / 12);
    const m = ((cm - 1 - i) % 12 + 12) % 12 + 1;
    keys.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  const from = new Date(`${keys[0]}-01T00:00:00-03:00`);
  const deptWhere = p.departmentId
    ? { departmentId: p.departmentId, ...(p.scopeDepartmentIds.length ? { AND: [{ departmentId: { in: p.scopeDepartmentIds } }] } : {}) }
    : (p.scopeDepartmentIds.length ? { departmentId: { in: p.scopeDepartmentIds } } : { departmentId: { not: null } });
  const rows = await db.creditAnalysis.findMany({
    where: { accountId: p.accountId, createdAt: { gte: from }, dryRun: false, status: { not: 'TEST' }, lead: { pipeline: deptWhere } },
    select: { leadId: true, bank: true, status: true, createdAt: true, finishedAt: true, updatedAt: true, source: true, detail: true, approvedValue: true, termMonths: true, rate: true, holderName: true, lead: { select: { name: true, customFields: true } } },
    orderBy: { createdAt: 'asc' },
  });
  // "Desqualificado" (o cliente não atende às regras daquele banco: mínimo do imóvel, terreno, saldo devedor…) vale como REPROVADO (Fabio 14/10).
  const OBJETIVA = /N[ÃA]O RODEI|n[aã]o conformidade|recusou antes de consultar|CPF j[aá] possui uma proposta ativa na Creditas/i;
  const reprovou = (r: { status: string; detail?: string | null }) => r.status === 'REJECTED' || (r.status === 'FAILED' && OBJETIVA.test(r.detail || ''));

  const out = keys.map((key) => {
    const [y, m] = key.split('-').map(Number);
    const label = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', month: 'long', year: 'numeric' }).format(new Date(`${key}-15T12:00:00-03:00`));
    // cliente×banco → linhas do mês (pelo mês da 1ª solicitação)
    const pairs = new Map<string, typeof rows>();
    for (const r of rows) {
      if (monthKey(r.createdAt) !== key) continue;
      const k = `${r.leadId}|${r.bank}`;
      pairs.set(k, [...(pairs.get(k) || []), r]);
    }
    const banks: Record<string, { analyzed: number; approved: number; conditional: number; rejected: number; pending: number; failed: number; decided: number; approvalRate: number | null; medianMinutes: number | null; avgMinutes: number | null }> = {};
    for (const b of BANK_KEYS) banks[b] = { analyzed: 0, approved: 0, conditional: 0, rejected: 0, pending: 0, failed: 0, decided: 0, approvalRate: null, medianMinutes: null, avgMinutes: null };
    const mins: Record<string, number[]> = Object.fromEntries(BANK_KEYS.map((b) => [b, [] as number[]]));
    const byLead = new Map<string, { ok: boolean; rejected: boolean; pending: boolean }>();
    // Listas de clientes (pra abrir no Dashboard): por banco e categoria, + "aprovou em algum banco" com os bancos.
    type Person = { leadId: string; name: string; status: string; approvedValue: number | null; termMonths: number | null; rate: string | null; holder: string | null; at: string };
    const people: Record<string, { approved: Person[]; rejected: Person[]; pending: Person[] }> = Object.fromEntries(BANK_KEYS.map((b) => [b, { approved: [], rejected: [], pending: [] }]));
    const approvedAny = new Map<string, { leadId: string; name: string; banks: { bank: string; status: string; approvedValue: number | null }[]; at: string }>();
    for (const [k, list] of Array.from(pairs.entries())) {
      const [leadId, bank] = k.split('|');
      if (!banks[bank]) continue;
      const decided = [...list].reverse().find((r) => DECIDED_OK.has(r.status) || reprovou(r));
      const rep = decided || list[list.length - 1];
      const b = banks[bank];
      b.analyzed++;
      const cfl = ((rep as any).lead?.customFields || {}) as Record<string, any>;
      const person: Person = { leadId, name: String(cfl.participante_1 || (rep as any).lead?.name || ''), status: rep.status, approvedValue: rep.approvedValue ?? null, termMonths: rep.termMonths ?? null, rate: rep.rate ?? null, holder: rep.holderName ?? null, at: (rep.finishedAt || rep.updatedAt || rep.createdAt).toISOString() };
      if (DECIDED_OK.has(rep.status)) {
        b.approved++; if (rep.status === 'CONDITIONAL') b.conditional++;
        people[bank].approved.push(person);
        const a = approvedAny.get(leadId) || { leadId, name: person.name, banks: [], at: person.at };
        a.banks.push({ bank, status: rep.status, approvedValue: person.approvedValue });
        if (person.at > a.at) a.at = person.at;
        approvedAny.set(leadId, a);
      }
      else if (reprovou(rep)) { b.rejected++; people[bank].rejected.push(person); }
      else if (PENDING.has(rep.status)) { b.pending++; people[bank].pending.push(person); }
      else b.failed++;
      if (decided && decided.finishedAt && list[0].source === 'EXTENSION') { // registro manual não mede tempo (não tem uma solicitação de verdade)
        const minutes = (decided.finishedAt.getTime() - list[0].createdAt.getTime()) / 60_000;
        if (minutes >= 0) mins[bank].push(minutes);
      }
      const l = byLead.get(leadId) || { ok: false, rejected: false, pending: false };
      if (DECIDED_OK.has(rep.status)) l.ok = true; else if (reprovou(rep)) l.rejected = true; else if (PENDING.has(rep.status)) l.pending = true;
      byLead.set(leadId, l);
    }
    for (const b of BANK_KEYS) for (const k of ['approved', 'rejected', 'pending'] as const) people[b][k].sort((a, c) => c.at.localeCompare(a.at));
    for (const b of BANK_KEYS) {
      const x = banks[b];
      x.decided = x.approved + x.rejected;
      x.approvalRate = x.decided ? Math.round((x.approved / x.decided) * 1000) / 10 : null;
      x.medianMinutes = median(mins[b]) === null ? null : Math.round(median(mins[b])! * 10) / 10;
      x.avgMinutes = mins[b].length ? Math.round((mins[b].reduce((a, c) => a + c, 0) / mins[b].length) * 10) / 10 : null;
    }
    const leads = Array.from(byLead.values());
    const clientsApproved = leads.filter((l) => l.ok).length;
    const clientsRejected = leads.filter((l) => !l.ok && l.rejected && !l.pending).length; // reprovado em todos os bancos que já responderam
    const allMins = BANK_KEYS.flatMap((b) => mins[b]);
    return {
      month: key, label,
      clientsAnalyzed: leads.length, clientsApproved, clientsRejected,
      clientsPending: leads.filter((l) => !l.ok && l.pending).length,
      people, approvedAny: Array.from(approvedAny.values()).sort((a, c) => c.at.localeCompare(a.at)),
      approvalRate: clientsApproved + clientsRejected ? Math.round((clientsApproved / (clientsApproved + clientsRejected)) * 1000) / 10 : null,
      medianMinutes: median(allMins) === null ? null : Math.round(median(allMins)! * 10) / 10,
      banks,
    };
  });
  return { rows: out.reverse() }; // mês mais novo primeiro, igual ao painel do mês
}

// ─── Trava única: uma extensão por vez usa o navegador ───
// As 3 extensões trabalham como uma pessoa (a aba do banco precisa ficar visível, senão o Chrome congela a página). Rodando
// juntas, cada uma puxa a aba pra frente e derruba a outra. Então elas pedem a vez aqui e esperam. A trava vence sozinha
// (10 min sem sinal) pra uma extensão travada/fechada não segurar a fila, e cada relato da extensão dona renova o prazo.
const LOCK_TTL_MS = 10 * 60 * 1000;
const locks = new Map<string, { bank: string; expiresAt: number }>();
export function acquireLock(accountId: string, bank: string): { ok: boolean; holder?: string } {
  const now = Date.now();
  const cur = locks.get(accountId);
  // Banco esperando LOGIN (CAPTCHA/código) não segura o navegador (Fabio 27/10, 1h: o Santander pediu login e a Creditas e o Inter ficaram parados a madrugada inteira).
  if (cur && cur.expiresAt > now && cur.bank !== bank && !loginNeededFor(accountId, cur.bank)) return { ok: false, holder: cur.bank };
  locks.set(accountId, { bank, expiresAt: now + LOCK_TTL_MS });
  return { ok: true };
}
export function releaseLock(accountId: string, bank: string) {
  const cur = locks.get(accountId);
  if (cur && cur.bank === bank) locks.delete(accountId);
}
export function renewLock(accountId: string, bank: string) {
  const cur = locks.get(accountId);
  if (cur && cur.bank === bank) cur.expiresAt = Date.now() + LOCK_TTL_MS;
}

// ─── Presença das extensões (quando cada uma buscou a fila pela última vez) ───
const lastSeen = new Map<string, { at: number; extId: string | null; userId: string | null }>();
const EXT_ID_RE = /^[a-p]{32}$/;
/** `extId` = id da extensão no Chrome, que o CRM usa pra avisá-la na hora (externally_connectable). */
export function touchExtension(accountId: string, bank: string, extId?: string | null, userId?: string | null) {
  const key = `${accountId}:${bank}`;
  const prev = lastSeen.get(key);
  // `userId` = o usuário do CRM com quem a extensão entrou (o dono do Chrome onde ela roda): é pra ele que vão os avisos da extensão (ex.: banco deslogado).
  lastSeen.set(key, { at: Date.now(), extId: extId && EXT_ID_RE.test(extId) ? extId : prev?.extId || null, userId: userId || prev?.userId || null });
}
export function extensionStatus(accountId: string): Record<string, { lastSeenAt: string | null; online: boolean; extId: string | null; loginNeeded: boolean }> {
  const out: Record<string, { lastSeenAt: string | null; online: boolean; extId: string | null; loginNeeded: boolean }> = {};
  for (const bank of BANK_KEYS) {
    const seen = lastSeen.get(`${accountId}:${bank}`);
    out[bank] = { lastSeenAt: seen ? new Date(seen.at).toISOString() : null, online: !!seen && Date.now() - seen.at < 3 * 60 * 1000, extId: seen?.extId || null, loginNeeded: loginNeeded.has(`${accountId}:${bank}`) };
  }
  return out;
}

/** Painel "o que cada extensão está fazendo agora" (Fabio 19/10: "um painel lá no início com o logo de cada banco, a extensão mostrando qual cliente ela está rodando" e depois "coloca os que estão
 *  na fila também, os que estão rodando e os que foram rodados"). Só leitura. */
export async function extensionsLive(db: Db, accountId: string) {
  const ext = extensionStatus(accountId);
  const out: any[] = [];
  const agora = new Date();
  const passoDe = (steps: unknown) => {
    const arr = ((steps as any[]) || []).filter((x) => x && x.s);
    const last = arr[arr.length - 1];
    return { step: last ? String(last.s).replace(/^passo:\s*/i, '').replace(/\s*\(\d+ s depois de abrir a proposta\)$/, '').slice(0, 120) : null, stepAt: last?.t || null };
  };
  for (const bank of BANK_KEYS) {
    const running = await db.creditAnalysis.findMany({
      where: { accountId, bank, status: 'RUNNING', dryRun: false }, orderBy: { startedAt: 'desc' }, take: 3,
      select: { id: true, leadId: true, kind: true, startedAt: true, steps: true, holderName: true, lead: { select: { name: true } } },
    });
    const pronta = { accountId, bank, status: 'REQUESTED', dryRun: false, OR: [{ notBefore: null }, { notBefore: { lte: agora } }] };
    // Fila (Fabio 21/10: "quero que mostre no painel os clientes que estão na fila"): análises (RODAR) primeiro e depois as conferências, cada grupo por ordem de pedido — antes as conferências antigas
    // ocupavam os 12 lugares e escondiam quem estava esperando pra rodar. As conferências agendadas (daqui a alguns minutos) também aparecem com o nome e a hora, não só o número.
    const queue = await db.creditAnalysis.findMany({ where: pronta, orderBy: [{ kind: 'desc' }, { requestedAt: 'asc' }], take: 20, select: { id: true, leadId: true, kind: true, requestedAt: true, requestedById: true, detail: true, lead: { select: { name: true } } } });
    const queuedTotal = await db.creditAnalysis.count({ where: pronta });
    const queuedRuns = await db.creditAnalysis.count({ where: { ...pronta, kind: 'RUN' } });
    const agendadasLista = await db.creditAnalysis.findMany({ where: { accountId, bank, status: 'REQUESTED', dryRun: false, notBefore: { gt: agora } }, orderBy: { notBefore: 'asc' }, take: 10, select: { id: true, leadId: true, kind: true, notBefore: true, lead: { select: { name: true } } } });
    const agendadas = await db.creditAnalysis.count({ where: { accountId, bank, status: 'REQUESTED', dryRun: false, notBefore: { gt: agora } } });
    const recent = await db.creditAnalysis.findMany({
      where: { accountId, bank, finishedAt: { not: null }, dryRun: false }, orderBy: { finishedAt: 'desc' }, take: 10,
      select: { id: true, leadId: true, kind: true, status: true, startedAt: true, finishedAt: true, lead: { select: { name: true } } },
    });
    out.push({
      bank, online: ext[bank].online, loginNeeded: ext[bank].loginNeeded, lastSeenAt: ext[bank].lastSeenAt, foraDoHorario: foraDoHorario(),
      running: running.map((r) => ({ id: r.id, leadId: r.leadId, leadName: String((r.lead as any)?.name || ''), kind: r.kind, holderName: r.holderName || null, since: r.startedAt, ...passoDe(r.steps) })),
      queue: queue.map((r) => ({ id: r.id, leadId: r.leadId, leadName: String((r.lead as any)?.name || ''), kind: r.kind, since: r.requestedAt, manual: !!r.requestedById, aguardandoLogin: /aguardando login/i.test(r.detail || '') })),
      queued: queuedTotal, queuedRuns, scheduled: agendadas,
      scheduledList: agendadasLista.map((r) => ({ id: r.id, leadId: r.leadId, leadName: String((r.lead as any)?.name || ''), kind: r.kind, at: r.notBefore })),
      recent: recent.map((r) => ({ id: r.id, leadId: r.leadId, leadName: String((r.lead as any)?.name || ''), kind: r.kind, status: r.status, at: r.finishedAt, durationMin: r.startedAt && r.finishedAt ? Math.round((r.finishedAt.getTime() - r.startedAt.getTime()) / 60000) : null })),
    });
  }
  return out;
}

// ─── Sessão do banco VENCIDA (Fabio 19/10) ──────────────────────────────────────────────────────────
// O Credimorar derruba a sessão de madrugada (login exige CAPTCHA + código por e-mail, só uma pessoa faz). Antes, a 1ª análise da manhã falhava, o CRM refazia 3 vezes e marcava "Falhou"
// por até 3 h sem avisar ninguém. Agora a extensão avisa "preciso de login", o pedido VOLTA pra fila (nada de "Falhou"/tentativa gasta), a tela mostra "deslogada" e a equipe recebe push.
const loginNeeded = new Map<string, number>(); // `${accountId}:${bank}` → início do episódio
const lastLoginAlert = new Map<string, number>();
const LOGIN_ALERT_GAP_MS = 45 * 60_000;
const BANK_LABEL: Record<string, string> = { INTER: 'Inter', CREDITAS: 'Creditas', CREDIMORAR: 'Santander (Credimorar)' };
export const loginNeededFor = (accountId: string, bank: string) => loginNeeded.has(`${accountId}:${bank}`);
/** Liga/desliga o estado "preciso de login" do banco. Devolve true quando um episódio NOVO começou. */
export function setLoginNeeded(accountId: string, bank: string, needed: boolean): boolean {
  const k = `${accountId}:${bank}`;
  if (!needed) { loginNeeded.delete(k); return false; }
  if (loginNeeded.has(k)) return false;
  loginNeeded.set(k, Date.now());
  return true;
}
/** Push pra equipe pedindo o login — no máximo 1 a cada 45 min por banco, e só no horário das extensões (07h–22h). */
export function alertLoginNeeded(accountId: string, bank: string): void {
  const k = `${accountId}:${bank}`;
  if (foraDoHorario() || Date.now() - (lastLoginAlert.get(k) || 0) < LOGIN_ALERT_GAP_MS) return;
  lastLoginAlert.set(k, Date.now());
  try {
    const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
    // Só pra quem tem a extensão (o usuário com quem ela entrou no CRM), e só no computador dele — a Andreia e os celulares não recebem (Fabio 19/10).
    const dono = lastSeen.get(k)?.userId;
    if (!dono) return;
    sendPushToAccount(accountId, { title: `🔐 ${BANK_LABEL[bank] || bank} deslogado`, body: 'A sessão do portal venceu: entre nele (CAPTCHA + código por e-mail) pras análises continuarem. Os clientes ficaram na fila — nada se perdeu.', url: '/analise-credito' }, [dono], { desktopOnly: true }).catch(() => {});
  } catch { /* push é extra */ }
}
/** A extensão bateu na tela de login: o pedido que ela estava rodando volta pra fila (sem falha e sem gastar tentativa) até alguém entrar no portal. */
export async function holdRunForLogin(db: Db, p: { accountId: string; requestId?: string; leadId: string; bank: string }): Promise<void> {
  const row = (p.requestId ? await db.creditAnalysis.findFirst({ where: { id: p.requestId, accountId: p.accountId, leadId: p.leadId } }) : null)
    || await db.creditAnalysis.findFirst({ where: { accountId: p.accountId, leadId: p.leadId, bank: p.bank, status: { in: ['RUNNING', 'REQUESTED'] } }, orderBy: { createdAt: 'desc' } });
  if (row && ['RUNNING', 'REQUESTED'].includes(row.status)) {
    await db.creditAnalysis.update({ where: { id: row.id }, data: { status: 'REQUESTED', startedAt: null, notBefore: null, detail: `Aguardando login no ${BANK_LABEL[p.bank] || p.bank}: a sessão do portal venceu — entre no portal (CAPTCHA + código por e-mail) que a análise segue sozinha.` } });
  }
  releaseLock(p.accountId, p.bank);
}


// ═══ IA da conversa × extensões (Fabio 13/10: "sempre que a IA responder o cliente, consultar agora no sistema, usando a extensão") ═══

/** Taxa MENSAL (%) lida do texto da análise ("1,09% a.m. + IPCA", "1.40% a.m.", "13,89% a.a."). null = não informou. */
export function monthlyRatePct(text?: string | null): number | null {
  const m = /(\d+(?:[.,]\d+)?)\s*%/.exec(String(text || ''));
  if (!m) return null;
  const v = Number(m[1].replace(',', '.'));
  if (!Number.isFinite(v) || v <= 0) return null;
  return /a\.?\s*a\b|ao ano|anual/i.test(String(text)) ? (Math.pow(1 + v / 100, 1 / 12) - 1) * 100 : v;
}

/** Ordem fixa de preferência dos bancos (Fabio 14/10): Inter primeiro, Creditas segundo, Santander terceiro. */
const SIM_BANK_PRIORITY: Record<string, number> = { INTER: 0, CREDITAS: 1, CREDIMORAR: 2 };
const simPriority = (bank: string) => SIM_BANK_PRIORITY[bank] ?? 9;

/** Banco cuja simulação em PDF vai pro cliente: só UM — a proposta que o cliente ESCOLHEU (`chosen`) ou, sem escolha, o primeiro na ordem
 *  Inter > Creditas > Santander entre os aprovados (Fabio 14/10: "não há taxa alta, segue a ordem dos bancos"). */
export function pickSimulationBank(all: Array<{ bank: string; rate?: string | null; chosen?: boolean; firstInstallment?: number | null }>): { bank: string; why: string } | null {
  // CREDITAS não tem evolução das parcelas feita por eles (Fabio 15/10): nunca vai PDF — só a mensagem de aprovação.
  const approved = all.filter((a) => a.bank !== 'CREDITAS');
  if (!approved.length) return null;
  const chosen = approved.find((a) => a.chosen);
  if (chosen) return { bank: chosen.bank, why: 'proposta escolhida' };
  if (approved.length === 1) return { bank: approved[0].bank, why: 'única aprovada' };
  const first = [...approved].sort((x, y) => simPriority(x.bank) - simPriority(y.bank))[0];
  return { bank: first.bank, why: 'ordem Inter > Santander' };
}

const BANK_LABEL_IA: Record<string, string> = { INTER: 'Inter', CREDITAS: 'Creditas', CREDIMORAR: 'Santander' };
const PERGUNTA_DE_STATUS = /(anali[sz]|aprov|resultad|retorno|saiu|sair|reprov|negad|deu certo|j[aá] sai|como (est|t[aá])|novidade|andamento|cr[eé]dito|propost|simula|banco|parcela|liberad|taxa|prazo)/i;

/** Texto pra IA da conversa: a leitura MAIS RECENTE de cada banco (por participante), com "lido há N min". Vazio se o cliente nunca foi rodado. */
export async function aiCreditContext(db: Db, leadId: string): Promise<string> {
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  if (!lead) return '';
  const cf = (lead.customFields || {}) as Record<string, any>;
  const rows = await db.creditAnalysis.findMany({
    where: { leadId, dryRun: false, createdAt: { gte: new Date(Date.now() - 60 * 86_400_000) }, status: { notIn: ['REQUESTED', 'RUNNING', 'TEST'] } },
    orderBy: { createdAt: 'desc' }, take: 40,
  });
  if (!rows.length) {
    // Análise pedida mas ainda sem NENHUM resultado lido (fila/rodando): a IA não pode agir como se a proposta não existisse (José Roberto 19/10: o cliente voltou a preencher o
    // formulário porque a IA mandou "preencha os campos que faltam" com a análise já rodando).
    const emAndamento = await db.creditAnalysis.count({ where: { leadId, dryRun: false, createdAt: { gte: new Date(Date.now() - 60 * 86_400_000) }, status: { in: ['REQUESTED', 'RUNNING'] } } });
    if (!emAndamento) return '';
    return 'ANÁLISE DE CRÉDITO DESTE CLIENTE: a proposta dele JÁ FOI RECEBIDA (veio do formulário do site) e a análise nos bancos está EM ANDAMENTO, ainda sem resultado. NÃO peça pra preencher a proposta, NÃO mande "preencher os campos que faltam" e NÃO diga "me avisa quando terminar". Se ele estiver preenchendo o formulário de novo, diga que não precisa: já recebemos. Se perguntar, diga que está em análise e que você avisa assim que sair o resultado (sem prazo exato).';
  }
  // Leitura que FALHOU (ex.: conferência que travou) não pode esconder o último resultado conhecido: só entra se não houver nada melhor.
  // A nova proposta que o CLIENTE pediu (outro prazo/valor) e NÃO foi aprovada não apaga a aprovação anterior no que a IA enxerga (a equipe é avisada por nota).
  const bons = latestByParticipant(rows.filter((r) => r.status !== 'FAILED' && !(r.source === 'AI_CHANGE' && r.status === 'REJECTED')), cf);
  const ruins = latestByParticipant(rows.filter((r) => r.status === 'FAILED'), cf);
  const p1 = { ...ruins.p1, ...bons.p1 };
  const p2 = { ...ruins.p2, ...bons.p2 };
  const agora = Date.now();
  const ha = (d: Date) => { const m = Math.max(0, Math.round((agora - d.getTime()) / 60000)); return m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} dia(s)`; };
  const descreve = (r: any): string => {
    const aMenor = /aprovad[oa] a menor/i.test(r.detail || '');
    switch (r.status) {
      case 'APPROVED': {
        const partes = [
          r.netValue ? `valor líquido ${brl(r.netValue)}` : r.approvedValue ? `valor ${brl(r.approvedValue)}` : '',
          r.termMonths ? `${r.termMonths} meses` : '', r.rate ? `taxa ${r.rate}` : '',
          r.firstInstallment ? `1ª parcela ${brl(r.firstInstallment)}` : '', r.lastInstallment ? `última parcela ${brl(r.lastInstallment)}` : '',
        ].filter(Boolean);
        const docs = aMenor ? parseDocumentosExigidos(r.detail) : null;
        const docsTxt = docs ? `. Para seguir com esse valor o banco exige comprovação de renda${docs.perfil ? ` (perfil ${docs.perfil})` : ''} — documentos: ${docs.itens.join('; ')} (peça ao cliente)` : '';
        // Fabio 19/10 (Jézer): no Inter, aprovado a menor num prazo menor que o máximo → a IA explica que NO PRAZO veio a menor e aconselha o prazo todo (aprovação melhor).
        const prazoTxt = aMenor && r.bank === 'INTER' && r.termMonths && r.termMonths < 240
          ? `. ORIENTE o cliente: no prazo de ${r.termMonths} meses a aprovação veio a menor que o pedido e você aconselha pegar o PRAZO TODO (240 meses) para conseguir uma aprovação melhor; se ele aceitar o prazo todo, peça a nova proposta com "simulate" {"prazo": 240}`
          : '';
        return `${aMenor ? 'APROVADO A MENOR (valor menor que o pedido)' : 'APROVADO'}${partes.length ? `: ${partes.join(', ')}` : ' (os números ainda não foram lidos)'}${docsTxt}${prazoTxt}`;
      }
      case 'CONDITIONAL': return 'APROVADO COM CONDIÇÃO — o banco pede documentos para seguir';
      case 'REJECTED': return 'REPROVADO';
      case 'SENT': {
        if (SANTANDER_MANUAL.test(r.detail || '')) {
          const dd = (parseDocumentosExigidos(r.detail)?.itens || []).map(docDoPortal);
          return `NÃO PASSOU NA ANÁLISE AUTOMÁTICA — o banco liberou ANÁLISE MANUAL e só segue com os documentos do cliente${dd.length ? ` (${dd.join('; ')})` : ''}. Peça/confirme esses documentos; quando chegarem, a EQUIPE anexa no portal e envia ao banco. NÃO diga que foi aprovado`;
        }
        return 'ENVIADO ao banco, EM ANÁLISE — ainda sem resultado';
      }
      case 'INCOMPLETE': return 'EM ANÁLISE — o banco pediu mais dados do cliente (a equipe está completando)';
      case 'CHECK': return 'EM ANÁLISE — ainda sem resultado conclusivo';
      default: return 'NÃO ANALISADO nesse banco (assunto interno: não explique o motivo ao cliente)';
    }
  };
  const linhas: string[] = [];
  for (const [bucket, quem] of [[p1, ''], [p2, ' [análise no nome do 2º participante]']] as [Record<string, any>, string][]) {
    for (const bank of ['CREDIMORAR', 'CREDITAS', 'INTER']) {
      const r = bucket[bank];
      if (r) linhas.push(`- ${BANK_LABEL_IA[bank]}${quem}: ${descreve(r)} (lido há ${ha(r.updatedAt)})`);
    }
  }
  const aprovados = Object.entries(p1).filter(([, r]: [string, any]) => r && (r.status === 'APPROVED' || r.status === 'CONDITIONAL') && r.approvedValue != null).map(([bank, r]: [string, any]) => ({ bank, rate: r.rate, chosen: r.chosen, firstInstallment: r.firstInstallment }));
  const escolha = aprovados.length >= 2 ? pickSimulationBank(aprovados) : null;
  if (escolha) linhas.push(`- Simulação em PDF: ${aprovados.some((a) => a.chosen) ? 'o cliente já escolheu' : 'se o cliente ainda não escolheu, mande só a do primeiro banco na ordem Inter, Creditas, Santander'} → ${BANK_LABEL_IA[escolha.bank]} (${escolha.why}).`);
  if (!linhas.length) return '';
  // Fabio 20/10: a IA precisa saber que renda só vale quando Santander/Creditas estão em jogo (o Inter não pede).
  const jogo = await bancosEmJogo(db, leadId).catch(() => null);
  if (jogo && !jogo.rendaNecessaria) linhas.push('- DOCUMENTOS DE RENDA: a equipe DISPENSOU a renda deste cliente (ele não vai seguir pelo banco que pedia). NÃO peça nem cobre renda e, se ele já mandou, não aponte problema nela.');
  return `ANÁLISE DE CRÉDITO DESTE CLIENTE (leitura dos portais dos bancos feita pela extensão do Chrome; entre parênteses, há quanto tempo foi lida):\n${linhas.join('\n')}`;
};

/** Cliente perguntou da análise: pede uma LEITURA NOVA (só leitura, não cria proposta) nos bancos já rodados e espera a extensão
 *  ler (até maxWaitMs). A extensão busca pedidos a cada ~1 min, então leva de 1 a 2 min. Nunca lança erro. */
export async function refreshAnalysesForAi(db: Db, p: { accountId: string; leadId: string; text: string; maxWaitMs?: number }): Promise<{ asked: boolean; waited: boolean }> {
  try {
    if (process.env.AI_SKIP_REFRESH === '1') return { asked: false, waited: false }; // só pra teste (não cria pedido nas extensões)
    if (!PERGUNTA_DE_STATUS.test(String(p.text || ''))) return { asked: false, waited: false };
    const ran = await db.creditAnalysis.findMany({
      where: { leadId: p.leadId, dryRun: false, status: { in: REAL_SENT }, createdAt: { gt: new Date(Date.now() - 60 * 86_400_000) } },
      orderBy: { updatedAt: 'desc' }, select: { bank: true, updatedAt: true },
    });
    const banks = Array.from(new Set(ran.map((r) => r.bank))).filter((b) => CHECK_BANKS.includes(b));
    if (!banks.length) return { asked: false, waited: false };
    // leitura recente (menos de 10 min) em todos os bancos: não precisa de outra
    const ultimaPorBanco = new Map<string, number>();
    for (const r of ran) if (!ultimaPorBanco.has(r.bank)) ultimaPorBanco.set(r.bank, r.updatedAt.getTime());
    const precisa = banks.filter((b) => Date.now() - (ultimaPorBanco.get(b) || 0) > 10 * 60_000);
    if (precisa.length) await createRequests(db, { accountId: p.accountId, leadIds: [p.leadId], banks: precisa, dryRun: false, kind: 'CHECK', source: 'AI' });
    // espera as leituras abertas (as que acabei de pedir e as que já estavam na fila)
    const abertas = await db.creditAnalysis.findMany({ where: { leadId: p.leadId, kind: 'CHECK', status: { in: ['REQUESTED', 'RUNNING'] }, updatedAt: { gt: new Date(Date.now() - 25 * 60_000) } }, select: { id: true, attempt: true } });
    if (!abertas.length) return { asked: precisa.length > 0, waited: false };
    const limite = Date.now() + (p.maxWaitMs ?? 120_000);
    while (Date.now() < limite) {
      await new Promise((r) => setTimeout(r, 4000));
      const agora = await db.creditAnalysis.findMany({ where: { id: { in: abertas.map((a) => a.id) } }, select: { id: true, status: true, attempt: true } });
      const pendente = agora.some((r) => {
        const antes = abertas.find((a) => a.id === r.id)!;
        return ['REQUESTED', 'RUNNING'].includes(r.status) && r.attempt <= antes.attempt;
      });
      if (!pendente) return { asked: true, waited: true };
    }
    return { asked: true, waited: true };
  } catch (err: any) {
    console.error('[IA × análise] não consegui renovar a leitura:', err?.message);
    return { asked: false, waited: false };
  }
}

// ─── Prazo ou valor DIFERENTE depois da aprovação (Fabio 19/10, Jézer): "se foi aprovado um valor com um prazo X e o cliente pedir outro prazo ou outro valor, a extensão deve
// rodar NOVA PROPOSTA com o que ele pediu; se vier menor, encaminha a aprovação e informa que NO PRAZO X foi aprovado a menor — vale pra qualquer banco".
// (Antes a IA pedia só uma simulação de teste no Inter com o valor aprovado — que não mostrava o que o banco APROVA no novo prazo.)
const CHANGE_ROW_SOURCE = 'AI_CHANGE';

const fmtBRL = (n: number) => `R$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A IA marca `simulate` {prazo?, valor?}: o CRM guarda o prazo/valor como ajuste dos bancos que já aprovaram (o escolhido pelo cliente, senão todos) e pede uma análise REAL nova.
 *  Creditas não deixa escolher prazo (o portal oferece as opções): numa troca só de prazo ele fica de fora. O resultado vira o aviso padrão de aprovação (finishProposalChange). */
export async function requestProposalChangeForAi(db: Db, accountId: string, leadId: string, p: { prazo?: number; valor?: number }): Promise<{ ok: boolean; detail: string }> {
  const prazo = p.prazo ? Math.round(Number(p.prazo)) : 0;
  const valor = p.valor ? Math.round(Number(p.valor)) : 0;
  if (!prazo && !valor) return { ok: false, detail: 'sem prazo nem valor pra analisar' };
  if (prazo && !(prazo >= 60 && prazo <= 240)) return { ok: false, detail: `prazo de ${p.prazo} meses fora do que os bancos aceitam (60 a 240)` };
  const set = await db.creditAutoSetting.findUnique({ where: { accountId } });
  if (!set?.enabled) return { ok: false, detail: 'a "Análise automática" do CRM está desligada' };
  if (set.paused) return { ok: false, detail: 'a pausa geral das execuções automáticas está ligada' };
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { status: true, archived: true, customFields: true, pipeline: { select: { department: { select: { name: true } } } } } });
  if (!lead || lead.status !== 'OPEN' || lead.archived) return { ok: false, detail: 'o card não está aberto' };
  if (!/home equity/i.test(lead.pipeline?.department?.name || '')) return { ok: false, detail: 'só vale para Home Equity' };
  if ((lead.customFields as any)?._autoPaused) return { ok: false, detail: 'este cliente está PAUSADO na Análise de Crédito (botão da tela)' };
  const aprovadas = await db.creditAnalysis.findMany({ where: { leadId, dryRun: false, status: { in: ['APPROVED', 'CONDITIONAL'] }, createdAt: { gt: new Date(Date.now() - 60 * 86_400_000) } }, orderBy: { createdAt: 'desc' }, take: 12, select: { bank: true, chosen: true, termMonths: true, approvedValue: true, detail: true } });
  if (!aprovadas.length) return { ok: false, detail: 'o cliente não tem banco aprovado (use a análise normal)' };
  const escolhido = aprovadas.find((a) => a.chosen)?.bank;
  const candidatos = escolhido ? [escolhido] : Array.from(new Set(aprovadas.map((a) => a.bank)));
  const motivos: string[] = [];
  const bancos = candidatos.filter((b) => {
    // Aprovou A MENOR (Fabio 26/10): pedir valor MAIOR que a aprovação não adianta — o banco já deu o máximo. Só vale prazo diferente (aprovação costuma subir com prazo maior).
    const ap = aprovadas.find((a) => a.bank === b);
    if (valor && ap && ap.approvedValue && /aprovad[oa] a menor/i.test(String(ap.detail || '')) && valor > Number(ap.approvedValue) && !(prazo && ap.termMonths && prazo > ap.termMonths)) {
      motivos.push(`${BANKS[b]?.label || b} já aprovou a menor (${fmtBRL(Number(ap.approvedValue))}) e não aprova mais que isso`); return false;
    }
    if (prazo && !valor && b === 'CREDITAS') { motivos.push('Creditas não deixa escolher o prazo'); return false; }
    if (prazo && !valor && aprovadas.find((a) => a.bank === b)?.termMonths === prazo) { motivos.push(`${BANKS[b]?.label || b} já foi analisado em ${prazo} meses`); return false; }
    return true;
  });
  if (!bancos.length) return { ok: false, detail: motivos.join('; ') || 'nenhum banco pra refazer' };
  const data: Record<string, any> = {};
  if (prazo) data.prazo = String(prazo);
  if (valor) data.valorEmprestimo = fmtBRL(valor).replace('R$ ', '');
  await setOverrides(db, { accountId, leadId, banks: bancos, data, merge: true, userName: 'IA (pedido do cliente)' });
  const r = await createRequests(db, { accountId, leadIds: [leadId], banks: bancos, dryRun: false, kind: 'RUN', source: CHANGE_ROW_SOURCE, force: true, alignApproval: true });
  if (!r.created) return { ok: false, detail: 'já havia análise em andamento' };
  const ped = [prazo && `${prazo} meses`, valor && fmtBRL(valor)].filter(Boolean).join(' e ');
  { // o que o cliente pediu, em palavras: entra no aviso ("rodei a nova proposta com o prazo de 180 meses…")
    const f = await db.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
    const cf2: Record<string, any> = { ...((f?.customFields || {}) as Record<string, any>) };
    cf2._changeAsk = [prazo && `o prazo de ${prazo} meses`, valor && `o valor de ${fmtBRL(valor)}`].filter(Boolean).join(' e ');
    // As linhas desta rodada: o resultado de Inter/Creditas chega numa conferência (CHECK) da proposta enviada, não na linha de quem enviou — por isso a rodada é acompanhada por aqui.
    const ids = (await db.creditAnalysis.findMany({ where: { leadId, source: CHANGE_ROW_SOURCE, kind: 'RUN', status: 'REQUESTED' }, select: { id: true } })).map((x) => x.id);
    cf2._changeRound = { ids, at: new Date().toISOString() };
    await db.lead.update({ where: { id: leadId }, data: { customFields: cf2 as any } });
  }
  return { ok: true, detail: `análise NOVA pedida a ${bancos.map((b) => BANKS[b]?.label || b).join(', ')} com ${ped}${motivos.length ? ` (fora: ${motivos.join('; ')})` : ''}` };
}

/** Acompanha a rodada pedida pelo cliente (outro prazo/valor) e, quando TODOS os bancos dela responderam, entrega: o aviso padrão de aprovação sai pelo mesmo caminho de sempre
 *  (noticeClients → só com a IA do card ligada, senão o botão "Avisar cliente"), agora como "rodei a nova proposta". Se SÓ vieram recusas o card NÃO fecha: o CRM avisa o cliente
 *  da negativa e repete a aprovação que continua valendo (Fabio 19/10). Chamada a cada linha que termina; sai logo se o card não tem rodada aberta (`_changeRound`).
 *  O resultado de Inter/Creditas vem numa conferência (CHECK) da proposta enviada — a linha de quem enviou fica "enviada" — por isso olhamos as duas. */
export async function finishProposalChange(db: Db, leadId: string): Promise<void> {
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { accountId: true, status: true, aiAutoReplyActive: true, customFields: true } });
  const cf: Record<string, any> = { ...((lead?.customFields || {}) as Record<string, any>) };
  const round = cf._changeRound as { ids?: string[]; at?: string } | undefined;
  if (!lead || !round?.ids?.length) return;
  const nota = (content: string) => db.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});
  const salvar = async (mexe: (c: Record<string, any>) => void) => { // relê o card: o aviso de recusa pode ter mexido nas marcas enquanto isso
    const f = await db.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
    const c: Record<string, any> = { ...((f?.customFields || {}) as Record<string, any>) }; mexe(c);
    await db.lead.update({ where: { id: leadId }, data: { customFields: c as any } });
  };
  if (Date.now() - new Date(round.at || 0).getTime() > 72 * 3_600_000) { // banco nunca respondeu: desiste de acompanhar
    await nota('⚠️ A nova proposta pedida pelo cliente (outro prazo/valor) ficou 72 h sem resposta de algum banco. Confira na aba Análise de Crédito.');
    await salvar((c) => { delete c._changeRound; delete c._changeAsk; });
    return;
  }
  const runs = await db.creditAnalysis.findMany({ where: { id: { in: round.ids } }, select: { leadId: true, bank: true, status: true, detail: true, proposalNumber: true, createdAt: true } });
  const veredito: { bank: string; status: string; detail: string | null }[] = [];
  for (const r of runs) {
    if (ACTIVE.includes(r.status)) return; // ainda rodando
    if (r.status === 'SENT') { // enviada: o resultado vem numa conferência da mesma proposta
      const c = await db.creditAnalysis.findFirst({
        where: { leadId, bank: r.bank, dryRun: false, createdAt: { gte: r.createdAt }, status: { in: ['APPROVED', 'CONDITIONAL', 'REJECTED'] }, ...(r.proposalNumber ? { proposalNumber: r.proposalNumber } : {}) },
        orderBy: { createdAt: 'desc' }, select: { status: true, detail: true },
      });
      if (!c) return; // o banco ainda não respondeu
      veredito.push({ bank: r.bank, ...c });
    } else veredito.push({ bank: r.bank, status: r.status, detail: r.detail });
  }
  const aprovou = veredito.filter((v) => v.status === 'APPROVED' || v.status === 'CONDITIONAL');
  const naoAprovou = veredito.filter((v) => !aprovou.includes(v));
  for (const v of naoAprovou) {
    const motivo = String(v.detail || '').replace(/Titular na análise:[^.]*\.\s*/i, '').replace(/\s+/g, ' ').trim().slice(0, 240);
    await nota(`⚠️ A nova proposta pedida pelo cliente (outro prazo/valor) NÃO foi aprovada no ${BANKS[v.bank]?.label || v.bank} (${v.status}${motivo ? `: ${motivo}` : ''}). A aprovação anterior continua valendo.`);
  }
  if (!aprovou.length) {
    // Só recusas: o card NÃO fecha. Falha técnica (login, página recarregou…) não é recusa: fica só a nota de cima.
    const objetiva = /N[ÃA]O RODEI|n[aã]o conformidade|recusou antes de consultar/i;
    const recusou = naoAprovou.some((v) => v.status === 'REJECTED' || (v.status === 'FAILED' && objetiva.test(v.detail || '')));
    if (recusou && lead.status === 'OPEN') {
      const an = require('./approval-notice.service') as typeof import('./approval-notice.service');
      if (lead.aiAutoReplyActive) {
        const out = await an.sendChangeRefusalNow({ accountId: lead.accountId, leadId });
        if (!out.ok && out.error !== 'janela de 24 h fechada') await nota(`⚠️ Não consegui avisar o cliente da nova proposta recusada: ${out.error}. Avise à mão — a aprovação anterior continua valendo.`);
      } else {
        const texto = await an.buildChangeRefusalText(leadId).catch(() => null);
        await nota(`✋ A nova proposta pedida pelo cliente foi recusada, mas o aviso NÃO saiu sozinho: a IA deste card está desligada.${texto ? ` Texto pronto pra você mandar:\n\n${texto}` : ''}`);
      }
    }
    await salvar((c) => { delete c._changeRound; }); // `_changeAsk` fica: o aviso agendado/o texto ainda usam
    return;
  }
  // Libera o aviso: o resultado novo pode ter o MESMO valor aprovado (só o prazo/parcelas mudaram) e a assinatura do último aviso o esconderia.
  await salvar((c) => { delete c._autoNoticeSig; delete c._autoNoticeAt; delete c._autoHeldSig; delete c._changeRound; delete c._changeAsk; if (!c._autoStartedAt) c._autoStartedAt = new Date().toISOString(); c._changeNotice = new Date().toISOString(); });
  await nota(`🔄 Nova proposta pedida pelo cliente (outro prazo/valor) respondida: ${aprovou.map((v) => `${BANKS[v.bank]?.label || v.bank} ${/aprovad[oa] a menor/i.test(v.detail || '') ? 'aprovou A MENOR' : 'aprovou'}`).join(', ')}. O aviso de aprovação vai ao cliente (com a IA do card ligada; senão use "Avisar cliente").`);
}

/** Valor de crédito pedido na última análise real (o Credimorar informa em "proposta N, R$ X") — pra saber se o cliente pediu OUTRO valor depois. */
export function lastRunCredit(rows: { detail: string | null }[]): number | null {
  for (const r of rows) {
    const m = /proposta\s+\d+,\s*R\$\s*([\d.]+,\d{2})/i.exec(r.detail || '');
    if (m) return brNumber(m[1]);
  }
  return null;
}

/** A IA da conversa pediu pra RODAR a análise do cliente (ponte: a extensão roda nos bancos). Só vale com a "Análise automática" LIGADA e sem
 *  pausa geral, com o card em Pré-Análise (proposta preenchida) do Home Equity. Banco já rodado vira só consulta (não duplica proposta). */
/** Bancos citados como "em análise" numa resposta da IA (Fabio 26/10). Pura (testável): só a frase que liga o banco a "em análise"/"vou colocar/incluir/rodar". */
export function bancosEmAnaliseNoTexto(texto: string): string[] {
  const out = new Set<string>();
  for (const frase of String(texto || '').split(/(?<=[.!?\n])\s*/)) {
    if (!/em an[aá]lise|(colocar|coloquei|incluir|inclu[ií]|rodar|rodando|enviar|enviei|mandar|mandei)[^.!?]{0,30}(an[aá]lise|proposta)|j[aá] (pedi|solicitei|encaminhei)[^.!?]{0,30}an[aá]lise/i.test(frase)) continue;
    if (/n[aã]o (est[aá] |ficou |entrou )?em an[aá]lise|n[aã]o (vou|vamos|d[aá] pra|consigo) (colocar|rodar|incluir|enviar|mandar)|n[aã]o (rodou|rodamos|analisa)/i.test(frase)) continue;
    if (/\bsantander\b/i.test(frase)) out.add('CREDIMORAR');
    if (/\binter\b/i.test(frase)) out.add('INTER');
    if (/\bcreditas\b/i.test(frase)) out.add('CREDITAS');
  }
  return [...out];
}

/** A IA disse ao cliente que um banco "está em análise" e esse banco NUNCA rodou neste card (Fabio 26/10, Jézer: "não tem problema a IA falar que está em análise, desde que a outra IA rode
 *  o crédito"). Pede a 1ª rodada SÓ nos bancos sem nenhuma análise no card — em qualquer etapa aberta do Home Equity (o cliente pode estar em Aguardando Documentação comparando bancos).
 *  Banco que já rodou (aprovou, reprovou, "NÃO RODEI", falhou) não é tocado. */
export async function requestBankRunForAi(db: Db, accountId: string, leadId: string, banks: string[]): Promise<{ ok: boolean; detail: string; banks: string[] }> {
  const set = await db.creditAutoSetting.findUnique({ where: { accountId } });
  if (!set?.enabled) return { ok: false, detail: 'a "Análise automática" do CRM está desligada', banks: [] };
  if (set.paused) return { ok: false, detail: 'a pausa geral das execuções automáticas está ligada', banks: [] };
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { status: true, archived: true, customFields: true, pipeline: { select: { department: { select: { name: true } } } } } });
  if (!lead || lead.status !== 'OPEN' || lead.archived) return { ok: false, detail: 'o card não está aberto', banks: [] };
  if (!/home equity/i.test(lead.pipeline?.department?.name || '')) return { ok: false, detail: 'só vale para Home Equity', banks: [] };
  const cf = (lead.customFields || {}) as Record<string, any>;
  if (cf._autoPaused) return { ok: false, detail: 'este cliente está PAUSADO na Análise de Crédito', banks: [] };
  if (String(cf.cpf_1 || '').replace(/\D/g, '').length !== 11 || !(Number(String(cf.valor_credito ?? '').replace(/[^\d.]/g, '')) > 0)) return { ok: false, detail: 'o card não tem a proposta (CPF e valor do crédito)', banks: [] };
  const keys = Array.from(new Set(banks.map((b) => (String(b).toUpperCase() === 'SANTANDER' ? 'CREDIMORAR' : String(b).toUpperCase())))).filter((b) => BANK_KEYS.includes(b));
  if (!keys.length) return { ok: false, detail: 'nenhum banco válido', banks: [] };
  const jaTem = await db.creditAnalysis.findMany({ where: { leadId, dryRun: false, bank: { in: keys } }, select: { bank: true } });
  const novos = keys.filter((b) => !jaTem.some((r) => r.bank === b));
  if (!novos.length) return { ok: false, detail: 'esse(s) banco(s) já têm análise neste card', banks: [] };
  const r = await createRequests(db, { accountId, leadIds: [leadId], banks: novos, dryRun: false, kind: 'RUN', source: 'AI' });
  if (!r.created) return { ok: false, detail: 'já havia análise em andamento nesse(s) banco(s)', banks: [] };
  return { ok: true, detail: `1ª análise pedida em ${novos.length} banco(s)`, banks: novos };
}

export async function requestRunForAi(db: Db, accountId: string, leadId: string): Promise<{ ok: boolean; detail: string }> {
  const set = await db.creditAutoSetting.findUnique({ where: { accountId } });
  if (!set?.enabled) return { ok: false, detail: 'a "Análise automática" do CRM está desligada' };
  if (set.paused) return { ok: false, detail: 'a pausa geral das execuções automáticas está ligada' };
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { status: true, archived: true, customFields: true, stage: { select: { name: true } }, pipeline: { select: { department: { select: { name: true } } } } } });
  if (!lead || lead.status !== 'OPEN' || lead.archived) return { ok: false, detail: 'o card não está aberto' };
  if (!/home equity/i.test(lead.pipeline?.department?.name || '')) return { ok: false, detail: 'só vale para Home Equity' };
  if ((lead.customFields as any)?._autoPaused) return { ok: false, detail: 'este cliente está PAUSADO na Análise de Crédito (botão da tela)' };
  if (!/^pre-?an/.test(normName(lead.stage?.name || ''))) return { ok: false, detail: `o card está em "${lead.stage?.name || '?'}", não na Pré-Análise` };
  // O cliente pode ter pedido OUTRO valor depois da 1ª análise (Aline e Dannilo, 14/10: "queria até 50 mil"): a proposta antiga não vale mais, então roda
  // DE NOVO com o valor do card (ajuste do financiamento nos 3 bancos) — antes o pedido da IA só relia a proposta velha e a "nova análise" nunca acontecia.
  // Pedido de nova análise entra na fila normal (um cliente por vez), não na via livre da IA.
  const cf = (lead.customFields || {}) as Record<string, any>;
  const atual = typeof cf.valor_credito === 'number' ? cf.valor_credito : Number(String(cf.valor_credito ?? '').replace(/[R$\s.]/g, '').replace(',', '.'));
  const antigas = await db.creditAnalysis.findMany({ where: { leadId, dryRun: false, status: { in: REAL_SENT }, createdAt: { gt: new Date(Date.now() - 60 * 86_400_000) } }, orderBy: { createdAt: 'desc' }, take: 12, select: { detail: true } });
  const anterior = lastRunCredit(antigas);
  const mudou = atual > 0 && !!anterior && Math.abs(atual - anterior) / anterior > 0.01;
  if (mudou) {
    await setOverrides(db, { accountId, leadId, banks: BANK_KEYS, merge: true, data: { valorEmprestimo: atual.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) } });
  }
  const r = await createRequests(db, { accountId, leadIds: [leadId], banks: BANK_KEYS, dryRun: false, kind: 'RUN', source: mudou ? 'EXTENSION' : 'AI', force: mudou, alignApproval: true });
  if (!r.created) return { ok: false, detail: 'já havia análise em andamento' };
  // A IA disparou a análise (cliente concordou, ex.: ajuste do troco): o card passa a valer como "iniciado pelo automático" — sem isso o 2º participante não roda sozinho, o aviso de aprovação não sai
  // e a negativa fica esperando a cascata pra sempre (Fernanda karita Batista Costa, 21/10: "por que não foi iniciado pelo automático?").
  if (!cf._autoStartedAt) {
    const fresh = await db.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
    await db.lead.update({ where: { id: leadId }, data: { customFields: { ...((fresh?.customFields || {}) as Record<string, any>), _autoStartedAt: new Date().toISOString() } as any } });
  }
  if (mudou) return { ok: true, detail: `o valor pedido mudou (de R$ ${anterior!.toLocaleString('pt-BR')} para R$ ${atual.toLocaleString('pt-BR')}): análise NOVA pedida a ${r.created} banco(s), um cliente por vez` };
  return { ok: true, detail: `pedido enviado a ${r.created} banco(s)${r.consulted.length ? ` (${r.consulted.length} já rodado(s): só consulta)` : ''}` };
}
