'use client';
import { useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Topbar } from '@/components/ui/topbar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { toast } from '@/components/ui/toast';
import api from '@/lib/api';
import { Plus, Trash2, Edit2, Zap, ToggleLeft, ToggleRight, Clock, GitBranch, MessageSquare, ArrowRight } from 'lucide-react';

type TriggerType = 'NEW_LEAD' | 'STAGE_CHANGE' | 'TAG_ADDED' | 'INACTIVITY' | 'MESSAGE_RECEIVED' | 'FORM_SUBMITTED';
type ActionType = 'send_message' | 'send_template' | 'send_email' | 'assign_agent' | 'move_stage' | 'move_stage_by_name' | 'add_note' | 'add_tag' | 'start_salesbot' | 'webhook' | 'activate_ai' | 'deactivate_ai';

interface AutomationAction { type: ActionType; config: Record<string, unknown> }

interface AutomationRule {
  id: string;
  name: string;
  active: boolean;
  trigger: TriggerType;
  triggerConfig: Record<string, unknown> | null;
  actions: AutomationAction[];
  createdAt: string;
  executionCount: number;
}

const TRIGGER_META: Record<TriggerType, { label: string; icon: React.ReactNode; color: string }> = {
  NEW_LEAD: { label: 'Novo lead criado', icon: <Plus size={13} />, color: 'text-green-600 bg-green-50' },
  STAGE_CHANGE: { label: 'Mudança de estágio', icon: <ArrowRight size={13} />, color: 'text-blue-600 bg-blue-50' },
  TAG_ADDED: { label: 'Tag adicionada', icon: <GitBranch size={13} />, color: 'text-purple-600 bg-purple-50' },
  INACTIVITY: { label: 'Inatividade do lead', icon: <Clock size={13} />, color: 'text-orange-600 bg-orange-50' },
  MESSAGE_RECEIVED: { label: 'Mensagem recebida', icon: <MessageSquare size={13} />, color: 'text-cyan-600 bg-cyan-50' },
  FORM_SUBMITTED: { label: 'Formulário do site', icon: <Zap size={13} />, color: 'text-yellow-600 bg-yellow-50' },
};
// Captação pública de lead via POST /api/webhooks/site-lead (Configurações
// → Site) — nenhum gatilho fica travado hoje.
const DISABLED_TRIGGERS: TriggerType[] = [];

const ACTION_META: Record<ActionType, { label: string }> = {
  send_message: { label: 'Enviar mensagem' },
  send_template: { label: 'Usar template' },
  send_email: { label: 'Enviar e-mail' },
  assign_agent: { label: 'Atribuir agente' },
  move_stage: { label: 'Mover estágio' },
  move_stage_by_name: { label: 'Mover pra etapa (por nome, no funil atual)' },
  add_note: { label: 'Adicionar nota' },
  add_tag: { label: 'Adicionar tag' },
  start_salesbot: { label: 'Iniciar Salesbot' },
  webhook: { label: 'Disparar webhook' },
  activate_ai: { label: 'Ativar IA (auto-resposta)' },
  deactivate_ai: { label: 'Desativar IA (auto-resposta)' },
};

// {{campo}} disponíveis na mensagem — mensagem_recebida só faz sentido
// quando o gatilho é "Mensagem recebida" (é o texto que o cliente mandou).
const BASE_VARIABLES = [
  { key: 'nome', label: 'Nome' },
  { key: 'telefone', label: 'Telefone' },
];

interface Stage { id: string; name: string; order: number }
interface Pipeline { id: string; name: string; stages: Stage[]; department?: { id: string; name: string } | null }
interface Department { id: string; name: string }
interface UserOption { id: string; name: string; email: string }
interface SalesBotOption { id: string; name: string; active: boolean }
interface MetaTemplate { name: string; status: string; language: string }

const EMPTY_FORM = {
  name: '',
  trigger: 'NEW_LEAD' as TriggerType,
  triggerConfig: {} as Record<string, unknown>,
  actions: [{ type: 'send_message' as ActionType, config: {} as Record<string, unknown> }],
};

