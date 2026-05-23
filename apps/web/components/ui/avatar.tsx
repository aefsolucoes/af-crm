import { cn, getInitials } from '@/lib/utils';

interface AvatarProps {
  name: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const COLORS = ['#2261a8', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#3b82f6'];

function colorFromName(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return COLORS[Math.abs(hash) % COLORS.length];
}

export function Avatar({ name, size = 'md', className }: AvatarProps) {
  const sizes = { sm: 'w-6 h-6 text-xs', md: 'w-8 h-8 text-sm', lg: 'w-10 h-10 text-base' };
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
