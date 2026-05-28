'use client';
import { useState, useEffect } from 'react';
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

const VINCULO_OPTIONS = ['CLT', 'Autônomo', 'Empresário', 'Aposentado', 'Servidor Público', 'Profissional Liberal', 'Outro'];

function maskPhone(value: string): string {
  const d = value.replace(/\D/g, '').slice(0, 11);
  if (d.length <= 10) return d.replace(/(\d{2})(\d{4})(\d{0,4})/, '($1) $2-$3').replace(/-$/, '');
  return d.replace(/(\d{2})(\d{5})(\d{0,4})/, '($1) $2-$3').replace(/-$/, '');
}

function parseBRNumber(raw: string): number {
  const clean = raw.trim().replace(/\./g, '').replace(',', '.');
  const n = parseFloat(clean);
  return isNaN(n) ? 0 : n;
}

export function LeadModal({ open, onClose, onCreated, stages, pipelineId, defaultStageId, contacts, users }: LeadModalProps) {
  const { user } = useAuthStore();

  const emptyForm = () => ({
    stageId: defaultStageId || stages[0]?.id || '',
    userId: user?.id || '',
    // Participante 1
    participante_1: '',
    telefone_1: '',
    cpf_1: '',
    nascimento_1: '',
    renda_1: '',
    email_1: '',
    vinculo_1: '',
    // Participante 2
    participante_2: '',
    telefone_2: '',
    cpf_2: '',
    nascimento_2: '',
    renda_2: '',
    email_2: '',
    vinculo_2: '',
    // Valores
    valor_imovel: '',
    valor_credito: '',
    valor_entrada: '',
  });

  const [form, setForm] = useState(emptyForm());
  const [loading, setLoading] = useState(false);

  // Reset when modal opens with possibly different defaultStageId
  useEffect(() => {
    if (open) setForm(emptyForm());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultStageId]);

  function handleChange(field: string, value: string) {
    setForm(prev => {
      // Aplica máscara nos campos de telefone
      const next = { ...prev, [field]: (field === 'telefone_1' || field === 'telefone_2') ? maskPhone(value) : value };

      // ── Cálculo triangular: imóvel = crédito + entrada ──
      // Quaisquer dois campos preenchidos calculam o terceiro automaticamente
      if (field === 'valor_imovel' || field === 'valor_credito' || field === 'valor_entrada') {
        const imovel  = parseBRNumber(field === 'valor_imovel'  ? value : prev.valor_imovel);
        const credito = parseBRNumber(field === 'valor_credito' ? value : prev.valor_credito);
        const entrada = parseBRNumber(field === 'valor_entrada' ? value : prev.valor_entrada);

        if (field === 'valor_imovel') {
          // Imóvel mudou: se crédito preenchido → calcula entrada; senão se entrada preenchida → calcula crédito
          if (value && prev.valor_credito) {
            next.valor_entrada = String(Math.max(0, imovel - credito));
          } else if (value && prev.valor_entrada) {
            next.valor_credito = String(Math.max(0, imovel - entrada));
          }
        } else if (field === 'valor_credito') {
          // Crédito mudou: se imóvel preenchido → calcula entrada; senão se entrada preenchida → calcula imóvel
          if (value && prev.valor_imovel) {
            next.valor_entrada = String(Math.max(0, imovel - credito));
          } else if (value && prev.valor_entrada) {
            next.valor_imovel = String(entrada + credito);
          }
        } else if (field === 'valor_entrada') {
          // Entrada mudou: se crédito preenchido → calcula imóvel; senão se imóvel preenchido → calcula crédito
          if (value && prev.valor_credito) {
            next.valor_imovel = String(entrada + credito);
          } else if (value && prev.valor_imovel) {
            next.valor_credito = String(Math.max(0, imovel - entrada));
          }
        }
      }

      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.participante_1.trim()) {
      toast('Informe o nome do Participante 1', 'error');
      return;
    }
    setLoading(true);
    try {
      const p1 = form.participante_1.trim();
      const p2 = form.participante_2.trim();
      const leadName = p2 ? `${p1} / ${p2}` : p1;

      const customFields: Record<string, string> = {};
      const set = (k: string, v: string) => { if (v.trim()) customFields[k] = v.trim(); };

      set('participante_1', p1);
      set('telefone_1', form.telefone_1);
      set('cpf_1', form.cpf_1);
      set('nascimento_1', form.nascimento_1);
      set('renda_1', form.renda_1);
      set('email_1', form.email_1);
      set('vinculo_1', form.vinculo_1);

      if (p2) {
        set('participante_2', p2);
        set('telefone_2', form.telefone_2);
        set('cpf_2', form.cpf_2);
        set('nascimento_2', form.nascimento_2);
        set('renda_2', form.renda_2);
        set('email_2', form.email_2);
        set('vinculo_2', form.vinculo_2);
      }

      set('valor_imovel', form.valor_imovel);
      set('valor_credito', form.valor_credito);
      set('valor_entrada', form.valor_entrada);

      const creditoNum = parseBRNumber(form.valor_credito);

      await api.post('/api/leads', {
        name: leadName,
        value: creditoNum > 0 ? creditoNum : undefined,
        stageId: form.stageId,
        pipelineId,
        userId: form.userId,
        customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
      });
      toast('Lead criado com sucesso!');
      onCreated();
      onClose();
    } catch {
      toast('Erro ao criar lead', 'error');
    } finally {
      setLoading(false);
    }
  }

  const labelCls = 'text-sm font-medium text-slate-700 mb-1 block';
  const selectCls = 'w-full px-3 py-2 text-sm border border-af-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-af-accent';

  return (
    <Modal open={open} onClose={onClose} title="Novo Lead">
      <form onSubmit={handleSubmit} className="space-y-5 max-h-[75vh] overflow-y-auto pr-1 scrollbar-thin">

        {/* ── Participante 1 ── */}
        <section className="rounded-xl border border-af-border p-4 space-y-3 bg-af-light/40">
          <p className="text-xs font-semibold text-af-mid uppercase tracking-wider">Participante 1 *</p>

          <Input
            label="Nome completo *"
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

          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Data de nascimento"
              type="date"
              value={form.nascimento_1}
              onChange={e => handleChange('nascimento_1', e.target.value)}
            />
            <Input
              label="Renda mensal (R$)"
              type="text"
              inputMode="numeric"
              value={form.renda_1}
              onChange={e => handleChange('renda_1', e.target.value)}
              placeholder="Ex: 5000"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Input
              label="E-mail"
              type="email"
              value={form.email_1}
              onChange={e => handleChange('email_1', e.target.value)}
              placeholder="email@exemplo.com"
            />
            <div>
              <label className={labelCls}>Tipo de vínculo</label>
              <select
                value={form.vinculo_1}
                onChange={e => handleChange('vinculo_1', e.target.value)}
                className={selectCls}
              >
                <option value="">Selecione</option>
                {VINCULO_OPTIONS.map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>
          </div>
        </section>

        {/* ── Participante 2 ── */}
        <section className="rounded-xl border border-af-border p-4 space-y-3">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Participante 2 (opcional)</p>

          <Input
            label="Nome completo"
            value={form.participante_2}
            onChange={e => handleChange('participante_2', e.target.value)}
            placeholder="Nome completo"
          />

          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Telefone"
              type="tel"
              value={form.telefone_2}
              onChange={e => handleChange('telefone_2', e.target.value)}
              placeholder="(61) 99999-0000"
            />
            <Input
              label="CPF"
              value={form.cpf_2}
              onChange={e => handleChange('cpf_2', e.target.value)}
              placeholder="000.000.000-00"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Data de nascimento"
              type="date"
              value={form.nascimento_2}
              onChange={e => handleChange('nascimento_2', e.target.value)}
            />
            <Input
              label="Renda mensal (R$)"
              type="text"
              inputMode="numeric"
              value={form.renda_2}
              onChange={e => handleChange('renda_2', e.target.value)}
              placeholder="Ex: 5000"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Input
              label="E-mail"
              type="email"
              value={form.email_2}
              onChange={e => handleChange('email_2', e.target.value)}
              placeholder="email@exemplo.com"
            />
            <div>
              <label className={labelCls}>Tipo de vínculo</label>
              <select
                value={form.vinculo_2}
                onChange={e => handleChange('vinculo_2', e.target.value)}
                className={selectCls}
              >
                <option value="">Selecione</option>
                {VINCULO_OPTIONS.map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>
          </div>
        </section>

        {/* ── Valores em destaque ── */}
        <section className="rounded-xl border-2 border-af-mid/30 p-4 space-y-3 bg-af-light/20">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-af-mid uppercase tracking-wider">Valores</p>
            <span className="text-xs text-slate-400 italic">Preencha 2 campos → o 3º é calculado</span>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <Input
              label="Valor do imóvel (R$)"
              type="text"
              inputMode="numeric"
              value={form.valor_imovel}
              onChange={e => handleChange('valor_imovel', e.target.value)}
              placeholder="Ex: 300000"
            />
            <Input
              label="Valor do crédito (R$)"
              type="text"
              inputMode="numeric"
              value={form.valor_credito}
              onChange={e => handleChange('valor_credito', e.target.value)}
              placeholder="Ex: 250000"
            />
            <Input
              label="Valor de entrada (R$)"
              type="text"
              inputMode="numeric"
              value={form.valor_entrada}
              onChange={e => handleChange('valor_entrada', e.target.value)}
              placeholder="Ex: 50000"
            />
          </div>
        </section>

        {/* ── Estágio + Responsável ── */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Estágio</label>
            <select
              value={form.stageId}
              onChange={e => handleChange('stageId', e.target.value)}
              className={selectCls}
            >
              {stages.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>Responsável</label>
            <select
              value={form.userId}
              onChange={e => handleChange('userId', e.target.value)}
              className={selectCls}
            >
              {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
        </div>

        <div className="flex gap-3 pt-1 sticky bottom-0 bg-white pb-1">
          <Button type="button" variant="secondary" onClick={onClose} className="flex-1">Cancelar</Button>
          <Button type="submit" loading={loading} className="flex-1">Criar Lead</Button>
        </div>
      </form>
    </Modal>
  );
}
