import { prisma } from '../lib/prisma';

/**
 * PROPOSTA MONTADA COM OS DOCUMENTOS (Fabio 02/11: "sim" — automatizar). Cliente do Home Equity que não consegue preencher a proposta: a IA oferece
 * "me manda uma foto do seu documento pessoal e um comprovante de residência que eu sigo com a pré-análise" (FORM_FIRST_RULES). Antes nada montava a
 * proposta: o card ficava parado e o cliente ainda recebia o "não finalizou" no dia seguinte.
 *  1. Chegou documento com foto (RG/CNH) e comprovante de residência depois da oferta → o CRM lê os dois (lerDocumentoPessoal: nome, CPF, nascimento, endereço).
 *  2. Pergunta numa mensagem só o que falta pra proposta (estado civil — Fabio: "precisaria também do estado civil" —, renda, imóvel, valores, quitado, e-mail,
 *     cônjuge se casado). O que o card já tem da simulação do site não é perguntado. Prazo: o do card, senão 240 meses (1ª análise sempre no prazo máximo).
 *  3. Lê as respostas (IA), e com tudo em mãos monta a proposta no MESMO texto da proposta manual do site (montarPropostaManual) e põe na conversa como
 *     as propostas do site por e-mail (INBOUND, canal EMAIL — não abre a janela de 24 h do WhatsApp): o card é preenchido, vai pra Pré-Análise e a análise
 *     automática roda nos bancos como numa proposta normal.
 *  Só com a IA do card ligada, das 07h às 21h e com a conversa do WhatsApp aberta; senão nota + push pra equipe (1 vez). Estado em `customFields._propostaDoc`.
 */
type Io = any;
type Cf = Record<string, any>;
type End = { logradouro?: string | null; numero?: string | null; complemento?: string | null; bairro?: string | null; cidade?: string | null; uf?: string | null; cep?: string | null };
type Estado = {
  leituras?: Record<string, { tipo: string; pessoa?: any; endereco?: End | null }>;
  respostas?: Cf; extraidoAte?: string;
  perguntouAt?: string; reperguntouAt?: string; equipeAt?: string; semIaAt?: string; montadaAt?: string;
};

const OFERTA_DIAS = 10;
const ESPERA_RAJADA_MS = 2 * 60_000; // o cliente costuma mandar frente, verso e comprovante em sequência
const ESPERA_RESPOSTA_MS = 5 * 60_000;
const ESPERA_EQUIPE_MS = 30 * 60_000;
const PRAZO_PADRAO = 240;
export const PERGUNTA_PREFIXO = 'Pra eu montar sua proposta';
const PROPOSTA_MARCAS = ['Proposta preenchida no site', 'PROPOSTA RECEBIDA', 'Preenchi a proposta', 'Proposta manual'];

const norm = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const num = (v: unknown): number => {
  if (typeof v === 'number') return v;
  const t = String(v ?? '').replace(/r\$\s*/i, '').trim();
  if (!t) return 0;
  const n = t.includes(',') ? Number(t.replace(/\./g, '').replace(',', '.')) : /\.\d{3}$/.test(t) ? Number(t.replace(/\./g, '')) : Number(t);
  return Number.isFinite(n) ? n : 0;
};
const ehOferta = (t: string) => /documento|\brg\b|cnh/i.test(t) && /comprovante de (resid|ender)/i.test(t) && /an[áa]lise/i.test(t) && !/parab|aprovad|documentos? (pessoais|do im[óo]vel)/i.test(t);
const ehIdentidade = (tipo: string) => /^(RG|CNH)$/.test(tipo);
const ehComprovante = (tipo: string) => /COMPROVANTE DE RESIDENCIA/.test(tipo);
const casado = (ec: unknown) => /casad|uniao|companheir/.test(norm(ec));

