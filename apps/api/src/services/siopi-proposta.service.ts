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

/** Casamento na vigência da Lei 6515/77 (publicada em 27/12/1977) — a pergunta do SIOPI no regime de bens. Sem data = 'S'. Pura. */
export function lei6515(dataCasamento: unknown): 'S' | 'N' {
  const m = String(dataCasamento || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return 'S';
  return Number(`${m[3]}${m[2]}${m[1]}`) >= 19771227 ? 'S' : 'N';
}

/** Vendedores (`_caixaVendedores`) pra etapa Participantes: na ordem da ficha, com o cônjuge (o 2º do casal é vinculado ao 1º no SIOPI). Pura. */
export function pessoasDaProposta(cf: Cf, ordens?: number[]): { ordem: number; cpf: string; nome: string; conjugeCpf: string | null; conjugeNome: string | null; lei6515: 'S' | 'N' }[] {
  const { vendedoresDaFicha } = require('./caixa-vendedores.service') as typeof import('./caixa-vendedores.service');
  return vendedoresDaFicha(cf).filter((p: any) => String(p.cpf || '').replace(/\D/g, '').length === 11 && (!ordens?.length || ordens.includes(Number(p.ordem))))
    .sort((a: any, b: any) => Number(a.ordem) - Number(b.ordem))
    .map((p: any) => ({ ordem: Number(p.ordem), cpf: String(p.cpf).replace(/\D/g, ''), nome: String(p.nome || ''), conjugeCpf: String(p.conjuge?.cpf || '').replace(/\D/g, '') || null, conjugeNome: p.conjuge?.nome || null, lei6515: lei6515(p.dataCasamento) }));
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
    if (st.passo === 'valores') {
      if (!st.escolhida || !st.valores?.dados) { await salvarP(id, (x) => { x.status = 'ERRO'; x.erro = 'sem a proposta escolhida ou os valores'; x.fim = new Date().toISOString(); }); continue; }
      await salvarP(id, (x) => { x.status = 'RODANDO'; x.inicio = new Date().toISOString(); x.tentativas = (x.tentativas || 0) + 1; });
      return { tipo: 'proposta', passo: 'valores', leadId: id, leadName: l!.name, numero: st.escolhida, dados: st.valores.dados, salvar: st.valores.salvar === true };
    }
    if (st.passo === 'participantes') {
      const pessoas = pessoasDaProposta(cf, st.participantes?.ordens);
      if (!st.escolhida || !pessoas.length) { await salvarP(id, (x) => { x.status = 'ERRO'; x.erro = 'sem a proposta escolhida ou os vendedores com CPF'; x.fim = new Date().toISOString(); }); continue; }
      await salvarP(id, (x) => { x.status = 'RODANDO'; x.inicio = new Date().toISOString(); x.tentativas = (x.tentativas || 0) + 1; });
      return { tipo: 'proposta', passo: 'participantes', leadId: id, leadName: l!.name, numero: st.participantes?.numero || st.escolhida, pessoas, papel: 'Vendedor', salvar: st.participantes?.salvar === true, alterarEtapa: st.participantes?.alterarEtapa === true, obsEtapa: 'Inclusão dos vendedores do imóvel na proposta' };
    }
    if (st.passo === 'imovel') {
      const cod = String(st.imovel?.codigo || cf._vistoriaCaixa?.codigoImovel || '').replace(/\D/g, '');
      if (!st.escolhida || !cod) { await salvarP(id, (x) => { x.status = 'ERRO'; x.erro = 'sem a proposta escolhida ou o código do imóvel no SIOPI'; x.fim = new Date().toISOString(); }); continue; }
      await salvarP(id, (x) => { x.status = 'RODANDO'; x.inicio = new Date().toISOString(); x.tentativas = (x.tentativas || 0) + 1; });
      return { tipo: 'proposta', passo: 'imovel', leadId: id, leadName: l!.name, numero: st.escolhida, codigoImovel: cod, salvar: st.imovel?.salvar === true, ...(st.imovel?.cadastro ? { cadastro: st.imovel.cadastro } : {}) };
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
    x.status = ['TELA', 'JA_EXISTE', 'NAO_ACHOU', 'COMPLEMENTADO', 'PREENCHIDO', 'IMOVEL_VINCULADO', 'IMOVEL_ACHADO', 'IMOVEL_CADASTRADO', 'IMOVEL_CADASTRO_PREENCHIDO', 'VALORES_SALVOS', 'VALORES_PREENCHIDOS', 'PARTICIPANTES_INCLUIDOS', 'PARTICIPANTE_PREENCHIDO'].includes(etapa) ? etapa : 'ERRO';
    if (b.passo === 'participantes') {
      const bb = b as any;
      x.participantes = { ...(x.participantes || {}), resultado: etapa, feitos: bb.feitos || [], jaEstavam: bb.jaEstavam || [], lista: bb.lista || [], avisos: bb.avisos || [], precisaEtapa: !!bb.precisaEtapa, etapaAtual: bb.etapaAtual || null, at: new Date().toISOString(), ...(bb.etapaAlterada ? { etapaAlterada: bb.etapaAlterada } : {}) };
      // A proposta volta pra "Negociada" quando os Valores da Operação são salvos de novo (a inclusão foi em "Em Negociação").
      if (etapa === 'PARTICIPANTES_INCLUIDOS' && (x.participantes.depoisValores || x.participantes.etapaAlterada) && x.valores?.dados) { x.status = 'FILA'; x.passo = 'valores'; x.pedidoEm = new Date().toISOString(); x.tentativas = 0; x.valores = { ...x.valores, salvar: true }; delete x.inicio; }
    }
    if (b.passo === 'valores') x.valores = { ...(x.valores || {}), resultado: etapa, feito: (b as any).feito || null, calculo: (b as any).calculo || null, semAvaliacao: !!(b as any).semAvaliacao, avisos: (b as any).avisos || [], at: new Date().toISOString() };
    if (b.passo === 'imovel' && x.imovel?.cadastro) { x.imovel = { ...(x.imovel || {}), cadastroResultado: etapa, cadastroFeito: (b as any).feito || null, cadastroAvisos: (b as any).avisos || [], cadastroAt: new Date().toISOString() }; if (etapa === 'IMOVEL_CADASTRADO') { const depois = x.imovel.depoisValores && x.valores?.dados; delete x.imovel.cadastro; if (depois) { x.status = 'FILA'; x.passo = 'valores'; x.pedidoEm = new Date().toISOString(); x.tentativas = 0; x.valores = { ...x.valores, salvar: true }; delete x.inicio; } } }
    else if (b.passo === 'imovel') x.imovel = { ...(x.imovel || {}), resultado: etapa, dados: (b as any).imovel || null, avisos: (b as any).avisos || [], at: new Date().toISOString(), ...(etapa === 'IMOVEL_VINCULADO' ? { vinculadoEm: x.imovel?.vinculadoEm || new Date().toISOString() } : {}) };
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
        : etapa === 'VALORES_SALVOS' || etapa === 'VALORES_PREENCHIDOS' ? (() => {
          const f = ((b as any).feito || {}) as Record<string, string>; const c = ((b as any).calculo || {}) as Record<string, string>;
          const ROT: Record<string, string> = { valorAtribuido: 'valor atribuído (laudo)', prazo: 'prazo (meses)', compraVenda: 'compra e venda', financiamento: 'financiamento', cota: 'cota', valorOperacao: 'valor da operação', recursosProprios: 'recursos próprios', taxaEfetiva: 'taxa efetiva a.a.', taxaNominal: 'taxa nominal a.a.', encargo: 'encargo mensal', amortizacao: 'amortização', juros: 'juros', seguroDFI: 'seguro DFI', seguroMIP: 'seguro MIP', prestacao: 'PRESTAÇÃO', taxaAdm: 'taxa de administração', taxasFinanciadas: 'taxas financiadas', taxasAVista: 'taxas à vista' };
          return `Valores da Operação ${etapa === 'VALORES_SALVOS' ? 'SALVOS' : 'preenchidos (sem salvar)'}:\n${Object.entries(f).map(([k, v]) => `• ${k}: ${v}`).join('\n')}${Object.keys(c).length ? `\n\nCalculado pelo SIOPI:\n${Object.entries(c).map(([k, v]) => `• ${ROT[k] || k}: ${v}`).join('\n')}` : ''}${(b as any).semAvaliacao ? '\n⚠️ O SIOPI ainda mostra "Imóvel sem avaliação".' : ''}${((b as any).avisos || []).length ? `\nAvisos do SIOPI: ${((b as any).avisos as string[]).join(' | ')}` : ''}`;
        })()
        : etapa === 'PARTICIPANTES_INCLUIDOS' || etapa === 'PARTICIPANTE_PREENCHIDO' ? (() => {
          const bb = b as any; const fs = (bb.feitos || []) as any[];
          const linhas = fs.map((f) => `• ${f.nome || f.cpf} (${f.cpf}) — ${f.papel || '?'}${f.conjuge ? `, cônjuge de ${f.conjuge}${f.lei6515 ? ` (Lei 6515: ${f.lei6515})` : ''}` : ''}${f.estadoCivil ? ` · ${f.estadoCivil}` : ''}${(f.vazios || []).length ? ` · ⚠️ obrigatórios vazios: ${f.vazios.join(', ')}` : ''}${f.contaCredito ? ` · conta do crédito: ${f.contaCredito}` : ''}${!f.salvo && (f.opcoesPapel || []).length ? `\n  papéis do SIOPI: ${f.opcoesPapel.join(' | ')}` : ''}`);
          const lista = ((bb.lista || []) as any[]).map((p) => `• ${p.nome || p.cpf} — ${p.papel}`);
          return `${etapa === 'PARTICIPANTES_INCLUIDOS' ? 'participantes INCLUÍDOS e conferidos na lista da proposta' : 'participante preenchido (sem salvar)'}:\n${linhas.join('\n') || '• (já estavam na proposta)'}${(bb.jaEstavam || []).length ? `\nJá estavam: ${bb.jaEstavam.join(', ')}` : ''}${bb.etapaAlterada ? `\nEtapa da proposta: ${bb.etapaAlterada.antes} → ${bb.etapaAlterada.depois} (o SIOPI só inclui participante em "Em Negociação"); os Valores da Operação vão ser salvos de novo.` : ''}${lista.length ? `\n\nParticipantes da proposta agora:\n${lista.join('\n')}` : ''}${(bb.avisos || []).length ? `\nAvisos do SIOPI: ${(bb.avisos as string[]).join(' | ')}` : ''}`;
        })()
        : etapa === 'IMOVEL_CADASTRADO' || etapa === 'IMOVEL_CADASTRO_PREENCHIDO' ? `cadastro do imóvel ${etapa === 'IMOVEL_CADASTRADO' ? 'SALVO no SIOPI e importado na proposta' : 'preenchido (sem salvar)'}: ${Object.entries(((b as any).feito || {}) as Record<string, unknown>).map(([k, v]) => `${k} ${v}`).join(', ')}.${((b as any).avisos || []).length ? `\nAvisos do SIOPI: ${((b as any).avisos as string[]).join(' | ')}` : ''}`
        : etapa === 'IMOVEL_VINCULADO' || etapa === 'IMOVEL_ACHADO' ? (() => { const im = ((b as any).imovel || {}) as Record<string, any>; return `imóvel ${im.codigo || ''} ${etapa === 'IMOVEL_ACHADO' ? 'achado (NÃO vinculado — só conferência)' : im.jaVinculado ? `já estava vinculado à proposta${im.igual === false ? ' — ⚠️ É OUTRO imóvel, não o da vistoria' : ''}` : 'VINCULADO à proposta e conferido'}: matrícula ${im.matricula || '?'}, ${im.cartorio || ''}; ${[im.logradouro, im.numero].filter(Boolean).join(' ')}${im.bairro ? `, ${im.bairro}` : ''}${im.municipio ? ` — ${im.municipio}` : ''}${im.compraVenda ? `; compra e venda R$ ${im.compraVenda}` : ''}.${((b as any).avisos || []).length ? `\nAvisos do SIOPI: ${((b as any).avisos as string[]).join(' | ')}` : ''}${etapa === 'IMOVEL_VINCULADO' ? '\nPróximo: Valores da Operação (selecionar a avaliação/laudo do imóvel).' : ''}`; })()
        : etapa === 'COMPLEMENTADO' || etapa === 'PREENCHIDO' ? `Complementar Dados da ${(b as any).numero || 'proposta'} ${etapa === 'COMPLEMENTADO' ? 'SALVO' : 'preenchido (sem salvar)'}:\n${Object.entries(((b as any).feito || {}) as Record<string, string>).map(([k, v]) => `• ${k}: ${v}`).join('\n')}${((b as any).avisos || []).length ? `\nAvisos do SIOPI: ${((b as any).avisos as string[]).join(' | ')}` : ''}`
          : `PAROU — ${b.erro || 'erro'}${(b as any).feito ? `\n(preenchido até: ${Object.keys((b as any).feito).join(', ')})` : ''}${((b as any).avisos || []).length ? `\nAvisos do SIOPI: ${((b as any).avisos as string[]).join(' | ')}` : ''}`;
  await note(leadId, `🏠 SIOPI — proposta (${b.passo || 'abrir'}): ${resumo}${tela?.texto ? `\n\n${tela.texto.slice(0, 2500)}` : ''}${campos.length ? `\n\nCampos:\n${campos.join('\n')}` : ''}${botoes.length ? `\n\nBotões: ${botoes.join(' · ')}` : ''}`);
  try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title: `🏠 ${l.name}: proposta no SIOPI`, body: (etapa === 'PARTICIPANTES_INCLUIDOS' ? `vendedores incluídos na proposta: ${(((b as any).feitos || []) as any[]).map((f) => f.nome).join(', ') || 'já estavam'}` : (b as any).precisaEtapa ? `participantes: a proposta está "${(b as any).etapaAtual || 'Negociada'}" — precisa voltar pra Em Negociação` : etapa === 'VALORES_SALVOS' ? `Valores da Operação salvos${((b as any).calculo || {}).prestacao ? ` — prestação ${(b as any).calculo.prestacao}` : ''}` : etapa === 'IMOVEL_VINCULADO' ? `imóvel ${((b as any).imovel || {}).codigo || ''} vinculado à proposta` : etapa === 'IMOVEL_ACHADO' ? `imóvel ${((b as any).imovel || {}).codigo || ''} achado (não vinculado)` : etapa === 'TELA' ? `abriu "${tela?.titulo || 'tela seguinte'}"` : etapa === 'JA_EXISTE' ? `já existe: ${(b.propostas || []).map((p) => p?.numero).join(', ')}` : `parou: ${b.erro || 'erro'}`).slice(0, 160), leadId }).catch(() => {}); } catch { /* só aviso */ }
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
  // Assinatura: o Fabio pediu 15 dias, mas o SIOPI só aceita até 10 ("DATA DE AGENDAMENTO DA ASSINATURA SUPERA LIMITE DE 10 DIAS", 18/11) → o último dia útil em até 10 dias.
  const limite10 = (): string => { const x = new Date(Date.now() + 10 * 86400_000); const dow = () => new Date(x.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })).getDay(); while ([0, 6].includes(dow())) x.setTime(x.getTime() - 86400_000); return x.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }); };
  const ag = d.agendamento && /^\d{2}\/\d{2}\/\d{4}$/.test(d.agendamento) ? d.agendamento : limite10();
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
  const dados = { financiamento: br(fin), compraVenda: br(cv), agendamento: ag, vencimento: venc, seguradora: '14', apolice: 'LIMITE COBERTURA', tipoApolice: 'C', amortizacao: 'PRICE', garantia: '432', // 426 Alienação Fiduciária deu "TIPO DE GARANTIA INVÁLIDO PARA A PROPOSTA" no SBPE usado (18/11); a extensão troca se precisar
   
    unidadeCobranca: { pv: agencia, uf: SR_CONHECIDA[agencia]?.uf || String(d.ufAgencia || ufIm), sr: SR_CONHECIDA[agencia]?.sr || '' }, ufImovel: ufIm, municipio: munIm,
    situacoes: Array.isArray(d.situacoes) && d.situacoes.length ? d.situacoes.map(String) : ['117', '132', '791'],
    ...(d.primeiraAquisicao ? { primeiraAquisicao: d.primeiraAquisicao } : {}) } as Record<string, any>;
  // "Proposta Nato Digital?" é obrigatório (SIOPI 18/11: "É obrigatório informar o campo 'Proposta Nato Digital?'"): com a situação 791 NATO DIGITAL = Sim.
  dados.natoDigital = d.natoDigital || (dados.situacoes.includes('791') ? 'S' : 'N');
  await salvarP(leadId, (x) => { x.status = 'FILA'; x.passo = 'complementar'; x.pedidoEm = new Date().toISOString(); x.por = por; x.tentativas = 0; x.complementar = { dados, salvar: d.salvar === true, pedidoEm: new Date().toISOString(), por }; delete x.inicio; });
  await note(leadId, `🏠 SIOPI — proposta ${st.escolhida}: Complementar Dados na fila (${por}, ${d.salvar ? 'preencher e SALVAR' : 'só preencher'}): financiamento R$ ${dados.financiamento}, compra e venda R$ ${dados.compraVenda}, assinatura ${dados.agendamento}, 1º encargo ${dados.vencimento}, unidade de cobrança ${agencia}, imóvel ${munIm}/${ufIm}, situações ${dados.situacoes.join(', ')}, seguradora CAIXA RESIDENCIAL HABITACIONAL (apólice SBPE limite de cobertura, coletiva), PRICE, garantia ${dados.garantia === '432' ? '432 Imóveis residenciais urbanos NR' : '426 Alienação Fiduciária'}${d.primeiraAquisicao ? `, 1ª aquisição no SFH: ${d.primeiraAquisicao === 'S' ? 'Sim' : 'Não'}` : ''}.`);
  return null;
}

