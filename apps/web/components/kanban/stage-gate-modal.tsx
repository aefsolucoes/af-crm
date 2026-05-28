'use client';
import { ValidationField } from '@/lib/stage-validation';
import { AlertTriangle, X } from 'lucide-react';

interface StageGateModalProps {
  open: boolean;
  stageName: string;
  missing: ValidationField[];
  onConfirm: () => void;
  onCancel: () => void;
}

export function StageGateModal({ open, stageName, missing, onConfirm, onCancel }: StageGateModalProps) {
  if (!open) return null;

  // Agrupa campos por seção
  const sections = missing.reduce<Record<string, ValidationField[]>>((acc, f) => {
    acc[f.section] = [...(acc[f.section] || []), f];
    return acc;
  }, {});

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-af-border">
          <div className="w-9 h-9 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
            <AlertTriangle size={18} className="text-amber-500" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-slate-900">Campos obrigatórios pendentes</p>
            <p className="text-xs text-slate-500 truncate">Mover para "{stageName}"</p>
          </div>
          <button onClick={onCancel} className="text-slate-400 hover:text-slate-600">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 max-h-80 overflow-y-auto space-y-4 scrollbar-thin">
          <p className="text-sm text-slate-600">
            Os campos abaixo estão em branco. Preencha-os antes de mover para esta etapa:
          </p>

          {Object.entries(sections).map(([section, fields]) => (
            <div key={section}>
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">{section}</p>
              <ul className="space-y-1">
                {fields.map(f => (
                  <li key={f.key} className="flex items-center gap-2 text-sm text-slate-700">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0" />
                    {f.label}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="flex gap-3 px-5 py-4 border-t border-af-border bg-slate-50">
          <button
            onClick={onCancel}
            className="flex-1 py-2.5 rounded-xl border border-af-border text-slate-700 text-sm font-medium hover:bg-white transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 py-2.5 rounded-xl bg-amber-500 text-white text-sm font-medium hover:bg-amber-600 transition-colors"
          >
            Mover mesmo assim
          </button>
        </div>
      </div>
    </div>
  );
}
