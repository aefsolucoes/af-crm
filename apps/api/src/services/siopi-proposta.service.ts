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

/** Avaliação de Risco do Caixa Aqui "Aprovada e Propagada" = o SIOPI já criou a proposta; "Aprovada e Não Propagada" = não criou, precisa da Nova Proposta
 *  (Fabio 18/11: "se a proposta no caixa aqui foi aprovada e propagada, a proposta no SIOPI foi criada, se foi aprovada e não propagada quer dizer que não criou").
 *  null = o texto do resultado não diz. Pura. */
export function avaliacaoPropagada(cf: Cf): boolean | null {
  if (typeof cf._caixaResultado?.propagada === 'boolean') return cf._caixaResultado.propagada; // gravado na aprovação, do texto original
  const t = String(cf._caixaResultado?.ultimaTela || cf._caixaResultado?.texto || '');
  if (/aprovad[ao]\s+e\s+n[ãa]o\s+propagad/i.test(t)) return false;
  if (/aprovad[ao]\s+e\s+propagad/i.test(t)) return true;
  return null;
}

/** Proposta mais recente = maior nº sequencial ("0007.3444.0000525-4" > "…0000520-3"). Pura. */
export function maisRecente(nums: string[]): string | null {
  const seq = (n: string) => Number((String(n).match(/\.(\d{7})-\d$/) || [])[1] || 0);
  return nums.filter(Boolean).sort((a, b) => seq(b) - seq(a))[0] || null;
}

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
    if (st.passo === 'complementar') {
      if (!st.escolhida || !st.complementar) { await salvarP(id, (x) => { x.status = 'ERRO'; x.erro = 'sem a proposta escolhida ou os dados do Complementar Dados'; x.fim = new Date().toISOString(); }); continue; }
      await salvarP(id, (x) => { x.status = 'RODANDO'; x.inicio = new Date().toISOString(); x.tentativas = (x.tentativas || 0) + 1; });
      return { tipo: 'proposta', passo: 'complementar', leadId: id, leadName: l!.name, numero: st.escolhida, dados: st.complementar.dados, salvar: st.complementar.salvar === true };
    }
    const cpfs = cpfsDaProposta(cf);
    if (!cpfs.length) { await salvarP(id, (x) => { x.status = 'ERRO'; x.erro = 'sem CPF'; x.fim = new Date().toISOString(); }); continue; }
    await salvarP(id, (x) => { x.status = 'RODANDO'; x.inicio = new Date().toISOString(); x.tentativas = (x.tentativas || 0) + 1; });
    // A extensão procura a proposta pelo CPF ANTES de criar (Fabio 18/11: "primeiro precisa ver se o Caixa Aqui criou a proposta automaticamente"); propagada e não achada = para.
    return { tipo: 'proposta', passo: st.passo || 'abrir', leadId: id, leadName: l!.name, cpfs, propagada: avaliacaoPropagada(cf) === true, siric: cf.num_proposta || cf._fhChosen?.proposta || null };
  }
  return null;
}

