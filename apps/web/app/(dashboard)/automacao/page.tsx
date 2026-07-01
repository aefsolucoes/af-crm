'use client';
import { useState } from 'react';
import { Topbar } from '@/components/ui/topbar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { toast } from '@/components/ui/toast';
import { Plus, Trash2, Edit2, Zap, ToggleLeft, ToggleRight, Clock, GitBranch, MessageSquare, ArrowRight } from 'lucide-react';

type TriggerType = 'new_lead' | 'stage_change' | 'tag_added' | 'inactivity' | 'message_received' | 'form_submitted';
type ActionType = 'send_message' | 'send_template' | 'assign_agent' | 'move_stage' | 'add_tag' | 'start_salesbot' | 'webhook';

interface AutomationRule {
  id: string;
  name: string;
  active: boolean;
  trigger: TriggerType;
  triggerConfig: Record<string, string>;
  actions: { type: ActionType; config: Record<string, string> }[];
  createdAt: string;
  executionCount: number;
}

const TRIGGER_META: Record<TriggerType, { label: string; icon: React.ReactNode; color: string }> = {
  new_lead: { label: 'Novo lead criado', icon: <Plus size={13} />, color: 'text-green-600 bg-green-50' },
  stage_change: { label: 'Mudança de estágio', icon: <ArrowRight size={13} />, color: 'text-blue-600 bg-blue-50' },
  tag_added: { label: 'Tag adicionada', icon: <GitBranch size={13} />, color: 'text-purple-600 bg-purple-50' },
  inactivity: { label: 'Inatividade do lead', icon: <Clock size={13} />, color: 'text-orange-600 bg-orange-50' },
  message_received: { label: 'Mensagem recebida', icon: <MessageSquare size={13} />, color: 'text-cyan-600 bg-cyan-50' },
  form_submitted: { label: 'Formulário enviado', icon: <Zap size={13} />, color: 'text-yellow-600 bg-yellow-50' },
};

const ACTION_META: Record<ActionType, { label: string }> = {
  send_message: { label: 'Enviar mensagem' },
  send_template: { label: 'Usar template' },
  assign_agent: { label: 'Atribuir agente' },
  move_stage: { label: 'Mover estágio' },
  add_tag: { label: 'Adicionar tag' },
  start_salesbot: { label: 'Iniciar Salesbot' },
  webhook: { label: 'Disparar webhook' },
};

const INITIAL_RULES: AutomationRule[] = [
  {
    id: 'r1',
    name: 'Boas-vindas para novos leads',
    active: true,
    trigger: 'new_lead',
    triggerConfig: {},
    actions: [
      { type: 'send_template', config: { templateId: 'Boas-vindas inicial' } },
      { type: 'assign_agent', config: { agentId: 'round_robin' } },
    ],
    createdAt: '2024-01-01',
    executionCount: 142,
  },
  {
    id: 'r2',
    name: 'Follow-up após 3 dias de inatividade',
    active: true,
    trigger: 'inactivity',
    triggerConfig: { days: '3' },
    actions: [
      { type: 'send_template', config: { templateId: 'Follow-up de proposta' } },
    ],
    createdAt: '2024-01-10',
    executionCount: 38,
  },
  {
    id: 'r3',
    name: 'Iniciar bot ao mudar para "Qualificação"',
    active: false,
    trigger: 'stage_change',
    triggerConfig: { stage: 'Qualificação' },
    actions: [
      { type: 'start_salesbot', config: { botId: 'Bot de Qualificação' } },
    ],
    createdAt: '2024-02-01',
    executionCount: 0,
  },
];

const EMPTY_FORM = {
  name: '',
  trigger: 'new_lead' as TriggerType,
  triggerConfig: {} as Record<string, string>,
  actions: [{ type: 'send_message' as ActionType, config: {} as Record<string, string> }],
};

