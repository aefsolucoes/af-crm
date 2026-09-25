'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Inbox, Send, PenSquare, RefreshCw, Search, Paperclip, Reply, ChevronLeft, Plus, Loader2, AlertTriangle,
  MessageSquare, Mail, LogOut, Building2, User,
} from 'lucide-react';
import api from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { toast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { cn } from '@/lib/utils';
import { EmailComposer } from './email-composer';

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
}
interface Addr { name: string | null; address: string }
interface Attachment { part: string; filename: string; contentType: string; size: number }
interface EmailSummary {
  id: string;
  folder: 'INBOX' | 'SENT';
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
  textBody: string | null;
  htmlBody: string | null;
}

type Folder = 'INBOX' | 'SENT';

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
  const [composer, setComposer] = useState<null | { to?: string; subject?: string; replyToId?: string | null; leadId?: string | null }>(null);
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);

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

  function reply() {
    if (!opened) return;
    const to = opened.folder === 'SENT' ? (opened.toList || []).map((a) => a.address).join(', ') : opened.fromAddress || '';
    const subj = opened.subject || '';
    setComposer({ to, subject: /^re:/i.test(subj) ? subj : `Re: ${subj}`, replyToId: opened.id, leadId: opened.lead?.id || null });
  }

  const composerMailboxes = useMemo(() => mailboxes.map((m) => ({ id: m.id, address: m.address, displayName: m.displayName, shared: m.shared })), [mailboxes]);

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
                {!m.shared && (
                  <button onClick={() => disconnect(m)} className="ml-auto text-slate-300 hover:text-red-500" title="Desconectar"><LogOut size={11} /></button>
                )}
              </div>
              <p className="px-2 -mt-0.5 mb-1 text-[11px] text-slate-400 truncate">{m.address}</p>
              {(['INBOX', 'SENT'] as Folder[]).map((f) => {
                const active = current?.id === m.id && folder === f;
                return (
                  <button
                    key={f}
                    onClick={() => { setMailboxId(m.id); setFolder(f); setOpenId(null); }}
                    className={cn('w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-sm transition-colors',
                      active ? 'bg-[#2261a8]/10 text-[#2261a8] font-semibold' : 'text-slate-600 hover:bg-slate-100')}
                  >
                    {f === 'INBOX' ? <Inbox size={14} /> : <Send size={14} />}
                    {f === 'INBOX' ? 'Entrada' : 'Enviados'}
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
            {mailboxes.flatMap((m) => (['INBOX', 'SENT'] as Folder[]).map((f) => (
              <option key={`${m.id}|${f}`} value={`${m.id}|${f}`}>
                {m.shared ? (m.displayName || 'Empresa') : 'Meu e-mail'} — {f === 'INBOX' ? `Entrada${m.unread ? ` (${m.unread})` : ''}` : 'Enviados'}
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
              {query ? 'Nada encontrado.' : current?.lastSyncAt ? 'Nenhum e-mail aqui.' : 'Buscando os e-mails pela primeira vez — pode levar um minuto.'}
            </div>
          )}
          {list.map((e) => {
            const who = folder === 'SENT'
              ? `Para: ${(e.toList || []).map((a) => a.name || a.address).join(', ') || '—'}`
              : e.fromName || e.fromAddress || '—';
            return (
              <button
                key={e.id}
                onClick={() => setOpenId(e.id)}
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
                <button onClick={reply} className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg text-white" style={{ backgroundColor: '#2261a8' }}>
                  <Reply size={13} /> Responder
                </button>
                {opened.lead && (
                  <button onClick={() => router.push(`/inbox?leadId=${opened.lead!.id}`)} className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100">
                    <MessageSquare size={13} /> Conversa de {opened.lead.name}
                  </button>
                )}
              </div>
              {!!opened.attachments?.length && (
                <div className="flex flex-wrap gap-1.5 mt-2.5">
                  {opened.attachments.map((a) => (
                    <button key={a.part} onClick={() => downloadAttachment(a)} className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg border border-af-border text-slate-600 hover:bg-slate-50 max-w-[240px]">
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
          subject={composer.subject}
          replyToId={composer.replyToId}
          leadId={composer.leadId}
          onClose={() => setComposer(null)}
          onSent={() => queryClient.invalidateQueries({ queryKey: ['email-messages'] })}
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
