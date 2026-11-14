'use client';
import { useEffect, useState } from 'react';
import { toast } from '@/components/ui/toast';
import api from '@/lib/api';
import { formatCurrency, formatDate, cn } from '@/lib/utils';
import { CommissionNote, CommissionNoteCandidate, LearnedRate } from '@/types';
import { Check, ExternalLink, FileText, Loader2, Pencil, Plus, Trash2, Upload, X } from 'lucide-react';
import { ProvisionBankIcon } from './provision-bank-icon';

/* Notas de comissão (Fabio 14/11): "podemos receber mais de um processo pro banco e seria tudo incluso na mesma nota".
 * Lançar: escolhe quem paga + anexa o PDF → a IA lê nº/data/total (e os clientes, se a nota listar) → o CRM marca os processos e o valor de cada um
 * → confere e salva. O valor da nota substitui a estimativa pela % e a taxa efetiva vira a sugestão dos próximos clientes do mesmo banco e produto.
 * Quando o dinheiro cai: "Recebida" → uma Receita com o total e baixa em todos os processos da nota. */

const PAGADORES = ['Credimorar', 'Inter', 'Creditas', 'Santander', 'Bradesco', 'Itaú', 'CAIXA', 'BRB', 'Âncora'];
const inputCls = 'w-full text-sm px-3 py-2 border border-af-border rounded-lg bg-white text-slate-800 focus:outline-none focus:ring-1 focus:ring-af-accent';
const toMoneyInput = (n: number) => (n ? n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '');
const parseMoney = (s: string) => Number(String(s).replace(/\./g, '').replace(',', '.')) || 0;
const todayISO = () => new Date().toLocaleDateString('en-CA');
const dayOf = (d?: string | null) => (d ? new Date(d).toLocaleDateString('en-CA') : '');
const raiz = (p?: string | null) => String(p || '').replace(/\s*\(.*\)\s*$/, '').trim().toLowerCase();
const PRODUTO: Record<string, string> = { HE: 'Home Equity', FH: 'Financiamento', OUTRO: 'Outros' };

/** Divide o total na proporção das estimativas (centavos exatos). */
function dividir(total: number, pesos: number[]): number[] {
  const soma = pesos.reduce((s, p) => s + p, 0);
  if (!(soma > 0)) return pesos.map(() => 0);
  const partes = pesos.map((p) => Math.round(((total * p) / soma) * 100) / 100);
  const dif = Math.round((total - partes.reduce((s, p) => s + p, 0)) * 100) / 100;
  if (partes.length) partes[partes.length - 1] = Math.round((partes[partes.length - 1] + dif) * 100) / 100;
  return partes;
}

