'use client';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { Topbar } from '@/components/ui/topbar';
import { Skeleton } from '@/components/ui/skeleton';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { getSocket } from '@/lib/socket';
import { formatCurrency } from '@/lib/utils';
import { ChevronDown, ChevronRight, MessageSquare, Play, Plus, Star, Pencil } from 'lucide-react';
import api from '@/lib/api';

/* Análise de Crédito — ver apps/api/src/services/credit-analysis.service.ts.
 * As extensões do Chrome (Credimorar/Santander, Creditas, Inter) rodam nos portais dos bancos e
 * contam o resultado pra cá; daqui o time dispara novas análises e escolhe a proposta. */

type Bank = 'CREDIMORAR' | 'CREDITAS' | 'INTER';
const BANKS: { key: Bank; label: string; short: string }[] = [
  { key: 'CREDIMORAR', label: 'Santander (Credimorar)', short: 'Santander' },
  { key: 'CREDITAS', label: 'Creditas', short: 'Creditas' },
  { key: 'INTER', label: 'Banco Inter', short: 'Inter' },
];

const STATUS: Record<string, { label: string; cls: string }> = {
  REQUESTED: { label: 'Na fila', cls: 'bg-slate-100 text-slate-600' },
  RUNNING: { label: 'Rodando', cls: 'bg-blue-50 text-blue-600' },
  SENT: { label: 'Enviada', cls: 'bg-indigo-50 text-indigo-600' },
  APPROVED: { label: 'Aprovado', cls: 'bg-emerald-50 text-emerald-600' },
  REJECTED: { label: 'Reprovado', cls: 'bg-red-50 text-red-500' },
  FAILED: { label: 'Falhou', cls: 'bg-orange-50 text-orange-600' },
  CHECK: { label: 'Conferir', cls: 'bg-amber-50 text-amber-600' },
  INCOMPLETE: { label: 'Incompleto', cls: 'bg-amber-50 text-amber-600' },
  TEST: { label: 'Teste', cls: 'bg-slate-100 text-slate-500' },
};
const MANUAL_STATUS = ['SENT', 'APPROVED', 'REJECTED', 'CHECK', 'FAILED'];

interface Analysis {
  id: string; bank: Bank; status: string; detail: string | null; dryRun: boolean; source: string; chosen: boolean;
  proposalNumber: string | null; approvedValue: number | null; termMonths: number | null; rate: string | null; indexer: string | null;
  firstInstallment: number | null; lastInstallment: number | null; conditions: string | null;
  requestedAt: string; finishedAt: string | null; updatedAt: string; createdAt: string;
}
interface BoardLead {
  id: string; name: string; stage: string; status: string;
  requested: { creditValue: number; propertyValue: number; term: string | null };
  latest: Partial<Record<Bank, Analysis>>; history: Analysis[]; chosenId: string | null;
}
interface Board { leads: BoardLead[]; extensions: Record<Bank, { lastSeenAt: string | null; online: boolean }>; }

