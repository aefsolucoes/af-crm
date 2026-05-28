import { cn, getInitials } from '@/lib/utils';

interface AvatarProps {
  name: string;
  src?: string | null;   // URL da foto (WhatsApp profile photo, etc.)
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const COLORS = ['#2261a8', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#3b82f6'];

function colorFromName(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return COLORS[Math.abs(hash) % COLORS.length];
}

export function Avatar({ name, src, size = 'md', className }: AvatarProps) {
  const sizes = { sm: 'w-6 h-6 text-xs', md: 'w-8 h-8 text-sm', lg: 'w-10 h-10 text-base' };

  if (src) {
    return (
      <img
        src={src}
        alt={name}
        title={name}
        className={cn('inline-block rounded-full object-cover flex-shrink-0', sizes[size], className)}
        onError={e => {
          // Se a foto falhar, troca para iniciais
          const el = e.currentTarget as HTMLImageElement;
          el.style.display = 'none';
          const span = document.createElement('span');
          span.className = el.className;
          span.style.cssText = `background-color:${colorFromName(name)};display:inline-flex;align-items:center;justify-content:center;color:white;font-weight:600`;
          span.textContent = getInitials(name);
          el.parentNode?.insertBefore(span, el);
        }}
      />
    );
  }

  return (
    <span
      className={cn('inline-flex items-center justify-center rounded-full font-semibold text-white flex-shrink-0', sizes[size], className)}
      style={{ backgroundColor: colorFromName(name) }}
      title={name}
    >
      {getInitials(name)}
    </span>
  );
}
