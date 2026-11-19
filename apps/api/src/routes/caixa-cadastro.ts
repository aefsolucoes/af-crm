import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { prisma } from '../lib/prisma';
import { requirePermission } from '../middleware/permission';
import { pedirCadastroCaixa, proximaConsulta, gravarConsulta, consultaSemResultado, informarEstadoCivil, informarDadosRenda, prontosParaCadastro, conferirCadastro, pedirCadastroParticipantes, gravarCadastro, salvarFormularioCaixa, pedirAvaliacao, gravarAvaliacao, marcarConferido, fazerCadastroManual, painelCaixa, semCadastroCaixa, AVALIACAO_APOS_CONFERENCIA, estadoCaixaDoCard, cadastroCaixaPeloCard, analiseCaixaPeloCard } from '../services/caixa-cadastro.service';
import { pedirConsultaResultado, proximaConsultaResultado, gravarConsultaResultado, pedirAvisoPv } from '../services/caixa-resultado.service';
import { verificarOcorrencias } from '../services/caixa-ocorrencias.service';
import { pedirDesbloqueio, proximoDesbloqueio, gravarDesbloqueio, perguntarAoCliente, entregarCodigo } from '../services/caixa-desbloqueio.service';
import { pedirProdutosCaixa, proximoProdutosCaixa, gravarProdutosCaixa, produtosDaAvaliacao } from '../services/caixa-produtos.service';

// Fila do cadastro na CAIXA (Fabio 29/10: "quero que o CRM indique qual cliente rodar") — usada pela extensão "Cadastro CAIXA (Caixa Aqui)".
const router = Router();
router.use(authMiddleware);

router.get('/fila', async (req: AuthRequest, res: Response) => {
  // Sem consulta/cadastro/avaliação pendente → consulta do resultado de avaliação já enviada (Formulários Enviados).
  // Desbloqueio do cadastro (cliente em outro convênio, Fabio 18/11) vem primeiro: é pedido pela equipe e espera o cliente.
  // Por último: conta + cartão do proponente na contratação (Fabio 19/11) — só consulta nesta fase.
  try { res.json((await proximoDesbloqueio(req.user!.accountId)) || (await proximaConsulta(req.user!.accountId)) || (await proximaConsultaResultado(req.user!.accountId)) || (await proximoProdutosCaixa(req.user!.accountId))); } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro na fila da CAIXA' }); }
});

// Resultado da Avaliação de Risco (Fabio 01/11: "PARA CONSULTAR O RESULTADO, PRECISA VOLTAR NO MENU E IR EM FORMULÁRIOS ENVIADOS").
router.post('/:leadId/consultar-resultado', async (req: AuthRequest, res: Response) => {
  const quem = (await prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true } }))?.name || 'equipe';
  // foraDoCrm: avaliação rodada direto no Caixa Aqui (Fabio 12/11) — consulta e só registra.
  const erro = await pedirConsultaResultado(req.user!.accountId, req.params.leadId, quem, { foraDoCrm: req.body?.foraDoCrm === true }).catch((e) => e?.message || 'erro');
  if (erro) return res.status(400).json({ error: erro });
  res.json({ ok: true });
});
router.post('/:leadId/resultado', async (req: AuthRequest, res: Response) => {
  const { status, texto } = req.body as { status?: string; texto?: string };
  if (!status) return res.status(400).json({ error: 'status obrigatório' });
  try { await gravarConsultaResultado(req.user!.accountId, req.params.leadId, { status: String(status), texto: String(texto || '') }); res.json({ ok: true }); } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro' }); }
});
// Aviso do PV ao cliente pelo fluxo automático (conversa fechada → template; o texto sai quando ele responder).
router.post('/:leadId/avisar-pv', async (req: AuthRequest, res: Response) => {
  const erro = await pedirAvisoPv(req.user!.accountId, req.params.leadId, req.app.get('io')).catch((e) => e?.message || 'erro');
  if (erro) return res.status(400).json({ error: erro });
  const pv = ((await prisma.lead.findUnique({ where: { id: req.params.leadId }, select: { customFields: true } }))?.customFields as any)?._caixaResultado?.pvAviso;
  res.json({ ok: true, pvAviso: pv?.status || null });
});

