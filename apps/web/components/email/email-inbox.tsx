'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Inbox, Send, PenSquare, RefreshCw, Search, Paperclip, Reply, ChevronLeft, Plus, Loader2, AlertTriangle,
  MessageSquare, Mail, LogOut, Building2, User, PenLine, Link2, Unlink, FileText, ShieldAlert, Trash2, RotateCcw,
} from 'lucide-react';
import { useAuthStore } from '@/store/auth.store';
import api from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { toast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { cn } from '@/lib/utils';
import { EmailComposer } from './email-composer';
import { signatureLineHtml } from '@/lib/signature-links';

/**
 * Caixa de e-mail do CRM (backend: email-inbox.service.ts). A caixa da
 * empresa (comercial@) aparece pra todo mundo; cada colaborador pode
 * conectar a própria. O servidor busca e-mails novos a cada minuto; e-mail
 * de cliente conhecido também cai na conversa do card.
 */
interface Mailbox {
  id: string;
  userId: string | null;
  address: string;
  displayName: string | null;
  shared: boolean;
  unread: number;
  lastSyncAt: string | null;
  lastError: string | null;
  signature: string | null;
  defaultSignature: string;
}
interface Addr { name: string | null; address: string }
interface Attachment { part: string | null; filename: string; contentType: string; size: number }
interface EmailSummary {
  id: string;
  folder: Folder;
  fromName: string | null;
  fromAddress: string | null;
  toList: Addr[] | null;
  subject: string | null;
  date: string;
  snippet: string | null;
  seen: boolean;
  attachments: Attachment[] | null;
  lead: { id: string; name: string } | null;
}
interface EmailFull extends EmailSummary {
  ccList: Addr[] | null;
  inReplyTo?: string | null;
  textBody: string | null;
  htmlBody: string | null;
}

type Folder = 'INBOX' | 'SENT' | 'DRAFTS' | 'SPAM' | 'TRASH';
const FOLDER_LIST: { key: Folder; label: string; icon: typeof Inbox }[] = [
  { key: 'INBOX', label: 'Entrada', icon: Inbox },
  { key: 'SENT', label: 'Enviados', icon: Send },
  { key: 'DRAFTS', label: 'Rascunhos', icon: FileText },
  { key: 'SPAM', label: 'Spam', icon: ShieldAlert },
  { key: 'TRASH', label: 'Lixeira', icon: Trash2 },
];

function shortDate(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }).replace('.', '');
  return d.toLocaleDateString('pt-BR');
}

