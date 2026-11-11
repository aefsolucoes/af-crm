'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import api from '@/lib/api';
import { ExtensionsLivePanel, BancoLiveCard, colunasDe, useCreditLive, type Live } from './extensions-live-panel';
import { CaixaPanel } from './caixa-panel';
import { H, criarCena, layoutPara, type Alvo, type Boneco, type Layout, type Lugar } from './escritorio-cena';

/* ESCRITÓRIO DOS BANCOS (Fabio 10/11: "os bonequinhos seriam os bancos; os que estivessem trabalhando ficariam sentados e os que não estivessem, por algum
 * motivo, ficariam em pé no xadrez"; "ele pode ficar no xadrez ou tomando café"). Pixel art própria, desenhada em canvas (sem imagem nem biblioteca).
 *  - Sentado na mesa: a extensão está rodando um cliente (ou o próximo da fila vai começar).
 *  - No café: online e sem cliente na fila (ou fora do horário 07h–22h).
 *  - Em pé no xadrez: problema — login vencido, extensão sem sinal ou automático pausado.
 * Quando o lugar de um banco muda, o bonequinho ANDA pelo salão até o lugar novo (Fabio 11/11) — o desenho e a caminhada ficam em escritorio-cena.ts.
 * Clique no bonequinho: o cartão daquele banco (o mesmo das caixinhas: rodando, fila, agendadas, já rodados; na CAIXA, os botões do cadastro).
 * Dados: os mesmos do painel das extensões (GET /credit-analysis/live), o painel da CAIXA (GET /caixa-cadastro/painel) e a pausa geral (GET /credit-analysis/auto). */

/** `carregando`: o dado ainda não chegou — o bonequinho espera no café e, quando o dado chega, aparece direto no lugar (sem "caminhada" de mentira). */
interface EstadoBanco { lugar: Lugar; titulo: string; detalhe: string; proximo?: boolean; carregando?: boolean }

const BONECOS_HE: Boneco[] = [
  { key: 'CREDIMORAR', nome: 'Santander', cor: '#EC0000', hair: ['#1E1A1A', '#0F0D0D', '#3A3333'], skin: ['#D9A07A', '#B97F5B'], shirt: ['#EC0000', '#A80000', '#FF4D4D'], tie: null, longo: true },
  { key: 'CREDITAS', nome: 'Creditas', cor: '#12A37E', hair: ['#E8C46A', '#BF9A45', '#F7DE95'], skin: ['#F6D2B5', '#DDAE8E'], shirt: ['#12A37E', '#0B7A5E', '#3FC79F'], tie: null, longo: true },
  { key: 'INTER', nome: 'Inter', cor: '#FF7A00', hair: ['#4A2F1F', '#33201A', '#6B4630'], skin: ['#F1C6A0', '#D9A27C'], shirt: ['#FF7A00', '#C95E00', '#FF9D45'], tie: null, longo: false },
  { key: 'CAIXA', nome: 'CAIXA', cor: '#005CA9', hair: ['#BDBDBD', '#8F8F8F', '#E0E0E0'], skin: ['#E8B590', '#C98F69'], shirt: ['#005CA9', '#00427A', '#2A7DC4'], tie: '#F39200', longo: false },
];

// Financiamento (FH): Credimorar (Bradesco e Santander numa simulação), Inter no nosso portal, Itaú no portal Itaú Imóveis, CAIXA e BRB (à mão).
const BONECOS_FH: Boneco[] = [
  { key: 'CREDIMORAR_FH', nome: 'Credimorar', cor: '#1F3A93', hair: ['#5A3A24', '#3E2718', '#7A5236'], skin: ['#E8B590', '#C98F69'], shirt: ['#1F3A93', '#152A6B', '#3554B8'], tie: '#CC092F', longo: false },
  { key: 'INTER_FH', nome: 'Inter', cor: '#FF7A00', hair: ['#4A2F1F', '#33201A', '#6B4630'], skin: ['#F1C6A0', '#D9A27C'], shirt: ['#FF7A00', '#C95E00', '#FF9D45'], tie: null, longo: false },
  { key: 'ITAU_FH', nome: 'Itaú', cor: '#EC7000', hair: ['#1A1412', '#0E0A09', '#33281F'], skin: ['#8D5A3B', '#6E4329'], shirt: ['#0B3D91', '#072A66', '#2A5BB5'], tie: '#EC7000', longo: false },
  { key: 'CAIXA_FH', nome: 'CAIXA', cor: '#005CA9', hair: ['#BDBDBD', '#8F8F8F', '#E0E0E0'], skin: ['#E8B590', '#C98F69'], shirt: ['#005CA9', '#00427A', '#2A7DC4'], tie: '#F39200', longo: false },
  { key: 'BRB_FH', nome: 'BRB', cor: '#00529B', hair: ['#2B1B14', '#1A100B', '#4A3022'], skin: ['#B07A55', '#8E5F40'], shirt: ['#3FA7E0', '#2A82B5', '#7CC6EE'], tie: '#00529B', longo: true },
];

