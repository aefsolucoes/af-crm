import { prisma } from '../lib/prisma';
import { sendOutboundWhatsApp } from './message.service';

type Io = Parameters<typeof sendOutboundWhatsApp>[0]['io'];
type Cf = Record<string, any>;
type DriveF = { id: string; name: string; path: string; mimeType: string; size: number };

/**
 * QUESTIONÁRIO DA CONTRATAÇÃO DO INTER (Fabio 30/10, Pedro Francisco). Depois da vistoria o consultor manda "CRÉDITO E IMÓVEL APROVADOS!… SEU CLIENTE ACEITA PROSSEGUIR?
 * QUESTIONÁRIO: vencimento, assinaturas, ICP-Brasil, registro, despesas de registro, profissão/e-mail/telefone, endereço… DOCUMENTOS… RESPONSÁVEL (Zeev)".
 * Respostas do Fabio:
 *  - vencimento das parcelas (1, 5, 10, 15 ou 20): perguntar ao cliente;
 *  - assinaturas: SEMPRE digitais; certificado ICP-Brasil: não possui; registro: eletrônico;
 *  - financiar as despesas de registro: perguntar ao cliente, explicando que funciona como um reembolso;
 *  - profissão, e-mail e telefone: os do card, confirmados com o cliente;
 *  - endereço dos proponentes: o da documentação do imóvel;
 *  - documentos: NÃO vão no e-mail (Fabio 30/10: "não precisa anexar nada, apenas responder o questionário") — sobem pelo portal Zeev (extensão a fazer, módulo da extensão do Inter);
 *  - responsável pelos documentos na Zeev: Andreia (zeevResponsavel — CPF na variável do Railway).
 * "Quando receber esse e-mail deve ser disparado ao cliente um template caso a conversa esteja fechada e/ou perguntar o questionário" — vale mesmo com a chave da contratação
 * automática desligada (pedido explícito); só o STOP do card (_autoPaused) e o horário 07–21h seguram a mensagem ao cliente.
 * Fluxo (customFields._interQuest): e-mail chega → PERGUNTAR → pergunta ao cliente (janela fechada: template de atualização 1×; a pergunta sai quando ele responder) → PERGUNTADO →
 * respostas lidas por IA (Haiku) 60 s depois da última mensagem → falta algo: pergunta só o que falta (1×) → completo: responde o e-mail do consultor no mesmo fio → ENVIADO.
 * Documento que não está na pasta (ex.: certidão de estado civil) é pedido ao cliente junto com as perguntas — e só ele (a Zeev vai precisar).
 */

/** Responsável pelos documentos na Zeev (Fabio 30/10: Andreia). O CPF não fica no código: vem da variável INTER_ZEEV_RESPONSAVEL do Railway ("Nome;CPF;e-mail").
 *  Sem o CPF configurado o e-mail ao Inter NÃO sai sozinho: nota + push pra equipe configurar (ou responder à mão). */
export function zeevResponsavel(): { nome: string; cpf: string; email: string } {
  const [nome, cpf, email] = String(process.env.INTER_ZEEV_RESPONSAVEL || '').split(';').map((x) => x.trim());
  return { nome: nome || 'Andreia Batista de Oliveira', cpf: cpf || '', email: email || 'andreia@aefsolucoesfinanceiras.com.br' };
}
const VENCIMENTOS = [1, 5, 10, 15, 20];
const TEMPLATE = 'atualizacao_processo_credito';
const CIVIL_ESPERA_MS = 10 * 86_400_000;
const CONFIRMA_ESPERA_MS = 24 * 3600_000;

type Q = {
  status?: 'PERGUNTAR' | 'PERGUNTADO' | 'ENVIADO' | 'ERRO';
  emailId?: string; at?: string; manual?: boolean;
  askedAt?: string; templateAt?: string; cobrouAt?: string; lidoAt?: string;
  vencimento?: number | null; despesas?: 'SIM' | 'NAO' | null; dadosOk?: boolean | null;
  profissao?: string | null; email?: string | null; telefone?: string | null; duvida?: string | null;
  enviadoAt?: string; enderecoEnviadoAt?: string; erro?: string;
};
type Dados = { nome: string; profissao: string | null; email: string | null; telefone: string | null };

const note = (leadId: string, content: string) => prisma.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});
const push = (accountId: string, title: string, body: string, leadId: string) => { try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title, body, leadId }).catch(() => {}); } catch { /* aviso */ } };
const vazio = (v: unknown) => v === undefined || v === null || String(v).trim() === '' || String(v).trim() === 'null';
const norm = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const faz = (iso?: string) => (iso ? Date.now() - new Date(iso).getTime() : Infinity);

