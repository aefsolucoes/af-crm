import { cn, getInitials } from '@/lib/utils';

interface AvatarProps {
  name: string;
  src?: string | null;   // URL da foto real (WhatsApp, upload, etc.)
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const COLORS = ['#2261a8', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#3b82f6'];

function colorFromName(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return COLORS[Math.abs(hash) % COLORS.length];
}

// Remove "lone surrogates" (metade de um par de UTF-16 sem a outra metade —
// costuma vir de emoji truncado no nome do perfil do WhatsApp) — sem isso,
// encodeURIComponent lança "URI malformed" e derruba a página inteira.
function stripLoneSurrogates(s: string): string {
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

/** Gera um SVG inline como data URL — sem chamadas de rede */
function makeAvatarSvg(name: string, size: 'sm' | 'md' | 'lg'): string {
  const px    = { sm: 24, md: 32, lg: 40 }[size];
  const fs    = { sm: 10, md: 13, lg: 16 }[size];
  const color = colorFromName(name);
  const label = stripLoneSurrogates(getInitials(name) || '?') || '?';

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${px} ${px}">`,
    `<defs>`,
    `<linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">`,
    `<stop offset="0%" stop-color="${color}" stop-opacity="1"/>`,
    `<stop offset="100%" stop-color="${color}" stop-opacity="0.75"/>`,
    `</linearGradient>`,
    `</defs>`,
    `<circle cx="${px / 2}" cy="${px / 2}" r="${px / 2}" fill="url(#g)"/>`,
    `<text`,
    ` x="${px / 2}"`,
    ` y="${px / 2 + fs * 0.37}"`,
    ` text-anchor="middle"`,
    ` font-family="system-ui,-apple-system,BlinkMacSystemFont,sans-serif"`,
    ` font-size="${fs}"`,
    ` font-weight="700"`,
    ` fill="white"`,
    ` letter-spacing="0.5"`,
    `>${label}</text>`,
    `</svg>`,
  ].join('');

  // Mesmo com o filtro acima, nunca deixa um SVG malformado derrubar a
  // página inteira — na dúvida, cai num círculo colorido sem iniciais.
  try {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  } catch {
    const fallback = `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${px} ${px}"><circle cx="${px / 2}" cy="${px / 2}" r="${px / 2}" fill="${color}"/></svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(fallback)}`;
  }
}

export function Avatar({ name, src, size = 'md', className }: AvatarProps) {
  const sizes = { sm: 'w-6 h-6', md: 'w-8 h-8', lg: 'w-10 h-10' };

  // SVG gerado inline — fallback garantido sem rede
  const fallbackSrc = makeAvatarSvg(name || '?', size);
  const imgSrc = src || fallbackSrc;

  return (
    <img
      src={imgSrc}
      alt={name}
      title={name}
      className={cn(
        'inline-block rounded-full object-cover flex-shrink-0',
        sizes[size],
        className,
      )}
      onError={e => {
        const el = e.currentTarget as HTMLImageElement;
        // Se a foto real falhar, usa o SVG gerado
        if (el.src !== fallbackSrc) {
          el.src = fallbackSrc;
        }
      }}
    />
  );
}
