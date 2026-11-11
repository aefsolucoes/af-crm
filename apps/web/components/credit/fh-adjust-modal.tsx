'use client';
import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import api from '@/lib/api';
import type { OverrideData } from '@/components/credit/shared';

/* "Ajustar" do Financiamento (Fabio 11/11: "cadê os botões de ajustar, stop e conferir cada banco para FH?" — Jaime: rodar de novo no Inter com valores novos).
 * No FH os VALORES vêm do card (regra de 05/11): o ajuste grava valor do imóvel, financiamento (a entrada é a diferença), renda e prazo no card
 * (PUT /credit-analysis/fh-valores). QUEM ENTRA na análise vira ajuste das três filas (PUT /credit-analysis/overrides). Dá pra salvar e já rodar nos bancos marcados. */

const FILAS_FH = [
  { key: 'CREDIMORAR_FH', label: 'Credimorar (Bradesco, Santander)' },
  { key: 'INTER_FH', label: 'Inter' },
  { key: 'ITAU_FH', label: 'Itaú' },
] as const;
type Quem = 'AUTO' | 'AMBOS_1' | 'AMBOS_2' | 'SO_1' | 'SO_2';
const inputCls = 'w-full text-sm border border-af-border rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-af-accent bg-white text-slate-800';
const brl = (n: number | null | undefined) => (n ? n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '');
const toNum = (v: string) => { const t = v.replace(/[^\d.,]/g, ''); if (!t) return null; const n = t.includes(',') ? Number(t.replace(/\./g, '').replace(',', '.')) : Number(t.replace(/\.(?=\d{3}(\D|$))/g, '')); return Number.isFinite(n) && n > 0 ? n : null; };

export type FhAjusteLead = {
  id: string; name: string;
  valores: { imovel: number | null; financia: number | null; entrada: number | null; renda: number | null };
  card: { name1: string | null; name2: string | null };
  participante2: string | null;
};

