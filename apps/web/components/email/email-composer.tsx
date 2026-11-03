'use client';
import { useEffect, useRef, useState } from 'react';
import { Send, Loader2, Paperclip, X, Lightbulb, FolderOpen, ExternalLink, FileText, Eye, Sparkles, MessageSquare } from 'lucide-react';
import { AttachmentPreviewModal } from '@/components/inbox/message-attachment';
import { Modal } from '@/components/ui/modal';
import { toast } from '@/components/ui/toast';
import api from '@/lib/api';
import { signatureLineHtml } from '@/lib/signature-links';

// Mesmo limite do servidor (email-inbox.service.ts): cabe no ~25 MB do provedor.
const MAX_FILES = 10;
const MAX_TOTAL_BYTES = 15 * 1024 * 1024;

/** Anexo do computador (dataBase64), da pasta do cliente no Drive (driveFileId) ou da conversa do card (attachmentId) — o servidor baixa os dois últimos na hora de enviar. */
interface PickedFile { name: string; type: string; size: number; dataBase64?: string; driveFileId?: string; attachmentId?: string }
interface DriveFile { id: string; name: string; mimeType: string; path: string; size: number }
interface ConvFile { id: string; name: string; mimeType: string; createdAt: string; recebido: boolean }
/** Pra onde vai o arquivo escolhido: anexo do e-mail ou documento que a IA só LÊ pra montar o texto (Fabio 03/11). */
type Alvo = 'email' | 'ia';
const IA_TIPOS = /^(application\/pdf|image\/(jpeg|png|gif|webp|heic|heif))$/;

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function formatSize(bytes: number) {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Miniatura de um arquivo do Drive (gerada pelo próprio Drive; sem miniatura, o ícone). Clicar abre o arquivo inteiro. */
function DriveThumb({ file, onOpen }: { file: DriveFile; onOpen: () => void }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let vivo = true;
    api.get(`/api/email/drive-thumb/${file.id}`, { responseType: 'blob' })
      .then((r) => { if (!vivo) return; url = URL.createObjectURL(r.data); setSrc(url); })
      .catch(() => {});
    return () => { vivo = false; if (url) URL.revokeObjectURL(url); };
  }, [file.id]);
  return (
    <button type="button" onClick={(e) => { e.preventDefault(); onOpen(); }} title="Ver o arquivo" className="relative w-12 h-12 flex-shrink-0 rounded border border-af-border bg-white overflow-hidden flex items-center justify-center group">
      {src ? <img src={src} alt="" className="w-full h-full object-cover" /> : <FileText size={18} className="text-slate-300" />}
      <span className="absolute inset-0 hidden group-hover:flex items-center justify-center bg-black/40"><Eye size={14} className="text-white" /></span>
    </button>
  );
}

function Chip({ f, onRemove }: { f: PickedFile; onRemove: () => void }) {
  return (
    <span className="flex items-center gap-1.5 text-xs pl-2.5 pr-1.5 py-1 rounded-lg border border-af-border bg-white text-slate-600 max-w-[260px]">
      {f.attachmentId ? <MessageSquare size={11} className="flex-shrink-0 text-af-mid" /> : f.driveFileId ? <FolderOpen size={11} className="flex-shrink-0 text-af-mid" /> : <Paperclip size={11} className="flex-shrink-0" />}
      <span className="truncate">{f.name}</span>
      {f.size > 0 && <span className="text-slate-400 flex-shrink-0">{formatSize(f.size)}</span>}
      <button onClick={onRemove} className="text-slate-400 hover:text-red-500 flex-shrink-0" title="Tirar"><X size={12} /></button>
    </span>
  );
}

/** Miniatura de um arquivo da conversa (imagem: o próprio arquivo; PDF/outros: o ícone). Clicar abre o arquivo inteiro. */
function ConvThumb({ file, onOpen }: { file: ConvFile; onOpen: () => void }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!file.mimeType.startsWith('image/')) return;
    let url: string | null = null;
    let vivo = true;
    api.get(`/api/messages/attachment/${file.id}`, { responseType: 'blob' })
      .then((r) => { if (!vivo) return; url = URL.createObjectURL(r.data); setSrc(url); })
      .catch(() => {});
    return () => { vivo = false; if (url) URL.revokeObjectURL(url); };
  }, [file.id, file.mimeType]);
  return (
    <button type="button" onClick={(e) => { e.preventDefault(); onOpen(); }} title="Ver o arquivo" className="relative w-12 h-12 flex-shrink-0 rounded border border-af-border bg-white overflow-hidden flex items-center justify-center group">
      {src ? <img src={src} alt="" className="w-full h-full object-cover" /> : <FileText size={18} className="text-slate-300" />}
      <span className="absolute inset-0 hidden group-hover:flex items-center justify-center bg-black/40"><Eye size={14} className="text-white" /></span>
    </button>
  );
}