// Painel CAIXA da Análise de Crédito (Fabio 31/10): rodando, conferir cadastro, avaliação e quem tem ficha sem cadastro.
router.get('/painel', async (req: AuthRequest, res: Response) => {
  try { const [cards, semCadastro] = await Promise.all([painelCaixa(req.user!.accountId), semCadastroCaixa(req.user!.accountId)]); res.json({ cards, semCadastro, avaliacaoAposConferencia: AVALIACAO_APOS_CONFERENCIA }); } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro' }); }
});
const nomeDe = async (req: AuthRequest) => (await prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true } }))?.name || 'equipe';
router.post('/:leadId/conferido', async (req: AuthRequest, res: Response) => {
  const erro = await marcarConferido(req.user!.accountId, req.params.leadId, await nomeDe(req)).catch((e) => e?.message || 'erro');
  if (erro) return res.status(400).json({ error: erro });
  res.json({ ok: true });
});
router.post('/:leadId/fazer-cadastro', async (req: AuthRequest, res: Response) => {
  const erro = await fazerCadastroManual(req.user!.accountId, req.params.leadId, await nomeDe(req)).catch((e) => e?.message || 'erro');
  if (erro) return res.status(400).json({ error: erro });
  res.json({ ok: true });
});

// Botões "Cadastro CAIXA" e "Análise CAIXA" no topo do card (Fabio 03/11: "NÃO ACHEI O BOTÃO PARA RODAR CADASTRO NA CAIXA…") — mesma fila da extensão; quem clica fica na anotação.
router.get('/:leadId/card', async (req: AuthRequest, res: Response) => {
  try {
    const estado = await estadoCaixaDoCard(req.user!.accountId, req.params.leadId);
    if (!estado) return res.status(404).json({ error: 'Lead não encontrado' });
    res.json(estado);
  } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro' }); }
});
router.post('/:leadId/card/cadastro', requirePermission('funnel_manage'), async (req: AuthRequest, res: Response) => {
  try {
    const r = await cadastroCaixaPeloCard(req.user!.accountId, req.params.leadId, { id: req.user!.id, nome: await nomeDe(req) }, req.app.get('io'), { analise: req.body?.analise === true, enviar: req.body?.enviar !== false });
    if ('erro' in r) return res.status(400).json({ error: r.erro });
    // `concluir` (Fabio 18/11): passa as páginas como estão, só a agência 3444 e "Concluir Cadastro".
    if (req.body?.concluir === true) { const { marcarSoConcluir } = require('../services/caixa-cadastro.service') as typeof import('../services/caixa-cadastro.service'); const n = await marcarSoConcluir(req.params.leadId); return res.json({ ok: true, mensagem: `${r.mensagem} Modo concluir sem mexer (${n} cadastro(s)): mantém o que está na CAIXA, agência 3444 e Concluir Cadastro.` }); }
    res.json({ ok: true, mensagem: r.mensagem });
  } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro ao pedir o cadastro na CAIXA' }); }
});
// Botão "Consultar na CAIXA" (Fabio 11/11: "Sempre que um cliente quiser seguir pela CAIXA, ele informar ou a gente, o CRM deve fazer uma consulta para buscar ocorrências"):
// consulta do nome em Oportunidades de Negócios antes de qualquer documento. Sem restrição → o cliente fica sabendo e o CRM pergunta do Habite-se; com restrição → Serasa/SCPC/protesto.
// Botão "Consultar aprovação na CAIXA" (Fabio 14/11): avaliação ENVIADA pelo CRM → consulta normal (o resultado segue o fluxo de sempre); sem isso → rodada direto no
// Caixa Aqui (foraDoCrm): a extensão consulta Formulários Enviados pelo CPF e SÓ registra (nota + card + push), sem avisar o cliente.
router.post('/:leadId/card/consultar-aprovacao', requirePermission('funnel_manage'), async (req: AuthRequest, res: Response) => {
  try {
    const l = await prisma.lead.findFirst({ where: { id: req.params.leadId, accountId: req.user!.accountId }, select: { customFields: true } });
    if (!l) return res.status(404).json({ error: 'Card não encontrado' });
    const enviadaPeloCrm = /^ENVIADA/i.test(String(((l.customFields || {}) as any)._caixaCadastro?.avaliacao?.status || ''));
    const erro = await pedirConsultaResultado(req.user!.accountId, req.params.leadId, `botão "Consultar aprovação na CAIXA" (${await nomeDe(req)})`, { foraDoCrm: !enviadaPeloCrm }).catch((e) => e?.message || 'erro');
    if (erro) return res.status(400).json({ error: erro });
    res.json({ ok: true, mensagem: `Consulta da aprovação na CAIXA na fila: a extensão abre o Caixa Aqui (Formulários Enviados) e procura o cliente pelo CPF.${enviadaPeloCrm ? '' : ' O resultado só é registrado no card (nada vai ao cliente).'}` });
  } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro ao pedir a consulta' }); }
});
router.post('/:leadId/card/consulta', requirePermission('funnel_manage'), async (req: AuthRequest, res: Response) => {
  try {
    const { pedirConsultaCaixa } = require('../services/caixa-screening.service') as typeof import('../services/caixa-screening.service');
    const r = await pedirConsultaCaixa(req.user!.accountId, req.params.leadId, { origem: 'botao', por: `botão "Consultar na CAIXA" (${await nomeDe(req)})`, io: req.app.get('io') });
    if (!r.ok) return res.status(400).json({ error: r.erro || 'Não consegui pedir a consulta' });
    res.json({ ok: true, mensagem: r.ja ? 'O card já tinha consulta da CAIXA: usei o resultado que existe' : 'Consulta do nome na CAIXA na fila da extensão' });
  } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro ao pedir a consulta na CAIXA' }); }
});
// Documentação da CAIXA já pedida à mão (Fabio 14/11, Phillipi: "já rodei, fiz a solicitação da documentação e o cliente não encaminhou … ele vai para Análise CAIXA"):
// põe o card na rota da CAIXA — etapa Análise CAIXA, conferência dos documentos e os 3 lembretes diários (caixa-docs-loop). Exige a consulta do nome já feita e sem restrição.
router.post('/:leadId/card/rota', requirePermission('funnel_manage'), async (req: AuthRequest, res: Response) => {
  try {
    const lead = await prisma.lead.findFirst({ where: { id: req.params.leadId, accountId: req.user!.accountId }, select: { customFields: true } });
    if (!lead) return res.status(404).json({ error: 'Card não encontrado' });
    const cf = (lead.customFields || {}) as Record<string, any>;
    if (!cf._caixaCadastro?.consultadoEm) return res.status(400).json({ error: 'Faça antes a consulta do nome na CAIXA ("Consultar na CAIXA")' });
    if (cf._ocorrencias?.consultadoEm && cf._ocorrencias.consultadoEm === cf._caixaCadastro.consultadoEm) return res.status(400).json({ error: 'A consulta da CAIXA mostrou restrição no nome' });
    const { entrarRotaCaixa } = require('../services/caixa-screening.service') as typeof import('../services/caixa-screening.service');
    const ok = await entrarRotaCaixa(req.user!.accountId, req.params.leadId, `documentação da CAIXA pedida pela equipe (${await nomeDe(req)})`, req.app.get('io'), { liberado: true });
    res.json({ ok: true, mensagem: ok ? 'Card na rota da CAIXA (Análise CAIXA)' : 'O card já estava na rota da CAIXA' });
  } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro ao pôr na rota da CAIXA' }); }
});
// O clique é a autorização da Avaliação de Risco pra este cliente (Fabio 31/10: só com o OK dele) — registrada no card (avaliacao.autorizacao + anotação).
// `denovo` (Fabio 03/11, Jézer/Fernanda depois da autorização do PV): roda a Avaliação de Risco de novo — a anterior vai pro histórico e o resultado é consultado de novo.
router.post('/:leadId/card/analise', requirePermission('funnel_manage'), async (req: AuthRequest, res: Response) => {
  try {
    const r = await analiseCaixaPeloCard(req.user!.accountId, req.params.leadId, { id: req.user!.id, nome: await nomeDe(req) }, { enviar: req.body?.enviar === true, conferido: req.body?.conferido === true, denovo: req.body?.denovo === true, price: req.body?.price === true });
    if ('erro' in r) return res.status(400).json({ error: r.erro });
    res.json({ ok: true, mensagem: r.mensagem });
  } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro ao pedir a análise na CAIXA' }); }
});

