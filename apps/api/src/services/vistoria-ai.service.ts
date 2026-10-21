import { prisma } from '../lib/prisma';
import { vistoriaPreview, solicitarVistoria } from './vistoria-inter.service';

type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | null | undefined;

/**
 * DOCUMENTAÇÃO COMPLETA → A IA SOLICITA A VISTORIA (Fabio 21/10, caso Luiz Fernando: "sempre que a documentação estiver completa a IA confirma com qual banco o cliente irá seguir e solicita a vistoria; por enquanto só
 * temos como solicitar a do Inter"). A documentação completa já leva o card por "Fechado" pro funil "Em contratação Home Equity / Documentação Recebida" e o CRM cria a pasta no Drive (docs-checker + organizador). Daqui:
 *  1) banco: UM banco aprovado → segue por ele ("quando só tem um banco aprovado, seguir pelo banco aprovado"); vários aprovados → vale o ⭐ "Escolher esta proposta" (sem escolha, avisa a equipe e espera);
 *  2) só o INTER tem solicitação automática (e-mail ao consultor do Inter, mesma conversa do "[Inter] Engajamento Automático", com a matrícula/ônus e o cadastro imobiliário da pasta do Drive): sem o e-mail de engajamento
 *     (ou sem a matrícula na pasta IMOVEL) ela ESPERA e envia sozinha quando chegar; outro banco → nota + push pra equipe pedir à mão;
 *  3) ao conseguir solicitar, o card vai pra "Vistoria do Imóvel" (feito dentro de solicitarVistoria, vale também pro botão do card).
 * Estado em customFields._vistoriaAi = { status: AGUARDA_ENGAJAMENTO | ESCOLHER | MANUAL | ENVIADA | ERRO, … }. Só pra cards que entraram em "Documentação Recebida" a partir de VISTORIA_AI_FROM (não mexe em cliente antigo).
 */

export const VISTORIA_AI_FROM = new Date('2026-10-21T13:00:00Z');
const ESPERA_MAX_MS = 10 * 86_400_000; // sem engajamento em 10 dias: a equipe cuida
const ERRO_RETRY_MS = 30 * 60_000;

const note = (leadId: string, content: string) => prisma.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});
const push = (accountId: string, title: string, body: string, leadId: string) => { try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title, body, leadId }).catch(() => {}); } catch { /* aviso */ } };
const BANCO: Record<string, string> = { INTER: 'Inter', CREDITAS: 'Creditas', CREDIMORAR: 'Santander' };

async function salva(leadId: string, patch: Record<string, unknown>) {
  const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cf = { ...((fresh?.customFields || {}) as Record<string, any>) };
  cf._vistoriaAi = { ...(cf._vistoriaAi || {}), ...patch };
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: cf as any } });
}

