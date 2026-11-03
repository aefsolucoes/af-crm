'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { UserPlus, ShieldCheck, RotateCcw } from 'lucide-react';
import api from '@/lib/api';
import { cn, formatCurrency } from '@/lib/utils';
import { toast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';

/* Bloco "CAIXA" na aba Financiamento do card (Fabio 03/11: "NÃO ACHEI O BOTÃO PARA RODAR CADASTRO NA CAIXA E TBM OUTRO BOTÃO ESCRITO, RODAR ANÁLISE DE CRÉDITO
 * NA CAIXA" + "OS BOTÕES DEVEM FICAR DENTRO DA ABA DE FINANCIAMENTO, ONDE FICA A PARTE DA CAIXA"). Mesma fila da extensão "Cadastro CAIXA" do painel CAIXA da Análise
 * de Crédito. Estado: GET /api/caixa-cadastro/:id/card (`mostrar` false = o card não tem nada da CAIXA → o bloco some); ações: POST /:id/card/cadastro e
 * /:id/card/analise. O clique na análise é a autorização da Avaliação de Risco pra este cliente — fica na anotação com o nome. Avaliação que já rodou → "Rodar análise
 * CAIXA de novo" (Jézer/Fernanda depois da autorização do PV): a extensão reabre a avaliação que deu erro e clica em Avançar lá, sem preencher outra. */
type Trava = { tipo: 'andamento' | 'feito' | 'falta'; msg: string } | null;
interface Part { ordem: number; nome: string; semRenda: boolean; consultado: boolean; cadastro: string | null; falta: string[] }
interface Refazer { proposta: string | null; data: string | null; produto: string | null; resultado: string | null }
interface Estado {
  mostrar: boolean;
  produto: 'HE' | 'FH';
  fechado: string | null;
  temFicha: boolean;
  rotaCaixa: boolean;
  avaliacaoFeita: boolean;
  participantes: Part[];
  cadastro: { trava: Trava };
  analise: {
    trava: Trava; precisaConferir: boolean; produto: string;
    tomador: string | null; incluir: string[]; fora: string[];
    valorImovel: unknown; valorCredito: unknown;
    avaliacao: { status: string; pedidoEm: string | null; inicio: string | null; fim: string | null; por: string | null; enviar: boolean; denovo: boolean; autorizacao: { por?: string; em?: string } | null; vezes: number } | null;
    denovo: { status: string; fim: string | null; resultado: string | null; refazer: Refazer | null } | null;
    resultado: string | null;
  };
}

const valor = (v: unknown) => (typeof v === 'number' ? formatCurrency(v) : String(v ?? '').trim() || '—');
const curto = (s: string) => s.split(/[:—]/)[0].trim();
const quando = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const aguardando = (s: string | null) => !s || s === 'AGUARDANDO_NOVA_AVALIACAO';

export function CaixaCardButtons({ leadId, onDone }: { leadId: string; /** Recarrega o card (anotação nova). */ onDone?: () => void }) {
  const queryClient = useQueryClient();
  const [modal, setModal] = useState<'cadastro' | 'analise' | null>(null);
  const [enviar, setEnviar] = useState(true);
  const [conferido, setConferido] = useState(false);
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const { data: estado, refetch } = useQuery<Estado>({
    queryKey: ['caixa-card', leadId],
    queryFn: async () => (await api.get(`/api/caixa-cadastro/${leadId}/card`)).data,
    // Na fila/rodando: atualiza sozinho pra o botão liberar quando a extensão terminar.
    refetchInterval: (q) => ([q.state.data?.cadastro?.trava, q.state.data?.analise?.trava].some((t) => t?.tipo === 'andamento') ? 20_000 : false),
  });
  if (!estado?.mostrar) return null;

  const a = estado.analise;
  const denovo = a.denovo; // já rodou → "Rodar análise CAIXA de novo"
  const refazer = denovo?.refazer || null;

  function abrir(qual: 'cadastro' | 'analise') {
    setEnviar(true); setConferido(false); setErro(null); setModal(qual);
  }

  async function rodar() {
    if (!modal) return;
    setBusy(true); setErro(null);
    try {
      const corpo = modal === 'analise' ? { enviar, conferido, ...(denovo ? { denovo: true } : {}) } : {};
      const { data } = await api.post(`/api/caixa-cadastro/${leadId}/card/${modal}`, corpo);
      toast(data?.mensagem || 'Pedido na fila da CAIXA');
      setModal(null);
      refetch();
      queryClient.invalidateQueries({ queryKey: ['caixa-painel'] });
      onDone?.();
    } catch (e: any) {
      const msg = e?.response?.data?.error || 'Não consegui pedir agora';
      setErro(msg);
      toast(msg, 'error');
      refetch();
    } finally { setBusy(false); }
  }

  // Linhas de status: o que a extensão está fazendo / o que já foi feito.
  const tc = estado.cadastro.trava;
  const linhaCadastro = tc && tc.tipo !== 'falta' ? tc.msg
    : estado.participantes.length ? estado.participantes.map((p) => `${p.nome.split(' ')[0] || `${p.ordem}º`}: ${p.cadastro ? curto(p.cadastro).toLowerCase() : p.consultado ? 'consultado, sem cadastro' : 'sem consulta'}`).join(' · ')
    : 'sem ficha de cadastro nem participantes no card';
  const ta = a.trava;
  const linhaAnalise = ta?.tipo === 'andamento' ? ta.msg
    : a.avaliacao ? `${curto(a.avaliacao.status).toLowerCase() || '—'} · ${quando(a.avaliacao.fim || a.avaliacao.pedidoEm)}${!aguardando(a.resultado) ? ` · resultado: ${a.resultado}` : ''}${a.avaliacao.vezes > 1 ? ` · ${a.avaliacao.vezes}ª vez` : ''}`
    : 'não rodou';

  // Botão: desabilitado quando já está na fila/rodando (ou feito, no cadastro) ou o card não está aberto; o título diz por quê. "Falta" fica clicável: a janela mostra o que falta.
  const botao = (qual: 'cadastro' | 'analise', rotulo: string, titulo: string, Icone: typeof UserPlus) => {
    const t = estado[qual].trava;
    const travado = !!estado.fechado || t?.tipo === 'andamento' || t?.tipo === 'feito';
    return (
      <button
        onClick={() => abrir(qual)}
        disabled={travado}
        title={estado.fechado || (t && t.tipo !== 'falta' ? t.msg : titulo)}
        className="inline-flex items-center gap-1 rounded border border-blue-200 bg-blue-50 px-2 py-1 text-[11px] font-medium text-[#005CA9] hover:bg-blue-100 disabled:opacity-50"
      >
        {t?.tipo === 'andamento' ? <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75 animate-ping" /><span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" /></span> : <Icone className="h-3 w-3" />}
        {rotulo}{t?.tipo === 'feito' ? ' ✓' : ''}
      </button>
    );
  };

  const travaModal = modal ? estado[modal].trava : null;
  const faltaPre = travaModal?.tipo === 'falta' ? travaModal.msg : null;
  const podeRodar = !busy && !faltaPre && !(modal === 'analise' && a.precisaConferir && !conferido);

  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
        <span className="flex h-4 w-4 items-center justify-center rounded text-[8px] font-bold text-white" style={{ background: '#005CA9' }}>CX</span> CAIXA
        <span className={cn('ml-1 rounded px-1 text-[9px] font-semibold normal-case', estado.produto === 'HE' ? 'bg-indigo-50 text-indigo-600' : 'bg-teal-50 text-teal-700')}>{estado.produto}</span>
      </div>
      <div className="space-y-0.5 text-xs">
        <p className="truncate text-slate-600" title={linhaCadastro}><span className="text-slate-400">Cadastro:</span> {linhaCadastro}</p>
        <p className="truncate text-slate-600" title={linhaAnalise}><span className="text-slate-400">Análise:</span> {linhaAnalise}</p>
        {estado.fechado && <p className="text-[11px] text-amber-700">{estado.fechado}</p>}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {botao('cadastro', 'Cadastro CAIXA', 'Rodar o cadastro deste cliente na CAIXA (Caixa Aqui) pela extensão', UserPlus)}
        {denovo
          ? botao('analise', 'Rodar análise CAIXA de novo', 'Rodar de novo a Avaliação de Risco que deu erro (ex.: depois da autorização do PV) — a extensão reabre a mesma avaliação e clica em Avançar', RotateCcw)
          : botao('analise', 'Análise CAIXA', 'Rodar a análise de crédito (Avaliação de Risco) deste cliente na CAIXA pela extensão', ShieldCheck)}
      </div>

      <Modal open={modal !== null} onClose={() => setModal(null)} title={modal === 'analise' ? (denovo ? 'Rodar a análise na CAIXA de novo' : 'Análise de crédito na CAIXA') : 'Cadastro na CAIXA'} size="sm">
        <div className="space-y-3 text-sm text-slate-600">
          {modal === 'cadastro' && (
            <>
              <p className="text-xs">
                A extensão <strong>“Cadastro CAIXA”</strong> {estado.participantes.some((p) => p.consultado) ? '' : 'consulta o nome de cada participante em Oportunidades de Negócios e '}
                preenche o cadastro no Caixa Aqui pela ficha; o CRM confere tela a tela. Nada é enviado ao cliente.
              </p>
              {!estado.temFicha && (
                <p className="text-xs rounded-lg bg-amber-50 border border-amber-200 text-amber-800 px-2.5 py-1.5">
                  O card ainda não tem a ficha de cadastro: o CRM lê os documentos do cliente (pasta do Drive ou conversa) e monta a ficha (1–3 min). Com ela pronta, o cadastro vai pra fila sozinho.
                </p>
              )}
              {estado.participantes.length > 0 && (
                <ul className="text-xs space-y-1">
                  {estado.participantes.map((p) => (
                    <li key={p.ordem} className="rounded-md border border-af-border px-2 py-1">
                      <span className="font-medium text-slate-800">{p.nome || `${p.ordem}º participante`}</span>
                      <span className="text-slate-400"> · {p.cadastro ? curto(p.cadastro).toLowerCase() : p.consultado ? 'consultado, sem cadastro' : 'sem consulta'}</span>
                      {p.falta.length > 0 && <span className="block text-amber-700">falta na ficha: {p.falta.join(', ')}</span>}
                    </li>
                  ))}
                </ul>
              )}
              {estado.avaliacaoFeita && (
                <p className="text-xs rounded-lg bg-amber-50 border border-amber-200 text-amber-800 px-2.5 py-1.5">
                  ⚠️ O crédito já rodou na CAIXA: alterar o cadastro agora pede a 2ª autorização do PV.
                </p>
              )}
            </>
          )}

          {modal === 'analise' && (
            <>
              {denovo && refazer ? (
                <p className="text-xs">
                  A extensão reabre em <strong>Formulários Enviados</strong> a avaliação que deu erro
                  ({refazer.proposta ? <>proposta <strong>{refazer.proposta}</strong>{refazer.data ? ` de ${refazer.data}` : ''}</> : 'a mais recente do produto'}
                  {(refazer.resultado || denovo.resultado) ? ` — ${refazer.resultado || denovo.resultado}` : ''}), clica em <strong>Avançar</strong> e segue as telas com os dados
                  que já estão nela — não preenche avaliação nova nem muda valores. Use depois que a agência (PV) autorizou. Se o portal barrar ou aparecer tela/botão que a
                  extensão não conhece, ela para sem clicar e o card mostra o que apareceu.
                </p>
              ) : denovo ? (
                <p className="text-xs">
                  A tentativa anterior parou antes de chegar à CAIXA (<em>{curto(denovo.status).toLowerCase() || '—'}</em>). A extensão roda a <strong>Avaliação de Risco</strong> do
                  começo, como na 1ª vez, produto <strong>{a.produto}</strong>.
                </p>
              ) : (
                <p className="text-xs">
                  A extensão roda a <strong>Avaliação de Risco</strong> no Caixa Aqui, produto <strong>{a.produto}</strong>.
                </p>
              )}
              <p className="text-xs">Clicar em “{denovo ? 'Autorizar e rodar de novo' : 'Autorizar e rodar'}” é a sua autorização pra este cliente — fica nas anotações com o seu nome e a hora. Nada é enviado ao cliente.</p>
              <dl className="text-xs grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
                <dt className="text-slate-400">Tomador</dt><dd className="text-slate-800">{a.tomador || '—'}</dd>
                {a.incluir.length > 0 && <><dt className="text-slate-400">Com renda</dt><dd className="text-slate-800">{a.incluir.join(', ')}</dd></>}
                {a.fora.length > 0 && <><dt className="text-slate-400">Fora (sem renda)</dt><dd className="text-slate-800">{a.fora.join(', ')}</dd></>}
                <dt className="text-slate-400">Imóvel</dt><dd className="text-slate-800">{valor(a.valorImovel)}</dd>
                <dt className="text-slate-400">Crédito</dt><dd className="text-slate-800">{valor(a.valorCredito)}</dd>
                {a.avaliacao && <><dt className="text-slate-400">Última</dt><dd className="text-slate-800">{curto(a.avaliacao.status).toLowerCase() || '—'} · {quando(a.avaliacao.fim || a.avaliacao.pedidoEm)}</dd></>}
                {!aguardando(a.resultado) && <><dt className="text-slate-400">Resultado</dt><dd className="text-slate-800">{a.resultado}</dd></>}
              </dl>
              {a.precisaConferir && (
                <label className="flex items-start gap-2 text-xs rounded-lg bg-amber-50 border border-amber-200 text-amber-800 px-2.5 py-1.5 cursor-pointer">
                  <input type="checkbox" checked={conferido} onChange={(e) => setConferido(e.target.checked)} className="mt-0.5" />
                  <span>Já conferi o cadastro no Caixa Aqui (o cadastro foi gravado e ainda não tinha sido conferido).</span>
                </label>
              )}
              <label className="flex items-start gap-2 text-xs cursor-pointer">
                <input type="checkbox" checked={enviar} onChange={(e) => setEnviar(e.target.checked)} className="mt-0.5" />
                <span>
                  <strong>Enviar à CAIXA</strong> — {denovo && refazer ? 'depois do Avançar, a extensão segue até o “Solicitar Avaliação”' : 'a extensão preenche a operação e clica na seta da tela 3'}; o resultado sai depois, na consulta de Formulários Enviados.
                  {!enviar && <span className="block text-slate-400">Desmarcado: para na tela da operação, antes de enviar, pra você conferir.</span>}
                </span>
              </label>
            </>
          )}

          {(faltaPre || erro) && (
            <p className="text-xs rounded-lg bg-red-50 border border-red-200 text-red-700 px-2.5 py-1.5">{erro || faltaPre}</p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button onClick={() => setModal(null)} className="text-sm px-4 py-2 rounded-lg text-slate-500 hover:bg-slate-100">Cancelar</button>
            <button
              onClick={rodar}
              disabled={!podeRodar}
              className="text-sm px-4 py-2 rounded-lg text-white disabled:opacity-50"
              style={{ background: '#005CA9' }}
            >
              {busy ? 'Pedindo...' : modal === 'analise' ? (denovo ? 'Autorizar e rodar de novo' : 'Autorizar e rodar') : 'Rodar cadastro'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