router.get('/prontos', async (req: AuthRequest, res: Response) => {
  try { res.json(await prontosParaCadastro(req.user!.accountId)); } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro' }); }
});

router.post('/:leadId/consulta', async (req: AuthRequest, res: Response) => {
  const { ordem, texto } = req.body as { ordem?: number; texto?: string };
  if (!ordem || !texto) return res.status(400).json({ error: 'ordem e texto obrigatórios' });
  try {
    await gravarConsulta(req.user!.accountId, req.params.leadId, Number(ordem), String(texto));
    // "Constam Ocorrências" → orientação Serasa/SCPC/protesto ao cliente (Fabio 01/11).
    await verificarOcorrencias(req.user!.accountId, req.params.leadId, (req as any).app.get('io')).catch((e) => console.error('[Ocorrências]', e?.message));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro' }); }
});

// Estado civil informado pela equipe quando a ficha não traz (Fabio 09/11).
router.post('/:leadId/estado-civil', requirePermission('funnel_manage'), async (req: AuthRequest, res: Response) => {
  const { ordem, estadoCivil } = req.body as { ordem?: number; estadoCivil?: string };
  if (!ordem || !estadoCivil) return res.status(400).json({ error: 'ordem e estadoCivil obrigatórios' });
  const erro = await informarEstadoCivil(req.user!.accountId, req.params.leadId, Number(ordem), String(estadoCivil).trim(), await nomeDe(req)).catch((e) => e?.message || 'erro');
  if (erro) return res.status(400).json({ error: erro });
  res.json({ ok: true });
});

// Órgão emissor / UF do RG informados pela equipe (Fabio 16/11, Danniele: "SSP/DF"): valem no lugar da ficha, mesmo quando ela é refeita.
router.post('/:leadId/identidade', requirePermission('funnel_manage'), async (req: AuthRequest, res: Response) => {
  const { ordem, orgao, uf } = req.body as { ordem?: number; orgao?: string; uf?: string };
  if (!ordem) return res.status(400).json({ error: 'ordem obrigatória' });
  const { informarIdentidade } = require('../services/caixa-cadastro.service') as typeof import('../services/caixa-cadastro.service');
  const erro = await informarIdentidade(req.user!.accountId, req.params.leadId, Number(ordem), { orgao, uf }, await nomeDe(req)).catch((e) => e?.message || 'erro');
  if (erro) return res.status(400).json({ error: erro });
  res.json({ ok: true });
});

// CNPJ e/ou data de admissão do emprego informados pela equipe (Fabio 10/11): valem no lugar da ficha, mesmo quando ela é refeita.
router.post('/:leadId/dados-renda', requirePermission('funnel_manage'), async (req: AuthRequest, res: Response) => {
  const { ordem, cnpj, admissao, comprovante, limparCnpj } = req.body as { ordem?: number; cnpj?: string; admissao?: string; comprovante?: string; limparCnpj?: boolean };
  if (!ordem) return res.status(400).json({ error: 'ordem obrigatória' });
  const erro = await informarDadosRenda(req.user!.accountId, req.params.leadId, Number(ordem), { cnpj, admissao, comprovante, limparCnpj: limparCnpj === true }, await nomeDe(req)).catch((e) => e?.message || 'erro');
  if (erro) return res.status(400).json({ error: erro });
  res.json({ ok: true });
});

// A CAIXA respondeu sem o resultado: a extensão conta o que apareceu e a fila segue (Fabio 09/11).
router.post('/:leadId/consulta-sem-resultado', async (req: AuthRequest, res: Response) => {
  const { ordem, texto } = req.body as { ordem?: number; texto?: string };
  if (!ordem) return res.status(400).json({ error: 'ordem obrigatória' });
  try { await consultaSemResultado(req.user!.accountId, req.params.leadId, Number(ordem), String(texto || '')); res.json({ ok: true }); } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro' }); }
});

router.post('/:leadId/pedir', async (req: AuthRequest, res: Response) => {
  const quem = (await prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true } }))?.name || 'equipe';
  const erro = await pedirCadastroCaixa(req.user!.accountId, req.params.leadId, quem).catch((e) => e?.message || 'erro');
  if (erro) return res.status(400).json({ error: erro });
  res.json({ ok: true });
});