/** Etapa "Imóvel" da proposta escolhida (Fabio 23/11: "AGORA CONTINUA A CONTRATAÇÃO NO SIOPI"): a extensão vincula o imóvel da vistoria (código do SIOPI em
 *  `_vistoriaCaixa.codigoImovel`) e confere reabrindo a proposta. `salvar` false = só acha o imóvel. Os Valores da Operação dependem disso. Erro em texto. */
export async function pedirImovelSiopi(accountId: string, leadId: string, por: string, d: { salvar?: boolean; codigo?: string; cadastro?: { inscricao?: string; elevador?: 'S' | 'N'; andar?: number }; depoisValores?: boolean } = {}): Promise<string | null> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  if (!l) return 'Lead não encontrado';
  const cf = (l.customFields || {}) as Cf;
  const st = (cf._siopiProposta || {}) as Cf;
  if (!st.escolhida) return 'O card ainda não tem a proposta do SIOPI escolhida (rode a consulta da proposta antes)';
  if (st.status === 'RODANDO' && st.inicio && Date.now() - Date.parse(st.inicio) < LEASE_MS) return 'A extensão já está com a proposta deste card';
  const cod = String(d.codigo || cf._vistoriaCaixa?.codigoImovel || '').replace(/\D/g, '');
  if (!cod) return 'O card não tem o código do imóvel no SIOPI (a vistoria da CAIXA não foi pedida pelo CRM) — informe o código';
  if (cf._laudoCaixa?.status && cf._laudoCaixa.status !== 'SALVO') return `O laudo da vistoria ainda não está aceito (${cf._laudoCaixa.status}) — sem laudo válido o imóvel não segue`;
  // Cadastro do imóvel (SIOPI 23/11 nos Valores: "O CAMPO DA INSCRICAO MUNICIPAL NA TELA DO IMÓVEL DEVE SER PREENCHIDO"): inscrição do IPTU (pedido → card → leitura da
  // vistoria), elevador e andar (do laudo). Só com o imóvel já vinculado; `depoisValores` = salvo o cadastro, os Valores da Operação voltam pra fila.
  if (d.cadastro) {
    if (st.imovel?.resultado !== 'IMOVEL_VINCULADO') return 'O imóvel ainda não está vinculado à proposta';
    const insc = String(d.cadastro.inscricao || cf.inscricao_imovel || cf._vistoriaCaixa?.imovel?.inscricaoMunicipal || '').replace(/\D/g, '');
    if (!insc) return 'Falta a inscrição do IPTU do imóvel (informe a inscrição)';
    const cad = { inscricao: insc, ...(d.cadastro.elevador ? { elevador: d.cadastro.elevador } : {}), ...(d.cadastro.andar !== undefined ? { andar: d.cadastro.andar } : {}) };
    await salvarP(leadId, (x) => { x.status = 'FILA'; x.passo = 'imovel'; x.pedidoEm = new Date().toISOString(); x.por = por; x.tentativas = 0; x.imovel = { ...(x.imovel || {}), codigo: cod, salvar: d.salvar === true, cadastro: cad, depoisValores: d.depoisValores === true, pedidoEm: new Date().toISOString(), por }; delete x.inicio; });
    await note(leadId, `🏠 SIOPI — proposta ${st.escolhida}: cadastro do imóvel ${cod} na fila (${por}, ${d.salvar ? 'SALVAR e importar na proposta' : 'só preencher'}): inscrição IPTU ${insc}${cad.elevador ? `, elevador ${cad.elevador === 'S' ? 'Sim' : 'Não'}` : ''}${cad.andar !== undefined ? `, ${cad.andar}º andar` : ''}${d.depoisValores ? '. Depois, os Valores da Operação de novo.' : '.'}`);
    return null;
  }
  await salvarP(leadId, (x) => { x.status = 'FILA'; x.passo = 'imovel'; x.pedidoEm = new Date().toISOString(); x.por = por; x.tentativas = 0; x.imovel = { ...(x.imovel || {}), codigo: cod, salvar: d.salvar === true, pedidoEm: new Date().toISOString(), por }; delete x.imovel.cadastro; delete x.inicio; });
  await note(leadId, `🏠 SIOPI — proposta ${st.escolhida}: etapa Imóvel na fila (${por}, ${d.salvar ? 'VINCULAR o imóvel e conferir' : 'só achar o imóvel'}): imóvel ${cod} da vistoria.`);
  return null;
}

