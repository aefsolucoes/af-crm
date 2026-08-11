'use client';
import { useEffect, useState } from 'react';
import { MessageAttachment } from '@/types';
import api from '@/lib/api';
import { FileText, Download, Loader2, ImageOff, Cloud } from 'lucide-react';

export function AttachmentView({ att }: { att: MessageAttachment }) {
  const isImage = att.mimeType.startsWith('image/');
  const isAudio = att.mimeType.startsWith('audio/');
  const isVideo = att.mimeType.startsWith('video/');
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'error' | 'drive'>('idle');

  // Imagem/áudio/vídeo carregam automaticamente (viram player); documentos só ao clicar em baixar.
  useEffect(() => {
    if (!isImage && !isAudio && !isVideo) return;
    let revoked = false;
    let objUrl: string | null = null;
    setState('loading');
    api.get(`/api/messages/attachment/${att.id}`, { responseType: 'blob' })
      .then((res) => {
        if (revoked) return;
        objUrl = URL.createObjectURL(res.data);
        setUrl(objUrl);
        setState('idle');
      })
      .catch((err) => {
        setState(err?.response?.status === 410 ? 'drive' : 'error');
      });
    return () => { revoked = true; if (objUrl) URL.revokeObjectURL(objUrl); };
  }, [att.id, isImage, isAudio, isVideo]);

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

  // Documento (pdf, pfx, etc.) → botão de baixar
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
