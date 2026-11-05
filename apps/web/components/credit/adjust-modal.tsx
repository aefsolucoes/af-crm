'use client';
import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import api from '@/lib/api';
import { maskCentavos } from '@/lib/utils';
import { BANKS, type Bank, type BoardLead, type OverrideData } from '@/components/credit/shared';

/* "Ajustar" um cliente já rodado: valores, renda, prazo e inverter titular/2º participante.
 * Vale a partir da próxima análise (as extensões leem daqui antes de preencher o portal). */

const inputCls = 'w-full text-sm border border-af-border rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-af-accent bg-white text-slate-800';
type Scope = 'ALL' | Bank;

/** "320000", "11364.46" ou "R$ 5.000,00" → número (ou null). */
function toNum(v: string | undefined | null): number | null {
  const t = String(v ?? '').replace(/[^\d.,-]/g, '');
  if (!t) return null;
  const n = t.includes(',') ? Number(t.replace(/\./g, '').replace(',', '.')) : (/^\d{1,3}(\.\d{3})+$/.test(t) ? Number(t.replace(/\./g, '')) : Number(t));
  return Number.isFinite(n) ? n : null;
}
const brl = (v: string | undefined | null) => { const n = toNum(v); return n === null ? '' : n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };

/** Valores que já estão no card — o modal abre preenchido com eles; só o que você mudar vira ajuste. */
function cardDefaults(lead: BoardLead): OverrideData {
  const c = lead.card;
  const prazo = toNum(c?.term);
  return {
    valorImovel: brl(c?.propertyValue), valorEmprestimo: brl(c?.creditValue), renda: brl(c?.income1),
    ...(c?.name2 ? { rendaParticipante: brl(c?.income2) } : {}),
    ...(prazo ? { prazo: String(prazo) } : {}),
  };
}

function initial(lead: BoardLead, scope: Scope, fresh?: Partial<Record<Bank, OverrideData | null>>): OverrideData {
  const ov = (fresh || lead.overrides || {}) as Partial<Record<Bank, OverrideData | null>>;
  const saved = scope === 'ALL' ? ((BANKS.map((b) => ov[b.key]).find(Boolean) as OverrideData | undefined) || {}) : ((ov[scope] as OverrideData | undefined) || {});
  const base = cardDefaults(lead);
  return { ...base, ...Object.fromEntries(Object.entries(saved).filter(([, v]) => v !== undefined && v !== '')) } as OverrideData;
}

/** Só vira ajuste o campo que é diferente do que está no card. */
function onlyChanges(lead: BoardLead, form: OverrideData): OverrideData {
  const base = cardDefaults(lead);
  const out: OverrideData = {};
  for (const k of ['valorImovel', 'valorEmprestimo', 'renda', 'rendaParticipante', 'prazo'] as const) {
    const v = (form[k] || '').trim();
    if (!v) continue;
    const a = toNum(v), b = toNum(base[k]);
    if (a !== null && b !== null && Math.abs(a - b) < 0.005) continue; // igual ao card = sem ajuste
    out[k] = v;
  }
  if (form.inverter) out.inverter = true;
  if (form.soTitular) out.soTitular = true; // marcado pelo CRM (idade / mesmo formato da aprovação) ou pela equipe: salvar não pode devolver quem ficou fora
  if (form.escolhaManual) out.escolhaManual = true; // a equipe escolheu quem entra (Fabio 05/11): as regras automáticas não mexem
  return out;
}

type Quem = 'AUTO' | 'AMBOS_1' | 'AMBOS_2' | 'SO_1' | 'SO_2';
/** Quem entra na análise (Fabio 05/11: "preciso de uma opção de selecionar o participante, não essa opção de inverter"). Escolha da equipe = escolhaManual (as regras automáticas não mexem). */
function quemOpcoes(n1?: string | null, n2?: string | null): { key: Quem; label: string; hint?: string; data: OverrideData }[] {
  const a = n1 || '1º participante', b = n2 || '2º participante';
  return [
    { key: 'AUTO', label: 'O CRM decide', hint: '1ª rodada nos dois nomes; não passou: casados invertem, os outros rodam cada um sozinho; depois de aprovado, roda do jeito que aprovou.', data: { escolhaManual: false } },
    { key: 'SO_1', label: `Só ${a}`, data: { inverter: false, soTitular: true, escolhaManual: true } },
    { key: 'SO_2', label: `Só ${b}`, data: { inverter: true, soTitular: true, escolhaManual: true } },
    { key: 'AMBOS_1', label: `Os dois — titular ${a}`, data: { inverter: false, soTitular: false, escolhaManual: true } },
    { key: 'AMBOS_2', label: `Os dois — titular ${b}`, data: { inverter: true, soTitular: false, escolhaManual: true } },
  ];
}
function quemAtual(f: OverrideData): Quem {
  if (!f.escolhaManual) return 'AUTO';
  return f.soTitular ? (f.inverter ? 'SO_2' : 'SO_1') : (f.inverter ? 'AMBOS_2' : 'AMBOS_1');
}