/** Etapa "Valores da Operação" (Fabio 23/11: "AGORA CONTINUA A CONTRATAÇÃO NO SIOPI"): avaliação = laudo da vistoria (`valor_de_avaliacao`), prazo (padrão 360 = o máximo
 *  da avaliação de risco — "sempre no prazo máximo"), compra e venda e financiamento do card, sem FGTS. Precisa do imóvel vinculado. `salvar` false = só preenche. */
export async function pedirValoresSiopi(accountId: string, leadId: string, por: string, d: { salvar?: boolean; prazo?: number; financiamento?: number; compraVenda?: number; fgts?: 'S' | 'N' } = {}): Promise<string | null> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  if (!l) return 'Lead não encontrado';
  const cf = (l.customFields || {}) as Cf;
  const st = (cf._siopiProposta || {}) as Cf;
  if (!st.escolhida) return 'O card ainda não tem a proposta do SIOPI escolhida';
  if (st.status === 'RODANDO' && st.inicio && Date.now() - Date.parse(st.inicio) < LEASE_MS) return 'A extensão já está com a proposta deste card';
  if (st.imovel?.resultado !== 'IMOVEL_VINCULADO') return 'O imóvel ainda não está vinculado à proposta (etapa Imóvel antes)';
  const num = (v: unknown) => Number(String(v ?? '').replace(/[^\d.]/g, ''));
  const fin = d.financiamento || num(cf.valor_credito);
  const cv = d.compraVenda || num(cf.valor_imovel);
  const laudo = num(cf.valor_de_avaliacao);
  if (!(fin > 0) || !(cv > 0)) return 'Falta o valor do financiamento ou do imóvel no card';
  if (!(laudo > 0)) return 'Falta o valor do laudo (Valor de avaliação) no card';
  const br = (n: number) => n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const prazo = Math.round(d.prazo || 360);
  const dados = { prazo: String(prazo), compraVenda: br(cv), financiamento: br(fin), valorLaudo: laudo, fgts: d.fgts === 'S' ? 'S' : 'N' };
  await salvarP(leadId, (x) => { x.status = 'FILA'; x.passo = 'valores'; x.pedidoEm = new Date().toISOString(); x.por = por; x.tentativas = 0; x.valores = { dados, salvar: d.salvar === true, pedidoEm: new Date().toISOString(), por }; delete x.inicio; });
  await note(leadId, `🏠 SIOPI — proposta ${st.escolhida}: Valores da Operação na fila (${por}, ${d.salvar ? 'preencher e SALVAR' : 'só preencher'}): avaliação = laudo R$ ${br(laudo)}, prazo ${prazo} meses, compra e venda R$ ${dados.compraVenda}, financiamento R$ ${dados.financiamento}, FGTS ${dados.fgts === 'S' ? 'Sim' : 'Não'}.`);
  return null;
}

