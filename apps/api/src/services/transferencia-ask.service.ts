import { prisma } from '../lib/prisma';
import { sendOutboundWhatsApp } from './message.service';
import { contractingAutoOn } from './contracting-auto.service';

type Io = Parameters<typeof sendOutboundWhatsApp>[0]['io'];

/**
 * ANTES DE FINALIZAR O CONTRATO O IMÓVEL PRECISA JÁ ESTAR TRANSFERIDO (Fabio 21/10, caso Luiz Fernando, que disse que ainda não transferiu a escritura: "antes de finalizar o contrato precisa estar com o imóvel
 * já transferido, pode solicitar isso ao cliente Luiz, após a vistoria — coloca isso como regra"; antes: "precisa informá-lo que precisa transferir no decorrer do processo").
 * O que o CRM faz:
 *  1) cliente que diz que não transferiu/registrou (marca `_transferenciaPendente` em certidao-offer): NÃO trava a conferência de documentos nem a análise; a IA da conversa avisa, uma vez, que a transferência
 *     precisa ser feita no decorrer do processo (regra TRANSFER_RULES em ai-shared.CORE_RULES);
 *  2) depois da vistoria — card no funil "Em contratação Home Equity" em "Análise Jurídica" (ou "Registro em Cartório") —, esta função PEDE a transferência ao cliente, UMA vez, e a matrícula atualizada em seguida;
 *  3) a equipe recebe nota + push (a transferência é condição pra assinar o contrato).
 */

const ETAPAS_DEPOIS_DA_VISTORIA = ['Análise Jurídica', 'Registro em Cartório'];

export const transferenciaAskText = (): string => [
  'Antes de assinar o contrato, o imóvel precisa já estar transferido: a escritura registrada em cartório, com a matrícula atualizada no nome de quem vai dar o imóvel em garantia.',
  '',
  'Como a vistoria já foi feita, esse é o momento de providenciar o registro. Quando a matrícula atualizada ficar pronta, me envie por aqui que a gente segue com o contrato.',
  '',
  'Se tiver qualquer dúvida de como fazer, me avise.',
].join('\n');

async function marca(leadId: string, valor: Record<string, unknown>) {
  const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...((fresh?.customFields || {}) as Record<string, any>), _transferenciaAsk: valor } as any } });
}

export async function processTransferenciaAsk(accountId: string, io: Io): Promise<void> {
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT l.id FROM "Lead" l
    JOIN "Pipeline" p ON p.id = l."pipelineId" JOIN "Stage" st ON st.id = l."stageId"
    WHERE l."accountId" = ${accountId} AND l.status = 'OPEN' AND l.archived = false AND l."isGroup" = false
      AND p.name = 'Em contratação Home Equity' AND st.name IN ('Análise Jurídica', 'Registro em Cartório')
      AND jsonb_exists(COALESCE(l."customFields", '{}'::jsonb), '_transferenciaPendente')
      AND NOT jsonb_exists(COALESCE(l."customFields", '{}'::jsonb), '_transferenciaAsk')
    LIMIT 20`;
  for (const { id } of ids) {
    try { await askOne(accountId, id, io); } catch (e: any) { console.warn('[Transferência] pergunta:', e?.message); }
  }
}

async function askOne(accountId: string, leadId: string, io: Io): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { id: true, name: true, aiAutoReplyActive: true, customFields: true, stage: { select: { name: true } } } });
  if (!lead || !etapaOk(lead.stage?.name)) return;
  const cf = (lead.customFields || {}) as Record<string, any>;
  if (cf._autoPaused || cf._transferenciaAsk || !cf._transferenciaPendente) return;
  // matrícula/certidão mais nova já mostra o imóvel no nome do cliente? (a equipe confere: aqui só registra quando a conversa já tratou do assunto)
  const jaPediu = await prisma.message.count({ where: { leadId, direction: 'OUTBOUND', createdAt: { gte: new Date(Date.now() - 3 * 86_400_000) }, content: { contains: 'transferid', mode: 'insensitive' } } });
  if (jaPediu > 0 && !lead.aiAutoReplyActive) { await marca(leadId, { skip: 'a equipe já tratou do assunto', at: new Date().toISOString() }); return; }
  const avisaEquipe = async (motivo: string) => {
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🏠 ${motivo} Regra do Fabio: antes de finalizar o contrato o imóvel precisa estar transferido (escritura registrada, matrícula atualizada). Peça isso ao cliente e a matrícula nova.` } }).catch(() => {});
    try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title: '🏠 Pedir a transferência do imóvel', body: `${lead.name}: depois da vistoria, a escritura precisa estar registrada antes do contrato`, leadId }).catch(() => {}); } catch { /* aviso */ }
  };
  if (!lead.aiAutoReplyActive) { await marca(leadId, { teamNotifiedAt: new Date().toISOString(), por: 'equipe (IA do card desligada)' }); await avisaEquipe('O cliente ainda não transferiu o imóvel e o card já passou da vistoria (IA do card desligada, não pedi sozinha).'); return; }
  // Chave geral desligada (Fabio 22/10): a equipe pede à mão.
  if (!(await contractingAutoOn(accountId))) { await marca(leadId, { teamNotifiedAt: new Date().toISOString(), por: 'equipe (automação da contratação desligada)' }); await avisaEquipe(`O cliente ainda não transferiu o imóvel e o card já passou da vistoria. Passo manual (automação da contratação desligada). Texto pronto:\n“${transferenciaAskText().replace(/\n+/g, ' ')}”\n`); return; }
  const { inNoticeWindow, whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  if (!inNoticeWindow()) return;
  if (!(await whatsappWindowOpen(leadId))) {
    if (!cf._transferenciaWait) {
      const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
      await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...((fresh?.customFields || {}) as Record<string, any>), _transferenciaWait: new Date().toISOString() } as any } });
      await avisaEquipe('O cliente ainda não transferiu o imóvel e o card já passou da vistoria, mas a janela de 24 h do WhatsApp está fechada (a IA pede assim que ele responder).');
    }
    return;
  }
  const r = await sendOutboundWhatsApp({ accountId, leadId, content: transferenciaAskText(), io: io as any });
  if (!r.success) return;
  await marca(leadId, { askedAt: new Date().toISOString() });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: '🏠 Depois da vistoria: pedi ao cliente a transferência do imóvel (escritura registrada, matrícula atualizada) — condição pra finalizar o contrato.' } }).catch(() => {});
}

const etapaOk = (nome?: string | null) => !!nome && ETAPAS_DEPOIS_DA_VISTORIA.includes(nome);