/** Grava só a chave _interQuest (jsonb, sem regravar o card inteiro — corrida no customFields). */
async function salva(leadId: string, patch: Partial<Q>) {
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_interQuest}', COALESCE("customFields"->'_interQuest', '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb, true) WHERE id = ${leadId}`;
}

// ─── Puras (testáveis) ───
/** O e-mail traz o questionário da contratação? */
export function pedeQuestionarioContratacao(text: string | null | undefined): boolean {
  const t = String(text || '');
  return /question[aá]rio/i.test(t) && /vencimento/i.test(t);
}

export function fmtTelefone(v: string | null | undefined): string | null {
  const d = String(v || '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return vazio(v) ? null : String(v).trim();
}

/** Profissão, e-mail e telefone do titular: o que o cliente corrigiu > card > ficha cadastral. */
export function dadosDoTitular(cf: Cf, leadName: string, q: Q = {}): Dados {
  const ficha = (((cf._fichaCadastral?.participantes || []) as any[])[0] || {}) as Record<string, any>;
  const s = (...vs: unknown[]) => { for (const v of vs) if (!vazio(v)) return String(v).trim(); return null; };
  return {
    nome: s(cf.participante_1, leadName) || '',
    profissao: s(q.profissao, cf.profissao_1, cf.profissao, ficha.profissao, ficha.trabalho?.cargo),
    email: s(q.email, cf.email_1, cf.email, ficha.email),
    telefone: fmtTelefone(s(q.telefone, cf.telefone_1, cf.telefone)),
  };
}

/** RG/CNH e certidão de estado civil dos proponentes na pasta do Drive (fora de IMOVEL/VENDEDOR/FORMULARIOS…). Vale o TIPO, não o nome no arquivo: o nome do titular
 *  vem da leitura e pode vir errado (Fabio 30/10: "CERTIDAO DE NASCIMENTO NILSO SANTOS" era a certidão do Pedro — "só pedir documento se não estiver na pasta"). */
export function docsDoTitular(files: DriveF[]): { ident: DriveF[]; civil: DriveF[] } {
  const IDENT = /^(RG|CNH|DOCUMENTO DE IDENTIFICACAO|CARTEIRA DE IDENTIDADE|IDENTIDADE)\b/;
  const CIVIL = /^(CERTIDAO DE (CASAMENTO|NASCIMENTO|OBITO|UNIAO ESTAVEL)|AVERBACAO|ESCRITURA DE UNIAO ESTAVEL)\b/;
  const ok = files.filter((f) => /^(application\/pdf|image\/)/.test(f.mimeType) && (f.size || 0) <= 10 * 1024 * 1024
    && !/imovel|im[oó]vel|vendedor|formulario|minuta|itbi/i.test(f.path || '') && !/^VERIFICAR/i.test(f.name));
  const by = (re: RegExp) => ok.filter((f) => re.test(norm(f.name))).sort((a, b) => a.name.localeCompare(b.name));
  return { ident: by(IDENT).slice(0, 4), civil: by(CIVIL).slice(0, 2) };
}

/** Nome do anexo no e-mail: com um proponente só, "TIPO - NOME DO CLIENTE.ext" (o nome lido no arquivo pode estar errado); com dois, o nome do arquivo. Pura. */
export function nomeDoAnexo(f: DriveF, titular: string, umProponente: boolean): string {
  if (!umProponente || !titular) return f.name;
  const ext = (/\.[a-z0-9]{2,5}$/i.exec(f.name)?.[0] || '').toLowerCase();
  const tipo = /^(RG|CNH|DOCUMENTO DE IDENTIFICACAO|CARTEIRA DE IDENTIDADE|IDENTIDADE|CERTIDAO DE (CASAMENTO|NASCIMENTO|OBITO|UNIAO ESTAVEL)|AVERBACAO|ESCRITURA DE UNIAO ESTAVEL)\b/.exec(norm(f.name))?.[0];
  return tipo ? `${tipo} - ${norm(titular)}${ext}` : f.name;
}

const lista = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} e ${xs[xs.length - 1]}`);

export function textoPergunta(nome: string, d: Dados, pedirCivil: boolean): string {
  const l = [`${nome ? `${nome}, a` : 'A'} vistoria do seu imóvel foi concluída e o seu processo seguiu para a contratação! 🎉`, '', 'Pra eu passar ao banco, preciso que você me confirme:', ''];
  let n = 0;
  l.push(`${++n}. Qual o melhor dia pro vencimento das parcelas: 1, 5, 10, 15 ou 20?`);
  l.push(`${++n}. Você quer incluir as despesas do registro do contrato no empréstimo? Funciona como um reembolso: você paga o registro no cartório e o banco te devolve esse valor junto com o crédito.`);
  const tem = [d.email && `e-mail ${d.email}`, d.telefone && `telefone ${d.telefone}`, d.profissao && `profissão ${d.profissao}`].filter(Boolean) as string[];
  const pede = [!d.email && 'o seu e-mail', !d.telefone && 'o seu telefone', !d.profissao && 'a sua profissão'].filter(Boolean) as string[];
  if (tem.length) l.push(`${++n}. Seus dados estão certos? ${tem.join(', ').replace(/^./, (c) => c.toUpperCase())}.${pede.length ? ` E qual é ${lista(pede)}?` : ''}`);
  else l.push(`${++n}. Qual é ${lista(pede)}?`);
  if (pedirCivil) l.push(`${++n}. Uma foto da sua certidão de nascimento (se for solteiro) ou de casamento (se for casado, divorciado ou viúvo). Pode ser a que você tiver, mesmo antiga.`);
  l.push('', 'A assinatura do contrato vai ser digital. 🙂');
  return l.join('\n');
}

