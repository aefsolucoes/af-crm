'use client';
import { useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import api from '@/lib/api';
import { BANKS, type Bank, type BoardLead, type OverrideData } from '@/components/credit/shared';

/* "Ajustar" um cliente já rodado: valores, renda, prazo e inverter titular/2º participante.
 * Vale a partir da próxima análise (as extensões leem daqui antes de preencher o portal). */

const inputCls = 'w-full text-sm border border-af-border rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-af-accent bg-white text-slate-800';
type Scope = 'ALL' | Bank;

function initial(lead: BoardLead, scope: Scope): OverrideData {
  const ov = lead.overrides || {};
  if (scope === 'ALL') return (BANKS.map((b) => ov[b.key]).find(Boolean) as OverrideData | undefined) || {};
  return (ov[scope] as OverrideData | undefined) || {};
}

export function AdjustModal({ lead, onClose, onSaved, onRunAgain }: {
  lead: BoardLead; onClose: () => void; onSaved: () => void; onRunAgain: (banks: Bank[]) => void;
}) {
  const hasP2 = !!lead.card?.name2;
  const [scope, setScope] = useState<Scope>('ALL');
  const [form, setForm] = useState<OverrideData>(() => initial(lead, 'ALL'));
  const [busy, setBusy] = useState(false);
  const set = (k: keyof OverrideData) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const banksOf = (s: Scope): Bank[] => (s === 'ALL' ? BANKS.map((b) => b.key) : [s]);

  function pickScope(s: Scope) {
    setScope(s);
    setForm(initial(lead, s));
  }

  async function save(clear = false, runAgain = false) {
    if (runAgain && !window.confirm(`Salvar e enviar de novo a proposta de ${lead.name} para ${banksOf(scope).map((b) => BANKS.find((x) => x.key === b)!.short).join(', ')}? Isso envia de verdade ao banco.`)) return;
    setBusy(true);
    try {
      await api.put('/api/credit-analysis/overrides', { leadId: lead.id, banks: banksOf(scope), data: clear ? {} : form, merge: false });
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

        <p className="text-xs text-slate-400">Deixe em branco o que não quiser mudar: a extensão usa o que está na proposta do cliente.</p>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-xs text-slate-500">Valor do imóvel (R$)
            <input className={`${inputCls} mt-1`} inputMode="decimal" value={form.valorImovel || ''} onChange={set('valorImovel')} placeholder={c?.propertyValue ? `no card: ${c.propertyValue}` : 'ex.: 900.000,00'} />
          </label>
          <label className="block text-xs text-slate-500">Valor do financiamento (R$)
            <input className={`${inputCls} mt-1`} inputMode="decimal" value={form.valorEmprestimo || ''} onChange={set('valorEmprestimo')} placeholder={c?.creditValue ? `no card: ${c.creditValue}` : 'ex.: 300.000,00'} />
          </label>
          <label className="block text-xs text-slate-500">Renda do titular (R$)
            <input className={`${inputCls} mt-1`} inputMode="decimal" value={form.renda || ''} onChange={set('renda')} placeholder={c?.income1 ? `no card: ${c.income1}` : ''} />
          </label>
          <label className="block text-xs text-slate-500">Prazo (meses)
            <input className={`${inputCls} mt-1`} inputMode="numeric" value={form.prazo || ''} onChange={set('prazo')} placeholder={c?.term ? `no card: ${c.term}` : 'ex.: 180'} />
          </label>
          {hasP2 && (
            <label className="block text-xs text-slate-500 col-span-2">Renda do 2º participante (R$)
              <input className={`${inputCls} mt-1`} inputMode="decimal" value={form.rendaParticipante || ''} onChange={set('rendaParticipante')} placeholder={c?.income2 ? `no card: ${c.income2}` : ''} />
            </label>
          )}
        </div>

        {hasP2 ? (
          <label className="flex items-start gap-2 rounded-lg border border-af-border p-3 text-sm text-slate-600 cursor-pointer">
            <input type="checkbox" className="mt-0.5" checked={!!form.inverter} onChange={(e) => setForm((f) => ({ ...f, inverter: e.target.checked }))} />
            <span>
              <span className="font-medium text-slate-700">Inverter participantes</span>
              <span className="block text-xs text-slate-400">
                {form.inverter ? <>Titular na análise: <strong>{c.name2}</strong> · 2º participante: <strong>{c.name1}</strong></> : <>Titular: <strong>{c.name1}</strong> · 2º participante: <strong>{c.name2}</strong></>}
              </span>
              {form.inverter && <span className="block text-[11px] text-slate-400 mt-1">Trocam de lugar nome, CPF, nascimento, telefone, e-mail e estado civil. A renda não troca: o novo titular usa a renda do 1º participante.</span>}
            </span>
          </label>
        ) : (
          <p className="text-xs text-slate-400">Este card não tem 2º participante, então não há o que inverter.</p>
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
