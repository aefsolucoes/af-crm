import { prisma } from '../lib/prisma';
import { logActivity } from './activity.service';

/** RENDA DO CARD PELO COMPROVANTE (Fabio 05/11: "sempre que houver um comprovante de renda, o card do cliente deve preencher sozinho com a renda bruta do cliente").
 *  A leitura de cada documento (doc-review) guarda a renda bruta MENSAL de contracheque/holerite/benefício/IR (`_docReview[id].renda`); aqui soma por participante —
 *  o comprovante mais recente de cada FONTE; IR só conta pra quem não tem contracheque/benefício (sócio, autônomo) — e grava renda_1 / renda_2 (+ "renda_bruta", que é a do 1º).
 *  A ficha de cadastro (CAIXA), quando é mais nova que os comprovantes lidos, vale por cima (já aplica as regras de sócio e verbas eventuais).
 *  Só regrava quando o valor CALCULADO muda (`_rendaComprovante`): se a equipe corrigir a renda à mão depois, o CRM não desfaz. */

type Renda = { bruta: number; fonte?: string; competencia?: string };
const sem = (t: unknown) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const tokens = (t: unknown) => sem(t).split(' ').filter((w) => w.length > 1 && !['de', 'da', 'do', 'dos', 'das'].includes(w));
const brl = (v: number) => `R$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (v: unknown) => { const s = String(v ?? '').replace(/[^\d.,-]/g, ''); const n = Number(/,\d{1,2}$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
const mesNum = (c?: string) => { const m = /(\d{1,2})\/(\d{4})/.exec(String(c || '')); return m ? Number(m[2]) * 12 + Number(m[1]) : 0; };
const ehIR = (tipo: string) => /imposto de renda|declaracao de (imposto|ir)|\birpf\b/.test(sem(tipo));

/** Participante (1/2) do titular do documento, pelo nome; 0 = não é nenhum dos dois (documento de outra pessoa não mexe no card). Pura. */
export function participanteDoTitular(nome1: string, nome2: string, titular: string): 0 | 1 | 2 {
  const h = tokens(titular);
  if (!h.length) return 0;
  const score = (n: string) => { const t = tokens(n); if (!t.length || t[0] !== h[0]) return 0; const inter = h.filter((w) => t.includes(w)).length; return inter >= 2 || (inter === 1 && Math.min(h.length, t.length) === 1) ? inter / (h.length + t.length - inter) : 0; };
  const s1 = score(nome1), s2 = score(nome2);
  if (!s1 && !s2) return 0;
  return s2 > s1 ? 2 : 1;
}

/** Soma das fontes de um participante a partir das leituras de documento: por fonte, a competência mais recente. Pura. */
export function somarRendas(itens: { tipo: string; renda: Renda; quando: number }[]): { total: number; fontes: string[] } {
  const temSalario = itens.some((i) => !ehIR(i.tipo));
  const validos = itens.filter((i) => i.renda.bruta > 0 && (!temSalario || !ehIR(i.tipo)));
  const porFonte = new Map<string, { tipo: string; renda: Renda; quando: number }>();
  for (const i of validos) {
    const chave = tokens(i.renda.fonte).slice(0, 3).join(' ') || sem(i.tipo);
    const atual = porFonte.get(chave);
    if (!atual || mesNum(i.renda.competencia) > mesNum(atual.renda.competencia) || (mesNum(i.renda.competencia) === mesNum(atual.renda.competencia) && i.quando > atual.quando)) porFonte.set(chave, i);
  }
  const lista = [...porFonte.values()];
  return { total: Math.round(lista.reduce((s, i) => s + i.renda.bruta, 0) * 100) / 100, fontes: lista.map((i) => `${i.tipo}${i.renda.fonte ? ` ${i.renda.fonte}` : ''}${i.renda.competencia ? ` (${i.renda.competencia})` : ''}: ${brl(i.renda.bruta)}`) };
}

export async function atualizarRendaPeloComprovante(leadId: string): Promise<void> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, accountId: true, customFields: true } });
  if (!l) return;
  const cf = (l.customFields || {}) as Record<string, any>;
  const nome1 = String(cf.participante_1 || l.name || ''), nome2 = String(cf.participante_2 || '');
  const reviews = (cf._docReview || {}) as Record<string, { tipo?: string; titular?: string; renda?: Renda }>;
  const ids = Object.keys(reviews).filter((id) => reviews[id]?.renda && Number(reviews[id]!.renda!.bruta) > 0);
  const atts = ids.length ? await prisma.messageAttachment.findMany({ where: { id: { in: ids } }, select: { id: true, createdAt: true } }) : [];
  const quando = new Map(atts.map((a) => [a.id, a.createdAt.getTime()]));
  const porP: Record<1 | 2, { tipo: string; renda: Renda; quando: number }[]> = { 1: [], 2: [] };
  for (const id of ids) {
    const r = reviews[id]!;
    // arquivo com 2 titulares ("A; B") conta pro primeiro nome que casar
    const p = String(r.titular || '').split(/\s*;\s*/).map((t) => participanteDoTitular(nome1, nome2, t)).find((x) => x) || 0;
    if (p) porP[p].push({ tipo: String(r.tipo || ''), renda: { bruta: Number(r.renda!.bruta), fonte: r.renda!.fonte, competencia: r.renda!.competencia }, quando: quando.get(id) || 0 });
  }
  const ficha = cf._fichaCadastral;
  const fichaEm = ficha?.at ? Date.parse(ficha.at) : 0;
  const ultimoDoc = Math.max(0, ...[...porP[1], ...porP[2]].map((i) => i.quando));
  const anterior = (cf._rendaComprovante || {}) as Record<string, { valor: number }>;
  const novo: Record<string, { valor: number; fontes: string[] }> = {};
  const mudancas: string[] = [];
  const sets: Record<string, string> = {};
  for (const p of [1, 2] as const) {
    if (p === 2 && !nome2) continue;
    let calc = somarRendas(porP[p]);
    // Ficha de cadastro mais nova que os comprovantes lidos: vale a renda bruta dela (só quando veio de documento de renda).
    const fp = Array.isArray(ficha?.participantes) ? ficha.participantes.find((x: any) => Number(x.ordem) === p) : null;
    const fichaRenda = fp && !fp.semRenda && Number(fp.rendaBrutaMensal) > 0 && (fp.fontes?.contracheques || fp.fontes?.rendaBrutaMensal || (Array.isArray(fp.contracheques) && fp.contracheques.length)) ? Number(fp.rendaBrutaMensal) : 0;
    if (fichaRenda && fichaEm >= ultimoDoc) calc = { total: Math.round(fichaRenda * 100) / 100, fontes: (Array.isArray(fp.contracheques) ? fp.contracheques : []).slice(0, 4).map((c: any) => `${c.tipo === 'lucros' ? 'IR (distribuição de lucros)' : 'contracheque'}${c.empregador ? ` ${c.empregador}` : ''}${c.competencia ? ` (${c.competencia})` : ''}`).concat(['ficha de cadastro']) };
    if (!(calc.total > 0)) continue;
    novo[`p${p}`] = { valor: calc.total, fontes: calc.fontes };
    if (Math.abs((anterior[`p${p}`]?.valor || 0) - calc.total) < 1) continue; // já aplicado: não desfaz correção manual da equipe
    const antes = num(cf[`renda_${p}`]);
    sets[`renda_${p}`] = String(calc.total);
    if (p === 1) sets.renda_bruta = brl(calc.total);
    mudancas.push(`${p === 1 ? nome1 : nome2}: ${brl(calc.total)}${antes && Math.abs(antes - calc.total) >= 1 ? ` (era ${brl(antes)})` : ''} — ${calc.fontes.join(' + ')}`);
  }
  if (!Object.keys(novo).length) return;
  const marca = JSON.stringify({ at: new Date().toISOString(), ...anterior, ...novo });
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = COALESCE("customFields", '{}'::jsonb) || ${JSON.stringify(sets)}::jsonb || jsonb_build_object('_rendaComprovante', ${marca}::jsonb) WHERE id = ${leadId}`;
  if (!mudancas.length) return;
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `💰 Renda do card preenchida pelo comprovante de renda:\n${mudancas.map((m) => `• ${m}`).join('\n')}` } }).catch(() => {});
  logActivity({ accountId: l.accountId, userId: null, userName: 'Leitor de documentos', action: 'lead_edited', leadId, leadName: l.name, summary: 'preencheu a renda do card pelo comprovante de renda' } as any);
}