function ago(d: string | null | undefined): string {
  if (!d) return '';
  const min = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  if (min < 60 * 24) return `há ${Math.round(min / 60)} h`;
  return new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

function Badge({ a }: { a?: Analysis }) {
  if (!a) return <span className="text-xs text-slate-300">—</span>;
  const s = STATUS[a.status] || { label: a.status, cls: 'bg-slate-100 text-slate-500' };
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-1">
        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${s.cls}`}>{s.label}{a.dryRun && a.status !== 'TEST' ? ' · teste' : ''}</span>
        {a.chosen && <Star size={13} className="text-amber-500 fill-amber-400" />}
      </div>
      <div className="text-[11px] text-slate-400">
        {a.status === 'APPROVED' && a.approvedValue ? <span className="text-slate-600 font-medium">{formatCurrency(a.approvedValue)} · </span> : null}
        {ago(a.updatedAt)}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-xs text-slate-500">{label}<div className="mt-1">{children}</div></label>;
}
const inputCls = 'w-full text-sm border border-af-border rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-af-accent bg-white text-slate-800';

function ResultModal({ lead, bank, analysis, onClose, onSaved }: { lead: BoardLead; bank: Bank; analysis?: Analysis; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    bank, status: analysis && MANUAL_STATUS.includes(analysis.status) ? analysis.status : 'APPROVED',
    approvedValue: analysis?.approvedValue ? String(analysis.approvedValue) : '', termMonths: analysis?.termMonths ? String(analysis.termMonths) : '',
    rate: analysis?.rate || '', indexer: analysis?.indexer || '', firstInstallment: analysis?.firstInstallment ? String(analysis.firstInstallment) : '',
    lastInstallment: analysis?.lastInstallment ? String(analysis.lastInstallment) : '', proposalNumber: analysis?.proposalNumber || '',
    conditions: analysis?.conditions || '', detail: analysis?.detail || '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function save() {
    setBusy(true);
    try {
      const body = { ...form };
      if (analysis) await api.put(`/api/credit-analysis/${analysis.id}`, body);
      else await api.post('/api/credit-analysis/manual', { leadId: lead.id, ...body });
      toast('Resultado salvo', 'success');
      onSaved();
      onClose();
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao salvar', 'error');
    } finally { setBusy(false); }
  }

  return (
    <Modal title={`${analysis ? 'Resultado' : 'Registrar resultado'} — ${lead.name}`} onClose={onClose}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Banco">
            <select className={inputCls} value={form.bank} onChange={set('bank')} disabled={!!analysis}>
              {BANKS.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
            </select>
          </Field>
          <Field label="Situação">
            <select className={inputCls} value={form.status} onChange={set('status')}>
              {MANUAL_STATUS.map((s) => <option key={s} value={s}>{STATUS[s].label}</option>)}
            </select>
          </Field>
        </div>
        {form.status === 'APPROVED' && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Valor aprovado (R$)"><input className={inputCls} inputMode="decimal" value={form.approvedValue} onChange={set('approvedValue')} placeholder="350000" /></Field>
              <Field label="Prazo (meses)"><input className={inputCls} inputMode="numeric" value={form.termMonths} onChange={set('termMonths')} placeholder="180" /></Field>
              <Field label="Taxa"><input className={inputCls} value={form.rate} onChange={set('rate')} placeholder="1,19% a.m." /></Field>
              <Field label="Indexador"><input className={inputCls} value={form.indexer} onChange={set('indexer')} placeholder="IPCA / TR" /></Field>
              <Field label="1ª parcela (R$)"><input className={inputCls} inputMode="decimal" value={form.firstInstallment} onChange={set('firstInstallment')} /></Field>
              <Field label="Última parcela (R$)"><input className={inputCls} inputMode="decimal" value={form.lastInstallment} onChange={set('lastInstallment')} /></Field>
            </div>
            <Field label="Nº da proposta"><input className={inputCls} value={form.proposalNumber} onChange={set('proposalNumber')} /></Field>
            <Field label="Condições (opcional)"><textarea className={inputCls} rows={2} value={form.conditions} onChange={set('conditions')} /></Field>
          </>
        )}
        <Field label="Observação (opcional)"><textarea className={inputCls} rows={2} value={form.detail} onChange={set('detail')} placeholder={form.status === 'REJECTED' ? 'Motivo da reprovação' : ''} /></Field>
        {(form.status === 'APPROVED' || form.status === 'REJECTED') && <p className="text-xs text-slate-400">Ao salvar, uma nota é criada no card com o resultado.</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button onClick={save} disabled={busy}>{busy ? 'Salvando…' : 'Salvar'}</Button>
        </div>
      </div>
    </Modal>
  );
}

export default function AnaliseCreditoPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery<Board>({
    queryKey: ['credit-board'],
    queryFn: async () => (await api.get('/api/credit-analysis/board')).data,
    refetchInterval: 30_000,
  });
  const [selected, setSelected] = useState<string[]>([]);
  const [banks, setBanks] = useState<Bank[]>(['CREDIMORAR', 'CREDITAS', 'INTER']);
  const [dryRun, setDryRun] = useState(true);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [modal, setModal] = useState<{ lead: BoardLead; bank: Bank; analysis?: Analysis } | null>(null);
  const [confirm, setConfirm] = useState(false);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['credit-board'] });

  useEffect(() => {
    const socket = getSocket();
    let t: ReturnType<typeof setTimeout> | null = null;
    const on = () => { if (t) return; t = setTimeout(() => { t = null; refresh(); }, 600); };
    socket.on('credit_analysis_updated', on);
    return () => { if (t) clearTimeout(t); socket.off('credit_analysis_updated', on); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const leads = data?.leads || [];
  const allSelected = leads.length > 0 && selected.length === leads.length;
  const offline = useMemo(() => banks.filter((b) => !data?.extensions?.[b]?.online), [banks, data]);

  async function run() {
    setBusy(true);
    try {
      const { data: r } = await api.post('/api/credit-analysis/requests', { leadIds: selected, banks, dryRun });
      toast(`${r.created} análise(s) na fila${r.skipped ? ` · ${r.skipped} já estavam rodando` : ''}`, 'success');
      setConfirm(false);
      setSelected([]);
      refresh();
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao pedir as análises', 'error');
    } finally { setBusy(false); }
  }

  async function choose(a: Analysis, lead: BoardLead) {
    if (!window.confirm(`Escolher a proposta ${BANKS.find((b) => b.key === a.bank)?.short} para ${lead.name}? Isso preenche o Financiamento do card com ela.`)) return;
    try {
      await api.post(`/api/credit-analysis/${a.id}/choose`);
      toast('Proposta escolhida — card preenchido', 'success');
      refresh();
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao escolher', 'error');
    }
  }

  return (
    <div className="flex flex-col h-full">
      <Topbar title="Análise de Crédito" subtitle="Disparo e retorno das análises dos bancos (extensões do Chrome)" />
      <div className="flex-1 overflow-auto px-4 md:px-6 py-4 space-y-4 scrollbar-thin">
        {/* Extensões */}
        <div className="bg-white rounded-xl border border-af-border p-4">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            <span className="text-slate-600 font-medium">Extensões do Chrome</span>
            {BANKS.map((b) => {
              const e = data?.extensions?.[b.key];
              return (
                <span key={b.key} className="flex items-center gap-1.5 text-xs text-slate-600">
                  <span className={`w-2 h-2 rounded-full ${e?.online ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                  {b.short}
                  <span className="text-slate-400">{e?.online ? 'conectada' : e?.lastSeenAt ? `vista ${ago(e.lastSeenAt)}` : 'sem sinal'}</span>
                </span>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-slate-400">As análises rodam no Chrome do Fabio (login e código dos bancos ficam lá). Com o Chrome aberto, a extensão busca os pedidos desta tela a cada minuto.</p>
        </div>

        {/* Disparo */}
        <div className="bg-white rounded-xl border border-af-border p-4">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
            <span className="text-sm font-medium text-slate-700">Rodar nos bancos:</span>
            {BANKS.map((b) => (
              <label key={b.key} className="flex items-center gap-1.5 text-sm text-slate-600 cursor-pointer">
                <input type="checkbox" checked={banks.includes(b.key)} onChange={() => setBanks((p) => p.includes(b.key) ? p.filter((x) => x !== b.key) : [...p, b.key])} />
                {b.short}
              </label>
            ))}
            <label className="flex items-center gap-1.5 text-sm text-slate-600 cursor-pointer" title="A extensão preenche tudo, mas não envia a proposta ao banco">
              <input type="checkbox" checked={dryRun} onChange={() => setDryRun((v) => !v)} />
              Modo teste (não envia ao banco)
            </label>
            <div className="ml-auto">
              <Button onClick={() => (dryRun ? run() : setConfirm(true))} disabled={busy || !selected.length || !banks.length}>
                <Play size={14} /> Rodar {selected.length ? `${selected.length} cliente(s)` : ''}
              </Button>
            </div>
          </div>
          {selected.length > 0 && offline.length > 0 && (
            <p className="mt-2 text-xs text-amber-600">Extensão sem sinal: {offline.map((b) => BANKS.find((x) => x.key === b)!.short).join(', ')}. O pedido fica na fila até ela abrir no Chrome.</p>
          )}
        </div>

        {/* Quadro */}
        <div className="bg-white rounded-xl border border-af-border overflow-hidden">
          <div className="px-4 py-3 border-b border-af-border">
            <h2 className="text-sm font-semibold text-slate-800">Clientes na Pré-Análise <span className="text-slate-400 font-normal">· Home Equity (e quem teve análise nas últimas 3 semanas)</span></h2>
          </div>
          {isLoading ? (
            <div className="p-4"><Skeleton className="h-32" /></div>
          ) : leads.length === 0 ? (
            <div className="text-center py-10 text-slate-400 text-sm">Nenhum cliente na Pré-Análise agora.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[760px]">
                <thead>
                  <tr className="text-left text-xs text-slate-400 border-b border-af-border">
                    <th className="pl-4 pr-2 py-2.5 w-8"><input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? [] : leads.map((l) => l.id))} /></th>
                    <th className="px-3 py-2.5 font-medium">Cliente</th>
                    {BANKS.map((b) => <th key={b.key} className="px-3 py-2.5 font-medium">{b.short}</th>)}
                    <th className="px-3 py-2.5 w-8" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-af-border">
                  {leads.map((l) => {
                    const expanded = open === l.id;
                    return (
                      <Fragment key={l.id}>
                        <tr className="hover:bg-slate-50 transition-colors align-top">
                          <td className="pl-4 pr-2 py-3"><input type="checkbox" checked={selected.includes(l.id)} onChange={() => setSelected((p) => p.includes(l.id) ? p.filter((x) => x !== l.id) : [...p, l.id])} /></td>
                          <td className="px-3 py-3 cursor-pointer" onClick={() => setOpen(expanded ? null : l.id)}>
                            <div className="font-medium text-slate-800">{l.name}</div>
                            <div className="text-[11px] text-slate-400">
                              {l.stage}{l.requested.creditValue ? ` · pediu ${formatCurrency(l.requested.creditValue)}` : ''}{l.requested.term ? ` · ${l.requested.term}` : ''}
                            </div>
                          </td>
                          {BANKS.map((b) => <td key={b.key} className="px-3 py-3 cursor-pointer" onClick={() => setOpen(expanded ? null : l.id)}><Badge a={l.latest[b.key]} /></td>)}
                          <td className="px-3 py-3 text-slate-400 cursor-pointer" onClick={() => setOpen(expanded ? null : l.id)}>{expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</td>
                        </tr>
                        {expanded && (
                          <tr className="bg-slate-50/60">
                            <td />
                            <td colSpan={BANKS.length + 2} className="px-3 py-4">
                              <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                                {BANKS.map((b) => {
                                  const a = l.latest[b.key];
                                  return (
                                    <div key={b.key} className="rounded-lg border border-af-border bg-white p-3 text-xs space-y-2">
                                      <div className="flex items-center justify-between">
                                        <span className="font-semibold text-slate-700">{b.label}</span>
                                        <Badge a={a} />
                                      </div>
                                      {a ? (
                                        <>
                                          {a.detail && <p className="text-slate-500 whitespace-pre-line">{a.detail}</p>}
                                          {a.status === 'APPROVED' && (
                                            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-slate-600">
                                              {a.approvedValue ? <><dt className="text-slate-400">Valor aprovado</dt><dd>{formatCurrency(a.approvedValue)}</dd></> : null}
                                              {a.termMonths ? <><dt className="text-slate-400">Prazo</dt><dd>{a.termMonths} meses</dd></> : null}
                                              {a.rate ? <><dt className="text-slate-400">Taxa</dt><dd>{a.rate}</dd></> : null}
                                              {a.indexer ? <><dt className="text-slate-400">Indexador</dt><dd>{a.indexer}</dd></> : null}
                                              {a.firstInstallment ? <><dt className="text-slate-400">1ª parcela</dt><dd>{formatCurrency(a.firstInstallment)}</dd></> : null}
                                              {a.lastInstallment ? <><dt className="text-slate-400">Última parcela</dt><dd>{formatCurrency(a.lastInstallment)}</dd></> : null}
                                              {a.proposalNumber ? <><dt className="text-slate-400">Proposta nº</dt><dd>{a.proposalNumber}</dd></> : null}
                                            </dl>
                                          )}
                                          {a.status === 'APPROVED' && !a.approvedValue && <p className="text-amber-600">Aprovada, mas sem os números — clique em "Resultado" e preencha.</p>}
                                        </>
                                      ) : <p className="text-slate-400">Nenhuma análise ainda.</p>}
                                      <div className="flex flex-wrap gap-2 pt-1">
                                        <button onClick={() => setModal({ lead: l, bank: b.key, analysis: a })} className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-af-border text-slate-600 hover:bg-slate-50">
                                          {a ? <><Pencil size={11} /> Resultado</> : <><Plus size={11} /> Registrar</>}
                                        </button>
                                        {a?.status === 'APPROVED' && (a.chosen
                                          ? <span className="flex items-center gap-1 px-2.5 py-1 text-amber-600"><Star size={11} className="fill-amber-400" /> Escolhida</span>
                                          : <button onClick={() => choose(a, l)} className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-af-accent text-white hover:opacity-90"><Star size={11} /> Escolher esta proposta</button>)}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                              {l.history.length > 1 && (
                                <div className="mt-3 text-[11px] text-slate-400">
                                  <div className="font-medium text-slate-500 mb-1">Histórico</div>
                                  <ul className="space-y-0.5">
                                    {l.history.map((h) => (
                                      <li key={h.id}>{new Date(h.createdAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · {BANKS.find((b) => b.key === h.bank)?.short} · {STATUS[h.status]?.label || h.status}{h.dryRun ? ' (teste)' : ''}{h.source === 'MANUAL' ? ' · manual' : ''}{h.detail ? ` — ${h.detail.slice(0, 90)}` : ''}</li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                              <button onClick={() => router.push(`/inbox?leadId=${l.id}`)} className="mt-3 flex items-center gap-1 text-xs text-af-mid hover:underline"><MessageSquare size={12} /> Abrir conversa</button>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <p className="text-xs text-slate-400 pb-2">Escolher a proposta é manual por enquanto: preenche o Financiamento do card (instituição, valor, prazo, taxa, parcelas) e cria uma nota.</p>
      </div>

      {modal && <ResultModal lead={modal.lead} bank={modal.bank} analysis={modal.analysis} onClose={() => setModal(null)} onSaved={refresh} />}
      {confirm && (
        <Modal title="Enviar propostas aos bancos?" onClose={() => setConfirm(false)}>
          <div className="space-y-3 text-sm text-slate-600">
            <p>O modo teste está <strong>desligado</strong>: a extensão vai <strong>enviar de verdade</strong> a proposta de {selected.length} cliente(s) para {banks.map((b) => BANKS.find((x) => x.key === b)!.short).join(', ')}.</p>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={() => setConfirm(false)}>Cancelar</Button>
              <Button onClick={run} disabled={busy}>{busy ? 'Enviando…' : 'Enviar de verdade'}</Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