async function salvar(leadId: string, st: Estado) {
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = COALESCE("customFields", '{}'::jsonb) || jsonb_build_object('_propostaDoc', ${JSON.stringify(st)}::jsonb) WHERE id = ${leadId}`;
}
const nota = (leadId: string, content: string) => prisma.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});
async function push(accountId: string, leadId: string, title: string, body: string) {
  const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
  await sendPushToAccount(accountId, { title, body, leadId }).catch(() => {});
}

/** Lê o que o cliente respondeu (só o que ele disse — nunca inventa). */
async function lerRespostas(pergunta: string, falas: string[]): Promise<Cf | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !falas.length) return null;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-5', max_tokens: 4096,
      system: `Você lê as respostas de um cliente no WhatsApp às perguntas de um correspondente bancário pra montar a proposta de crédito com garantia de imóvel (Home Equity). Extraia SÓ o que o cliente disse — nunca deduza nem invente; o que ele não respondeu = null. Valores em reais como número (ex.: "250 mil" → 250000, "5.500" → 5500). Responda SÓ com JSON:
{"estadoCivil":"Solteiro(a)|Casado(a)|União estável|Divorciado(a)|Viúvo(a)|null","renda":null,"valorImovel":null,"credito":null,"prazoMeses":null,"tipoImovel":"Casa|Apartamento|Terreno|Sala comercial|Outro|null","imovelMesmoEndereco":true|false|null,"imovelEndereco":{"logradouro":null,"numero":null,"complemento":null,"bairro":null,"cidade":null,"uf":null,"cep":null},"quitado":"Sim|Não|null","saldoDevedor":null,"email":null,"conjuge":{"nome":null,"cpf":null,"nascimento":"dd/mm/aaaa|null"}}`,
      messages: [{ role: 'user', content: `PERGUNTA QUE FIZEMOS:\n${pergunta}\n\nO QUE O CLIENTE RESPONDEU (em ordem):\n${falas.map((f) => `- ${f}`).join('\n')}` }],
    }),
  }).catch(() => null);
  if (!res?.ok) return null;
  const data: any = await res.json().catch(() => null);
  const raw = String(data?.content?.find((b: any) => b.type === 'text')?.text || '');
  try { return JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || ''); } catch { return null; }
}

/** Junta documento + comprovante + card + respostas no formato do montarPropostaManual. */
function juntar(st: Estado, cf: Cf, contato: { email?: string | null; telefone?: string | null }) {
  const leituras = Object.values(st.leituras || {});
  const id = leituras.find((l) => ehIdentidade(l.tipo) && l.pessoa?.cpf)?.pessoa || leituras.find((l) => ehIdentidade(l.tipo))?.pessoa || {};
  const endDoc = leituras.find((l) => ehComprovante(l.tipo) && l.endereco?.cep)?.endereco || leituras.find((l) => ehComprovante(l.tipo))?.endereco || null;
  const r = st.respostas || {};
  const end = endDoc ? { logradouro: endDoc.logradouro || '', numero: endDoc.numero || '', complemento: endDoc.complemento || '', bairro: endDoc.bairro || '', cidade: endDoc.cidade || '', uf: endDoc.uf || '', cep: endDoc.cep || '' } : undefined;
  const imEnd = r.imovelEndereco && (r.imovelEndereco.logradouro || r.imovelEndereco.cep) ? r.imovelEndereco : undefined;
  const sexo = String(id.sexo || '').toUpperCase();
  const quitado = r.quitado || (num(cf.saldo_devedor) > 0 ? 'Não' : '');
  return {
    nome: id.nome || cf.participante_1 || '', cpf: id.cpf || cf.cpf_1 || '', nascimento: id.nascimento || cf.nascimento_1 || '',
    estadoCivil: r.estadoCivil || id.estadoCivil || cf.estado_civil_1 || '',
    email: r.email || cf.email_1 || contato.email || '', celular: cf.telefone_1 || contato.telefone || '',
    genero: sexo === 'F' ? 'Feminino' : sexo === 'M' ? 'Masculino' : '', nacionalidade: id.nacionalidade || '',
    naturalidade: id.naturalidade?.cidade ? `${id.naturalidade.cidade}${id.naturalidade.uf ? `/${id.naturalidade.uf}` : ''}` : '',
    renda: num(r.renda) || num(cf.renda_1) || 0,
    endereco: end,
    imovel: { tipo: r.tipoImovel || cf.tipo_imovel || '', mesmoEndereco: r.imovelMesmoEndereco === true, endereco: imEnd },
    valorImovel: num(r.valorImovel) || num(cf.valor_imovel), credito: num(r.credito) || num(cf.valor_credito),
    prazo: Number(r.prazoMeses) || Number(String(cf.prazo_financ || '').replace(/\D/g, '')) || PRAZO_PADRAO,
    quitado, saldoDevedor: num(r.saldoDevedor) || num(cf.saldo_devedor),
    participante2: casado(r.estadoCivil || id.estadoCivil || cf.estado_civil_1) && r.conjuge?.nome ? { nome: r.conjuge.nome, cpf: r.conjuge.cpf || '', nascimento: r.conjuge.nascimento || '', relacao: 'Cônjuge', compoeRenda: false } : null,
  };
}

/** O que perguntar ao cliente (texto curto por item). Endereço do cliente vem do comprovante; CEP faltando vira pergunta. */
function faltando(d: ReturnType<typeof juntar>, respondeuImovelMesmo: boolean): string[] {
  const f: string[] = [];
  if (!d.estadoCivil) f.push('estado civil');
  if (casado(d.estadoCivil) && !d.participante2) f.push('nome completo, CPF e data de nascimento do cônjuge');
  if (!(d.renda > 0)) f.push('renda bruta mensal');
  if (!(d.valorImovel > 0)) f.push('valor aproximado do imóvel');
  if (!(d.credito > 0)) f.push('quanto você precisa de crédito');
  if (!d.imovel.tipo) f.push('se o imóvel é casa, apartamento ou terreno');
  if (!respondeuImovelMesmo && !d.imovel.mesmoEndereco && !d.imovel.endereco) f.push('se o imóvel fica no mesmo endereço do comprovante (se não, o endereço do imóvel com CEP)');
  if (!d.quitado) f.push('se o imóvel está quitado (se não, quanto falta pagar)');
  else if (d.quitado === 'Não' && !(d.saldoDevedor > 0)) f.push('quanto falta pagar do financiamento do imóvel');
  if (!d.email) f.push('seu e-mail');
  if (!d.endereco || !String(d.endereco.cep || '').replace(/\D/g, '')) f.push('o CEP do seu endereço');
  return f;
}

async function podeFalar(leadId: string, aiOn: boolean): Promise<'ok' | 'ia' | 'horario' | 'janela'> {
  const { inNoticeWindow, whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  if (!aiOn) return 'ia';
  if (!inNoticeWindow()) return 'horario';
  if (!(await whatsappWindowOpen(leadId))) return 'janela';
  return 'ok';
}

export async function processPropostasPorDocumento(accountId: string, io?: Io): Promise<void> {
  const desde = new Date(Date.now() - OFERTA_DIAS * 86_400_000);
  const leads = await prisma.lead.findMany({
    where: {
      accountId, status: 'OPEN', archived: false, isGroup: false,
      pipeline: { department: { name: { contains: 'Home Equity', mode: 'insensitive' } } },
      OR: ['Prospec', 'Follow', 'Sem Retorno'].map((s) => ({ stage: { name: { contains: s, mode: 'insensitive' as const } } })),
      messages: { some: { direction: 'OUTBOUND', createdAt: { gte: desde }, content: { contains: 'comprovante de resid', mode: 'insensitive' } } },
    },
    select: { id: true, name: true, customFields: true, aiAutoReplyActive: true, contact: { select: { email: true, phone: true, whatsappPhone: true } } },
    take: 20,
  });
  for (const l of leads) {
    try { await processarUm(accountId, l, io); } catch (e: any) { console.error('[Proposta por documento]', l.name, e?.message); }
  }
}

async function processarUm(accountId: string, l: { id: string; name: string; customFields: unknown; aiAutoReplyActive: boolean; contact: { email: string | null; phone: string | null; whatsappPhone: string | null } | null }, io?: Io) {
  const cf = (l.customFields || {}) as Cf;
  const st: Estado = { ...(cf._propostaDoc || {}) };
  if (st.montadaAt || cf._autoPaused) return;
  if (await prisma.message.findFirst({ where: { leadId: l.id, deleted: false, OR: PROPOSTA_MARCAS.map((m) => ({ content: { contains: m } })) }, select: { id: true } })) return; // já tem proposta: segue o fluxo normal
  const ofertas = await prisma.message.findMany({ where: { leadId: l.id, direction: 'OUTBOUND', deleted: false, createdAt: { gte: new Date(Date.now() - OFERTA_DIAS * 86_400_000) }, content: { contains: 'comprovante de resid', mode: 'insensitive' } }, orderBy: { createdAt: 'asc' }, select: { content: true, createdAt: true } });
  const oferta = ofertas.find((m) => ehOferta(m.content || ''));
  if (!oferta) return;

  // 1) Documentos que chegaram depois da oferta.
  const anexos = await prisma.messageAttachment.findMany({ where: { leadId: l.id, createdAt: { gt: oferta.createdAt }, message: { direction: 'INBOUND' }, OR: [{ mimeType: 'application/pdf' }, { mimeType: { startsWith: 'image/' } }] }, orderBy: { createdAt: 'asc' }, select: { id: true, fileName: true, mimeType: true, driveFileId: true, createdAt: true } });
  if (!anexos.length) return;
  const ultimo = anexos[anexos.length - 1].createdAt.getTime();
  if (Date.now() - ultimo < ESPERA_RAJADA_MS) return;
  if (anexos.some((a) => !a.driveFileId && Date.now() - a.createdAt.getTime() < 10 * 60_000)) return; // ainda subindo pro Drive
  const { lerDocumentoPessoal } = require('./ficha-cadastral.service') as typeof import('./ficha-cadastral.service');
  st.leituras = { ...(st.leituras || {}) };
  let leuAlgo = false;
  for (const a of anexos) {
    if (st.leituras[a.id] || !a.driveFileId) continue;
    const r = await lerDocumentoPessoal(accountId, { driveFileId: a.driveFileId, fileName: a.fileName, mimeType: a.mimeType }).catch(() => null);
    const p = Array.isArray(r?.pessoas) ? r.pessoas[0] : null;
    st.leituras[a.id] = { tipo: String(r?.tipo || 'OUTRO').toUpperCase(), pessoa: p ? { nome: p.nome, cpf: p.cpf, nascimento: p.nascimento, sexo: p.sexo, nacionalidade: p.nacionalidade, naturalidade: p.naturalidade, estadoCivil: p.estadoCivil } : null, endereco: p?.endereco || null };
    leuAlgo = true;
  }
  if (leuAlgo) await salvar(l.id, st);
  const tipos = Object.values(st.leituras).map((x) => x.tipo);
  if (!tipos.some(ehIdentidade) || !tipos.some(ehComprovante)) return; // falta um dos dois: a IA da conversa pede o que falta

  // 2) Respostas do cliente depois da pergunta.
  if (st.perguntouAt) {
    const novas = await prisma.message.findMany({ where: { leadId: l.id, direction: 'INBOUND', deleted: false, createdAt: { gt: new Date(st.perguntouAt) } }, orderBy: { createdAt: 'asc' }, select: { content: true, createdAt: true } });
    const ultimaFala = novas.length ? novas[novas.length - 1].createdAt.toISOString() : null;
    if (ultimaFala && ultimaFala !== st.extraidoAte) {
      if (Date.now() - new Date(ultimaFala).getTime() < 60_000) return; // deixa terminar de escrever
      const pergunta = (await prisma.message.findFirst({ where: { leadId: l.id, direction: 'OUTBOUND', content: { startsWith: PERGUNTA_PREFIXO, mode: 'insensitive' } }, orderBy: { createdAt: 'desc' }, select: { content: true } }))?.content || '';
      const lido = await lerRespostas(pergunta, novas.map((m) => String(m.content || '').slice(0, 600)).filter(Boolean));
      if (!lido) return; // a leitura falhou: tenta de novo no próximo minuto
      const limpo = Object.fromEntries(Object.entries(lido).filter(([, v]) => v !== null && v !== '' && !(typeof v === 'object' && v && Object.values(v).every((x) => x === null || x === ''))));
      st.respostas = { ...(st.respostas || {}), ...limpo };
      st.extraidoAte = ultimaFala;
      await salvar(l.id, st);
    }
  }

  const contato = { email: l.contact?.email || null, telefone: cf.telefone_1 || l.contact?.phone || l.contact?.whatsappPhone || null };
  const dados = juntar(st, cf, contato);
  const respondeuImovel = st.respostas?.imovelMesmoEndereco === false && !!st.respostas?.imovelEndereco;
  const { montarPropostaManual } = require('./assistant-actions.service') as typeof import('./assistant-actions.service');
  let falta = faltando(dados, respondeuImovel);
  if (!falta.length) {
    const m = montarPropostaManual({ ...dados, endereco: dados.endereco, imovel: dados.imovel });
    if (!m.faltam.length) return registrar(accountId, l, st, m.texto, dados, io);
    falta = m.faltam;
  }

  // 3) Pergunta (1 vez; uma 2ª só com o que ainda falta depois da resposta; depois disso a equipe assume).
  const nome = (require('../lib/text') as typeof import('../lib/text')).callableFirstName(cf.falando_com, dados.nome, cf.participante_1, l.name);
  if (!st.perguntouAt) {
    const pode = await podeFalar(l.id, l.aiAutoReplyActive);
    if (pode === 'horario') return;
    if (pode !== 'ok') {
      if (st.semIaAt) return;
      st.semIaAt = new Date().toISOString(); await salvar(l.id, st);
      const motivo = pode === 'ia' ? 'a IA do card está desligada' : 'a conversa do WhatsApp está fechada (mais de 24 h sem o cliente escrever)';
      await nota(l.id, `📋 O cliente mandou o documento e o comprovante pra gente montar a proposta, mas ${motivo}, então não perguntei o resto. Falta: ${falta.join('; ')}.`);
      await push(accountId, l.id, `📋 Montar proposta — ${l.name}`, `Mandou os documentos; falta perguntar: ${falta.join(', ')}`);
      return;
    }
    const texto = `${PERGUNTA_PREFIXO}${nome ? `, ${nome}` : ''}, me responde só:\n${falta.map((x) => `• ${x}`).join('\n')}`;
    const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
    const r = await sendOutboundWhatsApp({ accountId, leadId: l.id, io, content: texto });
    if (!r.success) { console.warn('[Proposta por documento]', l.name, 'pergunta não saiu:', r.error); return; }
    st.perguntouAt = new Date().toISOString(); await salvar(l.id, st);
    await nota(l.id, `📋 Li o documento e o comprovante que o cliente mandou (nome, CPF, nascimento e endereço) e perguntei o que falta pra montar a proposta: ${falta.join('; ')}.`);
    return;
  }
  const respondeuDepois = st.extraidoAte && new Date(st.extraidoAte) > new Date(st.reperguntouAt || st.perguntouAt);
  if (!st.reperguntouAt && respondeuDepois && Date.now() - new Date(st.extraidoAte!).getTime() > ESPERA_RESPOSTA_MS) {
    if ((await podeFalar(l.id, l.aiAutoReplyActive)) !== 'ok') return;
    const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
    const r = await sendOutboundWhatsApp({ accountId, leadId: l.id, io, content: `${PERGUNTA_PREFIXO}, falta só:\n${falta.map((x) => `• ${x}`).join('\n')}` });
    if (r.success) { st.reperguntouAt = new Date().toISOString(); await salvar(l.id, st); }
    return;
  }
  const base = st.reperguntouAt || st.perguntouAt;
  if (!st.equipeAt && Date.now() - new Date(base).getTime() > ESPERA_EQUIPE_MS && (st.reperguntouAt || respondeuDepois)) {
    st.equipeAt = new Date().toISOString(); await salvar(l.id, st);
    await nota(l.id, `📋 Proposta pelos documentos ainda incompleta depois das perguntas ao cliente. Falta: ${falta.join('; ')}. Complete com ele e registre a proposta (Meu Assistente → registrar proposta).`);
    await push(accountId, l.id, `📋 Proposta incompleta — ${l.name}`, `Falta: ${falta.join(', ')}`);
  }
}

async function registrar(accountId: string, l: { id: string; name: string; customFields: unknown; aiAutoReplyActive: boolean }, st: Estado, texto: string, dados: ReturnType<typeof juntar>, io?: Io) {
  const cf = (l.customFields || {}) as Cf;
  // Abaixo do mínimo do Home Equity (Fabio 02/11): não monta — a regra da conversa é explicar o mínimo e desqualificar.
  if (dados.credito < 50_000) {
    if (st.equipeAt) return;
    st.equipeAt = new Date().toISOString(); await salvar(l.id, st);
    await nota(l.id, `📋 Não montei a proposta pelos documentos: o crédito pedido (R$ ${dados.credito.toLocaleString('pt-BR')}) está abaixo do mínimo de R$ 50 mil do Home Equity.`);
    return;
  }
  const completo = `${texto}\nOrigem: proposta montada pelo CRM com o documento, o comprovante de residência e as respostas do cliente no WhatsApp`;
  const msg = await prisma.message.create({ data: { content: completo, direction: 'INBOUND', channel: 'EMAIL', leadId: l.id, status: 'SENT', read: true }, include: { sentBy: { select: { id: true, name: true } } } });
  if (io) io.to(`lead:${l.id}`).emit('new_message', msg);
  const { parseProposalForm, advanceLeadOnProposalForm } = require('./campaign-detection.service') as typeof import('./campaign-detection.service');
  const lido = parseProposalForm(completo);
  const campos: Record<string, unknown> = { ...(lido?.fields || {}), _propostaDoc: { ...st, montadaAt: new Date().toISOString() } };
  if (dados.estadoCivil && !cf.estado_civil_1) campos.estado_civil_1 = dados.estadoCivil;
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = COALESCE("customFields", '{}'::jsonb) || ${JSON.stringify(campos)}::jsonb WHERE id = ${l.id}`;
  const moved = await advanceLeadOnProposalForm(accountId, l.id, completo).catch(() => null);
  if (moved) {
    const { runAutomations } = require('./automation.service') as typeof import('./automation.service');
    runAutomations({ accountId, trigger: 'STAGE_CHANGE', leadId: l.id, io, context: { newStageId: moved.stageId, skipClientMessages: true } }).catch(() => {});
  }
  if ((await podeFalar(l.id, l.aiAutoReplyActive)) === 'ok') {
    const nome = (require('../lib/text') as typeof import('../lib/text')).callableFirstName(cf.falando_com, dados.nome, cf.participante_1, l.name);
    const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
    await sendOutboundWhatsApp({ accountId, leadId: l.id, io, content: `Pronto${nome ? `, ${nome}` : ''}! Montei sua proposta com os seus documentos e as suas respostas. Agora vou fazer a pré-análise nos bancos e te aviso assim que sair.` }).catch(() => null);
  }
  await nota(l.id, `📋 Proposta montada pelo CRM com o documento, o comprovante e as respostas do cliente${moved ? ` — card levado pra "${moved.stageName}"` : ''}; a análise automática segue como numa proposta normal.\n\n${completo}`);
  const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
  sendPushToAccount(accountId, { title: `📋 Proposta montada — ${l.name}`, body: 'Pelos documentos e respostas do cliente; vai pra pré-análise', leadId: l.id }).catch(() => {});
  console.log(`[Proposta por documento] ${l.name}: proposta montada${moved ? ` e card em ${moved.stageName}` : ''}`);
}