export function FhAdjustModal({ lead, onClose, onSaved }: { lead: FhAjusteLead; onClose: () => void; onSaved: () => void }) {
  const n1 = lead.card?.name1 || lead.name.split('/')[0].trim() || '1º participante';
  const n2 = lead.card?.name2 || lead.participante2 || '';
  const [imovel, setImovel] = useState(brl(lead.valores.imovel));
  const [financia, setFinancia] = useState(brl(lead.valores.financia));
  const [renda1, setRenda1] = useState('');
  const [renda2, setRenda2] = useState('');
  const [prazo, setPrazo] = useState('');
  const [quem, setQuem] = useState<Quem>('AUTO');
  const [quemMexeu, setQuemMexeu] = useState(false);
  const [rodar, setRodar] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  // Quem entra hoje (o ajuste da fila do Inter vale pras três — são gravadas juntas).
  useEffect(() => {
    let vivo = true;
    api.get('/api/credit-analysis/overrides', { params: { leadId: lead.id, bank: 'INTER_FH' } }).then((r) => {
      const f = (r.data?.data || {}) as OverrideData;
      if (!vivo || quemMexeu) return;
      setQuem(!f.escolhaManual ? 'AUTO' : f.soTitular ? (f.inverter ? 'SO_2' : 'SO_1') : (f.inverter ? 'AMBOS_2' : 'AMBOS_1'));
    }).catch(() => {});
    return () => { vivo = false; };
  }, [lead.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const im = toNum(imovel), fi = toNum(financia);
  const entrada = im && fi && im > fi ? im - fi : null;
  const opcoes: { key: Quem; label: string; data: OverrideData }[] = [
    { key: 'AUTO', label: 'O CRM decide', data: { escolhaManual: false } },
    { key: 'AMBOS_1', label: `Os dois — titular ${n1}`, data: { inverter: false, soTitular: false, escolhaManual: true } },
    ...(n2 ? [
      { key: 'AMBOS_2' as Quem, label: `Os dois — titular ${n2}`, data: { inverter: true, soTitular: false, escolhaManual: true } },
      { key: 'SO_1' as Quem, label: `Só ${n1}`, data: { inverter: false, soTitular: true, escolhaManual: true } },
      { key: 'SO_2' as Quem, label: `Só ${n2}`, data: { inverter: true, soTitular: true, escolhaManual: true } },
    ] : []),
  ];

  async function salvar() {
    if (im && fi && fi >= im) { toast('O financiamento tem que ser menor que o valor do imóvel', 'error'); return; }
    const pz = prazo ? Number(prazo.replace(/\D/g, '')) : null;
    if (pz && (pz < 60 || pz > 420)) { toast('Prazo entre 60 e 420 meses', 'error'); return; }
    const valores: Record<string, string> = {};
    if (im && im !== lead.valores.imovel) valores.valor_imovel = String(im);
    if (fi && fi !== lead.valores.financia) valores.valor_credito = String(fi);
    if (toNum(renda1)) valores.renda_1 = String(toNum(renda1));
    if (toNum(renda2)) valores.renda_2 = String(toNum(renda2));
    if (pz) valores.prazo = String(pz);
    setBusy(true);
    try {
      if (Object.keys(valores).length) await api.put('/api/credit-analysis/fh-valores', { leadId: lead.id, valores });
      if (quemMexeu) await api.put('/api/credit-analysis/overrides', { leadId: lead.id, banks: FILAS_FH.map((f) => f.key), data: opcoes.find((o) => o.key === quem)?.data || {}, merge: true });
      if (rodar.length) {
        const r = (await api.post('/api/credit-analysis/fh-request', { leadId: lead.id, kind: 'RUN', banks: rodar })).data;
        toast(r?.created ? `Ajustado e na fila: ${rodar.map((k) => FILAS_FH.find((f) => f.key === k)?.label).join(', ')}` : 'Ajustado (já estava na fila)', 'success');
      } else toast(Object.keys(valores).length || quemMexeu ? 'Ajuste salvo — vale na próxima rodada' : 'Nada mudou', 'success');
      onSaved();
      onClose();
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao salvar o ajuste', 'error');
    } finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title={`Ajustar Financiamento — ${lead.name}`}>
      <div className="space-y-3 text-sm">
        <p className="text-xs text-slate-500">No Financiamento os valores saem do card: o que você mudar aqui é gravado no card (com nota) e vale na próxima rodada.</p>
        <div className="grid grid-cols-2 gap-3">
          <label className="block"><span className="text-xs text-slate-500">Valor do imóvel (R$)</span><input className={inputCls} value={imovel} onChange={(e) => setImovel(e.target.value)} placeholder="0,00" /></label>
          <label className="block"><span className="text-xs text-slate-500">Financiamento (R$)</span><input className={inputCls} value={financia} onChange={(e) => setFinancia(e.target.value)} placeholder="0,00" /></label>
        </div>
        <div className="text-xs text-slate-500">Entrada: {entrada ? `R$ ${brl(entrada)}` : '—'}</div>
        <div className="grid grid-cols-3 gap-3">
          <label className="block"><span className="text-xs text-slate-500">Renda de {n1.split(' ')[0]} (R$)</span><input className={inputCls} value={renda1} onChange={(e) => setRenda1(e.target.value)} placeholder="sem mudança" /></label>
          {n2 ? <label className="block"><span className="text-xs text-slate-500">Renda de {n2.split(' ')[0]} (R$)</span><input className={inputCls} value={renda2} onChange={(e) => setRenda2(e.target.value)} placeholder="sem mudança" /></label> : <div />}
          <label className="block"><span className="text-xs text-slate-500">Prazo (meses)</span><input className={inputCls} value={prazo} onChange={(e) => setPrazo(e.target.value)} placeholder="máximo pela idade" /></label>
        </div>
        <div>
          <div className="text-xs font-medium text-slate-600 mb-1">Quem entra na análise</div>
          <div className="space-y-1">
            {opcoes.map((o) => (
              <label key={o.key} className="flex items-center gap-2 text-xs text-slate-700">
                <input type="radio" name="quem-fh" checked={quem === o.key} onChange={() => { setQuem(o.key); setQuemMexeu(true); }} /> {o.label}
              </label>
            ))}
          </div>
        </div>
        <div>
          <div className="text-xs font-medium text-slate-600 mb-1">Salvar e rodar de novo em</div>
          <div className="flex flex-wrap gap-3">
            {FILAS_FH.map((f) => (
              <label key={f.key} className="flex items-center gap-1.5 text-xs text-slate-700">
                <input type="checkbox" checked={rodar.includes(f.key)} onChange={() => setRodar((p) => p.includes(f.key) ? p.filter((x) => x !== f.key) : [...p, f.key])} /> {f.label}
              </label>
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button onClick={salvar} disabled={busy}>{busy ? 'Salvando…' : rodar.length ? 'Salvar e rodar' : 'Salvar'}</Button>
        </div>
      </div>
    </Modal>
  );
}
