'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Topbar } from '@/components/ui/topbar';
import { toast } from '@/components/ui/toast';
import { Skeleton } from '@/components/ui/skeleton';
import api from '@/lib/api';
import { formatCurrency, formatDate, cn } from '@/lib/utils';
import { Transaction, TransactionType } from '@/types';
import { Plus, TrendingUp, TrendingDown, Wallet, Trash2, X, PiggyBank, Pencil } from 'lucide-react';

interface FinanceResponse {
  transactions: Transaction[];
  totalIncome: number;
  totalExpense: number;
  totalSavingsPeriod: number;
  totalSavingsAllTime: number;
  balance: number;
}

const TYPE_LABELS: Record<TransactionType, string> = { INCOME: 'Receita', EXPENSE: 'Despesa', SAVINGS: 'Poupança' };
const TYPE_BADGE: Record<TransactionType, string> = {
  INCOME: 'bg-emerald-50 text-emerald-600',
  EXPENSE: 'bg-red-50 text-red-500',
  SAVINGS: 'bg-indigo-50 text-indigo-500',
};
const TYPE_TEXT: Record<TransactionType, string> = {
  INCOME: 'text-emerald-600',
  EXPENSE: 'text-red-500',
  SAVINGS: 'text-indigo-500',
};
const TYPE_SIGN: Record<TransactionType, string> = { INCOME: '+', EXPENSE: '-', SAVINGS: '-' };

async function fetchFinance(from: string, to: string): Promise<FinanceResponse> {
  const { data } = await api.get(`/api/finance?from=${from}&to=${to}`);
  return data;
}

function defaultFrom() {
  const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}