async function abrirArquivo(id: string) {
  try {
    const res = await api.get(`/api/finance/notes/${id}/file`, { responseType: 'blob' });
    const url = URL.createObjectURL(res.data as Blob);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch {
    toast('Não consegui abrir o arquivo da nota', 'error');
  }
}

type Revisao = {
  nota: CommissionNote;
  candidatos: CommissionNoteCandidate[];
  marcados: Record<string, string>; // id do processo → valor digitado
  motivos: Record<string, string>;
  observacao?: string | null;
  lida: boolean;
};

/** Lançar (ou corrigir) uma nota: passo 1 escolhe quem paga + arquivo; passo 2 confere os processos e o valor de cada um. */
function NotaForm({ editar, onClose, onSaved }: { editar: CommissionNote | null; onClose: () => void; onSaved: () => void }) {
  const [payer, setPayer] = useState(editar?.payer || '');
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [lendo, setLendo] = useState(false);
  const [rev, setRev] = useState<Revisao | null>(null);
  const [numero, setNumero] = useState(editar?.number || '');
  const [data, setData] = useState(dayOf(editar?.issueDate));
  const [total, setTotal] = useState(editar ? toMoneyInput(editar.totalAmount) : '');
  // Impostos (Fabio 14/11): retidos saem do que cai na conta; ISS não retido a A&F paga depois.
  const [retido, setRetido] = useState(editar?.retainedAmount ? toMoneyInput(editar.retainedAmount) : '');
  const [liquido, setLiquido] = useState(editar?.netAmount ? toMoneyInput(editar.netAmount) : '');
  const [aPagar, setAPagar] = useState(editar?.taxesToPay ? toMoneyInput(editar.taxesToPay) : '');
  const [liquidoTocado, setLiquidoTocado] = useState(!!editar?.netAmount);
  const [salvando, setSalvando] = useState(false);
  const [mostrarTodos, setMostrarTodos] = useState(false);

  // Corrigir nota já lançada: carrega os processos possíveis + os que já estão nela.
  useEffect(() => {
    if (!editar) return;
    api.get<CommissionNoteCandidate[]>(`/api/finance/notes/${editar.id}/candidates`).then(({ data: candidatos }) => {
      const marcados: Record<string, string> = {};
      for (const p of editar.processos || []) marcados[p.id] = toMoneyInput(p.amount);
      setRev({ nota: editar, candidatos, marcados, motivos: {}, observacao: editar.aiRead?.observacao, lida: true });
    }).catch(() => toast('Erro ao carregar os processos', 'error'));
  }, [editar]);

  async function ler() {
    if (!payer.trim()) return toast('Escolha quem paga a nota', 'error');
    if (!arquivo) return toast('Anexe o PDF da nota', 'error');
    setLendo(true);
    try {
      const { data: r } = await api.post(`/api/finance/notes/read?payer=${encodeURIComponent(payer.trim())}&fileName=${encodeURIComponent(arquivo.name)}`, arquivo, {
        headers: { 'Content-Type': arquivo.type || 'application/pdf' },
        timeout: 180_000,
      });
      const marcados: Record<string, string> = {};
      const motivos: Record<string, string> = {};
      for (const it of r.proposta || []) { marcados[it.id] = toMoneyInput(it.amount); motivos[it.id] = it.motivo; }
      setNumero(r.nota.number || '');
      setData(dayOf(r.nota.issueDate));
      setTotal(r.nota.totalAmount ? toMoneyInput(r.nota.totalAmount) : '');
      setRetido(r.nota.retainedAmount ? toMoneyInput(r.nota.retainedAmount) : '');
      setLiquido(r.nota.netAmount ? toMoneyInput(r.nota.netAmount) : '');
      setAPagar(r.nota.taxesToPay ? toMoneyInput(r.nota.taxesToPay) : '');
      setLiquidoTocado(!!r.nota.netAmount);
      setRev({ nota: r.nota, candidatos: r.candidatos || [], marcados, motivos, observacao: r.leitura?.observacao, lida: !!r.lida });
      if (!r.lida) toast('Não consegui ler a nota — preencha o número, a data e o total', 'error');
    } catch (e: any) {
      toast(e?.response?.data?.error || 'Erro ao ler a nota', 'error');
    } finally {
      setLendo(false);
    }
  }

  async function cancelar() {
    if (rev && rev.nota.status === 'DRAFT') await api.delete(`/api/finance/notes/${rev.nota.id}`).catch(() => {});
    onClose();
  }

  const totalNum = parseMoney(total);
  const liquidoNum = liquidoTocado ? parseMoney(liquido) : Math.max(0, Math.round((totalNum - parseMoney(retido)) * 100) / 100);
  const somaMarcados = rev ? Object.values(rev.marcados).reduce((s, v) => s + parseMoney(v), 0) : 0;
  const diferenca = Math.round((totalNum - somaMarcados) * 100) / 100;

  function alternar(c: CommissionNoteCandidate) {
    if (!rev) return;
    const marcados = { ...rev.marcados };
    if (c.id in marcados) delete marcados[c.id]; else marcados[c.id] = toMoneyInput(c.estimado);
    setRev({ ...rev, marcados });
  }
  function dividirPelaEstimativa() {
    if (!rev) return;
    const ids = Object.keys(rev.marcados);
    const partes = dividir(totalNum, ids.map((id) => rev.candidatos.find((c) => c.id === id)?.estimado || 1));
    setRev({ ...rev, marcados: Object.fromEntries(ids.map((id, i) => [id, toMoneyInput(partes[i])])) });
  }

  async function salvar() {
    if (!rev) return;
    const itens = Object.entries(rev.marcados).map(([id, v]) => ({ id, amount: parseMoney(v) })).filter((i) => i.amount > 0);
    if (!(totalNum > 0)) return toast('Informe o total da nota', 'error');
    if (!itens.length) return toast('Marque os processos que estão na nota', 'error');
    if (Math.abs(diferenca) > 0.01) return toast(`A soma dos processos não bate com o total (diferença de ${formatCurrency(diferenca)})`, 'error');
    setSalvando(true);
    try {
      const { data: r } = await api.put(`/api/finance/notes/${rev.nota.id}`, {
        payer: payer.trim(), number: numero.trim() || null, issueDate: data || null, totalAmount: totalNum, itens,
        retainedAmount: parseMoney(retido), netAmount: liquidoNum > 0 ? liquidoNum : null, taxesToPay: parseMoney(aPagar),
      });
      const onde = r.nota?.drivePath ? ` Guardada no Drive: ${r.nota.drivePath}.` : '';
      toast(r.reestimadas?.length ? `Nota salva!${onde} ${r.reestimadas.length} estimativa${r.reestimadas.length === 1 ? '' : 's'} do mesmo banco ajustada${r.reestimadas.length === 1 ? '' : 's'} pela taxa da nota` : `Nota salva!${onde}`);
      onSaved();
    } catch (e: any) {
      toast(e?.response?.data?.error || 'Erro ao salvar a nota', 'error');
    } finally {
      setSalvando(false);
    }
  }

  // Processos do mesmo pagador (ou sem banco) primeiro; os outros ficam escondidos até pedir.
  const lista = rev ? [...rev.candidatos].sort((a, b) => Number(b.id in rev.marcados) - Number(a.id in rev.marcados)) : [];
  const doPagador = (c: CommissionNoteCandidate) => !c.pagador || raiz(c.pagador) === raiz(payer) || (raiz(payer) === 'santander' && raiz(c.pagador) === 'credimorar');
  const visiveis = lista.filter((c) => mostrarTodos || c.id in (rev?.marcados || {}) || doPagador(c));
  const escondidos = lista.length - visiveis.length;

  return (
    <div className="rounded-xl border border-af-border bg-slate-50 p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-sm font-semibold text-slate-700">{editar ? `Corrigir nota${editar.number ? ` nº ${editar.number}` : ''}` : 'Lançar nota de comissão'}</h4>
        <button onClick={cancelar} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
      </div>

      {!rev && !editar && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
          <div>
            <label className="text-xs font-medium text-slate-500 mb-1 block">Quem paga</label>
            <select value={payer} onChange={(e) => setPayer(e.target.value)} className={inputCls}>
              <option value="">Escolha o banco…</option>
              {PAGADORES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-500 mb-1 block">Nota (PDF ou foto)</label>
            <label className={cn(inputCls, 'flex items-center gap-2 cursor-pointer text-slate-500')}>
              <Upload size={14} />
              <span className="truncate">{arquivo ? arquivo.name : 'Escolher arquivo…'}</span>
              <input type="file" accept="application/pdf,image/*" className="hidden" onChange={(e) => setArquivo(e.target.files?.[0] || null)} />
            </label>
          </div>
          <button onClick={ler} disabled={lendo} className="text-sm px-4 py-2 rounded-lg bg-af-mid text-white hover:bg-af-dark disabled:opacity-50 flex items-center justify-center gap-2">
            {lendo ? <><Loader2 size={14} className="animate-spin" /> Lendo a nota…</> : 'Ler a nota'}
          </button>
        </div>
      )}

      {rev && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <div>
              <label className="text-xs font-medium text-slate-500 mb-1 block">Quem paga</label>
              <select value={payer} onChange={(e) => setPayer(e.target.value)} className={inputCls}>
                {Array.from(new Set([payer, ...PAGADORES])).filter(Boolean).map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-slate-500 mb-1 block">Nº da nota</label>
              <input value={numero} onChange={(e) => setNumero(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-500 mb-1 block">Emissão</label>
              <input type="date" value={data} onChange={(e) => setData(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-500 mb-1 block">Total da nota (R$)</label>
              <input value={total} onChange={(e) => setTotal(e.target.value)} className={cn(inputCls, 'font-semibold')} />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 mt-3">
            <div>
              <label className="text-xs font-medium text-slate-500 mb-1 block">Impostos retidos na nota (R$)</label>
              <input value={retido} onChange={(e) => setRetido(e.target.value)} placeholder="IRRF, ISS retido…" className={inputCls} />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-500 mb-1 block">Líquido que cai na conta (R$)</label>
              <input value={liquidoTocado ? liquido : toMoneyInput(liquidoNum)} onChange={(e) => { setLiquido(e.target.value); setLiquidoTocado(true); }} className={cn(inputCls, 'font-semibold text-emerald-700')} />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-500 mb-1 block">Impostos a pagar (não retidos)</label>
              <input value={aPagar} onChange={(e) => setAPagar(e.target.value)} placeholder="ISS da nota" className={inputCls} />
            </div>
            <div className="text-[11px] text-slate-500 self-end pb-2">
              {rev.nota.docType === 'DEMONSTRATIVO' ? 'Demonstrativo do banco' : 'Nota fiscal (NFS-e)'}{rev.nota.drivePath ? ' · já está no Drive' : ' · vai pro Drive no padrão ao salvar'}
            </div>
          </div>
          {rev.observacao && <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5 mt-2">IA: {rev.observacao}</p>}

          <div className="flex items-center justify-between gap-3 mt-4 mb-1.5">
            <p className="text-xs font-semibold text-slate-600">Processos nesta nota</p>
            <button onClick={dividirPelaEstimativa} disabled={!Object.keys(rev.marcados).length || !(totalNum > 0)} className="text-[11px] text-af-mid hover:underline disabled:opacity-40">
              dividir o total pela estimativa
            </button>
          </div>
          <div className="max-h-80 overflow-y-auto divide-y divide-af-border rounded-lg border border-af-border bg-white scrollbar-thin">
            {!visiveis.length && <p className="text-xs text-slate-400 px-3 py-3">Nenhum processo em aberto desse banco.</p>}
            {visiveis.map((c) => {
              const marcado = c.id in rev.marcados;
              return (
                <div key={c.id} className={cn('flex items-center gap-3 px-3 py-2', marcado && 'bg-emerald-50/50')}>
                  <input type="checkbox" checked={marcado} onChange={() => alternar(c)} className="accent-emerald-600" />
                  <ProvisionBankIcon payer={c.pagador} product={c.produto} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-800 truncate">{c.cliente}{c.kind === 'SUGGESTION' && <span className="ml-2 text-[10px] font-normal text-amber-700">concluído</span>}</p>
                    <p className="text-[11px] text-slate-500 truncate">{c.etapa}{c.pagador ? ` · paga: ${c.pagador}` : ' · sem banco'} · crédito {formatCurrency(c.credito)} · estimado {formatCurrency(c.estimado)}</p>
                    {marcado && rev.motivos[c.id] && <p className="text-[10px] text-emerald-700 truncate">{rev.motivos[c.id]}</p>}
                  </div>
                  {marcado && (
                    <input value={rev.marcados[c.id]} onChange={(e) => setRev({ ...rev, marcados: { ...rev.marcados, [c.id]: e.target.value } })} className={cn(inputCls, 'w-32 text-right')} />
                  )}
                </div>
              );
            })}
          </div>
          {escondidos > 0 && (
            <button onClick={() => setMostrarTodos(true)} className="text-[11px] text-af-mid hover:underline mt-1">ver os outros {escondidos} processos (outros bancos)</button>
          )}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mt-3">
            <p className={cn('text-xs', Math.abs(diferenca) > 0.01 ? 'text-red-600 font-medium' : 'text-emerald-700')}>
              Soma dos processos: {formatCurrency(somaMarcados)} {Math.abs(diferenca) > 0.01 ? `· falta ${diferenca > 0 ? '' : 'tirar '}${formatCurrency(Math.abs(diferenca))} pra bater com a nota` : '· bate com a nota ✓'}
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={cancelar} className="text-sm px-4 py-2 rounded-lg text-slate-500 hover:bg-slate-100">Cancelar</button>
              <button onClick={salvar} disabled={salvando} className="text-sm px-4 py-2 rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50">
                {salvando ? 'Salvando...' : 'Salvar nota'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function NotaRow({ n, onEdit, onChanged }: { n: CommissionNote; onEdit: () => void; onChanged: () => void }) {
  const [recebendo, setRecebendo] = useState(false);
  const liquidoDaNota = n.netAmount ?? Math.round((n.totalAmount - (n.retainedAmount || 0)) * 100) / 100;
  const [valor, setValor] = useState(toMoneyInput(liquidoDaNota));
  const [quando, setQuando] = useState(todayISO());
  const [busy, setBusy] = useState(false);
  const [aberta, setAberta] = useState(false);
  const procs = n.processos || [];
  const estimado = procs.reduce((s, p) => s + (p.estimatedAmount ?? p.amount), 0);

  async function receber() {
    const v = parseMoney(valor);
    if (!(v > 0)) return toast('Informe um valor válido', 'error');
    setBusy(true);
    try {
      await api.post(`/api/finance/notes/${n.id}/receive`, { amount: v, date: quando });
      toast('Nota recebida — lançada como Receita!');
      onChanged();
    } catch (e: any) {
      toast(e?.response?.data?.error || 'Erro ao registrar o recebimento', 'error');
    } finally {
      setBusy(false);
    }
  }
  async function excluir() {
    if (!confirm(`Tirar a nota${n.number ? ` nº ${n.number}` : ''}? Os processos voltam pro valor estimado.`)) return;
    try {
      await api.delete(`/api/finance/notes/${n.id}`);
      toast('Nota excluída');
      onChanged();
    } catch (e: any) {
      toast(e?.response?.data?.error || 'Erro ao excluir a nota', 'error');
    }
  }

  return (
    <div className={cn('px-4 py-3 rounded-xl border border-af-border bg-white', n.status === 'RECEIVED' && 'opacity-70')}>
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
        <div className="flex-1 min-w-0 flex items-center gap-3">
          <ProvisionBankIcon payer={n.payer} product={null} />
          <div className="min-w-0">
            <button onClick={() => setAberta((v) => !v)} className="text-sm font-medium text-slate-800 hover:text-af-mid hover:underline text-left">
              Nota {n.number ? `nº ${n.number}` : 'sem número'} · {n.payer}
            </button>
            <p className="text-[11px] text-slate-500 truncate">
              {n.issueDate ? `emitida ${formatDate(n.issueDate)} · ` : ''}{procs.length} processo{procs.length === 1 ? '' : 's'}
              {estimado > 0 && Math.abs(estimado - n.totalAmount) >= 0.01 && ` · o CRM estimava ${formatCurrency(estimado)}`}
            </p>
            {((n.retainedAmount || 0) > 0 || (n.taxesToPay || 0) > 0) && (
              <p className="text-[11px] text-slate-500 truncate">
                {(n.retainedAmount || 0) > 0 && <>retido na nota {formatCurrency(n.retainedAmount || 0)} · </>}
                líquido <b className="text-emerald-700">{formatCurrency(liquidoDaNota)}</b>
                {(n.taxesToPay || 0) > 0 && <> · <span className="text-amber-700">ISS a pagar {formatCurrency(n.taxesToPay || 0)}</span></>}
              </p>
            )}
            {n.drivePath && <p className="text-[10px] text-slate-400 truncate">Drive: {n.drivePath}</p>}
          </div>
        </div>
        <div className="sm:text-right flex-shrink-0 sm:w-36">
          <p className="text-sm font-bold text-emerald-600">{formatCurrency(n.totalAmount)}</p>
          <p className="text-[11px] text-slate-400">{n.status === 'RECEIVED' ? `recebida ${n.receivedAt ? formatDate(n.receivedAt) : ''}` : 'bruto · a receber'}</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button onClick={() => abrirArquivo(n.id)} className="text-slate-400 hover:text-af-mid" title="Ver o arquivo da nota"><FileText size={15} /></button>
          {n.driveLink && <a href={n.driveLink} target="_blank" rel="noopener noreferrer" className="text-slate-400 hover:text-af-mid" title={n.drivePath || 'Abrir no Drive'}><ExternalLink size={14} /></a>}
          {n.status === 'OPEN' && (
            <>
              <button onClick={() => setRecebendo((v) => !v)} className="flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 bg-emerald-500 text-white rounded-lg hover:bg-emerald-600">
                <Check size={13} /> Recebida
              </button>
              <button onClick={onEdit} className="text-slate-300 hover:text-af-mid" title="Corrigir"><Pencil size={14} /></button>
              <button onClick={excluir} className="text-slate-300 hover:text-red-500" title="Excluir"><Trash2 size={14} /></button>
            </>
          )}
        </div>
      </div>
      {aberta && procs.length > 0 && (
        <div className="mt-2 pt-2 border-t border-af-border space-y-1">
          {procs.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-3 text-[11px]">
              <span className="text-slate-600 truncate">{p.leadName}{p.payer ? ` · ${p.payer}` : ''}</span>
              <span className="flex-shrink-0 text-slate-500">
                {p.estimatedAmount != null && Math.abs(p.estimatedAmount - p.amount) >= 0.01 && <span className="line-through mr-2 text-slate-400">{formatCurrency(p.estimatedAmount)}</span>}
                <b className="text-emerald-700">{formatCurrency(p.receivedAmount ?? p.amount)}</b>
                {p.baseAmount > 0 && <span className="ml-1 text-slate-400">({String(Math.round(((p.receivedAmount ?? p.amount) / p.baseAmount) * 100 * 1000) / 1000).replace('.', ',')}%)</span>}
              </span>
            </div>
          ))}
        </div>
      )}
      {recebendo && (
        <div className="mt-3 pt-3 border-t border-af-border flex flex-col sm:flex-row sm:items-end gap-2">
          <div>
            <label className="text-[11px] font-medium text-slate-500 mb-1 block">Valor que caiu (líquido, R$)</label>
            <input value={valor} onChange={(e) => setValor(e.target.value)} className={cn(inputCls, 'sm:w-36')} />
          </div>
          <div>
            <label className="text-[11px] font-medium text-slate-500 mb-1 block">Data</label>
            <input type="date" value={quando} onChange={(e) => setQuando(e.target.value)} className={cn(inputCls, 'sm:w-40')} />
          </div>
          <button onClick={receber} disabled={busy} className="text-sm px-4 py-2 rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50">
            {busy ? 'Lançando...' : 'Lançar como Receita'}
          </button>
          <button onClick={() => setRecebendo(false)} className="text-sm px-3 py-2 rounded-lg text-slate-500 hover:bg-slate-100">Cancelar</button>
        </div>
      )}
    </div>
  );
}

export function CommissionNotes({ notas, taxas, onChanged }: { notas: CommissionNote[]; taxas: LearnedRate[]; onChanged: () => void }) {
  const [form, setForm] = useState<{ editar: CommissionNote | null } | null>(null);
  const [verRecebidas, setVerRecebidas] = useState(false);
  const abertas = notas.filter((n) => n.status === 'OPEN');
  const recebidas = notas.filter((n) => n.status === 'RECEIVED');

  return (
    <div className="mb-5 rounded-xl border border-af-border p-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
        <div>
          <h4 className="text-sm font-semibold text-slate-700 flex items-center gap-2"><FileText size={15} className="text-af-mid" /> Notas de comissão</h4>
          <p className="text-[11px] text-slate-400">Uma nota pode ter vários processos do mesmo banco. O valor da nota substitui a estimativa, e a taxa dela passa a valer pros próximos clientes desse banco.</p>
        </div>
        {!form && (
          <button onClick={() => setForm({ editar: null })} className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 bg-af-mid text-white rounded-lg hover:bg-af-dark self-start">
            <Plus size={14} /> Lançar nota
          </button>
        )}
      </div>

      {taxas.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3">
          {taxas.map((t) => (
            <span key={`${t.produto}|${t.banco}`} className="text-[11px] px-2 py-1 rounded-lg bg-emerald-50 text-emerald-800 border border-emerald-200" title={`Taxa efetiva das notas (${t.processos} processo${t.processos === 1 ? '' : 's'} em ${t.notas} nota${t.notas === 1 ? '' : 's'})`}>
              {t.bancoNome} {PRODUTO[t.produto] || t.produto}: <b>{String(t.pct).replace('.', ',')}%</b> aprendida
            </span>
          ))}
        </div>
      )}

      {form && <NotaForm key={form.editar?.id || 'nova'} editar={form.editar} onClose={() => setForm(null)} onSaved={() => { setForm(null); onChanged(); }} />}

      {abertas.length === 0 && !form ? (
        <p className="text-xs text-slate-400">Nenhuma nota a receber. Use "Lançar nota" quando o banco mandar a nota ou o demonstrativo.</p>
      ) : (
        <div className="space-y-2">
          {abertas.map((n) => <NotaRow key={n.id} n={n} onChanged={onChanged} onEdit={() => setForm({ editar: n })} />)}
        </div>
      )}
      {recebidas.length > 0 && (
        <div className="mt-3">
          <button onClick={() => setVerRecebidas((v) => !v)} className="text-xs text-af-mid hover:underline">{verRecebidas ? 'Esconder notas recebidas' : `Ver notas recebidas (${recebidas.length})`}</button>
          {verRecebidas && <div className="space-y-2 mt-2">{recebidas.map((n) => <NotaRow key={n.id} n={n} onChanged={onChanged} onEdit={() => {}} />)}</div>}
        </div>
      )}
    </div>
  );
}
