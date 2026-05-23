'use client';
import { useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Stage, Contact, User } from '@/types';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { useAuthStore } from '@/store/auth.store';

interface LeadModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  stages: Stage[];
  pipelineId: string;
  defaultStageId?: string;
  contacts: Contact[];
  users: User[];
}

export function LeadModal({ open, onClose, onCreated, stages, pipelineId, defaultStageId, contacts, users }: LeadModalProps) {
  const { user } = useAuthStore();
  const [form, setForm] = useState({
    name: '',
    value: '',
    stageId: defaultStageId || stages[0]?.id || '',
    userId: user?.id || '',
    contactId: '',
    tags: '',
  });
  const [loading, setLoading] = useState(false);

  function handleChange(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await api.post('/api/leads', {
        name: form.name,
        value: form.value ? Number(form.value) : undefined,
        stageId: form.stageId,
        pipelineId,
        userId: form.userId,
        contactId: form.contactId || undefined,
        tags: form.tags ? form.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
      });
      toast('Lead criado com sucesso!');
      onCreated();
      onClose();
      setForm({ name: '', value: '', stageId: defaultStageId || stages[0]?.id || '', userId: user?.id || '', contactId: '', tags: '' });
    } catch {
      toast('Erro ao criar lead', 'error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Novo Lead">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input label="Nome do lead *" value={form.name} onChange={(e) => handleChange('name', e.target.value)} required placeholder="Ex: Financiamento Imobiliário - João Silva" />

        <div className="grid grid-cols-2 gap-3">
          <Input label="Valor (R$)" type="number" value={form.value} onChange={(e) => handleChange('value', e.target.value)} placeholder="0,00" />
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-slate-700">Estágio</label>
            <select value={form.stageId} onChange={(e) => handleChange('stageId', e.target.value)} className="w-full px-3 py-2 text-sm border border-af-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-af-accent">
              {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-slate-700">Responsável</label>
          <select value={form.userId} onChange={(e) => handleChange('userId', e.target.value)} className="w-full px-3 py-2 text-sm border border-af-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-af-accent">
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-slate-700">Contato</label>
          <select value={form.contactId} onChange={(e) => handleChange('contactId', e.target.value)} className="w-full px-3 py-2 text-sm border border-af-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-af-accent">
            <option value="">Selecionar contato...</option>
            {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>

        <Input label="Tags (separadas por vírgula)" value={form.tags} onChange={(e) => handleChange('tags', e.target.value)} placeholder="imobiliário, prioritário" />

        <div className="flex gap-3 pt-2">
          <Button type="button" variant="secondary" onClick={onClose} className="flex-1">Cancelar</Button>
          <Button type="submit" loading={loading} className="flex-1">Criar Lead</Button>
        </div>
      </form>
    </Modal>
  );
}
