'use client';
import { useEffect, useState } from 'react';
import { FileCheck2, ExternalLink, Plus, X } from 'lucide-react';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { maskDateBR } from '@/lib/utils';

/* Bloco "Certidões do processo" (aba Financiamento — Fabio 04/11): a extensão "Certidões (automática)" emite, de CADA pessoa (comprador(es) e
 * vendedor(es)), a Conjunta Receita/PGFN, Justiça Federal, Cíveis e Criminais (TJ), Trabalhista e a da Fazenda do estado/município — e a CND de IPTU
 * do imóvel. O PDF vai sozinho pra pasta do Drive (COMPRADOR / VENDEDOR / IMOVEL). Estado/município sem robô vira nota "emitir à mão" com o link.
 * Nada é enviado ao cliente nem ao banco. A certidão de matrícula/ônus continua no bloco da extensão Certidão ONR. */

type Tipo = 'FEDERAL' | 'JUSTICA_FEDERAL' | 'TJ' | 'TRABALHISTA' | 'FAZENDA' | 'IPTU';
const TIPOS_PESSOA: Tipo[] = ['FEDERAL', 'JUSTICA_FEDERAL', 'TJ', 'TRABALHISTA', 'FAZENDA'];
type Pessoa = { nome: string; doc: string; nascimento?: string; mae?: string; papel: 'COMPRADOR' | 'VENDEDOR'; uf?: string; cidade?: string };
type Job = {
  id: string; tipo: Tipo; status: string; pessoa?: Pessoa; imovel?: { inscricao: string; cidade: string; uf: string };
  site?: { orgao: string; url: string; adapter?: string }; requestedAt: string; erro?: string; detalhe?: string;
  arquivos?: { nome: string; url: string | null; resultado: string }[];
};
type Preview = { pessoas: Pessoa[]; imovel: { inscricao: string; cidade: string; uf: string }; fila: Job[]; tipos: Record<Tipo, string> };

const STATUS: Record<string, { label: string; cls: string }> = {
  REQUESTED: { label: 'Na fila', cls: 'bg-slate-100 text-slate-600' },
  RUNNING: { label: 'Emitindo', cls: 'bg-blue-100 text-blue-700' },
  WAITING: { label: 'Resolva o captcha no Chrome', cls: 'bg-amber-100 text-amber-800' },
  DONE: { label: 'Emitida', cls: 'bg-emerald-100 text-emerald-700' },
  FAILED: { label: 'Falhou', cls: 'bg-red-100 text-red-700' },
  MANUAL: { label: 'Emitir à mão', cls: 'bg-orange-100 text-orange-700' },
  CANCELED: { label: 'Cancelada', cls: 'bg-slate-100 text-slate-400' },
};
const UFS = ['AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO'];
const fmtDoc = (d: string) => { const x = d.replace(/\D/g, ''); return x.length === 11 ? x.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4') : x.length === 14 ? x.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5') : d; };

type Linha = Pessoa & { tipos: Tipo[] };