export default function AutomacaoPage() {
  const [rules, setRules] = useState<AutomationRule[]>(INITIAL_RULES);
  const [showModal, setShowModal] = useState(false);
  const [editingRule, setEditingRule] = useState<AutomationRule | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);

  function openNew() {
    setEditingRule(null);
    setForm(EMPTY_FORM);
    setShowModal(true);
  }

  function openEdit(r: AutomationRule) {
    setEditingRule(r);
    setForm({ name: r.name, trigger: r.trigger, triggerConfig: { ...r.triggerConfig }, actions: r.actions.map(a => ({ ...a, config: { ...a.config } })) });
    setShowModal(true);
  }

  function addAction() {
    setForm({ ...form, actions: [...form.actions, { type: 'send_message', config: {} }] });
  }

  function removeAction(i: number) {
    setForm({ ...form, actions: form.actions.filter((_, j) => j !== i) });
  }

  function updateAction(i: number, type: ActionType) {
    const actions = [...form.actions];
    actions[i] = { type, config: {} };
    setForm({ ...form, actions });
  }

  function updateActionConfig(i: number, key: string, value: string) {
    const actions = [...form.actions];
    actions[i] = { ...actions[i], config: { ...actions[i].config, [key]: value } };
    setForm({ ...form, actions });
  }

  function handleSave() {
    if (!form.name.trim()) { toast('Informe um nome para a automação.', 'warning'); return; }
    if (editingRule) {
      setRules(rules.map(r => r.id === editingRule.id ? { ...r, ...form } : r));
      toast('Automação atualizada!');
    } else {
      setRules([...rules, { id: `r-${Date.now()}`, ...form, active: true, createdAt: new Date().toISOString().split('T')[0], executionCount: 0 }]);
      toast('Automação criada!');
    }
    setShowModal(false);
  }

  function handleDelete(id: string) {
    setRules(rules.filter(r => r.id !== id));
    toast('Automação removida.');
  }

  function handleToggle(id: string) {
    setRules(rules.map(r => r.id === id ? { ...r, active: !r.active } : r));
  }

  const activeCount = rules.filter(r => r.active).length;

  return (
    <div className="flex flex-col h-full">
      <Topbar title="Automações" subtitle="Regras automáticas de mensagens e ações" />

      <div className="flex-1 overflow-y-auto p-6">
        {/* Stats */}
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="bg-af-light rounded-xl p-4">
            <p className="text-2xl font-bold text-af-accent">{rules.length}</p>
            <p className="text-xs font-medium text-slate-500 mt-1">Total de automações</p>
          </div>
          <div className="bg-green-50 rounded-xl p-4">
            <p className="text-2xl font-bold text-green-700">{activeCount}</p>
            <p className="text-xs font-medium text-slate-500 mt-1">Ativas</p>
          </div>
          <div className="bg-blue-50 rounded-xl p-4">
            <p className="text-2xl font-bold text-blue-700">{rules.reduce((acc, r) => acc + r.executionCount, 0)}</p>
            <p className="text-xs font-medium text-slate-500 mt-1">Execuções totais</p>
          </div>
        </div>

        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-slate-900">Regras de automação</h2>
          <Button onClick={openNew}><Plus size={15} /> Nova automação</Button>
        </div>

        <div className="space-y-3">
          {rules.map(r => {
            const tm = TRIGGER_META[r.trigger];
            return (
              <div key={r.id} className={`bg-white rounded-xl border shadow-sm transition-all ${r.active ? 'border-af-border' : 'border-af-border opacity-60'}`}>
                <div className="flex items-center gap-4 p-4">
                  <div className={`p-2 rounded-lg ${tm.color}`}>{tm.icon}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-slate-900">{r.name}</h3>
                      {!r.active && <span className="text-xs bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full">Pausada</span>}
                    </div>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${tm.color}`}>
                        Quando: {tm.label}
                      </span>
                      <span className="text-slate-300">→</span>
                      <div className="flex items-center gap-1 flex-wrap">
                        {r.actions.map((a, i) => (
                          <span key={i} className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">
                            {ACTION_META[a.type].label}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <div className="text-right">
                      <p className="text-sm font-semibold text-slate-900">{r.executionCount}</p>
                      <p className="text-xs text-slate-400">execuções</p>
                    </div>
                    <button onClick={() => handleToggle(r.id)} className={`transition-colors ${r.active ? 'text-green-500 hover:text-green-700' : 'text-slate-300 hover:text-slate-500'}`} title={r.active ? 'Pausar' : 'Ativar'}>
                      {r.active ? <ToggleRight size={22} /> : <ToggleLeft size={22} />}
                    </button>
                    <button onClick={() => openEdit(r)} className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors">
                      <Edit2 size={14} />
                    </button>
                    <button onClick={() => handleDelete(r.id)} className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}

          {rules.length === 0 && (
            <div className="text-center py-16 text-slate-400">
              <Zap size={32} className="mx-auto mb-3 opacity-30" />
              <p className="text-sm">Nenhuma automação criada</p>
              <Button className="mt-4" onClick={openNew}><Plus size={14} /> Criar primeira automação</Button>
            </div>
          )}
        </div>
      </div>

      {/* Modal */}
      {showModal && (
        <Modal title={editingRule ? 'Editar automação' : 'Nova automação'} onClose={() => setShowModal(false)}>
          <div className="space-y-5">
            <Input label="Nome da automação" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Ex: Boas-vindas para novos leads" />

            {/* Trigger */}
            <div className="flex flex-col gap-2">
              <label className="text-sm font-semibold text-slate-700 flex items-center gap-2"><Zap size={14} className="text-af-accent" /> Gatilho (quando acontecer)</label>
              <div className="grid grid-cols-2 gap-2">
                {(Object.keys(TRIGGER_META) as TriggerType[]).map(t => {
                  const tm = TRIGGER_META[t];
                  return (
                    <button
                      key={t}
                      onClick={() => setForm({ ...form, trigger: t, triggerConfig: {} })}
                      className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border-2 text-xs font-medium transition-colors text-left ${form.trigger === t ? 'border-af-accent bg-af-light' : 'border-af-border hover:border-af-mid'}`}
                    >
                      <span className={`p-1 rounded ${tm.color}`}>{tm.icon}</span>
                      {tm.label}
                    </button>
                  );
                })}
              </div>

              {form.trigger === 'inactivity' && (
                <Input
                  label="Dias de inatividade"
                  type="number"
                  value={form.triggerConfig.days || '3'}
                  onChange={e => setForm({ ...form, triggerConfig: { ...form.triggerConfig, days: e.target.value } })}
                />
              )}
              {form.trigger === 'stage_change' && (
                <Input
                  label="Nome do estágio"
                  value={form.triggerConfig.stage || ''}
                  onChange={e => setForm({ ...form, triggerConfig: { ...form.triggerConfig, stage: e.target.value } })}
                  placeholder="Ex: Qualificação"
                />
              )}
              {form.trigger === 'tag_added' && (
                <Input
                  label="Tag"
                  value={form.triggerConfig.tag || ''}
                  onChange={e => setForm({ ...form, triggerConfig: { ...form.triggerConfig, tag: e.target.value } })}
                  placeholder="nome-da-tag"
                />
              )}
            </div>

            {/* Actions */}
            <div className="flex flex-col gap-2">
              <label className="text-sm font-semibold text-slate-700 flex items-center gap-2"><ArrowRight size={14} className="text-af-accent" /> Ações (o que fazer)</label>
              {form.actions.map((action, i) => (
                <div key={i} className="p-3 bg-slate-50 border border-af-border rounded-lg space-y-2">
                  <div className="flex items-center gap-2">
                    <select
                      value={action.type}
                      onChange={e => updateAction(i, e.target.value as ActionType)}
                      className="flex-1 px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent bg-white"
                    >
                      {(Object.keys(ACTION_META) as ActionType[]).map(a => (
                        <option key={a} value={a}>{ACTION_META[a].label}</option>
                      ))}
                    </select>
                    {form.actions.length > 1 && (
                      <button onClick={() => removeAction(i)} className="p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg">
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>

                  {action.type === 'send_message' && (
                    <textarea
                      value={action.config.message || ''}
                      onChange={e => updateActionConfig(i, 'message', e.target.value)}
                      placeholder="Mensagem a enviar..."
                      className="w-full px-3 py-2 text-sm border border-af-border rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-af-accent"
                      rows={3}
                    />
                  )}
                  {action.type === 'send_template' && (
                    <input
                      value={action.config.templateId || ''}
                      onChange={e => updateActionConfig(i, 'templateId', e.target.value)}
                      placeholder="Nome ou ID do template"
                      className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
                    />
                  )}
                  {action.type === 'assign_agent' && (
                    <input
                      value={action.config.agentId || ''}
                      onChange={e => updateActionConfig(i, 'agentId', e.target.value)}
                      placeholder="ID do agente ou 'round_robin'"
                      className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
                    />
                  )}
                  {action.type === 'move_stage' && (
                    <input
                      value={action.config.stage || ''}
                      onChange={e => updateActionConfig(i, 'stage', e.target.value)}
                      placeholder="Nome do estágio destino"
                      className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
                    />
                  )}
                  {action.type === 'add_tag' && (
                    <input
                      value={action.config.tag || ''}
                      onChange={e => updateActionConfig(i, 'tag', e.target.value)}
                      placeholder="nome-da-tag"
                      className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
                    />
                  )}
                  {action.type === 'start_salesbot' && (
                    <input
                      value={action.config.botId || ''}
                      onChange={e => updateActionConfig(i, 'botId', e.target.value)}
                      placeholder="Nome ou ID do Salesbot"
                      className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
                    />
                  )}
                  {action.type === 'webhook' && (
                    <input
                      value={action.config.url || ''}
                      onChange={e => updateActionConfig(i, 'url', e.target.value)}
                      placeholder="https://..."
                      className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
                    />
                  )}
                </div>
              ))}
              <button onClick={addAction} className="flex items-center gap-1.5 text-xs text-af-accent hover:text-af-mid font-medium self-start">
                <Plus size={13} /> Adicionar ação
              </button>
            </div>
          </div>

          <div className="flex justify-end gap-2 mt-6 pt-4 border-t border-af-border">
            <Button variant="ghost" onClick={() => setShowModal(false)}>Cancelar</Button>
            <Button onClick={handleSave}>{editingRule ? 'Salvar alterações' : 'Criar automação'}</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