export function AdjustModal({ lead, onClose, onSaved, onRunAgain }: {
  lead: BoardLead; onClose: () => void; onSaved: () => void; onRunAgain: (banks: Bank[]) => void;
}) {
  const hasP2 = !!lead.card?.name2;
  const [scope, setScope] = useState<Scope>('ALL');
  const [form, setForm] = useState<OverrideData>(() => initial(lead, 'ALL'));
  const [busy, setBusy] = useState(false);
  // Ajustes ATUAIS de cada banco (Fabio 05/11: a janela abriu com o ajuste velho da lista — sem a inversão que a rodada automática tinha feito — e salvou "só no nome" da pessoa errada).
  const [fresh, setFresh] = useState<Partial<Record<Bank, OverrideData | null>> | null>(null);
  useEffect(() => {
    let vivo = true;
    Promise.all(BANKS.map((b) => api.get('/api/credit-analysis/overrides', { params: { leadId: lead.id, bank: b.key } }).then((r) => [b.key, r.data?.data || null] as const).catch(() => [b.key, lead.overrides?.[b.key] || null] as const)))
      .then((pares) => {
        if (!vivo) return;
        const f = Object.fromEntries(pares) as Partial<Record<Bank, OverrideData | null>>;
        setFresh(f);
        // Um banco só com escolha de quem entra (ex.: Inter "Só Nildinete"): a janela abre nele — em "Todos os bancos" a escolha não aparecia e salvar ali apagava ela.
        const manuais = BANKS.map((b) => b.key).filter((k) => f[k]?.escolhaManual);
        const alvo: Scope = scope === 'ALL' && manuais.length === 1 && !mexidos.size ? manuais[0] : scope;
        if (alvo !== scope) setScope(alvo);
        setForm((atual) => comMexidos(initial(lead, alvo, f), atual));
      });
    return () => { vivo = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead.id]);
  // O que você mexeu continua quando troca o banco (Fabio 05/11: "toda vez que mudo o banco o ajuste retorna para o que estava").
  const [mexidos, setMexidos] = useState<Set<string>>(new Set());
  const marca = (...ks: string[]) => setMexidos((m) => new Set([...Array.from(m), ...ks]));
  const DINHEIRO = new Set(['valorImovel', 'valorEmprestimo', 'renda', 'rendaParticipante']);
  const set = (k: keyof OverrideData) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = DINHEIRO.has(k) ? maskCentavos(e.target.value) : e.target.value.replace(/\D/g, ''); // máscara de banco: 16000000 → 160.000,00 (prazo só dígitos)
    setForm((f) => ({ ...f, [k]: v }));
    marca(k);
  };
  /** Ao sair do campo, completa os centavos: 160.000 → 160.000,00 (Fabio 05/11: "cadê os centavos?"). */
  const centavos = (k: keyof OverrideData) => () => setForm((f) => {
    const v = String(f[k] || '').trim();
    if (!v) return f;
    const [int, dec = ''] = v.split(',');
    return { ...f, [k]: `${int || '0'},${(dec + '00').slice(0, 2)}` };
  });
  /** Valores do banco escolhido + o que você já mexeu por cima. */
  const comMexidos = (base: OverrideData, atual: OverrideData): OverrideData => {
    const out: OverrideData = { ...base };
    mexidos.forEach((k) => {
      if (k === 'quem') { out.inverter = atual.inverter; out.soTitular = atual.soTitular; out.escolhaManual = atual.escolhaManual; }
      else (out as any)[k] = (atual as any)[k];
    });
    return out;
  };
  const banksOf = (s: Scope): Bank[] => (s === 'ALL' ? BANKS.map((b) => b.key) : [s]);

  function pickScope(s: Scope) {
    setScope(s);
    setForm((atual) => comMexidos(initial(lead, s, fresh || undefined), atual));
  }

  async function save(clear = false, runAgain = false) {
    if (runAgain && !window.confirm(`Salvar e enviar de novo a proposta de ${lead.name} para ${banksOf(scope).map((b) => BANKS.find((x) => x.key === b)!.short).join(', ')}? Isso envia de verdade ao banco.`)) return;
    setBusy(true);
    try {
      await api.put('/api/credit-analysis/overrides', { leadId: lead.id, banks: banksOf(scope), data: clear ? {} : onlyChanges(lead, form), merge: false });
      toast(clear ? 'Ajustes removidos' : 'Ajuste salvo — vale na próxima análise', 'success');
      onSaved();
      if (runAgain && !clear) onRunAgain(banksOf(scope));
      onClose();
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao salvar', 'error');
    } finally { setBusy(false); }
  }

  const c = lead.card;
  return (
    <Modal title={`Ajustar — ${lead.name}`} onClose={onClose}>
      <div className="space-y-3">
        <div>
          <div className="text-xs text-slate-500 mb-1">Vale para</div>
          <div className="flex flex-wrap gap-1.5">
            {([['ALL', 'Todos os bancos'], ...BANKS.map((b) => [b.key, b.short])] as [Scope, string][]).map(([k, label]) => (
              <button key={k} onClick={() => pickScope(k)} className={`text-xs px-3 py-1 rounded-lg border ${scope === k ? 'bg-af-accent text-white border-af-accent' : 'border-af-border text-slate-600 hover:bg-slate-50'}`}>
                {label}{k !== 'ALL' && lead.overrides?.[k] ? ' ✎' : ''}
              </button>
            ))}
          </div>
        </div>

        <p className="text-xs text-slate-400">Os campos já vêm com os dados do card. Mude só o que quiser ajustar — o que ficar igual ao card segue como está.</p>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-xs text-slate-500">Valor do imóvel (R$)
            <input className={`${inputCls} mt-1`} inputMode="decimal" value={form.valorImovel || ''} onChange={set('valorImovel')} onBlur={centavos('valorImovel')} placeholder="ex.: 900.000,00" />
          </label>
          <label className="block text-xs text-slate-500">Valor do financiamento (R$)
            <input className={`${inputCls} mt-1`} inputMode="decimal" value={form.valorEmprestimo || ''} onChange={set('valorEmprestimo')} onBlur={centavos('valorEmprestimo')} placeholder="ex.: 300.000,00" />
          </label>
          <label className="block text-xs text-slate-500">Renda do titular (R$)
            <input className={`${inputCls} mt-1`} inputMode="decimal" value={form.renda || ''} onChange={set('renda')} onBlur={centavos('renda')} placeholder="ex.: 8.000,00" />
          </label>
          <label className="block text-xs text-slate-500">Prazo (meses)
            <input className={`${inputCls} mt-1`} inputMode="numeric" value={form.prazo || ''} onChange={set('prazo')} placeholder="ex.: 180" />
          </label>
          {hasP2 && (
            <label className="block text-xs text-slate-500 col-span-2">Renda do 2º participante (R$)
              <input className={`${inputCls} mt-1`} inputMode="decimal" value={form.rendaParticipante || ''} onChange={set('rendaParticipante')} onBlur={centavos('rendaParticipante')} placeholder="ex.: 3.500,00" />
            </label>
          )}
        </div>

        {hasP2 ? (
          <div className="rounded-lg border border-af-border p-3 text-sm text-slate-600">
            <div className="font-medium text-slate-700 mb-1.5">Quem entra na análise</div>
            {quemOpcoes(c.name1, c.name2).map((o) => (
              <label key={o.key} className="flex items-start gap-2 py-1 cursor-pointer">
                <input type="radio" name="quem" className="mt-1" checked={quemAtual(form) === o.key} onChange={() => { setForm((f) => ({ ...f, ...o.data })); marca('quem'); }} />
                <span>
                  <span className="text-slate-700">{o.label}</span>
                  {o.hint && <span className="block text-xs text-slate-400">{o.hint}</span>}
                </span>
              </label>
            ))}
          </div>
        ) : (
          <p className="text-xs text-slate-400">Este card não tem 2º participante: a análise roda só no nome do titular.</p>
        )}

        <div className="flex flex-wrap justify-between gap-2 pt-1">
          <Button variant="ghost" onClick={() => save(true)} disabled={busy}>Limpar ajustes</Button>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>Cancelar</Button>
            <Button variant="secondary" onClick={() => save(false, true)} disabled={busy}>Salvar e rodar de novo</Button>
            <Button onClick={() => save()} disabled={busy}>{busy ? 'Salvando…' : 'Salvar'}</Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
