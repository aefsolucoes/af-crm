import { prisma } from '../lib/prisma';
import { vistoriaPreview, solicitarVistoria } from './vistoria-inter.service';
import { contractingAutoOn, manualStep } from './contracting-auto.service';

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

/** Financiamento Habitacional (Fabio 30/10: "INTER MESMO FLUXO, os outros bancos não precisa fazer agora"): Inter escolhido → mesmo caminho do Home Equity (seguir proposta, engajamento, vistoria, laudo);
 *  Bradesco/Itaú/Santander (Credimorar), CAIXA e BRB → passo manual. Sem escolha: a equipe confirma o banco. Devolve 'INTER', o nome do banco manual, ou null (sem escolha). */
function bancoDoFinanciamento(cf: Record<string, any>): string | null {
  const escolha = String(cf._optouCaixa?.banco || cf._fhChosen?.bank || '').trim();
  if (!escolha) return null;
  return /^inter$/i.test(escolha) ? 'INTER' : escolha;
}

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
      AND p.name IN ('Em contratação Home Equity', 'Em contratação') AND st.name = 'Documentação Recebida'
      AND l."stageEnteredAt" >= ${VISTORIA_AI_FROM}
      AND NOT jsonb_exists(COALESCE(l."customFields", '{}'::jsonb), '_vistoriaRequestedAt')
      AND COALESCE(l."customFields"->'_vistoriaAi'->>'status', '') NOT IN ('MANUAL', 'ENVIADA')
    LIMIT 20`;
  for (const { id } of ids) {
    try { await uma(accountId, id, io); } catch (e: any) { console.warn('[Vistoria IA]', e?.message); }
  }
}

async function uma(accountId: string, leadId: string, io: Io): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { id: true, name: true, aiAutoReplyActive: true, customFields: true, pipeline: { select: { department: { select: { name: true } } } } } });
  if (!lead) return;
  const cf = (lead.customFields || {}) as Record<string, any>;
  if (cf._autoPaused) return;
  const st = (cf._vistoriaAi || {}) as { status?: string; since?: string; waitNoteAt?: string; erroAt?: string; contatoNoteAt?: string };

  const fh = /habitacional/i.test(lead.pipeline?.department?.name || '');
  if (fh) {
    const b = bancoDoFinanciamento(cf);
    if (!b) {
      if (st.status !== 'ESCOLHER') {
        await salva(leadId, { status: 'ESCOLHER', since: new Date().toISOString() });
        await note(leadId, '🏠 Financiamento com a documentação completa, mas sem banco escolhido ("Seguir com esta"). Confirme com o cliente qual banco segue: se for o Inter, a IA cuida do "seguir com proposta" e da vistoria.');
        push(accountId, '🏠 Escolher o banco', `${lead.name}: Financiamento sem banco escolhido`, leadId);
      }
      return;
    }
    // Santander (Credimorar): autorização + declaração de saúde assinadas pelo gov.br + ficha + documentos → Letícia (Fabio 30/10) — vistoria-santander-fh.service
    if (/^santander$/i.test(b)) {
      const sfh = require('./vistoria-santander-fh.service') as typeof import('./vistoria-santander-fh.service');
      const auto = await contractingAutoOn(accountId, leadId);
      if (!auto && !(cf._vistoriaSantFh || {}).startedByTeam) {
        const avisou = await manualStep({ accountId, leadId, leadName: lead.name, step: 'vistoria', pushTitle: '🏠 Solicitar a vistoria', pushBody: `${lead.name}: documentação completa, Financiamento pelo Santander`,
          note: '🏠 Documentação completa; o cliente segue pelo Santander (Financiamento). Passo manual (automação da contratação desligada): na vistoria do Santander do card, clique em "Iniciar / avançar": o CRM manda a autorização e a declaração de saúde pra assinar pelo gov.br, pede ao cliente o contato do corretor/vendedor e os dados do vendedor, preenche a ficha e junta os documentos; você envia à Letícia no botão "Enviar à Letícia".' });
        if (avisou) await salva(leadId, { status: 'AGUARDA_EQUIPE', banco: b, since: st.since || new Date().toISOString() });
        return;
      }
      if (st.status !== 'SANTANDER') await salva(leadId, { status: 'SANTANDER', banco: b, since: st.since || new Date().toISOString() });
      const enviado = await sfh.processVistoriaSantanderFh(accountId, leadId, io as any, { holdSend: !auto });
      if (enviado) await salva(leadId, { status: 'ENVIADA', banco: b, at: new Date().toISOString(), por: auto ? 'IA' : 'equipe' });
      return;
    }
    if (b !== 'INTER') {
      await salva(leadId, { status: 'MANUAL', banco: b, at: new Date().toISOString() });
      await note(leadId, `🏠 Financiamento: documentação completa; o cliente segue pelo ${b}. A contratação desse banco (vistoria etc.) ainda é feita à mão — o fluxo automático do Financiamento por enquanto é só do Inter.`);
      push(accountId, '🏠 Vistoria à mão', `${lead.name}: Financiamento pelo ${b} — solicitar a vistoria`, leadId);
      return;
    }
    // No Financiamento o imóvel é do VENDEDOR: quem recebe o engenheiro raramente é o comprador. Sem o "Contato vistoria", o CRM pergunta ao cliente o contato do corretor (ou do vendedor) — Fabio 30/10;
    // a resposta preenche o campo. Sem IA/automação/janela, a equipe recebe nota + push.
    if (!String(cf.contato_vistoria || '').trim()) {
      if (!st.contatoNoteAt) await salva(leadId, { contatoNoteAt: new Date().toISOString(), since: st.since || new Date().toISOString() });
      try { const { pedirDadosVistoriaFh } = require('./vistoria-santander-fh.service') as typeof import('./vistoria-santander-fh.service'); await pedirDadosVistoriaFh(accountId, leadId, 'Inter', io as any); } catch (e: any) { console.warn('[Vistoria FH] contato:', e?.message); }
      // o "seguir com proposta" não depende do contato: já pergunta ao cliente enquanto a equipe preenche
      try { const { ensureInterSeguir } = require('./inter-seguir.service') as typeof import('./inter-seguir.service'); await ensureInterSeguir(accountId, leadId, io as any); } catch (e: any) { console.warn('[Inter seguir]', e?.message); }
      return;
    }
  }

  // 1) banco
  const aprov = (await prisma.creditAnalysis.findMany({ where: { leadId, dryRun: false, status: { in: ['APPROVED', 'CONDITIONAL'] }, approvedValue: { not: null } }, select: { bank: true, chosen: true } }))
    .map((a) => ({ ...a, bank: a.bank === 'INTER_FH' ? 'INTER' : a.bank })) // Inter do Financiamento = mesmo fluxo do Inter
    .filter((a) => !/_FH$/.test(a.bank)); // Credimorar FH/CAIXA/BRB já saíram acima (passo manual)
  if (!aprov.length) return; // sem aprovação lida não há o que seguir (a conferência já moveu por documentação completa)
  const escolhido = aprov.find((a) => a.chosen)?.bank;
  const bancos = Array.from(new Set(aprov.map((a) => a.bank)));
  const banco = fh ? 'INTER' : escolhido || (bancos.length === 1 ? bancos[0] : null); // Financiamento: o cliente já escolheu o Inter ("Seguir com esta")
  if (!banco) {
    // As propostas vão ao cliente com o botão "Seguir com esta" (Fabio 12/11: "encaminhe as propostas aprovadas ao cliente para que ele escolha clicando em Seguir com esta"):
    // IA do card ligada → o CRM manda sozinho (07h–21h, uma vez; espera o print do saldo devedor pedido há menos de 24 h e a rodada nova que ele dispara);
    // IA desligada → nada sai sozinho: a equipe usa o botão "Mandar propostas pra escolher" do card.
    const an = require('./approval-notice.service') as typeof import('./approval-notice.service');
    const sd = (cf._saldoDevedor || {}) as { askedAt?: string; doneAt?: string };
    const esperaSaldo = !!sd.askedAt && !sd.doneAt && Date.now() - new Date(sd.askedAt).getTime() < 24 * 3_600_000;
    const iaOn = !!lead.aiAutoReplyActive;
    const envio = iaOn && !cf._escolhaPedidaAt && !esperaSaldo && an.inNoticeWindow()
      ? await an.sendProposalChoice({ accountId, leadId, io, quem: 'auto', abertura: 'Sua documentação está completa! ✅' }).catch((e: any) => ({ ok: false, error: String(e?.message || e), espera: false }))
      : null;
    if (st.status !== 'ESCOLHER') {
      await salva(leadId, { status: 'ESCOLHER', since: new Date().toISOString() });
      // Mandou (agora ou na conferência de documentos): o envio já deixou a nota no card. Senão, a equipe fica sabendo do botão.
      if (!envio?.ok && !cf._escolhaPedidaAt) {
        const lista = bancos.map((b) => BANCO[b] || b).join(', ');
        // Vai sozinho mais tarde (fora do horário, esperando o print do saldo devedor ou a rodada nova): só a nota. Não vai sozinho (IA desligada, conversa fechada…): nota + push.
        const vaiSozinho = iaOn && (esperaSaldo || !envio || !!envio.espera);
        const porque = !iaOn ? ' A IA deste card está desligada, então as propostas NÃO foram sozinhas:'
          : esperaSaldo ? ' As propostas vão sozinhas depois do print do saldo devedor (ou em 24 h); pra mandar antes,'
          : envio?.espera ? ' As propostas vão sozinhas quando a rodada de análise em andamento terminar; pra mandar antes,'
          : envio?.error ? ` As propostas não foram sozinhas (${envio.error}):` : ' Fora do horário (07h–21h): as propostas vão sozinhas no horário; pra mandar antes,';
        await note(leadId, `🏠 Documentação completa e o cliente tem aprovação em ${bancos.length} bancos (${lista}).${porque} use o botão "Mandar propostas pra escolher" na aba Financiamento do card, em "Análises de crédito" (o cliente escolhe no botão "Seguir com esta"), ou confirme com ele e marque a ⭐ "Escolher esta proposta".`);
        if (!vaiSozinho) push(accountId, '🏠 Escolher o banco', `${lead.name}: aprovado em ${bancos.length} bancos — mandar as propostas pra ele escolher`, leadId);
      }
    }
    return;
  }
  // Chave geral desligada (Fabio 22/10: passos manuais por enquanto): nada sai sozinho — a equipe recebe a nota com o que fazer. Ligando a chave, o card segue daqui automaticamente.
  if (!(await contractingAutoOn(accountId, leadId))) {
    const nome = BANCO[banco] || banco;
    // Santander: se a equipe já começou pelo botão do card, o CRM continua conferindo assinatura/documentos (e segura o envio à Letícia até o clique) e avisa o colaborador se faltar a CND de IPTU.
    if (banco === 'CREDIMORAR') {
      const sant = require('./vistoria-santander.service') as typeof import('./vistoria-santander.service');
      if ((cf._vistoriaSant || {}).startedByTeam) {
        if (st.status !== 'SANTANDER') await salva(leadId, { status: 'SANTANDER', banco, since: st.since || new Date().toISOString() });
        const enviado = await sant.processVistoriaSantander(accountId, leadId, io as any, { holdSend: true });
        if (enviado) await salva(leadId, { status: 'ENVIADA', banco, at: new Date().toISOString(), por: 'equipe' });
        return;
      }
      await sant.avisaCndSeFalta(accountId, leadId).catch(() => {});
    }
    const passos = banco === 'INTER'
      ? 'Se o e-mail de engajamento do Inter ainda não chegou, confirme com o cliente e clique em "Seguir com proposta" no portal; com o e-mail na caixa, use o botão "Solicitar vistoria" do card (os anexos já vêm marcados).'
      : banco === 'CREDIMORAR'
        ? 'Abra a aba Financiamento do card, em "Vistoria do imóvel (Santander)", e clique em "Iniciar / avançar": o CRM manda a autorização USECASA ao cliente (assinar pelo gov.br), junta o cadastro WEB CASAS e os documentos da pasta, e você envia à Letícia no botão "Enviar à Letícia". Se faltar a CND de IPTU, o colaborador do card recebe um push para solicitá-la.'
        : `Solicite a vistoria do ${nome} à mão.`;
    const avisou = await manualStep({ accountId, leadId, leadName: lead.name, step: 'vistoria', pushTitle: '🏠 Solicitar a vistoria', pushBody: `${lead.name}: documentação completa, segue pelo ${nome}`,
      note: `🏠 Documentação completa; o cliente segue pelo ${nome}. Passo manual (automação da contratação desligada): ${passos}` });
    if (avisou) await salva(leadId, { status: 'AGUARDA_EQUIPE', banco, since: st.since || new Date().toISOString() });
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
