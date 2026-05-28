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

  const emptyForm = () => ({
    name: '',
    value: '',
    stageId: defaultStageId || stages[0]?.id || '',
    userId: user?.id || '',
    contactId: '',
    // Campos principais do card
    participante_1: '',
    telefone_1: '',
    cpf_1: '',
    participante_2: '',
    telefone_2: '',
  });

  const [form, setForm] = useState(emptyForm());
  const [loading, setLoading] = useState(false);

  function handleChange(field: string, value: string) {
    setForm(prev => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.participante_1.trim() && !form.name.trim()) {
      toast('Informe o nome do participante 1', 'error');
      return;
    }
    setLoading(true);
    try {
      const leadName = form.participante_1.trim() || form.name.trim();

      // Monta customFields com os campos preenchidos
      const customFields: Record<string, string> = {};
      if (form.participante_1.trim()) customFields.participante_1 = form.participante_1.trim();
      if (form.telefone_1.trim()) customFields.telefone_1 = form.telefone_1.trim();
      if (form.cpf_1.trim()) customFields.cpf_1 = form.cpf_1.trim();
      if (form.participante_2.trim()) customFields.participante_2 = form.participante_2.trim();
      if (form.telefone_2.trim()) customFields.telefone_2 = form.telefone_2.trim();

      await api.post('/api/leads', {
        name: leadName,
        value: form.value ? Number(form.value) : undefined,
        stageId: form.stageId,
        pipelineId,
        userId: form.userId,
        contactId: form.contactId || undefined,
        customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
      });
      toast('Lead criado com sucesso!');
      onCreated();
      onClose();
      setForm(emptyForm());
    } catch {
      toast('Erro ao criar lead', 'error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Novo Lead">
      <form onSubmit={handleSubmit} className="space-y-4">

        {/* Participante 1 */}
        <div className="rounded-xl border border-af-border p-4 space-y-3 bg-af-light/40">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Participante 1</p>
          <Input
            label="Nome *"
            value={form.participante_1}
            onChange={e => handleChange('participante_1', e.target.value)}
            placeholder="Nome completo"
          />
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Telefone"
              type="tel"
              value={form.telefone_1}
              onChange={e => handleChange('telefone_1', e.target.value)}
              placeholder="(61) 99999-0000"
            />
            <Input
              label="CPF"
              value={form.cpf_1}
              onChange={e => handleChange('cpf_1', e.target.value)}
              placeholder="000.000.000-00"
            />
          </div>
        </div>

        {/* Participante 2 (opcional) */}
        <div className="rounded-xl border border-af-border p-4 space-y-3">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Participante 2 (opcional)</p>
          <Input
            label="Nome"
            value={form.participante_2}
            onChange={e => handleChange('participante_2', e.target.value)}
            placeholder="Nome completo"
          />
          <Input
            label="Telefone"
            type="tel"
            value={form.telefone_2}
            onChange={e => handleChange('telefone_2', e.target.value)}
            placeholder="(61) 99999-0000"
          />
        </div>

        {/* Estágio + Responsável */}
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-slate-700">Estágio</label>
            <select
              value={form.stageId}
              onChange={e => handleChange('stageId', e.target.value)}
              className="w-full px-3 py-2 text-sm border border-af-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-af-accent"
            >
              {stages.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-slate-700">Responsável</label>
            <select
              value={form.userId}
              onChange={e => handleChange('userId', e.target.value)}
              className="w-full px-3 py-2 text-sm border border-af-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-af-accent"
            >
              {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
        </div>

        {/* Valor (opcional) */}
        <Input
          label="Valor do crédito (R$)"
          type="number"
          value={form.value}
          onChange={e => handleChange('value', e.target.value)}
          placeholder="Ex: 250000"
        />

        <div className="flex gap-3 pt-2">
          <Button type="button" variant="secondary" onClick={onClose} className="flex-1">Cancelar</Button>
          <Button type="submit" loading={loading} className="flex-1">Criar Lead</Button>
        </div>
      </form>
    </Modal>
  );
}
