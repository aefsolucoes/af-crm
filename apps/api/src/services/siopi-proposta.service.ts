import { prisma } from '../lib/prisma';
import { logActivity } from './activity.service';

/* ── PROPOSTA no SIOPI (contratação da CAIXA, Fabio 16/11: "VAMOS USAR O SISTEMA SIOPI PARA CONTRATACAO DO CREDITO APOS VISTORIA APROVADA"; 18/11, Fernanda:
 * "vamos abrir"). A extensão "SIOPI (A&F)" faz o portal (o CRM nunca digita CPF): passo "abrir" = Nova Proposta Individual PF → CPF do proponente → Próximo Passo →
 * a tela que a CAIXA abrir volta pro card (anotação + `_siopiProposta.ultimaTela`). As etapas seguintes são mapeadas com a equipe antes de virar automático.
 * Proponente = tomador da Avaliação de Risco (maior renda — `participantesDaAvaliacao`), os outros participantes com renda como reserva.
 * Estado: `_siopiProposta` = { status: FILA | RODANDO | TELA | ERRO, passo, pedidoEm, por, tentativas, inicio, fim, cpfs, ultimaTela, telas: [{ at, titulo, etapa }] }. */

type Cf = Record<string, any>;
const LEASE_MS = 10 * 60_000;

async function salvarP(leadId: string, mut: (c: Cf) => void): Promise<Cf> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const c: Cf = { ...(((l?.customFields || {}) as Cf)._siopiProposta || {}) };
  mut(c);
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_siopiProposta}', ${JSON.stringify(c)}::jsonb, true) WHERE id = ${leadId}`;
  return c;
}
const note = (leadId: string, content: string) => prisma.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});

/** CPFs pra abrir a proposta: tomador da avaliação primeiro, depois os outros com renda. Pura. */
export function cpfsDaProposta(cf: Cf): string[] {
  const cc = require('./caixa-cadastro.service') as typeof import('./caixa-cadastro.service');
  const ps = cc.participantesDa(cf);
  const q = cc.participantesDaAvaliacao(ps);
  return [q.tomador, ...q.incluir, ...ps].filter(Boolean).map((p: any) => String(p.cpf || '').replace(/\D/g, '')).filter((c, i, a) => c.length === 11 && a.indexOf(c) === i);
}

/** A equipe pede a proposta no SIOPI (passo "abrir"). Erro em texto. */
export async function pedirPropostaSiopi(accountId: string, leadId: string, por: string, userId: string | null = null): Promise<string | null> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true } });
  if (!l) return 'Lead não encontrado';
  const cf = (l.customFields || {}) as Cf;
  if (cf._fhChosen?.bank !== 'CAIXA' && !/caixa/i.test(String(cf.instituicao || ''))) return 'O card não está seguindo pela CAIXA';
  const st = cf._siopiProposta || {};
  if (st.status === 'RODANDO' && st.inicio && Date.now() - Date.parse(st.inicio) < LEASE_MS) return 'A extensão já está com a proposta deste card';
  const cpfs = cpfsDaProposta(cf);
  if (!cpfs.length) return 'Sem CPF dos participantes (ficha de cadastro/card)';
  await salvarP(leadId, (x) => { x.status = 'FILA'; x.passo = 'abrir'; x.pedidoEm = new Date().toISOString(); x.por = por; x.tentativas = 0; x.cpfs = cpfs.length; delete x.inicio; });
  await note(leadId, `🏠 SIOPI — proposta da contratação na fila (${por}): a extensão abre a "Nova Proposta Individual PF" com o CPF do tomador da avaliação, clica em "Próximo Passo" e traz a tela pra cá. Nada além disso é preenchido.`);
  logActivity({ accountId, userId, userName: por, action: 'lead_edited', leadId, leadName: l.name, summary: 'pediu a proposta no SIOPI (contratação CAIXA)' } as any);
  return null;
}

