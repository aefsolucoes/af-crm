import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { prisma } from '../lib/prisma';
import { requirePermission } from '../middleware/permission';
import { pedirCadastroCaixa, proximaConsulta, gravarConsulta, consultaSemResultado, informarEstadoCivil, informarDadosRenda, prontosParaCadastro, conferirCadastro, pedirCadastroParticipantes, gravarCadastro, salvarFormularioCaixa, pedirAvaliacao, gravarAvaliacao, marcarConferido, fazerCadastroManual, painelCaixa, semCadastroCaixa, AVALIACAO_APOS_CONFERENCIA, estadoCaixaDoCard, cadastroCaixaPeloCard, analiseCaixaPeloCard } from '../services/caixa-cadastro.service';
import { pedirConsultaResultado, proximaConsultaResultado, gravarConsultaResultado, pedirAvisoPv } from '../services/caixa-resultado.service';
import { verificarOcorrencias } from '../services/caixa-ocorrencias.service';

// Fila do cadastro na CAIXA (Fabio 29/10: "quero que o CRM indique qual cliente rodar") — usada pela extensão "Cadastro CAIXA (Caixa Aqui)".
const router = Router();
router.use(authMiddleware);

router.get('/fila', async (req: AuthRequest, res: Response) => {
  // Sem consulta/cadastro/avaliação pendente → consulta do resultado de avaliação já enviada (Formulários Enviados).
  try { res.json((await proximaConsulta(req.user!.accountId)) || (await proximaConsultaResultado(req.user!.accountId))); } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro na fila da CAIXA' }); }
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
    res.json({ ok: true, mensagem: r.mensagem });
  } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro ao pedir o cadastro na CAIXA' }); }
});
// Botão "Consultar na CAIXA" (Fabio 11/11: "Sempre que um cliente quiser seguir pela CAIXA, ele informar ou a gente, o CRM deve fazer uma consulta para buscar ocorrências"):
// consulta do nome em Oportunidades de Negócios antes de qualquer documento. Sem restrição → o cliente fica sabendo e o CRM pergunta do Habite-se; com restrição → Serasa/SCPC/protesto.
router.post('/:leadId/card/consulta', requirePermission('funnel_manage'), async (req: AuthRequest, res: Response) => {
  try {
    const { pedirConsultaCaixa } = require('../services/caixa-screening.service') as typeof import('../services/caixa-screening.service');
    const r = await pedirConsultaCaixa(req.user!.accountId, req.params.leadId, { origem: 'botao', por: `botão "Consultar na CAIXA" (${await nomeDe(req)})`, io: req.app.get('io') });
    if (!r.ok) return res.status(400).json({ error: r.erro || 'Não consegui pedir a consulta' });
    res.json({ ok: true, mensagem: r.ja ? 'O card já tinha consulta da CAIXA: usei o resultado que existe' : 'Consulta do nome na CAIXA na fila da extensão' });
  } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro ao pedir a consulta na CAIXA' }); }
});
// O clique é a autorização da Avaliação de Risco pra este cliente (Fabio 31/10: só com o OK dele) — registrada no card (avaliacao.autorizacao + anotação).
// `denovo` (Fabio 03/11, Jézer/Fernanda depois da autorização do PV): roda a Avaliação de Risco de novo — a anterior vai pro histórico e o resultado é consultado de novo.
router.post('/:leadId/card/analise', requirePermission('funnel_manage'), async (req: AuthRequest, res: Response) => {
  try {
    const r = await analiseCaixaPeloCard(req.user!.accountId, req.params.leadId, { id: req.user!.id, nome: await nomeDe(req) }, { enviar: req.body?.enviar === true, conferido: req.body?.conferido === true, denovo: req.body?.denovo === true });
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
  const erro = await pedirAvaliacao(req.user!.accountId, req.params.leadId, quem, { enviar: req.body?.enviar === true, construcaoConferida: req.body?.construcaoConferida === true, denovo: req.body?.denovo === true, ...(ajuste ? { ajuste } : {}) }).catch((e) => e?.message || 'erro');
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

// Histórico da extensão nos logs do servidor (diagnóstico sem precisar abrir o Chrome do Fabio).
router.post('/log', async (req: AuthRequest, res: Response) => {
  console.log('[CAIXA ext]', String((req.body as any)?.texto || '').replace(/\d{11}/g, '[CPF]').slice(0, 500));
  res.json({ ok: true });
});

export default router;
