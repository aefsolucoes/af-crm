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

/**
 * Formata um valor monetário para exibição (somente leitura), sempre no
 * padrão "xxx.xxx,xx" — com separador de milhar e 2 casas decimais, mesmo
 * quando o valor bruto salvo é um inteiro sem decimais (ex: "450000" → "450.000,00").
 */
export function formatMoneyDisplay(value: string | number): string {
  if (value === '' || value == null) return '';
  const trimmed = String(value).trim();
  let n: number;
  if (/^\d+$/.test(trimmed) || /^\d+\.\d+$/.test(trimmed)) {
    // Formato EN (vem de cálculos ou do banco): "450000" ou "450000.5"
    n = parseFloat(trimmed);
  } else {
    // Formato BR digitado: pontos de milhar + vírgula decimal
    n = parseFloat(trimmed.replace(/\./g, '').replace(',', '.'));
  }
  if (isNaN(n)) return '';
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Máscara de dinheiro para uso em onChange de inputs (digitação ao vivo).
 * Sempre remove os pontos de milhar já inseridos antes de reformatar, evitando
 * que o valor acumulado (ex: "1.234" + "5" digitado = "1.2345") seja confundido
 * com um decimal em formato EN e trunque o valor após poucos dígitos.
 */
export function maskMoneyInput(value: string): string {
  const cleaned = value.replace(/\./g, '').replace(/[^\d,]/g, '');
  if (!cleaned) return '';
  const [intRaw, centsRaw] = cleaned.split(',');
  const intFormatted = (parseInt(intRaw || '0', 10)).toLocaleString('pt-BR');
  if (cleaned.includes(',')) {
    return `${intFormatted},${(centsRaw || '').slice(0, 2)}`;
  }
  return intFormatted;
}

export const CHANNEL_COLORS: Record<string, string> = {
  WHATSAPP: '#25D366',
  INSTAGRAM: '#E1306C',
  TELEGRAM: '#229ED9',
  WEBCHAT: '#6366f1',
  EMAIL: '#f59e0b',
};
