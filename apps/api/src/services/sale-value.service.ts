import { prisma } from '../lib/prisma';

/**
 * VALOR DA VENDA NA VISTORIA (Fabio 26/10: "o valor de compra e venda deve ser ajustado com a proposta escolhida pelo cliente ou por nós na fase de vistoria").
 * Até aqui o "Valor da venda" (Lead.value) acompanha o crédito PEDIDO (trigger lead_sale_value_follows_credit). Na Vistoria ele passa a ser o valor APROVADO da
 * proposta que o cliente segue: a escolhida (⭐ na Análise de Crédito — pelo cliente ou pela equipe) ou, sem escolha, a do único banco que aprovou (mesma regra da tela).
 * Poller (1 min, junto da análise automática): só cards ABERTOS numa etapa de Vistoria; mexe só quando o valor muda; o crédito pedido (valor_credito) não é tocado.
 * Mais de um banco aprovado e nenhum escolhido: anota uma vez pedindo a escolha. Card sem análise no CRM: fica como está.
 */
export async function syncSaleValueAtVistoria(accountId: string): Promise<void> {
  const leads = await prisma.lead.findMany({
    where: { accountId, status: 'OPEN', archived: false, stage: { name: { contains: 'vistoria', mode: 'insensitive' } } },
    select: { id: true, name: true, value: true, customFields: true },
    take: 100,
  });
  const nomes: Record<string, string> = { INTER: 'Inter', CREDITAS: 'Creditas', CREDIMORAR: 'Santander' };
  const brl = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  for (const l of leads) {
    const aprovadas = await prisma.creditAnalysis.findMany({
      where: { leadId: l.id, dryRun: false, status: { in: ['APPROVED', 'CONDITIONAL'] }, approvedValue: { not: null }, source: { not: 'AI_SIM' } },
      orderBy: { createdAt: 'desc' }, take: 12, select: { bank: true, approvedValue: true, chosen: true, proposalNumber: true },
    });
    if (!aprovadas.length) continue;
    const bancos = Array.from(new Set(aprovadas.map((a) => a.bank)));
    const seguida = aprovadas.find((a) => a.chosen) || (bancos.length === 1 ? aprovadas[0] : null);
    const cf = (l.customFields || {}) as Record<string, any>;
    if (!seguida) {
      if (!cf._valorVendaSemEscolha) {
        await prisma.lead.update({ where: { id: l.id }, data: { customFields: { ...cf, _valorVendaSemEscolha: new Date().toISOString() } as any } });
        await prisma.note.create({ data: { leadId: l.id, type: 'COMMENT', content: `💰 Card na Vistoria com mais de um banco aprovado (${bancos.map((b) => nomes[b] || b).join(', ')}): marque a proposta que o cliente vai seguir (⭐ na aba Análise de Crédito) pra eu ajustar o Valor da venda.` } }).catch(() => {});
      }
      continue;
    }
    const novo = Number(seguida.approvedValue);
    if (!(novo > 0) || Math.abs(novo - Number(l.value || 0)) < 1) continue;
    await prisma.lead.update({ where: { id: l.id }, data: { value: novo } });
    await prisma.note.create({ data: { leadId: l.id, type: 'COMMENT', content: `💰 Valor da venda ajustado na Vistoria: ${l.value ? brl(Number(l.value)) : '—'} → ${brl(novo)} (proposta ${seguida.chosen ? 'escolhida' : 'do único banco que aprovou'}: ${nomes[seguida.bank] || seguida.bank}${seguida.proposalNumber ? ` nº ${seguida.proposalNumber}` : ''}).` } }).catch(() => {});
  }
}