/** Etapa "Participantes" (Fabio 23/11, "Pode incluir"): os vendedores do imóvel entram na proposta (papel Vendedor; o 2º do casal vinculado como cônjuge do 1º).
 *  Precisam estar GRAVADOS no Caixa Aqui (é o que os faz aparecer no SIOPI — Fabio 18/11). Proposta "Negociada" não aceita participante novo: `alterarEtapa` volta pra
 *  "Em Negociação" (Alterar Etapa); depois de incluir, os Valores da Operação são salvos de novo. `salvar` false = só preenche o 1º. `numero` = outra proposta do
 *  cliente, só pra conferir a tela (sem salvar). Erro em texto. */
export async function pedirParticipantesSiopi(accountId: string, leadId: string, por: string, d: { salvar?: boolean; ordens?: number[]; numero?: string; alterarEtapa?: boolean } = {}): Promise<string | null> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  if (!l) return 'Lead não encontrado';
  const cf = (l.customFields || {}) as Cf;
  const st = (cf._siopiProposta || {}) as Cf;
  if (!st.escolhida) return 'O card ainda não tem a proposta do SIOPI escolhida';
  if (st.status === 'RODANDO' && st.inicio && Date.now() - Date.parse(st.inicio) < LEASE_MS) return 'A extensão já está com a proposta deste card';
  const pessoas = pessoasDaProposta(cf, d.ordens);
  if (!pessoas.length) return 'O card não tem os vendedores com CPF (monte a ficha dos vendedores pela pasta VENDEDOR)';
  const cad = (cf._caixaVendedores?.cadastros || {}) as Record<string, any>;
  const semCadastro = pessoas.filter((p) => cad[p.ordem]?.status !== 'GRAVADO');
  if (semCadastro.length) return `Cadastre no Caixa Aqui antes (sem cadastro o SIOPI não acha): ${semCadastro.map((p) => p.nome).join(', ')}`;
  let numero: string | undefined;
  if (d.numero) {
    if (d.salvar) return 'Outra proposta só pra conferir a tela (sem salvar)';
    if (!((st.propostas || []) as any[]).some((p) => p?.numero === d.numero)) return `A proposta ${d.numero} não está entre as do cliente`;
    numero = d.numero;
  }
  const depoisValores = !numero && d.salvar === true && st.valores?.resultado === 'VALORES_SALVOS' && !!st.valores?.dados;
  await salvarP(leadId, (x) => { x.status = 'FILA'; x.passo = 'participantes'; x.pedidoEm = new Date().toISOString(); x.por = por; x.tentativas = 0; x.participantes = { ...(d.ordens?.length ? { ordens: d.ordens } : {}), ...(numero ? { numero } : {}), salvar: d.salvar === true, alterarEtapa: d.alterarEtapa === true, depoisValores, pedidoEm: new Date().toISOString(), por }; delete x.inicio; });
  const mc = (c: string) => `${c.slice(0, 3)}.***.***-${c.slice(9)}`;
  await note(leadId, `🏠 SIOPI — proposta ${numero || st.escolhida}: Participantes na fila (${por}, ${d.salvar ? 'INCLUIR e conferir' : 'só preencher o 1º, sem salvar'}): ${pessoas.map((p, i) => `${p.nome} (${mc(p.cpf)}) como Vendedor${i > 0 && p.conjugeCpf && pessoas.some((q) => q.cpf === p.conjugeCpf) ? `, cônjuge de ${p.conjugeNome}` : ''}`).join('; ')}.${d.alterarEtapa ? ' Se a proposta estiver "Negociada", volta pra "Em Negociação" antes (Alterar Etapa).' : ''}${depoisValores ? ' Depois, os Valores da Operação de novo.' : ''}`);
  return null;
}