function formatSize(bytes: number) {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const addrLabel = (a: Addr) => (a.name ? `${a.name} <${a.address}>` : a.address);

/** HTML do e-mail num iframe isolado (sem script, links abrem em outra aba). */
function htmlDoc(html: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>body{font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:14px;color:#1e293b;margin:16px;word-wrap:break-word}img{max-width:100%;height:auto}</style></head><body>${html}</body></html>`;
}

export function EmailInbox() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [mailboxId, setMailboxId] = useState<string | null>(null);
  const [folder, setFolder] = useState<Folder>('INBOX');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [composer, setComposer] = useState<null | { to?: string; cc?: string; subject?: string; body?: string; replyToId?: string | null; leadId?: string | null; draftId?: string | null }>(null);
  const [acting, setActing] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [editingSignature, setEditingSignature] = useState<Mailbox | null>(null);
  const [linking, setLinking] = useState(false);
  const { user } = useAuthStore();
  const isAdmin = user?.role === 'ADMIN';

  const { data: mailboxes = [], isLoading: loadingBoxes } = useQuery<Mailbox[]>({
    queryKey: ['email-accounts'],
    queryFn: async () => (await api.get('/api/email/accounts')).data,
    refetchInterval: 60_000,
  });
  const current = mailboxes.find((m) => m.id === mailboxId) || mailboxes[0] || null;
  const personal = mailboxes.find((m) => !m.shared);

  useEffect(() => {
    if (!mailboxId && mailboxes.length) setMailboxId((mailboxes.find((m) => !m.shared) || mailboxes[0]).id);
  }, [mailboxes, mailboxId]);

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  const { data: list = [], isLoading: loadingList } = useQuery<EmailSummary[]>({
    queryKey: ['email-messages', current?.id, folder, query],
    queryFn: async () => (await api.get(`/api/email/accounts/${current!.id}/messages`, { params: { folder, q: query || undefined } })).data,
    enabled: !!current,
  });

  const { data: opened, isLoading: loadingOpened } = useQuery<EmailFull>({
    queryKey: ['email-message', current?.id, openId],
    queryFn: async () => (await api.get(`/api/email/accounts/${current!.id}/messages/${openId}`)).data,
    enabled: !!current && !!openId,
  });

  // Abrir marca como lido — atualiza o contador da caixa.
  useEffect(() => {
    if (opened) queryClient.invalidateQueries({ queryKey: ['email-accounts'] });
  }, [opened?.id, queryClient]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const socket = getSocket();
    if (!socket.connected) socket.connect();
    function onSynced() {
      queryClient.invalidateQueries({ queryKey: ['email-accounts'] });
      queryClient.invalidateQueries({ queryKey: ['email-messages'] });
    }
    socket.on('email_synced', onSynced);
    return () => { socket.off('email_synced', onSynced); };
  }, [queryClient]);

  async function syncNow() {
    if (!current) return;
    setSyncing(true);
    try {
      await api.post(`/api/email/accounts/${current.id}/sync`);
      await queryClient.invalidateQueries({ queryKey: ['email-messages'] });
      await queryClient.invalidateQueries({ queryKey: ['email-accounts'] });
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Não consegui buscar os e-mails', 'error');
    } finally {
      setSyncing(false);
    }
  }

  async function disconnect(m: Mailbox) {
    if (!confirm(`Desconectar ${m.address} do CRM? Os e-mails continuam no seu provedor.`)) return;
    try {
      await api.delete(`/api/email/accounts/${m.id}`);
      setMailboxId(null);
      setOpenId(null);
      queryClient.invalidateQueries({ queryKey: ['email-accounts'] });
      toast('Caixa desconectada');
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Não consegui desconectar', 'error');
    }
  }

  async function downloadAttachment(a: Attachment) {
    if (!current || !opened) return;
    if (!a.part) { toast('O anexo fica disponível aqui em 1 minuto, quando a cópia chegar em Enviados', 'warning'); return; }
    try {
      const { data } = await api.get(`/api/email/accounts/${current.id}/messages/${opened.id}/attachments/${encodeURIComponent(a.part)}`, { responseType: 'blob' });
      const url = URL.createObjectURL(data);
      const link = document.createElement('a');
      link.href = url;
      link.download = a.filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      toast('Não consegui baixar o anexo', 'error');
    }
  }

  async function moveTo(target: Folder, okMsg: string) {
    if (!current || !opened) return;
    setActing(true);
    try {
      await api.post(`/api/email/accounts/${current.id}/messages/${opened.id}/move`, { folder: target });
      setOpenId(null);
      queryClient.invalidateQueries({ queryKey: ['email-messages'] });
      queryClient.invalidateQueries({ queryKey: ['email-accounts'] });
      toast(okMsg);
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Não consegui mover', 'error');
    } finally {
      setActing(false);
    }
  }

  async function deleteForever(id: string) {
    if (!current) return;
    if (!confirm('Excluir de vez? Não dá pra recuperar depois.')) return;
    setActing(true);
    try {
      await api.delete(`/api/email/accounts/${current.id}/messages/${id}`);
      setOpenId(null);
      queryClient.invalidateQueries({ queryKey: ['email-messages'] });
      toast('Excluído');
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Não consegui excluir', 'error');
    } finally {
      setActing(false);
    }
  }

  /** Rascunho abre direto na janela de escrever, pra continuar. */
  async function openDraft(id: string) {
    if (!current) return;
    try {
      const { data } = await api.get(`/api/email/accounts/${current.id}/messages/${id}`);
      setComposer({
        to: (data.toList || []).map((a: Addr) => a.address).join(', '),
        cc: (data.ccList || []).map((a: Addr) => a.address).join(', '),
        subject: data.subject || '', body: data.textBody || (data.htmlBody ? data.htmlBody.replace(/<[^>]+>/g, '') : ''),
        draftId: data.id,
      });
    } catch {
      toast('Não consegui abrir o rascunho', 'error');
    }
  }

  async function unlink() {
    if (!current || !opened?.lead) return;
    if (!confirm(`Tirar este e-mail da conversa de ${opened.lead.name}?`)) return;
    try {
      await api.post(`/api/email/accounts/${current.id}/messages/${opened.id}/link`, { leadId: null });
      queryClient.invalidateQueries({ queryKey: ['email-message'] });
      queryClient.invalidateQueries({ queryKey: ['email-messages'] });
      toast('E-mail desvinculado do card');
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Não consegui desvincular', 'error');
    }
  }

  function reply() {
    if (!opened) return;
    const to = opened.folder === 'SENT' ? (opened.toList || []).map((a) => a.address).join(', ') : opened.fromAddress || '';
    const subj = opened.subject || '';
    setComposer({ to, subject: /^re:/i.test(subj) ? subj : `Re: ${subj}`, replyToId: opened.id, leadId: opened.lead?.id || null });
  }

  const composerMailboxes = useMemo(() => mailboxes.map((m) => ({ id: m.id, address: m.address, displayName: m.displayName, shared: m.shared, signature: m.signature || m.defaultSignature })), [mailboxes]);

  if (loadingBoxes) {
    return <div className="flex-1 flex items-center justify-center text-slate-400 text-sm"><Loader2 size={18} className="animate-spin mr-2" /> Carregando caixas...</div>;
  }

  if (!mailboxes.length) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
        <Mail size={36} className="text-slate-300 mb-3" />
        <p className="text-sm text-slate-600 font-medium">Nenhuma caixa de e-mail conectada</p>
        <p className="text-xs text-slate-400 mt-1 mb-4">Conecte o seu e-mail pra ler e responder clientes por aqui.</p>
        <button onClick={() => setConnecting(true)} className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg text-white font-medium" style={{ backgroundColor: '#2261a8' }}>
          <Plus size={14} /> Conectar meu e-mail
        </button>
        {connecting && <ConnectMailboxModal onClose={() => setConnecting(false)} onConnected={(id) => { setMailboxId(id); queryClient.invalidateQueries({ queryKey: ['email-accounts'] }); }} />}
      </div>
    );
  }

  return (
    <div className="flex-1 flex overflow-hidden bg-white">
      {/* ── Caixas e pastas (desktop) ── */}
      <aside className="hidden md:flex w-60 flex-shrink-0 flex-col border-r border-af-border bg-slate-50/60">
        <div className="p-3">
          <button
            onClick={() => setComposer({})}
            className="w-full flex items-center justify-center gap-1.5 text-sm px-3 py-2 rounded-lg text-white font-medium"
            style={{ backgroundColor: '#2261a8' }}
          >
            <PenSquare size={14} /> Escrever
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-3 space-y-3">
          {mailboxes.map((m) => (
            <div key={m.id}>
              <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                {m.shared ? <Building2 size={11} /> : <User size={11} />}
                <span className="truncate" title={m.address}>{m.shared ? (m.displayName || 'Empresa') : 'Meu e-mail'}</span>
                {(!m.shared || isAdmin) && (
                  <button onClick={() => setEditingSignature(m)} className="ml-auto text-slate-300 hover:text-af-mid" title="Assinatura desta caixa"><PenLine size={11} /></button>
                )}
                {!m.shared && (
                  <button onClick={() => disconnect(m)} className="text-slate-300 hover:text-red-500" title="Desconectar"><LogOut size={11} /></button>
                )}
              </div>
              <p className="px-2 -mt-0.5 mb-1 text-[11px] text-slate-400 truncate">{m.address}</p>
              {FOLDER_LIST.map(({ key: f, label, icon: Icon }) => {
                const active = current?.id === m.id && folder === f;
                return (
                  <button
                    key={f}
                    onClick={() => { setMailboxId(m.id); setFolder(f); setOpenId(null); }}
                    className={cn('w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-sm transition-colors',
                      active ? 'bg-[#2261a8]/10 text-[#2261a8] font-semibold' : 'text-slate-600 hover:bg-slate-100')}
                  >
                    <Icon size={14} />
                    {label}
                    {f === 'INBOX' && m.unread > 0 && (
                      <span className="ml-auto text-[10px] font-bold bg-[#2261a8] text-white rounded-full px-1.5 min-w-[18px] text-center">{m.unread}</span>
                    )}
                  </button>
                );
              })}
              {m.lastError && (
                <p className="flex items-start gap-1 px-2 mt-1 text-[10px] text-red-500" title={m.lastError}>
                  <AlertTriangle size={10} className="mt-0.5 flex-shrink-0" /> Erro ao buscar e-mails
                </p>
              )}
            </div>
          ))}
          {!personal && (
            <button onClick={() => setConnecting(true)} className="w-full flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm text-af-mid hover:bg-slate-100">
              <Plus size={14} /> Conectar meu e-mail
            </button>
          )}
        </div>
      </aside>

      {/* ── Lista ── */}
      <section className={cn('flex-col border-r border-af-border w-full md:w-[360px] flex-shrink-0', openId ? 'hidden md:flex' : 'flex')}>
        {/* Seletor compacto no celular */}
        <div className="md:hidden flex items-center gap-2 px-3 pt-3">
          <select
            value={`${current?.id}|${folder}`}
            onChange={(e) => { const [id, f] = e.target.value.split('|'); setMailboxId(id); setFolder(f as Folder); setOpenId(null); }}
            className="flex-1 text-sm px-2 py-1.5 border border-af-border rounded-lg text-slate-700"
          >
            {mailboxes.flatMap((m) => FOLDER_LIST.map(({ key: f, label }) => (
              <option key={`${m.id}|${f}`} value={`${m.id}|${f}`}>
                {m.shared ? (m.displayName || 'Empresa') : 'Meu e-mail'} — {label}{f === 'INBOX' && m.unread ? ` (${m.unread})` : ''}
              </option>
            )))}
          </select>
          <button onClick={() => setComposer({})} className="p-2 rounded-lg text-white" style={{ backgroundColor: '#2261a8' }} title="Escrever"><PenSquare size={15} /></button>
          {!personal && <button onClick={() => setConnecting(true)} className="p-2 rounded-lg border border-af-border text-af-mid" title="Conectar meu e-mail"><Plus size={15} /></button>}
        </div>
        <div className="flex items-center gap-2 p-3 border-b border-af-border">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar e-mail"
              className="w-full text-sm pl-8 pr-2 py-1.5 border border-af-border rounded-lg focus:outline-none focus:border-af-mid text-slate-800"
            />
          </div>
          <button onClick={syncNow} disabled={syncing} className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 disabled:opacity-50" title="Buscar e-mails novos agora">
            <RefreshCw size={15} className={syncing ? 'animate-spin' : ''} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loadingList && <div className="p-6 text-center text-sm text-slate-400"><Loader2 size={16} className="animate-spin inline mr-1.5" />Carregando...</div>}
          {!loadingList && list.length === 0 && (
            <div className="p-8 text-center text-sm text-slate-400">
              {query ? 'Nada encontrado.' : current?.lastSyncAt ? (folder === 'DRAFTS' ? 'Nenhum rascunho.' : folder === 'TRASH' ? 'Lixeira vazia.' : folder === 'SPAM' ? 'Nenhum spam.' : 'Nenhum e-mail aqui.') : 'Buscando os e-mails pela primeira vez — pode levar um minuto.'}
            </div>
          )}
          {list.map((e) => {
            const who = folder === 'SENT' || folder === 'DRAFTS'
              ? `Para: ${(e.toList || []).map((a) => a.name || a.address).join(', ') || '—'}`
              : e.fromName || e.fromAddress || '—';
            return (
              <button
                key={e.id}
                onClick={() => (folder === 'DRAFTS' ? openDraft(e.id) : setOpenId(e.id))}
                className={cn('w-full text-left px-3 py-2.5 border-b border-slate-100 transition-colors',
                  openId === e.id ? 'bg-[#2261a8]/10' : 'hover:bg-slate-50')}
              >
                <div className="flex items-center gap-2">
                  {!e.seen && <span className="w-2 h-2 rounded-full bg-[#2261a8] flex-shrink-0" />}
                  <span className={cn('text-sm truncate flex-1', e.seen ? 'text-slate-600' : 'text-slate-900 font-semibold')}>{who}</span>
                  <span className="text-[11px] text-slate-400 flex-shrink-0">{shortDate(e.date)}</span>
                </div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className={cn('text-[13px] truncate flex-1', e.seen ? 'text-slate-600' : 'text-slate-800 font-medium')}>{e.subject || '(sem assunto)'}</span>
                  {!!e.attachments?.length && <Paperclip size={12} className="text-slate-400 flex-shrink-0" />}
                </div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className="text-xs text-slate-400 truncate flex-1">{e.snippet}</span>
                  {e.lead && <span className="text-[10px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-px flex-shrink-0 max-w-[110px] truncate">{e.lead.name}</span>}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {/* ── Leitura ── */}
      <section className={cn('flex-1 min-w-0 flex-col', openId ? 'flex' : 'hidden md:flex')}>
        {!openId && (
          <div className="flex-1 flex flex-col items-center justify-center text-slate-300">
            <Mail size={40} />
            <p className="text-sm mt-2 text-slate-400">Selecione um e-mail pra ler</p>
          </div>
        )}
        {openId && (loadingOpened || !opened) && (
          <div className="flex-1 flex items-center justify-center text-slate-400 text-sm"><Loader2 size={16} className="animate-spin mr-2" />Abrindo...</div>
        )}
        {openId && opened && (
          <>
            <div className="px-4 md:px-5 py-3 border-b border-af-border">
              <div className="flex items-start gap-2">
                <button onClick={() => setOpenId(null)} className="md:hidden -ml-1 mt-0.5 text-slate-500"><ChevronLeft size={20} /></button>
                <h2 className="text-base md:text-lg font-semibold text-slate-900 flex-1 min-w-0 break-words">{opened.subject || '(sem assunto)'}</h2>
              </div>
              <div className="mt-1.5 text-xs text-slate-500 space-y-0.5">
                <p><span className="text-slate-400">De:</span> {opened.fromName ? `${opened.fromName} <${opened.fromAddress}>` : opened.fromAddress}</p>
                <p className="truncate"><span className="text-slate-400">Para:</span> {(opened.toList || []).map(addrLabel).join(', ') || '—'}</p>
                {!!opened.ccList?.length && <p className="truncate"><span className="text-slate-400">Cc:</span> {opened.ccList.map(addrLabel).join(', ')}</p>}
                <p className="text-slate-400">{new Date(opened.date).toLocaleString('pt-BR', { dateStyle: 'medium', timeStyle: 'short' })}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2 mt-2.5">
                {opened.folder !== 'TRASH' && (
                  <button onClick={reply} className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg text-white" style={{ backgroundColor: '#2261a8' }}>
                    <Reply size={13} /> Responder
                  </button>
                )}
                {opened.folder === 'INBOX' && (
                  <button onClick={() => moveTo('SPAM', 'Movido pro Spam')} disabled={acting} className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border border-af-border text-slate-600 hover:bg-slate-50 disabled:opacity-50" title="Marcar como spam">
                    <ShieldAlert size={13} /> Spam
                  </button>
                )}
                {opened.folder === 'SPAM' && (
                  <button onClick={() => moveTo('INBOX', 'Voltou pra Entrada')} disabled={acting} className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border border-af-border text-slate-600 hover:bg-slate-50 disabled:opacity-50">
                    <Inbox size={13} /> Não é spam
                  </button>
                )}
                {opened.folder !== 'TRASH' ? (
                  <button onClick={() => moveTo('TRASH', 'Movido pra Lixeira')} disabled={acting} className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border border-af-border text-slate-600 hover:bg-slate-50 hover:text-red-600 disabled:opacity-50" title="Mandar pra Lixeira">
                    <Trash2 size={13} /> Lixeira
                  </button>
                ) : (
                  <>
                    <button
                      onClick={() => moveTo(opened.fromAddress === current?.address ? 'SENT' : 'INBOX', 'E-mail restaurado')}
                      disabled={acting}
                      className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border border-af-border text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                    >
                      <RotateCcw size={13} /> Restaurar
                    </button>
                    <button onClick={() => deleteForever(opened.id)} disabled={acting} className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50">
                      <Trash2 size={13} /> Excluir de vez
                    </button>
                  </>
                )}
                {opened.lead ? (
                  <>
                    <button onClick={() => router.push(`/inbox?leadId=${opened.lead!.id}`)} className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100">
                      <MessageSquare size={13} /> Conversa de {opened.lead.name}
                    </button>
                    <button onClick={unlink} className="flex items-center gap-1 text-xs px-2 py-1.5 rounded-lg text-slate-400 hover:text-red-500" title="Esse e-mail não é desse cliente — tirar da conversa do card">
                      <Unlink size={12} /> Desvincular
                    </button>
                  </>
                ) : (
                  <button onClick={() => setLinking(true)} className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-af-border text-slate-600 hover:bg-slate-50" title="Levar esse e-mail (e os próximos desse remetente) pra conversa de um card">
                    <Link2 size={13} /> Vincular a um card
                  </button>
                )}
              </div>
              {!!opened.attachments?.length && (
                <div className="flex flex-wrap gap-1.5 mt-2.5">
                  {opened.attachments.map((a) => (
                    <button key={`${a.part}-${a.filename}`} onClick={() => downloadAttachment(a)} className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg border border-af-border text-slate-600 hover:bg-slate-50 max-w-[240px]">
                      <Paperclip size={12} className="flex-shrink-0" />
                      <span className="truncate">{a.filename}</span>
                      <span className="text-slate-400 flex-shrink-0">{formatSize(a.size)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="flex-1 min-h-0 bg-white">
              {opened.htmlBody ? (
                <iframe
                  title="Conteúdo do e-mail"
                  sandbox="allow-popups allow-popups-to-escape-sandbox"
                  srcDoc={htmlDoc(opened.htmlBody)}
                  className="w-full h-full border-0"
                />
              ) : (
                <pre className="h-full overflow-auto whitespace-pre-wrap break-words font-sans text-sm text-slate-800 p-5">{opened.textBody || '(sem conteúdo)'}</pre>
              )}
            </div>
          </>
        )}
      </section>

      {composer && current && (
        <EmailComposer
          mailboxes={composerMailboxes}
          defaultMailboxId={current.id}
          to={composer.to}
          cc={composer.cc}
          subject={composer.subject}
          body={composer.body}
          replyToId={composer.replyToId}
          leadId={composer.leadId}
          draftId={composer.draftId}
          onClose={() => setComposer(null)}
          onSent={() => queryClient.invalidateQueries({ queryKey: ['email-messages'] })}
          onDeleteDraft={composer.draftId ? () => { const id = composer.draftId!; setComposer(null); deleteForever(id); } : undefined}
        />
      )}
      {editingSignature && (
        <SignatureModal
          mailbox={editingSignature}
          onClose={() => setEditingSignature(null)}
          onSaved={() => queryClient.invalidateQueries({ queryKey: ['email-accounts'] })}
        />
      )}
      {linking && current && opened && (
        <LinkLeadModal
          mailboxId={current.id}
          email={opened}
          onClose={() => setLinking(false)}
          onLinked={() => {
            queryClient.invalidateQueries({ queryKey: ['email-message'] });
            queryClient.invalidateQueries({ queryKey: ['email-messages'] });
          }}
        />
      )}
      {connecting && (
        <ConnectMailboxModal
          onClose={() => setConnecting(false)}
          onConnected={(id) => { setMailboxId(id); setFolder('INBOX'); setOpenId(null); queryClient.invalidateQueries({ queryKey: ['email-accounts'] }); }}
        />
      )}
    </div>
  );
}

/** "Conectar meu e-mail" — padrão Titan (e-mail do domínio da empresa);
 *  outros provedores pelo "Avançado". A senha vai criptografada pro servidor. */
function ConnectMailboxModal({ onClose, onConnected }: { onClose: () => void; onConnected: (id: string) => void }) {
  const [address, setAddress] = useState('');
  const [password, setPassword] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [imapHost, setImapHost] = useState('imap.titan.email');
  const [imapPort, setImapPort] = useState('993');
  const [smtpHost, setSmtpHost] = useState('smtp.titan.email');
  const [smtpPort, setSmtpPort] = useState('587');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function applyPreset(domain: string) {
    if (/gmail\.com$/i.test(domain)) { setImapHost('imap.gmail.com'); setSmtpHost('smtp.gmail.com'); setAdvanced(true); }
    else if (/(outlook|hotmail|live)\.com$/i.test(domain)) { setImapHost('outlook.office365.com'); setSmtpHost('smtp.office365.com'); setAdvanced(true); }
  }

  async function connect() {
    setSaving(true);
    setError('');
    try {
      const { data } = await api.post('/api/email/accounts', { address, password, imapHost, imapPort, smtpHost, smtpPort });
      toast('E-mail conectado! Buscando as mensagens...');
      onConnected(data.id);
      onClose();
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Não consegui conectar');
    } finally {
      setSaving(false);
    }
  }

  const field = 'w-full text-sm px-3 py-2 border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent text-slate-800';
  return (
    <Modal title="Conectar meu e-mail" onClose={onClose} size="sm">
      <div className="space-y-3">
        <div>
          <label className="text-xs font-medium text-slate-600 mb-1 block">E-mail</label>
          <input value={address} onChange={(e) => setAddress(e.target.value)} onBlur={() => applyPreset(address.split('@')[1] || '')} placeholder="voce@aefsolucoesfinanceiras.com.br" className={field} autoComplete="off" />
        </div>
        <div>
          <label className="text-xs font-medium text-slate-600 mb-1 block">Senha do e-mail</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className={field} autoComplete="new-password" />
          <p className="text-[11px] text-slate-400 mt-1">Fica guardada criptografada e só você enxerga essa caixa.</p>
        </div>
        <button onClick={() => setAdvanced((v) => !v)} className="text-xs text-af-mid hover:underline">{advanced ? 'Ocultar' : 'Avançado'} (servidores)</button>
        {advanced && (
          <div className="grid grid-cols-3 gap-2">
            <input value={imapHost} onChange={(e) => setImapHost(e.target.value)} className={`${field} col-span-2`} placeholder="Servidor IMAP" />
            <input value={imapPort} onChange={(e) => setImapPort(e.target.value)} className={field} placeholder="993" />
            <input value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} className={`${field} col-span-2`} placeholder="Servidor SMTP" />
            <input value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} className={field} placeholder="587" />
            <p className="col-span-3 text-[11px] text-slate-400">Gmail: use uma "senha de app" (Conta Google → Segurança). Padrão: e-mail da empresa (Titan).</p>
          </div>
        )}
        {error && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="text-sm px-4 py-2 rounded-lg text-slate-500 hover:bg-slate-100">Cancelar</button>
          <button
            onClick={connect}
            disabled={saving || !address.trim() || !password}
            className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg text-white font-medium disabled:opacity-50"
            style={{ backgroundColor: '#2261a8' }}
          >
            {saving && <Loader2 size={14} className="animate-spin" />} {saving ? 'Testando...' : 'Conectar'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Assinatura da caixa — texto simples, cada linha vira uma linha no e-mail
 *  (a 1ª em destaque). Vazio = volta pra assinatura padrão. */
function SignatureModal({ mailbox, onClose, onSaved }: { mailbox: Mailbox; onClose: () => void; onSaved: () => void }) {
  const [text, setText] = useState(mailbox.signature || mailbox.defaultSignature);
  const [saving, setSaving] = useState(false);
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  async function save() {
    setSaving(true);
    try {
      await api.put(`/api/email/accounts/${mailbox.id}/signature`, { signature: text });
      toast('Assinatura salva');
      onSaved();
      onClose();
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Não consegui salvar', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={`Assinatura — ${mailbox.address}`} onClose={onClose} size="md">
      <div className="space-y-3">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          className="w-full text-sm px-3 py-2 border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent text-slate-800 resize-y"
          placeholder={'Seu nome\nCargo\nA & F Soluções Financeiras\n(61) 9 0000-0000'}
        />
        <div>
          <p className="text-[11px] text-slate-400 mb-1.5">Como vai aparecer no e-mail:</p>
          <div className="border-l-[3px] border-blue-500 pl-3.5">
            {lines.length ? lines.map((l, i) => (
              i === 0
                ? <p key={i} className="text-[13px] font-bold text-[#0d2545] mb-1">{l}</p>
                : <p key={i} className="text-xs text-slate-500" dangerouslySetInnerHTML={{ __html: signatureLineHtml(l) }} />
            )) : <p className="text-xs text-slate-400">(sem assinatura — usa a padrão)</p>}
          </div>
          <p className="text-[11px] text-slate-400 mt-1.5">Site, e-mail e telefone viram link sozinhos.</p>
        </div>
        {mailbox.shared && <p className="text-[11px] text-amber-600">É a caixa da empresa: vale pros e-mails de todo mundo que enviar por ela.</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="text-sm px-4 py-2 rounded-lg text-slate-500 hover:bg-slate-100">Cancelar</button>
          <button onClick={save} disabled={saving} className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg text-white font-medium disabled:opacity-50" style={{ backgroundColor: '#2261a8' }}>
            {saving && <Loader2 size={14} className="animate-spin" />} Salvar
          </button>
        </div>
      </div>
    </Modal>
  );
}

interface LeadHit {
  id: string;
  name: string;
  archived: boolean;
  contact: { email: string | null; phone: string | null; whatsappPhone: string | null } | null;
  pipeline: { name: string; department: { name: string } | null } | null;
  stage: { name: string } | null;
}

/** "Vincular a um card": remetente que o CRM não reconheceu (não tem esse
 *  e-mail em nenhum contato) → escolhe o card; o e-mail e os outros desse
 *  remetente entram na conversa do card, e os próximos já caem lá sozinhos. */
function LinkLeadModal({ mailboxId, email, onClose, onLinked }: { mailboxId: string; email: EmailFull; onClose: () => void; onLinked: () => void }) {
  const [q, setQ] = useState(email.folder === 'INBOX' ? (email.fromName || '') : '');
  const [results, setResults] = useState<LeadHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const address = email.folder === 'INBOX' ? email.fromAddress : email.toList?.[0]?.address;

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setResults([]); return; }
    setSearching(true);
    const t = setTimeout(() => {
      api.get('/api/email/lead-search', { params: { q: term } })
        .then(({ data }) => setResults(data))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  async function link(lead: LeadHit) {
    setSaving(lead.id);
    try {
      const { data } = await api.post(`/api/email/accounts/${mailboxId}/messages/${email.id}/link`, { leadId: lead.id });
      toast(data.linked > 1 ? `${data.linked} e-mails de ${address} foram pra conversa de ${lead.name}` : `E-mail vinculado a ${lead.name}`);
      onLinked();
      onClose();
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Não consegui vincular', 'error');
    } finally {
      setSaving(null);
    }
  }

  return (
    <Modal title="Vincular a um card" onClose={onClose} size="md">
      <div className="space-y-3">
        <p className="text-xs text-slate-500">
          O e-mail de <b className="text-slate-700">{address || 'remetente'}</b> vai pra conversa do card escolhido — junto com os outros desse endereço — e os próximos já caem lá sozinhos. Se o contato não tiver e-mail, esse endereço fica salvo nele.
        </p>
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Nome, e-mail ou telefone do cliente"
            className="w-full text-sm pl-8 pr-3 py-2 border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent text-slate-800"
          />
        </div>
        <div className="max-h-72 overflow-y-auto -mx-1">
          {searching && <p className="text-xs text-slate-400 px-1 py-2"><Loader2 size={12} className="animate-spin inline mr-1" />Buscando...</p>}
          {!searching && q.trim().length >= 2 && results.length === 0 && <p className="text-xs text-slate-400 px-1 py-2">Nenhum card encontrado.</p>}
          {results.map((l) => (
            <button
              key={l.id}
              onClick={() => link(l)}
              disabled={!!saving}
              className="w-full text-left px-2.5 py-2 rounded-lg hover:bg-slate-50 disabled:opacity-50 flex items-center gap-2"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-slate-800 truncate">{l.name}{l.archived && <span className="text-[10px] text-slate-400 ml-1.5">(arquivado)</span>}</p>
                <p className="text-[11px] text-slate-400 truncate">
                  {[l.pipeline?.department?.name, l.pipeline?.name, l.stage?.name].filter(Boolean).join(' → ')}
                  {l.contact?.email ? ` · ${l.contact.email}` : ''}
                  {l.contact?.whatsappPhone || l.contact?.phone ? ` · ${l.contact.whatsappPhone || l.contact.phone}` : ''}
                </p>
              </div>
              {saving === l.id ? <Loader2 size={14} className="animate-spin text-slate-400" /> : <Link2 size={14} className="text-slate-300" />}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
