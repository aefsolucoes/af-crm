'use client';
import { useState } from 'react';
import { STEP_TYPES, StepType, getStepMeta } from './node-types';
import { NodeInspector } from './node-inspector';
import { Plus, Trash2 } from 'lucide-react';

// Formato do fluxo — espelha EXATAMENTE apps/api/src/services/salesbot.service.ts
// (SalesBotFlow/SalesBotStep). Sem x/y/connections do mockup antigo: a ordem
// do array já É a ordem de execução (próximo passo = próximo item da lista);
// só "condition" desvia disso, com trueStepId/falseStepId explícitos.
export interface BotStep {
  id: string;
  type: StepType;
  config: Record<string, unknown>;
}

export interface BotFlow {
  trigger: { keywords: string[] };
  steps: BotStep[];
}

export const EMPTY_FLOW: BotFlow = { trigger: { keywords: [] }, steps: [] };

function genId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function stepPreview(step: BotStep): string {
  const c = step.config as Record<string, any>;
  switch (step.type) {
    case 'send_message':
      return c.message ? String(c.message).slice(0, 70) : '(mensagem vazia)';
    case 'pause':
      return (c.pauseType || 'time') === 'response'
        ? `Aguarda resposta do lead (desiste em ${c.timeout || 24}h)`
        : `Aguarda ${c.duration || 1} ${{ minutes: 'minuto(s)', hours: 'hora(s)', days: 'dia(s)' }[c.unit as string] || 'hora(s)'}`;
    case 'condition':
      return c.field ? `Se "${c.field}" ${c.operator || 'equals'} "${c.value || ''}"` : '(configure a condição)';
    case 'action':
      return { assign: 'Atribui a alguém', move_stage: 'Move de etapa', add_tag: 'Adiciona tag', remove_tag: 'Remove tag', set_field: 'Define campo' }[c.actionType as string] || '(configure a ação)';
    case 'validation':
      return `Valida "${c.validationType || 'text'}" e guarda em "${c.field || '?'}"`;
    case 'stop_salesbot':
      return c.sendFinalMessage ? 'Encerra o fluxo, com mensagem final' : 'Encerra o fluxo';
    default:
      return '';
  }
}

interface StepListProps {
  flow: BotFlow;
  onChange: (flow: BotFlow) => void;
}

export function StepList({ flow, onChange }: StepListProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pickerAt, setPickerAt] = useState<number | null>(null);

  const steps = flow.steps;
  const selected = steps.find((s) => s.id === selectedId) || null;

  function insertStep(type: StepType, atIndex: number) {
    const newStep: BotStep = { id: genId(), type, config: {} };
    onChange({ ...flow, steps: [...steps.slice(0, atIndex), newStep, ...steps.slice(atIndex)] });
    setPickerAt(null);
    setSelectedId(newStep.id);
  }

  function updateStep(updated: BotStep) {
    onChange({ ...flow, steps: steps.map((s) => (s.id === updated.id ? updated : s)) });
  }

  function deleteStep(id: string) {
    onChange({ ...flow, steps: steps.filter((s) => s.id !== id) });
    if (selectedId === id) setSelectedId(null);
  }

  function setKeywordsRaw(raw: string) {
    onChange({ ...flow, trigger: { keywords: raw.split(',').map((k) => k.trim()).filter(Boolean) } });
  }

  return (
    <div className="flex-1 flex overflow-hidden">
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mb-6 bg-af-light border border-af-border rounded-xl p-4">
          <label className="text-sm font-semibold text-slate-800">Gatilho — quando esse bot começa a rodar</label>
          <p className="text-xs text-slate-500 mt-0.5 mb-2">
            Dispara sozinho na primeira mensagem de um lead sem bot ativo, quando o texto bate com alguma dessas frases (não repara maiúscula nem acento).
          </p>
          <input
            defaultValue={flow.trigger.keywords.join(', ')}
            onBlur={(e) => setKeywordsRaw(e.target.value)}
            placeholder="Ex: vim do site, olá, quero financiamento"
            className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent bg-white"
          />
          <p className="text-xs text-slate-400 mt-1">Separe várias frases por vírgula.</p>
        </div>

        <InsertPoint index={0} pickerAt={pickerAt} setPickerAt={setPickerAt} onPick={(t) => insertStep(t, 0)} />
        {steps.map((step, i) => (
          <div key={step.id}>
            <StepCard
              step={step}
              index={i}
              selected={step.id === selectedId}
              onSelect={() => setSelectedId(step.id)}
              onDelete={() => deleteStep(step.id)}
            />
            <InsertPoint index={i + 1} pickerAt={pickerAt} setPickerAt={setPickerAt} onPick={(t) => insertStep(t, i + 1)} />
          </div>
        ))}
        {steps.length === 0 && (
          <p className="text-center text-sm text-slate-400 py-8">Nenhum passo ainda — clique no "+" acima pra começar.</p>
        )}
      </div>

      {selected && (
        <NodeInspector step={selected} allSteps={steps} onUpdate={updateStep} onClose={() => setSelectedId(null)} />
      )}
    </div>
  );
}

function InsertPoint({
  index, pickerAt, setPickerAt, onPick,
}: { index: number; pickerAt: number | null; setPickerAt: (i: number | null) => void; onPick: (t: StepType) => void }) {
  const open = pickerAt === index;
  return (
    <div className="relative flex items-center justify-center py-1">
      <div className="flex-1 h-px bg-af-border" />
      <button
        type="button"
        onClick={() => setPickerAt(open ? null : index)}
        className={`mx-2 p-1 rounded-full border transition-colors ${open ? 'bg-af-accent border-af-accent text-white' : 'border-af-border text-slate-400 hover:border-af-accent hover:text-af-accent'}`}
      >
        <Plus size={14} />
      </button>
      <div className="flex-1 h-px bg-af-border" />
      {open && (
        <div className="absolute top-8 z-20 bg-white border border-af-border rounded-xl shadow-lg p-2 w-64">
          {STEP_TYPES.map((t) => (
            <button
              type="button"
              key={t.type}
              onClick={() => onPick(t.type)}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-af-light text-left"
            >
              <span className="p-1.5 rounded-lg text-white flex-shrink-0" style={{ backgroundColor: t.color }}>{t.icon}</span>
              <span className="text-sm text-slate-700">{t.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function StepCard({
  step, index, selected, onSelect, onDelete,
}: { step: BotStep; index: number; selected: boolean; onSelect: () => void; onDelete: () => void }) {
  const meta = getStepMeta(step.type);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === 'Enter') onSelect(); }}
      className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border-2 text-left transition-colors cursor-pointer ${selected ? 'border-af-accent bg-blue-50' : 'border-af-border bg-white hover:border-af-mid'}`}
    >
      <span className="text-xs font-mono text-slate-300 w-5 flex-shrink-0">{index + 1}</span>
      <span className="p-1.5 rounded-lg text-white flex-shrink-0" style={{ backgroundColor: meta.color }}>{meta.icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-slate-800">{meta.label}</p>
        <p className="text-xs text-slate-500 truncate">{stepPreview(step)}</p>
      </div>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="flex-shrink-0 p-1 text-slate-300 hover:text-red-500"
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}
