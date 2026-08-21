'use client';
import { useEffect, useRef, useState } from 'react';
import { MessageAttachment } from '@/types';
import api from '@/lib/api';
import { FileText, Download, Loader2, ImageOff, Cloud, Play, Pause } from 'lucide-react';

function formatAudioTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Player mínimo — só play/pausa, barra de progresso e tempo — no lugar do
 *  `<audio controls>` nativo do navegador, que trazia junto controle de
 *  volume, menu de velocidade (1x/1,5x/2x) e "baixar" (visível em alguns
 *  navegadores/SOs), nada disso existe na bolha de áudio de verdade do
 *  WhatsApp. Clique na barra pula pra posição; sem arrastar por enquanto. */
function AudioPlayer({ url }: { url: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => setCurrentTime(audio.currentTime);
    const onLoaded = () => setDuration(audio.duration || 0);
    const onEnd = () => { setPlaying(false); setCurrentTime(0); };
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('loadedmetadata', onLoaded);
    audio.addEventListener('ended', onEnd);
    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('loadedmetadata', onLoaded);
      audio.removeEventListener('ended', onEnd);
    };
  }, []);

  function toggle() {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) audio.pause();
    else audio.play().catch(() => {});
    setPlaying(!playing);
  }

  function seek(e: React.MouseEvent<HTMLDivElement>) {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    audio.currentTime = ratio * duration;
    setCurrentTime(audio.currentTime);
  }

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
  const showElapsed = playing || currentTime > 0;

  return (
    <div className="flex items-center gap-2.5" style={{ minWidth: 220 }}>
      <audio ref={audioRef} src={url} preload="metadata" className="hidden" />
      <button
        type="button"
        onClick={toggle}
        className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-colors hover:brightness-110"
        style={{ backgroundColor: 'rgba(255,255,255,0.12)' }}
      >
        {playing
          ? <Pause size={14} className="text-[#e9edef]" fill="currentColor" />
          : <Play size={14} className="text-[#e9edef] ml-0.5" fill="currentColor" />}
      </button>
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <div onClick={seek} className="relative h-1 rounded-full cursor-pointer" style={{ backgroundColor: 'rgba(255,255,255,0.2)' }}>
          <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${progress}%`, backgroundColor: '#00a884' }} />
        </div>
        <span className="text-[11px] text-[#e9edef]/60">{formatAudioTime(showElapsed ? currentTime : duration)}</span>
      </div>
    </div>
  );
}

// Miniatura da 1ª página do PDF, gerada no navegador (evita depender de
// renderização com canvas nativo no backend — mais frágil de manter no
// Railway). O worker vem de public/pdf.worker.min.mjs (copiado do próprio
// pacote instalado, versão travada em package.json para não desalinhar).
let pdfWorkerConfigured = false;
async function renderPdfFirstPageThumbnail(bytes: ArrayBuffer, targetWidth = 220): Promise<string> {
  const pdfjsLib = await import('pdfjs-dist');
  if (!pdfWorkerConfigured) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
    pdfWorkerConfigured = true;
  }
  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  const page = await pdf.getPage(1);
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = targetWidth / baseViewport.width;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d indisponível');
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas.toDataURL('image/jpeg', 0.82);
}

export function AttachmentView({ att }: { att: MessageAttachment }) {
  const isImage = att.mimeType.startsWith('image/');
  const isAudio = att.mimeType.startsWith('audio/');
  const isVideo = att.mimeType.startsWith('video/');
  const isPdf = att.mimeType === 'application/pdf';
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'error' | 'drive'>('idle');
  // Miniatura da 1ª página (só para PDF) — separado de `url`/`state` porque o
  // PDF em si (bytes originais) continua disponível pra abrir/baixar mesmo se
  // a miniatura falhar em renderizar (PDF corrompido, protegido por senha etc).
  const [pdfThumb, setPdfThumb] = useState<string | null>(null);
  const [pdfThumbFailed, setPdfThumbFailed] = useState(false);

  // Imagem/áudio/vídeo/PDF carregam automaticamente (viram player/miniatura);
  // outros documentos só ao clicar em baixar.
  useEffect(() => {
    if (!isImage && !isAudio && !isVideo && !isPdf) return;
    let revoked = false;
    let objUrl: string | null = null;
    setState('loading');
    api.get(`/api/messages/attachment/${att.id}`, { responseType: 'blob' })
      .then(async (res) => {
        if (revoked) return;
        objUrl = URL.createObjectURL(res.data);
        setUrl(objUrl);
        setState('idle');
        if (isPdf) {
          try {
            const bytes = await res.data.arrayBuffer();
            if (revoked) return;
            const dataUrl = await renderPdfFirstPageThumbnail(bytes);
            if (!revoked) setPdfThumb(dataUrl);
          } catch (err) {
            console.warn('[Anexo] Falha ao gerar miniatura do PDF:', err);
            if (!revoked) setPdfThumbFailed(true);
          }
        }
      })
      .catch((err) => {
        setState(err?.response?.status === 410 ? 'drive' : 'error');
      });
    return () => { revoked = true; if (objUrl) URL.revokeObjectURL(objUrl); };
  }, [att.id, isImage, isAudio, isVideo, isPdf]);

  async function download() {
    setState('loading');
    try {
      const res = await api.get(`/api/messages/attachment/${att.id}`, { responseType: 'blob' });
      const objUrl = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = att.fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objUrl);
      setState('idle');
    } catch (err: any) {
      setState(err?.response?.status === 410 ? 'drive' : 'error');
    }
  }

  if (isImage) {
    if (state === 'loading') {
      return <div className="flex items-center justify-center w-48 h-32 rounded-lg bg-black/5 text-slate-400"><Loader2 size={18} className="animate-spin" /></div>;
    }
    if (state === 'drive') {
      return <div className="flex items-center gap-1.5 text-xs text-slate-500 py-1"><Cloud size={13} /> Imagem salva no Google Drive</div>;
    }
    if (state === 'error' || !url) {
      return <div className="flex items-center gap-1.5 text-xs text-slate-400 py-1"><ImageOff size={13} /> Não foi possível carregar a imagem</div>;
    }
    return (
      <a href={url} target="_blank" rel="noreferrer" className="block">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={att.fileName} className="rounded-lg max-w-full max-h-64 object-cover" />
      </a>
    );
  }

  if (isAudio) {
    if (state === 'loading') {
      return <div className="flex items-center justify-center w-56 h-10 rounded-lg bg-black/5 text-slate-400"><Loader2 size={16} className="animate-spin" /></div>;
    }
    if (state === 'drive') {
      return <div className="flex items-center gap-1.5 text-xs text-slate-500 py-1"><Cloud size={13} /> Áudio salvo no Google Drive</div>;
    }
    if (state === 'error' || !url) {
      return <div className="flex items-center gap-1.5 text-xs text-slate-400 py-1"><ImageOff size={13} /> Não foi possível carregar o áudio</div>;
    }
    return <AudioPlayer url={url} />;
  }

  if (isVideo) {
    if (state === 'loading') {
      return <div className="flex items-center justify-center w-48 h-32 rounded-lg bg-black/5 text-slate-400"><Loader2 size={18} className="animate-spin" /></div>;
    }
    if (state === 'drive') {
      return <div className="flex items-center gap-1.5 text-xs text-slate-500 py-1"><Cloud size={13} /> Vídeo salvo no Google Drive</div>;
    }
    if (state === 'error' || !url) {
      return <div className="flex items-center gap-1.5 text-xs text-slate-400 py-1"><ImageOff size={13} /> Não foi possível carregar o vídeo</div>;
    }
    return <video controls src={url} className="rounded-lg max-w-full max-h-64" />;
  }

  // PDF: miniatura de verdade da 1ª página (como no WhatsApp) — clica pra abrir.
  if (isPdf) {
    if (state === 'drive') {
      return <div className="flex items-center gap-1.5 text-xs text-slate-500 py-1"><Cloud size={13} /> Documento salvo no Google Drive</div>;
    }
    if (state === 'error') {
      return <div className="flex items-center gap-1.5 text-xs text-slate-400 py-1"><ImageOff size={13} /> Não foi possível carregar o documento</div>;
    }
    // Miniatura ainda não pronta (carregando o PDF ou renderizando a página) —
    // mas se a renderização falhou (pdfThumbFailed), cai pro botão genérico
    // de baixar em vez de ficar girando pra sempre.
    if (!pdfThumbFailed && (state === 'loading' || !pdfThumb)) {
      return <div className="flex items-center justify-center w-40 h-52 rounded-lg bg-black/5 text-slate-400"><Loader2 size={18} className="animate-spin" /></div>;
    }
    if (pdfThumb) {
      return (
        <a
          href={url ?? undefined}
          target="_blank"
          rel="noreferrer"
          className="block w-40 rounded-lg overflow-hidden border border-black/10 bg-white shadow-sm hover:shadow-md transition-shadow"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={pdfThumb} alt={att.fileName} className="w-full h-auto block border-b border-black/5" />
          <div className="flex items-center gap-1.5 px-2 py-1.5">
            <FileText size={12} className="text-red-500 flex-shrink-0" />
            <span className="text-[11px] text-slate-700 truncate flex-1">{att.fileName}</span>
          </div>
        </a>
      );
    }
    // pdfThumbFailed && sem thumb: mesmo botão genérico de baixar de baixo.
  }

  // Documento (pdf sem miniatura, docx, xlsx etc.) → botão de baixar
  return (
    <button
      onClick={download}
      className="flex items-center gap-2 max-w-full text-left rounded-lg bg-black/5 hover:bg-black/10 transition-colors px-2.5 py-2"
    >
      <FileText size={18} className="text-slate-500 flex-shrink-0" />
      <span className="text-xs text-slate-700 truncate flex-1">{att.fileName}</span>
      {state === 'loading' ? <Loader2 size={14} className="animate-spin text-slate-400" />
        : state === 'drive' ? <Cloud size={14} className="text-slate-400" />
        : <Download size={14} className="text-slate-400 flex-shrink-0" />}
    </button>
  );
}