/** Retorno da extensão: a tela que abriu (ou o erro). Sessão do SIOPI caída → volta pra fila. */
export async function reportPropostaSiopi(accountId: string, leadId: string, b: { etapa?: string; erro?: string; tela?: any; cpfUsado?: number; passo?: string; versao?: string; propostas?: { numero?: string; linha?: string }[] }): Promise<void> {
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
    x.status = ['TELA', 'JA_EXISTE', 'NAO_ACHOU', 'COMPLEMENTADO', 'PREENCHIDO'].includes(etapa) ? etapa : 'ERRO';
    if (b.passo === 'complementar') x.complementar = { ...(x.complementar || {}), resultado: etapa, feito: (b as any).feito || null, avisos: (b as any).avisos || [], at: new Date().toISOString() }; x.fim = new Date().toISOString(); x.erro = b.erro || null; x.versaoExt = b.versao || null;
    if (Array.isArray(b.propostas)) x.propostas = b.propostas.slice(0, 20).map((p) => ({ numero: String(p?.numero || ''), linha: String(p?.linha || '').slice(0, 300) }));
    // Mais de uma proposta ativa: segue só a MAIS RECENTE (maior número sequencial da agência) e as outras ficam como estão (Fabio 18/11: "deixa as duas ativas e segue
    // apenas com a proposta mais recente").
    if (etapa === 'JA_EXISTE' && Array.isArray(x.propostas) && x.propostas.length) x.escolhida = maisRecente(x.propostas.filter((p: any) => !/cancelad|inativ/i.test(p.linha)).map((p: any) => p.numero)) || x.propostas[0].numero;
    if (tela) { x.ultimaTela = { at: new Date().toISOString(), passo: b.passo || x.passo, cpfUsado: b.cpfUsado || null, ...tela }; x.telas = [...(x.telas || []), { at: new Date().toISOString(), passo: b.passo || x.passo, titulo: tela.titulo, etapa }].slice(-15); }
  });
  const campos = (tela?.campos || []).filter((c: any) => c?.nome).map((c: any) => `• ${c.rotulo || c.nome}${c.valor ? `: ${c.valor}` : ''}${c.opcoes ? ` [${c.opcoes.length} opções]` : ''}`).slice(0, 40);
  const botoes = (tela?.botoes || []).map((x: any) => x.texto).filter(Boolean).slice(0, 30);
  const props = Array.isArray(b.propostas) ? b.propostas.map((p) => `• ${p?.linha || p?.numero}`).slice(0, 10) : [];
  const resumo = etapa === 'TELA' ? `abriu "${tela?.titulo || 'tela seguinte'}"${b.cpfUsado ? ` (com o ${b.cpfUsado}º CPF)` : ''}`
    : etapa === 'JA_EXISTE' ? `o SIOPI JÁ TEM proposta pro ${b.cpfUsado || 1}º CPF — não criei outra:\n${props.join('\n')}${(b.propostas || []).length > 1 ? `\nSeguimos só pela mais recente: ${maisRecente((b.propostas || []).filter((p) => !/cancelad|inativ/i.test(String(p?.linha || ''))).map((p) => String(p?.numero || ''))) || b.propostas![0]?.numero}; as outras ficam ativas, sem mexer (Fabio 18/11).` : ''}`
      : etapa === 'NAO_ACHOU' ? `NÃO ACHEI a proposta — ${b.erro || ''}`
        : etapa === 'COMPLEMENTADO' || etapa === 'PREENCHIDO' ? `Complementar Dados da ${(b as any).numero || 'proposta'} ${etapa === 'COMPLEMENTADO' ? 'SALVO' : 'preenchido (sem salvar)'}:\n${Object.entries(((b as any).feito || {}) as Record<string, string>).map(([k, v]) => `• ${k}: ${v}`).join('\n')}${((b as any).avisos || []).length ? `\nAvisos do SIOPI: ${((b as any).avisos as string[]).join(' | ')}` : ''}`
          : `PAROU — ${b.erro || 'erro'}${(b as any).feito ? `\n(preenchido até: ${Object.keys((b as any).feito).join(', ')})` : ''}${((b as any).avisos || []).length ? `\nAvisos do SIOPI: ${((b as any).avisos as string[]).join(' | ')}` : ''}`;
  await note(leadId, `🏠 SIOPI — proposta (${b.passo || 'abrir'}): ${resumo}${tela?.texto ? `\n\n${tela.texto.slice(0, 2500)}` : ''}${campos.length ? `\n\nCampos:\n${campos.join('\n')}` : ''}${botoes.length ? `\n\nBotões: ${botoes.join(' · ')}` : ''}`);
  try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title: `🏠 ${l.name}: proposta no SIOPI`, body: (etapa === 'TELA' ? `abriu "${tela?.titulo || 'tela seguinte'}"` : etapa === 'JA_EXISTE' ? `já existe: ${(b.propostas || []).map((p) => p?.numero).join(', ')}` : `parou: ${b.erro || 'erro'}`).slice(0, 160), leadId }).catch(() => {}); } catch { /* só aviso */ }
}