router.post('/:leadId/conferir', async (req: AuthRequest, res: Response) => {
  const { ordem, campos } = req.body as { ordem?: number; campos?: { rotulo: string; valor: string }[] };
  if (!ordem || !Array.isArray(campos)) return res.status(400).json({ error: 'ordem e campos obrigatórios' });
  try {
    const r = await conferirCadastro(req.user!.accountId, req.params.leadId, Number(ordem), campos);
    if (!r) return res.status(502).json({ error: 'Não consegui conferir agora' });
    res.json(r);
  } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro' }); }
});

router.post('/:leadId/cadastrar', async (req: AuthRequest, res: Response) => {
  const ordens = (Array.isArray(req.body?.ordens) ? req.body.ordens : []).map(Number).filter((n: number) => n > 0);
  const quem = (await prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true } }))?.name || 'equipe';
  const erro = await pedirCadastroParticipantes(req.user!.accountId, req.params.leadId, ordens, quem).catch((e) => e?.message || 'erro');
  if (erro) return res.status(400).json({ error: erro });
  res.json({ ok: true });
});

router.post('/:leadId/cadastro', async (req: AuthRequest, res: Response) => {
  const { ordem, status, texto, antigo, antigoDatas } = req.body as { ordem?: number; status?: string; texto?: string; antigo?: string; antigoDatas?: { residenciaMes?: string; residenciaAno?: string; renda?: string } | null };
  if (!ordem || !status) return res.status(400).json({ error: 'ordem e status obrigatórios' });
  try { await gravarCadastro(req.user!.accountId, req.params.leadId, Number(ordem), { status: String(status), texto: String(texto || ''), antigo: antigo ? String(antigo) : '', antigoDatas: antigoDatas && typeof antigoDatas === 'object' ? antigoDatas : null }); res.json({ ok: true }); } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro' }); }
});