export interface MailboxOption {
  id: string;
  address: string;
  displayName: string | null;
  shared: boolean;
  /** Assinatura que vai no fim do e-mail (a da caixa ou a padrão). */
  signature?: string;
}

/**
 * Janela de escrever/responder e-mail — usada na página E-mail e no card do
 * cliente. Em resposta (replyToId), o servidor cita o e-mail original embaixo
 * e mantém o mesmo fio; com leadId, o enviado aparece na conversa do card.
 */
export function EmailComposer({
  mailboxes, defaultMailboxId, to = '', cc: initialCc = '', subject = '', body: initialBody = '', replyToId = null, leadId = null, draftId = null,
  onClose, onSent, onDeleteDraft,
}: {
  mailboxes: MailboxOption[];
  defaultMailboxId?: string;
  to?: string;
  cc?: string;
  subject?: string;
  body?: string;
  /** Continuando um rascunho: ao enviar ou salvar de novo, o antigo sai de Rascunhos. */
  draftId?: string | null;
  onDeleteDraft?: () => void;
  replyToId?: string | null;
  leadId?: string | null;
  onClose: () => void;
  onSent?: () => void;
}) {
  const [mailboxId, setMailboxId] = useState(defaultMailboxId || mailboxes.find((m) => !m.shared)?.id || mailboxes[0]?.id || '');
  const [toValue, setToValue] = useState(to);
  const [cc, setCc] = useState(initialCc);
  const [showCc, setShowCc] = useState(!!initialCc);
  const [subjectValue, setSubjectValue] = useState(subject);
  const [body, setBody] = useState(initialBody);
  const [savingDraft, setSavingDraft] = useState(false);
  const [sending, setSending] = useState(false);
  const [files, setFiles] = useState<PickedFile[]>([]);
  // "Criar com IA" (Fabio 03/11): a IA lê a conversa inteira do card + os documentos que a pessoa der pra ela LER e preenche Para/Assunto/Texto.
  // Com texto já escrito, o resultado vem como sugestão (a pessoa revisa e clica "Usar").
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [iaAberta, setIaAberta] = useState(false);
  const [iaPedido, setIaPedido] = useState('');
  const [iaDocs, setIaDocs] = useState<PickedFile[]>([]);
  const [criando, setCriando] = useState(false);
  const iaFileInput = useRef<HTMLInputElement>(null);
  // De qual dia da conversa sai o e-mail (Fabio 03/11: "deve ser a conversa da data atual ou sugerir uma data da conversa"): hoje, se teve conversa; senão o último dia com conversa.
  const [dias, setDias] = useState<{ date: string; count: number }[] | null>(null);
  const [diaConversa, setDiaConversa] = useState('');
  useEffect(() => {
    if (!iaAberta || !leadId || dias) return;
    api.get('/api/email/lead-conversation-days', { params: { leadId } })
      .then(({ data }) => { setDias(data || []); setDiaConversa((data || [])[0]?.date || ''); })
      .catch(() => setDias([]));
  }, [iaAberta, leadId, dias]);
  async function criarComIa() {
    setCriando(true);
    try {
      const { data } = await api.post('/api/email/compose-ai', {
        replyToId, leadId, instruction: iaPedido, to: toValue, subject: subjectValue, draft: body, conversationDate: diaConversa || undefined,
        docs: iaDocs.map((d) => (d.attachmentId ? { attachmentId: d.attachmentId, name: d.name } : d.driveFileId ? { driveFileId: d.driveFileId, name: d.name, type: d.type } : { name: d.name, type: d.type, dataBase64: d.dataBase64 })),
      });
      if (data.to && !toValue.trim()) setToValue(data.to);
      if (data.subject && !subjectValue.trim()) setSubjectValue(data.subject);
      if (body.trim()) setSuggestion(data.body); else setBody(data.body);
      if (data.pulados?.length) toast(`A IA não conseguiu ler: ${data.pulados.join(', ')} (só PDF e imagem)`, 'warning');
      setIaAberta(false);
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Não consegui montar o e-mail agora', 'error');
    } finally {
      setCriando(false);
    }
  }
  async function addIaFiles(list: FileList | null) {
    const picked = Array.from(list || []).filter((f) => IA_TIPOS.test(f.type));
    if (list?.length && picked.length < list.length) toast('A IA só lê PDF e imagem — os outros arquivos ficaram de fora', 'warning');
    if (!picked.length) return;
    if (iaDocs.length + picked.length > MAX_FILES) { toast(`No máximo ${MAX_FILES} documentos pra IA ler`, 'warning'); return; }
    try {
      const read = await Promise.all(picked.map(async (f) => ({ name: f.name, type: f.type, size: f.size, dataBase64: await readAsBase64(f) })));
      setIaDocs((prev) => [...prev, ...read]);
    } catch {
      toast('Não consegui ler o arquivo', 'error');
    }
  }
  const fileInput = useRef<HTMLInputElement>(null);
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  // "Do Drive do cliente" (Fabio 27/10): escolher documentos da pasta do cliente no Drive pra anexar.
  const [drive, setDrive] = useState<null | { alvo: Alvo; loading: boolean; folderUrl: string | null; files: DriveFile[]; error?: string }>(null);
  const [driveSel, setDriveSel] = useState<string[]>([]);
  const [driveBusca, setDriveBusca] = useState('');
  const [preview, setPreview] = useState<null | { url: string; name: string; isPdf: boolean }>(null);
  const [abrindo, setAbrindo] = useState<string | null>(null);
  async function verArquivo(f: DriveFile) {
    setAbrindo(f.id);
    try {
      const r = await api.get(`/api/email/drive-file/${f.id}`, { responseType: 'blob' });
      setPreview({ url: URL.createObjectURL(r.data), name: f.name, isPdf: f.mimeType === 'application/pdf' });
    } catch (err: any) {
      toast('Não consegui abrir o arquivo — use "abrir no Drive"', 'error');
    } finally { setAbrindo(null); }
  }
  function fecharPreview() { if (preview) URL.revokeObjectURL(preview.url); setPreview(null); }
  async function openDrive(alvo: Alvo) {
    if (!leadId) return;
    if (drive) { setDrive(null); if (drive.alvo === alvo) return; }
    setConversa(null);
    setDrive({ alvo, loading: true, folderUrl: null, files: [] });
    setDriveSel([]);
    try {
      const { data } = await api.get('/api/email/lead-drive-files', { params: { leadId } });
      setDrive({ alvo, loading: false, folderUrl: data.folderUrl || null, files: data.files || [] });
    } catch (err: any) {
      setDrive({ alvo, loading: false, folderUrl: null, files: [], error: err?.response?.data?.error || 'Não consegui abrir a pasta do cliente no Drive' });
    }
  }
  // Arquivos que chegaram/saíram na conversa do card (Fabio 03/11) — pra anexar no e-mail ou pra IA ler.
  const [conversa, setConversa] = useState<null | { alvo: Alvo; loading: boolean; files: ConvFile[]; error?: string }>(null);
  const [convSel, setConvSel] = useState<string[]>([]);
  async function openConversa(alvo: Alvo) {
    if (!leadId) return;
    if (conversa) { setConversa(null); if (conversa.alvo === alvo) return; }
    setDrive(null);
    setConversa({ alvo, loading: true, files: [] });
    setConvSel([]);
    try {
      const { data } = await api.get('/api/email/lead-conversation-files', { params: { leadId } });
      setConversa({ alvo, loading: false, files: (data || []).filter((f: ConvFile) => alvo === 'email' || IA_TIPOS.test(f.mimeType)) });
    } catch (err: any) {
      setConversa({ alvo, loading: false, files: [], error: err?.response?.data?.error || 'Não consegui buscar os arquivos da conversa' });
    }
  }
  async function verArquivoConversa(f: ConvFile) {
    setAbrindo(f.id);
    try {
      const r = await api.get(`/api/messages/attachment/${f.id}`, { responseType: 'blob' });
      setPreview({ url: URL.createObjectURL(r.data), name: f.name, isPdf: f.mimeType === 'application/pdf' });
    } catch {
      toast('Não consegui abrir o arquivo', 'error');
    } finally { setAbrindo(null); }
  }
  function addConversaFiles() {
    if (!conversa) return;
    const destino = conversa.alvo === 'ia' ? iaDocs : files;
    const escolhidos = conversa.files.filter((f) => convSel.includes(f.id) && !destino.some((x) => x.attachmentId === f.id));
    if (!escolhidos.length) { setConversa(null); return; }
    if (destino.length + escolhidos.length > MAX_FILES) { toast(`No máximo ${MAX_FILES} arquivos`, 'warning'); return; }
    const novos = escolhidos.map((f) => ({ name: f.name, type: f.mimeType, size: 0, attachmentId: f.id }));
    if (conversa.alvo === 'ia') setIaDocs((prev) => [...prev, ...novos]); else setFiles((prev) => [...prev, ...novos]);
    setConversa(null);
  }
  function addDriveFiles() {
    if (drive?.alvo === 'ia') {
      const novos = drive.files.filter((f) => driveSel.includes(f.id) && !iaDocs.some((x) => x.driveFileId === f.id));
      if (novos.some((f) => !IA_TIPOS.test(f.mimeType))) toast('A IA só lê PDF e imagem — os outros arquivos ficaram de fora', 'warning');
      const ok = novos.filter((f) => IA_TIPOS.test(f.mimeType));
      if (iaDocs.length + ok.length > MAX_FILES) { toast(`No máximo ${MAX_FILES} documentos pra IA ler`, 'warning'); return; }
      setIaDocs((prev) => [...prev, ...ok.map((f) => ({ name: f.name, type: f.mimeType, size: f.size || 0, driveFileId: f.id }))]);
      setDrive(null);
      return;
    }
    const escolhidos = (drive?.files || []).filter((f) => driveSel.includes(f.id) && !files.some((x) => x.driveFileId === f.id));
    if (!escolhidos.length) { setDrive(null); return; }
    if (files.length + escolhidos.length > MAX_FILES) { toast(`No máximo ${MAX_FILES} anexos por e-mail`, 'warning'); return; }
    if (totalBytes + escolhidos.reduce((t, f) => t + (f.size || 0), 0) > MAX_TOTAL_BYTES) { toast('Os anexos passam de 15 MB — mande em mais de um e-mail ou mande o link da pasta', 'warning'); return; }
    setFiles((prev) => [...prev, ...escolhidos.map((f) => ({ name: f.name, type: f.mimeType || 'application/octet-stream', size: f.size || 0, driveFileId: f.id }))]);
    setDrive(null);
  }

  async function addFiles(list: FileList | null) {
    if (!list?.length) return;
    const picked = Array.from(list);
    if (files.length + picked.length > MAX_FILES) { toast(`No máximo ${MAX_FILES} anexos por e-mail`, 'warning'); return; }
    const newTotal = totalBytes + picked.reduce((sum, f) => sum + f.size, 0);
    if (newTotal > MAX_TOTAL_BYTES) { toast('Os anexos passam de 15 MB — mande em mais de um e-mail ou use um link do Drive', 'warning'); return; }
    try {
      const read = await Promise.all(picked.map(async (f) => ({ name: f.name, type: f.type || 'application/octet-stream', size: f.size, dataBase64: await readAsBase64(f) })));
      setFiles((prev) => [...prev, ...read]);
    } catch {
      toast('Não consegui ler o arquivo', 'error');
    }
  }

  async function send() {
    if (!mailboxId) { toast('Nenhuma caixa de e-mail disponível', 'error'); return; }
    if (!toValue.trim() || !body.trim()) { toast('Preencha o destinatário e a mensagem', 'warning'); return; }
    setSending(true);
    try {
      await api.post(`/api/email/accounts/${mailboxId}/send`, {
        to: toValue, cc, subject: subjectValue, body, replyToId, leadId, draftId,
        attachments: files.map((f) => (f.attachmentId ? { filename: f.name, contentType: f.type, attachmentId: f.attachmentId } : f.driveFileId ? { filename: f.name, contentType: f.type, driveFileId: f.driveFileId } : { filename: f.name, contentType: f.type, dataBase64: f.dataBase64 })),
      });
      toast('E-mail enviado');
      onSent?.();
      onClose();
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Não consegui enviar o e-mail', 'error');
    } finally {
      setSending(false);
    }
  }

  async function saveDraft(closeAfter = true) {
    if (!mailboxId) return;
    setSavingDraft(true);
    try {
      await api.post(`/api/email/accounts/${mailboxId}/drafts`, { to: toValue, cc, subject: subjectValue, body, draftId, replyToId });
      toast('Rascunho salvo');
      onSent?.();
      if (closeAfter) onClose();
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Não consegui salvar o rascunho', 'error');
    } finally {
      setSavingDraft(false);
    }
  }

  // Fechar com texto escrito: pergunta se guarda como rascunho (não perde nada).
  function close() {
    const changed = body.trim() && (body !== initialBody || toValue !== to || subjectValue !== subject);
    if (changed && !sending && confirm('Salvar como rascunho antes de fechar?')) { saveDraft(true); return; }
    onClose();
  }

  const field = 'w-full text-sm px-3 py-2 border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent text-slate-800';

  return (
    <Modal title={draftId ? 'Rascunho' : replyToId ? 'Responder e-mail' : 'Novo e-mail'} onClose={close} onBackdropClick={() => {}} size="lg">
      <div className="space-y-2.5">
        <div className="flex items-center gap-2">
          <label className="w-14 text-xs text-slate-500 flex-shrink-0">De</label>
          <select value={mailboxId} onChange={(e) => setMailboxId(e.target.value)} className={field} disabled={!!replyToId}>
            {mailboxes.map((m) => (
              <option key={m.id} value={m.id}>{m.shared ? `${m.displayName || 'Comercial'} — ` : ''}{m.address}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="w-14 text-xs text-slate-500 flex-shrink-0">Para</label>
          <input value={toValue} onChange={(e) => setToValue(e.target.value)} placeholder="cliente@exemplo.com (separe vários com vírgula)" className={field} />
          {!showCc && <button onClick={() => setShowCc(true)} className="text-xs text-af-mid hover:underline flex-shrink-0">Cc</button>}
        </div>
        {showCc && (
          <div className="flex items-center gap-2">
            <label className="w-14 text-xs text-slate-500 flex-shrink-0">Cc</label>
            <input value={cc} onChange={(e) => setCc(e.target.value)} className={field} />
          </div>
        )}
        <div className="flex items-center gap-2">
          <label className="w-14 text-xs text-slate-500 flex-shrink-0">Assunto</label>
          <input value={subjectValue} onChange={(e) => setSubjectValue(e.target.value)} className={field} />
        </div>
        {iaAberta && (
          <div className="rounded-lg border border-violet-200 bg-violet-50 p-3 space-y-2">
            <div className="flex items-center gap-2">
              <Sparkles size={13} className="text-violet-600" />
              <span className="text-[11px] font-semibold uppercase tracking-wide text-violet-700">Criar com IA</span>
              <span className="text-[11px] text-violet-500 truncate">{leadId ? 'lê a conversa inteira' : replyToId ? 'lê o e-mail respondido' : ''}{iaDocs.length ? ` + ${iaDocs.length} documento${iaDocs.length > 1 ? 's' : ''}` : ''}</span>
              <button onClick={() => setIaAberta(false)} className="ml-auto text-slate-400 hover:text-slate-600" title="Fechar"><X size={14} /></button>
            </div>
            {leadId && dias && dias.length > 0 && (
              <div className="flex items-center gap-2">
                <label className="text-[11px] text-slate-500 flex-shrink-0">Conversa de</label>
                <select value={diaConversa} onChange={(e) => setDiaConversa(e.target.value)} className="text-xs px-2 py-1.5 border border-af-border rounded-lg bg-white text-slate-700">
                  {dias.map((d) => {
                    const hoje = new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10);
                    return <option key={d.date} value={d.date}>{d.date === hoje ? 'Hoje' : d.date.split('-').reverse().join('/')} ({d.count} mensage{d.count > 1 ? 'ns' : 'm'})</option>;
                  })}
                  <option value="">A conversa inteira</option>
                </select>
              </div>
            )}
            <textarea
              value={iaPedido}
              onChange={(e) => setIaPedido(e.target.value)}
              rows={2}
              placeholder={leadId ? 'O que o e-mail precisa dizer? (opcional — sem isso a IA deduz pela conversa)' : 'O que o e-mail precisa dizer?'}
              className={`${field} bg-white resize-y`}
            />
            <div className="space-y-1.5">
              <p className="text-[11px] text-slate-500">Documentos pra IA ler e tirar os dados (não vão anexados no e-mail):</p>
              {iaDocs.length > 0 && <div className="flex flex-wrap gap-1.5">{iaDocs.map((f, i) => <Chip key={`${f.name}-${i}`} f={f} onRemove={() => setIaDocs((prev) => prev.filter((_, j) => j !== i))} />)}</div>}
              <div className="flex flex-wrap items-center gap-1.5">
                <button onClick={() => iaFileInput.current?.click()} className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border border-af-border bg-white text-slate-600 hover:bg-slate-50"><Paperclip size={12} /> Do computador</button>
                {leadId && <button onClick={() => openConversa('ia')} className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border border-af-border bg-white text-slate-600 hover:bg-slate-50"><MessageSquare size={12} /> Da conversa</button>}
                {leadId && <button onClick={() => openDrive('ia')} className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border border-af-border bg-white text-slate-600 hover:bg-slate-50"><FolderOpen size={12} /> Do Drive do cliente</button>}
                <button onClick={criarComIa} disabled={criando || (!leadId && !replyToId && !iaPedido.trim() && !iaDocs.length)} className="ml-auto flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg text-white font-medium disabled:opacity-50 bg-violet-600 hover:bg-violet-700">
                  {criando ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />} {criando ? 'Montando...' : 'Criar e-mail'}
                </button>
              </div>
            </div>
            <input ref={iaFileInput} type="file" multiple accept="application/pdf,image/*" className="hidden" onChange={(e) => { addIaFiles(e.target.files); e.target.value = ''; }} />
          </div>
        )}
        {suggestion && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
            <div className="flex items-center gap-2 mb-1.5">
              <Lightbulb size={13} className="text-amber-600" />
              <span className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">Sugestão — revise antes de mandar</span>
              <button onClick={() => { setBody(suggestion); setSuggestion(null); }} className="ml-auto text-xs px-2.5 py-1 rounded-md text-white font-medium" style={{ backgroundColor: '#2261a8' }}>Usar</button>
              <button onClick={() => setSuggestion(null)} className="text-slate-400 hover:text-slate-600" title="Descartar"><X size={14} /></button>
            </div>
            <p className="text-sm text-slate-700 whitespace-pre-wrap max-h-60 overflow-y-auto">{suggestion}</p>
          </div>
        )}
        <textarea
          autoFocus={!!replyToId || !!to}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={10}
          placeholder="Escreva a mensagem..."
          className={`${field} resize-y min-h-[180px]`}
        />
        {files.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {files.map((f, i) => <Chip key={`${f.name}-${i}`} f={f} onRemove={() => setFiles((prev) => prev.filter((_, j) => j !== i))} />)}
          </div>
        )}
        {drive && (
          <div className="rounded-lg border border-af-border bg-slate-50 p-3 space-y-2">
            <div className="flex items-center gap-2">
              <FolderOpen size={14} className="text-af-mid" />
              <span className="text-xs font-semibold text-slate-700">Pasta do cliente no Drive{drive.alvo === 'ia' ? ' — pra IA ler' : ' — pra anexar'}</span>
              {drive.folderUrl && <a href={drive.folderUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[11px] text-af-mid hover:underline">abrir no Drive <ExternalLink size={10} /></a>}
              <button onClick={() => setDrive(null)} className="ml-auto text-slate-400 hover:text-slate-600" title="Fechar"><X size={14} /></button>
            </div>
            {drive.loading ? <div className="flex items-center gap-2 text-xs text-slate-500"><Loader2 size={12} className="animate-spin" /> Lendo a pasta...</div>
              : drive.error ? <p className="text-xs text-red-600">{drive.error}</p>
              : !drive.folderUrl ? <p className="text-xs text-slate-500">Este cliente ainda não tem pasta no Drive (o campo "link da pasta" do card está vazio e não achei pasta com o nome dele).</p>
              : !drive.files.length ? <p className="text-xs text-slate-500">A pasta está vazia.</p>
              : (
                <>
                  {drive.files.length > 8 && <input value={driveBusca} onChange={(e) => setDriveBusca(e.target.value)} placeholder="Buscar pelo nome do arquivo..." className="w-full text-xs px-2.5 py-1.5 border border-af-border rounded-md bg-white" />}
                  <p className="text-[10px] text-slate-400">Clique na miniatura pra ver o arquivo inteiro.</p>
                  <div className="max-h-72 overflow-y-auto space-y-0.5">
                    {drive.files.filter((f) => !driveBusca.trim() || `${f.path} ${f.name}`.toLowerCase().includes(driveBusca.trim().toLowerCase())).map((f) => {
                      const ja = (drive.alvo === 'ia' ? iaDocs : files).some((x) => x.driveFileId === f.id);
                      return (
                        <label key={f.id} className={`flex items-center gap-2 text-xs px-1.5 py-1 rounded hover:bg-white ${ja ? 'opacity-50' : 'cursor-pointer'}`}>
                          <input type="checkbox" disabled={ja} checked={ja || driveSel.includes(f.id)} onChange={(e) => setDriveSel((prev) => (e.target.checked ? [...prev, f.id] : prev.filter((x) => x !== f.id)))} />
                          <DriveThumb file={f} onOpen={() => verArquivo(f)} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-slate-700">{f.name}</span>
                            {f.path && <span className="block truncate text-[10px] text-slate-400">{f.path}</span>}
                          </span>
                          {abrindo === f.id ? <Loader2 size={12} className="animate-spin text-slate-400 flex-shrink-0" /> : <span className="flex-shrink-0 text-[10px] text-slate-400">{f.size ? formatSize(f.size) : ''}</span>}
                        </label>
                      );
                    })}
                  </div>
                  <div className="flex justify-end">
                    <button onClick={addDriveFiles} disabled={!driveSel.length} className="text-xs px-3 py-1.5 rounded-lg text-white font-medium disabled:opacity-50" style={{ backgroundColor: '#2261a8' }}>
                      {drive.alvo === 'ia' ? 'Dar pra IA ler' : 'Anexar'} {driveSel.length ? `${driveSel.length} arquivo${driveSel.length > 1 ? 's' : ''}` : 'selecionados'}
                    </button>
                  </div>
                </>
              )}
          </div>
        )}
        {conversa && (
          <div className="rounded-lg border border-af-border bg-slate-50 p-3 space-y-2">
            <div className="flex items-center gap-2">
              <MessageSquare size={14} className="text-af-mid" />
              <span className="text-xs font-semibold text-slate-700">Arquivos da conversa{conversa.alvo === 'ia' ? ' — pra IA ler' : ' — pra anexar'}</span>
              <button onClick={() => setConversa(null)} className="ml-auto text-slate-400 hover:text-slate-600" title="Fechar"><X size={14} /></button>
            </div>
            {conversa.loading ? <div className="flex items-center gap-2 text-xs text-slate-500"><Loader2 size={12} className="animate-spin" /> Buscando...</div>
              : conversa.error ? <p className="text-xs text-red-600">{conversa.error}</p>
              : !conversa.files.length ? <p className="text-xs text-slate-500">{conversa.alvo === 'ia' ? 'Nenhum PDF ou imagem nesta conversa.' : 'Nenhum arquivo nesta conversa.'}</p>
              : (
                <>
                  <div className="max-h-72 overflow-y-auto space-y-0.5">
                    {conversa.files.map((f) => {
                      const ja = (conversa.alvo === 'ia' ? iaDocs : files).some((x) => x.attachmentId === f.id);
                      return (
                        <label key={f.id} className={`flex items-center gap-2 text-xs px-1.5 py-1 rounded hover:bg-white ${ja ? 'opacity-50' : 'cursor-pointer'}`}>
                          <input type="checkbox" disabled={ja} checked={ja || convSel.includes(f.id)} onChange={(e) => setConvSel((prev) => (e.target.checked ? [...prev, f.id] : prev.filter((x) => x !== f.id)))} />
                          <ConvThumb file={f} onOpen={() => verArquivoConversa(f)} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-slate-700">{f.name}</span>
                            <span className="block truncate text-[10px] text-slate-400">{f.recebido ? 'recebido' : 'enviado'} em {new Date(f.createdAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                          </span>
                          {abrindo === f.id && <Loader2 size={12} className="animate-spin text-slate-400 flex-shrink-0" />}
                        </label>
                      );
                    })}
                  </div>
                  <div className="flex justify-end">
                    <button onClick={addConversaFiles} disabled={!convSel.length} className="text-xs px-3 py-1.5 rounded-lg text-white font-medium disabled:opacity-50" style={{ backgroundColor: '#2261a8' }}>
                      {conversa.alvo === 'ia' ? 'Dar pra IA ler' : 'Anexar'} {convSel.length ? `${convSel.length} arquivo${convSel.length > 1 ? 's' : ''}` : 'selecionados'}
                    </button>
                  </div>
                </>
              )}
          </div>
        )}
        {(() => {
          const sig = mailboxes.find((m) => m.id === mailboxId)?.signature;
          return sig ? (
            <div className="border-l-[3px] border-blue-500/70 pl-3 py-0.5">
              {sig.split('\n').map((l) => l.trim()).filter(Boolean).map((l, i) => (
                i === 0
                  ? <p key={i} className="text-xs font-semibold text-slate-600">{l}</p>
                  : <p key={i} className="text-[11px] text-slate-400" dangerouslySetInnerHTML={{ __html: signatureLineHtml(l) }} />
              ))}
            </div>
          ) : null;
        })()}
        <p className="text-[11px] text-slate-400">
          {replyToId ? 'A mensagem original vai citada embaixo. ' : ''}Assinatura acima entra automaticamente (muda no lápis ao lado da caixa, na página E-mail).
        </p>
        <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          <button
            onClick={() => fileInput.current?.click()}
            disabled={sending}
            className="flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg border border-af-border text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            <Paperclip size={14} /> Anexar
            {files.length > 0 && <span className="text-xs text-slate-400">({formatSize(totalBytes)} de 15 MB)</span>}
          </button>
          {leadId && (
            <button
              onClick={() => openConversa('email')}
              disabled={sending}
              title="Anexar arquivos que chegaram ou saíram nesta conversa"
              className="flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg border border-af-border text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              <MessageSquare size={14} /> <span className="hidden sm:inline">Da conversa</span>
            </button>
          )}
          <button
            onClick={() => openDrive('email')}
            disabled={sending || !leadId}
            title={leadId ? 'Escolher documentos da pasta do cliente no Drive' : 'Vincule este e-mail a um cliente pra buscar na pasta dele no Drive'}
            className="flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg border border-af-border text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            <FolderOpen size={14} /> <span className="hidden sm:inline">Do Drive do cliente</span>
          </button>
          <button
            onClick={() => setIaAberta((v) => !v)}
            disabled={sending}
            title={leadId ? 'A IA lê a conversa inteira (e os documentos que você der pra ela) e monta o e-mail' : 'A IA monta o e-mail com o que você pedir e os documentos que der pra ela ler'}
            className={`mr-auto flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg border disabled:opacity-50 ${iaAberta ? 'border-violet-300 bg-violet-50 text-violet-700' : 'border-af-border text-slate-600 hover:bg-slate-50'}`}
          >
            <Sparkles size={14} /> <span className="hidden sm:inline">Criar com IA</span>
          </button>
          {onDeleteDraft && (
            <button onClick={onDeleteDraft} className="text-sm px-3 py-2 rounded-lg text-red-500 hover:bg-red-50" title="Apagar este rascunho">Apagar</button>
          )}
          <button onClick={() => saveDraft(true)} disabled={savingDraft || sending || (!body.trim() && !toValue.trim() && !subjectValue.trim())} className="text-sm px-3 py-2 rounded-lg text-slate-600 hover:bg-slate-100 disabled:opacity-50">
            {savingDraft ? 'Salvando...' : 'Salvar rascunho'}
          </button>
          <button onClick={close} className="text-sm px-4 py-2 rounded-lg text-slate-500 hover:bg-slate-100">Cancelar</button>
          <button
            onClick={send}
            disabled={sending}
            className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg text-white font-medium disabled:opacity-50"
            style={{ backgroundColor: '#2261a8' }}
          >
            {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Enviar
          </button>
        </div>
      </div>
      {preview && (
        <AttachmentPreviewModal
          url={preview.url}
          fileName={preview.name}
          isPdf={preview.isPdf}
          onClose={fecharPreview}
          onDownload={() => { const a = document.createElement('a'); a.href = preview.url; a.download = preview.name; a.click(); }}
        />
      )}
    </Modal>
  );
}
