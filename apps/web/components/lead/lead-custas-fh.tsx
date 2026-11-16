'use client';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Calculator, Copy, Loader2, MessageSquare } from 'lucide-react';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { valorParaEdicao, maskMoneyInput } from '@/lib/utils';
import { useComposerDraft } from '@/store/composer-draft.store';

/* Bloco "Custas do financiamento" da aba Financiamento (Fabio 16/11 — antes era um botão ao lado do campo de mensagem: "ficou muito estranho perto da msg").
 * Abre a janela de confirmação (cidade e UF em lista, valores, banco, imóvel novo, 1ª aquisição), pesquisa ITBI + escritura + registro no servidor e
 * põe a mensagem (formato do modelo "Taxas Financiamento Habitacional") no campo da conversa pra revisar — nada é enviado sozinho. */

const UFS = ['AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO'];
const BANCOS = ['CAIXA', 'BRB', 'Inter', 'Santander', 'Itaú', 'Bradesco'];
type Form = { cidade: string; uf: string; origemCidade: string; valorImovel: string; financiado: string; imovelNovo: boolean; primeiraAquisicao: boolean; banco: string };

const brNum = (v: string) => Number(String(v || '').replace(/\./g, '').replace(',', '.')) || 0;
const normCidade = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
// Nome do banco do card → opção da lista (ex.: "Banco Inter S.A." → "Inter"; "CAIXA ECONÔMICA" → "CAIXA").
const bancoDaLista = (b: string) => BANCOS.find((o) => normCidade(b).includes(normCidade(o))) || b;
const inputCls = 'mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-800';

