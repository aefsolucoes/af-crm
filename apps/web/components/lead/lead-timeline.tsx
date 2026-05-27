'use client';
import { Note, Message, NoteType } from '@/types';
import { formatDateTime, CHANNEL_LABELS, CHANNEL_COLORS } from '@/lib/utils';
import { MessageSquare, Phone, Mail, ArrowRightLeft, FileText, Plus } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';

const NOTE_ICONS: Record<NoteType, React.ReactNode> = {
  COMMENT: <FileText size={14} />,
  CALL: <Phone size={14} />,
  EMAIL: <Mail size={14} />,
  STAGE_CHANGE: <ArrowRightLeft size={14} />,
};

const NOTE_LABELS: Record<NoteType, string> = {
  COMMENT: 'Nota',
  CALL: 'Ligação',
  EMAIL: 'E-mail',
  STAGE_CHANGE: 'Mudança de estágio',
};

interface TimelineItem {
  id: string;
  type: 'note' | 'message';
  createdAt: string;
  note?: Note;
  message?: Message;
}

interface LeadTimelineProps {
  leadId: string;
  notes: Note[];
  messages: Message[];
  onRefresh: () => void;
}

export function LeadTimeline({ leadId, notes, messages, onRefresh }: LeadTimelineProps) {
  const [showNoteForm, setShowNoteForm] = useState(false);
  const [noteContent, setNoteContent] = useState('');
  const [noteType, setNoteType] = useState<NoteType>('COMMENT');
  const [saving, setSaving] = useState(false);

  const items: TimelineItem[] = [
    ...notes.map((n) => ({ id: n.id, type: 'note' as const, createdAt: n.createdAt, note: n })),
    ...messages.map((m) => ({ id: m.id, type: 'message' as const, createdAt: m.createdAt, message: m })),
  ].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  async function handleAddNote() {
    if (!noteContent.trim()) return;
    setSaving(true);
    try {
      await api.post('/api/notes', { leadId, content: noteContent.trim(), type: noteType });
      toast('Nota adicionada!');
      setNoteContent('');
      setShowNoteForm(false);
      onRefresh();
    } catch {
      toast('Erro ao adicionar nota', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b border-af-border bg-white">
        <h3 className="text-sm font-semibold text-slate-700">Histórico</h3>
        <Button size="sm" variant="secondary" onClick={() => setShowNoteForm(!showNoteForm)}>
          <Plus size={13} />
          Adicionar nota
        </Button>
      </div>

      {showNoteForm && (
        <div className="px-6 py-4 bg-af-light border-b border-af-border space-y-3">
          <div className="flex gap-2">
            {(['COMMENT', 'CALL', 'EMAIL'] as NoteType[]).map((t) => (
              <button
                key={t}
                onClick={() => setNoteType(t)}
                className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${noteType === t ? 'bg-af-mid text-white' : 'bg-white text-slate-600 border border-af-border hover:bg-white'}`}
              >
                {NOTE_LABELS[t]}
              </button>
            ))}
          </div>
          <textarea
            value={noteContent}
            onChange={(e) => setNoteContent(e.target.value)}
            placeholder="Escreva sua nota aqui..."
            className="w-full px-3 py-2 text-sm border border-af-border rounded-lg bg-white resize-none focus:outline-none focus:ring-2 focus:ring-af-accent"
            rows={3}
          />
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => setShowNoteForm(false)}>Cancelar</Button>
            <Button size="sm" loading={saving} onClick={handleAddNote}>Salvar</Button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4 scrollbar-thin">
        {items.map((item) => {
          if (item.type === 'note' && item.note) {
            const n = item.note;
            return (
              <div key={item.id} className="flex gap-3">
                <div className="flex-shrink-0 w-7 h-7 bg-af-light border border-af-border rounded-full flex items-center justify-center text-af-mid">
                  {NOTE_ICONS[n.type]}
                </div>
                <div className="flex-1 bg-white border border-af-border rounded-lg p-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-af-mid">{NOTE_LABELS[n.type]}</span>
                    <span className="text-xs text-slate-400">{formatDateTime(n.createdAt)}</span>
                  </div>
                  <p className="text-sm text-slate-700">{n.content}</p>
                </div>
              </div>
            );
          }
          if (item.type === 'message' && item.message) {
            const m = item.message;
            return (
              <div key={item.id} className={`flex gap-3 ${m.direction === 'OUTBOUND' ? 'flex-row-reverse' : ''}`}>
                <div
                  className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center"
                  style={{ backgroundColor: CHANNEL_COLORS[m.channel] + '22', color: CHANNEL_COLORS[m.channel] }}
                >
                  <MessageSquare size={13} />
                </div>
                <div className={`flex-1 rounded-lg p-3 text-sm ${m.direction === 'OUTBOUND' ? 'bg-af-mid text-white' : 'bg-white border border-af-border text-slate-700'}`}>
                  <div className={`flex items-center justify-between mb-1 text-xs ${m.direction === 'OUTBOUND' ? 'text-white/70' : 'text-slate-400'}`}>
                    <span>{CHANNEL_LABELS[m.channel]} · {m.direction === 'INBOUND' ? 'Recebido' : 'Enviado'}</span>
                    <span>{formatDateTime(m.createdAt)}</span>
                  </div>
                  <p>{m.content}</p>
                </div>
              </div>
            );
          }
          return null;
        })}
        {items.length === 0 && (
          <div className="flex items-center justify-center h-32 text-slate-400 text-sm">
            Nenhuma atividade registrada
          </div>
        )}
      </div>
    </div>
  );
}