export type FaltaQ = 'vencimento' | 'despesas' | 'profissao' | 'contato' | 'confirmar';
export function faltasDoQuestionario(q: Q, d: Dados): FaltaQ[] {
  const f: FaltaQ[] = [];
  if (!q.vencimento || !VENCIMENTOS.includes(Number(q.vencimento))) f.push('vencimento');
  if (q.despesas !== 'SIM' && q.despesas !== 'NAO') f.push('despesas');
  if (!d.profissao) f.push('profissao');
  if (!d.email || !d.telefone) f.push('contato');
  else if (q.dadosOk !== true && vazio(q.profissao) && vazio(q.email) && vazio(q.telefone)) f.push('confirmar');
  return f;
}

export function textoCobranca(nome: string, faltas: FaltaQ[], d: Dados): string {
  const t: Record<FaltaQ, string> = {
    vencimento: 'o dia do vencimento das parcelas (1, 5, 10, 15 ou 20)',
    despesas: 'se quer incluir as despesas do registro no empréstimo (funciona como reembolso: você paga o cartório e o banco te devolve junto com o crédito)',
    profissao: 'a sua profissão',
    contato: [!d.email && 'o seu e-mail', !d.telefone && 'o seu telefone'].filter(Boolean).join(' e ') || 'o seu e-mail e telefone',
    confirmar: `se o e-mail ${d.email} e o telefone ${d.telefone} estão certos`,
  };
  return `${nome ? `${nome}, o` : 'O'}brigado! Pra fechar com o banco, só falta me dizer ${lista(faltas.map((x) => t[x]))}.`;
}

export function corpoEmailQuestionario(p: { consultor: string; q: Q; d: Dados; endereco: string | null; zeev: { nome: string; cpf: string; email: string } }): string {
  const { q, d } = p;
  return [
    `Olá, ${p.consultor || 'tudo bem'}${p.consultor ? ', tudo bem?' : '?'}`,
    '',
    'Sim, o cliente aceita prosseguir com a contratação. Seguem as informações:',
    '',
    'QUESTIONÁRIO:',
    `• Data de vencimento das parcelas: dia ${q.vencimento}`,
    '• Assinaturas: Digitais',
    '• Possui certificado ICP-Brasil? Não possui',
    '• Registro: Eletrônico',
    `• Irá financiar despesas de registro? ${q.despesas === 'SIM' ? 'Sim' : 'Não'}`,
    `• Profissão, e-mail e telefone dos proponentes: ${d.nome} — ${d.profissao} — ${d.email} — ${d.telefone}`,
    `• Endereço dos proponentes: ${p.endereco || '(confirmo em seguida)'}`,
    '',
    'RESPONSÁVEL PELOS DOCUMENTOS PARA EMISSÃO DO CONTRATO (acesso à Zeev):',
    `• Nome completo: ${p.zeev.nome}`,
    `• CPF: ${p.zeev.cpf}`,
    `• E-mail: ${p.zeev.email}`,
    '',
    'Qualquer dúvida, fico à disposição.',
  ].join('\n');
}

// ─── Dados de fora (Drive, endereço, e-mail original) ───
async function arquivosDoDrive(accountId: string, cf: Cf): Promise<DriveF[]> {
  const link = String(cf.link_pasta_drive || '').trim();
  if (!link) return [];
  try { const { extractFolderId, listAllFilesInFolderTree } = await import('./google.service'); return (await listAllFilesInFolderTree(accountId, extractFolderId(link), 3)) as DriveF[]; } catch { return []; }
}