/** CAIXA aprovou (Fabio 18/11: "ele pode verificar isso quando aprovar o crédito"): anota se a proposta já existe no SIOPI. Propagada → a extensão só PROCURA a
 *  proposta pelo CPF (passo "localizar", nunca cria); não propagada → anota que, na contratação (depois da vistoria aprovada), vai a Nova Proposta. */
export async function aoAprovarCaixa(accountId: string, leadId: string, propagada: boolean): Promise<void> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  if (!l) return;
  const st = (((l.customFields || {}) as Cf)._siopiProposta || {}) as Cf;
  if (['RODANDO', 'TELA', 'JA_EXISTE'].includes(String(st.status || ''))) return; // já tem a proposta (ou a extensão está nela)
  if (!propagada) {
    await salvarP(leadId, (x) => { x.propagada = false; });
    // A propagação pode aparecer uns 10 min depois da aprovação (Fabio 18/11): reconsulta agendada (15 min, depois mais 15 e 30), sem segurar a extensão.
    const { salvarPropagacao } = require('./caixa-resultado.service') as typeof import('./caixa-resultado.service');
    const jaAgendada = ['AGENDADA', 'RODANDO'].includes(String((((l.customFields || {}) as Cf)._caixaPropagacao || {}).status || ''));
    if (!jaAgendada) await salvarPropagacao(leadId, (x) => { x.status = 'AGENDADA'; x.em = new Date(Date.now() + 15 * 60_000).toISOString(); x.tentativas = 0; x.desde = new Date().toISOString(); });
    if (!jaAgendada) await note(leadId, '🏠 SIOPI: a avaliação da CAIXA saiu "Aprovada e NÃO Propagada" no Caixa Aqui. A propagação pode aparecer uns minutos depois: reconfiro no Caixa Aqui em 15 min. Continuando "não propagada", na contratação (depois da vistoria aprovada) vai a Nova Proposta Individual PF.');
    return;
  }
  await salvarP(leadId, (x) => { x.propagada = true; x.status = 'FILA'; x.passo = 'localizar'; x.pedidoEm = new Date().toISOString(); x.por = 'automático (CAIXA aprovou)'; x.tentativas = 0; delete x.inicio; });
  await note(leadId, '🏠 SIOPI: a avaliação da CAIXA saiu "Aprovada e Propagada" — a proposta já foi criada no SIOPI. A extensão vai conferir lá (Localiza Proposta pelo CPF) e traz o número pra cá; não cria nada.');
}

/** Etapa "Complementar Dados" da proposta escolhida (Fabio 18/11: seguradora "Caixa residencial", assinatura "15 dias após"; valores do card). `salvar` false = só
 *  preenche e devolve a tela. Valores em texto no formato do SIOPI ("292.998,84", "03/12/2026"). Erro em texto. */
