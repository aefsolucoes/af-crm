'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Topbar } from '@/components/ui/topbar';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { ChevronLeft, ChevronRight, ClipboardList, ExternalLink, Send, SkipForward, Check, RotateCcw, Volume2, Mic, Square, MessagesSquare } from 'lucide-react';
import api from '@/lib/api';

/* Supervisão de sexta — ver apps/api/src/services/supervision.service.ts.
 * Toda sexta 08h o CRM resume cada cliente "Em contratação" e sugere a próxima mensagem; aqui o Fabio passa um por um. Nada sai sem clicar em Enviar. */

interface Item {
  id: string; leadId: string; leadName: string; etapa: string; banco: string; janelaAberta: boolean;
  status: 'PENDING' | 'SENT' | 'SKIPPED' | 'DONE';
  resumo: string; situacao: string | null; pendencias: string | null; sugestao: string | null; acao: string | null; sentText: string | null;
}
interface Data { weekKey: string; items: Item[] }

const ST: Record<Item['status'], { label: string; cls: string }> = {
  PENDING: { label: 'Pendente', cls: 'bg-amber-50 text-amber-700' },
  SENT: { label: 'Mensagem enviada', cls: 'bg-emerald-50 text-emerald-700' },
  DONE: { label: 'Feito', cls: 'bg-blue-50 text-blue-700' },
  SKIPPED: { label: 'Pulado', cls: 'bg-slate-100 text-slate-500' },
};

