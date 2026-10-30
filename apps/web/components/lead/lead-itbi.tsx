'use client';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Landmark, Send, X } from 'lucide-react';
import api from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { toast } from '@/components/ui/toast';

/* Bloco "ITBI (Receita DF)" do card (aba Financiamento) — Fabio 30/10. A extensão "ITBI DF" faz a declaração (DEITBI) no portal da Receita do DF.
 * 1º passo: "Calcular no portal" — preenche e para no Resumo (nada é enviado). 2º passo: a equipe confere o valor e confirma o ENVIO, que gera o imposto;
 * a guia (DAR) vai pra pasta ITBI do Drive e pro cliente no WhatsApp. Uma declaração por vendedor × comprador (regra do portal). */

type Pessoa = { nome: string; cpf: string; percentual: number };
type Decl = { idx: number; transmitente: Pessoa; adquirente: Pessoa; percentual: number; valorPactuado: number; status: string; valorItbi?: number; baseCalculo?: number; aliquota?: number; vencimento?: string; darUrl?: string; detail?: string };
type Itbi = { status: string; modo: string; natureza: string; inscricao: string; valorTotal: number; declaracoes: Decl[]; detail?: string; envio?: { enviadoAt?: string; templateAt?: string; falha?: string } };
type Preview = { natureza: '004' | '001'; inscricao: string; valorTotal: number; itbiEstimado: number; aliquotaEsperada: number; vendedores: Pessoa[]; compradores: Pessoa[]; declaracoes: Decl[]; faltam: string[]; avisos: string[]; anexo: { nome: string } | null; minuta: { arquivo: string; observacao: string } | null };

const brl = (n?: number) => (n || n === 0 ? n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '—');
const STATUS: Record<string, { label: string; cls: string }> = {
  REQUESTED: { label: 'Na fila da extensão', cls: 'bg-slate-100 text-slate-600' },
  RUNNING: { label: 'Extensão no portal', cls: 'bg-blue-100 text-blue-700' },
  CALCULADO: { label: 'Calculado — confirme o envio', cls: 'bg-amber-100 text-amber-700' },
  DONE: { label: 'Guia emitida', cls: 'bg-emerald-100 text-emerald-700' },
  OFICIO: { label: 'Lançamento de ofício', cls: 'bg-orange-100 text-orange-700' },
  FAILED: { label: 'Falhou', cls: 'bg-red-100 text-red-700' },
  CANCELED: { label: 'Cancelado', cls: 'bg-slate-100 text-slate-500' },
};

