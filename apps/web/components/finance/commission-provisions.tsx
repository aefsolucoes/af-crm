'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@/components/ui/toast';
import api from '@/lib/api';
import { formatCurrency, formatDate, cn } from '@/lib/utils';
import { CommissionProvision, ProvisionCandidate } from '@/types';
import { CalendarClock, Check, Pencil, Plus, Search, Trash2, X } from 'lucide-react';

/* Provisão de comissão por processo (Fabio 28/10: "provisão de pagamento de processo", lançada à mão). Previsão do que vai entrar
 * de cada cliente em Vistoria (mais perto de finalizar — Fabio 28/10) — NÃO entra no saldo; "Recebido" vira Receita no extrato. Taxa padrão pelo banco e produto (ver commission.service na API): Home Equity — Inter 3/4/5% pela produção do mês, Creditas 5%, Santander 2,5%; Financiamento — Bradesco 0,9/1%, Inter e Itaú 0,8%, Santander 0,8/0,9%. */

const inputCls = 'w-full text-sm px-3 py-2 border border-af-border rounded-lg bg-white text-slate-800 focus:outline-none focus:ring-1 focus:ring-af-accent';
const PAYERS = ['Inter', 'Creditas', 'Credimorar', 'Santander', 'CAIXA', 'BRB', 'Itaú', 'Bradesco'];

const toMoneyInput = (n: number) => (n ? n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '');
const parseMoney = (s: string) => Number(s.replace(/\./g, '').replace(',', '.')) || 0;
const parsePct = (s: string) => Number(s.replace(',', '.')) || 0;
const todayISO = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD no fuso do aparelho
const dayOf = (d?: string | null) => (d ? new Date(d).toLocaleDateString('en-CA') : '');