export function LeadCustasFh({ leadId }: { leadId: string }) {
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<Form | null>(null);
  const [mensagem, setMensagem] = useState<string | null>(null);
  // Filtro digitado da lista de cidades (Fabio 16/11: "coloca pra digitar um filtro, caso precise pesquisar cidade").
  const [filtro, setFiltro] = useState('');
  const setDraft = useComposerDraft((s) => s.setDraft);
  useEffect(() => { setMensagem(null); setForm(null); }, [leadId]);

  const uf = form?.uf || '';
  const { data: municipios, isError: municipiosErro, isLoading: municipiosCarregando } = useQuery<string[]>({
    queryKey: ['custas-municipios', uf],
    queryFn: async () => (await api.get(`/api/custas/municipios/${uf}`)).data,
    enabled: !!form && UFS.includes(uf),
    staleTime: 24 * 60 * 60_000,
    retry: 1,
  });
  useEffect(() => {
    // Cidade do card escrita sem acento/diferente → ajusta pro nome da lista (ex.: "Brasilia" → "Brasília").
    if (!form?.cidade || !municipios?.length || municipios.includes(form.cidade)) return;
    const igual = municipios.find((m) => normCidade(m) === normCidade(form.cidade));
    if (igual) setForm((f) => (f ? { ...f, cidade: igual } : f));
  }, [municipios, form?.cidade]);

  async function abrir() {
    if (busy) return;
    setFiltro('');
    setBusy(true);
    try {
      const { data } = await api.get(`/api/custas/fh/${leadId}`);
      setForm({
        cidade: data.cidade || '', uf: UFS.includes(data.uf) ? data.uf : '', origemCidade: data.origemCidade || '',
        valorImovel: valorParaEdicao(data.valorImovel || ''), financiado: valorParaEdicao(data.financiado || ''),
        imovelNovo: !!data.imovelNovo, primeiraAquisicao: !!data.primeiraAquisicao, banco: data.banco ? bancoDaLista(String(data.banco)) : '',
      });
    } catch (e: any) {
      toast(e?.response?.data?.error || 'Não consegui ler os dados do card', 'error');
    } finally { setBusy(false); }
  }

  function usarNaConversa(texto: string) {
    setDraft(leadId, texto);
    toast('Mensagem no campo da conversa — confira antes de enviar', 'success');
  }

  async function calcular() {
    if (!form || busy) return;
    setBusy(true);
    try {
      const f = form;
      await api.post(`/api/custas/fh/${leadId}`, { cidade: f.cidade, uf: f.uf, origemCidade: f.origemCidade, valorImovel: brNum(f.valorImovel), financiado: brNum(f.financiado), imovelNovo: f.imovelNovo, primeiraAquisicao: f.primeiraAquisicao, banco: f.banco });
      // A pesquisa roda no servidor (1–2 min): consulta o resultado a cada 5 s, até 4 min.
      let data: any = null;
      for (let t = 0; t < 48; t++) {
        await new Promise((r) => setTimeout(r, 5000));
        const r = (await api.get(`/api/custas/fh/${leadId}/resultado`)).data;
        if (r?.status === 'PRONTO' || r?.status === 'ERRO') { data = r; break; }
      }
      if (!data) throw new Error('A pesquisa demorou demais — tente de novo');
      if (data.status === 'ERRO') throw new Error(data.erro || 'Não consegui calcular as custas agora');
      setMensagem(data.mensagem);
      setForm(null);
      usarNaConversa(data.mensagem);
    } catch (e: any) {
      toast(e?.response?.data?.error || e?.message || 'Não consegui calcular as custas agora', 'error');
    } finally { setBusy(false); }
  }

  const mudar = (p: Partial<Form>) => setForm((f) => (f ? { ...f, ...p } : f));
  const listaCidades = !municipiosErro && UFS.includes(uf);
  const filtradas = filtro.trim() ? (municipios || []).filter((m) => normCidade(m).includes(normCidade(filtro))) : (municipios || []);
  function filtrar(texto: string) {
    setFiltro(texto);
    // Sobrou uma cidade só (ou o nome exato) → já seleciona.
    const lista = texto.trim() ? (municipios || []).filter((m) => normCidade(m).includes(normCidade(texto))) : [];
    const exata = lista.find((m) => normCidade(m) === normCidade(texto));
    const escolhida = exata || (lista.length === 1 ? lista[0] : null);
    if (escolhida && escolhida !== form?.cidade) mudar({ cidade: escolhida, origemCidade: 'confirmação da equipe' });
  }

  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
        <Calculator size={14} /> Custas do financiamento
      </div>
      <p className="mb-2 text-xs text-slate-500">Estimativa de escritura, ITBI e registro pela cidade do imóvel. A mensagem vai pro campo da conversa pra você revisar.</p>
      <button onClick={abrir} disabled={busy} className="inline-flex items-center gap-1.5 rounded bg-[#00a884] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#008f70] disabled:opacity-50">
        {busy ? <Loader2 size={13} className="animate-spin" /> : <Calculator size={13} />} {busy && !form ? 'Abrindo…' : busy ? 'Calculando… (até 2 min)' : 'Calcular custas'}
      </button>

      {mensagem && (
        <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-2">
          <div className="max-h-56 overflow-y-auto whitespace-pre-wrap text-xs text-slate-700">{mensagem}</div>
          <div className="mt-2 flex flex-wrap gap-2">
            <button onClick={() => usarNaConversa(mensagem)} className="inline-flex items-center gap-1 rounded border border-emerald-300 px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50">
              <MessageSquare size={12} /> Usar na conversa
            </button>
            <button onClick={() => { navigator.clipboard?.writeText(mensagem).then(() => toast('Mensagem copiada', 'success')).catch(() => toast('Não consegui copiar', 'error')); }} className="inline-flex items-center gap-1 rounded border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100">
              <Copy size={12} /> Copiar
            </button>
          </div>
        </div>
      )}

      <Modal open={!!form} onClose={() => { if (!busy) setForm(null); }} title="Custas do financiamento" size="sm">
        {form && (
          <div className="space-y-3 text-sm text-slate-600">
            <p className="text-xs">Confira os valores do cálculo. A estimativa pesquisa a alíquota do ITBI da prefeitura e as tabelas dos cartórios do estado (escritura e registro) em fontes oficiais. A mensagem vai pro campo pra você revisar — nada é enviado sozinho.</p>
            <div className="grid grid-cols-[1fr_5rem] gap-2">
              <label className="text-xs">Cidade{form.origemCidade ? <span className="text-slate-400"> · pela {form.origemCidade}</span> : null}
                {listaCidades ? (
                  <>
                    <input value={filtro} onChange={(e) => filtrar(e.target.value)} placeholder="Digite pra filtrar a cidade" disabled={municipiosCarregando} className={inputCls} />
                    <select value={form.cidade} disabled={municipiosCarregando} onChange={(e) => mudar({ cidade: e.target.value, origemCidade: 'confirmação da equipe' })} className={inputCls}>
                    <option value="">{municipiosCarregando ? 'Carregando cidades…' : 'Escolha a cidade'}</option>
                    {form.cidade && !filtradas.includes(form.cidade) && <option value={form.cidade}>{form.cidade}</option>}
                    {filtradas.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                  {filtro.trim() && <span className="mt-0.5 block text-[11px] text-slate-400">{filtradas.length ? `${filtradas.length} cidade${filtradas.length > 1 ? 's' : ''}` : 'Nenhuma cidade com esse nome nesta UF'}</span>}
                  </>
                ) : (
                  <input value={form.cidade} onChange={(e) => mudar({ cidade: e.target.value, origemCidade: 'confirmação da equipe' })} placeholder={UFS.includes(uf) ? '' : 'Escolha a UF'} className={inputCls} />
                )}
              </label>
              <label className="text-xs">UF
                <select value={form.uf} onChange={(e) => { setFiltro(''); mudar({ uf: e.target.value, cidade: e.target.value === form.uf ? form.cidade : '', origemCidade: 'confirmação da equipe' }); }} className={inputCls}>
                  {!UFS.includes(form.uf) && <option value="">—</option>}
                  {UFS.map((u) => <option key={u} value={u}>{u}</option>)}
                </select>
              </label>
              <label className="text-xs">Valor do imóvel (R$)
                <input value={form.valorImovel} inputMode="decimal" onChange={(e) => mudar({ valorImovel: maskMoneyInput(e.target.value) })} className={inputCls} />
              </label>
              <span />
              <label className="text-xs">Valor financiado (R$)
                <input value={form.financiado} inputMode="decimal" onChange={(e) => mudar({ financiado: maskMoneyInput(e.target.value) })} className={inputCls} />
              </label>
              <span />
              <label className="text-xs">Banco
                <select value={form.banco} onChange={(e) => mudar({ banco: e.target.value })} className={inputCls}>
                  <option value="">Não definido</option>
                  {form.banco && !BANCOS.includes(form.banco) && <option value={form.banco}>{form.banco}</option>}
                  {BANCOS.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </label>
            </div>
            {/caixa|brb/i.test(form.banco) && <p className="text-xs text-amber-700">CAIXA/BRB: a mensagem avisa do pacote comercial e do seguro da taxa bonificada, apresentados no final do processo.</p>}
            <label className="flex items-start gap-2 text-xs cursor-pointer">
              <input type="checkbox" checked={form.imovelNovo} onChange={(e) => mudar({ imovelNovo: e.target.checked })} className="mt-0.5" />
              <span>Imóvel novo (1ª venda, da construtora) — em algumas cidades o ITBI é menor</span>
            </label>
            <label className="flex items-start gap-2 text-xs cursor-pointer">
              <input type="checkbox" checked={form.primeiraAquisicao} onChange={(e) => mudar({ primeiraAquisicao: e.target.checked })} className="mt-0.5" />
              <span>1ª aquisição de imóvel residencial pelo SFH — registro com 50% de desconto</span>
            </label>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setForm(null)} disabled={busy} className="text-sm px-4 py-2 rounded-lg text-slate-500 hover:bg-slate-100 disabled:opacity-50">Cancelar</button>
              <button onClick={calcular} disabled={busy || !form.cidade.trim() || !UFS.includes(form.uf) || !brNum(form.valorImovel)} className="text-sm px-4 py-2 rounded-lg text-white bg-[#00a884] disabled:opacity-50 inline-flex items-center gap-1.5">
                {busy ? <><Loader2 size={14} className="animate-spin" /> Calculando… (até 2 min)</> : 'Calcular'}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