export async function processVistoriaAi(accountId: string, io: Io): Promise<void> {
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT l.id FROM "Lead" l
    JOIN "Pipeline" p ON p.id = l."pipelineId" JOIN "Stage" st ON st.id = l."stageId"
    WHERE l."accountId" = ${accountId} AND l.status = 'OPEN' AND l.archived = false AND l."isGroup" = false
      AND p.name = 'Em contratação Home Equity' AND st.name = 'Documentação Recebida'
      AND l."stageEnteredAt" >= ${VISTORIA_AI_FROM}
      AND NOT jsonb_exists(COALESCE(l."customFields", '{}'::jsonb), '_vistoriaRequestedAt')
      AND COALESCE(l."customFields"->'_vistoriaAi'->>'status', '') NOT IN ('MANUAL', 'ENVIADA')
    LIMIT 20`;
  for (const { id } of ids) {
    try { await uma(accountId, id, io); } catch (e: any) { console.warn('[Vistoria IA]', e?.message); }
  }
}

async function uma(accountId: string, leadId: string, io: Io): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { id: true, name: true, customFields: true } });
  if (!lead) return;
  const cf = (lead.customFields || {}) as Record<string, any>;
  if (cf._autoPaused) return;
  const st = (cf._vistoriaAi || {}) as { status?: string; since?: string; waitNoteAt?: string; erroAt?: string };

  // 1) banco
  const aprov = await prisma.creditAnalysis.findMany({ where: { leadId, dryRun: false, status: { in: ['APPROVED', 'CONDITIONAL'] }, approvedValue: { not: null } }, select: { bank: true, chosen: true } });
  if (!aprov.length) return; // sem aprovação lida não há o que seguir (a conferência já moveu por documentação completa)
  const escolhido = aprov.find((a) => a.chosen)?.bank;
  const bancos = Array.from(new Set(aprov.map((a) => a.bank)));
  const banco = escolhido || (bancos.length === 1 ? bancos[0] : null);
  if (!banco) {
    if (st.status !== 'ESCOLHER') {
      await salva(leadId, { status: 'ESCOLHER', since: new Date().toISOString() });
      await note(leadId, `🏠 Documentação completa e o cliente tem aprovação em ${bancos.length} bancos (${bancos.map((b) => BANCO[b] || b).join(', ')}). Confirme com ele qual segue e marque a ⭐ "Escolher esta proposta": aí a IA solicita a vistoria sozinha.`);
      push(accountId, '🏠 Escolher o banco', `${lead.name}: aprovado em ${bancos.length} bancos — confirmar qual segue`, leadId);
    }
    return;
  }
  // 2a) Santander: fluxo próprio por e-mail à Letícia (autorização USECASA assinada pelo cliente no gov.br + cadastro WEB CASAS + documentos) — vistoria-santander.service
  if (banco === 'CREDIMORAR') {
    if (st.status !== 'SANTANDER') await salva(leadId, { status: 'SANTANDER', banco, since: st.since || new Date().toISOString() });
    const { processVistoriaSantander } = require('./vistoria-santander.service') as typeof import('./vistoria-santander.service');
    const enviado = await processVistoriaSantander(accountId, leadId, io as any);
    if (enviado) await salva(leadId, { status: 'ENVIADA', banco, at: new Date().toISOString(), por: 'IA' });
    return;
  }
  // 2) só o Inter tem solicitação automática
  if (banco !== 'INTER') {
    await salva(leadId, { status: 'MANUAL', banco, at: new Date().toISOString() });
    await note(leadId, `🏠 Documentação completa; o cliente segue pelo ${BANCO[banco] || banco}. A solicitação automática de vistoria só existe pro Inter: peça a vistoria do ${BANCO[banco] || banco} à mão.`);
    push(accountId, '🏠 Vistoria à mão', `${lead.name}: segue pelo ${BANCO[banco] || banco} — solicitar a vistoria`, leadId);
    return;
  }
  if (st.status === 'ERRO' && st.erroAt && Date.now() - new Date(st.erroAt).getTime() < ERRO_RETRY_MS) return;
  const pv = await vistoriaPreview(accountId, leadId);
  if (pv.jaSolicitadaEm) { await salva(leadId, { status: 'ENVIADA', at: pv.jaSolicitadaEm }); return; }
  const marcados = pv.anexos.filter((a) => a.checked);
  const temMatricula = marcados.some((a) => /MATRICULA|ONUS/i.test(a.name));
  const faltas = [!pv.engajamentoRecebido && 'o e-mail de engajamento do Inter', !pv.to && 'o e-mail do consultor do Inter', !temMatricula && 'a matrícula/certidão de ônus na pasta IMOVEL do Drive'].filter(Boolean) as string[];
  if (faltas.length) {
    // Sem o e-mail de engajamento do Inter é porque o cliente ainda não "seguiu com a proposta" no portal: o CRM pergunta a ele (uma vez) e a equipe clica depois do SIM (inter-seguir.service).
    if (!pv.engajamentoRecebido) { try { const { ensureInterSeguir } = require('./inter-seguir.service') as typeof import('./inter-seguir.service'); await ensureInterSeguir(accountId, leadId, io as any); } catch (e: any) { console.warn('[Inter seguir]', e?.message); } }
    const desde = st.since || new Date().toISOString();
    if (Date.now() - new Date(desde).getTime() > ESPERA_MAX_MS) { await salva(leadId, { status: 'MANUAL', at: new Date().toISOString() }); await note(leadId, '🏠 Vistoria do Inter: passaram 10 dias sem o e-mail de engajamento — a IA parou de esperar. Solicite à mão.'); return; }
    if (!st.waitNoteAt) {
      await salva(leadId, { status: 'AGUARDA_ENGAJAMENTO', since: desde, waitNoteAt: new Date().toISOString() });
      await note(leadId, `🏠 Documentação completa e o cliente segue pelo Inter. A vistoria será solicitada ao Inter assim que chegar ${faltas.join(' e ')} — a IA envia sozinha (e leva o card pra "Vistoria do Imóvel").`);
    } else if (st.status !== 'AGUARDA_ENGAJAMENTO') await salva(leadId, { status: 'AGUARDA_ENGAJAMENTO' });
    return;
  }
  // 3) tudo pronto: solicita (e solicitarVistoria move o card pra "Vistoria do Imóvel")
  const dono = await prisma.user.findFirst({ where: { accountId, role: 'ADMIN' }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  if (!dono) return;
  try {
    await solicitarVistoria({ accountId, userId: dono.id, leadId, to: pv.to, cc: '', subject: pv.subject, body: pv.body, replyToId: pv.replyToId, attachDriveFileIds: marcados.map((a) => a.id), io: io as any });
    await salva(leadId, { status: 'ENVIADA', at: new Date().toISOString(), por: 'IA' });
    await note(leadId, '🤖 A IA solicitou a vistoria ao Inter (e-mail na conversa do engajamento, com a matrícula/ônus e o cadastro imobiliário) e levou o card pra "Vistoria do Imóvel". Falta subir a matrícula e a guia do IPTU no portal do Inter (aba Documentos da proposta).');
  } catch (e: any) {
    await salva(leadId, { status: 'ERRO', erroAt: new Date().toISOString(), erro: String(e?.message || e).slice(0, 200) });
    await note(leadId, `⚠️ A IA tentou solicitar a vistoria ao Inter e não conseguiu: ${e?.message || e}. Use o botão "Solicitar vistoria" do card.`);
    push(accountId, '⚠️ Vistoria não saiu', lead.name, leadId);
  }
}