interface CardCaixa { leadId: string; nome: string; status: string | null; atual: { tipo: string; ordem: number; desde: string } | null; participantes: { ordem: number; nome: string; cadastro: string | null }[]; conferencia: { status: string } | null; avaliacao: { status: string } | null }
const ACAO_CAIXA: Record<string, string> = { consultar: 'consultando o nome', cadastrar: 'cadastrando no Caixa Aqui', avaliar: 'Avaliação de Risco' };

const curto = (t: string, n = 34) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/** Onde o bonequinho de um banco com extensão fica. Pura. */
export function estadoDoBanco(l: Live | undefined, pausado: boolean): EstadoBanco {
  if (!l) return { lugar: 'cafe', titulo: 'carregando…', detalhe: '', carregando: true };
  if (l.loginNeeded) return { lugar: 'xadrez', titulo: '🔑 login vencido', detalhe: 'entre no portal do banco' };
  const r = l.running[0];
  if (r) return { lugar: 'mesa', titulo: r.leadName, detalhe: r.step || (r.kind === 'CHECK' ? 'conferindo o resultado' : 'rodando a análise') };
  if (l.foraDoHorario) return { lugar: 'cafe', titulo: '🌙 fora do horário', detalhe: 'volta às 07h' };
  if (!l.online) return { lugar: 'xadrez', titulo: '📡 extensão sem sinal', detalhe: 'Chrome aberto e extensão ligada?' };
  const q = l.queue[0];
  if (q) return { lugar: 'mesa', titulo: q.leadName, detalhe: `próximo da fila${l.queued > 1 ? ` · ${l.queued} na fila` : ''}`, proximo: true };
  if (pausado) return { lugar: 'xadrez', titulo: '⏸ automático pausado', detalhe: 'só roda o que for pedido' };
  return { lugar: 'cafe', titulo: '☕ sem cliente na fila', detalhe: '' };
}

/** Banco rodado à mão (CAIXA e BRB no Financiamento): na mesa enquanto tem cliente em análise; senão no café. Pura. */
export function estadoManual(l: Live | undefined): EstadoBanco {
  if (!l) return { lugar: 'cafe', titulo: 'carregando…', detalhe: '', carregando: true };
  const r = l.running[0];
  if (r) return { lugar: 'mesa', titulo: r.leadName, detalhe: 'em análise (à mão)' };
  const q = l.queue[0];
  if (q) return { lugar: 'mesa', titulo: q.leadName, detalhe: `pedido à mão${l.queued > 1 ? ` · ${l.queued} na fila` : ''}`, proximo: true };
  return { lugar: 'cafe', titulo: '✋ roda à mão', detalhe: 'com a documentação completa' };
}

/** CAIXA: pelo painel da fila do Caixa Aqui (consulta, cadastro, Avaliação de Risco). Pura. */
export function estadoDaCaixa(cards: CardCaixa[] | undefined): EstadoBanco {
  if (!cards) return { lugar: 'cafe', titulo: 'carregando…', detalhe: '', carregando: true };
  const rodando = cards.find((c) => c.atual);
  if (rodando) return { lugar: 'mesa', titulo: rodando.nome, detalhe: ACAO_CAIXA[rodando.atual!.tipo] || rodando.atual!.tipo };
  const fila = cards.filter((c) => c.status === 'FILA' || c.participantes.some((p) => p.cadastro === 'FILA') || c.avaliacao?.status === 'FILA');
  if (fila.length) return { lugar: 'mesa', titulo: fila[0].nome, detalhe: `próximo da fila${fila.length > 1 ? ` · ${fila.length} na fila` : ''}`, proximo: true };
  const conferir = cards.filter((c) => c.conferencia?.status === 'PENDENTE').length;
  if (conferir) return { lugar: 'cafe', titulo: `☕ esperando a conferência (${conferir})`, detalhe: 'confira o cadastro no Caixa Aqui' };
  return { lugar: 'cafe', titulo: '☕ sem cliente na fila', detalhe: '' };
}

