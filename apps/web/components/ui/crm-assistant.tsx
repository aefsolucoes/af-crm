'use client';
import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Check, Ban, ExternalLink, X, Volume2, MessageSquare } from 'lucide-react';
import api from '@/lib/api';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/toast';
import { useAuthStore } from '@/store/auth.store';
import { useOutboundCallStore } from '@/store/outbound-call.store';
import { DocumentCard, SimulationCard, CopyCard, RecorderCard, VoicePicker, type Attachment, type AudioReq, type CopyReq, type Nav, type Pending, type Voice } from '@/components/ui/jarvis-cards';
import { JarvisChat, type ChatItem } from '@/components/ui/jarvis-chat';

/* "Jarvis" — o assistente do CRM em forma de BOLINHA (Fabio 29/10: "não precisa ter chat, só a bolinha mesmo, como se fosse uma Siri").
 * Toca na bolinha → ela ouve, o Claude raciocina com as ferramentas do CRM (routes/assistant.ts) e responde FALANDO (voz Matilda da ElevenLabs; a do navegador
 * de reserva). Ela é 3D e passeia pela tela enquanto conversa; parada, fica no canto. O que precisa de tela aparece num balãozinho ao lado dela:
 * confirmar/cancelar ação ("sim"/"não" falado também vale), gravador de áudio pro cliente, PDF da simulação, link pra tela aberta.
 * Ligação: confirmada, ela para de ouvir, abre a conversa e disca (quem fala é o colaborador). Lembretes ("me lembra de…") ela fala na hora.
 * O contexto da conversa fica só neste navegador e é esquecido depois de 2 h parado.
 * 23/11 (Fabio: "abrir o chat para fazer as funções novamente"): o 💬 colado na bolinha abre o CHAT POR TEXTO (jarvis-chat.tsx) — mesma conversa, com histórico,
 * anexar arquivo e os mesmos cartões Confirmar/Cancelar; aberto o chat, a bolinha vai pro cabeçalho dele. */

type Msg = { role: 'user' | 'assistant'; content: string };
type Voz = 'off' | 'ouvindo' | 'pensando' | 'falando';
type Cartao = { fala?: string; disse?: string; pending?: Pending[]; attachments?: Attachment[]; nav?: Nav | null; audio?: AudioReq | null; copiar?: CopyReq[]; escolherVoz?: boolean };
const VOZ_KEY = 'af_jarvis_voz';
const lerVoz = () => { try { return localStorage.getItem(VOZ_KEY) || ''; } catch { return ''; } };
const STORE_KEY = 'af_crm_jarvis_ctx';
// Conversa ativa (sessionStorage, por aba): se a página recarregar no meio — depois de um deploy, a 1ª troca de tela recarrega o site inteiro — a conversa volta sozinha (Fabio 30/10: "mudei de tela e ela parou").
const ATIVO_KEY = 'af_jarvis_ativo';
function marcaAtivo(on: boolean) { try { if (on) sessionStorage.setItem(ATIVO_KEY, String(Date.now())); else sessionStorage.removeItem(ATIVO_KEY); } catch { /* */ } }
const SPOKEN_KEY = 'af_crm_assistant_reminders_spoken';
const ORB = 64;
const MOVE_MS = 4200;