// VENDEDORES no Caixa Aqui (Fabio 18/11: cadastrados sem renda pra aparecerem no SIOPI na contratação; sem card próprio — ficam no card do comprador).
router.get('/:leadId/vendedores', async (req: AuthRequest, res: Response) => {
  const l = await prisma.lead.findFirst({ where: { id: req.params.leadId, accountId: req.user!.accountId }, select: { customFields: true } });
  if (!l) return res.status(404).json({ error: 'Lead não encontrado' });
  const { vendedoresDaFicha, faltaVendedor } = await import('../services/caixa-vendedores.service');
  const cf = (l.customFields || {}) as any;
  res.json({ at: cf._caixaVendedores?.at || null, cadastros: cf._caixaVendedores?.cadastros || {}, pessoas: vendedoresDaFicha(cf).map((p: any) => ({ ordem: p.ordem, nome: p.nome, telefone: p.telefone, email: p.email, enderecoDoImovel: p.enderecoDoImovel, falta: faltaVendedor(p) })) });
});
router.post('/:leadId/vendedores/ficha', requirePermission('funnel_manage'), async (req: AuthRequest, res: Response) => {
  const quem = (await prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true } }))?.name || 'equipe';
  const { montarFichaVendedores, faltaVendedor } = await import('../services/caixa-vendedores.service');
  const r = await montarFichaVendedores(req.user!.accountId, req.params.leadId, quem).catch((e) => ({ erro: e?.message || 'erro' } as { erro: string; pessoas?: any[] }));
  if (r.erro) return res.status(400).json({ error: r.erro });
  res.json({ ok: true, pessoas: (r.pessoas || []).map((p: any) => ({ ordem: p.ordem, nome: p.nome, falta: faltaVendedor(p) })) });
});
router.post('/:leadId/vendedores/dados', requirePermission('funnel_manage'), async (req: AuthRequest, res: Response) => {
  const quem = (await prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true } }))?.name || 'equipe';
  const { informarDadosVendedor } = await import('../services/caixa-vendedores.service');
  const erro = await informarDadosVendedor(req.user!.accountId, req.params.leadId, Number(req.body?.ordem), { telefone: req.body?.telefone, email: req.body?.email }, quem).catch((e) => e?.message || 'erro');
  if (erro) return res.status(400).json({ error: erro });
  res.json({ ok: true });
});
router.post('/:leadId/vendedores/cadastrar', requirePermission('funnel_manage'), async (req: AuthRequest, res: Response) => {
  const quem = (await prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true } }))?.name || 'equipe';
  const { pedirCadastroVendedores } = await import('../services/caixa-vendedores.service');
  const ordens = (Array.isArray(req.body?.ordens) ? req.body.ordens : []).map(Number).filter((n: number) => n > 100);
  const r = await pedirCadastroVendedores(req.user!.accountId, req.params.leadId, quem, ordens.length ? ordens : undefined).catch((e) => ({ erro: e?.message || 'erro', fila: [], faltando: [] }));
  if (r.erro) return res.status(400).json({ error: r.erro });
  res.json({ ok: true, fila: r.fila, faltando: r.faltando });
});

