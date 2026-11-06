import { prisma } from '../lib/prisma';
import { sexoParaFormulario } from './sexo-pelo-nome';

/**
 * PROPOSTA MONTADA COM OS DOCUMENTOS (Fabio 02/11: "sim" — automatizar). Cliente do Home Equity que não consegue preencher a proposta: a IA oferece
 * "me manda uma foto do seu documento pessoal e um comprovante de residência que eu sigo com a pré-análise" (FORM_FIRST_RULES). Antes nada montava a
 * proposta: o card ficava parado e o cliente ainda recebia o "não finalizou" no dia seguinte.
 *  1. Chegou documento com foto (RG/CNH) e comprovante de residência depois da oferta → o CRM lê os dois (lerDocumentoPessoal: nome, CPF, nascimento, endereço).
 *  2. Pergunta numa mensagem só o que falta pra proposta (estado civil — Fabio: "precisaria também do estado civil" —, renda, imóvel, valores, quitado, e-mail,
 *     cônjuge se casado). O que o card já tem da simulação do site não é perguntado. Prazo: o do card, senão 240 meses (1ª análise sempre no prazo máximo).
 *     Renda (Fabio 02/11): a MAIOR entre a que o cliente informou e a que faz a parcela do crédito caber em 30%, + R$ 3 mil (rendaDaProposta).
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
  perguntouAt?: string; reperguntouAt?: string; equipeAt?: string; semIaAt?: string; montadaAt?: string; versao?: number;
};
/** Versão das regras da montagem: subir faz a proposta que o CRM já montou ser REFEITA uma vez (e a análise rodar de novo). 2 = renda + R$ 3 mil, endereço do imóvel dito pelo cliente, nacionalidade (02/11). */
const PROPOSTA_V = 2;

const OFERTA_DIAS = 10;
const ESPERA_RAJADA_MS = 2 * 60_000; // o cliente costuma mandar frente, verso e comprovante em sequência
const ESPERA_RESPOSTA_MS = 5 * 60_000;
const ESPERA_EQUIPE_MS = 30 * 60_000;
const PRAZO_PADRAO = 240;
/** Renda da proposta montada pelos documentos (Fabio 02/11): a MAIOR entre a que o cliente informou e a que faz a parcela do crédito pedido caber em 30%, mais R$ 3 mil
 *  (ex.: parcela de R$ 1.200 → R$ 4.000 → R$ 7.000; informou R$ 3.700 e a parcela pede menos → R$ 6.700). Parcela estimada na PRICE (o Home Equity é PRICE), na taxa mais
 *  alta dos bancos do HE (Santander ~1,69% a.m.) pra renda não ficar curta em nenhum. Pura. */
const TAXA_HE_MES = 0.0169;
export function rendaPelaParcela(credito: number, prazo: number): number {
  if (!(credito > 0) || !(prazo > 0)) return 0;
  const parcela = (credito * TAXA_HE_MES) / (1 - Math.pow(1 + TAXA_HE_MES, -prazo));
  return Math.ceil(parcela / 0.3 / 100) * 100 + 3000;
}
export function rendaDaProposta(informada: number, credito: number, prazo: number): number {
  const pelaParcela = rendaPelaParcela(credito, prazo); // já com os R$ 3 mil
  if (!(informada > 0)) return pelaParcela;
  return Math.max(informada + 3000, pelaParcela);
}
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
async function lerRespostas(pergunta: string, falas: string[], enderecoComprovante = ''): Promise<Cf | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !falas.length) return null;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-5', max_tokens: 4096,
      system: `Você lê as respostas de um cliente no WhatsApp às perguntas de um correspondente bancário pra montar a proposta de crédito com garantia de imóvel (Home Equity). Extraia SÓ o que o cliente disse — nunca deduza nem invente; o que ele não respondeu = null. Valores em reais como número (ex.: "250 mil" → 250000, "5.500" → 5500). Responda SÓ com JSON:
{"estadoCivil":"Solteiro(a)|Casado(a)|União estável|Divorciado(a)|Viúvo(a)|null","valorImovel":null,"credito":null,"prazoMeses":null,"tipoImovel":"Casa|Apartamento|Terreno|Sala comercial|Outro|null","imovelMesmoEndereco":true|false|null,"imovelEndereco":{"logradouro":null,"numero":null,"complemento":null,"bairro":null,"cidade":null,"uf":null,"cep":null},"quitado":"Sim|Não|null","saldoDevedor":null,"email":null,"conjuge":{"nome":null,"cpf":null,"nascimento":"dd/mm/aaaa|null"}}`,
      messages: [{ role: 'user', content: `PERGUNTA QUE FIZEMOS:\n${pergunta}\n\nENDEREÇO DO COMPROVANTE DE RESIDÊNCIA (onde o cliente mora): ${enderecoComprovante || '—'}\nimovelMesmoEndereco = true SÓ se o imóvel da garantia fica nesse endereço; se ele disse que o imóvel fica em outro lugar, false e o endereço em imovelEndereco.\n\nO QUE O CLIENTE RESPONDEU (em ordem):\n${falas.map((f) => `- ${f}`).join('\n')}` }],
    }),
  }).catch(() => null);
  if (!res?.ok) return null;
  const data: any = await res.json().catch(() => null);
  const raw = String(data?.content?.find((b: any) => b.type === 'text')?.text || '');
  try { return JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || ''); } catch { return null; }
}

