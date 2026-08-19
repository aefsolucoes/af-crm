'use client';
import { STAGE_COLORS } from './stage-colors';

interface ColorSwatchesProps {
  value: string;
  onChange: (color: string) => void;
  className?: string;
}

/** Grade pequena de bolinhas de cor clicáveis — usada tanto ao criar quanto
 *  ao editar uma etapa do funil. */
export function ColorSwatches({ value, onChange, className }: ColorSwatchesProps) {
  return (
    <div className={`flex flex-wrap gap-1.5 ${className || ''}`}>
      {STAGE_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          title={c}
          className={`w-5 h-5 rounded-full flex-shrink-0 transition-transform ${value === c ? 'ring-2 ring-offset-1 ring-slate-500 scale-110' : 'hover:scale-110'}`}
          style={{ backgroundColor: c }}
        />
      ))}
    </div>
  );
}