function defaultTo() {
  const d = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function FinanceiroPage() {
  const [from, setFrom] = useState(defaultFrom());
  const [to, setTo] = useState(defaultTo());
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formType, setFormType] = useState<TransactionType>('INCOME');
  const [formDescription, setFormDescription] = useState('');
  const [formAmount, setFormAmount] = useState('');
  const [formDate, setFormDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);

  const [showSavings, setShowSavings] = useState(false);
  const [savingsAmount, setSavingsAmount] = useState('');
  const [savingsDescription, setSavingsDescription] = useState('');
  const [savingSavings, setSavingSavings] = useState(false);

  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['finance', from, to],
    queryFn: () => fetchFinance(from, to),
  });

  function resetForm() {
    setFormDescription('');
    setFormAmount('');
    setFormDate(new Date().toISOString().slice(0, 10));
    setFormType('INCOME');
    setEditingId(null);
    setShowAdd(false);
  }

  // Abre o formulário já preenchido para editar um lançamento existente.
  function openEdit(t: Transaction) {
    setEditingId(t.id);
    setFormType(t.type === 'EXPENSE' ? 'EXPENSE' : 'INCOME');
    setFormDescription(t.description);
    setFormAmount(String(t.amount).replace('.', ','));
    setFormDate(new Date(t.date).toISOString().slice(0, 10));
    setShowAdd(true);
  }

  async function handleSave() {
    const amount = Number(formAmount.replace(/\./g, '').replace(',', '.'));
    if (!formDescription.trim() || !amount || amount <= 0) {
      toast('Preencha descrição e valor válido', 'error');
      return;
    }
    setSaving(true);
    try {
      const payload = { description: formDescription.trim(), amount, type: formType, date: formDate };
      if (editingId) {
        await api.patch(`/api/finance/${editingId}`, payload);
        toast('Lançamento atualizado!');
      } else {
        await api.post('/api/finance', payload);
        toast(formType === 'INCOME' ? 'Receita lançada!' : 'Despesa lançada!');
      }
      queryClient.invalidateQueries({ queryKey: ['finance'] });
      resetForm();
    } catch {
      toast('Erro ao salvar lançamento', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveSavings() {
    const amount = Number(savingsAmount.replace(/\./g, '').replace(',', '.'));
    if (!amount || amount <= 0) {
      toast('Informe um valor válido', 'error');
      return;
    }
    if ((data?.balance || 0) < amount) {
      toast('Valor maior que o saldo disponível no período', 'error');
      return;
    }
    setSavingSavings(true);
    try {
      await api.post('/api/finance/savings', {
        amount,
        description: savingsDescription.trim() || undefined,
      });
      toast('Valor guardado na poupança!');
      queryClient.invalidateQueries({ queryKey: ['finance'] });
      setSavingsAmount('');
      setSavingsDescription('');
      setShowSavings(false);
    } catch {
      toast('Erro ao guardar na poupança', 'error');
    } finally {
      setSavingSavings(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      await api.delete(`/api/finance/${id}`);
      toast('Lançamento excluído');
      queryClient.invalidateQueries({ queryKey: ['finance'] });
    } catch {
      toast('Erro ao excluir lançamento', 'error');
    }
  }

  // Maiores gastos do período (agrupados por descrição) — base do gráfico.
  const topExpenses = (() => {
    const map = new Map<string, number>();
    (data?.transactions || [])
      .filter((t) => t.type === 'EXPENSE')
      .forEach((t) => map.set(t.description, (map.get(t.description) || 0) + t.amount));
    return Array.from(map.entries())
      .map(([description, total]) => ({ description, total }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 6);
  })();
  const maxExpense = topExpenses[0]?.total || 1;

  return (
    <div className="flex flex-col h-full">
      <Topbar title="Financeiro" subtitle="Receitas e despesas do escritório" />

      <div className="flex items-center justify-between px-6 py-3 app-topbar-surface border-b gap-4">
        <div className="flex items-center gap-2">
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="text-xs px-2 py-1.5 border border-af-border rounded-lg bg-white text-slate-700 focus:outline-none focus:ring-1 focus:ring-af-accent" />
          <span className="text-xs app-topbar-text-muted">até</span>
          <input type="date" value={to} onChange={e => setTo(e.target.value)} className="text-xs px-2 py-1.5 border border-af-border rounded-lg bg-white text-slate-700 focus:outline-none focus:ring-1 focus:ring-af-accent" />
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowSavings(true)}
            className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 bg-indigo-500 text-white rounded-lg hover:bg-indigo-600 transition-colors"
          >
            <PiggyBank size={14} /> Guardar na poupança
          </button>
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 bg-af-mid text-white rounded-lg hover:bg-af-dark transition-colors"
          >
            <Plus size={14} /> Novo lançamento
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto px-6 py-5 space-y-5 scrollbar-thin">
        {/* KPIs */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {isLoading ? (
            [1, 2, 3, 4].map(i => <Skeleton key={i} className="h-24" />)
          ) : (
            <>
              <div className="bg-white rounded-xl border border-af-border p-5 shadow-sm flex items-start justify-between">
                <div>
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Receitas</p>
                  <p className="text-2xl font-bold text-emerald-600 mt-1">{formatCurrency(data?.totalIncome || 0)}</p>
                </div>
                <div className="p-2.5 rounded-xl bg-emerald-50"><TrendingUp size={20} className="text-emerald-500" /></div>
              </div>
              <div className="bg-white rounded-xl border border-af-border p-5 shadow-sm flex items-start justify-between">
                <div>
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Despesas</p>
                  <p className="text-2xl font-bold text-red-500 mt-1">{formatCurrency(data?.totalExpense || 0)}</p>
                </div>
                <div className="p-2.5 rounded-xl bg-red-50"><TrendingDown size={20} className="text-red-500" /></div>
              </div>
              <div className="bg-white rounded-xl border border-af-border p-5 shadow-sm flex items-start justify-between">
                <div>
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Saldo do período</p>
                  <p className={cn('text-2xl font-bold mt-1', (data?.balance || 0) >= 0 ? 'text-slate-900' : 'text-red-500')}>{formatCurrency(data?.balance || 0)}</p>
                </div>
                <div className="p-2.5 rounded-xl bg-af-light"><Wallet size={20} className="text-af-mid" /></div>
              </div>
              <div className="bg-white rounded-xl border border-af-border p-5 shadow-sm flex items-start justify-between">
                <div>
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Poupança acumulada</p>
                  <p className="text-2xl font-bold text-indigo-500 mt-1">{formatCurrency(data?.totalSavingsAllTime || 0)}</p>
                </div>
                <div className="p-2.5 rounded-xl bg-indigo-50"><PiggyBank size={20} className="text-indigo-500" /></div>
              </div>
            </>
          )}
        </div>

        {/* Gráfico: onde mais gastou no período (por descrição) */}
        {!isLoading && topExpenses.length > 0 && (
          <div className="bg-white rounded-2xl border border-af-border shadow-sm p-5">
            <h3 className="text-sm font-semibold text-slate-700 mb-4 flex items-center gap-2">
              <TrendingDown size={16} className="text-red-500" /> Onde você mais gastou no período
            </h3>
            <div className="space-y-2.5">
              {topExpenses.map((e) => (
                <div key={e.description}>
                  <div className="flex items-center justify-between text-xs mb-1 gap-2">
                    <span className="text-slate-600 truncate">{e.description}</span>
                    <span className="font-semibold text-red-500 flex-shrink-0">{formatCurrency(e.total)}</span>
                  </div>
                  <div className="h-2.5 bg-slate-100 rounded-full overflow-hidden">
                    <div className="h-full rounded-full bg-red-400" style={{ width: `${Math.max(4, (e.total / maxExpense) * 100)}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Formulário de novo lançamento */}
        {showAdd && (
          <div className="bg-white rounded-2xl border border-af-border shadow-sm p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-slate-700">{editingId ? 'Editar lançamento' : 'Novo lançamento'}</h3>
              <button onClick={resetForm} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="flex bg-slate-100 rounded-xl p-1 gap-1 sm:col-span-2 max-w-xs">
                <button
                  onClick={() => setFormType('INCOME')}
                  className={cn('flex-1 py-2 rounded-lg text-sm font-medium transition-all', formType === 'INCOME' ? 'bg-white shadow text-emerald-600' : 'text-slate-500')}
                >
                  Receita
                </button>
                <button
                  onClick={() => setFormType('EXPENSE')}
                  className={cn('flex-1 py-2 rounded-lg text-sm font-medium transition-all', formType === 'EXPENSE' ? 'bg-white shadow text-red-500' : 'text-slate-500')}
                >
                  Despesa
                </button>
              </div>
              <div className="sm:col-span-2">
                <label className="text-xs font-medium text-slate-500 mb-1 block">Descrição</label>
                <input
                  value={formDescription}
                  onChange={e => setFormDescription(e.target.value)}
                  placeholder="Ex: Aluguel do escritório"
                  className="w-full text-sm px-3 py-2 border border-af-border rounded-lg bg-white text-slate-800 focus:outline-none focus:ring-1 focus:ring-af-accent"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-500 mb-1 block">Valor (R$)</label>
                <input
                  value={formAmount}
                  onChange={e => setFormAmount(e.target.value)}
                  placeholder="Ex: 1.500,00"
                  className="w-full text-sm px-3 py-2 border border-af-border rounded-lg bg-white text-slate-800 focus:outline-none focus:ring-1 focus:ring-af-accent"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-500 mb-1 block">Data</label>
                <input
                  type="date"
                  value={formDate}
                  onChange={e => setFormDate(e.target.value)}
                  className="w-full text-sm px-3 py-2 border border-af-border rounded-lg bg-white text-slate-800 focus:outline-none focus:ring-1 focus:ring-af-accent"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={resetForm} className="text-sm px-4 py-2 rounded-lg text-slate-500 hover:bg-slate-100">Cancelar</button>
              <button onClick={handleSave} disabled={saving} className="text-sm px-4 py-2 rounded-lg bg-af-mid text-white hover:bg-af-dark disabled:opacity-50">
                {saving ? 'Salvando...' : editingId ? 'Salvar alterações' : 'Salvar lançamento'}
              </button>
            </div>
          </div>
        )}

        {/* Guardar na poupança */}
        {showSavings && (
          <div className="bg-white rounded-2xl border border-indigo-200 shadow-sm p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2"><PiggyBank size={16} className="text-indigo-500" /> Guardar na poupança</h3>
              <button onClick={() => { setShowSavings(false); setSavingsAmount(''); setSavingsDescription(''); }} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
            </div>
            <p className="text-xs text-slate-500 mb-3">O valor é retirado do saldo disponível do período e somado ao total acumulado em poupança.</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-slate-500 mb-1 block">Valor (R$)</label>
                <input
                  value={savingsAmount}
                  onChange={e => setSavingsAmount(e.target.value)}
                  placeholder="Ex: 500,00"
                  className="w-full text-sm px-3 py-2 border border-af-border rounded-lg bg-white text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-500 mb-1 block">Descrição (opcional)</label>
                <input
                  value={savingsDescription}
                  onChange={e => setSavingsDescription(e.target.value)}
                  placeholder="Ex: Reserva de emergência"
                  className="w-full text-sm px-3 py-2 border border-af-border rounded-lg bg-white text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => { setShowSavings(false); setSavingsAmount(''); setSavingsDescription(''); }} className="text-sm px-4 py-2 rounded-lg text-slate-500 hover:bg-slate-100">Cancelar</button>
              <button onClick={handleSaveSavings} disabled={savingSavings} className="text-sm px-4 py-2 rounded-lg bg-indigo-500 text-white hover:bg-indigo-600 disabled:opacity-50">
                {savingSavings ? 'Guardando...' : 'Guardar na poupança'}
              </button>
            </div>
          </div>
        )}

        {/* Extrato */}
        <div className="bg-white rounded-2xl border border-af-border shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-af-border">
            <h3 className="text-sm font-semibold text-slate-700">Extrato</h3>
          </div>
          {isLoading ? (
            <div className="p-5 space-y-3">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-10" />)}
            </div>
          ) : data?.transactions.length === 0 ? (
            <div className="flex items-center justify-center py-10 text-slate-400 text-sm">
              Nenhum lançamento neste período
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-af-border text-xs text-slate-500 font-semibold uppercase tracking-wide">
                    <th className="text-left px-5 py-3">Descrição</th>
                    <th className="text-left px-4 py-3">Tipo</th>
                    <th className="text-left px-4 py-3">Lançado por</th>
                    <th className="text-right px-4 py-3">Valor</th>
                    <th className="text-right px-4 py-3">Data</th>
                    <th className="text-right px-5 py-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-af-border">
                  {data?.transactions.map((t) => (
                    <tr key={t.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-5 py-3 font-medium text-slate-800">{t.description}</td>
                      <td className="px-4 py-3">
                        <span className={cn('text-xs font-semibold px-2 py-0.5 rounded-full', TYPE_BADGE[t.type])}>
                          {TYPE_LABELS[t.type]}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-500">{t.user?.name || '—'}</td>
                      <td className={cn('px-4 py-3 text-right font-semibold', TYPE_TEXT[t.type])}>
                        {TYPE_SIGN[t.type]} {formatCurrency(t.amount)}
                      </td>
                      <td className="px-4 py-3 text-right text-slate-400 text-xs">{formatDate(t.date)}</td>
                      <td className="px-5 py-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          {t.type !== 'SAVINGS' && (
                            <button onClick={() => openEdit(t)} className="text-slate-300 hover:text-af-mid transition-colors" title="Editar">
                              <Pencil size={14} />
                            </button>
                          )}
                          <button onClick={() => handleDelete(t.id)} className="text-slate-300 hover:text-red-500 transition-colors" title="Excluir">
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