function ProvisionForm({ editing, onClose, onSaved }: { editing: CommissionProvision | null; onClose: () => void; onSaved: () => void }) {
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [picked, setPicked] = useState<{ id: string; name: string; stage: string; product: string | null } | null>(
    editing ? { id: editing.leadId, name: editing.leadName, stage: editing.leadStage, product: editing.product || null } : null,
  );
  const [base, setBase] = useState(editing ? toMoneyInput(editing.baseAmount) : '');
  const [rate, setRate] = useState(editing ? String(editing.ratePct).replace('.', ',') : '');
  const [amount, setAmount] = useState(editing ? toMoneyInput(editing.amount) : '');
  const [amountTouched, setAmountTouched] = useState(!!editing);
  const [expected, setExpected] = useState(dayOf(editing?.expectedDate));
  const [payer, setPayer] = useState(editing?.payer || '');
  const [note, setNote] = useState(editing?.note || '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const { data: candidates, isLoading } = useQuery({
    queryKey: ['provision-candidates', debouncedQ],
    queryFn: async () => (await api.get<ProvisionCandidate[]>(`/api/finance/provisions/candidates?q=${encodeURIComponent(debouncedQ)}`)).data,
    enabled: !picked,
  });

  // Valor previsto acompanha crédito × % até a pessoa digitar um valor próprio.
  useEffect(() => {
    if (amountTouched) return;
    const v = Math.round(parseMoney(base) * parsePct(rate)) / 100;
    setAmount(v ? toMoneyInput(v) : '');
  }, [base, rate, amountTouched]);

  function pick(c: ProvisionCandidate) {
    setPicked({ id: c.id, name: c.name, stage: c.stage, product: c.product });
    setBase(toMoneyInput(c.baseAmount));
    setRate(String(c.ratePct).replace('.', ','));
    setPayer(c.payer || '');
    setAmountTouched(false);
  }

  async function save() {
    const payload = {
      baseAmount: parseMoney(base),
      ratePct: parsePct(rate),
      amount: parseMoney(amount),
      expectedDate: expected || null,
      payer: payer.trim() || null,
      note: note.trim() || null,
    };
    if (!picked) return toast('Escolha o cliente', 'error');
    if (payload.baseAmount <= 0 || payload.ratePct <= 0 || payload.amount <= 0) return toast('Preencha crédito, % e valor', 'error');
    setSaving(true);
    try {
      if (editing) await api.patch(`/api/finance/provisions/${editing.id}`, payload);
      else await api.post('/api/finance/provisions', { leadId: picked.id, ...payload });
      toast(editing ? 'Provisão atualizada!' : 'Provisão lançada!');
      onSaved();
    } catch (e: any) {
      toast(e?.response?.data?.error || 'Erro ao salvar provisão', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-af-border bg-slate-50 p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-sm font-semibold text-slate-700">{editing ? 'Editar provisão' : 'Nova provisão'}</h4>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
      </div>

      {!picked ? (
        <div>
          <div className="relative mb-2">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar cliente pelo nome…" className={cn(inputCls, 'pl-8')} autoFocus />
          </div>
          <p className="text-[11px] text-slate-400 mb-2">
            {debouncedQ.length >= 2 ? 'Resultado da busca' : 'Clientes em Vistoria ainda sem provisão'}
          </p>
          <div className="max-h-64 overflow-y-auto divide-y divide-af-border rounded-lg border border-af-border bg-white scrollbar-thin">
            {isLoading ? (
              <p className="text-xs text-slate-400 px-3 py-3">Carregando…</p>
            ) : !candidates?.length ? (
              <p className="text-xs text-slate-400 px-3 py-3">Nenhum cliente encontrado</p>
            ) : (
              candidates.map((c) => (
                <button key={c.id} onClick={() => pick(c)} className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-slate-800 truncate">{c.name}</span>
                    <span className="block text-[11px] text-slate-500 truncate">{c.stage}{c.product ? ` · ${c.product}` : ''}</span>
                  </span>
                  <span className="text-right flex-shrink-0">
                    <span className="block text-xs text-slate-600">{c.baseAmount ? formatCurrency(c.baseAmount) : 'sem crédito'}</span>
                    {c.hasProvision && <span className="block text-[10px] text-amber-600">já tem provisão</span>}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3 mb-3 px-3 py-2 rounded-lg bg-white border border-af-border">
            <span className="min-w-0">
              <span className="block text-sm font-medium text-slate-800 truncate">{picked.name}</span>
              <span className="block text-[11px] text-slate-500 truncate">{picked.stage}{picked.product ? ` · ${picked.product}` : ''}</span>
            </span>
            {!editing && <button onClick={() => setPicked(null)} className="text-xs text-af-mid hover:underline flex-shrink-0">trocar</button>}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="text-xs font-medium text-slate-500 mb-1 block">Valor do crédito (R$)</label>
              <input value={base} onChange={(e) => setBase(e.target.value)} placeholder="Ex: 300.000,00" className={inputCls} />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-500 mb-1 block">Comissão (%)</label>
              <input value={rate} onChange={(e) => setRate(e.target.value)} placeholder="1 ou 5" className={inputCls} />
              <p className="text-[10px] text-slate-400 mt-0.5">Home Equity: Inter 3–5% (produção do mês) · Creditas 5% · Santander 2,5% — Financiamento: Bradesco 0,9–1% · Inter/Itaú 0,8% · Santander 0,8–0,9%</p>
            </div>
            <div>
              <label className="text-xs font-medium text-slate-500 mb-1 block">Valor previsto (R$)</label>
              <input value={amount} onChange={(e) => { setAmount(e.target.value); setAmountTouched(true); }} className={cn(inputCls, 'font-semibold')} />
              {amountTouched && (
                <button onClick={() => setAmountTouched(false)} className="text-[10px] text-af-mid hover:underline mt-0.5">recalcular pelo %</button>
              )}
            </div>
            <div>
              <label className="text-xs font-medium text-slate-500 mb-1 block">Previsão de pagamento</label>
              <input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-500 mb-1 block">Quem paga</label>
              <input value={payer} onChange={(e) => setPayer(e.target.value)} list="provision-payers" placeholder="Ex: Inter" className={inputCls} />
              <datalist id="provision-payers">{PAYERS.map((p) => <option key={p} value={p} />)}</datalist>
            </div>
            <div>
              <label className="text-xs font-medium text-slate-500 mb-1 block">Observação</label>
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Opcional" className={inputCls} />
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={onClose} className="text-sm px-4 py-2 rounded-lg text-slate-500 hover:bg-slate-100">Cancelar</button>
            <button onClick={save} disabled={saving} className="text-sm px-4 py-2 rounded-lg bg-af-mid text-white hover:bg-af-dark disabled:opacity-50">
              {saving ? 'Salvando...' : editing ? 'Salvar alterações' : 'Lançar provisão'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Símbolo do banco do processo (Fabio 14/11). "Credimorar (Inter)" = banco Inter pago pela Credimorar; "Credimorar" sozinho no Home Equity = Santander.
 *  Sem banco no card: "?" cinza (a taxa é a padrão do produto). Banco sem imagem em public/banks (BRB…): a sigla. */
const BANK_FILE: Array<[RegExp, string, string]> = [
  [/inter/i, 'inter.png', 'Inter'],
  [/creditas/i, 'creditas-simbolo.svg', 'Creditas'],
  [/santander/i, 'santander.png', 'Santander'],
  [/bradesco/i, 'bradesco.png', 'Bradesco'],
  [/ita[uú]/i, 'itau.png', 'Itaú'],
  [/caixa/i, 'caixa.png', 'CAIXA'],
];
/** Nome do banco do processo (o mesmo do símbolo): "Credimorar (Inter)" → Inter; Credimorar no Home Equity → Santander; sem banco → ''. */
function bancoDaProvisao(payer?: string | null, product?: string | null): string {
  const banco = ((/\(([^)]+)\)/.exec(payer || '') || [])[1] || payer || '').trim();
  if (/^credimorar$/i.test(banco) && /home equity/i.test(product || '')) return 'Santander';
  const hit = BANK_FILE.find(([rx]) => rx.test(banco));
  return hit ? hit[2] : banco;
}
function ProvisionBankIcon({ payer, product }: { payer?: string | null; product?: string | null }) {
  const [semImagem, setSemImagem] = useState(false);
  const nome = bancoDaProvisao(payer, product);
  const hit = BANK_FILE.find(([rx]) => rx.test(nome));
  const box = 'w-8 h-8 flex-shrink-0 rounded-lg';
  if (hit && !semImagem) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={`/banks/${hit[1]}`} alt={hit[2]} title={payer || hit[2]} className={cn(box, 'object-contain bg-white border border-af-border p-0.5')} onError={() => setSemImagem(true)} />;
  }
  const sigla = nome ? nome.replace(/[^A-Za-zÀ-ú]/g, '').slice(0, 3).toUpperCase() : '?';
  return (
    <span title={payer || 'Banco não identificado no card — taxa padrão do produto'} className={cn(box, 'flex items-center justify-center text-[10px] font-bold', nome ? 'bg-slate-100 text-slate-600' : 'bg-amber-50 text-amber-600 border border-amber-200')}>
      {sigla}
    </span>
  );
}

/** Linha de uma provisão em aberto: "Recebido" abre valor + data reais e vira Receita. */
function ProvisionRow({ p, onEdit, onChanged }: { p: CommissionProvision; onEdit: () => void; onChanged: () => void }) {
  const router = useRouter();
  const [receiving, setReceiving] = useState(false);
  const [recAmount, setRecAmount] = useState(toMoneyInput(p.amount));
  const [recDate, setRecDate] = useState(todayISO());
  const [busy, setBusy] = useState(false);
  const late = !!p.expectedDate && dayOf(p.expectedDate) < todayISO();

  async function receive() {
    const value = parseMoney(recAmount);
    if (value <= 0) return toast('Informe um valor válido', 'error');
    setBusy(true);
    try {
      await api.post(`/api/finance/provisions/${p.id}/receive`, { amount: value, date: recDate });
      toast('Comissão recebida — lançada como Receita!');
      onChanged();
    } catch (e: any) {
      toast(e?.response?.data?.error || 'Erro ao registrar recebimento', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Tirar a provisão de ${p.leadName}?`)) return;
    try {
      await api.delete(`/api/finance/provisions/${p.id}`);
      toast('Provisão excluída');
      onChanged();
    } catch (e: any) {
      toast(e?.response?.data?.error || 'Erro ao excluir provisão', 'error');
    }
  }

  return (
    <div className={cn('px-4 py-3 rounded-xl border border-af-border bg-white', p.leadSituacao === 'PERDIDO' && 'opacity-60')}>
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
        <div className="flex-1 min-w-0 flex items-center gap-3">
          <ProvisionBankIcon payer={p.payer} product={p.product} />
          <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <button onClick={() => router.push(`/inbox?leadId=${p.leadId}`)} className="text-sm font-medium text-slate-800 hover:text-af-mid hover:underline truncate block max-w-full text-left">
              {p.leadName}
            </button>
            {p.leadSituacao === 'PERDIDO' && <span className="flex-shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">Perdido · fora do total</span>}
            {p.leadSituacao === 'CONCLUIDO' && <span className="flex-shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">Concluído · falta receber</span>}
          </div>
          <p className="text-[11px] text-slate-500 truncate">
            {p.leadStage}{p.payer ? ` · paga: ${p.payer}` : ''}{p.note ? ` · ${p.note}` : ''}
          </p>
          </div>
        </div>
        <div className="text-xs text-slate-500 sm:text-right flex-shrink-0">
          {String(p.ratePct).replace('.', ',')}% de {formatCurrency(p.baseAmount)}
        </div>
        <div className="sm:text-right flex-shrink-0 sm:w-32">
          <p className="text-sm font-bold text-emerald-600">{formatCurrency(p.amount)}</p>
          <p className={cn('text-[11px]', late ? 'text-red-500 font-medium' : 'text-slate-400')}>
            {p.expectedDate ? `${late ? 'atrasada · ' : 'prev. '}${formatDate(p.expectedDate)}` : 'sem previsão'}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button onClick={() => setReceiving((v) => !v)} className="flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 bg-emerald-500 text-white rounded-lg hover:bg-emerald-600">
            <Check size={13} /> Recebido
          </button>
          <button onClick={onEdit} className="text-slate-300 hover:text-af-mid transition-colors" title="Editar"><Pencil size={14} /></button>
          <button onClick={remove} className="text-slate-300 hover:text-red-500 transition-colors" title="Excluir"><Trash2 size={14} /></button>
        </div>
      </div>
      {receiving && (
        <div className="mt-3 pt-3 border-t border-af-border flex flex-col sm:flex-row sm:items-end gap-2">
          <div>
            <label className="text-[11px] font-medium text-slate-500 mb-1 block">Valor que caiu (R$)</label>
            <input value={recAmount} onChange={(e) => setRecAmount(e.target.value)} className={cn(inputCls, 'sm:w-36')} />
          </div>
          <div>
            <label className="text-[11px] font-medium text-slate-500 mb-1 block">Data</label>
            <input type="date" value={recDate} onChange={(e) => setRecDate(e.target.value)} className={cn(inputCls, 'sm:w-40')} />
          </div>
          <button onClick={receive} disabled={busy} className="text-sm px-4 py-2 rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50">
            {busy ? 'Lançando...' : 'Lançar como Receita'}
          </button>
          <button onClick={() => setReceiving(false)} className="text-sm px-3 py-2 rounded-lg text-slate-500 hover:bg-slate-100">Cancelar</button>
        </div>
      )}
    </div>
  );
}

export function CommissionProvisions({ from, to }: { from: string; to: string }) {
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<CommissionProvision | null>(null);
  const [showReceived, setShowReceived] = useState(false);

  const { data } = useQuery({
    queryKey: ['commission-provisions'],
    queryFn: async () => (await api.get<CommissionProvision[]>('/api/finance/provisions')).data,
  });
  // Ordem: em contratação → concluído (falta receber) → perdido (não paga) — Fabio 14/11.
  const ORDEM: Record<string, number> = { CONTRATACAO: 0, CONCLUIDO: 1, REMOVIDO: 2, PERDIDO: 3 };
  const open = (data || []).filter((p) => p.status === 'OPEN').sort((a, b) => (ORDEM[a.leadSituacao || 'CONTRATACAO'] ?? 0) - (ORDEM[b.leadSituacao || 'CONTRATACAO'] ?? 0));
  const received = (data || []).filter((p) => p.status === 'RECEIVED');
  // "A soma de todos os processos pra receber" (Fabio 14/11): tudo em aberto, menos quem foi pra Perdidos (não paga). Separado por produto.
  const aReceber = open.filter((p) => p.leadSituacao !== 'PERDIDO');
  const perdidos = open.filter((p) => p.leadSituacao === 'PERDIDO');
  const soma = (xs: CommissionProvision[]) => xs.reduce((s, p) => s + p.amount, 0);
  const totalOpen = soma(aReceber);
  const he = aReceber.filter((p) => /home equity/i.test(p.product || ''));
  const fh = aReceber.filter((p) => /financiamento/i.test(p.product || ''));
  const outros = aReceber.filter((p) => !he.includes(p) && !fh.includes(p));
  const concluidos = aReceber.filter((p) => p.leadSituacao === 'CONCLUIDO');
  const semBanco = aReceber.filter((p) => !p.payer);
  // Total a receber por banco (Fabio 14/11), do maior pro menor; "sem banco" por último.
  const porBanco = Object.values(aReceber.reduce<Record<string, { nome: string; exemplo: CommissionProvision; total: number; n: number; he: number; fh: number }>>((acc, p) => {
    const nome = bancoDaProvisao(p.payer, p.product) || 'Sem banco';
    const g = (acc[nome] ||= { nome, exemplo: p, total: 0, n: 0, he: 0, fh: 0 });
    g.total += p.amount; g.n += 1;
    if (/home equity/i.test(p.product || '')) g.he += p.amount; else if (/financiamento/i.test(p.product || '')) g.fh += p.amount;
    return acc;
  }, {})).sort((a, b) => (a.nome === 'Sem banco' ? 1 : b.nome === 'Sem banco' ? -1 : b.total - a.total));
  const inPeriod = aReceber.filter((p) => p.expectedDate && dayOf(p.expectedDate) >= from && dayOf(p.expectedDate) <= to);
  const totalInPeriod = inPeriod.reduce((s, p) => s + p.amount, 0);
  const lateCount = aReceber.filter((p) => p.expectedDate && dayOf(p.expectedDate) < todayISO()).length;

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ['commission-provisions'] });
    queryClient.invalidateQueries({ queryKey: ['provision-candidates'] });
    queryClient.invalidateQueries({ queryKey: ['commission-suggestions'] });
    queryClient.invalidateQueries({ queryKey: ['finance'] });
  }

  function closeForm() {
    setFormOpen(false);
    setEditing(null);
  }

  return (
    <div className="bg-white rounded-2xl border border-af-border shadow-sm p-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
            <CalendarClock size={16} className="text-emerald-500" /> Provisão de comissões
            <span className="text-xs font-normal text-slate-400">(a receber dos processos — não entra no saldo)</span>
          </h3>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5 text-xs text-slate-500">
            <span>Previsto no período: <b className="text-slate-700">{formatCurrency(totalInPeriod)}</b> ({inPeriod.length})</span>
            {lateCount > 0 && <span className="text-red-500 font-medium">{lateCount} atrasada{lateCount > 1 ? 's' : ''}</span>}
          </div>
        </div>
        {!formOpen && (
          <button
            onClick={() => { setEditing(null); setFormOpen(true); }}
            className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 bg-emerald-500 text-white rounded-lg hover:bg-emerald-600 transition-colors self-start"
          >
            <Plus size={14} /> Nova provisão
          </button>
        )}
      </div>

      {open.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 mb-4">
          <div className="sm:col-span-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
            <p className="text-[11px] font-medium text-emerald-700 uppercase tracking-wide">Total a receber</p>
            <p className="text-2xl font-bold text-emerald-700">{formatCurrency(totalOpen)}</p>
            <p className="text-[11px] text-emerald-700/80">
              {aReceber.length} processo{aReceber.length === 1 ? '' : 's'}
              {concluidos.length > 0 && ` · ${concluidos.length} concluído${concluidos.length === 1 ? '' : 's'} aguardando o pagamento (${formatCurrency(soma(concluidos))})`}
            </p>
          </div>
          <div className="rounded-xl border border-af-border bg-white px-4 py-3">
            <p className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">Home Equity</p>
            <p className="text-lg font-bold text-slate-800">{formatCurrency(soma(he))}</p>
            <p className="text-[11px] text-slate-400">{he.length} processo{he.length === 1 ? '' : 's'}</p>
          </div>
          <div className="rounded-xl border border-af-border bg-white px-4 py-3">
            <p className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">Financiamento</p>
            <p className="text-lg font-bold text-slate-800">{formatCurrency(soma(fh))}</p>
            <p className="text-[11px] text-slate-400">{fh.length} processo{fh.length === 1 ? '' : 's'}</p>
          </div>
          {porBanco.length > 0 && (
            <div className="sm:col-span-4">
              <p className="text-[11px] font-medium text-slate-500 uppercase tracking-wide mb-1.5">Por banco</p>
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
                {porBanco.map((b) => (
                  <div key={b.nome} className="flex items-center gap-2 rounded-xl border border-af-border bg-white px-3 py-2 min-w-0" title={b.he && b.fh ? `Home Equity ${formatCurrency(b.he)} · Financiamento ${formatCurrency(b.fh)}` : undefined}>
                    <ProvisionBankIcon payer={b.nome === 'Sem banco' ? null : b.exemplo.payer} product={b.exemplo.product} />
                    <div className="min-w-0">
                      <p className="text-[11px] text-slate-500 truncate">{b.nome} · {b.n}</p>
                      <p className="text-sm font-bold text-slate-800 truncate">{formatCurrency(b.total)}</p>
                      {b.he > 0 && b.fh > 0 && <p className="text-[10px] text-slate-400 truncate">HE {formatCurrency(b.he)} · FH {formatCurrency(b.fh)}</p>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {(outros.length > 0 || perdidos.length > 0 || semBanco.length > 0) && (
            <div className="sm:col-span-4 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500 -mt-1">
              {outros.length > 0 && <span>Outros produtos: <b className="text-slate-700">{formatCurrency(soma(outros))}</b> ({outros.length})</span>}
              {semBanco.length > 0 && (
                <span title="Sem banco no card, a taxa é a padrão do produto (Home Equity 5%, Financiamento 0,8%) — pode ser menor">
                  {semBanco.length} sem banco identificado (taxa padrão): <b className="text-amber-600">{formatCurrency(soma(semBanco))}</b>
                </span>
              )}
              {perdidos.length > 0 && <span>Fora do total — em Perdidos: <b className="text-slate-500 line-through">{formatCurrency(soma(perdidos))}</b> ({perdidos.length})</span>}
            </div>
          )}
        </div>
      )}

      {formOpen && (
        <ProvisionForm key={editing?.id || 'new'} editing={editing} onClose={closeForm} onSaved={() => { closeForm(); refresh(); }} />
      )}

      {open.length === 0 && !formOpen ? (
        <p className="text-xs text-slate-400">Nenhuma provisão em aberto. Use "Nova provisão" para lançar a comissão prevista de um processo.</p>
      ) : (
        // Lista separada por produto (Fabio 14/11: "separa FH e HE"), cada grupo com o seu total a receber.
        <div className="space-y-5">
          {[
            { titulo: 'Home Equity', itens: open.filter((p) => he.includes(p) || (p.leadSituacao === 'PERDIDO' && /home equity/i.test(p.product || ''))), total: soma(he) },
            { titulo: 'Financiamento', itens: open.filter((p) => fh.includes(p) || (p.leadSituacao === 'PERDIDO' && /financiamento/i.test(p.product || ''))), total: soma(fh) },
            { titulo: 'Outros produtos', itens: open.filter((p) => !/home equity|financiamento/i.test(p.product || '')), total: soma(outros) },
          ].filter((g) => g.itens.length > 0).map((g) => (
            <div key={g.titulo}>
              <div className="flex items-baseline justify-between gap-3 mb-2 px-1">
                <h4 className="text-xs font-semibold text-slate-600 uppercase tracking-wide">{g.titulo}</h4>
                <span className="text-xs text-slate-500">a receber: <b className="text-emerald-600">{formatCurrency(g.total)}</b></span>
              </div>
              <div className="space-y-2">
                {g.itens.map((p) => (
                  <ProvisionRow key={p.id} p={p} onChanged={refresh} onEdit={() => { setEditing(p); setFormOpen(true); }} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {received.length > 0 && (
        <div className="mt-4">
          <button onClick={() => setShowReceived((v) => !v)} className="text-xs text-af-mid hover:underline">
            {showReceived ? 'Esconder recebidas' : `Ver recebidas (${received.length})`}
          </button>
          {showReceived && (
            <div className="mt-2 divide-y divide-af-border rounded-xl border border-af-border">
              {received.map((p) => (
                <div key={p.id} className="flex items-center justify-between gap-3 px-4 py-2 text-xs">
                  <span className="min-w-0 truncate text-slate-600">{p.leadName}{p.payer ? ` · ${p.payer}` : ''}</span>
                  <span className="flex-shrink-0 text-slate-400">
                    previsto {formatCurrency(p.amount)} · <b className="text-emerald-600">recebido {formatCurrency(p.receivedAmount ?? p.amount)}</b>
                    {p.receivedAt ? ` em ${formatDate(p.receivedAt)}` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