/** Endereço pelos campos do imóvel no card + CEP (ViaCEP): Pedro não tinha a proposta com "Endereço do imóvel" nem leitura de documento com endereço, e o e-mail saiu "(confirmo em seguida)". */
export async function enderecoDoCard(cf: Cf): Promise<string | null> {
  const cep = String(cf.imovel_cep || '').replace(/\D/g, '');
  if (cep.length !== 8 || vazio(cf.imovel_numero)) return null;
  const v = await fetch(`https://viacep.com.br/ws/${cep}/json/`, { signal: AbortSignal.timeout(6000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as Record<string, any> | null;
  if (!v || v.erro || vazio(v.logradouro)) return null;
  return [`${v.logradouro}, ${String(cf.imovel_numero).trim()}${vazio(cf.imovel_complemento) ? '' : ` - ${String(cf.imovel_complemento).trim()}`}`, v.bairro, `${v.localidade}/${v.uf}`, `CEP ${cep.slice(0, 5)}-${cep.slice(5)}`]
    .filter((x) => !vazio(x)).join(' — ');
}

async function enderecoTexto(leadId: string, cf: Cf): Promise<string | null> {
  const { enderecoDoImovel } = require('./certidao-offer.service') as typeof import('./certidao-offer.service');
  const e = await enderecoDoImovel(leadId, cf).catch(() => null);
  if (!e) return enderecoDoCard(cf);
  const x = e.endereco as Record<string, any>;
  const cep = String(x.cep || '').replace(/\D/g, '');
  return [
    `${[x.tipoLogradouro, x.logradouro].filter((v) => !vazio(v)).join(' ')}${vazio(x.numero) ? '' : `, ${x.numero}`}${vazio(x.complemento) ? '' : ` - ${x.complemento}`}`,
    x.bairro, `${e.cidade}/${e.uf}`, cep.length === 8 ? `CEP ${cep.slice(0, 5)}-${cep.slice(5)}` : null,
  ].filter((v) => !vazio(v)).join(' — ');
}

const PRIMEIRO_NOME = (s: string | null | undefined) => { const w = String(s || '').trim().split(/\s+/)[0] || ''; return /^[A-Za-zÀ-ÿ]{2,}$/.test(w) ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : ''; };

// ─── Fluxo ───
/** E-mail do consultor com o questionário chegou (inter-email.service). Começa o fluxo (uma vez por e-mail). */
export async function iniciarQuestionarioInter(accountId: string, leadId: string, emailId: string, io?: Io, opts: { manual?: boolean; jaPerguntadoEm?: string } = {}): Promise<Q | null> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  if (!lead) return null;
  const q = ((lead.customFields || {}) as Cf)._interQuest as Q | undefined;
  if (q?.emailId === emailId && !opts.manual) return q;
  if (q?.status === 'ENVIADO' && !opts.manual) return q;
  const base: Q = { status: opts.jaPerguntadoEm ? 'PERGUNTADO' : 'PERGUNTAR', emailId, at: new Date().toISOString(), ...(opts.manual ? { manual: true } : {}), ...(opts.jaPerguntadoEm ? { askedAt: opts.jaPerguntadoEm } : {}) };
  await salva(leadId, base);
  if (!opts.jaPerguntadoEm) await perguntarQuestionario(accountId, leadId, io);
  else agendaLeitura(accountId, leadId, io);
  return { ...(q || {}), ...base };
}

/** Pergunta ao cliente (07–21h, sem STOP). Janela fechada: template de atualização (uma vez; a pergunta sai quando ele responder). */
export async function perguntarQuestionario(accountId: string, leadId: string, io?: Io): Promise<boolean> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, customFields: true } });
  if (!lead) return false;
  const cf = (lead.customFields || {}) as Cf;
  const q = (cf._interQuest || {}) as Q;
  if (q.status !== 'PERGUNTAR' || cf._autoPaused) return false;
  const { inNoticeWindow, whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  if (!inNoticeWindow()) return false;
  const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
  const nome = callableFirstName(cf.falando_com, cf.participante_1, lead.name) || '';
  if (!(await whatsappWindowOpen(leadId))) {
    if (q.templateAt) return false;
    // template de atualização já saiu hoje (equipe/Jarvis/supervisão): não repete
    const recente = await prisma.message.findFirst({ where: { leadId, direction: 'OUTBOUND', createdAt: { gt: new Date(Date.now() - 20 * 3600_000) }, content: { contains: 'Temos uma atualização sobre o seu processo' } }, select: { id: true } });
    let ok = !!recente;
    if (!recente) {
      const { sendOutboundWhatsAppTemplate } = require('./message.service') as typeof import('./message.service');
      const n = nome || 'cliente';
      const t = await sendOutboundWhatsAppTemplate({ accountId, leadId, templateName: TEMPLATE, language: 'pt_BR', bodyParams: [n], previewText: `Oi ${n}, tudo bem? Temos uma atualização sobre o seu processo de crédito com garantia de imóvel. Responda esta mensagem para que a gente possa te passar os detalhes.`, io: io as any });
      ok = t.success;
      if (!t.success) await note(leadId, `📝 Questionário do Inter: a conversa está fechada e o template de atualização não saiu (${t.error}). Pergunte ao cliente o vencimento, as despesas de registro e confirme profissão/e-mail/telefone.`);
    }
    await salva(leadId, { templateAt: new Date().toISOString() });
    if (ok) await note(leadId, `📝 Questionário do Inter: a conversa estava fechada — ${recente ? 'o template de atualização já tinha saído hoje' : 'mandei o template de atualização'}. Quando o cliente responder, o CRM pergunta o vencimento, as despesas de registro e confirma os dados.`);
    return false;
  }
  const d = dadosDoTitular(cf, lead.name, q);
  const pedirCivil = !docsDoTitular(await arquivosDoDrive(accountId, cf)).civil.length; // só pede o que NÃO está na pasta (Fabio 30/10)
  const r = await sendOutboundWhatsApp({ accountId, leadId, content: textoPergunta(nome, d, pedirCivil), io });
  if (!r.success) return false;
  await salva(leadId, { status: 'PERGUNTADO', askedAt: new Date().toISOString() });
  await note(leadId, `📝 Questionário do Inter: perguntei ao cliente o dia do vencimento, se financia as despesas de registro${pedirCivil ? ', a certidão de estado civil' : ''} e confirmei profissão/e-mail/telefone. Assinatura digital, sem ICP-Brasil e registro eletrônico vão fixos. Com as respostas, o CRM responde o e-mail do Inter sozinho.`);
  return true;
}

