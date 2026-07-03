import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(value?: number | null) {
  if (value == null) return '—';
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
}

export function formatDate(date: string | Date) {
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(date));
}

export function formatDateTime(date: string | Date) {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(date));
}

export function isOverdue(date: string | Date) {
  return new Date(date) < new Date();
}

export function getInitials(name: string) {
  return name.split(' ').slice(0, 2).map((n) => n[0]).join('').toUpperCase();
}

export const CHANNEL_LABELS: Record<string, string> = {
  WHATSAPP: 'WhatsApp',
  INSTAGRAM: 'Instagram',
  TELEGRAM: 'Telegram',
  WEBCHAT: 'Web Chat',
  EMAIL: 'E-mail',
};

/** Máscara CPF: 000.000.000-00 */
export function maskCPF(value: string): string {
  const d = value.replace(/\D/g, '').slice(0, 11);
  return d
    .replace(/(\d{3})(\d)/, '$1.$2')
    .replace(/(\d{3})(\d)/, '$1.$2')
    .replace(/(\d{3})(\d{1,2})$/, '$1-$2');
}

/** Máscara de data BR enquanto digita: DD/MM/AAAA */
export function maskDateBR(value: string): string {
  const d = value.replace(/\D/g, '').slice(0, 8);
  return d
    .replace(/(\d{2})(\d)/, '$1/$2')
    .replace(/(\d{2})(\d)/, '$1/$2');
}

/** Converte data ISO (AAAA-MM-DD, vinda de dados antigos) para DD/MM/AAAA. Se já estiver em DD/MM/AAAA (ou vazio/inválido), retorna como está. */
export function isoToBRDate(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value || '');
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return value;
}

/**
 * Máscara de dinheiro (formato brasileiro).
 * Aceita strings brutas (de cálculos, ex: "50000") ou digitadas (ex: "50.000,00").
 * Retorna string formatada: "50.000" ou "50.000,50"
 */
export function maskMoney(value: string): string {
  if (!value) return '';
  const trimmed = value.trim();
  // Número inteiro puro (vem de cálculos automáticos)
  if (/^\d+$/.test(trimmed)) {
    const n = parseInt(trimmed, 10);
    return n === 0 ? '' : n.toLocaleString('pt-BR');
  }
  // Decimal no formato EN (vem de cálculos: 50000.5)
  if (/^\d+\.\d+$/.test(trimmed)) {
    const n = parseFloat(trimmed);
    return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  // Usuário digitando em formato BR (pode ter pontos de milhar e vírgula decimal)
  const parts = trimmed.replace(/[^\d,]/g, '').split(',');
  const intPart = parts[0] ? parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.') : '';
  if (parts.length > 1) {
    return `${intPart},${parts[1].slice(0, 2)}`;
  }
  return intPart;
}

export const CHANNEL_COLORS: Record<string, string> = {
  WHATSAPP: '#25D366',
  INSTAGRAM: '#E1306C',
  TELEGRAM: '#229ED9',
  WEBCHAT: '#6366f1',
  EMAIL: '#f59e0b',
};