/** Próximo trabalho de proposta pra extensão (depois de vistoria e simulação). */
export async function proximaPropostaSiopi(accountId: string): Promise<any | null> {
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND archived = false AND status = 'OPEN'
      AND "customFields"->'_siopiProposta'->>'status' IN ('FILA', 'RODANDO')
    ORDER BY "customFields"->'_siopiProposta'->>'pedidoEm' ASC LIMIT 5`;
  for (const { id } of ids) {
    const l = await prisma.lead.findUnique({ where: { id }, select: { name: true, customFields: true } });
    const cf = (l?.customFields || {}) as Cf;
    const st = cf._siopiProposta || {};
    if (st.status === 'RODANDO' && st.inicio && Date.now() - Date.parse(st.inicio) < LEASE_MS) return null; // um por vez
    if (st.status === 'RODANDO' && (st.tentativas || 0) >= 3) {
      await salvarP(id, (x) => { x.status = 'ERRO'; x.fim = new Date().toISOString(); x.erro = 'a extensão largou 3 vezes'; });
      await note(id, '⚠️ SIOPI — proposta: a extensão largou a Nova Proposta 3 vezes. Confira o SIOPI e peça de novo.');
      continue;
    }
    const cpfs = cpfsDaProposta(cf);
    if (!cpfs.length) { await salvarP(id, (x) => { x.status = 'ERRO'; x.erro = 'sem CPF'; x.fim = new Date().toISOString(); }); continue; }
    await salvarP(id, (x) => { x.status = 'RODANDO'; x.inicio = new Date().toISOString(); x.tentativas = (x.tentativas || 0) + 1; });
    return { tipo: 'proposta', passo: st.passo || 'abrir', leadId: id, leadName: l!.name, cpfs, siric: cf.num_proposta || cf._fhChosen?.proposta || null };
  }
  return null;
}

/** Retorno da extensão: a tela que abriu (ou o erro). Sessão do SIOPI caída → volta pra fila. */
export async function reportPropostaSiopi(accountId: string, leadId: string, b: { etapa?: string; erro?: string; tela?: any; cpfUsado?: number; passo?: string; versao?: string }): Promise<void> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true } });
  if (!l) return;
  const etapa = String(b.etapa || 'ERRO');
  const tela = b.tela && typeof b.tela === 'object' ? {
    titulo: String(b.tela.titulo || '').slice(0, 200), texto: String(b.tela.texto || '').slice(0, 8000), erro: String(b.tela.erro || '').slice(0, 500),
    campos: Array.isArray(b.tela.campos) ? b.tela.campos.slice(0, 150) : [], botoes: Array.isArray(b.tela.botoes) ? b.tela.botoes.slice(0, 80) : [],
  } : null;
  if (etapa === 'AGUARDANDO_LOGIN') {
    await salvarP(leadId, (x) => { x.status = 'FILA'; x.ultimoErro = b.erro || 'SIOPI sem login'; delete x.inicio; });
    return;
  }
  await salvarP(leadId, (x) => {
    x.status = etapa === 'TELA' ? 'TELA' : 'ERRO'; x.fim = new Date().toISOString(); x.erro = b.erro || null; x.versaoExt = b.versao || null;
    if (tela) { x.ultimaTela = { at: new Date().toISOString(), passo: b.passo || x.passo, cpfUsado: b.cpfUsado || null, ...tela }; x.telas = [...(x.telas || []), { at: new Date().toISOString(), passo: b.passo || x.passo, titulo: tela.titulo, etapa }].slice(-15); }
  });
  const campos = (tela?.campos || []).filter((c: any) => c?.nome).map((c: any) => `• ${c.rotulo || c.nome}${c.valor ? `: ${c.valor}` : ''}${c.opcoes ? ` [${c.opcoes.length} opções]` : ''}`).slice(0, 40);
  const botoes = (tela?.botoes || []).map((x: any) => x.texto).filter(Boolean).slice(0, 30);
  await note(leadId, `🏠 SIOPI — proposta (${b.passo || 'abrir'}): ${etapa === 'TELA' ? `abriu "${tela?.titulo || 'tela seguinte'}"${b.cpfUsado ? ` (com o ${b.cpfUsado}º CPF)` : ''}` : `PAROU — ${b.erro || 'erro'}`}${tela?.texto ? `\n\n${tela.texto.slice(0, 2500)}` : ''}${campos.length ? `\n\nCampos:\n${campos.join('\n')}` : ''}${botoes.length ? `\n\nBotões: ${botoes.join(' · ')}` : ''}`);
  try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title: `🏠 ${l.name}: proposta no SIOPI`, body: (etapa === 'TELA' ? `abriu "${tela?.titulo || 'tela seguinte'}"` : `parou: ${b.erro || 'erro'}`).slice(0, 160), leadId }).catch(() => {}); } catch { /* só aviso */ }
}