export async function pedirComplementarSiopi(accountId: string, leadId: string, por: string, d: { primeiraAquisicao?: 'S' | 'N'; agendamento?: string; financiamento?: number; compraVenda?: number; salvar?: boolean; natoDigital?: 'S' | 'N'; situacoes?: string[]; agencia?: string; ufAgencia?: string }): Promise<string | null> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  if (!l) return 'Lead não encontrado';
  const cf = (l.customFields || {}) as Cf;
  const st = (cf._siopiProposta || {}) as Cf;
  if (!st.escolhida) return 'O card ainda não tem a proposta do SIOPI escolhida (rode a consulta da proposta antes)';
  const num = (v: unknown) => Number(String(v ?? '').replace(/[^\d.]/g, ''));
  const fin = d.financiamento || num(cf.valor_credito);
  const cv = d.compraVenda || num(cf.valor_imovel);
  if (!(fin > 0) || !(cv > 0)) return 'Falta o valor do financiamento ou do imóvel no card';
  const br = (n: number) => n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const ag = d.agendamento && /^\d{2}\/\d{2}\/\d{4}$/.test(d.agendamento) ? d.agendamento : new Date(Date.now() + 15 * 86400_000).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  // 1º encargo = 30 dias depois da assinatura (Fabio 18/11); unidade de cobrança = agência + dígito pela lupa (padrão: 3444 Planaltina de Goiás, SR 2639 Brasília Norte/DF);
  // UF/município do imóvel = os do laudo/imóvel (DF → Brasília); situações especiais 117, 132 e 791 (Fabio 18/11).
  const [dd0, mm0, aa0] = ag.split('/').map(Number);
  const venc = new Date(Date.UTC(aa0, mm0 - 1, dd0 + 30)).toLocaleDateString('pt-BR', { timeZone: 'UTC' });
  const { enderecoDoImovel } = require('./certidao-offer.service') as typeof import('./certidao-offer.service');
  const end = await enderecoDoImovel(leadId, cf).catch(() => null);
  const ufIm = String(end?.uf || cf.uf_imovel || '').toUpperCase().slice(0, 2) || 'DF';
  const munIm = ufIm === 'DF' ? 'BRASILIA' : String(end?.cidade || cf.cidade_imovel || '').trim();
  // Unidade de cobrança = a agência da CONTA CAIXA da cliente (Fabio 18/11: "unidade de cobrança é a mesma da conta da cliente") — campo agencia_conta_caixa do card.
  const agencia = String(d.agencia || cf.agencia_conta_caixa || '').replace(/\D/g, '').slice(0, 4);
  if (!agencia) return 'Falta a agência da conta CAIXA da cliente (unidade de cobrança) — informe a agência';
  if (d.agencia) await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{agencia_conta_caixa}', to_jsonb(${agencia}::text), true) WHERE id = ${leadId}`;
  const SR_CONHECIDA: Record<string, { uf: string; sr: string }> = { '3444': { uf: 'DF', sr: '2639' } }; // achadas na busca PV/SR do SIOPI
  const dados = { financiamento: br(fin), compraVenda: br(cv), agendamento: ag, vencimento: venc, seguradora: '14', apolice: 'LIMITE COBERTURA', tipoApolice: 'C', amortizacao: 'PRICE', garantia: '426',
    unidadeCobranca: { pv: agencia, uf: SR_CONHECIDA[agencia]?.uf || String(d.ufAgencia || ufIm), sr: SR_CONHECIDA[agencia]?.sr || '' }, ufImovel: ufIm, municipio: munIm,
    situacoes: Array.isArray(d.situacoes) && d.situacoes.length ? d.situacoes.map(String) : ['117', '132', '791'],
    ...(d.primeiraAquisicao ? { primeiraAquisicao: d.primeiraAquisicao } : {}) } as Record<string, any>;
  // "Proposta Nato Digital?" é obrigatório (SIOPI 18/11: "É obrigatório informar o campo 'Proposta Nato Digital?'"): com a situação 791 NATO DIGITAL = Sim.
  dados.natoDigital = d.natoDigital || (dados.situacoes.includes('791') ? 'S' : 'N');
  await salvarP(leadId, (x) => { x.status = 'FILA'; x.passo = 'complementar'; x.pedidoEm = new Date().toISOString(); x.por = por; x.tentativas = 0; x.complementar = { dados, salvar: d.salvar === true, pedidoEm: new Date().toISOString(), por }; delete x.inicio; });
  await note(leadId, `🏠 SIOPI — proposta ${st.escolhida}: Complementar Dados na fila (${por}, ${d.salvar ? 'preencher e SALVAR' : 'só preencher'}): financiamento R$ ${dados.financiamento}, compra e venda R$ ${dados.compraVenda}, assinatura ${dados.agendamento}, 1º encargo ${dados.vencimento}, unidade de cobrança ${agencia}, imóvel ${munIm}/${ufIm}, situações ${dados.situacoes.join(', ')}, seguradora CAIXA RESIDENCIAL HABITACIONAL (apólice SBPE limite de cobertura, coletiva), PRICE, garantia 426 Alienação Fiduciária${d.primeiraAquisicao ? `, 1ª aquisição no SFH: ${d.primeiraAquisicao === 'S' ? 'Sim' : 'Não'}` : ''}.`);
  return null;
}
