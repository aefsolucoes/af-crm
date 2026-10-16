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
import { BANKS, STATUS, MANUAL_STATUS, ago, Badge, overrideSummary, type Bank, type Analysis, type BoardLead, fmtCpf, sameWho, ParticipantCell } from '@/components/credit/shared';
import { AdjustModal } from '@/components/credit/adjust-modal';
import { NotifyClientModal } from '@/components/credit/notify-modal';
import { pingExtensions } from '@/lib/credit-extensions';
import { useAuthStore } from '@/store/auth.store';
import { ChevronDown, ChevronRight, MessageSquare, Square, Play, Plus, Star, Pencil, SlidersHorizontal, ArrowLeftRight, RefreshCw, Send } from 'lucide-react';
import api from '@/lib/api';

/* Análise de Crédito — ver apps/api/src/services/credit-analysis.service.ts.
 * As extensões do Chrome (Credimorar/Santander, Creditas, Inter) rodam nos portais dos bancos e
 * contam o resultado pra cá; daqui o time dispara novas análises e escolhe a proposta. */

interface Board { leads: BoardLead[]; extensions: Record<Bank, { lastSeenAt: string | null; online: boolean; extId?: string | null }>; }

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
  const { data, isLoading, dataUpdatedAt } = useQuery<Board>({
    queryKey: ['credit-board'],
    queryFn: async () => (await api.get('/api/credit-analysis/board')).data,
    refetchInterval: 15_000,
    refetchIntervalInBackground: true, // aba em segundo plano (o Fabio fica no portal do banco) também atualiza — o padrão do navegador era pausar (14/10)
  });
  const [selected, setSelected] = useState<string[]>([]);
  const [banks, setBanks] = useState<Bank[]>(['CREDIMORAR', 'CREDITAS', 'INTER']);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [modal, setModal] = useState<{ lead: BoardLead; bank: Bank; analysis?: Analysis } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [view, setView] = useState<'pre' | 'ran'>('pre');
  const [adjust, setAdjust] = useState<BoardLead | null>(null);
  const [notify, setNotify] = useState<BoardLead | null>(null);
  const [forceRun, setForceRun] = useState(false);
  const isAdmin = useAuthStore((s) => s.user?.role === 'ADMIN');
  const { data: auto } = useQuery<{ enabled: boolean; enabledAt: string | null; paused?: boolean }>({ queryKey: ['credit-auto'], queryFn: async () => (await api.get('/api/credit-analysis/auto')).data });
  async function togglePause() {
    const next = !auto?.paused;
    try {
      await api.put('/api/credit-analysis/auto', { paused: next });
      toast(next ? 'PAUSADO: nada roda sozinho. Só o que você pedir na hora.' : 'Pausa desligada', 'success');
      queryClient.invalidateQueries({ queryKey: ['credit-auto'] });
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao salvar a pausa', 'error');
    }
  }
  async function toggleAuto() {
    const next = !auto?.enabled;
    if (next && !window.confirm('Ligar a análise automática?\n\nDaqui pra frente, todo cliente que cair na Pré-Análise do Home Equity (proposta preenchida) e tiver os dados conferidos pela IA vai ser enviado sozinho para os 3 bancos. Se o 1º participante vier reprovado ou aprovado a menor, roda no 2º. Quando as respostas saírem, o cliente recebe no WhatsApp as opções aprovadas para escolher. Cards que já estão na Pré-Análise não entram.')) return;
    try {
      await api.put('/api/credit-analysis/auto', { enabled: next });
      toast(next ? 'Análise automática LIGADA' : 'Análise automática desligada', 'success');
      queryClient.invalidateQueries({ queryKey: ['credit-auto'] });
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao salvar', 'error');
    }
  }

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['credit-board'] });

  useEffect(() => {
    const socket = getSocket();
    let t: ReturnType<typeof setTimeout> | null = null;
    // Aba em segundo plano: o Chrome segura timers (até 1 min) — nesse caso atualiza na hora, sem o atraso de 0,6 s.
    const on = () => { if (document.visibilityState === 'hidden') { refresh(); return; } if (t) return; t = setTimeout(() => { t = null; refresh(); }, 600); };
    socket.on('credit_analysis_updated', on);
    return () => { if (t) clearTimeout(t); socket.off('credit_analysis_updated', on); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Link vindo do card (?leadId=): já abre o cliente.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('leadId');
    if (id) setOpen(id);
  }, []);

  const allLeads = data?.leads || [];
  const leads = useMemo(() => (view === 'pre'
    ? allLeads.filter((l) => l.inPre)
    : allLeads.filter((l) => l.ran && !l.inPre).sort((a, b) => new Date(b.lastRunAt || 0).getTime() - new Date(a.lastRunAt || 0).getTime())), [allLeads, view]);
  const allSelected = leads.length > 0 && leads.every((l) => selected.includes(l.id));
  const offline = useMemo(() => banks.filter((b) => !data?.extensions?.[b]?.online), [banks, data]);

  // Clientes que já tiveram proposta enviada de verdade no banco: rodar de novo pode duplicar a proposta.
  const dups = useMemo(() => {
    const out: string[] = [];
    for (const l of leads) {
      if (!selected.includes(l.id)) continue;
      for (const b of banks) {
        const a = l.latest[b];
        if (a && !a.dryRun && ['SENT', 'APPROVED', 'CONDITIONAL', 'REJECTED', 'CHECK'].includes(a.status)) out.push(`${l.name} — ${BANKS.find((x) => x.key === b)!.short} (${STATUS[a.status].label.toLowerCase()})`);
      }
    }
    return out;
  }, [leads, selected, banks]);

  async function run() {
    setBusy(true);
    try {
      const { data: r } = await api.post('/api/credit-analysis/requests', { leadIds: selected, banks, force: forceRun });
      pingExtensions(data?.extensions, banks);
      toast(`${r.created} na fila${r.consulted?.length ? ` · quem já foi rodado só tem a proposta consultada (${r.consulted.map((b: string) => BANKS.find((x) => x.key === b)?.short).join(', ')})` : ''}${r.skipped ? ` · ${r.skipped} já estavam rodando` : ''}`, 'success');
      setConfirm(false);
      setSelected([]);
      refresh();
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao pedir as análises', 'error');
    } finally { setBusy(false); }
  }

  // Inverte titular e 2º participante nos 3 bancos (vale na próxima análise).
  async function toggleInvert(l: BoardLead) {
    const inverted = BANKS.every((b) => l.overrides?.[b.key]?.inverter);
    try {
      await api.put('/api/credit-analysis/overrides', { leadId: l.id, banks: BANKS.map((b) => b.key), data: { inverter: !inverted }, merge: true });
      toast(inverted ? 'Participantes voltaram ao normal' : `Participantes invertidos: ${l.card.name2} passa a ser o titular`, 'success');
      refresh();
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao inverter', 'error');
    }
  }

  // "Conferir resultado": cliente "Em análise" — a extensão lê o resultado AGORA (adianta a conferência da fila), sem criar proposta nova.
  async function conferirAgora(l: BoardLead, bank: Bank) {
    try {
      const { data: r } = await api.post('/api/credit-analysis/check-now', { leadId: l.id, bank });
      pingExtensions(data?.extensions, [bank]);
      toast(`${BANKS.find((b) => b.key === bank)?.short}: ${r.detail}`, 'success');
      refresh();
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao pedir a conferência', 'error');
    }
  }
  const emAnalise = (a?: { status: string; kind?: string }) => !!a && (a.status === 'SENT' || (a.kind === 'CHECK' && ['REQUESTED', 'RUNNING'].includes(a.status)));

  // Só CONFERIR o resultado no portal do Inter de uma proposta já enviada (não cria proposta nova).
  async function checkBank(l: BoardLead, bank: Bank) {
    try {
      const { data: r } = await api.post('/api/credit-analysis/requests', { leadIds: [l.id], banks: [bank], kind: 'CHECK' });
      pingExtensions(data?.extensions, [bank]);
      toast(r.created ? `Conferência pedida — a extensão do ${BANKS.find((b) => b.key === bank)?.short} vai ler o resultado no portal` : 'Já tem uma conferência/análise em andamento', 'success');
      refresh();
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao pedir a conferência', 'error');
    }
  }

  // STOP TOTAL só deste cliente: derruba as rodadas em andamento (a extensão tira a aba do banco do meio do formulário), para conferências, refações, avisos, fechamento e a IA.
  // Retomar volta o automático (e a IA do card, se estava ligada).
  async function toggleClientPause(l: BoardLead) {
    const next = !l.autoPaused;
    if (next && !window.confirm(`Parar TUDO deste cliente (${l.name})?\n\n• Rodadas em andamento nos bancos são interrompidas no meio (o banco pode ficar com um rascunho/proposta incompleta).\n• Nada roda, refaz, confere nem avisa o cliente sozinho; a IA para de responder.\n• Só ele: os outros clientes seguem normalmente.`)) return;
    try {
      const { data: r } = await api.put('/api/credit-analysis/pause', { leadId: l.id, paused: next });
      toast(next ? `${l.name}: PARADO${r?.interrompidas ? ` — ${r.interrompidas} rodada(s) interrompida(s)` : ''}. A extensão derruba a aba do banco no próximo passo (até ~10 s).` : `${l.name}: retomado`, 'success');
      refresh();
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao parar o cliente', 'error');
    }
  }

  // "Salvar e rodar de novo" do modal de ajuste.
  async function runAgain(leadId: string, bks: Bank[]) {
    try {
      const { data: r } = await api.post('/api/credit-analysis/requests', { leadIds: [leadId], banks: bks, force: true }); // depois de ajustar: roda de novo de propósito
      pingExtensions(data?.extensions, bks);
      toast(`${r.created} análise(s) na fila${r.skipped ? ` · ${r.skipped} já estavam rodando` : ''}`, 'success');
      refresh();
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao pedir as análises', 'error');
    }
  }

  // Botão dentro do cartão do banco: roda SÓ aquele banco, daquele participante (Fabio 14/10). No 2º participante liga a inversão só naquele banco
  // (a mesma que a cascata automática usa); no 1º desliga, pra não rodar no nome errado.
  const [rerunKey, setRerunKey] = useState<string | null>(null);
  async function rerunBank(l: BoardLead, bank: Bank, who: 'p1' | 'p2') {
    const key = `${l.id}-${bank}-${who}`;
    if (rerunKey) return;
    setRerunKey(key);
    try {
      const inverted = !!l.overrides?.[bank]?.inverter;
      if (who === 'p2' !== inverted) await api.put('/api/credit-analysis/overrides', { leadId: l.id, banks: [bank], data: { inverter: who === 'p2' }, merge: true });
      const { data: r } = await api.post('/api/credit-analysis/requests', { leadIds: [l.id], banks: [bank], force: true });
      pingExtensions(data?.extensions, [bank]);
      const short = BANKS.find((b) => b.key === bank)?.short;
      toast(r.created ? `${short} na fila para ${who === 'p2' ? (l.card?.name2 || '2º participante') : (l.card?.name1 || l.name)}` : `${short}: já tem uma análise rodando`, r.created ? 'success' : 'error');
      refresh();
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao pedir a análise', 'error');
    } finally { setRerunKey(null); }
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

        {/* Análise automática */}
        <div className="bg-white rounded-xl border border-af-border p-4 flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-[260px]">
            <div className="text-sm font-medium text-slate-700 flex items-center gap-2">
              Análise automática
              <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${auto?.enabled ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-500'}`}>{auto?.enabled ? 'ligada' : 'desligada'}</span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Quando o cliente preenche a proposta e a IA confere os dados, as análises rodam sozinhas nos 3 bancos. Com 2º participante: roda o 1º e, sem esperar a resposta dele, roda o 2º (só não roda se o 1º foi aprovado no valor total ou barrado por regra do imóvel). Depois o cliente recebe as opções aprovadas para escolher, e a IA ajuda na conversa.
              {auto?.enabled && auto.enabledAt ? ` Valendo para cards que chegaram na Pré-Análise depois de ${new Date(auto.enabledAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}.` : ''}
            </p>
          </div>
          {isAdmin ? (
            <div className="flex items-center gap-2">
              <Button variant={auto?.paused ? 'primary' : 'secondary'} onClick={togglePause} title="Para tudo que roda sozinho (análise automática, reconferências e as extensões por conta própria). Só roda o que você pedir na hora, um de cada vez.">{auto?.paused ? '▶ Retomar automático' : '⏸ Pausar automático'}</Button>
              <Button variant={auto?.enabled ? 'secondary' : 'primary'} onClick={toggleAuto}>{auto?.enabled ? 'Desligar' : 'Ligar'}</Button>
            </div>
          ) : <span className="text-xs text-slate-400">Só administradores ligam.</span>}
          {auto?.paused && <div className="basis-full text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">⏸ PAUSA GERAL LIGADA — nada roda sozinho (nem a análise automática, nem as reconferências, nem as extensões por conta própria). Só o que você pedir na hora (Rodar análise / Conferir) é executado.</div>}
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
            <div className="ml-auto">
              <Button onClick={() => setConfirm(true)} disabled={busy || !selected.length || !banks.length}>
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
          <div className="px-4 pt-3 border-b border-af-border flex items-end gap-1">
            {([['pre', 'Pré-Análise', allLeads.filter((l) => l.inPre).length], ['ran', 'Já rodados', allLeads.filter((l) => l.ran && !l.inPre).length]] as const).map(([k, label, n]) => (
              <button key={k} onClick={() => setView(k)} className={`px-4 py-2 text-sm -mb-px border-b-2 transition-colors ${view === k ? 'border-af-accent text-slate-800 font-medium' : 'border-transparent text-slate-400 hover:text-slate-600'}`}>
                {label} <span className="text-xs text-slate-400">({n})</span>
              </button>
            ))}
            <span className="ml-auto pb-2 text-[11px] text-slate-400 hidden md:block">
              {view === 'pre' ? 'Home Equity · clientes na etapa Pré-Análise' : 'Home Equity · quem já foi analisado nos últimos 90 dias e saiu da Pré-Análise — ajuste ou inverta participantes e rode de novo'}{dataUpdatedAt ? ` · atualizado às ${new Date(dataUpdatedAt).toLocaleTimeString('pt-BR')}` : ''}
            </span>
          </div>
          {isLoading ? (
            <div className="p-4"><Skeleton className="h-32" /></div>
          ) : leads.length === 0 ? (
            <div className="text-center py-10 text-slate-400 text-sm">{view === 'pre' ? 'Nenhum cliente na Pré-Análise agora.' : 'Nenhum cliente foi rodado ainda.'}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[860px]">
                <thead>
                  <tr className="text-left text-xs text-slate-400 border-b border-af-border">
                    <th className="pl-4 pr-2 py-2.5 w-8"><input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? selected.filter((id) => !leads.some((l) => l.id === id)) : Array.from(new Set([...selected, ...leads.map((l) => l.id)])))} /></th>
                    <th className="px-3 py-2.5 font-medium">Cliente</th>
                    {BANKS.map((b) => <th key={b.key} className="px-3 py-2.5 font-medium">{b.short}</th>)}
                    <th className="px-3 py-2.5 font-medium">Ajustes</th>
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
                            <div className="font-medium text-slate-800">{l.name}{l.card?.cpf1 && <span className="ml-2 text-[11px] font-normal text-slate-400">CPF {fmtCpf(l.card.cpf1)}</span>}</div>
                            <div className="text-[11px] text-slate-400">
                              {l.stage}{l.requested.creditValue ? ` · pediu ${formatCurrency(l.requested.creditValue)}` : ''}{l.requested.term ? ` · ${l.requested.term}` : ''}
                            </div>
                            {l.autoPaused && <div className="text-[11px] font-semibold text-red-600">⏹ PARADO — nada roda, confere, avisa nem responde (IA) sozinho</div>}
                            {l.preAnaliseAt && (
                              <div className="text-[11px] text-slate-400" title="Data e hora em que o card entrou na Pré-Análise">
                                Entrou na Pré-Análise: {new Date(l.preAnaliseAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })}
                              </div>
                            )}
                            {l.card?.name2 && (
                              <div className="text-[11px] text-slate-500 mt-0.5">
                                2º participante: <span className="font-medium text-slate-600">{l.card.name2}</span>{l.card.cpf2 && <span className="text-slate-400"> · CPF {fmtCpf(l.card.cpf2)}</span>}
                                {BANKS.some((b) => l.overrides?.[b.key]?.inverter) && (
                                  <span className="text-amber-600"> · rodando no nome de <strong>{l.card.name2}</strong></span>
                                )}
                              </div>
                            )}
                            {overrideSummary(BANKS.map((b) => l.overrides?.[b.key]).find(Boolean)) && (
                              <div className="text-[11px] text-amber-600 mt-0.5">✎ {overrideSummary(BANKS.map((b) => l.overrides?.[b.key]).find(Boolean))}</div>
                            )}
                          </td>
                          {BANKS.map((b) => {
                            // Resultado de cada participante lado a lado: o do 2º participante não esconde o do 1º (e vice-versa).
                            const a1 = l.latestP1?.[b.key], a2 = l.latestP2?.[b.key];
                            return (
                              <td key={b.key} className="px-3 py-3 cursor-pointer" onClick={() => setOpen(expanded ? null : l.id)}>
                                {(a1 && a2) || l.card?.name2 ? (
                                  <div className="space-y-1.5">
                                    <div><div className="text-[10px] uppercase tracking-wide text-slate-400">1º participante</div><ParticipantCell a={a1 || (!a2 ? l.latest[b.key] : undefined)} why={l.notRun?.[b.key]?.p1} /></div>
                                    <div><div className="text-[10px] uppercase tracking-wide text-slate-400">2º participante</div><ParticipantCell a={a2} why={l.notRun?.[b.key]?.p2} /></div>
                                  </div>
                                ) : (
                                  <>
                                    {a2 && !a1 && <div className="text-[10px] uppercase tracking-wide text-slate-400">2º participante</div>}
                                    <ParticipantCell a={l.latest[b.key]} why={l.notRun?.[b.key]?.p1} />
                                  </>
                                )}
                              </td>
                            );
                          })}
                          <td className="px-3 py-3">
                            <div className="flex flex-col gap-1.5 items-start">
                              <button onClick={() => router.push(`/inbox?leadId=${l.id}`)} title="Abrir a conversa do WhatsApp deste cliente" className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border border-emerald-200 text-emerald-700 hover:bg-emerald-50"><MessageSquare size={11} /> Conversa</button>
                              {Object.values(l.latest).some((a) => a && (a.status === 'APPROVED' || a.status === 'CONDITIONAL') && !!a.approvedValue) && (
                                <button onClick={() => setNotify(l)} title="Mandar ao cliente as opções aprovadas (todas, para ele escolher)" className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg bg-af-accent text-white hover:opacity-90"><Send size={11} /> Avisar cliente</button>
              )}
                              <button onClick={() => setAdjust(l)} className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border border-af-border text-slate-600 hover:bg-slate-50"><SlidersHorizontal size={11} /> Ajustar</button>
                              <button onClick={() => toggleClientPause(l)} title={l.autoPaused ? 'Voltar o automático (e a IA, se estava ligada) pra este cliente' : 'STOP TOTAL só deste cliente: derruba as rodadas em andamento e para tudo, inclusive a IA'} className={`flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border ${l.autoPaused ? 'border-emerald-300 text-emerald-700 hover:bg-emerald-50' : 'border-red-300 text-red-600 hover:bg-red-50'}`}>
                                {l.autoPaused ? <><Play size={11} /> Retomar</> : <><Square size={11} className="fill-current" /> Parar</>}
                              </button>
                              {(['INTER', 'CREDITAS', 'CREDIMORAR'] as Bank[]).filter((bk) => emAnalise(l.latest[bk])).map((bk) => (
                                <button key={`ra-${bk}`} onClick={() => conferirAgora(l, bk)} title={`A extensão lê AGORA o resultado da proposta no ${BANKS.find((b) => b.key === bk)?.short} (sem criar proposta nova)`} className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border border-indigo-300 text-indigo-700 hover:bg-indigo-50"><RefreshCw size={11} /> Conferir resultado {BANKS.find((b) => b.key === bk)?.short}</button>
                              ))}
                              {(['INTER', 'CREDITAS', 'CREDIMORAR'] as Bank[]).filter((bk) => l.latest[bk] && !['REQUESTED', 'RUNNING'].includes(l.latest[bk]!.status) && !emAnalise(l.latest[bk])).map((bk) => (
                                <button key={bk} onClick={() => checkBank(l, bk)} title={`Ler o resultado no portal do ${BANKS.find((b) => b.key === bk)?.short} sem criar proposta nova`} className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border border-af-border text-slate-600 hover:bg-slate-50"><RefreshCw size={11} /> Conferir {BANKS.find((b) => b.key === bk)?.short}</button>
                              ))}
                              {(() => {
                                const inverted = BANKS.every((b) => l.overrides?.[b.key]?.inverter);
                                return l.card?.name2 ? (
                                  <button onClick={() => toggleInvert(l)} title={inverted ? 'Voltar ao titular original' : `${l.card.name2} passa a ser o titular na análise`} className={`flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border ${inverted ? 'border-amber-300 bg-amber-50 text-amber-700' : 'border-af-border text-slate-600 hover:bg-slate-50'}`}>
                                    <ArrowLeftRight size={11} /> {inverted ? 'Invertido' : 'Inverter'}
                                  </button>
                                ) : null;
                              })()}
                            </div>
                          </td>
                          <td className="px-3 py-3 text-slate-400 cursor-pointer" onClick={() => setOpen(expanded ? null : l.id)}>{expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</td>
                        </tr>
                        {expanded && (
                          <tr className="bg-slate-50/60">
                            <td />
                            <td colSpan={BANKS.length + 3} className="px-3 py-4">
                              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                                {BANKS.flatMap((b) => {
                                  const a1 = l.latestP1?.[b.key], a2 = l.latestP2?.[b.key];
                                  // Com resultado dos dois participantes no mesmo banco: um cartão pra cada.
                                  // Card com 2º participante: SEMPRE um cartão por banco pra cada participante (Fabio 14/10: "senão fica muito confuso"); sem análise num deles, o cartão diz que não rodou.
                                  const dois = !!l.card?.name2 || (a1 && a2);
                                  const itens: { a?: typeof a1; who: 'p1' | 'p2' }[] = dois ? [{ a: a1 || (!a2 ? l.latest[b.key] : undefined), who: 'p1' }, { a: a2, who: 'p2' }] : [{ a: l.latest[b.key], who: 'p1' }];
                                  return itens.map((it) => ({ b, ...it }));
                                }).map(({ b, a, who }) => {
                                  const hasP2 = Object.keys(l.latestP2 || {}).length > 0 || !!l.card?.name2;
                                  const quem = who === 'p2' ? `2º participante${l.card?.name2 ? ` · ${l.card.name2}` : ''}${l.card?.cpf2 ? ` · CPF ${fmtCpf(l.card.cpf2)}` : ''}` : `1º participante${l.card?.name1 ? ` · ${l.card.name1}` : ''}${l.card?.cpf1 ? ` · CPF ${fmtCpf(l.card.cpf1)}` : ''}`;
                                  return (
                                    <div key={`${b.key}-${who}`} className="rounded-lg border border-af-border bg-white p-3 text-xs space-y-2">
                                      <div className="flex items-center justify-between">
                                        <span className="font-semibold text-slate-700">{b.label}{hasP2 && <span className="block font-normal text-[11px] text-slate-400">{quem}</span>}</span>
                                        <Badge a={a} />
                                      </div>
                                      {a ? (
                                        <>
                                          {a.holderName && l.card?.name1 && !sameWho(a.holderName, l.card.name1) && <p className="text-amber-600 font-medium">{a.status === 'APPROVED' || a.status === 'CONDITIONAL' ? 'Aprovado' : a.status === 'REJECTED' ? 'Reprovado' : 'Analisado'} no nome de {a.holderName} (2º participante)</p>}
                                          {b.key === 'CREDITAS' && l.scr && l.scr.status !== 'NOTED' && (
                                            <p className={l.scr.status === 'SENT' ? 'text-emerald-700 bg-emerald-50 rounded-md px-2 py-1' : 'text-amber-700 bg-amber-50 rounded-md px-2 py-1'}>
                                              {l.scr.status === 'SENT'
                                                ? `📤 Autorização SCR Bacen assinada enviada à Creditas${l.scr.sentAt ? ` em ${new Date(l.scr.sentAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : ''} — a consulta voltou a rodar; aguardando o retorno da Creditas.`
                                                : `🔒 Consulta TRAVADA: a Creditas pediu a Autorização SCR Bacen assinada${l.scr.creditasId ? ` (ID ${l.scr.creditasId})` : ''}. ${l.scr.status === 'PENDING' ? 'O CRM vai mandar o formulário ao cliente.' : 'Formulário já foi ao cliente — aguardando ele devolver assinado pelo gov.br com o documento de identidade.'} A consulta destrava quando o formulário for enviado à Creditas.`}
                                            </p>
                                          )}
                                          {a.detail && <p className="text-slate-500 whitespace-pre-line">{a.detail}</p>}
                                          {(a.status === 'APPROVED' || a.status === 'CONDITIONAL' || (a.status === 'SENT' && !!a.approvedValue)) && (
                                            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-slate-600">
                                              {a.approvedValue ? <><dt className="text-slate-400">{a.status === 'SENT' ? 'Valor (simulação)' : 'Valor aprovado'}</dt><dd>{formatCurrency(a.approvedValue)}</dd></> : null}
                                              {a.netValue ? <><dt className="text-slate-400">Valor líquido</dt><dd>{formatCurrency(a.netValue)}</dd></> : null}
                                              {a.termMonths ? <><dt className="text-slate-400">Prazo</dt><dd>{a.termMonths} meses</dd></> : null}
                                              {a.rate ? <><dt className="text-slate-400">Taxa</dt><dd>{a.rate}</dd></> : null}
                                              {a.indexer ? <><dt className="text-slate-400">Indexador</dt><dd>{a.indexer}</dd></> : null}
                                              {a.firstInstallment ? <><dt className="text-slate-400">1ª parcela</dt><dd>{formatCurrency(a.firstInstallment)}</dd></> : null}
                                              {a.lastInstallment ? <><dt className="text-slate-400">Última parcela</dt><dd>{formatCurrency(a.lastInstallment)}</dd></> : null}
                                              {a.proposalNumber ? <><dt className="text-slate-400">Proposta nº</dt><dd>{a.proposalNumber}</dd></> : null}
                                            </dl>
                                          )}
                                          {a.bank === 'INTER' && a.status === 'SENT' && !a.proposalNumber && a.source !== 'MANUAL' && <p className="text-amber-600">⚠️ Marcada como enviada, mas sem número de proposta: no portal pode ser só um rascunho. Confira no portal do Inter; se for erro, use "Rodar de novo".</p>}
                                          {a.status === 'APPROVED' && !a.approvedValue && <p className="text-amber-600">Aprovada, mas sem os números — clique em "Resultado" e preencha.</p>}
                                          {a.status === 'CONDITIONAL' && <p className="text-teal-700">Aprovada com condição: o banco pede documentação para seguir.</p>}
                                        </>
                                      ) : <p className="text-amber-600">{(who === 'p2' ? l.notRun?.[b.key]?.p2 : l.notRun?.[b.key]?.p1) || (who === 'p2' ? 'Não rodou no 2º participante.' : 'Nenhuma análise ainda.')}</p>}
                                      <div className="flex flex-wrap gap-2 pt-1">
                                        <button onClick={() => setModal({ lead: l, bank: b.key, analysis: a })} className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-af-border text-slate-600 hover:bg-slate-50">
                                          {a ? <><Pencil size={11} /> Resultado</> : <><Plus size={11} /> Registrar</>}
                                        </button>
                                        {emAnalise(a) && <button onClick={() => conferirAgora(l, b.key)} title="A extensão lê AGORA o resultado da proposta (sem criar proposta nova)" className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-indigo-300 text-indigo-700 hover:bg-indigo-50"><RefreshCw size={11} /> Conferir resultado</button>}
                                        {(!a || ['FAILED', 'INCOMPLETE', 'CHECK'].includes(a.status) || (a.bank === 'INTER' && a.status === 'SENT' && !a.proposalNumber && a.source !== 'MANUAL')) && (
                                          <button onClick={() => rerunBank(l, b.key, who)} disabled={!!rerunKey} className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-af-accent text-af-accent hover:bg-af-accent/10 disabled:opacity-50">
                                            <RefreshCw size={11} className={rerunKey === `${l.id}-${b.key}-${who}` ? 'animate-spin' : ''} /> {a ? 'Rodar de novo' : who === 'p2' ? 'Rodar no 2º participante' : 'Rodar'}
                                          </button>
                                        )}
                                        {(a?.status === 'APPROVED' || a?.status === 'CONDITIONAL') && (a.chosen
                                          ? <span className="flex items-center gap-1 px-2.5 py-1 text-amber-600"><Star size={11} className="fill-amber-400" /> Escolhida</span>
                                          : <button onClick={() => choose(a, l)} className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-af-accent text-white hover:opacity-90"><Star size={11} /> Escolher esta proposta</button>)}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                              {(l.verdicts || []).length > 1 && (() => {
                                const vs = l.verdicts || [];
                                const ok = (st: string) => st === 'APPROVED' || st === 'CONDITIONAL';
                                const grupos = Array.from(new Set(vs.map((v) => `${v.bank}|${(v.holderName || '').split(' ')[0].toLowerCase()}`))).filter((k) => vs.filter((v) => `${v.bank}|${(v.holderName || '').split(' ')[0].toLowerCase()}` === k).length > 1);
                                if (!grupos.length) return null;
                                return (
                                  <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-xs text-slate-600">
                                    <div className="font-medium text-slate-700 mb-1">Resultados anteriores — o resultado mudou depois que o valor/dados mudaram</div>
                                    <ul className="space-y-1.5">
                                      {grupos.map((k) => {
                                        const lista = vs.filter((v) => `${v.bank}|${(v.holderName || '').split(' ')[0].toLowerCase()}` === k);
                                        return (
                                          <li key={k}>
                                            <span className="font-medium">{BANKS.find((b) => b.key === lista[0].bank)?.short}{lista[0].holderName ? ` — ${lista[0].holderName}` : ''}:</span>{' '}
                                            {lista.map((v, i) => (
                                              <span key={v.id}>
                                                {i > 0 && <span className="mx-1 text-slate-400">→</span>}
                                                <span className={ok(v.status) ? 'text-emerald-600' : 'text-red-500'}>{ok(v.status) ? 'Aprovou' : 'Reprovou'}{v.netValue || v.approvedValue ? ` ${formatCurrency(Number(v.netValue || v.approvedValue))}` : ''}</span>
                                                <span className="text-slate-400"> (pedido {v.requestedValue ? formatCurrency(Number(v.requestedValue)) : 'não registrado'}, {new Date(v.at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })})</span>
                                              </span>
                                            ))}
                                          </li>
                                        );
                                      })}
                                    </ul>
                                  </div>
                                );
                              })()}
                              {l.history.length > 1 && (
                                <div className="mt-3 text-[11px] text-slate-400">
                                  <div className="font-medium text-slate-500 mb-1">Histórico</div>
                                  <ul className="space-y-0.5">
                                    {l.history.map((h) => (
                                      <li key={h.id}>{new Date(h.createdAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · {BANKS.find((b) => b.key === h.bank)?.short} · {STATUS[h.status]?.label || h.status}{h.source === 'MANUAL' ? ' · manual' : ''}{h.detail ? ` — ${h.detail.slice(0, 90)}` : ''}</li>
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

      {notify && <NotifyClientModal leadId={notify.id} leadName={notify.name} onClose={() => setNotify(null)} onSent={refresh} />}
      {adjust && <AdjustModal lead={adjust} onClose={() => setAdjust(null)} onSaved={refresh} onRunAgain={(bks) => runAgain(adjust.id, bks)} />}
      {modal && <ResultModal lead={modal.lead} bank={modal.bank} analysis={modal.analysis} onClose={() => setModal(null)} onSaved={refresh} />}
      {confirm && (
        <Modal title="Enviar propostas aos bancos?" onClose={() => setConfirm(false)}>
          <div className="space-y-3 text-sm text-slate-600">
            <p>A extensão vai <strong>enviar de verdade</strong> a proposta de {selected.length} cliente(s) para {banks.map((b) => BANKS.find((x) => x.key === b)!.short).join(', ')}; onde o cliente já foi rodado, só consulta a proposta.</p>
            {dups.length > 0 && (
              <label className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer"><input type="checkbox" checked={forceRun} onChange={(e) => setForceRun(e.target.checked)} /> Rodar de novo mesmo assim (cria proposta nova no banco)</label>
            )}
            {dups.length > 0 && (
              <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-700">
                <p className="font-medium mb-1">{forceRun ? 'Já têm proposta enviada — vai criar proposta NOVA (duplicada) no banco:' : 'Já foram rodados — nesses bancos só vou CONSULTAR a proposta (não cria de novo):'}</p>
                <ul className="list-disc pl-4 space-y-0.5">{dups.slice(0, 8).map((d) => <li key={d}>{d}</li>)}{dups.length > 8 && <li>e mais {dups.length - 8}…</li>}</ul>
              </div>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={() => setConfirm(false)}>Cancelar</Button>
              <Button onClick={run} disabled={busy}>{busy ? 'Enviando…' : 'Enviar'}</Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