export function LeadItbi({ leadId }: { leadId: string }) {
  const queryClient = useQueryClient();
  const key = ['itbi', leadId];
  const [busy, setBusy] = useState<string | null>(null);
  const [pv, setPv] = useState<Preview | null>(null);
  const [form, setForm] = useState<{ inscricao: string; valorTotal: string; natureza: '004' | '001'; vendedores: Pessoa[] } | null>(null);
  const { data } = useQuery<{ itbi: Itbi | null; elegivel: boolean }>({
    queryKey: key,
    queryFn: async () => (await api.get('/api/itbi/status', { params: { leadId } })).data,
    refetchInterval: 60_000,
  });

  useEffect(() => {
    const socket = getSocket();
    const on = (e: { leadId?: string }) => { if (!e?.leadId || e.leadId === leadId) queryClient.invalidateQueries({ queryKey: key }); };
    socket.on('itbi_updated', on);
    return () => { socket.off('itbi_updated', on); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId, queryClient]);

  const it = data?.itbi || null;
  if (!it && !data?.elegivel) return null;
  const podePedir = !it || ['FAILED', 'CANCELED', 'OFICIO'].includes(it.status);

  async function abrirPreview() {
    setBusy('preview');
    try {
      const { data: p } = await api.get<Preview>('/api/itbi/preview', { params: { leadId } });
      setPv(p);
      setForm({ inscricao: p.inscricao, valorTotal: String(p.valorTotal || ''), natureza: p.natureza, vendedores: p.vendedores.length ? p.vendedores : [{ nome: '', cpf: '', percentual: 0 }] });
    } catch (err: any) { toast(err?.response?.data?.error || 'Erro ao ler a minuta', 'error'); } finally { setBusy(null); }
  }

  async function calcular() {
    if (!form) return;
    setBusy('pedir');
    try {
      await api.post('/api/itbi', { leadId, overrides: { inscricao: form.inscricao, valorTotal: Number(String(form.valorTotal).replace(/\./g, '').replace(',', '.')) || undefined, natureza: form.natureza, vendedores: form.vendedores.filter((v) => v.nome || v.cpf) } });
      toast('Pedido feito — a extensão preenche no portal da Receita DF e CALCULA, sem enviar', 'success');
      setPv(null); setForm(null);
      queryClient.invalidateQueries({ queryKey: key });
    } catch (err: any) { toast(err?.response?.data?.error || 'Erro ao pedir o ITBI', 'error'); } finally { setBusy(null); }
  }

  async function enviar() {
    if (!it) return;
    const total = it.declaracoes.reduce((s, d) => s + (d.valorItbi || 0), 0);
    if (!window.confirm(`ENVIAR a declaração de ITBI à Receita do DF?\n\nIsso GERA O IMPOSTO (${brl(total)}) — só dá pra cancelar no portal enquanto a guia não for paga. A guia vai pra pasta ITBI do Drive e pro cliente no WhatsApp.`)) return;
    setBusy('enviar');
    try {
      await api.post(`/api/itbi/${leadId}/enviar`);
      toast('Envio confirmado — a extensão envia, gera a guia e manda ao cliente', 'success');
      queryClient.invalidateQueries({ queryKey: key });
    } catch (err: any) { toast(err?.response?.data?.error || 'Erro ao confirmar o envio', 'error'); } finally { setBusy(null); }
  }

  async function acao(path: string, msg: string, confirmar?: string) {
    if (confirmar && !window.confirm(confirmar)) return;
    setBusy(path);
    try { await api.post(`/api/itbi/${leadId}/${path}`); toast(msg, 'success'); queryClient.invalidateQueries({ queryKey: key }); } catch (err: any) { toast(err?.response?.data?.error || 'Erro', 'error'); } finally { setBusy(null); }
  }

  const st = it ? STATUS[it.status] || { label: it.status, cls: 'bg-slate-100 text-slate-600' } : null;
  const input = 'w-full rounded border border-slate-200 px-1.5 py-1 text-[11px]';
  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
        <Landmark className="h-3.5 w-3.5" /> ITBI (Receita DF)
        {st && <span className={`ml-1 rounded px-1.5 py-0.5 text-[11px] font-medium normal-case tracking-normal ${st.cls}`}>{st.label}</span>}
      </div>

      {it && (
        <div className="space-y-1.5 text-xs">
          {it.declaracoes.map((d) => (
            <div key={d.idx} className="rounded-md border border-slate-100 p-2">
              <div className="font-medium text-slate-700">{d.transmitente.nome} → {d.adquirente.nome}</div>
              <div className="text-slate-500">{d.percentual}% · valor {brl(d.valorPactuado)}{d.valorItbi ? ` · base ${brl(d.baseCalculo)} · ${d.aliquota ?? '?'}% · ITBI ${brl(d.valorItbi)}` : ''}{d.vencimento ? ` · vence ${d.vencimento}` : ''}</div>
              {d.detail && d.status !== 'GUIA' && <div className="text-slate-400">{d.detail}</div>}
              {d.darUrl && <a href={d.darUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50"><ExternalLink className="h-3 w-3" /> Guia no Drive</a>}
            </div>
          ))}
          {it.detail && <div className="text-slate-400">{it.detail}</div>}
          {it.envio?.enviadoAt && <div className="text-emerald-700">Guia enviada ao cliente no WhatsApp.</div>}
          {it.status === 'DONE' && !it.envio?.enviadoAt && <div className="text-slate-500">{it.envio?.templateAt ? 'Conversa fechada: mandei "Olá, tudo bem?" — a guia vai quando o cliente responder.' : it.envio?.falha ? `A guia não saiu: ${it.envio.falha}` : 'A guia vai ao cliente no horário de envio (07h–21h).'}</div>}
          <div className="flex flex-wrap gap-2 pt-1">
            {it.status === 'CALCULADO' && (
              <button onClick={enviar} disabled={!!busy} className="inline-flex items-center gap-1 rounded bg-emerald-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
                <Send className="h-3 w-3" /> Enviar declaração e mandar a guia
              </button>
            )}
            {['REQUESTED', 'CALCULADO'].includes(it.status) && (
              <button onClick={() => acao('cancel', 'Pedido de ITBI cancelado', 'Cancelar o pedido de ITBI? Nada foi enviado à Receita.')} disabled={!!busy} className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-50 disabled:opacity-50">
                <X className="h-3 w-3" /> Cancelar
              </button>
            )}
            {it.status === 'DONE' && (
              <button onClick={() => acao('reenviar', 'Guia reenviada ao cliente (ou na fila do horário)')} disabled={!!busy} className="rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-50 disabled:opacity-50">Mandar a guia ao cliente de novo</button>
            )}
          </div>
        </div>
      )}

      {podePedir && !pv && (
        <button onClick={abrirPreview} disabled={busy === 'preview'} className="mt-1 inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50">
          <Landmark className="h-3 w-3" /> {busy === 'preview' ? 'Lendo a minuta…' : it ? 'Pedir o ITBI de novo' : 'Pedir ITBI'}
        </button>
      )}

      {pv && form && (
        <div className="mt-2 space-y-2 rounded-md bg-slate-50 p-2 text-[11px] text-slate-600">
          {pv.minuta && <div>Minuta lida: <b>{pv.minuta.arquivo}</b>{pv.minuta.observacao ? ` — ${pv.minuta.observacao}` : ''}</div>}
          <div className="grid grid-cols-2 gap-2">
            <label>Inscrição do IPTU (8 dígitos)<input className={input} value={form.inscricao} onChange={(e) => setForm({ ...form, inscricao: e.target.value })} /></label>
            <label>Valor de compra e venda<input className={input} value={form.valorTotal} onChange={(e) => setForm({ ...form, valorTotal: e.target.value })} /></label>
          </div>
          <label>Natureza
            <select className={input} value={form.natureza} onChange={(e) => setForm({ ...form, natureza: e.target.value as '004' | '001' })}>
              <option value="004">004 — Compra e venda com alienação fiduciária (financiado)</option>
              <option value="001">001 — Compra e venda (sem financiamento)</option>
            </select>
          </label>
          <div>
            <div className="font-medium">Vendedor(es)</div>
            {form.vendedores.map((v, i) => (
              <div key={i} className="mt-1 grid grid-cols-[1fr_8rem_4rem_1.5rem] gap-1">
                <input className={input} placeholder="Nome" value={v.nome} onChange={(e) => setForm({ ...form, vendedores: form.vendedores.map((x, k) => (k === i ? { ...x, nome: e.target.value } : x)) })} />
                <input className={input} placeholder="CPF" value={v.cpf} onChange={(e) => setForm({ ...form, vendedores: form.vendedores.map((x, k) => (k === i ? { ...x, cpf: e.target.value } : x)) })} />
                <input className={input} placeholder="%" value={v.percentual || ''} onChange={(e) => setForm({ ...form, vendedores: form.vendedores.map((x, k) => (k === i ? { ...x, percentual: Number(e.target.value.replace(',', '.')) || 0 } : x)) })} />
                <button onClick={() => setForm({ ...form, vendedores: form.vendedores.filter((_, k) => k !== i) })} className="text-slate-400 hover:text-red-600" title="Tirar"><X className="h-3 w-3" /></button>
              </div>
            ))}
            <button onClick={() => setForm({ ...form, vendedores: [...form.vendedores, { nome: '', cpf: '', percentual: 0 }] })} className="mt-1 text-blue-700 hover:underline">+ vendedor</button>
            <div className="text-slate-400">% vazio = partes iguais.</div>
          </div>
          <div><span className="font-medium">Comprador(es):</span> {pv.compradores.map((c) => `${c.nome} (${c.cpf})`).join('; ') || '—'}</div>
          <div><span className="font-medium">Anexo (contrato/minuta):</span> {pv.anexo?.nome || '— nenhum PDF na pasta MINUTA'}</div>
          <div>ITBI estimado: <b>{brl(pv.itbiEstimado)}</b> ({pv.aliquotaEsperada}% do valor) — o portal pode usar outra base de cálculo.</div>
          {pv.avisos.map((a, i) => <div key={i} className="text-amber-700">⚠️ {a}</div>)}
          {pv.faltam.length > 0 && <div className="text-red-700">Falta (corrija acima ou na pasta do Drive): {pv.faltam.join('; ')}</div>}
          <div className="flex gap-2 pt-1">
            <button onClick={calcular} disabled={busy === 'pedir'} className="rounded bg-blue-600 px-2 py-1 font-medium text-white hover:bg-blue-700 disabled:opacity-50">Calcular no portal (sem enviar)</button>
            <button onClick={() => { setPv(null); setForm(null); }} className="rounded border border-slate-200 px-2 py-1 hover:bg-white">Fechar</button>
          </div>
        </div>
      )}
    </div>
  );
}
