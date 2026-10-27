'use client';
import { useEffect, useRef, useState } from 'react';
import { Send, Loader2, Paperclip, X, Lightbulb, FolderOpen, ExternalLink, FileText, Eye } from 'lucide-react';
import { AttachmentPreviewModal } from '@/components/inbox/message-attachment';
import { Modal } from '@/components/ui/modal';
import { toast } from '@/components/ui/toast';
import api from '@/lib/api';
import { signatureLineHtml } from '@/lib/signature-links';

// Mesmo limite do servidor (email-inbox.service.ts): cabe no ~25 MB do provedor.
const MAX_FILES = 10;
const MAX_TOTAL_BYTES = 15 * 1024 * 1024;

/** Anexo do computador (dataBase64) ou da pasta do cliente no Drive (driveFileId: o servidor baixa na hora de enviar). */
interface PickedFile { name: string; type: string; size: number; dataBase64?: string; driveFileId?: string }
interface DriveFile { id: string; name: string; mimeType: string; path: string; size: number }

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
  // "Sugerir resposta" (igual ao da conversa): a IA sugere, a pessoa revisa e clica "Usar".
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  async function suggest() {
    setSuggesting(true);
    try {
      const { data } = await api.post('/api/email/suggest-reply', { replyToId, leadId, subject: subjectValue, to: toValue, draft: body });
      setSuggestion(data.suggestion || null);
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Não consegui gerar uma sugestão agora', 'error');
    } finally {
      setSuggesting(false);
    }
  }
  const fileInput = useRef<HTMLInputElement>(null);
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  // "Do Drive do cliente" (Fabio 27/10): escolher documentos da pasta do cliente no Drive pra anexar.
  const [drive, setDrive] = useState<null | { loading: boolean; folderUrl: string | null; files: DriveFile[]; error?: string }>(null);
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
  async function openDrive() {
    if (!leadId) return;
    if (drive) { setDrive(null); return; }
    setDrive({ loading: true, folderUrl: null, files: [] });
    setDriveSel([]);
    try {
      const { data } = await api.get('/api/email/lead-drive-files', { params: { leadId } });
      setDrive({ loading: false, folderUrl: data.folderUrl || null, files: data.files || [] });
    } catch (err: any) {
      setDrive({ loading: false, folderUrl: null, files: [], error: err?.response?.data?.error || 'Não consegui abrir a pasta do cliente no Drive' });
    }
  }
  function addDriveFiles() {
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
        attachments: files.map((f) => (f.driveFileId ? { filename: f.name, contentType: f.type, driveFileId: f.driveFileId } : { filename: f.name, contentType: f.type, dataBase64: f.dataBase64 })),
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
            {files.map((f, i) => (
              <span key={`${f.name}-${i}`} className="flex items-center gap-1.5 text-xs pl-2.5 pr-1.5 py-1 rounded-lg border border-af-border bg-slate-50 text-slate-600 max-w-[260px]">
                {f.driveFileId ? <FolderOpen size={11} className="flex-shrink-0 text-af-mid" /> : <Paperclip size={11} className="flex-shrink-0" />}
                <span className="truncate">{f.name}</span>
                <span className="text-slate-400 flex-shrink-0">{formatSize(f.size)}</span>
                <button onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))} className="text-slate-400 hover:text-red-500 flex-shrink-0" title="Tirar anexo"><X size={12} /></button>
              </span>
            ))}
          </div>
        )}
        {drive && (
          <div className="rounded-lg border border-af-border bg-slate-50 p-3 space-y-2">
            <div className="flex items-center gap-2">
              <FolderOpen size={14} className="text-af-mid" />
              <span className="text-xs font-semibold text-slate-700">Pasta do cliente no Drive</span>
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
                      const ja = files.some((x) => x.driveFileId === f.id);
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
                      Anexar {driveSel.length ? `${driveSel.length} arquivo${driveSel.length > 1 ? 's' : ''}` : 'selecionados'}
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
          <button
            onClick={openDrive}
            disabled={sending || !leadId}
            title={leadId ? 'Escolher documentos da pasta do cliente no Drive' : 'Vincule este e-mail a um cliente pra buscar na pasta dele no Drive'}
            className="flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg border border-af-border text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            <FolderOpen size={14} /> <span className="hidden sm:inline">Do Drive do cliente</span>
          </button>
          <button
            onClick={suggest}
            disabled={suggesting || sending}
            title={body.trim() ? 'A IA melhora/completa o que você já escreveu' : replyToId ? 'A IA sugere uma resposta pra esse e-mail' : 'A IA sugere um e-mail com base no card e na conversa'}
            className="mr-auto flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg border border-af-border text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            {suggesting ? <Loader2 size={14} className="animate-spin" /> : <Lightbulb size={14} />} <span className="hidden sm:inline">Sugerir resposta</span>
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
