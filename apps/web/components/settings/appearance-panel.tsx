'use client';
import { useRef } from 'react';
import { Palette, CheckCircle2, Upload } from 'lucide-react';
import { toast } from '@/components/ui/toast';
import { useThemeStore, BackgroundTheme } from '@/store/theme.store';

// Extraído de Configurações → Aparência pra ser reaproveitado também como
// atalho rápido na Dashboard (mesmo componente, dois lugares de acesso).

const THEME_OPTIONS: { key: BackgroundTheme; label: string; desc: string; preview: string; textColor: string }[] = [
  { key: 'white', label: 'Branco', desc: 'Fundo claro padrão', preview: '#f4f6f9', textColor: '#1e293b' },
  { key: 'black', label: 'Preto', desc: 'Fundo escuro para pouca luz', preview: '#0b0f16', textColor: '#e5e7eb' },
  { key: 'blue', label: 'Azul', desc: 'Fundo nas cores da A&F', preview: '#0d2545', textColor: '#e8f0f9' },
];

const IMAGE_PRESETS: { label: string; url: string; thumb: string }[] = [
  { label: 'Montanhas', url: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=1600&q=80', thumb: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=300&q=60' },
  { label: 'Floresta', url: 'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=1600&q=80', thumb: 'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=300&q=60' },
  { label: 'Serra', url: 'https://images.unsplash.com/photo-1519681393784-d120267933ba?w=1600&q=80', thumb: 'https://images.unsplash.com/photo-1519681393784-d120267933ba?w=300&q=60' },
  { label: 'Lago', url: 'https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?w=1600&q=80', thumb: 'https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?w=300&q=60' },
  { label: 'Campo', url: 'https://images.unsplash.com/photo-1500673922987-e212871fec22?w=1600&q=80', thumb: 'https://images.unsplash.com/photo-1500673922987-e212871fec22?w=300&q=60' },
  { label: 'Pico', url: 'https://images.unsplash.com/photo-1472214103451-9374bd1c798e?w=1600&q=80', thumb: 'https://images.unsplash.com/photo-1472214103451-9374bd1c798e?w=300&q=60' },
];

const MAX_UPLOAD_BYTES = 3 * 1024 * 1024; // 3MB

interface AppearancePanelProps {
  /** Mostra o cabeçalho colorido com título/subtítulo (usado na aba de
   *  Configurações). No atalho da Dashboard, o modal já tem título — passe
   *  false pra não duplicar. */
  showHeader?: boolean;
}

export function AppearancePanel({ showHeader = true }: AppearancePanelProps) {
  const { theme, setTheme, bgImage, setBgImage, surfaceOpacity, setSurfaceOpacity } = useThemeStore();
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast('Selecione um arquivo de imagem', 'error');
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      toast('Imagem muito grande. Escolha um arquivo de até 3MB.', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setBgImage(reader.result as string);
      toast('Imagem de fundo aplicada!');
    };
    reader.readAsDataURL(file);
  }

  return (
    <div className={showHeader ? 'bg-white rounded-2xl border border-af-border shadow-sm overflow-hidden' : ''}>
      {showHeader && (
        <div className="flex items-center gap-3 px-6 py-4 border-b border-af-border bg-gradient-to-r from-slate-700 to-slate-900">
          <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center">
            <Palette size={22} className="text-white" />
          </div>
          <div>
            <h2 className="text-white font-bold text-base">Aparência</h2>
            <p className="text-white/70 text-xs">Escolha a cor ou imagem de fundo do sistema</p>
          </div>
        </div>
      )}

      <div className={showHeader ? 'px-6 py-5 space-y-5' : 'space-y-5'}>
        <div>
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Cor sólida</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {THEME_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                onClick={() => {
                  setTheme(opt.key);
                  setBgImage(null);
                  toast(`Fundo "${opt.label}" aplicado!`);
                }}
                className={`text-left rounded-xl border p-3.5 transition-all ${
                  theme === opt.key && !bgImage
                    ? 'border-violet-400 ring-2 ring-violet-100'
                    : 'border-af-border hover:border-violet-200'
                }`}
              >
                <div
                  className="w-full h-16 rounded-lg border border-black/10 flex items-center justify-center mb-2"
                  style={{ backgroundColor: opt.preview, color: opt.textColor }}
                >
                  <span className="text-xs font-medium">Aa</span>
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold text-slate-800">{opt.label}</p>
                    <p className="text-xs text-slate-400">{opt.desc}</p>
                  </div>
                  {theme === opt.key && !bgImage && <CheckCircle2 size={16} className="text-violet-600 flex-shrink-0" />}
                </div>
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Imagem de fundo</p>
            {bgImage && (
              <button
                onClick={() => { setBgImage(null); toast('Imagem de fundo removida'); }}
                className="text-xs text-red-500 hover:text-red-600 font-medium"
              >
                Remover imagem
              </button>
            )}
          </div>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            {IMAGE_PRESETS.map((img) => (
              <button
                key={img.url}
                onClick={() => { setBgImage(img.url); toast(`Fundo "${img.label}" aplicado!`); }}
                className={`relative h-16 rounded-lg overflow-hidden border-2 transition-all ${
                  bgImage === img.url ? 'border-violet-400 ring-2 ring-violet-100' : 'border-transparent hover:border-violet-200'
                }`}
                title={img.label}
              >
                <img src={img.thumb} alt={img.label} className="w-full h-full object-cover" />
                {bgImage === img.url && (
                  <span className="absolute inset-0 bg-black/20 flex items-center justify-center">
                    <CheckCircle2 size={16} className="text-white" />
                  </span>
                )}
              </button>
            ))}
            <button
              onClick={() => fileInputRef.current?.click()}
              className="h-16 rounded-lg border-2 border-dashed border-af-border hover:border-violet-300 hover:bg-violet-50 flex flex-col items-center justify-center gap-0.5 text-slate-400 hover:text-violet-500 transition-colors"
              title="Enviar imagem"
            >
              <Upload size={16} />
              <span className="text-[10px] font-medium">Enviar</span>
            </button>
          </div>
          <input ref={fileInputRef} type="file" accept="image/*" onChange={handleUpload} className="hidden" />
          <p className="text-xs text-slate-400 mt-2">Imagens até 3MB. A imagem substitui a cor sólida como fundo do sistema.</p>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Transparência dos painéis</p>
            <span className="text-xs font-semibold text-slate-600">{surfaceOpacity}%</span>
          </div>
          <input
            type="range"
            min={30}
            max={100}
            step={5}
            value={surfaceOpacity}
            onChange={(e) => setSurfaceOpacity(Number(e.target.value))}
            onMouseUp={() => toast('Transparência atualizada!')}
            onTouchEnd={() => toast('Transparência atualizada!')}
            className="w-full accent-violet-500"
          />
          <p className="text-xs text-slate-400 mt-1">Controla o quanto o topo e as colunas do Funil deixam o fundo transparecer, como no Trello.</p>
        </div>
      </div>
    </div>
  );
}