interface Posicionado { b: Boneco; st: EstadoBanco; cx: number; dy: number; x: number; y: number }
/** Onde cada banco fica: na própria mesa, ou no próximo lugar livre do café / do xadrez. */
function posicionar(L: Layout, bonecos: Boneco[], estados: Record<string, EstadoBanco>): Posicionado[] {
  let nc = 0, nx = 0;
  return bonecos.map((b, k) => {
    const st = estados[b.key], [cx, dy] = L.estacoes[k];
    if (st.lugar === 'mesa') return { b, st, cx, dy, x: cx - 8, y: dy - 20 };
    const [x, y] = st.lugar === 'cafe' ? L.cafe[nc++ % L.cafe.length] : L.xadrez[nx++ % L.xadrez.length];
    return { b, st, cx, dy, x, y };
  });
}
const pct = (v: number, total: number) => `${(v / total) * 100}%`;

type Modo = 'escritorio' | 'mini' | 'caixas';
const CHAVE_MODO = 'analise-credito-escritorio';

export function EscritorioBancos({ produto = 'he' }: { produto?: 'he' | 'fh' }) {
  const he = produto === 'he';
  const bonecos = he ? BONECOS_HE : BONECOS_FH;
  const colunas = colunasDe(produto);
  const { data: live } = useCreditLive(produto);
  const { data: caixa } = useQuery<{ cards: CardCaixa[] }>({ queryKey: ['caixa-painel'], queryFn: async () => (await api.get('/api/caixa-cadastro/painel')).data, refetchInterval: 10_000, enabled: he });
  const { data: auto, isFetched: autoChegou } = useQuery<{ paused?: boolean }>({ queryKey: ['credit-auto'], queryFn: async () => (await api.get('/api/credit-analysis/auto')).data, enabled: he });

  const [modo, setModo] = useState<Modo>('escritorio');
  const [escolhido, setEscolhido] = useState<string | null>(null);
  useEffect(() => { try { const m = localStorage.getItem(CHAVE_MODO); if (m === 'mini' || m === 'caixas' || m === 'escritorio') setModo(m); } catch { /* sem armazenamento: abre no escritório */ } }, []);
  const mudarModo = (m: Modo) => { setModo(m); try { localStorage.setItem(CHAVE_MODO, m); } catch { /* só não lembra */ } };

  const estados = useMemo(() => {
    const out: Record<string, EstadoBanco> = {};
    for (const b of bonecos) {
      const l = live?.find((x) => x.bank === b.key);
      const manual = !!colunas.find((c) => c.key === b.key)?.manual;
      out[b.key] = b.key === 'CAIXA' ? estadoDaCaixa(caixa?.cards) : manual ? estadoManual(l) : estadoDoBanco(l, he && !!auto?.paused);
      // A pausa geral chega por outra consulta: enquanto ela não chegou, o lugar ainda pode mudar (café → xadrez) sem ter mudado nada de verdade.
      if (he && !autoChegou && b.key !== 'CAIXA' && !manual) out[b.key].carregando = true;
    }
    return out;
  }, [bonecos, colunas, he, live, caixa, auto, autoChegou]);
  const L = useMemo(() => layoutPara(bonecos.length), [bonecos.length]);
  const pos = useMemo(() => posicionar(L, bonecos, estados), [L, bonecos, estados]);

  // A cena guarda onde cada bonequinho ESTÁ; aqui só se diz onde ele deve estar. Os alvos entram já no render (a chamada é idempotente): assim a plaquinha
  // de quem começou a andar acompanha o bonequinho neste mesmo render, sem piscar no lugar novo.
  const cena = useMemo(() => criarCena(L, bonecos), [L, bonecos]);
  const calmo = useMemo(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);
  useMemo(() => cena.definir(pos.map((p): Alvo => ({ lugar: p.st.lugar, x: p.x, y: p.y, proximo: p.st.proximo, provisorio: p.st.carregando })), !calmo), [cena, pos, calmo]);

  const cvRef = useRef<HTMLCanvasElement>(null);
  const topoRef = useRef<HTMLCanvasElement>(null);
  const plaquinhas = useRef<Record<string, HTMLDivElement | null>>({});
  const frameRef = useRef(0);
  const rafRef = useRef(0);
  const ultimoRef = useRef(0);
  const [, repintar] = useState(0);
  const desenhar = useRef<() => void>(() => {});
  desenhar.current = () => {
    const cv = cvRef.current; if (!cv) return;
    const g = cv.getContext('2d'); if (!g) return;
    cena.desenhar(g, topoRef.current?.getContext('2d') || null, frameRef.current, escolhido);
    // a plaquinha de quem está andando vai junto, sem re-render
    bonecos.forEach((b, k) => { const el = plaquinhas.current[b.key]; if (!el) return; const q = cena.posicao(k); el.style.left = pct(q.x + 8, L.W); el.style.top = pct(q.y - 1, H); });
  };
  useEffect(() => { desenhar.current(); });
  // Caminhada: um passo por quadro da tela enquanto alguém anda; quando o último chega, o laço para (e as plaquinhas voltam pro lugar com um re-render).
  const passo = useRef<(t: number) => void>(() => {});
  passo.current = (t) => {
    const dt = Math.min(60, Math.max(0, t - ultimoRef.current)); ultimoRef.current = t;
    const chegou = cena.avancar(dt);
    frameRef.current = Math.floor(t / 320);
    desenhar.current();
    if (chegou) repintar((v) => v + 1);
    rafRef.current = cena.temAndando() ? requestAnimationFrame((x) => passo.current(x)) : 0;
  };
  useEffect(() => {
    if (!cena.temAndando() || rafRef.current) return;
    ultimoRef.current = performance.now();
    rafRef.current = requestAnimationFrame((x) => passo.current(x));
  });
  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); rafRef.current = 0; }, []);
  // Parado também tem vida (digitando, fumacinha do café, telas): um quadro a cada 320 ms.
  useEffect(() => {
    if (modo !== 'escritorio' || calmo) return;
    let t: ReturnType<typeof setInterval> | null = null;
    const ligar = () => { if (t) clearInterval(t); t = document.hidden ? null : setInterval(() => { frameRef.current = Math.floor(performance.now() / 320); desenhar.current(); }, 320); };
    ligar();
    document.addEventListener('visibilitychange', ligar);
    return () => { if (t) clearInterval(t); document.removeEventListener('visibilitychange', ligar); };
  }, [modo, calmo]);

  function clique(ev: React.MouseEvent<HTMLCanvasElement>) {
    const r = ev.currentTarget.getBoundingClientRect(), x = (ev.clientX - r.left) / r.width * L.W, y = (ev.clientY - r.top) / r.height * H;
    const k = bonecos.findIndex((_b, i) => { const a = cena.area(i); return x >= a.x && x <= a.x + a.w && y >= a.y && y <= a.y + a.h; });
    if (k >= 0) setEscolhido((e) => (e === bonecos[k].key ? null : bonecos[k].key));
  }

  const rodando = pos.filter((p) => p.st.lugar === 'mesa' && !p.st.proximo).length;
  const noCafe = pos.filter((p) => p.st.lugar === 'cafe').length;
  const problema = pos.filter((p) => p.st.lugar === 'xadrez').length;
  const naFila = new Set((live || []).flatMap((l) => [...l.queue, ...(l.scheduledList || [])].map((q) => q.leadId))).size;
  const sel = escolhido ? bonecos.find((b) => b.key === escolhido) : null;

  const botao = 'text-xs px-2.5 py-1 rounded-lg border border-[#2C3A5E] text-[#D6DEEE] hover:bg-[#243052]';
  const icone = (t: string) => { const w = t.split(' ')[0]; return /^[A-Za-zÀ-ÿ0-9]/.test(w) ? '•' : w; };
  return (
    <div className="space-y-3">
      <div className="bg-[#1B2440] rounded-xl border border-[#2C3A5E] p-2.5 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2 px-1">
          <div>
            <p className="text-sm font-semibold text-white">Bancos</p>
            <p className="text-xs text-[#9FB0D0]">{rodando} rodando · {noCafe} no café · {problema} com problema{naFila ? ` · ${naFila} cliente${naFila === 1 ? '' : 's'} na fila` : ''}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {modo !== 'mini' && <button type="button" className={botao} onClick={() => mudarModo('mini')}>Minimizar</button>}
            {modo !== 'escritorio' && <button type="button" className={botao} onClick={() => mudarModo('escritorio')}>Ver o escritório</button>}
            {modo !== 'caixas' && <button type="button" className={botao} onClick={() => mudarModo('caixas')}>Ver em caixinhas</button>}
          </div>
        </div>

        {modo === 'mini' && (
          <div className="flex flex-wrap gap-2 px-1 pb-1">
            {pos.map((p) => (
              <button key={p.b.key} type="button" onClick={() => { setEscolhido(p.b.key); mudarModo('escritorio'); }} className="inline-flex items-center gap-1.5 rounded-full border border-[#2C3A5E] px-2.5 py-0.5 text-xs text-[#D6DEEE] hover:bg-[#243052]">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ background: p.b.cor }} />
                <b>{p.b.nome}</b>
                <span className="text-[#9FB0D0]">{p.st.lugar === 'mesa' ? `${p.st.proximo ? 'próximo' : 'rodando'} ${curto(p.st.titulo, 22)}` : p.st.titulo.replace(/^\S+\s/, '')}</span>
              </button>
            ))}
          </div>
        )}

        {modo === 'escritorio' && (
          <>
            <div className="relative w-full overflow-hidden rounded-lg bg-[#141821]">
              <canvas ref={cvRef} width={L.W} height={H} onClick={clique} className="block w-full cursor-pointer [image-rendering:pixelated]" aria-label="Escritório dos bancos: sentado na mesa = rodando; no café = sem cliente na fila; em pé no xadrez = login vencido, sem sinal ou pausado; andando = indo pro lugar novo" />
              {pos.map((p, k) => (cena.posicao(k).andando ? null : p.st.lugar === 'mesa' ? (
                <div key={`tag-${p.b.key}`} className="pointer-events-none absolute -translate-x-1/2 whitespace-nowrap rounded px-[0.6em] py-[0.15em] font-bold text-white shadow" style={{ left: pct(p.cx, L.W), top: pct(p.dy + 21, H), background: p.b.cor, fontSize: 'clamp(7px, 0.85vw, 11px)' }}>{p.b.nome}</div>
              ) : (
                <div key={`tag-${p.b.key}`} className="pointer-events-none absolute -translate-x-1/2 whitespace-nowrap rounded px-[0.5em] py-[0.1em] font-bold text-white shadow" style={{ left: pct(p.x + 8, L.W), top: pct(p.y + 30 + (pos.filter((q, j) => j < k && q.st.lugar === p.st.lugar).length % 2) * 7, H), background: p.b.cor, fontSize: 'clamp(6px, 0.75vw, 10px)' }}>{p.b.nome}</div>
              )))}
              {pos.map((p, k) => (cena.posicao(k).andando ? null : p.st.lugar === 'mesa' ? (
                <div key={`bal-${p.b.key}`} className="pointer-events-none absolute -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md bg-white px-[0.7em] py-[0.3em] leading-tight text-slate-800 shadow-md" style={{ left: pct(p.cx, L.W), top: pct(p.dy - 21, H), fontSize: 'clamp(7px, 0.85vw, 11px)' }}>
                  {p.st.proximo ? 'Próximo: ' : 'Rodando: '}<b>{curto(p.st.titulo, 24)}</b>
                  <span className="block text-[0.85em] text-slate-500">{curto(p.st.detalhe)}</span>
                </div>
              ) : (
                <div key={`ico-${p.b.key}`} title={`${p.b.nome}: ${p.st.titulo.replace(/^\S+\s/, '')}`} className="pointer-events-none absolute -translate-x-1/2 -translate-y-full rounded-full bg-white px-[0.35em] leading-none shadow" style={{ left: pct(p.x + 8, L.W), top: pct(p.y - 1, H), fontSize: 'clamp(8px, 0.95vw, 13px)' }}>{icone(p.st.titulo)}</div>
              )))}
              {/* quem atravessa o salão vai num canvas por cima das plaquinhas, com o nome acompanhando em cima da cabeça */}
              <canvas ref={topoRef} width={L.W} height={H} aria-hidden className="pointer-events-none absolute inset-0 h-full w-full [image-rendering:pixelated]" />
              {pos.map((p, k) => {
                const q = cena.posicao(k);
                if (!q.andando) return null;
                return <div key={`anda-${p.b.key}`} ref={(el) => { plaquinhas.current[p.b.key] = el; }} className="pointer-events-none absolute -translate-x-1/2 -translate-y-full whitespace-nowrap rounded px-[0.5em] py-[0.1em] font-bold text-white shadow" style={{ left: pct(q.x + 8, L.W), top: pct(q.y - 1, H), background: p.b.cor, fontSize: 'clamp(6px, 0.75vw, 10px)' }}>{p.b.nome}</div>;
              })}
            </div>
            {!sel && <p className="px-1 text-xs text-[#9FB0D0]">Clique num banco para ver a fila e os botões dele. ☕ sem cliente na fila · 🌙 fora do horário · 🔑 login vencido · 📡 extensão sem sinal · ⏸ automático pausado{he ? '' : ' · ✋ roda à mão'}</p>}
            {sel && (
              <div className="max-w-xl">
                {sel.key === 'CAIXA' ? <CaixaPanel /> : <BancoLiveCard b={colunas.find((c) => c.key === sel.key)!} l={live?.find((l) => l.bank === sel.key)} />}
              </div>
            )}
          </>
        )}
      </div>

      {modo === 'caixas' && <ExtensionsLivePanel produto={produto} />}
    </div>
  );
}
