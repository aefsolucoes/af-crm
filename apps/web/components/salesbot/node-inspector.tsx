'use client';
import { useQuery } from '@tanstack/react-query';
import { getStepMeta } from './node-types';
import { X, Plus, Trash2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import api from '@/lib/api';
import type { BotStep } from './step-list';

interface FlatStage { id: string; label: string; }

interface NodeInspectorProps {
  step: BotStep | null;
  allSteps: BotStep[];
  onUpdate: (step: BotStep) => void;
  onClose: () => void;
}

function cfg(step: BotStep, key: string): string {
  return String(step.config[key] ?? '');
}

function set(step: BotStep, key: string, value: unknown): BotStep {
  return { ...step, config: { ...step.config, [key]: value } };
}

export function NodeInspector({ step, allSteps, onUpdate, onClose }: NodeInspectorProps) {
  const { data: users } = useQuery({
    queryKey: ['users'],
    queryFn: async () => (await api.get('/api/users')).data as { id: string; name: string }[],
    enabled: !!step && step.type === 'action',
  });
  const { data: pipelines } = useQuery({
    queryKey: ['pipelines'],
    queryFn: async () => (await api.get('/api/pipelines')).data as { id: string; name: string; stages: { id: string; name: string }[] }[],
    enabled: !!step && step.type === 'action',
  });

  if (!step) return null;
  const meta = getStepMeta(step.type);
  const u = (key: string, value: unknown) => onUpdate(set(step, key, value));

  const buttons: string[] = Array.isArray(step.config.buttons) ? (step.config.buttons as string[]) : [];
  const otherSteps = allSteps.filter((s) => s.id !== step.id);
  const flatStages: FlatStage[] = (pipelines || []).flatMap((p) =>
    p.stages.map((s) => ({ id: s.id, label: `${p.name} → ${s.name}` }))
  );

  return (
    <aside className="w-80 border-l border-af-border bg-white flex flex-col flex-shrink-0 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-af-border">
        <div className="flex items-center gap-2">
          <span className="p-1.5 rounded-lg text-white" style={{ backgroundColor: meta.color }}>
            {meta.icon}
          </span>
          <span className="text-sm font-semibold text-slate-900">{meta.label}</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
          <X size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        <p className="text-xs text-slate-500 italic">{meta.description}</p>

        {/* ─── send_message ─── */}
        {step.type === 'send_message' && (
          <>
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700">Mensagem</label>
              <textarea
                value={cfg(step, 'message')}
                onChange={(e) => u('message', e.target.value)}
                className="w-full px-3 py-2 text-sm border border-af-border rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-af-accent"
                rows={4}
                placeholder="Digite a mensagem que será enviada..."
              />
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium text-slate-700">Botões de resposta rápida (opcional, máx. 3)</label>
              <p className="text-xs text-slate-400 -mt-1">Clicável de verdade na API Oficial; no QR Code vira uma lista numerada no texto.</p>
              {buttons.map((b, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    value={b}
                    onChange={(e) => { const arr = [...buttons]; arr[i] = e.target.value; u('buttons', arr); }}
                    className="flex-1 px-2 py-1.5 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
                    placeholder={i === 0 ? 'Sim' : i === 1 ? 'Não' : `Opção ${i + 1}`}
                  />
                  <button onClick={() => u('buttons', buttons.filter((_, j) => j !== i))} className="text-red-400 hover:text-red-600">
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              {buttons.length < 3 && (
                <button onClick={() => u('buttons', [...buttons, ''])} className="flex items-center gap-1 text-xs text-af-accent hover:text-af-mid font-medium">
                  <Plus size={12} /> Adicionar botão
                </button>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700">Atraso antes de enviar (segundos, máx. 30)</label>
              <input
                type="number"
                value={cfg(step, 'delay') || '0'}
                onChange={(e) => u('delay', e.target.value)}
                min={0}
                max={30}
                className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
              />
              <p className="text-xs text-slate-400">Pra esperas mais longas, use um passo "Pausar" depois deste.</p>
            </div>
          </>
        )}

        {/* ─── pause ─── */}
        {step.type === 'pause' && (
          <>
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700">Tipo de pausa</label>
              <select
                value={cfg(step, 'pauseType') || 'time'}
                onChange={(e) => u('pauseType', e.target.value)}
                className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
              >
                <option value="time">Aguardar por tempo</option>
                <option value="response">Aguardar resposta do lead</option>
              </select>
            </div>
            {(cfg(step, 'pauseType') || 'time') === 'time' && (
              <div className="flex gap-2">
                <input
                  type="number"
                  value={cfg(step, 'duration') || '1'}
                  onChange={(e) => u('duration', e.target.value)}
                  min={1}
                  className="flex-1 px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
                />
                <select
                  value={cfg(step, 'unit') || 'hours'}
                  onChange={(e) => u('unit', e.target.value)}
                  className="flex-1 px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
                >
                  <option value="minutes">Minutos</option>
                  <option value="hours">Horas</option>
                  <option value="days">Dias</option>
                </select>
              </div>
            )}
            {cfg(step, 'pauseType') === 'response' && (
              <Input
                label="Desistir depois de quantas horas sem resposta"
                type="number"
                value={cfg(step, 'timeout') || '24'}
                onChange={(e) => u('timeout', e.target.value)}
              />
            )}
          </>
        )}

        {/* ─── condition ─── */}
        {step.type === 'condition' && (
          <>
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700">Campo a verificar</label>
              <select
                value={cfg(step, 'field')}
                onChange={(e) => u('field', e.target.value)}
                className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
              >
                <option value="">Selecione...</option>
                <option value="last_message">Última mensagem recebida</option>
                <option value="name">Nome</option>
                <option value="email">E-mail</option>
                <option value="phone">Telefone</option>
                <option value="stage">Etapa atual</option>
                <option value="tag">Tag</option>
                <option value="custom">Campo personalizado</option>
              </select>
            </div>
            {cfg(step, 'field') === 'custom' && (
              <Input label="Nome do campo" value={cfg(step, 'customField')} onChange={(e) => u('customField', e.target.value)} placeholder="nome_campo" />
            )}
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700">Operador</label>
              <select
                value={cfg(step, 'operator') || 'equals'}
                onChange={(e) => u('operator', e.target.value)}
                className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
              >
                <option value="equals">É igual a</option>
                <option value="not_equals">Não é igual a</option>
                <option value="contains">Contém</option>
                <option value="not_contains">Não contém</option>
                <option value="starts_with">Começa com</option>
                <option value="exists">Existe (preenchido)</option>
                <option value="not_exists">Não existe</option>
              </select>
            </div>
            {cfg(step, 'operator') !== 'exists' && cfg(step, 'operator') !== 'not_exists' && (
              <Input label="Valor" value={cfg(step, 'value')} onChange={(e) => u('value', e.target.value)} placeholder="Ex: sim" />
            )}
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700">Se verdadeiro, ir para</label>
              <select
                value={cfg(step, 'trueStepId')}
                onChange={(e) => u('trueStepId', e.target.value)}
                className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
              >
                <option value="">Próximo passo da lista</option>
                {otherSteps.map((s, i) => <option key={s.id} value={s.id}>{`${i + 1}. ${getStepMeta(s.type).label}`}</option>)}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700">Se falso, ir para</label>
              <select
                value={cfg(step, 'falseStepId')}
                onChange={(e) => u('falseStepId', e.target.value)}
                className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
              >
                <option value="">Encerra o fluxo aqui</option>
                {otherSteps.map((s, i) => <option key={s.id} value={s.id}>{`${i + 1}. ${getStepMeta(s.type).label}`}</option>)}
              </select>
            </div>
          </>
        )}

        {/* ─── action ─── */}
        {step.type === 'action' && (
          <>
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700">Tipo de ação</label>
              <select
                value={cfg(step, 'actionType') || 'assign'}
                onChange={(e) => u('actionType', e.target.value)}
                className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
              >
                <option value="assign">Atribuir a alguém</option>
                <option value="move_stage">Mover de etapa</option>
                <option value="add_tag">Adicionar tag</option>
                <option value="remove_tag">Remover tag</option>
                <option value="set_field">Definir campo</option>
              </select>
            </div>
            {cfg(step, 'actionType') === 'assign' && (
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-slate-700">Atribuir a</label>
                <select
                  value={cfg(step, 'agentId')}
                  onChange={(e) => u('agentId', e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
                >
                  <option value="">Selecione...</option>
                  {(users || []).map((u2) => <option key={u2.id} value={u2.id}>{u2.name}</option>)}
                </select>
              </div>
            )}
            {cfg(step, 'actionType') === 'move_stage' && (
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-slate-700">Mover para</label>
                <select
                  value={cfg(step, 'stageId')}
                  onChange={(e) => u('stageId', e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
                >
                  <option value="">Selecione...</option>
                  {flatStages.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
              </div>
            )}
            {(cfg(step, 'actionType') === 'add_tag' || cfg(step, 'actionType') === 'remove_tag') && (
              <Input label="Tag" value={cfg(step, 'tag')} onChange={(e) => u('tag', e.target.value)} placeholder="nome-da-tag" />
            )}
            {cfg(step, 'actionType') === 'set_field' && (
              <>
                <Input label="Campo" value={cfg(step, 'fieldName')} onChange={(e) => u('fieldName', e.target.value)} placeholder="Ex: status" />
                <Input label="Valor" value={cfg(step, 'fieldValue')} onChange={(e) => u('fieldValue', e.target.value)} placeholder="Ex: qualificado" />
              </>
            )}
          </>
        )}

        {/* ─── validation ─── */}
        {step.type === 'validation' && (
          <>
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700">Tipo de validação</label>
              <select
                value={cfg(step, 'validationType') || 'text'}
                onChange={(e) => u('validationType', e.target.value)}
                className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
              >
                <option value="text">Texto (não vazio)</option>
                <option value="email">E-mail válido</option>
                <option value="phone">Telefone válido</option>
                <option value="cpf">CPF (11 dígitos)</option>
                <option value="cnpj">CNPJ (14 dígitos)</option>
                <option value="number">Número</option>
                <option value="regex">Expressão regular</option>
              </select>
            </div>
            <Input label="Guardar resposta no campo" value={cfg(step, 'field')} onChange={(e) => u('field', e.target.value)} placeholder="Ex: email" />
            {cfg(step, 'validationType') === 'regex' && (
              <Input label="Expressão regular" value={cfg(step, 'regex')} onChange={(e) => u('regex', e.target.value)} placeholder="^[0-9]+$" />
            )}
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700">Mensagem de erro</label>
              <textarea
                value={cfg(step, 'errorMessage')}
                onChange={(e) => u('errorMessage', e.target.value)}
                className="w-full px-3 py-2 text-sm border border-af-border rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-af-accent"
                rows={2}
                placeholder="Não entendi, pode tentar de novo?"
              />
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="retryValidation"
                checked={!!step.config.retry}
                onChange={(e) => u('retry', e.target.checked)}
                className="rounded"
              />
              <label htmlFor="retryValidation" className="text-sm text-slate-700">Repetir até valor válido (até 5x)</label>
            </div>
          </>
        )}

        {/* ─── stop_salesbot ─── */}
        {step.type === 'stop_salesbot' && (
          <>
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700">Motivo (opcional, aparece nas Execuções)</label>
              <select
                value={cfg(step, 'reason') || 'completed'}
                onChange={(e) => u('reason', e.target.value)}
                className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
              >
                <option value="completed">Fluxo concluído</option>
                <option value="unsubscribed">Lead optou por sair</option>
                <option value="transferred">Transferido para humano</option>
              </select>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="sendFinalMsg"
                checked={!!step.config.sendFinalMessage}
                onChange={(e) => u('sendFinalMessage', e.target.checked)}
                className="rounded"
              />
              <label htmlFor="sendFinalMsg" className="text-sm text-slate-700">Enviar mensagem de encerramento</label>
            </div>
            {!!step.config.sendFinalMessage && (
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-slate-700">Mensagem final</label>
                <textarea
                  value={cfg(step, 'finalMessage')}
                  onChange={(e) => u('finalMessage', e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-af-border rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-af-accent"
                  rows={3}
                  placeholder="Obrigado pelo contato! Até logo."
                />
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