export function LeadCertidoesProcesso({ leadId }: { leadId: string }) {
  const [p, setP] = useState<Preview | null>(null);
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [linhas, setLinhas] = useState<Linha[]>([]);
  const [imovel, setImovel] = useState({ inscricao: '', cidade: '', uf: '', emitir: false });
  const carregar = () => api.get<Preview>('/api/certidoes-pessoais/preview', { params: { leadId } }).then((r) => setP(r.data)).catch(() => {});
  const pendente = !!p?.fila.some((j) => ['REQUESTED', 'RUNNING', 'WAITING'].includes(j.status));
  useEffect(() => { carregar(); }, [leadId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!pendente) return; const t = setInterval(carregar, 15_000); return () => clearInterval(t); }, [pendente, leadId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!p) return null;

  function abrir() {
    // Vem com o conjunto todo marcado; desmarcar o resto = certidão avulsa (Fabio 04/11: "o botão emite o conjunto todo ou uma certidão avulsa").
    const base = p!.pessoas.length ? p!.pessoas : [{ nome: '', doc: '', nascimento: '', papel: 'COMPRADOR' as const, uf: '', cidade: '' }];
    setLinhas(base.map((x) => ({ ...x, tipos: [...TIPOS_PESSOA] })));
    setImovel({ ...p!.imovel, emitir: !!p!.imovel.inscricao });
    setOpen(true);
  }
  const muda = (i: number, patch: Partial<Linha>) => setLinhas((cur) => cur.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  const alterna = (i: number, t: Tipo) => setLinhas((cur) => cur.map((l, k) => (k === i ? { ...l, tipos: l.tipos.includes(t) ? l.tipos.filter((x) => x !== t) : [...l.tipos, t] } : l)));

  async function pedir() {
    const total = linhas.reduce((n, l) => n + l.tipos.length, 0) + (imovel.emitir ? 1 : 0);
    if (!total) { toast('Marque ao menos uma certidão', 'error'); return; }
    if (!window.confirm(`Pedir ${total} certidão(ões)? A extensão "Certidões" emite no Chrome (captcha, se aparecer, é com você) e guarda o PDF na pasta do Drive. Nada vai ao cliente nem ao banco.`)) return;
    setSending(true);
    try {
      const { data } = await api.post<{ naFila: number; manuais: number; faltas: string[]; pulados: string[] }>('/api/certidoes-pessoais/request', { leadId, pessoas: linhas, imovel });
      const partes = [data.naFila ? `${data.naFila} na fila da extensão` : '', data.manuais ? `${data.manuais} pra emitir à mão (link na nota)` : '', data.faltas.length ? `${data.faltas.length} sem dado (ver nota)` : '', data.pulados.length ? `${data.pulados.length} já estavam na fila` : ''].filter(Boolean);
      toast(partes.join(' · ') || 'Pedido registrado', data.faltas.length ? 'error' : 'success');
      setOpen(false);
      await carregar();
    } catch (err: any) { toast(err?.response?.data?.error || 'Erro ao pedir as certidões', 'error'); }
    finally { setSending(false); }
  }
  async function cancelar(j: Job) {
    if (!window.confirm(`Cancelar ${p!.tipos[j.tipo]}?`)) return;
    try { await api.post(`/api/certidoes-pessoais/${leadId}/${j.id}/cancel`); await carregar(); } catch (err: any) { toast(err?.response?.data?.error || 'Erro ao cancelar', 'error'); }
  }

  const quem = (j: Job) => (j.pessoa ? `${j.pessoa.nome.split(' ')[0]} (${j.pessoa.papel === 'VENDEDOR' ? 'vend.' : 'comp.'})` : 'Imóvel');
  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
        <FileCheck2 className="h-3.5 w-3.5" /> Certidões do processo
      </div>
      <div className="mb-2 text-xs text-slate-500">De cada comprador e vendedor: Receita/PGFN, Justiça Federal, Cíveis e Criminais, Trabalhista e Fazenda. Do imóvel: CND de IPTU. O PDF vai pra pasta do Drive.</div>
      {p.fila.length > 0 && (
        <ul className="mb-2 space-y-1">
          {p.fila.slice(0, 14).map((j) => {
            const st = STATUS[j.status] || { label: j.status, cls: 'bg-slate-100 text-slate-600' };
            return (
              <li key={j.id} className="flex flex-wrap items-center gap-1.5 text-xs text-slate-700">
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${st.cls}`}>{st.label}</span>
                <span className="font-medium">{p.tipos[j.tipo]}</span>
                <span className="text-slate-400">— {quem(j)}</span>
                {(j.arquivos || []).map((a) => a.url && <a key={a.nome} href={a.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-blue-600 hover:underline" title={a.nome}>{a.resultado === '?' ? 'PDF' : a.resultado.toLowerCase()}<ExternalLink className="h-3 w-3" /></a>)}
                {j.status === 'MANUAL' && j.site?.url && <a href={j.site.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-orange-700 hover:underline">{j.site.orgao}<ExternalLink className="h-3 w-3" /></a>}
                {j.status === 'FAILED' && j.erro && <span className="text-red-600" title={j.erro}>{j.erro.slice(0, 60)}</span>}
                {['REQUESTED', 'WAITING', 'MANUAL'].includes(j.status) && <button onClick={() => cancelar(j)} className="text-slate-400 hover:text-red-600" title="Cancelar"><X className="h-3 w-3" /></button>}
              </li>
            );
          })}
        </ul>
      )}
      <button onClick={abrir} className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700">Emitir certidões</button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !sending && setOpen(false)}>
          <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-xl bg-white p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-800">Emitir certidões do processo</h3>
              <button onClick={() => !sending && setOpen(false)} className="text-slate-400 hover:text-slate-600"><X className="h-4 w-4" /></button>
            </div>
            <div className="mb-2 text-xs text-slate-500">O estado (UF) é o do ENDEREÇO da pessoa: define a Justiça Federal, o TJ e a Fazenda. Sem robô pro estado, a certidão vira nota com o link pra emitir à mão.</div>
            {linhas.map((l, i) => (
              <div key={i} className="mb-2 rounded border border-slate-200 p-2">
                <div className="mb-1.5 grid grid-cols-12 gap-1.5">
                  <select value={l.papel} onChange={(e) => muda(i, { papel: e.target.value as Pessoa['papel'] })} className="col-span-2 rounded border border-slate-300 px-1 py-1 text-xs">
                    <option value="COMPRADOR">Comprador</option><option value="VENDEDOR">Vendedor</option>
                  </select>
                  <input value={l.nome} onChange={(e) => muda(i, { nome: e.target.value })} placeholder="Nome completo" className="col-span-4 rounded border border-slate-300 px-2 py-1 text-xs" />
                  <input value={fmtDoc(l.doc)} onChange={(e) => muda(i, { doc: e.target.value.replace(/\D/g, '').slice(0, 14) })} placeholder="CPF ou CNPJ" className="col-span-2 rounded border border-slate-300 px-2 py-1 text-xs" />
                  <input value={l.nascimento || ''} onChange={(e) => muda(i, { nascimento: maskDateBR(e.target.value) })} placeholder="Nascimento" className="col-span-2 rounded border border-slate-300 px-2 py-1 text-xs" />
                  <select value={l.uf || ''} onChange={(e) => muda(i, { uf: e.target.value })} className={`col-span-1 rounded border px-1 py-1 text-xs ${l.uf ? 'border-slate-300' : 'border-amber-400'}`} title="Estado do endereço da pessoa">
                    <option value="">UF</option>{UFS.map((u) => <option key={u} value={u}>{u}</option>)}
                  </select>
                  <button onClick={() => setLinhas((cur) => cur.filter((_, k) => k !== i))} className="col-span-1 text-slate-400 hover:text-red-600" title="Tirar esta pessoa"><X className="mx-auto h-3.5 w-3.5" /></button>
                </div>
                <input value={l.mae || ''} onChange={(e) => muda(i, { mae: e.target.value })} placeholder="Nome da mãe (o TJDFT pede pra Cíveis e Criminais)" className="mb-1.5 w-full rounded border border-slate-300 px-2 py-1 text-xs" />
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  {TIPOS_PESSOA.map((t) => (
                    <label key={t} className="flex items-center gap-1 text-xs text-slate-600">
                      <input type="checkbox" checked={l.tipos.includes(t)} onChange={() => alterna(i, t)} /> {p.tipos[t]}
                    </label>
                  ))}
                </div>
              </div>
            ))}
            <button onClick={() => setLinhas((cur) => [...cur, { nome: '', doc: '', nascimento: '', papel: 'VENDEDOR', uf: '', cidade: '', tipos: [...TIPOS_PESSOA] }])} className="mb-3 inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline">
              <Plus className="h-3.5 w-3.5" /> Adicionar pessoa (vendedor, outro comprador)
            </button>
            <div className="mb-3 rounded border border-slate-200 p-2">
              <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-slate-700">
                <input type="checkbox" checked={imovel.emitir} onChange={(e) => setImovel({ ...imovel, emitir: e.target.checked })} /> {p.tipos.IPTU}
              </label>
              <div className="grid grid-cols-12 gap-1.5">
                <input value={imovel.inscricao} onChange={(e) => setImovel({ ...imovel, inscricao: e.target.value })} placeholder="Inscrição do IPTU" className="col-span-5 rounded border border-slate-300 px-2 py-1 text-xs" />
                <input value={imovel.cidade} onChange={(e) => setImovel({ ...imovel, cidade: e.target.value })} placeholder="Município" className="col-span-5 rounded border border-slate-300 px-2 py-1 text-xs" />
                <select value={imovel.uf} onChange={(e) => setImovel({ ...imovel, uf: e.target.value })} className="col-span-2 rounded border border-slate-300 px-1 py-1 text-xs">
                  <option value="">UF</option>{UFS.map((u) => <option key={u} value={u}>{u}</option>)}
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setOpen(false)} disabled={sending} className="rounded border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50">Cancelar</button>
              <button onClick={pedir} disabled={sending} className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50">{sending ? 'Pedindo…' : 'Pedir certidões'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
