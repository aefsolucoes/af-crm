import { prisma } from '../lib/prisma';
import { logActivity } from './activity.service';

type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | undefined;

/**
 * CAIXA SÓ A PEDIDO DO CLIENTE (Fabio 01/11 — substitui a pergunta "Vi que você marcou a CAIXA…" de 21/10, que saiu): "SE JÁ PASSAMOS AS APROVAÇÕES AO CLIENTE, NÃO TEM POR
 * QUE OFERECERMOS CAIXA". A documentação da CAIXA só é pedida quando algum banco aprovou, o CLIENTE pediu a CAIXA e tem nome limpo e imóvel com Habite-se — a IA da conversa
 * faz as perguntas (regra CAIXA em ai-shared.CORE_RULES) e marca "caixaRota". Aí o card VOLTA pra Pré-Análise do funil de Vendas do setor (HE e FH) e fica lá até o resultado da
 * CAIXA ("O CADASTRO NA CAIXA DEVE OCORRER EM PRÉ-ANÁLISE AINDA"): a conferência dos documentos da CAIXA, a ficha e o cadastro rodam nessa etapa.
 * Também param (Fabio 01/11): a documentação da CAIXA combinada antes da proposta e o reprovado que volta pela CAIXA.
 */

/** Algum banco aprovou de verdade (não simulação), ou o aviso de aprovação do Financiamento já saiu. */
export async function temAprovacao(leadId: string, cf: Record<string, any>): Promise<boolean> {
  if (cf._fhNotice?.sentAt) return true;
  return (await prisma.creditAnalysis.count({ where: { leadId, dryRun: false, source: { not: 'AI_SIM' }, status: { in: ['APPROVED', 'CONDITIONAL'] } } })) > 0;
}

/** O cliente pediu a CAIXA e passou nas regras dela: marca `_caixaRota` (+ `_optouCaixa`, que guarda as outras aprovações), volta o card pra Pré-Análise e agenda a
 *  conferência dos documentos que já estão na conversa. true = entrou agora. */
export async function entrarRotaCaixa(accountId: string, leadId: string, motivo: string | null, io?: Io): Promise<boolean> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { id: true, name: true, customFields: true, stage: { select: { name: true } }, pipeline: { select: { departmentId: true } } } });
  if (!lead) return false;
  const cf = (lead.customFields || {}) as Record<string, any>;
  if (cf._caixaRota) return false;
  if (!(await temAprovacao(leadId, cf))) {
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: '🏦 O cliente pediu a CAIXA, mas nenhum banco aprovou ainda: pela regra (Fabio 01/11) a documentação da CAIXA só é pedida depois de alguma aprovação. O card ficou onde estava.' } }).catch(() => {});
    return false;
  }
  const agora = new Date().toISOString();
  const rota = { at: agora, motivo: motivo || null, etapaAntes: lead.stage?.name || null };
  // Só as duas chaves (jsonb_set): regravar o card inteiro apaga o que outro processo gravou no meio (corrida no customFields, 29/10).
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_caixaRota}', ${JSON.stringify(rota)}::jsonb, true), '{_optouCaixa}', ${JSON.stringify({ banco: 'CAIXA', at: agora })}::jsonb, true) WHERE id = ${leadId}`;
  const sales = lead.pipeline?.departmentId
    ? await prisma.pipeline.findFirst({ where: { accountId, departmentId: lead.pipeline.departmentId, name: { contains: 'Vendas', mode: 'insensitive' } }, select: { name: true, stages: { select: { id: true, name: true } } } })
    : null;
  const pre = sales?.stages.find((s) => /^pr[eé].?an[aá]lise/i.test(s.name));
  let movido = '';
  if (pre && sales && lead.stage?.name !== pre.name) {
    const { updateLeadStage } = require('./lead.service') as typeof import('./lead.service');
    await updateLeadStage(leadId, accountId, pre.id);
    movido = `${sales.name} / ${pre.name}`;
    if (io) io.to(`lead:${leadId}`).emit('lead_moved', { leadId, stageId: pre.id });
  }
  // Documento que já está na conversa (RG, comprovante…) entra na conferência da CAIXA sem esperar arquivo novo.
  const due = new Date(Date.now() + 5 * 60_000).toISOString();
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_docsCheckDue}', ${JSON.stringify(due)}::jsonb, true) WHERE id = ${leadId}`;
  await prisma.note.create({ data: { leadId, type: movido ? 'STAGE_CHANGE' : 'COMMENT', content: `🏦 O cliente PEDIU a CAIXA (nome limpo, imóvel com Habite-se)${motivo ? ` — ${motivo}` : ''}. ${movido ? `Card voltou pra "${movido}"` : 'Card fica na Pré-Análise'} até o resultado da CAIXA. As aprovações dos outros bancos ficam GUARDADAS. A IA pediu a documentação da CAIXA; quando estiver completa, o CRM gera a ficha e a extensão faz o cadastro.` } }).catch(() => {});
  (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title: `🏦 ${lead.name}: pediu a CAIXA`, body: `Card ${movido ? 'voltou pra Pré-Análise' : 'na Pré-Análise'}; documentação da CAIXA pedida`, leadId }).catch(() => {});
  logActivity({ accountId, userId: null, userName: 'Assistente IA', action: 'lead_edited', leadId, leadName: lead.name, summary: `cliente pediu a CAIXA${movido ? ' — card voltou pra Pré-Análise' : ''}` });
  return true;
}