const SYSTEM_Q = `Você lê mensagens de WhatsApp de um cliente respondendo às perguntas da contratação do empréstimo: (1) dia do vencimento das parcelas — só 1, 5, 10, 15 ou 20; (2) se quer incluir/financiar as despesas do registro no cartório (funciona como reembolso); (3) se os dados dele (e-mail, telefone, profissão) estão certos, ou a correção. Extraia SÓ o que está escrito (nunca invente) e responda SOMENTE com JSON:
{"vencimento":null,"despesas":null,"dadosOk":null,"profissao":null,"email":null,"telefone":null,"duvida":null}
Regras: "vencimento" é número (1, 5, 10, 15 ou 20); dia fora da lista → null e diga em "duvida". "despesas": "SIM" se ele quer incluir/financiar ("sim", "quero", "pode incluir"), "NAO" se não quer; sem resposta → null. "dadosOk": true se ele disse que os dados estão certos ("tudo certo", "isso mesmo", "confirmo", "correto"); false se disse que algo está errado. Se ele informou ou corrigiu profissão, e-mail ou telefone, preencha o campo (telefone só dígitos com DDD). "duvida": pergunta ou dúvida que ele fez, em poucas palavras; sem dúvida → null. Respostas numeradas ("1- 10, 2- sim, 3- ok") seguem a ordem das perguntas.`;

async function lerResposta(leadId: string, desde: Date): Promise<Record<string, any> | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const msgs = await prisma.message.findMany({ where: { leadId, direction: 'INBOUND', createdAt: { gt: desde } }, orderBy: { createdAt: 'asc' }, take: 25, select: { content: true } });
  const texto = msgs.map((m) => m.content).filter((c) => c && c.trim() && !/^📎/.test(c.trim())).join('\n---\n').slice(0, 6000);
  if (!texto.trim()) return null;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 600, system: SYSTEM_Q, messages: [{ role: 'user', content: texto }] }),
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  try { return JSON.parse((data.content?.find((b) => b.type === 'text')?.text || '').match(/\{[\s\S]*\}/)?.[0] || ''); } catch { return null; }
}

const lendo = new Map<string, NodeJS.Timeout>();
/** Lê as respostas 60 s depois da última mensagem (o cliente costuma mandar em várias). */
function agendaLeitura(accountId: string, leadId: string, io?: Io) {
  const t = lendo.get(leadId);
  if (t) clearTimeout(t);
  lendo.set(leadId, setTimeout(() => { lendo.delete(leadId); lerAgora(accountId, leadId, io).catch((e: any) => console.warn('[Questionário Inter] leitura:', e?.message)); }, 60_000));
}

async function lerAgora(accountId: string, leadId: string, io?: Io) {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, customFields: true } });
  if (!lead) return;
  const cf = (lead.customFields || {}) as Cf;
  const q = (cf._interQuest || {}) as Q;
  if (q.status !== 'PERGUNTADO' || !q.askedAt) return;
  const novo = await lerResposta(leadId, new Date(q.askedAt));
  if (!novo) return;
  const patch: Partial<Q> = { lidoAt: new Date().toISOString() };
  if (VENCIMENTOS.includes(Number(novo.vencimento))) patch.vencimento = Number(novo.vencimento);
  if (novo.despesas === 'SIM' || novo.despesas === 'NAO') patch.despesas = novo.despesas;
  if (typeof novo.dadosOk === 'boolean') patch.dadosOk = novo.dadosOk;
  for (const k of ['profissao', 'email', 'telefone'] as const) if (!vazio(novo[k])) patch[k] = String(novo[k]).trim();
  if (!vazio(novo.duvida)) patch.duvida = String(novo.duvida).trim().slice(0, 200);
  await salva(leadId, patch);
  const q2: Q = { ...q, ...patch };
  const d = dadosDoTitular(cf, lead.name, q2);
  const faltas = faltasDoQuestionario(q2, d);
  const leuAlgo = ['vencimento', 'despesas', 'dadosOk', 'profissao', 'email', 'telefone'].some((k) => k in patch);
  if (leuAlgo || patch.duvida) {
    const linhas = [
      patch.vencimento && `Vencimento: dia ${patch.vencimento}`,
      patch.despesas && `Financiar despesas de registro: ${patch.despesas === 'SIM' ? 'Sim' : 'Não'}`,
      patch.dadosOk === true && 'Dados confirmados',
      patch.profissao && `Profissão: ${patch.profissao}`, patch.email && `E-mail: ${patch.email}`, patch.telefone && `Telefone: ${fmtTelefone(patch.telefone)}`,
      patch.duvida && `❓ Dúvida do cliente: ${patch.duvida}`,
    ].filter(Boolean);
    await note(leadId, `📝 Questionário do Inter — o cliente respondeu:\n${linhas.join('\n')}${faltas.length ? `\nAinda falta: ${faltas.join(', ')}.` : ''}`);
    if (patch.duvida) push(accountId, '❓ Questionário do Inter: dúvida do cliente', `${lead.name}: ${patch.duvida}`, leadId);
  }
  const duras = faltas.filter((f) => f !== 'confirmar');
  if (!duras.length && (!faltas.includes('confirmar') || q.cobrouAt)) { await enviarEmailQuestionario(accountId, leadId, io); return; }
  if (!leuAlgo || q.cobrouAt || cf._autoPaused) return;
  const { inNoticeWindow } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  if (!inNoticeWindow()) return;
  const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
  const r = await sendOutboundWhatsApp({ accountId, leadId, content: textoCobranca(callableFirstName(cf.falando_com, cf.participante_1, lead.name) || '', faltas, d), io });
  if (r.success) await salva(leadId, { cobrouAt: new Date().toISOString() });
}