// Avaliação de Risco (passo 2): equipe pede; extensão devolve o que viu/fez.
router.post('/:leadId/avaliar', async (req: AuthRequest, res: Response) => {
  const quem = (await prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true } }))?.name || 'equipe';
  // `denovo` + `amortizacao` (SAC|PRICE): reabre a avaliação que deu erro e troca só a amortização (Fabio 12/11, Isidro: PRICE recusada no prazo → "pode aprovar na SAC").
  const amort = /^(SAC|PRICE)$/i.test(String(req.body?.amortizacao || '')) ? String(req.body.amortizacao).toUpperCase() : null;
  // `ajusteAnterior`: reenvia com o MESMO ajuste da avaliação refeita que parou pra conferência (condicionada de construção — Fabio 12/11, Isidro: "pode enviar").
  let ajuste: Record<string, unknown> | undefined = amort ? { amortizacao: amort } : undefined;
  if (req.body?.ajusteAnterior === true) {
    const l = await prisma.lead.findFirst({ where: { id: req.params.leadId, accountId: req.user!.accountId }, select: { customFields: true } });
    const aj = ((l?.customFields || {}) as any)._caixaCadastro?.avaliacao?.ajuste;
    if (!aj) return res.status(400).json({ error: 'a avaliação deste card não tem ajuste pra reenviar' });
    ajuste = aj;
  }
  const erro = await pedirAvaliacao(req.user!.accountId, req.params.leadId, quem, { enviar: req.body?.enviar === true, construcaoConferida: req.body?.construcaoConferida === true, denovo: req.body?.denovo === true, manual: true, ...(ajuste ? { ajuste } : {}) }).catch((e) => e?.message || 'erro');
  if (erro) return res.status(400).json({ error: erro });
  res.json({ ok: true });
});
router.post('/:leadId/avaliacao', async (req: AuthRequest, res: Response) => {
  const { status, texto } = req.body as { status?: string; texto?: string };
  if (!status) return res.status(400).json({ error: 'status obrigatório' });
  try {
    await gravarAvaliacao(req.user!.accountId, req.params.leadId, { status: String(status), texto: String(texto || '') });
    // Enviada → a extensão já consulta o resultado em Formulários Enviados (no Jézer o SIRIC respondeu no mesmo minuto do envio, 01/11).
    if (/^ENVIADA: a CAIXA recebeu/i.test(String(status))) await pedirConsultaResultado(req.user!.accountId, req.params.leadId, 'automático (depois do envio)').catch(() => null);
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro' }); }
});

// PDF do "Imprimir Formulário" da tela final → pasta FORMULARIOS do cliente no Drive.
router.post('/:leadId/formulario', async (req: AuthRequest, res: Response) => {
  const { ordem, pdf } = req.body as { ordem?: number; pdf?: string };
  if (!ordem || !pdf) return res.status(400).json({ error: 'ordem e pdf obrigatórios' });
  const erro = await salvarFormularioCaixa(req.user!.accountId, req.params.leadId, Number(ordem), String(pdf)).catch((e) => e?.message || 'erro');
  if (erro) return res.status(400).json({ error: erro });
  res.json({ ok: true });
});

// Mapa do formulário de cadastro da CAIXA (nomes, rótulos, opções e botões — sem valores), pra acertar o preenchimento.
router.post('/:leadId/mapa', async (req: AuthRequest, res: Response) => {
  const l = await prisma.lead.findFirst({ where: { id: req.params.leadId, accountId: req.user!.accountId }, select: { customFields: true } });
  if (!l) return res.status(404).json({ error: 'Lead não encontrado' });
  const mapa = { at: new Date().toISOString(), pagina: String((req.body as any)?.pagina || '').slice(0, 200), campos: Array.isArray((req.body as any)?.campos) ? (req.body as any).campos.slice(0, 150) : [], botoes: Array.isArray((req.body as any)?.botoes) ? (req.body as any).botoes.slice(0, 40) : [] };
  await prisma.lead.update({ where: { id: req.params.leadId }, data: { customFields: { ...((l.customFields || {}) as Record<string, unknown>), _caixaFormMapa: mapa } as any } });
  res.json({ ok: true });
});

// Desbloqueio do cadastro CAIXA — cliente atendido por OUTRO convênio (Fabio 18/11, Lucas): a extensão abre o cadastro, responde SIM ao aviso e, com `enviar`,
// clica "Enviar Token" (a CAIXA manda o SMS pro celular cadastrado do cliente). Quem pede fica na anotação.
router.post('/:leadId/card/desbloqueio', requirePermission('funnel_manage'), async (req: AuthRequest, res: Response) => {
  const erro = await pedirDesbloqueio(req.user!.accountId, req.params.leadId, await nomeDe(req), { modo: req.body?.enviar === true ? 'enviar' : req.body?.modo }).catch((e) => e?.message || 'erro');
  if (erro) return res.status(400).json({ error: erro });
  res.json({ ok: true, mensagem: 'Desbloqueio na fila da extensão da CAIXA' });
});
// Cancela a análise que sairia sozinha depois do cadastro (Fabio 18/11).
router.delete('/:leadId/card/analise-pendente', requirePermission('funnel_manage'), async (req: AuthRequest, res: Response) => {
  try {
    const { cancelarAnalisePendente } = require('../services/caixa-cadastro.service') as typeof import('../services/caixa-cadastro.service');
    const ok = await cancelarAnalisePendente(req.params.leadId, await nomeDe(req));
    res.json({ ok: true, mensagem: ok ? 'Análise pendente cancelada' : 'Não havia análise pendente' });
  } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro' }); }
});
// Pergunta ao cliente (outro correspondente) — o texto fixo de textoPerguntaOutroCca; daí em diante a IA conduz.
router.post('/:leadId/card/desbloqueio/perguntar', requirePermission('funnel_manage'), async (req: AuthRequest, res: Response) => {
  const erro = await perguntarAoCliente(req.user!.accountId, req.params.leadId, await nomeDe(req), req.app.get('io')).catch((e) => e?.message || 'erro');
  if (erro) return res.status(400).json({ error: erro });
  res.json({ ok: true, mensagem: 'Pergunta enviada ao cliente' });
});
// A extensão, parada na tela do token, pergunta se o cliente já mandou o código (entregue uma vez por código).
router.get('/:leadId/desbloqueio/token', async (req: AuthRequest, res: Response) => {
  try {
    const token = await entregarCodigo(req.user!.accountId, req.params.leadId);
    // Pedido novo na fila pra este cliente (código novo / outro modo): a extensão larga a tela do token e vai pra fila.
    const st = ((await prisma.lead.findUnique({ where: { id: req.params.leadId }, select: { customFields: true } }))?.customFields as any)?._caixaDesbloqueio?.status;
    res.json({ token, largar: !token && st === 'FILA' });
  } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro' }); }
});
router.post('/:leadId/desbloqueio', async (req: AuthRequest, res: Response) => {
  const b = (req.body || {}) as { status?: string; texto?: string; telefones?: string[]; campos?: string[]; final?: boolean };
  if (!b.status) return res.status(400).json({ error: 'status obrigatório' });
  try { await gravarDesbloqueio(req.user!.accountId, req.params.leadId, { status: String(b.status), texto: b.texto, telefones: Array.isArray(b.telefones) ? b.telefones : [], campos: Array.isArray(b.campos) ? b.campos : [], final: b.final }); res.json({ ok: true }); } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro' }); }
});

// Histórico da extensão nos logs do servidor (diagnóstico sem precisar abrir o Chrome do Fabio).
// Conta + cartão do PROPONENTE na contratação (Fabio 18/11 e 19/11: "caso estejam aprovados, basta contratá-los") — 1ª fase só consulta no Caixa Aqui.
router.get('/:leadId/produtos', async (req: AuthRequest, res: Response) => {
  const l = await prisma.lead.findFirst({ where: { id: req.params.leadId, accountId: req.user!.accountId }, select: { customFields: true } });
  if (!l) return res.status(404).json({ error: 'Lead não encontrado' });
  const cf = (l.customFields || {}) as any;
  res.json({ estado: cf._caixaProdutos || null, daAvaliacao: produtosDaAvaliacao(cf) });
});
router.post('/:leadId/produtos/pedir', requirePermission('funnel_manage'), async (req: AuthRequest, res: Response) => {
  const quem = (await prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true } }))?.name || 'equipe';
  const ordem = Number(req.body?.ordem) || undefined;
  const modo = req.body?.modo === 'ate' ? 'ate' : 'olhar';
  const erro = await pedirProdutosCaixa(req.user!.accountId, req.params.leadId, quem, { ordem, modo, avancos: Number(req.body?.avancos) || 0, conta: req.body?.conta ? { tipo: 'corrente', cheque: req.body.conta.cheque !== false, gerar: req.body.conta.gerar === true, ...(/^\d{1,3}(\.\d{3})*,\d{2}$/.test(String(req.body.conta.limite || '')) ? { limite: String(req.body.conta.limite) } : {}) } : null, cartao: req.body?.cartao === true ? true : (req.body?.cartao && typeof req.body.cartao === 'object' ? { solicitar: req.body.cartao.solicitar === true, bandeira: ['MASTERCARD', 'VISA', 'ELO'].includes(String(req.body.cartao.bandeira || '').toUpperCase()) ? String(req.body.cartao.bandeira).toUpperCase() : undefined, vencimento: /^([1-9]|1\d|2[0-8])$/.test(String(req.body.cartao.vencimento || '')) ? String(req.body.cartao.vencimento) : undefined, limite: /^\d{1,3}(\.\d{3})*,\d{2}$/.test(String(req.body.cartao.limite || '')) ? String(req.body.cartao.limite) : undefined, variante: req.body.cartao.variante ? String(req.body.cartao.variante).slice(0, 60) : undefined } : undefined) }).catch((e) => e?.message || 'erro');
  if (erro) return res.status(400).json({ error: erro });
  res.json({ ok: true });
});
router.post('/:leadId/produtos', async (req: AuthRequest, res: Response) => {
  try { await gravarProdutosCaixa(req.user!.accountId, req.params.leadId, req.body || {}); res.json({ ok: true }); } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro' }); }
});

router.post('/log', async (req: AuthRequest, res: Response) => {
  console.log('[CAIXA ext]', String((req.body as any)?.texto || '').replace(/\d{11}/g, '[CPF]').slice(0, 500));
  res.json({ ok: true });
});

export default router;
