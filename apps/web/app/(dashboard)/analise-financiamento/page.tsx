'use client';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { Topbar } from '@/components/ui/topbar';
import { Skeleton } from '@/components/ui/skeleton';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { getSocket } from '@/lib/socket';
import { formatCurrency } from '@/lib/utils';
import { STATUS, ago, fmtCpf, type Bank } from '@/components/credit/shared';
import { ExtensionsLivePanel } from '@/components/credit/extensions-live-panel';
import { pingExtensions } from '@/lib/credit-extensions';
import { ChevronDown, ChevronRight, MessageSquare, Play, RefreshCw, AlertTriangle, FileText } from 'lucide-react';
import api from '@/lib/api';

/* Análise de Crédito — Financiamento Imobiliário (Fabio 27/10; tela igual à do Home Equity em 29/10).
 * Bradesco, Itaú e Santander rodam juntos numa simulação do Credimorar (extensão do Credimorar, fila CREDIMORAR_FH);
 * o Inter roda no NOSSO portal do Inter (extensão do Inter, fila INTER_FH); CAIXA (Caixa Aqui) e BRB (PCN) rodam só com a documentação completa.
 * Ver fhBoard em apps/api/src/services/credit-analysis.service.ts. */

const BANCOS = ['Bradesco', 'Itaú', 'Santander', 'Inter', 'CAIXA', 'BRB'] as const;
const SO_COM_DOCUMENTACAO = new Set<string>(['CAIXA', 'BRB']);
// Banco → tipo do PDF de simulação que o CRM manda ao cliente
const PDF: Record<string, string> = { Bradesco: 'FH_BRADESCO', 'Itaú': 'FH_ITAU', Santander: 'FH_SANTANDER', Inter: 'FH_INTER' };
// Fila de cada extensão (checkbox "Rodar nos bancos")
const FILAS = [
  { key: 'CREDIMORAR_FH', label: 'Credimorar (Bradesco, Itaú, Santander)', short: 'Credimorar', ext: 'CREDIMORAR' as Bank },
  { key: 'INTER_FH', label: 'Inter (nosso portal)', short: 'Inter', ext: 'INTER' as Bank },
];
const ROTULO_FILA: Record<string, string> = { CREDIMORAR_FH: 'Credimorar', INTER_FH: 'Inter', CAIXA_FH: 'CAIXA', BRB_FH: 'BRB' };

interface FhHistorico { id: string; bank: string; kind: string; status: string; detail: string | null; createdAt: string; proposalNumber: string | null; dryRun: boolean }
interface FhLead {
  id: string; name: string; status: string; stage: string; pipeline: string; stageEnteredAt: string | null;
  valores: { imovel: number | null; financia: number | null; entrada: number | null; renda: number | null };
  participante2: string | null;
  restricaoSerasa: boolean | null;
  simulacao: string | null;
  last: { id: string; kind: string; status: string; detail: string | null; updatedAt: string; notBefore: string | null } | null;
  leituraEm: string | null;
  active: boolean;
  bancos: Record<string, { status: string; texto: string }>;
  card: { name1: string | null; cpf1: string | null; name2: string | null; cpf2: string | null };
  inPre: boolean;
  history: FhHistorico[];
}
interface FhBoard { leads: FhLead[]; extension: { lastSeenAt: string | null; online: boolean; extId?: string | null; loginNeeded?: boolean } | null }

/** Cor do status de cada banco (texto que o banco mostra). */
function tom(status: string): string {
  const s = status.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (/aprovad/.test(s)) return 'bg-emerald-100 text-emerald-700';
  if (/rejeit|reprov|negad|recusad|cancel/.test(s)) return 'bg-red-100 text-red-700';
  if (/enviar documentos|incomplet|pend/.test(s)) return 'bg-amber-100 text-amber-700';
  if (/an[aá]lise|analise|aguard|enviad/.test(s)) return 'bg-blue-100 text-blue-700';
  return 'bg-slate-100 text-slate-500';
}

const aprovado = (status: string) => /aprovad/i.test(status) && !/n[aã]o aprovad/i.test(status);
const numeroProposta = (texto: string) => /proposta (\S+)/.exec(texto)?.[1]?.replace(/[,.;]$/, '') || null;
const semAcento = (v: string) => v.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const dataHora = (d: string) => new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
/** Data do último pedido do cliente (histórico vem do mais novo pro mais antigo, mas não confio na ordem). */
const ultimaRodada = (l: FhLead) => Math.max(0, ...l.history.map((h) => new Date(h.createdAt).getTime()), l.last ? new Date(l.last.updatedAt).getTime() : 0);