/** Prazo nas opções do formulário da proposta (60, 120, 180 ou 240 meses — Fabio 03/11): o mais perto; empate → o maior. */
export function prazoDoFormulario(meses: number): number {
  const ops = [60, 120, 180, 240];
  if (!(meses > 0)) return 240;
  return ops.reduce((best, o) => (Math.abs(o - meses) < Math.abs(best - meses) || (Math.abs(o - meses) === Math.abs(best - meses) && o > best) ? o : best), ops[0]);
}

/** Junta documento + comprovante + card + respostas no formato do montarPropostaManual. */
function juntar(st: Estado, cf: Cf, contato: { email?: string | null; telefone?: string | null }) {
  const leituras = Object.values(st.leituras || {});
  const id = leituras.find((l) => ehIdentidade(l.tipo) && l.pessoa?.cpf)?.pessoa || leituras.find((l) => ehIdentidade(l.tipo))?.pessoa || {};
  const endDoc = leituras.find((l) => ehComprovante(l.tipo) && l.endereco?.cep)?.endereco || leituras.find((l) => ehComprovante(l.tipo))?.endereco || null;
  const r = st.respostas || {};
  const end = endDoc ? { logradouro: endDoc.logradouro || '', numero: endDoc.numero || '', complemento: endDoc.complemento || '', bairro: endDoc.bairro || '', cidade: endDoc.cidade || '', uf: endDoc.uf || '', cep: endDoc.cep || '' } : undefined;
  const imEnd = r.imovelEndereco && (r.imovelEndereco.logradouro || r.imovelEndereco.cep) ? r.imovelEndereco : undefined;
  // Endereço do imóvel dito pelo cliente e DIFERENTE do comprovante vale mais que um "é o mesmo endereço" (Francisco 02/11: mora em Goiânia, o imóvel é no Ceará).
  const cepDe = (e: any) => String(e?.cep || '').replace(/\D/g, '');
  const outroLugar = !!imEnd && !!end && ((cepDe(imEnd) && cepDe(end) && cepDe(imEnd).slice(0, 5) !== cepDe(end).slice(0, 5)) || (imEnd.cidade && end.cidade && norm(imEnd.cidade) !== norm(end.cidade)));
  const sexo = String(sexoParaFormulario(cf, id.nome || cf.participante_1, id.sexo) || '').toUpperCase(); // "Gênero" do card (equipe) → documento → card (CRM) → primeiro nome (Fabio 06/11)
  const quitado = r.quitado || (num(cf.saldo_devedor) > 0 ? 'Não' : '');
  return {
    nome: id.nome || cf.participante_1 || '', cpf: id.cpf || cf.cpf_1 || '', nascimento: id.nascimento || cf.nascimento_1 || '',
    estadoCivil: r.estadoCivil || id.estadoCivil || cf.estado_civil_1 || '',
    email: r.email || cf.email_1 || contato.email || '', celular: cf.telefone_1 || contato.telefone || '',
    genero: sexo === 'F' ? 'Feminino' : sexo === 'M' ? 'Masculino' : '', nacionalidade: /^brasil/i.test(String(id.nacionalidade || '').trim()) ? 'Brasileira' : id.nacionalidade || '', // CNH traz "BRASILEIRO"; o Santander só aceita BRASILEIRA
    naturalidade: id.naturalidade?.cidade ? `${id.naturalidade.cidade}${id.naturalidade.uf ? `/${id.naturalidade.uf}` : ''}` : '',
    endereco: end,
    imovel: { tipo: r.tipoImovel || cf.tipo_imovel || '', mesmoEndereco: r.imovelMesmoEndereco === true && !outroLugar, endereco: imEnd },
    valorImovel: num(r.valorImovel) || num(cf.valor_imovel), credito: num(r.credito) || num(cf.valor_credito),
    prazo: prazoDoFormulario(Number(r.prazoMeses) || Number(String(cf.prazo_financ || '').replace(/\D/g, '')) || PRAZO_PADRAO),
    // "O imóvel possui certidão de ônus/matrícula?" do formulário (o Creditas lê como "imóvel regularizado"): sempre Sim (Fabio 03/11).
    certidao: 'Sim',
    renda: num(r.renda) || num(cf._propostaDoc?.rendaInformada) || 0,
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
  // Propostas que o CRM já montou com regras antigas (o card já saiu do Follow Up): refeitas uma vez (PROPOSTA_V).
  const antigas = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false
      AND "customFields"->'_propostaDoc'->>'montadaAt' IS NOT NULL
      AND COALESCE(NULLIF("customFields"->'_propostaDoc'->>'versao', '')::int, 1) < ${PROPOSTA_V} LIMIT 10`;
  const extras = antigas.length ? await prisma.lead.findMany({ where: { id: { in: antigas.map((x) => x.id) } }, select: { id: true, name: true, customFields: true, aiAutoReplyActive: true, contact: { select: { email: true, phone: true, whatsappPhone: true } } } }) : [];
  for (const l of [...leads, ...extras.filter((x) => !leads.some((y) => y.id === x.id))]) {
    try { await processarUm(accountId, l, io); } catch (e: any) { console.error('[Proposta por documento]', l.name, e?.message); }
  }
}

async function processarUm(accountId: string, l: { id: string; name: string; customFields: unknown; aiAutoReplyActive: boolean; contact: { email: string | null; phone: string | null; whatsappPhone: string | null } | null }, io?: Io) {
  const cf = (l.customFields || {}) as Cf;
  const st: Estado = { ...(cf._propostaDoc || {}) };
  const refazer = !!st.montadaAt && Number(st.versao || 1) < PROPOSTA_V;
  if ((st.montadaAt && !refazer) || cf._autoPaused) return;
  if (refazer) return refazerProposta(accountId, l, st, io);
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
      const comp = Object.values(st.leituras || {}).find((x) => ehComprovante(x.tipo))?.endereco;
      const lido = await lerRespostas(pergunta, novas.map((m) => String(m.content || '').slice(0, 600)).filter(Boolean), comp ? [comp.logradouro, comp.numero, comp.bairro, comp.cidade, comp.uf, comp.cep].filter(Boolean).join(', ') : '');
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
  await completarPorCep(dados.imovel.endereco);
  let falta = faltando(dados, respondeuImovel);
  if (!falta.length) {
    const m = montarPropostaManual({ ...dados, renda: rendaDaProposta(dados.renda, dados.credito, dados.prazo) });
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

/** Endereço do imóvel dito pelo cliente sem cidade/UF (ou rua): completa pelo CEP (ViaCEP). */
async function completarPorCep(e: End | undefined) {
  const cep = String(e?.cep || '').replace(/\D/g, '');
  if (!e || cep.length !== 8 || (e.cidade && e.uf && e.logradouro)) return;
  const v = await fetch(`https://viacep.com.br/ws/${cep}/json/`, { signal: AbortSignal.timeout(6000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as Record<string, any> | null;
  if (!v || v.erro) return;
  e.cidade = e.cidade || v.localidade || null; e.uf = e.uf || v.uf || null;
  e.logradouro = e.logradouro || v.logradouro || null; e.bairro = e.bairro || v.bairro || null;
}

/** Proposta que o CRM já montou com regras antigas (PROPOSTA_V): refaz com os mesmos documentos e respostas, sem perguntar nada ao cliente, e roda a análise de novo. */
async function refazerProposta(accountId: string, l: { id: string; name: string; customFields: unknown; aiAutoReplyActive: boolean; contact: { email: string | null; phone: string | null; whatsappPhone: string | null } | null }, st: Estado, io?: Io) {
  const cf = (l.customFields || {}) as Cf;
  const dados = juntar(st, cf, { email: l.contact?.email || null, telefone: cf.telefone_1 || l.contact?.phone || l.contact?.whatsappPhone || null });
  await completarPorCep(dados.imovel.endereco);
  const { montarPropostaManual } = require('./assistant-actions.service') as typeof import('./assistant-actions.service');
  const m = montarPropostaManual({ ...dados, renda: rendaDaProposta(dados.renda, dados.credito, dados.prazo) });
  if (m.faltam.length) {
    await salvar(l.id, { ...st, versao: PROPOSTA_V });
    await nota(l.id, `📋 Não consegui refazer a proposta montada pelo CRM com as regras novas — falta: ${m.faltam.join('; ')}. Confira com o cliente.`);
    return;
  }
  return registrar(accountId, l, st, m.texto, dados, io, true);
}

async function registrar(accountId: string, l: { id: string; name: string; customFields: unknown; aiAutoReplyActive: boolean }, st: Estado, texto: string, dados: ReturnType<typeof juntar>, io?: Io, refeita = false) {
  const cf = (l.customFields || {}) as Cf;
  // Abaixo do mínimo do Home Equity (Fabio 02/11): não monta — a regra da conversa é explicar o mínimo e desqualificar.
  if (dados.credito < 50_000) {
    if (st.equipeAt) return;
    st.equipeAt = new Date().toISOString(); await salvar(l.id, st);
    await nota(l.id, `📋 Não montei a proposta pelos documentos: o crédito pedido (R$ ${dados.credito.toLocaleString('pt-BR')}) está abaixo do mínimo de R$ 50 mil do Home Equity.`);
    return;
  }
  const completo = `${texto}\nOrigem: proposta ${refeita ? 'REFEITA' : 'montada'} pelo CRM com o documento, o comprovante de residência e as respostas do cliente no WhatsApp`;
  const msg = await prisma.message.create({ data: { content: completo, direction: 'INBOUND', channel: 'EMAIL', leadId: l.id, status: 'SENT', read: true }, include: { sentBy: { select: { id: true, name: true } } } });
  if (io) io.to(`lead:${l.id}`).emit('new_message', msg);
  const { parseProposalForm, advanceLeadOnProposalForm } = require('./campaign-detection.service') as typeof import('./campaign-detection.service');
  const lido = parseProposalForm(completo);
  const campos: Record<string, unknown> = { ...(lido?.fields || {}), _propostaDoc: { ...st, montadaAt: new Date().toISOString(), versao: PROPOSTA_V, rendaInformada: dados.renda || null } };
  if (dados.estadoCivil && !cf.estado_civil_1) campos.estado_civil_1 = dados.estadoCivil;
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = COALESCE("customFields", '{}'::jsonb) || ${JSON.stringify(campos)}::jsonb WHERE id = ${l.id}`;
  if (refeita) {
    // Já estava na Pré-Análise (ou adiante): roda de novo nos bancos com a proposta nova (a extensão lê sempre a proposta mais recente da conversa).
    const { createRequests } = require('./credit-analysis.service') as typeof import('./credit-analysis.service');
    const { bancosAuto } = require('./credit-auto.service') as typeof import('./credit-auto.service');
    const r = await createRequests(prisma as any, { accountId, leadIds: [l.id], banks: bancosAuto(cf), dryRun: false, kind: 'RUN', force: true, queueIfBusy: true }).catch(() => ({ created: 0 }));
    await nota(l.id, `📋 Proposta montada pelo CRM REFEITA com as regras novas (renda: a informada ou a que a parcela pede, + R$ 3 mil; endereço do imóvel dito pelo cliente; nacionalidade). ${r.created} análise(s) pedida(s) de novo.\n\n${completo}`);
    console.log(`[Proposta por documento] ${l.name}: proposta refeita (v${PROPOSTA_V}); ${r.created} análise(s) de novo`);
    return;
  }
  const moved = await advanceLeadOnProposalForm(accountId, l.id, completo).catch(() => null);
  if (moved) {
    const { runAutomations } = require('./automation.service') as typeof import('./automation.service');
    runAutomations({ accountId, trigger: 'STAGE_CHANGE', leadId: l.id, io, context: { newStageId: moved.stageId, skipClientMessages: true } }).catch(() => {});
  }
  if (!l.aiAutoReplyActive) await (require('./ia-pendencias.service') as typeof import('./ia-pendencias.service')).guardarPendenciaIa(l.id, 'propostaMontada', 'avisar que a proposta foi montada com os documentos e as respostas dele e que a pré-análise nos bancos já está rodando (avisa quando sair o resultado)');
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
