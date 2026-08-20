'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { BookOpen, Plus, Trash2, Loader2, ChevronDown, ChevronRight } from 'lucide-react';

interface AgentPlaybook {
  id: string;
  domain: string;
  title: string;
  steps: string;
  active: boolean;
  sourceTaskId?: string | null;
  updatedAt: string;
}

async function fetchPlaybooks(): Promise<AgentPlaybook[]> {
  const { data } = await api.get('/api/browser-agent/playbooks');
  return data;
}

const EMPTY_FORM = { domain: '', title: '', steps: '' };

/** Aba "Guias" do Agente de Navegador — memória de como navegar cada site,
 *  gerada automaticamente a partir de tarefas concluídas (botão "Guardar
 *  como guia" na aba Tarefas) ou escrita à mão aqui. 100% editável — é
 *  exatamente o "lugar pra orientar/corrigir" que a IA usa como guia nas
 *  próximas tarefas do mesmo site (ver buildSystemPromptForTask no backend). */
export function PlaybooksTab() {
  const queryClient = useQueryClient();
  const { data: playbooks, isLoading } = useQuery({ queryKey: ['browser-agent-playbooks'], queryFn: fetchPlaybooks });

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['browser-agent-playbooks'] });
  }

  function openEdit(p: AgentPlaybook) {
    setCreating(false);
    setExpandedId(p.id === expandedId ? null : p.id);
    setForm({ domain: p.domain, title: p.title, steps: p.steps });
  }

  function openNew() {
    setExpandedId(null);
    setCreating((c) => !c);
    setForm(EMPTY_FORM);
  }

  async function handleSaveNew() {
    if (!form.domain.trim() || !form.title.trim() || !form.steps.trim()) {
      toast('Preencha domínio, título e o passo a passo.', 'warning');
      return;
    }
    setSaving(true);
    try {
      await api.post('/api/browser-agent/playbooks', form);
      toast('Guia criado!');
      setCreating(false);
      setForm(EMPTY_FORM);
      invalidate();
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao criar o guia', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveEdit(id: string) {
    setSaving(true);
    try {
      await api.patch(`/api/browser-agent/playbooks/${id}`, form);
      toast('Guia atualizado!');
      setExpandedId(null);
      invalidate();
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao salvar o guia', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleActive(p: AgentPlaybook) {
    try {
      await api.patch(`/api/browser-agent/playbooks/${p.id}`, { active: !p.active });
      invalidate();
    } catch {
      toast('Erro ao atualizar o guia', 'error');
    }
  }

  async function handleDelete(id: string) {
    try {
      await api.delete(`/api/browser-agent/playbooks/${id}`);
      toast('Guia excluído.');
      setExpandedId(null);
      invalidate();
    } catch {
      toast('Erro ao excluir o guia', 'error');
    }
  }

  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin px-6 py-4">
      <div className="max-w-3xl mx-auto flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <p className="text-xs text-slate-500">
            Memória de como o agente navega cada site — gerada automaticamente ao concluir uma tarefa (botão "Guardar como guia") ou escrita aqui do zero. Edite pra corrigir o que o agente entendeu errado (ex.: "isso é pra selecionar, não digitar" ou "esse dado muda por cliente").
          </p>
          <button
            onClick={openNew}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-af-mid text-white text-xs font-medium hover:bg-af-dark flex-shrink-0"
          >
            <Plus size={14} /> Novo guia
          </button>
        </div>

        {creating && (
          <div className="border border-af-accent/40 rounded-xl bg-af-light p-4 flex flex-col gap-2.5">
            <div className="grid grid-cols-2 gap-2.5">
              <input
                value={form.domain}
                onChange={(e) => setForm({ ...form, domain: e.target.value })}
                placeholder="Domínio (ex.: ridigital.org.br)"
                className="px-3 py-2 text-sm border border-af-border rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-af-accent"
              />
              <input
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="Título (ex.: Emitir certidão de ônus)"
                className="px-3 py-2 text-sm border border-af-border rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-af-accent"
              />
            </div>
            <textarea
              value={form.steps}
              onChange={(e) => setForm({ ...form, steps: e.target.value })}
              placeholder="Passo a passo..."
              rows={8}
              className="px-3 py-2 text-sm border border-af-border rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-af-accent font-mono"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setCreating(false)} className="text-xs text-slate-500 hover:text-slate-700 px-3 py-2">Cancelar</button>
              <button
                onClick={handleSaveNew}
                disabled={saving}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-af-mid text-white text-xs font-medium hover:bg-af-dark disabled:opacity-50"
              >
                {saving && <Loader2 size={13} className="animate-spin" />} Criar guia
              </button>
            </div>
          </div>
        )}

        {isLoading ? (
          <p className="text-sm text-slate-400 text-center py-8">Carregando…</p>
        ) : (playbooks || []).length === 0 ? (
          <div className="flex flex-col items-center justify-center text-slate-400 text-sm gap-2 py-16">
            <BookOpen size={28} className="opacity-40" />
            <p>Nenhum guia ainda.</p>
            <p className="text-xs opacity-70">Conclua uma tarefa na aba Tarefas e clique em "Guardar como guia".</p>
          </div>
        ) : (
          (playbooks || []).map((p) => {
            const expanded = expandedId === p.id;
            return (
              <div key={p.id} className={cn('border rounded-xl overflow-hidden', expanded ? 'border-af-accent/40' : 'border-af-border')}>
                <button
                  onClick={() => openEdit(p)}
                  className="w-full flex items-center gap-2.5 px-4 py-3 hover:bg-af-light transition-colors text-left"
                >
                  {expanded ? <ChevronDown size={15} className="text-slate-400 flex-shrink-0" /> : <ChevronRight size={15} className="text-slate-400 flex-shrink-0" />}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-800 truncate">{p.title}</p>
                    <p className="text-xs text-slate-400 truncate">{p.domain}</p>
                  </div>
                  <span
                    onClick={(e) => { e.stopPropagation(); handleToggleActive(p); }}
                    className={cn(
                      'text-xs px-2 py-1 rounded-full font-medium flex-shrink-0',
                      p.active ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-400'
                    )}
                  >
                    {p.active ? 'Ativo' : 'Inativo'}
                  </span>
                </button>
                {expanded && (
                  <div className="border-t border-af-border p-4 flex flex-col gap-2.5 bg-white">
                    <div className="grid grid-cols-2 gap-2.5">
                      <input
                        value={form.domain}
                        onChange={(e) => setForm({ ...form, domain: e.target.value })}
                        className="px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-1 focus:ring-af-accent"
                      />
                      <input
                        value={form.title}
                        onChange={(e) => setForm({ ...form, title: e.target.value })}
                        className="px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-1 focus:ring-af-accent"
                      />
                    </div>
                    <textarea
                      value={form.steps}
                      onChange={(e) => setForm({ ...form, steps: e.target.value })}
                      rows={10}
                      className="px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-1 focus:ring-af-accent font-mono"
                    />
                    <div className="flex justify-between gap-2">
                      <button
                        onClick={() => handleDelete(p.id)}
                        className="flex items-center gap-1.5 text-xs text-red-500 hover:text-red-600 px-3 py-2"
                      >
                        <Trash2 size={13} /> Excluir
                      </button>
                      <button
                        onClick={() => handleSaveEdit(p.id)}
                        disabled={saving}
                        className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-af-mid text-white text-xs font-medium hover:bg-af-dark disabled:opacity-50"
                      >
                        {saving && <Loader2 size={13} className="animate-spin" />} Salvar
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