export default function AutomacaoPage() {
  const qc = useQueryClient();
  const [showModal, setShowModal] = useState(false);
  const [editingRule, setEditingRule] = useState<AutomationRule | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);

  const { data: rules, isLoading } = useQuery({
    queryKey: ['automations'],
    queryFn: async () => (await api.get('/api/automations')).data as AutomationRule[],
  });
  const { data: pipelines } = useQuery({
    queryKey: ['pipelines'],
    queryFn: async () => (await api.get('/api/pipelines')).data as Pipeline[],
  });
  const { data: departments } = useQuery({
    queryKey: ['departments'],
    queryFn: async () => (await api.get('/api/departments')).data as { id: string; name: string }[],
  });
  const { data: users } = useQuery({
    queryKey: ['users'],
    queryFn: async () => (await api.get('/api/users')).data as UserOption[],
  });
  const { data: salesBots } = useQuery({
    queryKey: ['salesbots'],
    queryFn: async () => (await api.get('/api/salesbot')).data as SalesBotOption[],
  });
  // Sem API Oficial configurada, esse endpoint dá 400 — trata como "sem
  // templates" (fallback pra digitar o nome à mão), não deixa a tela quebrar.
  const { data: templatesData } = useQuery({
    queryKey: ['meta-templates'],
    queryFn: async () => (await api.get('/api/settings/whatsapp/templates')).data as { templates: MetaTemplate[] },
    retry: false,
    throwOnError: false,
  });
  const templates = templatesData?.templates || [];

  const createMutation = useMutation({
    mutationFn: async (data: typeof EMPTY_FORM) => (await api.post('/api/automations', data)).data,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['automations'] }); toast('Automação criada!'); setShowModal(false); },
    onError: (err: any) => toast(err?.response?.data?.error || 'Erro ao criar automação', 'error'),
  });
  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<typeof EMPTY_FORM> }) => (await api.put(`/api/automations/${id}`, data)).data,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['automations'] }); toast('Automação atualizada!'); setShowModal(false); },
    onError: (err: any) => toast(err?.response?.data?.error || 'Erro ao atualizar automação', 'error'),
  });
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => api.delete(`/api/automations/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['automations'] }); toast('Automação removida.'); },
    onError: () => toast('Erro ao remover automação', 'error'),
  });
  const toggleMutation = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => (await api.put(`/api/automations/${id}`, { active })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['automations'] }),
    onError: () => toast('Erro ao ativar/pausar automação', 'error'),
  });

  function openNew() {
    setEditingRule(null);
    setForm(EMPTY_FORM);
    setShowModal(true);
  }

  function openEdit(r: AutomationRule) {
    setEditingRule(r);
    setForm({
      name: r.name,
      trigger: r.trigger,
      triggerConfig: { ...(r.triggerConfig || {}) },
      actions: r.actions.map((a) => ({ ...a, config: { ...a.config } })),
    });
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
  function updateActionConfig(i: number, key: string, value: unknown) {
    const actions = [...form.actions];
    actions[i] = { ...actions[i], config: { ...actions[i].config, [key]: value } };
    setForm({ ...form, actions });
  }

  function handleSave() {
    if (!form.name.trim()) { toast('Informe um nome para a automação.', 'warning'); return; }
    if (editingRule) updateMutation.mutate({ id: editingRule.id, data: form });
    else createMutation.mutate(form);
  }

  const activeCount = (rules || []).filter((r) => r.active).length;
  const totalExecutions = (rules || []).reduce((acc, r) => acc + r.executionCount, 0);
  const saving = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="flex flex-col h-full">
      <Topbar title="Automações" subtitle="Regras automáticas de mensagens e ações" />

      <div className="flex-1 overflow-y-auto p-6">
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="bg-af-light rounded-xl p-4">
            <p className="text-2xl font-bold text-af-accent">{rules?.length ?? 0}</p>
            <p className="text-xs font-medium text-slate-500 mt-1">Total de automações</p>
          </div>
          <div className="bg-green-50 rounded-xl p-4">
            <p className="text-2xl font-bold text-green-700">{activeCount}</p>
            <p className="text-xs font-medium text-slate-500 mt-1">Ativas</p>
          </div>
          <div className="bg-blue-50 rounded-xl p-4">
            <p className="text-2xl font-bold text-blue-700">{totalExecutions}</p>
            <p className="text-xs font-medium text-slate-500 mt-1">Execuções totais</p>
          </div>
        </div>

        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-slate-900">Regras de automação</h2>
          <Button onClick={openNew}><Plus size={15} /> Nova automação</Button>
        </div>

        {isLoading ? (
          <div className="text-center py-16 text-sm text-slate-400">Carregando...</div>
        ) : (
          <div className="space-y-3">
            {(rules || []).map((r) => {
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
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${tm.color}`}>Quando: {tm.label}</span>
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
                      <button onClick={() => toggleMutation.mutate({ id: r.id, active: !r.active })} className={`transition-colors ${r.active ? 'text-green-500 hover:text-green-700' : 'text-slate-300 hover:text-slate-500'}`} title={r.active ? 'Pausar' : 'Ativar'}>
                        {r.active ? <ToggleRight size={22} /> : <ToggleLeft size={22} />}
                      </button>
                      <button onClick={() => openEdit(r)} className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors">
                        <Edit2 size={14} />
                      </button>
                      <button
                        onClick={() => { if (confirm(`Excluir "${r.name}"? Isso apaga o histórico de execuções também.`)) deleteMutation.mutate(r.id); }}
                        className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}

            {(rules || []).length === 0 && (
              <div className="text-center py-16 text-slate-400">
                <Zap size={32} className="mx-auto mb-3 opacity-30" />
                <p className="text-sm">Nenhuma automação criada</p>
                <Button className="mt-4" onClick={openNew}><Plus size={14} /> Criar primeira automação</Button>
              </div>
            )}
          </div>
        )}
      </div>

      {showModal && (
        <Modal title={editingRule ? 'Editar automação' : 'Nova automação'} onClose={() => setShowModal(false)} size="lg">
          <div className="space-y-5">
            <Input label="Nome da automação" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ex: Boas-vindas para novos leads" />

            <div className="flex flex-col gap-2">
              <label className="text-sm font-semibold text-slate-700 flex items-center gap-2"><Zap size={14} className="text-af-accent" /> Gatilho (quando acontecer)</label>
              <div className="grid grid-cols-2 gap-2">
                {(Object.keys(TRIGGER_META) as TriggerType[]).map((t) => {
                  const tm = TRIGGER_META[t];
                  const disabled = DISABLED_TRIGGERS.includes(t);
                  return (
                    <button
                      key={t}
                      disabled={disabled}
                      onClick={() => setForm({ ...form, trigger: t, triggerConfig: {} })}
                      className={`relative flex items-center gap-2 px-3 py-2.5 rounded-lg border-2 text-xs font-medium transition-colors text-left ${
                        disabled ? 'border-af-border opacity-50 cursor-not-allowed'
                        : form.trigger === t ? 'border-af-accent bg-af-light' : 'border-af-border hover:border-af-mid'
                      }`}
                    >
                      <span className={`p-1 rounded ${tm.color}`}>{tm.icon}</span>
                      {tm.label}
                      {disabled && <span className="absolute top-1 right-1 text-[9px] bg-slate-200 text-slate-500 px-1.5 py-0.5 rounded-full">Em breve</span>}
                    </button>
                  );
                })}
              </div>

              {form.trigger === 'INACTIVITY' && (
                <div className="space-y-2">
                  <Input
                    label="Dias de inatividade"
                    type="number"
                    min={1}
                    value={String(form.triggerConfig.days ?? '3')}
                    onChange={(e) => setForm({ ...form, triggerConfig: { ...form.triggerConfig, days: e.target.value } })}
                  />
                  <label className="flex items-center gap-2 text-xs text-slate-600">
                    <input
                      type="checkbox"
                      checked={!!form.triggerConfig.onlySiteLeads}
                      onChange={(e) => setForm({ ...form, triggerConfig: { ...form.triggerConfig, onlySiteLeads: e.target.checked || undefined } })}
                    />
                    Só leads vindos do formulário do site
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      label="Só enviar a partir de (hora)"
                      type="number"
                      min={0}
                      max={23}
                      value={String(form.triggerConfig.sendHourStart ?? '')}
                      onChange={(e) => setForm({ ...form, triggerConfig: { ...form.triggerConfig, sendHourStart: e.target.value === '' ? undefined : e.target.value } })}
                      placeholder="ex.: 8"
                    />
                    <Input
                      label="Até (hora)"
                      type="number"
                      min={0}
                      max={23}
                      value={String(form.triggerConfig.sendHourEnd ?? '')}
                      onChange={(e) => setForm({ ...form, triggerConfig: { ...form.triggerConfig, sendHourEnd: e.target.value === '' ? undefined : e.target.value } })}
                      placeholder="ex.: 10"
                    />
                  </div>
                  <p className="text-[11px] text-slate-400">
                    Deixe as horas em branco pra disparar assim que completar os dias, a qualquer hora. Preenchendo os
                    dois, só dispara dentro dessa janela (horário de Brasília) — e passa a contar por dia de
                    calendário, não 24h corridas (quem entrou de tarde ainda cai no dia seguinte de manhã).
                  </p>
                  <DepartmentStageSelect
                    pipelines={pipelines}
                    departments={departments}
                    departmentId={String(form.triggerConfig.departmentId ?? '')}
                    stageName={String(form.triggerConfig.stageName ?? '')}
                    onChangeDepartment={(id) => setForm({ ...form, triggerConfig: { ...form.triggerConfig, departmentId: id || undefined } })}
                    onChangeStage={(name) => setForm({ ...form, triggerConfig: { ...form.triggerConfig, stageName: name || undefined } })}
                    allowEmptyDepartment
                    emptyDepartmentLabel="Qualquer setor (não recomendado)"
                    helperText='Escolha o setor primeiro pra ver só as etapas dele — sem isso, a regra vale pra QUALQUER lead inativo da conta inteira, mesmo de outro setor/produto que não tem nada a ver com esse follow-up.'
                  />
                </div>
              )}
              {form.trigger === 'STAGE_CHANGE' && (
                <StageSelect
                  label="Estágio específico (opcional — deixe em branco pra qualquer mudança)"
                  pipelines={pipelines}
                  value={String(form.triggerConfig.stageId || '')}
                  onChange={(stageId) => setForm({ ...form, triggerConfig: { ...form.triggerConfig, stageId: stageId || undefined } })}
                  allowEmpty
                />
              )}
              {form.trigger === 'TAG_ADDED' && (
                <Input
                  label="Tag específica (opcional — deixe em branco pra qualquer tag)"
                  value={String(form.triggerConfig.tag || '')}
                  onChange={(e) => setForm({ ...form, triggerConfig: { ...form.triggerConfig, tag: e.target.value || undefined } })}
                  placeholder="nome-da-tag"
                />
              )}
              {form.trigger === 'FORM_SUBMITTED' && (
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-semibold text-slate-500">Setor específico (opcional — deixe em branco pra qualquer setor)</label>
                  <select
                    value={String(form.triggerConfig.departmentId || '')}
                    onChange={(e) => setForm({ ...form, triggerConfig: { ...form.triggerConfig, departmentId: e.target.value || undefined } })}
                    className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent bg-white"
                  >
                    <option value="">Qualquer setor</option>
                    {(departments || []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </select>
                  <p className="text-[11px] text-slate-400">Use isso pra mandar um template diferente por produto (ex.: Home Equity x Financiamento Habitacional) — crie uma regra por setor.</p>
                </div>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <label className="text-sm font-semibold text-slate-700 flex items-center gap-2"><ArrowRight size={14} className="text-af-accent" /> Ações (o que fazer)</label>
              {form.actions.map((action, i) => (
                <div key={i} className="p-3 bg-slate-50 border border-af-border rounded-lg space-y-2">
                  <div className="flex items-center gap-2">
                    <select
                      value={action.type}
                      onChange={(e) => updateAction(i, e.target.value as ActionType)}
                      className="flex-1 px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent bg-white"
                    >
                      {(Object.keys(ACTION_META) as ActionType[]).map((a) => (
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
                    <MessageActionFields
                      value={String(action.config.message || '')}
                      onChange={(v) => updateActionConfig(i, 'message', v)}
                      showMensagemRecebida={form.trigger === 'MESSAGE_RECEIVED'}
                    />
                  )}

                  {action.type === 'send_template' && (
                    <div className="space-y-1.5">
                      {templates.length > 0 ? (
                        <select
                          value={String(action.config.templateName || '')}
                          onChange={(e) => updateActionConfig(i, 'templateName', e.target.value)}
                          className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent bg-white"
                        >
                          <option value="">Selecione um template aprovado...</option>
                          {templates.filter((t) => t.status === 'APPROVED').map((t) => (
                            <option key={t.name} value={t.name}>{t.name} ({t.language})</option>
                          ))}
                        </select>
                      ) : (
                        <Input
                          value={String(action.config.templateName || '')}
                          onChange={(e) => updateActionConfig(i, 'templateName', e.target.value)}
                          placeholder="Nome do template aprovado na Meta"
                        />
                      )}
                      <Input
                        value={Array.isArray(action.config.bodyParams) ? (action.config.bodyParams as string[]).join(', ') : ''}
                        onChange={(e) => updateActionConfig(i, 'bodyParams', e.target.value.split(',').map((s) => s.trim()).filter(Boolean))}
                        placeholder="Parâmetros do corpo, separados por vírgula (opcional)"
                      />
                    </div>
                  )}

                  {action.type === 'send_email' && (
                    <div className="space-y-1.5">
                      <Input
                        value={String(action.config.subject || '')}
                        onChange={(e) => updateActionConfig(i, 'subject', e.target.value)}
                        placeholder="Assunto do e-mail... aceita variáveis, ex.: Olá {{nome}}"
                      />
                      <MessageActionFields
                        value={String(action.config.body || '')}
                        onChange={(v) => updateActionConfig(i, 'body', v)}
                        showMensagemRecebida={form.trigger === 'MESSAGE_RECEIVED'}
                      />
                      <p className="text-xs text-slate-400">
                        Vai pro e-mail cadastrado no card do cliente. Sem e-mail cadastrado (ou se o envio falhar), as ações seguintes desta regra não rodam pra esse lead — evita mover estágio/gravar nota como se tivesse enviado quando não enviou.
                      </p>
                    </div>
                  )}

                  {action.type === 'assign_agent' && (
                    <div className="space-y-1.5">
                      <select
                        value={String(action.config.mode || 'specific')}
                        onChange={(e) => updateActionConfig(i, 'mode', e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent bg-white"
                      >
                        <option value="specific">Um usuário específico</option>
                        <option value="least_open_leads">Distribuir automaticamente (quem tem menos leads abertos)</option>
                      </select>
                      {(action.config.mode || 'specific') === 'specific' && (
                        <select
                          value={String(action.config.userId || '')}
                          onChange={(e) => updateActionConfig(i, 'userId', e.target.value)}
                          className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent bg-white"
                        >
                          <option value="">Selecione um usuário...</option>
                          {(users || []).map((u) => (
                            <option key={u.id} value={u.id}>{u.name}</option>
                          ))}
                        </select>
                      )}
                    </div>
                  )}

                  {action.type === 'move_stage' && (
                    <StageSelect
                      pipelines={pipelines}
                      value={String(action.config.stageId || '')}
                      onChange={(stageId) => updateActionConfig(i, 'stageId', stageId)}
                    />
                  )}

                  {action.type === 'move_stage_by_name' && (
                    <div className="space-y-1.5">
                      <MoveStageByNameFields
                        pipelines={pipelines}
                        departments={departments}
                        value={String(action.config.stageName || '')}
                        onChange={(name) => updateActionConfig(i, 'stageName', name)}
                      />
                      <p className="text-[11px] text-slate-400">
                        Move o lead pra essa etapa DENTRO do funil onde ele já está (o setor acima é só pra achar o
                        nome certo na lista — quem decide o setor de verdade é o próprio funil onde o lead está).
                      </p>
                    </div>
                  )}

                  {action.type === 'add_note' && (
                    <Input
                      value={String(action.config.text || '')}
                      onChange={(e) => updateActionConfig(i, 'text', e.target.value)}
                      placeholder="Texto da nota, ex.: Follow-up automático enviado"
                    />
                  )}

                  {(action.type === 'activate_ai' || action.type === 'deactivate_ai') && (
                    <p className="text-[11px] text-slate-400">
                      {action.type === 'activate_ai'
                        ? 'Liga a IA de auto-resposta pra esse lead (mesmo botão "Ativar IA" da Inbox) — ela passa a responder o cliente sozinha pelo WhatsApp, seguindo o escopo/Base de Conhecimento do setor dele.'
                        : 'Desliga a IA de auto-resposta pra esse lead — volta a exigir um humano pra responder.'}
                    </p>
                  )}

                  {action.type === 'add_tag' && (
                    <Input
                      value={String(action.config.tag || '')}
                      onChange={(e) => updateActionConfig(i, 'tag', e.target.value)}
                      placeholder="nome-da-tag"
                    />
                  )}

                  {action.type === 'start_salesbot' && (
                    <select
                      value={String(action.config.botId || '')}
                      onChange={(e) => updateActionConfig(i, 'botId', e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent bg-white"
                    >
                      <option value="">Selecione um SalesBot...</option>
                      {(salesBots || []).map((b) => (
                        <option key={b.id} value={b.id}>{b.name}{!b.active ? ' (inativo)' : ''}</option>
                      ))}
                    </select>
                  )}

                  {action.type === 'webhook' && (
                    <Input
                      value={String(action.config.url || '')}
                      onChange={(e) => updateActionConfig(i, 'url', e.target.value)}
                      placeholder="https://..."
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
            <Button onClick={handleSave} loading={saving}>{editingRule ? 'Salvar alterações' : 'Criar automação'}</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Setor + Estágio pra ação "Mover pra etapa (por nome)" — o setor aqui é só
 *  um filtro local (não é salvo em lugar nenhum, a ação não tem campo de
 *  setor no banco): ajuda a achar o estágio certo numa lista curta em vez de
 *  procurar o nome no meio de todos os estágios de todos os setores juntos. */
function MoveStageByNameFields({
  pipelines, departments, value, onChange,
}: { pipelines?: Pipeline[]; departments?: Department[]; value: string; onChange: (name: string) => void }) {
  const [departmentId, setDepartmentId] = useState('');
  return (
    <DepartmentStageSelect
      pipelines={pipelines}
      departments={departments}
      departmentId={departmentId}
      stageName={value}
      onChangeDepartment={setDepartmentId}
      onChangeStage={onChange}
      allowEmptyDepartment
      emptyDepartmentLabel="Todos os setores"
    />
  );
}

/** Select de estágio agrupado por funil — usado tanto no gatilho "Mudança de
 *  estágio" quanto na ação "Mover estágio". */
function StageSelect({
  pipelines, value, onChange, label, allowEmpty,
}: { pipelines?: Pipeline[]; value: string; onChange: (stageId: string) => void; label?: string; allowEmpty?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      {label && <label className="text-sm font-medium text-slate-700">{label}</label>}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent bg-white"
      >
        <option value="">{allowEmpty ? 'Qualquer estágio' : 'Selecione um estágio...'}</option>
        {(pipelines || []).map((p) => (
          <optgroup key={p.id} label={p.name}>
            {p.stages.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}

/** Nomes de etapa (deduplicados) dos funis de um setor — ou de todos os
 *  funis, se nenhum setor foi escolhido ainda (fallback pra quando o setor é
 *  opcional, ex.: a ação "Mover pra etapa" não trava a regra num setor só). */
function stageNamesForDepartment(pipelines: Pipeline[] | undefined, departmentId: string): string[] {
  const relevant = (pipelines || []).filter((p) => !departmentId || p.department?.id === departmentId);
  return Array.from(new Set(relevant.flatMap((p) => p.stages.map((s) => s.name)))).sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

/** Setor → Estágio, igual ao card do lead (Funil de Vendas) — em vez de uma
 *  lista só com o nome da etapa, que ficava sem jeito de saber "Prospecção"
 *  de qual setor era (todo funil se chama "Vendas", só o setor muda).
 *  `departmentId` pode ficar sem persistir em lugar nenhum (a ação "Mover
 *  pra etapa" não tem campo de setor no banco — aqui ele só filtra a lista
 *  de estágios, pra ajudar a achar o certo; quem decide o setor de verdade
 *  é o funil onde o lead já está). */
function DepartmentStageSelect({
  pipelines, departments, departmentId, stageName, onChangeDepartment, onChangeStage,
  allowEmptyDepartment, emptyDepartmentLabel, helperText,
}: {
  pipelines?: Pipeline[];
  departments?: Department[];
  departmentId: string;
  stageName: string;
  onChangeDepartment: (id: string) => void;
  onChangeStage: (name: string) => void;
  allowEmptyDepartment?: boolean;
  emptyDepartmentLabel?: string;
  helperText?: string;
}) {
  const stageOptions = stageNamesForDepartment(pipelines, departmentId);
  return (
    <div className="grid grid-cols-2 gap-2">
      <div className="flex flex-col gap-1">
        <label className="text-xs font-semibold text-slate-500">Setor</label>
        <select
          value={departmentId}
          onChange={(e) => { onChangeDepartment(e.target.value); onChangeStage(''); }}
          className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent bg-white"
        >
          <option value="">{allowEmptyDepartment ? (emptyDepartmentLabel || 'Qualquer setor') : 'Selecione um setor...'}</option>
          {(departments || []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-semibold text-slate-500">Estágio</label>
        <select
          value={stageName}
          onChange={(e) => onChangeStage(e.target.value)}
          className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent bg-white"
        >
          <option value="">Selecione um estágio...</option>
          {stageOptions.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      </div>
      {helperText && <p className="col-span-2 text-[11px] text-slate-400">{helperText}</p>}
    </div>
  );
}

/** Textarea da ação "Enviar mensagem" + chips pra inserir variáveis na
 *  posição do cursor — {{mensagem_recebida}} só aparece quando o gatilho é
 *  "Mensagem recebida" (é o texto que o cliente acabou de mandar). */
function MessageActionFields({
  value, onChange, showMensagemRecebida,
}: { value: string; onChange: (v: string) => void; showMensagemRecebida: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const variables = showMensagemRecebida ? [...BASE_VARIABLES, { key: 'mensagem_recebida', label: 'Mensagem recebida' }] : BASE_VARIABLES;

  function insertVariable(key: string) {
    const el = ref.current;
    const token = `{{${key}}}`;
    if (!el) { onChange(value + token); return; }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const next = value.slice(0, start) + token + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  }

  return (
    <div className="space-y-1.5">
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Mensagem a enviar... use as variáveis abaixo"
        className="w-full px-3 py-2 text-sm border border-af-border rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-af-accent"
        rows={3}
      />
      <div className="flex items-center gap-1.5 flex-wrap">
        {variables.map((v) => (
          <button
            key={v.key}
            type="button"
            onClick={() => insertVariable(v.key)}
            className="text-[11px] bg-af-light text-af-accent px-2 py-1 rounded-full hover:bg-af-accent hover:text-white transition-colors font-medium"
          >
            + {v.label}
          </button>
        ))}
      </div>
    </div>
  );
}