export default function SupervisaoPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<Data>({ queryKey: ['supervision'], queryFn: async () => (await api.get('/api/supervision')).data });
  const [idx, setIdx] = useState(0);
  const [texto, setTexto] = useState('');
  const [busy, setBusy] = useState(false);
  const [gerando, setGerando] = useState(false);
  const [falando, setFalando] = useState(false);
  const [ouvindo, setOuvindo] = useState(false);
  // modo conversa por voz (só quando clica em "Conversar"): fala → texto → IA → fala, em loop até "parar"
  const [conversa, setConversa] = useState(false);
  const [falas, setFalas] = useState<{ de: 'fabio' | 'ia'; texto: string }[]>([]);
  const [pensando, setPensando] = useState(false);
  const conversaRef = useRef(false);
  const falasRef = useRef<{ de: 'fabio' | 'ia'; texto: string }[]>([]);
  const textoRef = useRef('');
  useEffect(() => { textoRef.current = texto; }, [texto]);

  const items = data?.items || [];
  const pendentes = useMemo(() => items.filter((i) => i.status === 'PENDING').length, [items]);
  const item = items[idx];

  // abre no 1º pendente
  useEffect(() => {
    if (!items.length) return;
    const p = items.findIndex((i) => i.status === 'PENDING');
    setIdx((cur) => (cur < items.length ? (items[cur].status === 'PENDING' ? cur : p >= 0 ? p : cur) : Math.max(0, p)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  useEffect(() => { setTexto(item?.sentText || item?.sugestao || ''); if (typeof window !== 'undefined' && 'speechSynthesis' in window) { window.speechSynthesis.cancel(); setFalando(false); } }, [item?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const recarregar = () => qc.invalidateQueries({ queryKey: ['supervision'] });
  const proximo = () => { const n = items.findIndex((i, k) => k > idx && i.status === 'PENDING'); setIdx(n >= 0 ? n : Math.min(idx + 1, items.length - 1)); };

  // ── Voz (só ao clicar): o CRM lê o card em voz alta; você responde falando e vira o texto da mensagem ──
  function ouvir() {
    if (!item || typeof window === 'undefined' || !('speechSynthesis' in window)) { toast('Este navegador não fala em voz alta', 'error'); return; }
    if (falando) { window.speechSynthesis.cancel(); setFalando(false); return; }
    const partes = [`${item.leadName}.`, item.resumo, item.situacao ? `Onde está: ${item.situacao}.` : '', item.pendencias ? `Pendências: ${item.pendencias}.` : '', item.acao ? `Sugestão pra equipe: ${item.acao}.` : '', texto.trim() ? `Mensagem sugerida pro cliente: ${texto}` : 'A sugestão é não falar com o cliente agora.'];
    const u = new SpeechSynthesisUtterance(partes.filter(Boolean).join(' '));
    u.lang = 'pt-BR'; u.rate = 1.05;
    const voz = window.speechSynthesis.getVoices().find((v) => v.lang?.toLowerCase().startsWith('pt'));
    if (voz) u.voice = voz;
    u.onend = () => setFalando(false); u.onerror = () => setFalando(false);
    window.speechSynthesis.cancel(); window.speechSynthesis.speak(u); setFalando(true);
  }
  function responderFalando() {
    const SR: any = typeof window !== 'undefined' && ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
    if (!SR) { toast('Este navegador não reconhece fala (use o Chrome ou o Safari)', 'error'); return; }
    if (falando) { window.speechSynthesis.cancel(); setFalando(false); }
    const rec = new SR();
    rec.lang = 'pt-BR'; rec.interimResults = false; rec.maxAlternatives = 1;
    rec.onresult = (e: any) => {
      const dito = String(e.results?.[0]?.[0]?.transcript || '').trim();
      if (!dito) return;
      const cmd = dito.toLowerCase().replace(/[.!?]/g, '').trim();
      if (/^(pular|pula|próximo|proximo)$/.test(cmd)) { agir('skip'); return; }
      if (/^(feito|resolvido|já fiz|ja fiz)$/.test(cmd)) { agir('done'); return; }
      setTexto(dito.charAt(0).toUpperCase() + dito.slice(1));
      toast('Texto ditado. Confira e clique em Enviar', 'success');
    };
    rec.onerror = () => { setOuvindo(false); toast('Não consegui ouvir. Tente de novo', 'error'); };
    rec.onend = () => setOuvindo(false);
    rec.start(); setOuvindo(true);
  }

  function falar(frase: string): Promise<void> {
    return new Promise((resolve) => {
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) return resolve();
      const u = new SpeechSynthesisUtterance(frase);
      u.lang = 'pt-BR'; u.rate = 1.05;
      const voz = window.speechSynthesis.getVoices().find((v) => v.lang?.toLowerCase().startsWith('pt'));
      if (voz) u.voice = voz;
      u.onend = () => resolve(); u.onerror = () => resolve();
      window.speechSynthesis.cancel(); window.speechSynthesis.speak(u);
    });
  }
  function escutar(): Promise<string> {
    return new Promise((resolve) => {
      const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (!SR) { resolve(''); return; }
      const rec = new SR(); rec.lang = 'pt-BR'; rec.interimResults = false; rec.maxAlternatives = 1;
      let dito = '';
      rec.onresult = (e: any) => { dito = String(e.results?.[0]?.[0]?.transcript || '').trim(); };
      rec.onend = () => { setOuvindo(false); resolve(dito); };
      rec.onerror = () => { setOuvindo(false); resolve(''); };
      setOuvindo(true); rec.start();
    });
  }
  function pararConversa() {
    conversaRef.current = false; setConversa(false); setOuvindo(false); setPensando(false);
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
  }
  async function conversar() {
    if (conversa) { pararConversa(); return; }
    const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR || !('speechSynthesis' in window)) { toast('Este navegador não conversa por voz (use o Chrome ou o Safari)', 'error'); return; }
    if (!item) return;
    conversaRef.current = true; setConversa(true); falasRef.current = []; setFalas([]);
    const abertura = [`${item.leadName}.`, item.resumo, item.situacao ? `Onde está: ${item.situacao}.` : '', textoRef.current.trim() ? `Minha sugestão de mensagem é: ${textoRef.current}` : 'Minha sugestão é não falar com o cliente agora.', 'O que você acha?'].filter(Boolean).join(' ');
    falasRef.current = [{ de: 'ia', texto: abertura }]; setFalas(falasRef.current);
    await falar(abertura);
    let silencios = 0;
    while (conversaRef.current) {
      const dito = await escutar();
      if (!conversaRef.current) break;
      if (!dito) { if (++silencios >= 2) { await falar('Vou parar por aqui. É só clicar em Conversar de novo.'); break; } continue; }
      silencios = 0;
      falasRef.current = [...falasRef.current, { de: 'fabio', texto: dito }]; setFalas(falasRef.current);
      if (/^(parar|para|chega|encerrar|tchau)[.!]?$/i.test(dito.trim())) break;
      setPensando(true);
      let resp: { fala: string; mensagem: string; comando: string };
      try { resp = (await api.post(`/api/supervision/${item.id}/chat`, { history: falasRef.current.slice(0, -1), fala: dito, rascunho: textoRef.current })).data; }
      catch (err: any) { resp = { fala: 'Tive um problema pra responder. Pode repetir?', mensagem: '', comando: '' }; }
      setPensando(false);
      if (!conversaRef.current) break;
      if (resp.mensagem) setTexto(resp.mensagem);
      falasRef.current = [...falasRef.current, { de: 'ia', texto: resp.fala }]; setFalas(falasRef.current);
      await falar(resp.fala);
      if (resp.comando === 'PARAR') break;
      if (resp.comando === 'PULAR') { pararConversa(); await agir('skip'); return; }
      if (resp.comando === 'FEITO') { pararConversa(); await agir('done'); return; }
      if (resp.comando === 'PROXIMO') { pararConversa(); proximo(); return; }
    }
    pararConversa();
  }
  useEffect(() => () => { conversaRef.current = false; }, []);
  useEffect(() => { if (conversaRef.current) pararConversa(); setFalas([]); }, [item?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function agir(acao: 'send' | 'template' | 'skip' | 'done' | 'reopen') {
    if (!item) return;
    if (acao === 'send' && !window.confirm(`Enviar esta mensagem pro ${item.leadName} pelo WhatsApp?`)) return;
    if (acao === 'template' && !window.confirm(`A janela do ${item.leadName} está fechada. Enviar o template de atualização do processo agora? A mensagem abaixo fica guardada e sai sozinha quando ele responder.`)) return;
    setBusy(true);
    try {
      await api.post(`/api/supervision/${item.id}/${acao}`, acao === 'send' || acao === 'template' ? { text: texto } : {});
      toast(acao === 'template' ? 'Template enviado; a mensagem sai quando ele responder' : acao === 'send' ? 'Mensagem enviada' : acao === 'skip' ? 'Pulado — fica na lista' : acao === 'done' ? 'Marcado como feito' : 'Voltou pra pendente', 'success');
      await recarregar();
      if (acao !== 'reopen') proximo();
    } catch (err: any) { toast(err?.response?.data?.error || 'Erro', 'error'); }
    finally { setBusy(false); }
  }

  async function gerar() {
    if (!window.confirm('Gerar agora a lista desta semana? (a IA lê a conversa de cada cliente em contratação — pode levar alguns minutos)')) return;
    setGerando(true);
    try { const { data: r } = await api.post('/api/supervision/generate'); toast(`${r.criados} cliente(s) adicionados — ${r.total} na lista`, 'success'); await recarregar(); }
    catch (err: any) { toast(err?.response?.data?.error || 'Erro ao gerar', 'error'); }
    finally { setGerando(false); }
  }

  return (
    <div className="flex h-full flex-col">
      <Topbar title="Supervisão de sexta" subtitle="Clientes em contratação, um por um: resumo da conversa e a próxima mensagem sugerida" />
      <div className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto p-4">
        {isLoading && <Skeleton className="h-64 w-full" />}
        {!isLoading && !items.length && (
          <div className="rounded-xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
            <ClipboardList className="mx-auto mb-2 h-8 w-8 text-slate-300" />
            A lista desta semana ainda não foi gerada. Ela sai sozinha toda sexta às 08:00.
            <div className="mt-3"><Button onClick={gerar} disabled={gerando}>{gerando ? 'Gerando…' : 'Gerar agora'}</Button></div>
          </div>
        )}
        {item && (
          <>
            <div className="mb-3 flex items-center justify-between text-xs text-slate-500">
              <span>Semana de {data?.weekKey.split('-').reverse().join('/')} · {pendentes} pendente(s) de {items.length}</span>
              <div className="flex items-center gap-1">
                <button onClick={() => setIdx(Math.max(0, idx - 1))} disabled={idx === 0} className="rounded p-1 hover:bg-slate-100 disabled:opacity-30"><ChevronLeft className="h-4 w-4" /></button>
                <span>{idx + 1} / {items.length}</span>
                <button onClick={() => setIdx(Math.min(items.length - 1, idx + 1))} disabled={idx >= items.length - 1} className="rounded p-1 hover:bg-slate-100 disabled:opacity-30"><ChevronRight className="h-4 w-4" /></button>
                <button onClick={gerar} disabled={gerando} className="ml-2 rounded border border-slate-200 px-2 py-1 hover:bg-slate-50">{gerando ? 'Gerando…' : 'Atualizar lista'}</button>
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="text-base font-semibold text-slate-800">{item.leadName}</div>
                  <div className="text-xs text-slate-500">{item.etapa}{item.banco ? ` · ${item.banco}` : ''}</div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`rounded px-2 py-0.5 text-xs font-medium ${ST[item.status].cls}`}>{ST[item.status].label}</span>
                  <Link href={`/inbox?leadId=${item.leadId}`} target="_blank" className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50">
                    <ExternalLink className="h-3 w-3" /> Abrir card
                  </Link>
                </div>
              </div>

              <section className="mb-3 text-sm text-slate-700">
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Resumo</div>
                <p className="whitespace-pre-wrap">{item.resumo}</p>
              </section>
              {item.situacao && <section className="mb-3 text-sm"><div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Onde está</div><p className="text-slate-700">{item.situacao}</p></section>}
              {item.pendencias && (
                <section className="mb-3 text-sm">
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Pendências</div>
                  <ul className="list-disc pl-5 text-slate-700">{item.pendencias.split(/;\s*/).filter(Boolean).map((p, k) => <li key={k}>{p}</li>)}</ul>
                </section>
              )}
              {item.acao && <section className="mb-3 rounded-md bg-blue-50 p-2 text-sm text-blue-800"><span className="font-medium">Sugestão pra equipe: </span>{item.acao}</section>}

              <section className="mt-4">
                <div className="mb-1 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-400">
                  <span>Mensagem pro cliente</span>
                  {!item.janelaAberta && <span className="normal-case text-amber-700">janela de 24 h fechada: vai o template e a mensagem sai quando ele responder</span>}
                </div>
                {item.status === 'SENT' ? (
                  <p className="whitespace-pre-wrap rounded-md bg-emerald-50 p-2 text-sm text-emerald-800">{item.sentText}</p>
                ) : (
                  <textarea value={texto} onChange={(e) => setTexto(e.target.value)} rows={5} placeholder="A IA achou melhor não falar com o cliente agora. Se quiser, escreva uma mensagem." className="w-full rounded-md border border-slate-300 p-2 text-sm" />
                )}
              </section>

              {falas.length > 0 && (
                <div className="mt-3 max-h-56 space-y-1 overflow-y-auto rounded-md bg-slate-50 p-2 text-sm">
                  {falas.map((f, k) => <div key={k} className={f.de === 'fabio' ? 'text-right text-slate-800' : 'text-indigo-800'}><span className="text-xs text-slate-400">{f.de === 'fabio' ? 'Você' : 'CRM'}: </span>{f.texto}</div>)}
                </div>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                {item.status !== 'SENT' && (item.janelaAberta ? (
                  <Button onClick={() => agir('send')} disabled={busy || !texto.trim()}><Send className="mr-1 h-4 w-4" /> Enviar ao cliente</Button>
                ) : (
                  <Button onClick={() => agir('template')} disabled={busy || !texto.trim()}><Send className="mr-1 h-4 w-4" /> Enviar template e guardar a mensagem</Button>
                ))}
                <button onClick={conversar} className={`inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-sm font-medium ${conversa ? 'bg-red-600 text-white hover:bg-red-700' : 'bg-indigo-600 text-white hover:bg-indigo-700'}`}><MessagesSquare className="h-4 w-4" /> {conversa ? (pensando ? 'Pensando… (parar)' : ouvindo ? 'Ouvindo… (parar)' : 'Falando… (parar)') : 'Conversar sobre este card'}</button>
                <button onClick={ouvir} className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">{falando ? <><Square className="h-4 w-4" /> Parar</> : <><Volume2 className="h-4 w-4" /> Ouvir</>}</button>
                {item.status !== 'SENT' && <button onClick={responderFalando} disabled={ouvindo} className={`inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm hover:bg-slate-50 ${ouvindo ? 'border-red-300 text-red-600' : 'border-slate-300 text-slate-700'}`}><Mic className="h-4 w-4" /> {ouvindo ? 'Ouvindo…' : 'Responder falando'}</button>}
                {item.status === 'PENDING' ? (
                  <>
                    <button onClick={() => agir('done')} disabled={busy} className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"><Check className="h-4 w-4" /> Feito (resolvi de outro jeito)</button>
                    <button onClick={() => agir('skip')} disabled={busy} className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-50"><SkipForward className="h-4 w-4" /> Pular</button>
                  </>
                ) : (
                  <button onClick={() => agir('reopen')} disabled={busy} className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-50"><RotateCcw className="h-4 w-4" /> Voltar pra pendente</button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
