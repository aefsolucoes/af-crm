'use client';
import { useEffect, useState } from 'react';
import { MessageAttachment } from '@/types';
import api from '@/lib/api';
import { FileText, Download, Loader2, ImageOff, Cloud } from 'lucide-react';

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
    return <audio controls src={url} className="max-w-full h-10" style={{ minWidth: 220 }} />;
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