function load(): Msg[] {
  try { const v = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); return v && Date.now() - v.at < 2 * 3600_000 && Array.isArray(v.msgs) ? v.msgs.slice(-20) : []; } catch { return []; }
}
function save(msgs: Msg[]) { try { localStorage.setItem(STORE_KEY, JSON.stringify({ at: Date.now(), msgs: msgs.slice(-20) })); } catch { /* sem armazenamento: segue sem contexto */ } }
function spokenIds(): string[] { try { const v = JSON.parse(localStorage.getItem(SPOKEN_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } }
function markSpoken(id: string) { try { localStorage.setItem(SPOKEN_KEY, JSON.stringify([...spokenIds(), id].slice(-100))); } catch { /* */ } }
// Chat por texto (Fabio 23/11): o histórico que aparece no painel fica neste navegador por 12 h (o contexto do Claude continua no af_crm_jarvis_ctx, 2 h).
const LOG_KEY = 'af_jarvis_chat_log';
const CHAT_ABERTO_KEY = 'af_jarvis_chat_aberto';
const LOG_MAX = 60;
function loadLog(): ChatItem[] {
  try {
    const v = JSON.parse(localStorage.getItem(LOG_KEY) || 'null');
    if (!v || !Array.isArray(v.itens) || Date.now() - v.at > 12 * 3600_000) return [];
    const agora = Date.now();
    // ação pendente de mais de 30 min já saiu da memória do servidor; "Fazendo…" sem resposta = a página recarregou no meio
    return (v.itens as ChatItem[]).slice(-LOG_MAX).map((it) => ({ ...it, pending: it.pending?.map((x) => (x.estado === 'PENDENTE' && agora - it.at > 30 * 60_000 ? { ...x, estado: 'ERRO' as const, resultado: 'Expirou — peça de novo.' } : x.resultado === 'Fazendo…' ? { ...x, resultado: 'A página recarregou antes da resposta — confira no card.' } : x)) }));
  } catch { return []; }
}
function saveLog(itens: ChatItem[]) { try { localStorage.setItem(LOG_KEY, JSON.stringify({ at: Date.now(), itens: itens.slice(-LOG_MAX) })); } catch { /* sem armazenamento: o chat vale só nesta tela */ } }
const paraBase64 = (b: Blob) => new Promise<string>((resolve, reject) => { const fr = new FileReader(); fr.onload = () => resolve(String(fr.result).split(',')[1] || ''); fr.onerror = reject; fr.readAsDataURL(b); });
/** Foto grande (> 4 MB) vira JPEG de até 2400 px antes de subir; PDF e HEIC vão como estão (o servidor converte o HEIC). */
async function prepararArquivo(f: File): Promise<{ nome: string; mimeType: string; base64: string }> {
  let mime = f.type || (/\.pdf$/i.test(f.name) ? 'application/pdf' : /\.(heic|heif)$/i.test(f.name) ? 'image/heic' : /\.png$/i.test(f.name) ? 'image/png' : 'image/jpeg');
  let blob: Blob = f; let nome = f.name || 'documento';
  if (/^image\/(jpeg|png|webp)$/.test(mime) && f.size > 4_000_000) {
    try {
      const bmp = await createImageBitmap(f);
      const k = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
      const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
      cv.getContext('2d')!.drawImage(bmp, 0, 0, cv.width, cv.height);
      const out = await new Promise<Blob | null>((r) => cv.toBlob(r, 'image/jpeg', 0.85));
      if (out && out.size < f.size) { blob = out; mime = 'image/jpeg'; nome = `${nome.replace(/\.(png|webp|jpe?g)$/i, '')}.jpg`; }
    } catch { /* manda o original */ }
  }
  return { nome, mimeType: mime, base64: await paraBase64(blob) };
}
// "sim"/"não" DIGITADO só vale como resposta curta e sozinha (no texto não existe o atalho "já confirmei" da voz: sempre clique ou "sim").
const SIM_TXT = /^(sim|s|pode|pode sim|confirmo|confirma|confirmar|confirmado|manda|pode mandar|faz|pode fazer|isso|ok|beleza|claro)$/;
const QUAL_TXT = /^(?:(?:sim|confirma|confirmo|pode)[, ]+)?(?:a |o )?(primeir[ao]|segund[ao]|terceir[ao]|1|2|3|todas|todos|tudo|as duas|os dois|ambas|ambos)$/;
const NAO_TXT = /^(n[aã]o|n|cancela|cancelar|deixa|esquece|negativo)$/;

const SIM = /^(sim|pode|pode sim|confirmo|confirma|confirmar|confirmado|firma|firmo|manda|pode mandar|faz|pode fazer|isso|ok|beleza|claro|liga|pode ligar)\b/i; // "firma": o reconhecimento às vezes corta o começo de "confirma"
// Pedido que JÁ traz a confirmação ("…e confirma", "pode pedir", "sem perguntar"): a ação sai sem pedir de novo (Fabio 29/10: "não precisa confirmar 2x se eu já disse confirmar").
const JA_CONFIRMOU = /\b(e\s+)?(confirm[ao]|confirmar|confirmado|j[aá] confirmo|sem perguntar|pode (pedir|mandar|fazer|enviar|solicitar)|j[aá] pode)\b/i;
const NAO = /^(não|nao|cancela|cancelar|deixa|esquece|negativo)\b/i;
const FALHA_MIC = '\u0000falha';
const PARAR = /^(parar|para|para de ouvir|chega|encerrar|tchau|obrigado|valeu|só isso|é só isso)[.!]?$/i;

/** Bolinha 3D: esfera com luz, sombra e "plasma" girando dentro. Gira mais rápido pensando, pulsa falando, respira ouvindo. */
function Orb3D({ voz }: { voz: Voz }) {
  const ativo = voz !== 'off';
  return (
    <span className="relative block w-full h-full" style={{ perspective: 300 }}>
      <span className="absolute left-[12%] right-[12%] -bottom-[14%] h-[18%] rounded-[50%] bg-black/30 blur-[6px]" style={{ animation: 'jvShadow 3.6s ease-in-out infinite' }} />
      <span
        className="absolute inset-0 rounded-full overflow-hidden"
        style={{
          background: 'radial-gradient(circle at 32% 26%, #ffffff 0%, #c9e8ff 7%, #63b3ff 26%, #3a4fd6 55%, #1a0f5c 82%, #0b0730 100%)',
          boxShadow: `inset -9px -12px 20px rgba(5,3,30,.55), inset 7px 7px 16px rgba(255,255,255,.22), 0 0 ${ativo ? 34 : 18}px rgba(99,179,255,${ativo ? 0.7 : 0.45})`,
          animation: voz === 'falando' ? 'jvTalk .5s ease-in-out infinite alternate' : voz === 'ouvindo' ? 'jvBreath 1.8s ease-in-out infinite' : 'jvWobble 7s ease-in-out infinite',
        }}
      >
        <span className="absolute -inset-[30%] opacity-60 mix-blend-screen blur-[7px]" style={{ background: 'conic-gradient(from 0deg, transparent 0 15%, #a78bfa 25%, transparent 38%, #38bdf8 55%, transparent 68%, #f0abfc 82%, transparent 92%)', animation: `jvSpin ${voz === 'pensando' ? '1.2s' : voz === 'falando' ? '2.2s' : '6s'} linear infinite` }} />
        <span className="absolute -inset-[30%] opacity-45 mix-blend-screen blur-[9px]" style={{ background: 'conic-gradient(from 120deg, transparent 0 20%, #22d3ee 32%, transparent 45%, #818cf8 70%, transparent 85%)', animation: `jvSpin ${voz === 'pensando' ? '1.8s' : '9s'} linear infinite reverse` }} />
        <span className="absolute left-[18%] top-[12%] w-[38%] h-[26%] rounded-[50%] bg-white/70 blur-[5px]" />
        <span className="absolute left-[26%] top-[16%] w-[14%] h-[9%] rounded-[50%] bg-white blur-[1px]" />
        <span className="absolute inset-0 rounded-full" style={{ boxShadow: 'inset 0 -3px 6px rgba(167,139,250,.35)' }} />
      </span>
      <style>{`
        @keyframes jvSpin { to { transform: rotate(360deg); } }
        @keyframes jvTalk { from { transform: scale(.9); } to { transform: scale(1.08); } }
        @keyframes jvBreath { 0%,100% { transform: scale(.95); } 50% { transform: scale(1.03); } }
        @keyframes jvWobble { 0%,100% { transform: rotateX(0deg) rotateY(0deg) translateY(0); } 25% { transform: rotateX(10deg) rotateY(-12deg) translateY(-3px); } 50% { transform: rotateX(-5deg) rotateY(9deg) translateY(1px); } 75% { transform: rotateX(7deg) rotateY(5deg) translateY(-2px); } }
        @keyframes jvShadow { 0%,100% { transform: scaleX(1); opacity: .9; } 50% { transform: scaleX(.85); opacity: .6; } }
      `}</style>
    </span>
  );
}


/** "zero quatro sete sete sete zero dois zero" → "04777020"; "4 7 7 7" → "4777". Só junta sequências de 3+ dígitos falados (palavra ou número solto), pra não trocar "um cliente". Pura. */
const DIGITO: Record<string, string> = { zero: '0', um: '1', uma: '1', dois: '2', duas: '2', tres: '3', quatro: '4', cinco: '5', seis: '6', meia: '6', sete: '7', oito: '8', nove: '9' };
/** Texto → fala (Fabio 29/10: "em vez de dizer avenida ela diz AVE" e "fala embolado os números"): abreviações por extenso, ordinal por extenso e CEP/CPF/telefone dígito a dígito, em grupos. Pura. */
const ORDINAL = ['', 'primeiro', 'segundo', 'terceiro', 'quarto', 'quinto', 'sexto', 'sétimo', 'oitavo', 'nono', 'décimo', 'décimo primeiro', 'décimo segundo', 'décimo terceiro', 'décimo quarto', 'décimo quinto', 'décimo sexto', 'décimo sétimo', 'décimo oitavo', 'décimo nono', 'vigésimo'];
const DIG_FALA = ['zero', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove'];
const digitos = (d: string) => d.split('').map((c) => DIG_FALA[Number(c)]).join(' ');
export function paraFala(texto: string): string {
  let t = String(texto || '');
  t = t.replace(/\bAv\.?(?=\s)/gi, 'Avenida').replace(/\bR\.(?=\s+[A-ZÀ-Ú0-9])/g, 'Rua').replace(/\bTv\.?(?=\s)/gi, 'Travessa').replace(/\bAl\.(?=\s)/g, 'Alameda').replace(/\bEstr\.(?=\s)/gi, 'Estrada')
    .replace(/\bApto\.?|\bAp\.(?=\s*\d)/gi, 'apartamento').replace(/\bn[º°o]\.?\s*(?=\d)/gi, 'número ').replace(/\bBl\.(?=\s)/g, 'bloco').replace(/\bJd\.(?=\s)/gi, 'Jardim').replace(/\bVl\.(?=\s)/gi, 'Vila')
    .replace(/\bSta\.(?=\s)/g, 'Santa').replace(/\bSto\.(?=\s)/g, 'Santo').replace(/\bDr\.(?=\s)/g, 'Doutor').replace(/\bDra\.(?=\s)/g, 'Doutora').replace(/\ba\.m\./gi, 'ao mês').replace(/\ba\.a\./gi, 'ao ano');
  t = t.replace(/\b(\d{1,2})\s*[º°]/g, (_m, n) => ORDINAL[Number(n)] || `${n}º`).replace(/\b(\d{1,2})\s*ª/g, (_m, n) => (ORDINAL[Number(n)] || n).replace(/o\b/g, 'a'));
  // CEP (00000-000 ou 8 dígitos depois de "CEP"), CPF e telefone: dígito a dígito, com pausa entre os grupos
  t = t.replace(/\b(\d{5})-?(\d{3})\b/g, (_m, a, b) => `${digitos(a)}, ${digitos(b)}`)
    .replace(/\b(\d{3})\.(\d{3})\.(\d{3})-(\d{2})\b/g, (_m, a, b, c, d) => `${digitos(a)}, ${digitos(b)}, ${digitos(c)}, ${digitos(d)}`)
    .replace(/\(?\b(\d{2})\)?\s*(9?\d{4})-?(\d{4})\b/g, (_m, a, b, c) => `${digitos(a)}, ${digitos(b)}, ${digitos(c)}`)
    .replace(/\b\d{9,}\b/g, (d) => d.match(/.{1,3}/g)!.map(digitos).join(', '));
  return t;
}

/** Soletrado (Fabio 29/10: "ela não sabe soletrar"): "f e r n a n d a" / "efe erre a" → "fernanda" (3+ letras seguidas); "arroba" → "@" e "ponto" → "." dentro de e-mail. Pura. */
const LETRA: Record<string, string> = { a: 'a', be: 'b', ce: 'c', de: 'd', e: 'e', efe: 'f', ge: 'g', ga: 'h', aga: 'h', aga_: 'h', i: 'i', jota: 'j', ka: 'k', ca: 'k', ele: 'l', eme: 'm', ene: 'n', o: 'o', pe: 'p', que: 'q', erre: 'r', esse: 's', te: 't', u: 'u', ve: 'v', dablio: 'w', xis: 'x', ipsilon: 'y', ze: 'z' };
export function soletrado(texto: string): string {
  const nrm = (w: string) => w.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[.,;:!?]+$/, '');
  const letra = (w: string) => { const raw = w.replace(/[.,;:!?]+$/, ''); if (/^[a-zA-Z]$/.test(raw)) return raw.toLowerCase(); const n = nrm(w); return raw.length > 1 && LETRA[n] ? LETRA[n] : null; }; // "é" (verbo) não é letra
  const toks = String(texto || '').split(/\s+/);
  const out: string[] = [];
  for (let i = 0; i < toks.length;) {
    let j = i; const ls: string[] = [];
    while (j < toks.length) { const l = letra(toks[j]); if (l === null) break; ls.push(l); j++; }
    if (ls.length >= 3) { out.push(ls.join('')); i = j; } else { out.push(toks[i]); i++; }
  }
  let t = out.join(' ');
  t = t.replace(/\s*\barroba\b\s*/gi, '@');
  for (let k = 0; k < 4; k++) t = t.replace(/(\S*@\S*?)\s+ponto\s+(\S+)/gi, '$1.$2');
  return t;
}
export function numerosFalados(texto: string): string {
  texto = soletrado(texto);
  const toks = String(texto || '').split(/\s+/);
  const dig = (w: string) => { const n = w.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[.,;:!?]+$/, ''); return DIGITO[n] ?? (/^\d{1,4}$/.test(n) ? n : null); };
  const out: string[] = [];
  for (let i = 0; i < toks.length;) {
    let j = i; const ds: string[] = [];
    while (j < toks.length) { const d = dig(toks[j]); if (d === null) break; ds.push(d); j++; }
    if (ds.length >= 3) { out.push(ds.join('') + (/[.,;:!?]$/.test(toks[j - 1]) ? toks[j - 1].slice(-1) : '')); i = j; }
    else { out.push(toks[i]); i++; }
  }
  return out.join(' ');
}





export function CrmAssistant() {
  const pathname = usePathname();
  const router = useRouter();
  const userName = useAuthStore((s) => s.user?.name) || '';
  const primeiroNome = userName.split(/\s+/)[0] || '';
  const [voz, setVoz] = useState<Voz>('off');
  const [cartao, setCartao] = useState<Cartao | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const msgsRef = useRef<Msg[]>([]);
  const vozRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const recRef = useRef<any>(null);
  const cartaoRef = useRef<Cartao | null>(null);
  const vozIdRef = useRef('');
  const [vozNome, setVozNome] = useState('');
  const vozNomeRef = useRef('');
  useEffect(() => { vozNomeRef.current = vozNome; }, [vozNome]);
  // Chamar pelo nome (Fabio 29/10: "somente o primeiro nome, sem ei"): desligado por padrão; ligado, um reconhecimento fica ouvindo (com o CRM aberto) e abre a conversa quando ouve o nome da voz escolhida.
  const WAKE_KEY = 'jv_chamar_nome';
  const [chamarPorNome, setChamarPorNome] = useState(false);
  const partidaRef = useRef('');
  useEffect(() => { try { setChamarPorNome(localStorage.getItem(WAKE_KEY) === '1'); } catch { /* */ } }, []);
  function alternaChamarPorNome() {
    const novo = !chamarPorNome; setChamarPorNome(novo);
    try { localStorage.setItem(WAKE_KEY, novo ? '1' : '0'); } catch { /* */ }
    toast(novo ? `Pronto: é só dizer "${vozNome || 'o nome da voz'}" (Chrome com o CRM aberto)` : 'Chamar pelo nome desligado', 'success');
  }
  useEffect(() => { vozIdRef.current = lerVoz(); try { setVozNome(localStorage.getItem(`${VOZ_KEY}_nome`) || ''); } catch { /* */ } }, []);
  const setCard = (c: Cartao | null) => { cartaoRef.current = c; setCartao(c); };

  useEffect(() => { msgsRef.current = load(); }, []);

  // ── chat por texto (Fabio 23/11): mesma conversa da voz, num painel; o que a bolinha fala também entra no histórico ──
  const [chatAberto, setChatAberto] = useState(false);
  const chatAbertoRef = useRef(false);
  const [itens, setItensState] = useState<ChatItem[]>([]);
  const itensRef = useRef<ChatItem[]>([]);
  const [pensandoTexto, setPensandoTexto] = useState(false);
  useEffect(() => { const l = loadLog(); itensRef.current = l; setItensState(l); try { if (sessionStorage.getItem(CHAT_ABERTO_KEY) === '1') setChatAberto(true); } catch { /* */ } }, []);
  useEffect(() => { chatAbertoRef.current = chatAberto; try { if (chatAberto) sessionStorage.setItem(CHAT_ABERTO_KEY, '1'); else sessionStorage.removeItem(CHAT_ABERTO_KEY); } catch { /* */ } }, [chatAberto]);
  const setItens = (f: (a: ChatItem[]) => ChatItem[]) => { const n = f(itensRef.current).slice(-LOG_MAX); itensRef.current = n; setItensState(n); saveLog(n); };
  const addItem = (it: Omit<ChatItem, 'id' | 'at'>) => { const item: ChatItem = { ...it, id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, at: Date.now() }; setItens((a) => [...a, item]); return item.id; };
  /** Lista de vozes: no chat aberto vai pro histórico (o balãozinho fica escondido), senão no balão. */
  const pedeVoz = () => { if (chatAbertoRef.current) addItem({ role: 'assistant', texto: 'Escolha a voz do Jarvis:', escolherVoz: true }); else setCard({ escolherVoz: true }); };
  function limparChat() { setItens(() => []); msgsRef.current = []; save([]); setCard(null); }

  // ── posição: no canto quando parada; passeando pela tela enquanto conversa (para quando há algo pra clicar no balão) ──
  const canto = () => ({ x: window.innerWidth - ORB - 20, y: window.innerHeight - ORB - 84 });
  const precisaClique = !!(cartao?.pending?.some((p) => p.estado === 'PENDENTE') || cartao?.audio || cartao?.attachments?.length || cartao?.copiar?.length || cartao?.escolherVoz);
  const conversando = voz !== 'off';
  // Mouse em cima da bolinha ou do balão: ela PARA onde está pra pessoa olhar (Fabio 29/10); ao sair, volta a passear.
  const [mouseEm, setMouseEm] = useState(false);
  const orbRef = useRef<HTMLButtonElement | null>(null);
  const pressRef = useRef<{ t: ReturnType<typeof setTimeout> | null; abriu: boolean }>({ t: null, abriu: false });
  const segura = () => { const r = orbRef.current?.getBoundingClientRect(); if (r) setPos({ x: r.left, y: r.top }); setMouseEm(true); };
  const solta = () => setMouseEm(false);
  useEffect(() => {
    setPos(canto());
    const onR = () => { if (!vozRef.current) setPos(canto()); };
    window.addEventListener('resize', onR);
    return () => window.removeEventListener('resize', onR);
  }, []);
  useEffect(() => {
    if (!conversando) { if (!precisaClique) setPos(canto()); return; }
    if (precisaClique || mouseEm) return;
    const passeia = () => {
      const w = window.innerWidth, h = window.innerHeight;
      setPos({ x: 260 + Math.random() * Math.max(40, w - 260 - ORB - 40), y: 90 + Math.random() * Math.max(40, h - 90 - ORB - 120) });
    };
    let t: ReturnType<typeof setInterval> | undefined;
    const primeiro = setTimeout(() => { passeia(); t = setInterval(passeia, MOVE_MS); }, 1200);
    return () => { clearTimeout(primeiro); if (t) clearInterval(t); };
  }, [conversando, precisaClique, mouseEm]);

  // ── voz ──
  function vozNavegador(frase: string): Promise<void> {
    return new Promise((resolve) => {
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) return resolve();
      const u = new SpeechSynthesisUtterance(frase);
      u.lang = 'pt-BR'; u.rate = 1.05;
      const vs = window.speechSynthesis.getVoices();
      const v = vs.find((x) => x.lang?.toLowerCase().replace('_', '-') === 'pt-br') || vs.find((x) => /brasil|brazil|luciana|felipe/i.test(x.name)); // nunca pt-PT (Fabio 29/10: português do Brasil)
      if (v) u.voice = v;
      u.onend = () => resolve(); u.onerror = () => resolve();
      window.speechSynthesis.cancel(); window.speechSynthesis.speak(u);
    });
  }
  /** Fala no máximo ~3 frases (Fabio 30/10: "fala demais"); o texto inteiro continua no balão. */
  function encurta(t: string): string {
    if (t.length <= 360) return t;
    const frases = t.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) || [t];
    let out = '';
    for (const f of frases) { if (out && (out + f).length > 360) break; out += f; }
    if (!out) out = t.slice(0, 340).replace(/\s+\S*$/, '') + '…';
    return `${out.trim()} O resto está na tela.`;
  }
  async function falar(frase: string): Promise<void> {
    const t = encurta(paraFala(frase.replace(/[*_#`>⏰]/g, '').replace(/https?:\S+/g, '').trim()));
    if (!t) return;
    setVoz('falando');
    try { audioRef.current?.pause(); } catch { /* */ }
    cortouRef.current = false;
    const soltaVigia = vigiarInterrupcao(t);
    try {
      const r = await api.post('/api/assistant/tts', { text: t.slice(0, 900), voiceId: vozIdRef.current || undefined }, { responseType: 'blob' });
      const url = URL.createObjectURL(r.data as Blob);
      await new Promise<void>((resolve) => {
        if (cortouRef.current) { resolve(); return; } // falou por cima antes do áudio chegar: nem começa
        const a = new Audio(url); audioRef.current = a;
        a.onended = () => resolve(); a.onerror = () => resolve(); a.onpause = () => resolve();
        a.play().catch(() => resolve());
      });
      URL.revokeObjectURL(url);
    } catch { await vozNavegador(t); }
    soltaVigia();
    await new Promise((r) => setTimeout(r, 250)); // o navegador só deixa um reconhecimento por vez: dá tempo de o vigia soltar o microfone
    setVoz(vozRef.current ? 'pensando' : 'off');
  }
  /** Interromper a bolinha falando (Fabio 29/10: "falei o nome da cliente e ela continuou a lista"). Enquanto ela fala, um 2º reconhecimento fica ouvindo: palavra que ela NÃO está dizendo (o eco da própria voz é descartado) ou "pare/espera/calma/chega" corta a fala na hora e o que foi dito vira o pedido seguinte. */
  const interrompidoRef = useRef('');
  const cortouRef = useRef(false);
  function vigiarInterrupcao(falado: string): () => void {
    const SR: any = typeof window !== 'undefined' ? ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition) : null;
    if (!SR || !vozRef.current) return () => {};
    const norm = (x: string) => x.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
    const palavras = norm(falado);
    const dele = new Set(palavras);
    let ativo = true;
    let rec: any;
    try {
      rec = new SR(); rec.lang = 'pt-BR'; rec.continuous = true; rec.interimResults = true;
      rec.onresult = (e: any) => {
        if (!ativo) return;
        let txt = ''; let final = false;
        for (let i = e.resultIndex; i < e.results.length; i++) { txt += `${e.results[i][0].transcript} `; if (e.results[i].isFinal) final = true; }
        const ws = norm(txt);
        if (!ws.length) return;
        // Fabio 29/10 e 30/10 (2ª vez): "eu nem falo nada, ele acha que eu estou falando e para" — o microfone ouve a PRÓPRIA voz (eco) com atraso e o reconhecimento
        // devolve trechos inteiros já ditos; a regra de "escolha curta" (02bbe1e) cortava com isso. Agora só corta com o que NÃO pode ser eco:
        //  1) palavra de parar que ela NÃO está dizendo nesta fala (pare, espera, calma, chega, o nome da voz);
        //  2) frase de verdade, já fechada: 4+ palavras que não estão na fala dela, sendo quase tudo o que foi ouvido;
        //  3) "sim/confirma" com ação esperando — só se essa palavra não está na fala dela (eco de "pode" nunca confirma nada).
        // Escolher uma opção no meio da leitura: toque na bolinha (corta na hora) e fale.
        const nomeVoz = norm(vozNomeRef.current || '')[0];
        const pararCom = ['pare', 'espera', 'espere', 'calma', 'chega', 'jarvis', ...(nomeVoz ? [nomeVoz] : [])].filter((w) => !dele.has(w));
        const pediuParar = ws.some((w) => pararCom.includes(w));
        const novas = ws.filter((w) => w.length > 2 && !dele.has(w));
        const frase = final && novas.length >= 4 && novas.length / ws.length >= 0.75;
        const confirmou = final && ws.length <= 3 && !dele.has(ws[0]) && (cartaoRef.current?.pending || []).some((p) => p.estado === 'PENDENTE') && SIM.test(txt.trim());
        if (pediuParar || frase || confirmou) { ativo = false; interrompidoRef.current = frase || confirmou ? txt.trim() : ''; /* "pare"/"espera" sozinho: só cala e escuta */ cortouRef.current = true; try { rec.abort(); } catch { /* */ } calar(); }
      };
      rec.onend = () => { if (ativo) { try { rec.start(); } catch { /* */ } } };
      rec.onerror = () => { /* sem microfone livre: segue sem interromper */ };
      rec.start();
    } catch { return () => {}; }
    return () => { ativo = false; try { rec.abort(); } catch { /* */ } };
  }
  function calar() {
    try { audioRef.current?.pause(); } catch { /* */ }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
  }
  /** Fabio 29/10: "não entende o número que eu falo". 1) Fala de número costuma ter pausa (CEP, CPF, telefone): o reconhecimento agora espera 1,8 s de silêncio DEPOIS de você falar
   *  (antes cortava na 1ª pausa e mandava metade do número). 2) Dígito falado vira número: "zero quatro sete sete sete" → "04777" (só em sequência de 3+, pra não mexer em "um cliente"). */
  function escutar(): Promise<string> {
    return new Promise((resolve) => {
      const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (!SR) { resolve(''); return; }
      const rec = new SR(); rec.lang = 'pt-BR'; rec.interimResults = true; rec.continuous = true; rec.maxAlternatives = 1;
      recRef.current = rec;
      let finais = '', parcial = '', falhou = false, acabou = false, entregue = false;
      let calado: ReturnType<typeof setTimeout> | null = null;
      // Fabio 30/10: "trava quando não estou falando nada" — às vezes o Chrome não dispara o onend depois do stop(); sem resposta em 1,5 s, entrega assim mesmo.
      const entrega = () => { if (entregue) return; entregue = true; clearTimeout(semFala); clearTimeout(teto); if (calado) clearTimeout(calado); resolve(falhou ? FALHA_MIC : numerosFalados(`${finais} ${parcial}`.replace(/\s+/g, ' ').trim())); };
      const encerra = () => { if (acabou) return; acabou = true; if (calado) clearTimeout(calado); try { rec.stop(); } catch { /* */ } setTimeout(() => { try { rec.abort(); } catch { /* */ } entrega(); }, 1500); };
      const semFala = setTimeout(() => { if (!finais && !parcial) encerra(); }, 10000); // ninguém falou: conta como silêncio
      const teto = setTimeout(encerra, 60000); // fala sem fim (barulho contínuo): fecha o que ouviu
      rec.onresult = (e: any) => {
        finais = ''; parcial = '';
        for (let i = 0; i < e.results.length; i++) { const t = String(e.results[i][0]?.transcript || ''); if (e.results[i].isFinal) finais += ` ${t}`; else parcial += ` ${t}`; }
        if (calado) clearTimeout(calado);
        calado = setTimeout(encerra, 1800);
      };
      rec.onend = () => entrega();
      // 'no-speech' = silêncio de verdade; outro erro ('aborted', microfone ainda preso pelo vigia da interrupção) NÃO conta como silêncio — o loop tenta de novo (Fabio 29/10: "parava sem eu falar nada").
      rec.onerror = (ev: any) => { if (ev?.error !== 'no-speech' && ev?.error !== 'aborted') falhou = true; };
      setVoz('ouvindo');
      try { rec.start(); } catch { falhou = true; entrega(); }
    });
  }

  // ── conversa com o Claude ──
  function lembra(m: Msg) { msgsRef.current = [...msgsRef.current, m].slice(-20); save(msgsRef.current); }
  // "Um instante" na mesma voz, quando a resposta demora (o áudio é baixado uma vez e reaproveitado).
  const aguardeRef = useRef<string | null>(null);
  async function avisaQueEstaVendo() {
    try {
      if (!aguardeRef.current) {
        const r = await api.post('/api/assistant/tts', { text: 'Um instante, já vejo.', voiceId: vozIdRef.current || undefined }, { responseType: 'blob' });
        aguardeRef.current = URL.createObjectURL(r.data as Blob);
      }
      const a = new Audio(aguardeRef.current); audioRef.current = a;
      await a.play();
    } catch { /* sem aviso, segue pensando */ }
  }
  /** texto = veio do chat digitado: resposta completa (voice false), sem voz e sem mexer na bolinha. exibir/arquivos = o que aparece no histórico (sem o marcador dos arquivos). */
  async function perguntar(content: string, o: { texto?: boolean; exibir?: string; arquivos?: string[] } = {}): Promise<Cartao> {
    lembra({ role: 'user', content });
    addItem({ role: 'user', texto: o.exibir ?? content, ...(o.arquivos?.length ? { arquivos: o.arquivos } : {}) });
    if (o.texto) setPensandoTexto(true); else setVoz('pensando');
    const demora = o.texto ? null : setTimeout(() => { if (vozRef.current) void avisaQueEstaVendo(); }, 2500);
    try {
      const { data } = await api.post('/api/assistant/chat', { voice: !o.texto, messages: msgsRef.current }).finally(() => { if (demora) clearTimeout(demora); });
      const fala = String(data.reply || '').trim() || 'Não consegui responder agora.';
      lembra({ role: 'assistant', content: fala });
      const c: Cartao = { disse: content, fala, pending: data.pending?.length ? data.pending.map((p: Pending) => ({ ...p, estado: 'PENDENTE' })) : undefined, attachments: data.attachments?.length ? data.attachments : undefined, nav: data.navigate || null, audio: data.audio || null, copiar: data.copiar?.length ? data.copiar : undefined, escolherVoz: data.escolherVoz === true || undefined };
      setCard(c);
      addItem({ role: 'assistant', texto: fala, pending: c.pending, attachments: c.attachments, nav: c.nav, audio: c.audio, copiar: c.copiar, escolherVoz: c.escolherVoz });
      if (c.nav?.path) router.push(c.nav.path);
      return c;
    } catch (err: any) {
      const c: Cartao = { disse: content, fala: err?.response?.data?.error || 'Não consegui responder agora. Tenta de novo.' };
      setCard(c);
      addItem({ role: 'assistant', texto: c.fala || '', erro: true });
      return c;
    } finally { if (o.texto) setPensandoTexto(false); }
  }

  /** Mensagem digitada no chat. Arquivos sobem antes (ficam no servidor até a pessoa confirmar pra onde vão) e a mensagem leva o marcador com os ids. */
  async function enviarTexto(texto: string, arquivos: File[]): Promise<boolean> {
    const t = texto.trim().toLowerCase().replace(/[.!]+$/, '').trim();
    const pend = itensRef.current.flatMap((it) => (Date.now() - it.at < 30 * 60_000 ? it.pending || [] : [])).filter((x) => x.estado === 'PENDENTE');
    if (!arquivos.length && pend.length && (SIM_TXT.test(t) || QUAL_TXT.test(t) || NAO_TXT.test(t))) {
      addItem({ role: 'user', texto: texto.trim() });
      if (NAO_TXT.test(t)) { pend.forEach((x) => cancelar(x.id)); addItem({ role: 'assistant', texto: pend.length > 1 ? 'Cancelei as ações que estavam esperando.' : 'Cancelado.' }); return true; }
      const q = QUAL_TXT.exec(t);
      let alvo = pend;
      if (q && !/^(todas|todos|tudo|as duas|os dois|ambas|ambos)$/.test(q[1])) {
        const idx = /^(primeir|1)/.test(q[1]) ? 0 : /^(segund|2)/.test(q[1]) ? 1 : 2;
        if (!pend[idx]) { addItem({ role: 'assistant', texto: 'Não achei essa. Clique em Confirmar no cartão certo.' }); return true; }
        alvo = [pend[idx]];
      } else if (!q && pend.length > 1) {
        addItem({ role: 'assistant', texto: `Tem ${pend.length} ações esperando:\n${pend.map((x, i) => `${i + 1}. ${x.descricao.split(/[.\n]/)[0]}`).join('\n')}\nQual eu confirmo? Escreva "a primeira", "a segunda" ou "todas" — ou clique em Confirmar no cartão.` });
        return true;
      }
      for (const x of alvo) await confirmar(x.id);
      return true;
    }
    const subidos: { id: string; nome: string }[] = [];
    try {
      for (const f of arquivos) {
        const a = await prepararArquivo(f);
        const { data } = await api.post('/api/assistant/upload', a);
        subidos.push({ id: data.id, nome: data.nome });
      }
    } catch (err: any) { toast(err?.response?.data?.error || 'Não consegui subir o arquivo', 'error'); return false; }
    const marcador = subidos.length ? `[Arquivos anexados no chat: ${subidos.map((x) => `${x.nome} (arquivoId: ${x.id})`).join('; ')}]` : '';
    void perguntar([texto.trim(), marcador].filter(Boolean).join('\n\n'), { texto: true, exibir: texto.trim(), arquivos: subidos.map((x) => x.nome) });
    return true;
  }

  function atualizaPendente(id: string, patch: Partial<Pending>) {
    const c = cartaoRef.current;
    if (c?.pending) setCard({ ...c, pending: c.pending.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
    setItens((a) => a.map((it) => (it.pending?.some((p) => p.id === id) ? { ...it, pending: it.pending.map((p) => (p.id === id ? { ...p, ...patch } : p)) } : it)));
  }
  async function confirmar(id: string): Promise<string> {
    atualizaPendente(id, { estado: 'FEITO', resultado: 'Fazendo…' });
    try {
      const { data } = await api.post(`/api/assistant/confirm/${id}`);
      atualizaPendente(id, { estado: 'FEITO', resultado: data.resultado || 'Feito.', nav: data.nav || null });
      lembra({ role: 'assistant', content: `(feito: ${data.resultado || 'ok'})` });
      if (data.call?.leadId) await discar(data.call.leadId, data.call.leadName);
      return data.resultado || 'Feito.';
    } catch (err: any) {
      const e = err?.response?.data?.error || 'Não consegui fazer.';
      atualizaPendente(id, { estado: 'ERRO', resultado: e });
      return `Não deu: ${e}`;
    }
  }
  function cancelar(id: string) {
    atualizaPendente(id, { estado: 'CANCELADO', resultado: 'Cancelado.' });
    lembra({ role: 'assistant', content: '(ação cancelada pela pessoa)' });
    api.post(`/api/assistant/cancel/${id}`).catch(() => {});
  }
  // Ligação confirmada: o colaborador fala; a bolinha só disca (mesmo fluxo do botão Ligar) e para de ouvir pra não disputar o microfone.
  async function discar(leadId: string, leadName: string) {
    parar();
    router.push(`/inbox?leadId=${leadId}`);
    const call = useOutboundCallStore.getState();
    if (call.stage !== 'idle') { toast('Já tem uma ligação em andamento', 'warning'); return; }
    await call.checkAndCall(leadId, leadName);
    if (useOutboundCallStore.getState().stage === 'confirm') await useOutboundCallStore.getState().confirmCall();
  }

  function parar() {
    vozRef.current = false; setVoz('off'); calar(); marcaAtivo(false);
    try { recRef.current?.abort?.(); } catch { /* */ }
  }
  function escolherVoz(v: Voice) {
    vozIdRef.current = v.id; setVozNome(v.nome);
    try { localStorage.setItem(VOZ_KEY, v.id); localStorage.setItem(`${VOZ_KEY}_nome`, v.nome); } catch { /* */ }
    if (aguardeRef.current) { URL.revokeObjectURL(aguardeRef.current); aguardeRef.current = null; } // o "um instante" é refeito na voz nova
    setCard(null);
    void conversar();
  }
  async function conversar() {
    if (vozRef.current) { parar(); return; }
    // 1ª vez neste navegador: cada colaborador escolhe a voz antes de conversar.
    if (!vozIdRef.current) { pedeVoz(); return; }
    const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { toast('Este navegador não reconhece fala (use o Chrome ou o Safari)', 'error'); return; }
    vozRef.current = true;
    marcaAtivo(true);
    const pulso = setInterval(() => { if (vozRef.current) marcaAtivo(true); else clearInterval(pulso); }, 5000);
    if (!precisaClique) setCard(null);
    const inicial = partidaRef.current; partidaRef.current = '';
    if (retomarRef.current) { retomarRef.current = false; setCard({ fala: 'Voltei — a tela recarregou. Pode falar.' }); }
    else if (!inicial) await falar(primeiroNome ? `Oi, ${primeiroNome}.` : 'Oi.');
    let primeira = inicial;
    let silencios = 0;
    let falhasMic = 0;
    while (vozRef.current) {
      const parcial = interrompidoRef.current; interrompidoRef.current = '';
      // se interrompeu, ainda pega o resto da frase (no máx. 2 s: o que ela já ouviu vale como pedido)
      const mais = primeira ? '' : parcial ? await Promise.race([escutar(), new Promise<string>((r) => setTimeout(() => { try { recRef.current?.stop(); } catch { /* */ } r(''); }, 2000))]) : await escutar();
      if (mais === FALHA_MIC && !primeira && !parcial) {
        if (++falhasMic > 6) { toast('O microfone parou de responder — toque na bolinha pra recomeçar', 'warning'); break; }
        await new Promise((r) => setTimeout(r, 400 * falhasMic)); continue;
      }
      falhasMic = 0;
      const dito = primeira || [parcial, mais === FALHA_MIC ? '' : mais].filter(Boolean).join(' ').trim();
      primeira = '';
      if (!vozRef.current) break;
      // Silêncio não encerra de cara (Fabio 30/10: na revisão ele fica olhando a tela): segue ouvindo ~1 min; aí avisa que parou, pra não parecer travada.
      if (!dito) { if (++silencios >= 6) { setCard(null); await falar('Vou ficar quieta. É só tocar na bolinha.'); break; } continue; }
      silencios = 0;
      if (PARAR.test(dito.trim())) { setCard(null); await falar('Até já.'); break; }
      if (/^(trocar|mudar|muda|troca)\s+(a\s+|de\s+)?voz/i.test(dito.trim())) { pedeVoz(); await falar(chatAbertoRef.current ? 'Escolha a voz nova aqui no chat.' : 'Escolha a voz nova aqui no balão.'); break; }
      const pend = (cartaoRef.current?.pending || []).filter((p) => p.estado === 'PENDENTE');
      // Mais de uma ação esperando: "sim" sozinho NÃO confirma todas (Fabio 29/10: pediu a mensagem ao cliente e saiu também o pedido da certidão). Pergunta qual.
      const ORD = /\b(primeir[ao]|1|um|segund[ao]|2|dois|terceir[ao]|3|tr[eê]s)\b/i;
      if (pend.length > 1 && (SIM.test(dito.trim()) || ORD.test(dito)) && !/\b(todas|todos|tudo|as duas|os dois|ambas|ambos)\b/i.test(dito)) {
        const m = ORD.exec(dito);
        if (!m) { await falar(`Tem ${pend.length} ações esperando: ${pend.map((p, i) => `${i + 1}, ${p.descricao.split(/[.\n]/)[0]}`).join('; ')}. Qual eu confirmo? Diga a primeira, a segunda ou todas.`); continue; }
        const w = m[1].toLowerCase();
        const idx = /^(primeir|1|um)/.test(w) ? 0 : /^(segund|2|dois)/.test(w) ? 1 : 2;
        const alvo = pend[idx];
        if (!alvo) { await falar('Não achei essa. Diga a primeira ou a segunda.'); continue; }
        setVoz('pensando');
        const r = await confirmar(alvo.id);
        if (!vozRef.current) break;
        await falar(r);
        continue;
      }
      if (pend.length && SIM.test(dito.trim())) {
        setCard({ ...cartaoRef.current, disse: dito });
        setVoz('pensando');
        const res: string[] = [];
        for (const p of pend) res.push(await confirmar(p.id));
        if (!vozRef.current) break;
        await falar(res.join(' '));
        continue;
      }
      if (pend.length && NAO.test(dito.trim())) {
        pend.forEach((p) => cancelar(p.id));
        await falar('Cancelado.');
        continue;
      }
      setCard({ disse: dito });
      const c = await perguntar(dito);
      if (!vozRef.current) break;
      const pendNovas = (c.pending || []).filter((p) => p.estado === 'PENDENTE');
      if (pendNovas.length === 1 && JA_CONFIRMOU.test(dito)) {
        setVoz('pensando');
        const r = await confirmar(pendNovas[0].id);
        if (!vozRef.current) break;
        await falar(r);
        continue;
      }
      if (c.audio) { await falar(c.fala || 'Pode gravar.'); break; } // gravador aberto: solta o microfone pra gravação
      if (c.escolherVoz) { await falar(c.fala || 'Escolha a voz aqui no balão.'); break; } // lista de vozes aberta: solta o microfone pra pessoa ouvir as amostras
      if (c.fala) await falar(c.fala);
    }
    parar();
  }
  useEffect(() => () => { vozRef.current = false; calar(); }, []);
  // Página recarregou no meio da conversa (até 90 s atrás): retoma ouvindo, sem o "oi" de novo; o histórico já está no localStorage.
  const retomarRef = useRef(false);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    try {
      const at = Number(sessionStorage.getItem(ATIVO_KEY) || 0);
      if (at && Date.now() - at < 90_000) t = setTimeout(() => { if (!vozRef.current && vozIdRef.current) { retomarRef.current = true; void conversar(); } else marcaAtivo(false); }, 800);
      else marcaAtivo(false);
    } catch { /* */ }
    return () => { if (t) clearTimeout(t); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!chamarPorNome || !vozNome || voz !== 'off') return;
    const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    const nome = vozNome.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean)[0];
    if (!nome) return;
    let vivo = true;
    let rec: any;
    const iniciar = () => {
      if (!vivo || document.visibilityState !== 'visible') return;
      try {
        rec = new SR(); rec.lang = 'pt-BR'; rec.continuous = true; rec.interimResults = true;
        rec.onresult = (e: any) => {
          if (!vivo) return;
          let txt = '';
          for (let i = e.resultIndex; i < e.results.length; i++) txt += `${e.results[i][0].transcript} `;
          const ws = txt.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
          const i = ws.indexOf(nome);
          if (i < 0) return;
          vivo = false; try { rec.abort(); } catch { /* */ }
          partidaRef.current = ws.slice(i + 1).join(' '); // "Nina, abre o card do Pedro": o resto já vale como pedido
          void conversar();
        };
        rec.onend = () => { if (vivo) setTimeout(iniciar, 400); };
        rec.onerror = () => { /* microfone ocupado/negado: tenta de novo no onend */ };
        rec.start();
      } catch { /* */ }
    };
    iniciar();
    return () => { vivo = false; try { rec?.abort(); } catch { /* */ } };
  }, [chamarPorNome, vozNome, voz]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── lembretes: na hora, a bolinha fala (além do push) ──
  useEffect(() => {
    let vivo = true;
    const tick = async () => {
      try {
        const { data } = await api.get('/api/assistant/reminders/due');
        if (!vivo || !Array.isArray(data)) return;
        const ja = new Set(spokenIds());
        for (const r of data as { id: string; titulo: string; leadId: string | null; cliente: string | null }[]) {
          if (ja.has(r.id)) continue;
          markSpoken(r.id);
          const lembrete: Cartao = { fala: `⏰ Lembrete: ${r.titulo}${r.cliente ? ` (${r.cliente})` : ''}.`, nav: r.leadId ? { path: `/inbox?leadId=${r.leadId}`, label: `Conversa do ${r.cliente}` } : null };
          setCard(lembrete);
          addItem({ role: 'assistant', texto: lembrete.fala || '', nav: lembrete.nav });
          if (!vozRef.current) await falar(`${primeiroNome ? `${primeiroNome}, ` : ''}lembrete: ${r.titulo}.`);
        }
      } catch { /* sem rede: tenta no próximo */ }
    };
    tick();
    const t = setInterval(tick, 30_000);
    return () => { vivo = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primeiroNome]);

  if (!pos) return null;
  const escondeCelular = pathname.startsWith('/inbox') && !conversando && !cartao;
  const status = voz === 'ouvindo' ? 'Ouvindo…' : voz === 'pensando' ? 'Pensando…' : '';
  // balão ao lado da bolinha: em cima se houver espaço, senão embaixo; sempre dentro da tela
  const W = 300;
  const bx = Math.min(Math.max(pos.x + ORB / 2 - W / 2, 8), window.innerWidth - W - 8);
  const acima = pos.y > 300;
  const anda = mouseEm ? 'none' : `left ${MOVE_MS}ms ease-in-out, top ${MOVE_MS}ms ease-in-out, bottom ${MOVE_MS}ms ease-in-out`;
  const orbVoz: Voz = voz !== 'off' ? voz : pensandoTexto ? 'pensando' : 'off';
  const tocarBolinha = () => {
    // Falando: o toque só corta a fala e ela passa a ouvir (Fabio 30/10: "não consigo interromper quando fala demais"). Ouvindo/pensando: o toque encerra.
    if (vozRef.current && voz === 'falando') { cortouRef.current = true; interrompidoRef.current = ''; calar(); return; }
    void conversar();
  };

  return (
    <>
      {chatAberto && (
        <JarvisChat
          itens={itens}
          pensando={pensandoTexto}
          status={voz === 'ouvindo' ? 'Ouvindo…' : voz === 'pensando' ? 'Pensando…' : voz === 'falando' ? 'Falando… (toque na bolinha pra cortar)' : ''}
          orb={<Orb3D voz={orbVoz} />}
          vozLigada={conversando}
          vozAtual={vozIdRef.current}
          primeiroNome={primeiroNome}
          onEnviar={enviarTexto}
          onConfirmar={(id) => { void confirmar(id); }}
          onCancelar={cancelar}
          onAbrir={(path) => { router.push(path); if (window.innerWidth < 768) setChatAberto(false); }}
          onMic={tocarBolinha}
          onFechar={() => setChatAberto(false)}
          onLimpar={limparChat}
          onAudioFeito={(itemId, msg) => { setItens((a) => a.map((it) => (it.id === itemId ? { ...it, audio: null } : it))); addItem({ role: 'assistant', texto: msg }); }}
          onEscolherVoz={(v) => { setItens((a) => a.map((it) => (it.escolherVoz ? { ...it, escolherVoz: false } : it))); escolherVoz(v); }}
        />
      )}
      {!chatAberto && (
        <button
          onClick={() => setChatAberto(true)}
          className={cn('fixed z-[51] flex h-7 w-7 items-center justify-center rounded-full border border-slate-200 bg-white text-[#2261a8] shadow-md hover:bg-slate-50', escondeCelular && 'hidden md:flex')}
          style={{ left: pos.x - 14, top: pos.y - 14, transition: anda }}
          onMouseEnter={segura}
          onMouseLeave={solta}
          title="Abrir o chat do Jarvis (escrever, anexar documento)"
          aria-label="Chat do Jarvis"
        >
          <MessageSquare size={14} />
        </button>
      )}
      {(cartao || status) && !chatAberto && (
        <div
          className="fixed z-50 w-[300px] max-w-[calc(100vw-1rem)] rounded-2xl border border-slate-200 bg-white/95 backdrop-blur shadow-xl p-3 text-sm text-slate-800"
          style={{ left: bx, ...(acima ? { bottom: window.innerHeight - pos.y + 12 } : { top: pos.y + ORB + 12 }), transition: anda }}
          onMouseEnter={segura}
          onMouseLeave={solta}
        >
          <button onClick={() => setCard(null)} className="absolute right-2 top-2 text-slate-400 hover:text-slate-600" title="Fechar"><X size={14} /></button>
          {cartao?.disse && <p className="pr-5 text-xs italic text-slate-500">“{cartao.disse}”</p>}
          {status && <p className="mt-0.5 text-xs font-medium text-sky-600">{status}</p>}
          {cartao?.fala && <p className="mt-1 pr-4 leading-snug whitespace-pre-wrap max-h-48 overflow-y-auto">{cartao.fala}</p>}
          {cartao?.attachments?.map((a) => (a.type === 'document' ? <DocumentCard key={`${a.source}:${a.ref}`} a={a} /> : <SimulationCard key={a.id} a={a} />))}
          {cartao?.copiar?.map((c, i) => <CopyCard key={i} c={c} />)}
          {cartao?.escolherVoz && <VoicePicker atual={vozIdRef.current} primeiroNome={primeiroNome} onPick={escolherVoz} />}
          {cartao?.audio && <RecorderCard req={cartao.audio} onDone={(m) => setCard({ fala: m })} />}
          {cartao?.pending?.map((p) => (
            <div key={p.id} className={cn('mt-2 rounded-lg border p-2 text-xs', p.estado === 'PENDENTE' ? 'border-amber-300 bg-amber-50' : p.estado === 'ERRO' ? 'border-red-200 bg-red-50' : 'border-slate-200 bg-slate-50')}>
              <div className="text-slate-700 whitespace-pre-wrap max-h-40 overflow-y-auto">{p.descricao}</div>
              {p.estado === 'PENDENTE' ? (
                <div className="mt-1.5 flex gap-1.5">
                  <button onClick={async () => { const r = await confirmar(p.id); if (!vozRef.current) setCard({ ...cartaoRef.current, fala: r }); }} className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 font-medium text-white hover:brightness-110"><Check size={12} /> Confirmar</button>
                  <button onClick={() => cancelar(p.id)} className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-slate-600 hover:bg-slate-100"><Ban size={12} /> Cancelar</button>
                </div>
              ) : (
                <div className={cn('mt-1 font-medium', p.estado === 'ERRO' ? 'text-red-600' : p.estado === 'CANCELADO' ? 'text-slate-500' : 'text-emerald-700')}>{p.resultado}</div>
              )}
              {p.nav?.path && <button onClick={() => router.push(p.nav!.path)} className="mt-1 flex items-center gap-1 font-medium text-[#2261a8] hover:underline"><ExternalLink size={11} /> {p.nav.label}</button>}
            </div>
          ))}
          {cartao?.nav?.path && <button onClick={() => router.push(cartao.nav!.path)} className="mt-1.5 flex items-center gap-1 text-xs font-medium text-[#2261a8] hover:underline"><ExternalLink size={12} /> {cartao.nav.label}</button>}
          {!cartao?.escolherVoz && vozNome && <button onClick={() => { if (vozRef.current) parar(); setCard({ escolherVoz: true }); }} className="mt-2 flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-600"><Volume2 size={11} /> Voz: {vozNome} · trocar</button>}
          {!cartao?.escolherVoz && vozNome && <button onClick={alternaChamarPorNome} className="mt-1 flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-600"><Volume2 size={11} /> Chamar dizendo "{vozNome}": {chamarPorNome ? 'ligado' : 'desligado'}</button>}
        </div>
      )}

      <button
        ref={orbRef}
        onClick={() => {
          if (pressRef.current.abriu) { pressRef.current.abriu = false; return; }
          tocarBolinha();
        }}
        onTouchStart={() => { pressRef.current.abriu = false; pressRef.current.t = setTimeout(() => { pressRef.current.abriu = true; if (vozRef.current) parar(); setCard({ escolherVoz: true }); }, 650); }}
        onTouchEnd={() => { if (pressRef.current.t) clearTimeout(pressRef.current.t); }}
        onMouseEnter={segura}
        onMouseLeave={solta}
        // Botão direito (ou segurar o dedo no celular) abre a lista de vozes (Fabio 29/10: "colocar a opção de escolher vozes").
        onContextMenu={(e) => { e.preventDefault(); if (vozRef.current) parar(); setCard({ escolherVoz: true }); }}
        className={cn('fixed z-50 rounded-full focus:outline-none', escondeCelular && 'hidden md:block', chatAberto && '!hidden')}
        style={{ left: pos.x, top: pos.y, width: ORB, height: ORB, transition: anda }}
        aria-label="Assistente do CRM"
        title={voz === 'falando' ? 'Falando — toque pra cortar e falar' : conversando ? 'Conversando — toque pra encerrar' : 'Assistente do CRM — toque e fale (botão direito ou segurar: escolher a voz)'}
      >
        <Orb3D voz={orbVoz} />
      </button>
    </>
  );
}