/** Responde o e-mail do consultor no mesmo fio, com o questionário e os documentos do titular. */
export async function enviarEmailQuestionario(accountId: string, leadId: string, io?: Io, opts: { forcar?: boolean } = {}): Promise<{ ok: boolean; erro?: string }> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true } });
  if (!lead) return { ok: false, erro: 'Card não encontrado' };
  const cf = (lead.customFields || {}) as Cf;
  const q = (cf._interQuest || {}) as Q;
  if (q.status === 'ENVIADO' && !opts.forcar) return { ok: true };
  const d = dadosDoTitular(cf, lead.name, q);
  const duras = faltasDoQuestionario(q, d).filter((f) => f !== 'confirmar');
  if (duras.length) return { ok: false, erro: `Falta: ${duras.join(', ')}` };
  const row = q.emailId ? await prisma.emailMessage.findUnique({ where: { id: q.emailId }, select: { id: true, emailAccountId: true, fromAddress: true, fromName: true, subject: true, toList: true, ccList: true } }) : null;
  const acc = row ? await prisma.emailAccount.findUnique({ where: { id: row.emailAccountId } }) : null;
  const dono = await prisma.user.findFirst({ where: { accountId, role: 'ADMIN' }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  if (!row || !acc || !row.fromAddress) return { ok: false, erro: 'E-mail do Inter não encontrado' };
  const zeev = zeevResponsavel();
  if (!zeev.cpf) {
    if (!q.erro?.startsWith('ZEEV')) {
      await salva(leadId, { erro: 'ZEEV: falta INTER_ZEEV_RESPONSAVEL' });
      await note(leadId, `⚠️ Questionário do Inter pronto (vencimento dia ${q.vencimento}, despesas de registro: ${q.despesas === 'SIM' ? 'Sim' : 'Não'}), mas o e-mail ao Inter não saiu: falta configurar o responsável da Zeev (variável INTER_ZEEV_RESPONSAVEL no Railway, "Nome;CPF;e-mail"). Depois de configurar, o CRM envia sozinho.`);
      push(accountId, '⚠️ Questionário do Inter parado', `${lead.name}: falta o responsável da Zeev`, leadId);
    }
    return { ok: false, erro: 'Falta configurar o responsável da Zeev (INTER_ZEEV_RESPONSAVEL)' };
  }
  const endereco = await enderecoTexto(leadId, cf);
  if (!endereco) {
    if (!q.erro?.startsWith('ENDERECO')) {
      await salva(leadId, { erro: 'ENDERECO: não achei o endereço do imóvel' });
      await note(leadId, `⚠️ Questionário do Inter pronto (vencimento dia ${q.vencimento}), mas o e-mail não saiu: não achei o endereço do imóvel (proposta, documentos ou CEP/número no card, aba Financiamento). Preencha CEP e número do imóvel no card que o CRM envia sozinho.`);
      push(accountId, '⚠️ Questionário do Inter parado', `${lead.name}: falta o endereço do imóvel`, leadId);
    }
    return { ok: false, erro: 'Falta o endereço do imóvel' };
  }
  const proprio = acc.address.toLowerCase();
  const cc = [...new Set([...(Array.isArray(row.toList) ? row.toList : []), ...(Array.isArray(row.ccList) ? row.ccList : [])]
    .map((a: any) => String(a?.address || '').toLowerCase())
    .filter((a) => a && a !== proprio && a !== row.fromAddress!.toLowerCase() && /@([a-z0-9-]+\.)*(inter\.co|bancointer\.com\.br)$/.test(a)))];
  const sub = String(row.subject || 'Home Equity').trim();
  const corpo = corpoEmailQuestionario({ consultor: PRIMEIRO_NOME(row.fromName), q, d, endereco, zeev });
  try {
    const { sendEmailFrom } = require('./email-inbox.service') as typeof import('./email-inbox.service');
    await sendEmailFrom({ acc, userId: dono?.id || null, to: [row.fromAddress], cc, subject: /^re:/i.test(sub) ? sub : `Re: ${sub}`, body: corpo, replyToId: row.id, leadId, io: (io || ({ to: () => ({ emit: () => {} }) })) as any });
  } catch (e: any) {
    await salva(leadId, { erro: String(e?.message || e).slice(0, 200) });
    await note(leadId, `⚠️ Questionário do Inter: o e-mail de resposta não saiu (${e?.message}). Responda à mão.`);
    push(accountId, '⚠️ Questionário do Inter não saiu', lead.name, leadId);
    return { ok: false, erro: e?.message };
  }
  await salva(leadId, { status: 'ENVIADO', enviadoAt: new Date().toISOString() });
  await note(leadId, `📨 Questionário do Inter respondido por e-mail a ${row.fromAddress}: vencimento dia ${q.vencimento}, despesas de registro ${q.despesas === 'SIM' ? 'financiadas' : 'não financiadas'}, assinatura digital (sem ICP-Brasil), registro eletrônico, responsável na Zeev ${zeev.nome}, endereço ${endereco}. Os documentos sobem pelo portal Zeev.`);
  push(accountId, '📨 Questionário do Inter respondido', `${lead.name}: vencimento dia ${q.vencimento}`, leadId);
  return { ok: true };
}

const RETOMA_DESDE = new Date('2026-10-30T03:00:00Z');
/** E-mail do questionário que chegou antes do fluxo existir (Pedro, 30/10) ou que o vigia não pegou: começa sozinho. Se a pergunta já saiu na conversa
 *  (à mão), começa como PERGUNTADO dessa hora e só lê as respostas (Fabio 30/10: "o Pedro já confirmou, o próximo passo é responder o e-mail pro André"). */
async function retomarSemFluxo(accountId: string, io?: Io): Promise<void> {
  const rows = await prisma.$queryRaw<{ id: string; leadId: string; date: Date }[]>`
    SELECT em.id, em."leadId", em.date FROM "EmailMessage" em
      JOIN "EmailAccount" ea ON ea.id = em."emailAccountId"
      JOIN "Lead" l ON l.id = em."leadId"
    WHERE ea."accountId" = ${accountId} AND em.folder = 'INBOX' AND em.date > ${RETOMA_DESDE} AND em.date > now() - interval '5 days'
      AND em."fromAddress" ~* '@([a-z0-9-]+\.)*(inter\.co|bancointer\.com\.br)$'
      AND (em."textBody" ILIKE '%question%rio%' OR em."htmlBody" ILIKE '%question%rio%')
      AND l.status = 'OPEN' AND l.archived = false AND NOT jsonb_exists(COALESCE(l."customFields", '{}'::jsonb), '_interQuest')
    ORDER BY em.date DESC LIMIT 10`;
  const { vistoriaConcluida, interEmailTexto, freshPart } = require('./inter-email.service') as typeof import('./inter-email.service');
  for (const r of rows) {
    const em = await prisma.emailMessage.findUnique({ where: { id: r.id }, select: { textBody: true, htmlBody: true } });
    const fresh = freshPart(interEmailTexto(em?.textBody, em?.htmlBody));
    if (!pedeQuestionarioContratacao(fresh) || !vistoriaConcluida(fresh)) continue;
    const ja = await prisma.message.findFirst({ where: { leadId: r.leadId, direction: 'OUTBOUND', channel: 'WHATSAPP', createdAt: { gt: r.date }, content: { contains: 'vencimento das parcelas' } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    await iniciarQuestionarioInter(accountId, r.leadId, r.id, io, ja ? { jaPerguntadoEm: ja.createdAt.toISOString() } : {});
    await note(r.leadId, `📝 Questionário do Inter retomado pelo CRM (e-mail que chegou antes do fluxo). ${ja ? 'A pergunta já tinha saído na conversa: o CRM lê as respostas do cliente e responde o consultor.' : 'O CRM vai perguntar ao cliente.'}`);
  }
}

/** E-mail que saiu com "Endereço dos proponentes: (confirmo em seguida)" (Pedro, 30/10, antes do endereço pelo CEP do card): manda o endereço no mesmo fio, uma vez
 *  (Fabio: "pode mandar o endereço pro André"). */
async function complementarEndereco(accountId: string, io?: Io): Promise<void> {
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT l.id FROM "Lead" l WHERE l."accountId" = ${accountId} AND l.status = 'OPEN' AND l.archived = false
      AND l."customFields"->'_interQuest'->>'status' = 'ENVIADO' AND COALESCE(l."customFields"->'_interQuest'->>'enderecoEnviadoAt', '') = ''
      AND EXISTS (SELECT 1 FROM "Message" m WHERE m."leadId" = l.id AND m.channel = 'EMAIL' AND m.direction = 'OUTBOUND' AND m."createdAt" > now() - interval '7 days'
                  AND m.content LIKE '%Endereço dos proponentes: (confirmo em seguida)%')`;
  for (const { id } of ids) {
    const lead = await prisma.lead.findUnique({ where: { id }, select: { name: true, customFields: true } });
    if (!lead) continue;
    const cf = (lead.customFields || {}) as Cf;
    const q = (cf._interQuest || {}) as Q;
    const endereco = await enderecoTexto(id, cf);
    if (!endereco) continue;
    const row = q.emailId ? await prisma.emailMessage.findUnique({ where: { id: q.emailId }, select: { id: true, emailAccountId: true, fromAddress: true, fromName: true, subject: true } }) : null;
    const acc = row ? await prisma.emailAccount.findUnique({ where: { id: row.emailAccountId } }) : null;
    if (!row || !acc || !row.fromAddress) continue;
    await salva(id, { enderecoEnviadoAt: new Date().toISOString() }); // antes do envio: nunca manda 2×
    const dono = await prisma.user.findFirst({ where: { accountId, role: 'ADMIN' }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    const consultor = PRIMEIRO_NOME(row.fromName);
    const sub = String(row.subject || 'Home Equity').trim();
    const d = dadosDoTitular(cf, lead.name, q);
    try {
      const { sendEmailFrom } = require('./email-inbox.service') as typeof import('./email-inbox.service');
      await sendEmailFrom({ acc, userId: dono?.id || null, to: [row.fromAddress], subject: /^re:/i.test(sub) ? sub : `Re: ${sub}`, body: `Olá${consultor ? `, ${consultor}` : ''}!\n\nComplementando o questionário do cliente ${d.nome}:\n• Endereço dos proponentes: ${endereco}\n\nQualquer dúvida, fico à disposição.`, replyToId: row.id, leadId: id, io: (io || ({ to: () => ({ emit: () => {} }) })) as any });
    } catch (e: any) {
      await note(id, `⚠️ Questionário do Inter: o complemento com o endereço não saiu (${e?.message}). Mande à mão: ${endereco}`);
      continue;
    }
    await note(id, `📨 Endereço dos proponentes enviado ao Inter (complemento do questionário): ${endereco}`);
  }
}

/** Poller (1 min, credit-auto): pergunta quem está esperando, fecha quem só não confirmou os dados há 24 h e manda o e-mail que estava esperando (responsável da Zeev / endereço). */
export async function processQuestionariosInter(accountId: string, io?: Io): Promise<void> {
  await retomarSemFluxo(accountId, io).catch((e: any) => console.warn('[Questionário Inter] retomar:', e?.message));
  await complementarEndereco(accountId, io).catch((e: any) => console.warn('[Questionário Inter] endereço:', e?.message));
  const ids = await prisma.$queryRaw<{ id: string; status: string }[]>`
    SELECT id, "customFields"->'_interQuest'->>'status' AS status FROM "Lead"
    WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false AND "isGroup" = false
      AND "customFields"->'_interQuest'->>'status' IN ('PERGUNTAR', 'PERGUNTADO')`;
  for (const { id, status } of ids) {
    try {
      if (status === 'PERGUNTAR') await perguntarQuestionario(accountId, id, io);
      else {
        const lead = await prisma.lead.findUnique({ where: { id }, select: { name: true, customFields: true } });
        const q = (((lead?.customFields || {}) as Cf)._interQuest || {}) as Q;
        if (!lead) continue;
        if (q.erro?.startsWith('ZEEV')) { if (zeevResponsavel().cpf) await enviarEmailQuestionario(accountId, id, io); continue; } // respostas prontas esperando o responsável da Zeev
        if (q.erro?.startsWith('ENDERECO')) { if (faz(q.lidoAt) > 10 * 60_000) { await salva(id, { lidoAt: new Date().toISOString() }); await enviarEmailQuestionario(accountId, id, io); } continue; } // tenta de novo a cada 10 min (equipe preenche CEP/nº no card)
        if (!q.cobrouAt || faz(q.cobrouAt) < CONFIRMA_ESPERA_MS) continue;
        const f = faltasDoQuestionario(q, dadosDoTitular((lead.customFields || {}) as Cf, lead.name, q));
        if (f.length === 1 && f[0] === 'confirmar') await enviarEmailQuestionario(accountId, id, io); // só não confirmou os dados do card: seguem os do card
      }
    } catch (e: any) { console.warn('[Questionário Inter]', e?.message); }
  }
}

/** Hook da mensagem recebida. */
export async function onClientReplyQuestionario(accountId: string, leadId: string, io?: Io): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const q = (((lead?.customFields || {}) as Cf)._interQuest || {}) as Q;
  if (q.status === 'PERGUNTAR') { await perguntarQuestionario(accountId, leadId, io); return; } // respondeu o template: a janela abriu
  if (q.status === 'PERGUNTADO') agendaLeitura(accountId, leadId, io);
}

/** Card / Jarvis / início manual: estado + o e-mail que sairia. */
export async function questionarioPreview(accountId: string, leadId: string) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true } });
  if (!lead) throw new Error('Card não encontrado');
  const cf = (lead.customFields || {}) as Cf;
  const q = (cf._interQuest || {}) as Q;
  const d = dadosDoTitular(cf, lead.name, q);
  const docs = docsDoTitular(await arquivosDoDrive(accountId, cf));
  return { estado: q, dados: d, faltas: faltasDoQuestionario(q, d), documentosNaPasta: [...docs.ident, ...docs.civil].map((f) => nomeDoAnexo(f, d.nome, vazio(cf.participante_2))), endereco: await enderecoTexto(leadId, cf) };
}

/** Início manual (e-mail que já tinha chegado antes do fluxo existir): acha o e-mail do questionário ligado ao card. */
export async function iniciarManual(accountId: string, leadId: string, io?: Io, jaPerguntadoEm?: string): Promise<Q | null> {
  const { vistoriaConcluida, interEmailTexto } = require('./inter-email.service') as typeof import('./inter-email.service');
  const rows = await prisma.emailMessage.findMany({ where: { leadId, folder: 'INBOX', emailAccount: { accountId } }, orderBy: { date: 'desc' }, take: 15, select: { id: true, textBody: true, htmlBody: true } });
  const row = rows.find((r) => { const t = interEmailTexto(r.textBody, r.htmlBody); return pedeQuestionarioContratacao(t) && vistoriaConcluida(t); });
  if (!row) throw new Error('Não achei o e-mail do Inter com o questionário ligado a este card');
  return iniciarQuestionarioInter(accountId, leadId, row.id, io, { manual: true, jaPerguntadoEm });
}
