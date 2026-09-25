import { PrismaClient } from '@prisma/client';
import { logActivity } from './activity.service';

const prisma = new PrismaClient();

/* Estrela automática (pedido do Fabio): cliente grande sobe pro topo da Inbox
 * e do Funil — Home Equity com crédito acima de R$ 150 mil, Financiamento
 * Habitacional acima de R$ 300 mil (sem valor do crédito no card, usa imóvel
 * menos entrada: o formulário do Habitacional não traz o valor financiado).
 * Roda por polling porque o valor chega por vários caminhos (formulário, IA,
 * edição à mão, importação). Marca cada card UMA vez (_autoStarredAt): se
 * alguém tirar a estrela depois, não volta. */

const THRESHOLDS: Record<string, number> = {
  'home equity': 150_000,
  'financiamento habitacional': 300_000,
};

function norm(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/** "660000" / "300.000" / "1.500.000,00" / "R$ 450.000" → número. */
function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).trim().replace(/r\$/i, '').trim();
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s) || s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function creditValue(cf: Record<string, unknown>): number | null {
  const credit = toNumber(cf.valor_credito);
  if (credit !== null) return credit;
  const property = toNumber(cf.valor_imovel);
  if (property === null) return null;
  return property - (toNumber(cf.valor_entrada) || 0);
}

let running = false;

export async function autoStarBigLeads(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const leads = await prisma.lead.findMany({
      where: { status: 'OPEN', archived: false, isGroup: false, starred: false },
      select: { id: true, name: true, accountId: true, customFields: true, pipeline: { select: { department: { select: { name: true } } } } },
    });
    for (const lead of leads) {
      const threshold = THRESHOLDS[norm(lead.pipeline.department?.name || '')];
      if (!threshold) continue;
      const cf = (lead.customFields || {}) as Record<string, unknown>;
      if (cf._autoStarredAt) continue;
      const credit = creditValue(cf);
      if (credit === null || credit <= threshold) continue;

      await prisma.lead.update({
        where: { id: lead.id },
        data: { starred: true, customFields: { ...cf, _autoStarredAt: new Date().toISOString() } as any },
      });
      logActivity({
        accountId: lead.accountId, userId: null, userName: 'Estrela automática', action: 'lead_edited', leadId: lead.id, leadName: lead.name,
        summary: `marcou com estrela: crédito de ${credit.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 })}`,
      });
    }
  } finally {
    running = false;
  }
}