function BancoCell({ nome, lead }: { nome: string; lead: FhLead }) {
  const b = lead.bancos[nome];
  if (b) {
    const n = numeroProposta(b.texto);
    return (
      <div className="space-y-0.5" title={b.texto}>
        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${tom(b.status)}`}>{b.status}</span>
        {n && <div className="text-[10px] text-slate-400">nº {n}</div>}
      </div>
    );
  }
  if (SO_COM_DOCUMENTACAO.has(nome)) return <span className="text-[11px] text-slate-400 leading-tight block">com a documentação completa</span>;
  if (lead.active) return <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-600">{lead.last?.status === 'RUNNING' ? 'Rodando' : 'Na fila'}</span>;
  return <span className="text-xs text-slate-300">—</span>;
}

export default function AnaliseFinanciamentoPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data, isLoading, dataUpdatedAt } = useQuery<FhBoard>({
    queryKey: ['credit-fh-board'],
    queryFn: async () => (await api.get('/api/credit-analysis/fh-board')).data,
    refetchInterval: 15_000,
    refetchIntervalInBackground: true, // aba em segundo plano (o Fabio fica no portal do banco) também atualiza
  });
  const [selected, setSelected] = useState<string[]>([]);
  const [filas, setFilas] = useState<string[]>(['CREDIMORAR_FH', 'INTER_FH']);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [view, setView] = useState<'pre' | 'ran'>('pre');
  const [busca, setBusca] = useState(''); // "Buscar": nome (titular ou 2º participante), CPF ou nº da proposta (Fabio 29/10)
  const [pedindo, setPedindo] = useState<string | null>(null); // botão da linha em andamento (leadId + tipo)
  const [pdfBusy, setPdfBusy] = useState<string | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['credit-fh-board'] });

  useEffect(() => {
    const socket = getSocket();
    let t: ReturnType<typeof setTimeout> | null = null;
    // Aba em segundo plano: o Chrome segura timers (até 1 min) — nesse caso atualiza na hora, sem o atraso de 0,6 s.
    const on = () => { if (document.visibilityState === 'hidden') { refresh(); return; } if (t) return; t = setTimeout(() => { t = null; refresh(); }, 600); };
    socket.on('credit_analysis_updated', on);
    return () => { if (t) clearTimeout(t); socket.off('credit_analysis_updated', on); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Link vindo do card (?leadId=): acha o cliente, abre a linha dele e rola até ela.
  const leadDoLink = useRef<string | null>(typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('leadId') : null);
  useEffect(() => {
    const id = leadDoLink.current;
    if (!id || !data?.leads) return;
    leadDoLink.current = null;
    const l = data.leads.find((x) => x.id === id);
    if (!l) { toast('Esse cliente ainda não tem análise de Financiamento nem está na Pré-Análise.', 'error'); return; }
    setBusca(l.card?.name1 || l.name);
    setOpen(id);
    setTimeout(() => document.getElementById(`lead-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 300);
  }, [data]);

  const allLeads = data?.leads || [];
  const preLeads = useMemo(() => allLeads.filter((l) => l.inPre), [allLeads]);
  const ranLeads = useMemo(() => allLeads.filter((l) => !l.inPre && l.history.length > 0).sort((a, b) => ultimaRodada(b) - ultimaRodada(a)), [allLeads]);
  const leads = useMemo(() => {
    const q = semAcento(busca).trim();
    if (!q) return view === 'pre' ? preLeads : ranLeads;
    const qDig = q.replace(/\D/g, '');
    // Buscando: procura nas DUAS abas (Pré-Análise e Já rodados), não só na que está aberta.
    return [...preLeads, ...ranLeads].filter((l) => {
      const texto = semAcento([l.name, l.card?.name1, l.card?.name2, l.participante2].filter(Boolean).join(' '));
      const docs = [l.card?.cpf1, l.card?.cpf2, l.simulacao, ...l.history.map((h) => h.proposalNumber), ...Object.values(l.bancos).map((b) => numeroProposta(b.texto))].map((v) => String(v || '').replace(/\D/g, ''));
      return texto.includes(q) || (qDig.length >= 3 && docs.some((d) => d.includes(qDig)));
    });
  }, [preLeads, ranLeads, view, busca]);
  const allSelected = leads.length > 0 && leads.every((l) => selected.includes(l.id));

  const ext = data?.extension;
  // Extensão sem sinal nas filas marcadas (Inter vem do quadro do Home Equity, se já estiver no cache)
  const offline = useMemo(() => {
    const board = queryClient.getQueryData<{ extensions?: Record<string, { online: boolean }> }>(['credit-board']);
    return FILAS.filter((f) => filas.includes(f.key) && !(f.ext === 'CREDIMORAR' ? ext?.online : board?.extensions?.[f.ext]?.online ?? true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filas, ext, dataUpdatedAt]);

  /** Avisa as extensões que há pedido novo (sem esperar o alarme de 1 minuto). */
  function avisarExtensoes(keys: string[]) {
    const board = queryClient.getQueryData<{ extensions?: Record<string, { extId?: string | null }> }>(['credit-board']);
    const mapa: Partial<Record<Bank, { extId?: string | null }>> = { CREDIMORAR: ext || undefined, INTER: board?.extensions?.INTER };
    pingExtensions(mapa, FILAS.filter((f) => keys.includes(f.key)).map((f) => f.ext));
  }

  const jaRodou = (l: FhLead) => !!l.simulacao || Object.keys(l.bancos).length > 0;

  // Clientes selecionados que já têm simulação/resultado: rodar de novo cria proposta NOVA.
  const dups = useMemo(() => leads.filter((l) => selected.includes(l.id) && jaRodou(l)).map((l) => `${l.name}${l.simulacao ? ` — simulação nº ${l.simulacao}` : ''}`), [leads, selected]);

  async function run() {
    setBusy(true);
    try {
      let criados = 0, jaNaFila = 0, erros = 0;
      for (const id of selected) {
        try {
          const r = (await api.post('/api/credit-analysis/fh-request', { leadId: id, kind: 'RUN', banks: filas })).data;
          if (r.created) criados++; else jaNaFila++;
        } catch { erros++; }
      }
      avisarExtensoes(filas);
      toast(`${criados} na fila${jaNaFila ? ` · ${jaNaFila} já estavam na fila` : ''}${erros ? ` · ${erros} com erro` : ''}`, erros && !criados ? 'error' : 'success');
      setConfirm(false);
      setSelected([]);
      refresh();
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao pedir as análises', 'error');
    } finally { setBusy(false); }
  }

  // Botões da linha: "Rodar"/"Rodar de novo" (nos bancos marcados) e "Conferir" (só lê, não cria proposta).
  async function pedir(l: FhLead, kind: 'RUN' | 'CHECK') {
    if (kind === 'RUN' && !filas.length) { toast('Marque ao menos um banco em "Rodar nos bancos"', 'warning'); return; }
    if (kind === 'RUN' && jaRodou(l) && !window.confirm(`${l.name} já tem ${l.simulacao ? `a simulação nº ${l.simulacao}` : 'resultado'} no Financiamento.\n\nRodar de novo cria uma proposta NOVA e envia de novo aos bancos marcados. Para só ler a situação, use "Conferir".\n\nRodar de novo?`)) return;
    setPedindo(l.id + kind);
    try {
      const r = (await api.post('/api/credit-analysis/fh-request', kind === 'RUN' ? { leadId: l.id, kind, banks: filas } : { leadId: l.id, kind })).data;
      toast(r.created ? (kind === 'RUN' ? 'Pedido na fila: a extensão roda os bancos marcados' : 'Conferência na fila') : 'Já tem um pedido desse cliente na fila', r.created ? 'success' : 'warning');
      avisarExtensoes(kind === 'RUN' ? filas : FILAS.map((f) => f.key));
      refresh();
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao pedir a análise', 'error');
    } finally { setPedindo(null); }
  }

  // Simulação em PDF pro cliente: manda ao WhatsApp do cliente (só banco aprovado).
  async function pdf(l: FhLead, banco: string) {
    if (!window.confirm(`Mandar ao cliente, pelo WhatsApp, o PDF da simulação do ${banco} (com a logo da A&F)?`)) return;
    setPdfBusy(l.id + banco);
    try {
      const { data: r } = await api.post('/api/credit-analysis/simulation-docs', { leadId: l.id, institutions: [PDF[banco]] });
      toast(r.created?.length ? `Pedido feito: o PDF do ${banco} sai em instantes` : 'Já tem um pedido desse PDF em andamento', 'success');
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao pedir o PDF', 'error');
    } finally { setPdfBusy(null); }
  }

  return (
    <div className="flex flex-col h-full">
      <Topbar title="Análise de Crédito — Financiamento Imobiliário" subtitle="Bradesco, Itaú e Santander pelo Credimorar · Inter pelo nosso portal · CAIXA e BRB com a documentação completa" />
      <div className="flex-1 overflow-auto px-4 md:px-6 py-4 space-y-4 scrollbar-thin">
        {/* Extensões: logo de cada banco e o cliente que a extensão está rodando agora */}
        <ExtensionsLivePanel produto="fh" />
        <p className="-mt-2 text-xs text-slate-400">As análises rodam no Chrome do Fabio (login e código dos bancos ficam lá), das 07h às 22h. Com o Chrome aberto, a extensão busca os pedidos desta tela a cada minuto.</p>

        <div className="bg-white rounded-xl border border-af-border p-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <span className="text-slate-500">Card novo na Pré-Análise roda sozinho. O resultado de cada banco vem em nota no card e em push; <b>o cliente não é avisado sozinho</b>.</span>
          <span className="flex items-center gap-1 text-amber-700"><AlertTriangle size={14} /> Nome limpo é obrigatório nesses bancos: com restrição no Serasa não roda sozinho.</span>
        </div>

        {/* Disparo */}
        <div className="bg-white rounded-xl border border-af-border p-4">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
            <span className="text-sm font-medium text-slate-700">Rodar nos bancos:</span>
            {FILAS.map((f) => (
              <label key={f.key} className="flex items-center gap-1.5 text-sm text-slate-600 cursor-pointer">
                <input type="checkbox" checked={filas.includes(f.key)} onChange={() => setFilas((p) => p.includes(f.key) ? p.filter((x) => x !== f.key) : [...p, f.key])} />
                {f.label}
              </label>
            ))}
            <div className="ml-auto">
              <Button onClick={() => setConfirm(true)} disabled={busy || !selected.length || !filas.length}>
                <Play size={14} /> Rodar {selected.length ? `${selected.length} cliente(s)` : ''}
              </Button>
            </div>
          </div>
          {selected.length > 0 && offline.length > 0 && (
            <p className="mt-2 text-xs text-amber-600">Extensão sem sinal: {offline.map((f) => f.short).join(', ')}. O pedido fica na fila até ela abrir no Chrome.</p>
          )}
        </div>

        {/* Quadro */}
        <div className="bg-white rounded-xl border border-af-border overflow-hidden">
          <div className="px-4 pt-3 border-b border-af-border flex items-end gap-1">
            {([['pre', 'Pré-Análise', preLeads.length], ['ran', 'Já rodados', ranLeads.length]] as const).map(([k, label, n]) => (
              <button key={k} onClick={() => setView(k)} className={`px-4 py-2 text-sm -mb-px border-b-2 transition-colors ${view === k ? 'border-af-accent text-slate-800 font-medium' : 'border-transparent text-slate-400 hover:text-slate-600'}`}>
                {label} <span className="text-xs text-slate-400">({n})</span>
              </button>
            ))}
            <div className="ml-3 pb-1.5 flex items-center">
              <input
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                placeholder="Buscar por nome, CPF ou nº da proposta"
                className="w-64 text-sm rounded-lg border border-slate-200 px-3 py-1.5 focus:outline-none focus:border-[#2261a8] text-slate-700 placeholder:text-slate-400"
                aria-label="Buscar na análise de Financiamento"
              />
              {busca && <button onClick={() => setBusca('')} className="ml-1 text-xs text-slate-400 hover:text-slate-600 px-1" aria-label="Limpar a busca">✕</button>}
              {busca.trim() && <span className="ml-2 text-[11px] text-slate-500 whitespace-nowrap">{leads.length} resultado{leads.length === 1 ? '' : 's'} (nas duas abas)</span>}
            </div>
            <span className="ml-auto pb-2 text-[11px] text-slate-400 hidden md:block">
              {view === 'pre' ? 'Financiamento · clientes na etapa Pré-Análise' : 'Financiamento · quem já foi analisado nos últimos 90 dias e saiu da Pré-Análise'}{dataUpdatedAt ? ` · atualizado às ${new Date(dataUpdatedAt).toLocaleTimeString('pt-BR')}` : ''}
            </span>
          </div>
          {isLoading ? (
            <div className="p-4"><Skeleton className="h-32" /></div>
          ) : leads.length === 0 ? (
            <div className="text-center py-10 text-slate-400 text-sm">{busca.trim() ? `Nenhum cliente encontrado para "${busca.trim()}" (procurei em Pré-Análise e Já rodados).` : view === 'pre' ? 'Nenhum cliente de Financiamento na Pré-Análise agora.' : 'Nenhum cliente foi rodado ainda.'}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[1000px]">
                <thead>
                  <tr className="text-left text-xs text-slate-400 border-b border-af-border">
                    <th className="pl-4 pr-2 py-2.5 w-8"><input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? selected.filter((id) => !leads.some((l) => l.id === id)) : Array.from(new Set([...selected, ...leads.map((l) => l.id)])))} /></th>
                    <th className="px-3 py-2.5 font-medium">Cliente</th>
                    {BANCOS.map((b) => <th key={b} className="px-3 py-2.5 font-medium">{b}</th>)}
                    <th className="px-3 py-2.5 font-medium">Ajustes</th>
                    <th className="px-3 py-2.5 w-8" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-af-border">
                  {leads.map((l) => {
                    const expanded = open === l.id;
                    return (
                      <Fragment key={l.id}>
                        <tr id={`lead-${l.id}`} className="hover:bg-slate-50 transition-colors align-top">
                          <td className="pl-4 pr-2 py-3"><input type="checkbox" checked={selected.includes(l.id)} onChange={() => setSelected((p) => p.includes(l.id) ? p.filter((x) => x !== l.id) : [...p, l.id])} /></td>
                          <td className="px-3 py-3 cursor-pointer" onClick={() => setOpen(expanded ? null : l.id)}>
                            <div className="font-medium text-slate-800">{l.name}{l.card?.cpf1 && <span className="ml-2 text-[11px] font-normal text-slate-400">CPF {fmtCpf(l.card.cpf1)}</span>}</div>
                            <div className="text-[11px] text-slate-400">
                              {l.stage}{l.status === 'LOST' ? ' · Perdido' : ''}
                              {l.valores.imovel ? ` · imóvel ${formatCurrency(l.valores.imovel)}` : ''}{l.valores.financia ? ` · pediu financiar ${formatCurrency(l.valores.financia)}` : ''}{l.valores.renda ? ` · renda ${formatCurrency(l.valores.renda)}` : ''}
                            </div>
                            {l.simulacao && <div className="text-[11px] text-slate-400">Simulação Credimorar nº {l.simulacao}{l.leituraEm ? ` · lida ${ago(l.leituraEm)}` : ''}</div>}
                            {(l.card?.name2 || l.participante2) && (
                              <div className="text-[11px] text-slate-500 mt-0.5">
                                2º participante: <span className="font-medium text-slate-600">{l.card?.name2 || l.participante2}</span>{l.card?.cpf2 && <span className="text-slate-400"> · CPF {fmtCpf(l.card.cpf2)}</span>}
                              </div>
                            )}
                            {l.restricaoSerasa === true && <div className="mt-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-50 text-red-700 text-[11px]"><AlertTriangle size={11} /> Restrição no Serasa</div>}
                          </td>
                          {BANCOS.map((b) => <td key={b} className="px-3 py-3 cursor-pointer" onClick={() => setOpen(expanded ? null : l.id)}><BancoCell nome={b} lead={l} /></td>)}
                          <td className="px-3 py-3">
                            <div className="flex flex-col gap-1.5 items-start">
                              <button onClick={() => router.push(`/inbox?leadId=${l.id}`)} title="Abrir a conversa do WhatsApp deste cliente" className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border border-emerald-200 text-emerald-700 hover:bg-emerald-50"><MessageSquare size={11} /> Conversa</button>
                              <button onClick={() => pedir(l, 'RUN')} disabled={!!pedindo || l.active} title="Simular e enviar aos bancos marcados em “Rodar nos bancos” (cria proposta nova)" className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border border-af-accent text-af-accent hover:bg-af-accent/10 disabled:opacity-50">
                                <Play size={11} /> {jaRodou(l) ? 'Rodar de novo' : 'Rodar'}
                              </button>
                              {jaRodou(l) && (
                                <button onClick={() => pedir(l, 'CHECK')} disabled={!!pedindo || l.active} title="Ler de novo a situação dos bancos (não cria proposta nova)" className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border border-af-border text-slate-600 hover:bg-slate-50 disabled:opacity-50">
                                  <RefreshCw size={11} className={pedindo === l.id + 'CHECK' ? 'animate-spin' : ''} /> Conferir
                                </button>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-3 text-slate-400 cursor-pointer" onClick={() => setOpen(expanded ? null : l.id)}>{expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</td>
                        </tr>
                        {expanded && (
                          <tr className="bg-slate-50/60">
                            <td />
                            <td colSpan={BANCOS.length + 3} className="px-3 py-4">
                              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                                {BANCOS.map((b) => {
                                  const x = l.bancos[b];
                                  const proposta = x ? numeroProposta(x.texto) : null;
                                  const valor = x ? /R\$ ([\d.]+,\d{2})/.exec(x.texto)?.[1] : null;
                                  const prazo = x ? /(\d+) meses/.exec(x.texto)?.[1] : null;
                                  return (
                                    <div key={b} className="rounded-lg border border-af-border bg-white p-3 text-xs space-y-2">
                                      <div className="flex items-center justify-between">
                                        <span className="font-semibold text-slate-700">{b}</span>
                                        {x
                                          ? <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${tom(x.status)}`}>{x.status}</span>
                                          : l.active && !SO_COM_DOCUMENTACAO.has(b)
                                            ? <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-600">{l.last?.status === 'RUNNING' ? 'Rodando' : 'Na fila'}</span>
                                            : <span className="text-xs text-slate-300">—</span>}
                                      </div>
                                      {x ? (
                                        <>
                                          {x.texto && <p className="text-slate-500 whitespace-pre-line">{x.texto}</p>}
                                          {(proposta || valor || prazo) && (
                                            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-slate-600">
                                              {proposta ? <><dt className="text-slate-400">Proposta nº</dt><dd>{proposta}</dd></> : null}
                                              {valor ? <><dt className="text-slate-400">Valor</dt><dd>R$ {valor}</dd></> : null}
                                              {prazo ? <><dt className="text-slate-400">Prazo</dt><dd>{prazo} meses</dd></> : null}
                                            </dl>
                                          )}
                                          {aprovado(x.status) && PDF[b] && (
                                            <div className="flex flex-wrap gap-2 pt-1">
                                              <button onClick={() => pdf(l, b)} disabled={pdfBusy === l.id + b} className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-af-accent text-white hover:opacity-90 disabled:opacity-50"><FileText size={11} /> Simulação em PDF pro cliente</button>
                                            </div>
                                          )}
                                        </>
                                      ) : SO_COM_DOCUMENTACAO.has(b)
                                        ? <p className="text-slate-400">Roda só com a documentação completa.</p>
                                        : <p className="text-amber-600">{l.active ? 'Pedido na fila / rodando agora.' : 'Nenhuma análise ainda.'}</p>}
                                    </div>
                                  );
                                })}
                              </div>
                              {l.last && !['DONE', 'COMPLETED'].includes(l.last.status) && l.last.detail && (
                                <p className="mt-3 text-[11px] text-slate-500">Último retorno da extensão ({ago(l.last.updatedAt)}): {l.last.detail}</p>
                              )}
                              {l.history.length > 0 && (
                                <div className="mt-3 text-[11px] text-slate-400">
                                  <div className="font-medium text-slate-500 mb-1">Histórico</div>
                                  <ul className="space-y-0.5">
                                    {l.history.map((h) => (
                                      <li key={h.id}>{dataHora(h.createdAt)} · {ROTULO_FILA[h.bank] || h.bank} · {h.kind === 'CHECK' ? 'conferência · ' : ''}{STATUS[h.status as keyof typeof STATUS]?.label || h.status}{h.dryRun ? ' · teste' : ''}{h.proposalNumber ? ` · proposta ${h.proposalNumber}` : ''}{h.detail ? ` — ${h.detail.slice(0, 90)}` : ''}</li>
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
        <p className="text-xs text-slate-400 pb-2">Card novo na Pré-Análise roda sozinho; aqui você roda de novo, confere ou manda a simulação em PDF. O cliente só recebe o que você mandar.</p>
      </div>

      {confirm && (
        <Modal title="Enviar propostas aos bancos?" onClose={() => setConfirm(false)}>
          <div className="space-y-3 text-sm text-slate-600">
            <p>As extensões vão <strong>enviar de verdade</strong> a proposta de {selected.length} cliente(s) para {FILAS.filter((f) => filas.includes(f.key)).map((f) => f.label).join(' e ')}.</p>
            {dups.length > 0 && (
              <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-700">
                <p className="font-medium mb-1">Já têm simulação/resultado — rodar de novo cria proposta NOVA nos bancos:</p>
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
