import { prisma } from '../lib/prisma';
import { templateAtualizacaoDoLead } from './template-atualizacao';
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
 * Documento que não está na pasta (ex.: certidão de estado civil): o CRM NÃO pede ao cliente (Fabio 31/10: "não peça nenhum documento ao cliente antes de me
 * perguntar") — anotação + push pra equipe decidir.
 */

/** Responsável pelos documentos na Zeev (Fabio 30/10: Andreia). O CPF não fica no código: vem da variável INTER_ZEEV_RESPONSAVEL do Railway ("Nome;CPF;e-mail").
 *  Sem o CPF configurado o e-mail ao Inter NÃO sai sozinho: nota + push pra equipe configurar (ou responder à mão). */
export function zeevResponsavel(): { nome: string; cpf: string; email: string } {
  const [nome, cpf, email] = String(process.env.INTER_ZEEV_RESPONSAVEL || '').split(';').map((x) => x.trim());
  return { nome: nome || 'Andreia Batista de Oliveira', cpf: cpf || '', email: email || 'andreia@aefsolucoesfinanceiras.com.br' };
}
const VENCIMENTOS = [1, 5, 10, 15, 20];
const CIVIL_ESPERA_MS = 10 * 86_400_000;
const CONFIRMA_ESPERA_MS = 24 * 3600_000;

type Q = {
  status?: 'PERGUNTAR' | 'PERGUNTADO' | 'ENVIADO' | 'ERRO';
  emailId?: string; at?: string; manual?: boolean;
  askedAt?: string; templateAt?: string; cobrouAt?: string; lidoAt?: string;
  vencimento?: number | null; despesas?: 'SIM' | 'NAO' | null; dadosOk?: boolean | null;
  profissao?: string | null; email?: string | null; telefone?: string | null; duvida?: string | null;
  /** Itens do questionário NOVO do Inter (Fabio 12/11, Alice): carência de 90 dias, conta Inter (agência/conta; semConta = disse que não tem). */
  carencia?: 'SIM' | 'NAO' | null; conta?: string | null; semConta?: boolean | null;
  enviadoAt?: string; enderecoEnviadoAt?: string; erro?: string | null; tentouAt?: string; remetente?: string;
};

/** O que o e-mail do consultor pergunta além do questionário de sempre (Fabio 12/11: o questionário da Alice trouxe carência de 90 dias, conta Inter,
 *  imóvel quitado e documento com QR Code / CNH digital — o CRM só perguntava vencimento, despesas e dados). Pura (testável). */
export type ExtrasQ = { carencia: boolean; conta: boolean; quitado: boolean; cnh: boolean };
export function extrasDoEmail(text: string | null | undefined): ExtrasQ {
  const t = String(text || '');
  return {
    carencia: /car[eê]ncia/i.test(t),
    conta: /conta\s+(do\s+|no\s+)?inter\b|correntista/i.test(t),
    quitado: /quitad[oa]|saldo\s+em\s+aberto/i.test(t),
    cnh: /QR\s*-?\s*Code|CNH\s+digital/i.test(t),
  };
}
const SEM_EXTRAS: ExtrasQ = { carencia: false, conta: false, quitado: false, cnh: false };

/** Extras do e-mail do questionário deste card (lê a parte nova do e-mail do consultor). */
async function extrasDoQuestionario(q: Q): Promise<ExtrasQ> {
  if (!q.emailId) return SEM_EXTRAS;
  const em = await prisma.emailMessage.findUnique({ where: { id: q.emailId }, select: { textBody: true, htmlBody: true } }).catch(() => null);
  if (!em) return SEM_EXTRAS;
  const { interEmailTexto, freshPart } = require('./inter-email.service') as typeof import('./inter-email.service');
  return extrasDoEmail(freshPart(interEmailTexto(em.textBody, em.htmlBody)));
}

// ─── Valor liberado MENOR que o pedido (Fabio 12/11: "quando vier valor menor e for menor que o solicitado, colocar no e-mail o valor que a cliente precisa e pedir pra
//     revisar o valor. Lembrando da cota de 60% sobre o valor de avaliação") ───
const COTA_AVALIACAO = 0.6;
const brl = (n: number) => `R$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const numBr = (s: string | null | undefined) => { const v = Number(String(s || '').replace(/\./g, '').replace(',', '.')); return Number.isFinite(v) && v > 0 ? v : null; };

/** Quanto pedir na revisão: o que o cliente precisa, limitado a 60% da avaliação. null = não há o que pedir (liberou o pedido, ou o liberado já é o teto). Pura. */
export function revisaoDeValor(p: { liberado: number | null; solicitado: number | null; avaliacao: number | null }): { alvo: number; teto: number | null } | null {
  const { liberado, solicitado, avaliacao } = p;
  if (!liberado || !solicitado || liberado >= solicitado - 1) return null;
  const teto = avaliacao ? Math.floor(avaliacao * COTA_AVALIACAO) : null;
  const alvo = teto ? Math.min(solicitado, teto) : solicitado;
  return alvo > liberado + 1 ? { alvo, teto } : null;
}

/** Parágrafo do e-mail pedindo a revisão. Pura. */
export function textoRevisaoValor(p: { liberado: number; solicitado: number; avaliacao: number | null; alvo: number; teto: number | null; oa: 'a' | 'o' }): string {
  const cota = p.teto && p.avaliacao ? ` Pela cota de 60% da avaliação do imóvel (${brl(p.avaliacao)}), cabe até ${brl(p.teto)}.` : '';
  return `Só um ponto sobre o valor: o valor liberado veio de ${brl(p.liberado)}, mas ${p.oa} cliente precisa de ${brl(p.solicitado)}.${cota} Conseguem revisar o valor para ${brl(p.alvo)}${cota ? '' : ', dentro da cota de 60% da avaliação do imóvel'}?`;
}

/** Liberado (texto do e-mail), pedido (card) e avaliação: o e-mail, o campo "Avaliação do imóvel" do card ou — no Inter, depois da vistoria — o "Valor estimado do imóvel"
 *  da simulação anexa (Marli 12/11: rodamos com R$ 200 mil, a simulação pós-vistoria veio com R$ 185 mil, que é o do laudo). */
async function valoresDoEmail(acc: any, row: { uid: number | null; folder: string; textBody: string | null; htmlBody: string | null }, cf: Cf, leadId: string) {
  const { interEmailTexto, freshPart } = require('./inter-email.service') as typeof import('./inter-email.service');
  const texto = freshPart(interEmailTexto(row.textBody, row.htmlBody));
  const liberado = numBr((/valor\s+(?:liberado|aprovado)\s*:?\s*R\$\s*([\d.]+,\d{2})/i.exec(texto) || [])[1]);
  let avaliacao = numBr((/(?:valor\s+de\s+avalia[cç][aã]o|avalia[cç][aã]o\s+do\s+im[oó]vel|avaliado\s+em)[^R\n]{0,40}R\$\s*([\d.]+,\d{2})/i.exec(texto) || [])[1]);
  let fonte = avaliacao ? 'e-mail do banco' : '';
  if (!avaliacao && Number(cf.valor_de_avaliacao) > 0) { avaliacao = Number(cf.valor_de_avaliacao); fonte = 'card'; }
  const vc = String(cf.valor_credito ?? '').trim();
  let solicitado = /,\d{1,2}$/.test(vc) ? numBr(vc.replace(/[^\d.,]/g, '')) : Number(vc.replace(/[^\d.]/g, '')) || null; // "80000" ou "80.000,00"
  if (!solicitado) solicitado = (await prisma.creditAnalysis.findFirst({ where: { leadId, bank: 'INTER', kind: 'RUN', dryRun: false, requestedValue: { not: null } }, orderBy: { createdAt: 'desc' }, select: { requestedValue: true } }).catch(() => null))?.requestedValue || null;
  if (!avaliacao && liberado && solicitado && liberado < solicitado - 1) {
    try {
      const { getEmailAttachments } = require('./email-inbox.service') as typeof import('./email-inbox.service');
      const pdfParse = require('pdf-parse') as (b: Buffer, o?: any) => Promise<{ text: string }>;
      for (const a of (await getEmailAttachments(acc, row, { max: 3 })).filter((x) => x.kind === 'pdf')) {
        const m = /Valor\s*estimado\s*do\s*im[oó]vel\s*:?\s*(?:R\$\s*)?([\d.]+,\d{2})/i.exec((await pdfParse(Buffer.from(a.base64, 'base64'), { max: 1 })).text);
        if (m && numBr(m[1])) { avaliacao = numBr(m[1]); fonte = 'simulação anexa ao e-mail'; break; }
      }
    } catch (e: any) { console.warn('[Questionário Inter] avaliação na simulação anexa:', e?.message); }
  }
  return { liberado, solicitado, avaliacao, fonte };
}

/** Erro de login no envio (Titan suspendeu o comercial@ em 09/11: o SMTP responde 535 com a senha certa). */
const ERRO_LOGIN = /\b535\b|invalid login|authentication failed|EAUTH/i;
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

/** Perguntas dos itens novos (o mesmo texto que o Fabio aprovou pra Marli em 12/11). `cnh` só quando a pasta não tem CNH. */
function perguntasExtras(ex: Partial<ExtrasQ>): string[] {
  const l: string[] = [];
  if (ex.carencia) l.push('Você quer carência de 90 dias pra começar a pagar? Com a carência, a 1ª parcela vem 90 dias depois da liberação; sem ela, vem a partir de 30 dias.');
  if (ex.conta) l.push('Você tem conta no Inter? Se tiver, me passa a agência e o número da conta. Se não tiver, precisa abrir pelo app do Inter, porque o banco pede essa conta pra seguir com o contrato.');
  if (ex.cnh) l.push('Você tem CNH digital? Se tiver, me manda o PDF dela (do app Carteira Digital de Trânsito). Se não tiver, é só me avisar.');
  return l;
}

export function textoPergunta(nome: string, d: Dados, pedirCivil: boolean, ex: Partial<ExtrasQ> = {}): string {
  const l = [`${nome ? `${nome}, a` : 'A'} vistoria do seu imóvel foi concluída e o seu processo seguiu para a contratação! 🎉`, '', 'Pra eu passar ao banco, preciso que você me confirme:', ''];
  let n = 0;
  l.push(`${++n}. Qual o melhor dia pro vencimento das parcelas: 1, 5, 10, 15 ou 20?`);
  l.push(`${++n}. Você quer incluir as despesas do registro do contrato no empréstimo? Funciona como um reembolso: você paga o registro no cartório e o banco te devolve esse valor junto com o crédito.`);
  const tem = [d.email && `e-mail ${d.email}`, d.telefone && `telefone ${d.telefone}`, d.profissao && `profissão ${d.profissao}`].filter(Boolean) as string[];
  const pede = [!d.email && 'o seu e-mail', !d.telefone && 'o seu telefone', !d.profissao && 'a sua profissão'].filter(Boolean) as string[];
  if (tem.length) l.push(`${++n}. Seus dados estão certos? ${tem.join(', ').replace(/^./, (c) => c.toUpperCase())}.${pede.length ? ` E qual é ${lista(pede)}?` : ''}`);
  else l.push(`${++n}. Qual é ${lista(pede)}?`);
  if (pedirCivil) l.push(`${++n}. Uma foto da sua certidão de nascimento (se for solteiro) ou de casamento (se for casado, divorciado ou viúvo). Pode ser a que você tiver, mesmo antiga.`);
  for (const p of perguntasExtras(ex)) l.push(`${++n}. ${p}`);
  l.push('', 'A assinatura do contrato vai ser digital. 🙂');
  return l.join('\n');
}

export type FaltaQ = 'vencimento' | 'despesas' | 'profissao' | 'contato' | 'confirmar' | 'carencia' | 'conta';
export function faltasDoQuestionario(q: Q, d: Dados, ex: Partial<ExtrasQ> = {}): FaltaQ[] {
  const f: FaltaQ[] = [];
  if (!q.vencimento || !VENCIMENTOS.includes(Number(q.vencimento))) f.push('vencimento');
  if (q.despesas !== 'SIM' && q.despesas !== 'NAO') f.push('despesas');
  if (ex.carencia && q.carencia !== 'SIM' && q.carencia !== 'NAO') f.push('carencia');
  if (ex.conta && vazio(q.conta)) f.push('conta'); // sem conta no Inter: o cliente abre pelo app e manda a agência/conta — o e-mail espera
  if (!d.profissao) f.push('profissao');
  if (!d.email || !d.telefone) f.push('contato');
  else if (q.dadosOk !== true && vazio(q.profissao) && vazio(q.email) && vazio(q.telefone)) f.push('confirmar');
  return f;
}

export function textoCobranca(nome: string, faltas: FaltaQ[], d: Dados, q: Q = {}): string {
  const t: Record<FaltaQ, string> = {
    vencimento: 'o dia do vencimento das parcelas (1, 5, 10, 15 ou 20)',
    despesas: 'se quer incluir as despesas do registro no empréstimo (funciona como reembolso: você paga o cartório e o banco te devolve junto com o crédito)',
    profissao: 'a sua profissão',
    contato: [!d.email && 'o seu e-mail', !d.telefone && 'o seu telefone'].filter(Boolean).join(' e ') || 'o seu e-mail e telefone',
    confirmar: `se o e-mail ${d.email} e o telefone ${d.telefone} estão certos`,
    carencia: 'se quer carência de 90 dias pra começar a pagar (com ela, a 1ª parcela vem 90 dias depois da liberação; sem ela, a partir de 30 dias)',
    conta: q.semConta ? 'a agência e o número da sua conta no Inter, assim que abrir pelo app' : 'a agência e o número da sua conta no Inter (se não tiver, precisa abrir pelo app do Inter)',
  };
  return `${nome ? `${nome}, o` : 'O'}brigado! Pra fechar com o banco, só falta me dizer ${lista(faltas.map((x) => t[x]))}.`;
}

export function corpoEmailQuestionario(p: { consultor: string; q: Q; d: Dados; endereco: string | null; zeev: { nome: string; cpf: string; email: string }; pede?: Partial<ExtrasQ>; quitado?: boolean | null; revisao?: string | null; oa?: 'a' | 'o' }): string {
  const { q, d } = p;
  const ex = p.pede || {};
  const imovel = p.quitado === true ? 'Quitado' : p.quitado === false ? 'Possui saldo em aberto (envio a planilha de evolução do empréstimo em seguida)' : '(confirmo em seguida)';
  return [
    `Olá, ${p.consultor || 'tudo bem'}${p.consultor ? ', tudo bem?' : '?'}`,
    '',
    `Sim, ${p.oa || 'o'} cliente aceita prosseguir com a contratação. Seguem as informações:`,
    '',
    ...(p.revisao ? [p.revisao, ''] : []),
    'QUESTIONÁRIO:',
    `• Data de vencimento das parcelas: dia ${q.vencimento}`,
    ...(ex.carencia ? [`• Carência de 90 dias para iniciar o pagamento das parcelas: ${q.carencia === 'SIM' ? 'Sim' : 'Não'}`] : []),
    ...(ex.conta ? [`• Conta Inter: ${String(q.conta || '').trim()}`] : []),
    ...(ex.quitado ? [`• Imóvel quitado ou com saldo em aberto: ${imovel}`] : []),
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

/** Endereço dos proponentes = o do imóvel: o campo "Endereço do imóvel" do card (preenchido sozinho pela documentação — endereco-imovel.service) ou, sem ele,
 *  proposta/documentos/CEP do card. */
async function enderecoTexto(leadId: string, cf: Cf): Promise<string | null> {
  if (!vazio(cf.endereco_imovel)) return String(cf.endereco_imovel).trim();
  const { enderecoDoImovelInfo } = require('./endereco-imovel.service') as typeof import('./endereco-imovel.service');
  return (await enderecoDoImovelInfo(leadId, cf).catch(() => null))?.texto || null;
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
  const nome = callableFirstName(cf.falando_com, cf.nome_social_1, cf.participante_1, lead.name) || '';
  if (!(await whatsappWindowOpen(leadId))) {
    if (q.templateAt) return false;
    // template de atualização já saiu hoje (equipe/Jarvis/supervisão): não repete
    const recente = await prisma.message.findFirst({ where: { leadId, direction: 'OUTBOUND', createdAt: { gt: new Date(Date.now() - 20 * 3600_000) }, content: { contains: 'Temos uma atualização sobre o seu processo' } }, select: { id: true } });
    let ok = !!recente;
    if (!recente) {
      const { sendOutboundWhatsAppTemplate } = require('./message.service') as typeof import('./message.service');
      const n = nome || 'cliente';
      const t = await sendOutboundWhatsAppTemplate({ accountId, leadId, ...(await templateAtualizacaoDoLead(leadId, n)), io: io as any });
      ok = t.success;
      if (!t.success) await note(leadId, `📝 Questionário do Inter: a conversa está fechada e o template de atualização não saiu (${t.error}). Pergunte ao cliente o vencimento, as despesas de registro e confirme profissão/e-mail/telefone.`);
    }
    await salva(leadId, { templateAt: new Date().toISOString() });
    if (ok) await note(leadId, `📝 Questionário do Inter: a conversa estava fechada — ${recente ? 'o template de atualização já tinha saído hoje' : 'mandei o template de atualização'}. Quando o cliente responder, o CRM pergunta o vencimento, as despesas de registro e confirma os dados.`);
    return false;
  }
  const d = dadosDoTitular(cf, lead.name, q);
  // Documento nunca vai no pedido ao cliente sem o Fabio (31/10) — falta da certidão vira aviso pra equipe.
  const docs = docsDoTitular(await arquivosDoDrive(accountId, cf));
  const semCivil = !docs.civil.length;
  // Itens que o consultor pediu além do de sempre (Fabio 12/11): carência, conta Inter e, se a pasta não tem CNH, a CNH digital (documento com QR Code).
  const ex = await extrasDoQuestionario(q);
  const exPergunta: ExtrasQ = { ...ex, cnh: ex.cnh && !docs.ident.some((f) => /^CNH\b/.test(norm(f.name))) };
  const r = await sendOutboundWhatsApp({ accountId, leadId, content: textoPergunta(nome, d, false, exPergunta), io });
  if (!r.success) return false;
  await salva(leadId, { status: 'PERGUNTADO', askedAt: new Date().toISOString() });
  const extrasTxt = [exPergunta.carencia && 'a carência de 90 dias', exPergunta.conta && 'a conta Inter', exPergunta.cnh && 'a CNH digital'].filter(Boolean) as string[];
  await note(leadId, `📝 Questionário do Inter: perguntei ao cliente o dia do vencimento, se financia as despesas de registro${extrasTxt.length ? `, ${lista(extrasTxt)}` : ''} e confirmei profissão/e-mail/telefone. Assinatura digital, sem ICP-Brasil e registro eletrônico vão fixos. Com as respostas, o CRM responde o e-mail do Inter sozinho.${semCivil ? '\n⚠️ A certidão de estado civil não está na pasta (a Zeev vai precisar) — o CRM não pediu ao cliente; peça se quiser.' : ''}`);
  if (semCivil) { const { sendPushToAccount } = require('./push.service') as typeof import('./push.service'); sendPushToAccount(accountId, { title: '📝 Questionário Inter: falta certidão', body: 'A certidão de estado civil não está na pasta — pedir ao cliente?', leadId }).catch(() => {}); }
  return true;
}

const SYSTEM_Q = `Você lê a conversa de WhatsApp (Atendente = nós; Cliente = o cliente) em que o cliente responde às perguntas da contratação do empréstimo: (1) dia do vencimento das parcelas — só 1, 5, 10, 15 ou 20; (2) se quer incluir/financiar as despesas do registro no cartório (funciona como reembolso); (3) se os dados dele (e-mail, telefone, profissão) estão certos, ou a correção; e, quando o Atendente perguntou, (4) se quer carência de 90 dias pra começar a pagar e (5) a conta dele no Inter (agência e número). Extraia SÓ o que o CLIENTE disse (nunca invente; o que o Atendente escreveu não é resposta) e responda SOMENTE com JSON:
{"vencimento":null,"despesas":null,"dadosOk":null,"profissao":null,"email":null,"telefone":null,"carencia":null,"conta":null,"semConta":null,"duvida":null}
Regras: "vencimento" é número (1, 5, 10, 15 ou 20); dia fora da lista → null e diga em "duvida". "despesas": "SIM" se ele quer incluir/financiar ("sim", "quero", "pode incluir"), "NAO" se não quer; sem resposta → null. "dadosOk": true se ele disse que os dados estão certos ("tudo certo", "isso mesmo", "confirmo", "correto"); false se disse que algo está errado. Se ele informou ou corrigiu profissão, e-mail ou telefone, preencha o campo (telefone só dígitos com DDD). "carencia": "SIM" se quer a carência de 90 dias, "NAO" se não quer (ex.: "não precisa", "quero pagar logo"); sem resposta → null. "conta": agência e número da conta no Inter como ele escreveu (ex.: "agência 0001, conta 12345678-9"); só o que ele mandou. "semConta": true se ele disse que NÃO tem conta no Inter (ou que ainda vai abrir); false se disse que tem; sem resposta → null. A CNH digital chega como arquivo: ignore. "duvida": pergunta ou dúvida que ele fez, em poucas palavras; sem dúvida → null. Respostas numeradas ("1- 10, 2- sim, 3- ok") seguem a ordem das perguntas da mensagem do Atendente logo antes delas.`;

async function lerResposta(leadId: string, desde: Date): Promise<Record<string, any> | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  // Com as perguntas do Atendente no meio (Fabio 12/11: perguntas novas mandadas depois da 1ª lista) — "1. não" só se entende com a pergunta de antes.
  const msgs = await prisma.message.findMany({ where: { leadId, channel: 'WHATSAPP', createdAt: { gt: desde } }, orderBy: { createdAt: 'asc' }, take: 40, select: { content: true, direction: true } });
  if (!msgs.some((m) => m.direction === 'INBOUND' && m.content?.trim() && !/^📎/.test(m.content.trim()))) return null;
  const texto = msgs.filter((m) => m.content && m.content.trim() && !/^📎/.test(m.content.trim())).map((m) => `${m.direction === 'INBOUND' ? 'Cliente' : 'Atendente'}: ${m.content.trim()}`).join('\n---\n').slice(-8000);
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
  if (novo.carencia === 'SIM' || novo.carencia === 'NAO') patch.carencia = novo.carencia;
  if (!vazio(novo.conta)) patch.conta = String(novo.conta).trim().slice(0, 120);
  if (typeof novo.semConta === 'boolean') patch.semConta = novo.semConta;
  if (!vazio(novo.duvida)) patch.duvida = String(novo.duvida).trim().slice(0, 200);
  // Só grava/avisa o que MUDOU: a leitura relê a conversa toda desde a pergunta e devolve de novo o que já estava gravado.
  for (const k of Object.keys(patch) as (keyof Q)[]) if (k !== 'lidoAt' && JSON.stringify(patch[k]) === JSON.stringify(q[k])) delete patch[k];
  await salva(leadId, patch);
  const q2: Q = { ...q, ...patch };
  const d = dadosDoTitular(cf, lead.name, q2);
  const ex = await extrasDoQuestionario(q2);
  const faltas = faltasDoQuestionario(q2, d, ex);
  const leuAlgo = ['vencimento', 'despesas', 'dadosOk', 'profissao', 'email', 'telefone', 'carencia', 'conta', 'semConta'].some((k) => k in patch);
  if (leuAlgo || patch.duvida) {
    const linhas = [
      patch.vencimento && `Vencimento: dia ${patch.vencimento}`,
      patch.despesas && `Financiar despesas de registro: ${patch.despesas === 'SIM' ? 'Sim' : 'Não'}`,
      patch.carencia && `Carência de 90 dias: ${patch.carencia === 'SIM' ? 'Sim' : 'Não'}`,
      patch.conta && `Conta Inter: ${patch.conta}`,
      patch.semConta === true && !q2.conta && 'Não tem conta no Inter (precisa abrir pelo app)',
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
  const r = await sendOutboundWhatsApp({ accountId, leadId, content: textoCobranca(callableFirstName(cf.falando_com, cf.nome_social_1, cf.participante_1, lead.name) || '', faltas, d, q2), io });
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
  const pede = await extrasDoQuestionario(q);
  const duras = faltasDoQuestionario(q, d, pede).filter((f) => f !== 'confirmar');
  if (duras.length) return { ok: false, erro: `Falta: ${duras.join(', ')}` };
  const row = q.emailId ? await prisma.emailMessage.findUnique({ where: { id: q.emailId }, select: { id: true, emailAccountId: true, fromAddress: true, fromName: true, subject: true, toList: true, ccList: true, uid: true, folder: true, textBody: true, htmlBody: true } }) : null;
  const acc = row ? await prisma.emailAccount.findUnique({ where: { id: row.emailAccountId } }) : null;
  const dono = await prisma.user.findFirst({ where: { accountId, role: 'ADMIN' }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  if (!row || !acc || !row.fromAddress) return { ok: false, erro: 'E-mail do Inter não encontrado' };
  const zeev = zeevResponsavel();
  const oa: 'a' | 'o' = /^f/i.test(String(cf.genero_1 || '')) ? 'a' : 'o';
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
  const quitado = pede.quitado ? (await (require('./saldo-devedor.service') as typeof import('./saldo-devedor.service')).proposalFinancing(leadId).catch(() => null))?.quitado ?? null : null;
  const valores = await valoresDoEmail(acc, row, cf, leadId).catch(() => null);
  const rev = valores ? revisaoDeValor(valores) : null;
  const revisao = rev && valores ? textoRevisaoValor({ liberado: valores.liberado!, solicitado: valores.solicitado!, avaliacao: valores.avaliacao, alvo: rev.alvo, teto: rev.teto, oa }) : null;
  // Liberou menos que o pedido mas já no teto de 60% da avaliação: não pede revisão, só avisa a equipe na nota.
  const noTeto = !rev && valores?.liberado && valores.solicitado && valores.liberado < valores.solicitado - 1
    ? `\n💰 Liberado ${brl(valores.liberado)} (pedido ${brl(valores.solicitado)}): ${valores.avaliacao ? `já é o teto de 60% da avaliação (${brl(valores.avaliacao)}, ${valores.fonte}) — não pedi revisão` : 'não pedi revisão'}.` : '';
  const corpo = corpoEmailQuestionario({ consultor: PRIMEIRO_NOME(row.fromName), q, d, endereco, zeev, pede, quitado, revisao, oa });
  // Um envio por vez (a leitura das respostas e a nova tentativa do poller podem chegar juntas).
  if (!opts.forcar) {
    const pego = await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set("customFields", '{_interQuest,enviandoAt}', to_jsonb(${new Date().toISOString()}::text), true)
      WHERE id = ${leadId} AND COALESCE("customFields"->'_interQuest'->>'status', '') <> 'ENVIADO'
        AND COALESCE(("customFields"->'_interQuest'->>'enviandoAt')::timestamptz, 'epoch'::timestamptz) < now() - interval '3 minutes'`;
    if (!pego) return { ok: false, erro: 'Envio em andamento' };
  }
  const { sendEmailFrom } = require('./email-inbox.service') as typeof import('./email-inbox.service');
  const enviar = (conta: typeof acc, comCopia: string[]) => sendEmailFrom({
    acc: conta, userId: dono?.id || null, to: [row.fromAddress!], cc: [...new Set([...cc, ...comCopia])].filter((a) => a !== conta.address.toLowerCase()),
    subject: /^re:/i.test(sub) ? sub : `Re: ${sub}`, body: corpo, replyToId: row.id, leadId, io: (io || ({ to: () => ({ emit: () => {} }) })) as any,
  });
  const falhou = async (msg: string) => {
    if (q.erro !== msg.slice(0, 200)) { // a nova tentativa do poller não repete nota/push do mesmo erro
      await note(leadId, `⚠️ Questionário do Inter: o e-mail de resposta não saiu (${msg}). Responda à mão.`);
      push(accountId, '⚠️ Questionário do Inter não saiu', lead.name, leadId);
    }
    await salva(leadId, { erro: msg.slice(0, 200), tentouAt: new Date().toISOString(), enviandoAt: null } as any);
    return { ok: false, erro: msg };
  };
  let via = acc.address;
  let copias: string[] = [];
  try {
    await enviar(acc, []);
  } catch (e: any) {
    const msg = String(e?.message || e);
    // CAIXA RESERVA (Fabio 12/11: "do Fabio, cópias para Andreia e Vania — isso é temporário enquanto o e-mail comercial não volta"): o comercial@ está suspenso no Titan
    // (535 com a senha certa) → a mesma resposta sai pela caixa pessoal do 1º admin, no mesmo fio, com cópia pros nossos endereços que estavam no e-mail do banco (Andreia)
    // e pro responsável da Zeev. Volta sozinho pro comercial@ quando ele voltar a enviar (a reserva só entra no erro de login).
    const reserva = ERRO_LOGIN.test(msg) && dono ? await prisma.emailAccount.findFirst({ where: { accountId, userId: dono.id, NOT: { id: acc.id } }, orderBy: { createdAt: 'asc' } }) : null;
    if (!reserva) return falhou(msg);
    const dominio = proprio.split('@')[1] || '';
    copias = [...new Set([...(Array.isArray(row.toList) ? row.toList : []), ...(Array.isArray(row.ccList) ? row.ccList : [])].map((a: any) => String(a?.address || '').toLowerCase())
      .filter((a) => a && a !== proprio && dominio && a.endsWith(`@${dominio}`)).concat(zeev.email ? [zeev.email.toLowerCase()] : []))];
    try { await enviar(reserva, copias); via = reserva.address; } catch (e2: any) { return falhou(`${msg} — e pela caixa reserva ${reserva.address}: ${e2?.message || e2}`); }
  }
  await salva(leadId, { status: 'ENVIADO', enviadoAt: new Date().toISOString(), erro: null, remetente: via } as any);
  const extrasTxt = [
    pede.carencia && `carência de 90 dias: ${q.carencia === 'SIM' ? 'sim' : 'não'}`,
    pede.conta && `conta Inter ${q.conta}`,
    pede.quitado && `imóvel ${quitado === true ? 'quitado' : quitado === false ? 'com saldo em aberto (falta mandar a planilha de evolução do empréstimo)' : 'sem informação (confirmar com o banco)'}`,
  ].filter(Boolean).join(', ');
  const reservaTxt = via !== acc.address ? `\n📤 Saiu pelo ${via} (o ${acc.address} está com erro de login no envio), com cópia pra ${[...cc, ...copias].filter((a) => a !== via).join(', ') || 'ninguém'}.` : '';
  const revisaoTxt = rev && valores ? `\n💰 Pedi revisão do valor pra ${brl(rev.alvo)}: liberado ${brl(valores.liberado!)}, pedido ${brl(valores.solicitado!)}${valores.avaliacao ? `, avaliação ${brl(valores.avaliacao)} (${valores.fonte}) → teto de 60% ${brl(rev.teto!)}` : ' (avaliação não informada)'}.` : noTeto;
  await note(leadId, `📨 Questionário do Inter respondido por e-mail a ${row.fromAddress}: vencimento dia ${q.vencimento}, despesas de registro ${q.despesas === 'SIM' ? 'financiadas' : 'não financiadas'}${extrasTxt ? `, ${extrasTxt}` : ''}, assinatura digital (sem ICP-Brasil), registro eletrônico, responsável na Zeev ${zeev.nome}, endereço ${endereco}. Os documentos sobem pelo portal Zeev.${reservaTxt}${revisaoTxt}`);
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
        // Envio que falhou por erro de login (comercial@ suspenso, 12/11): tenta de novo a cada 10 min — sai pela caixa reserva assim que as respostas estiverem completas.
        if (q.erro && ERRO_LOGIN.test(q.erro)) { if (faz(q.tentouAt || q.lidoAt) > 10 * 60_000) { await salva(id, { tentouAt: new Date().toISOString() }); await enviarEmailQuestionario(accountId, id, io); } continue; }
        if (!q.cobrouAt || faz(q.cobrouAt) < CONFIRMA_ESPERA_MS) continue;
        const f = faltasDoQuestionario(q, dadosDoTitular((lead.customFields || {}) as Cf, lead.name, q), await extrasDoQuestionario(q));
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
  const pede = await extrasDoQuestionario(q);
  return { estado: q, dados: d, pede, faltas: faltasDoQuestionario(q, d, pede), documentosNaPasta: [...docs.ident, ...docs.civil].map((f) => nomeDoAnexo(f, d.nome, vazio(cf.participante_2))), endereco: await enderecoTexto(leadId, cf) };
}

/** Início manual (e-mail que já tinha chegado antes do fluxo existir): acha o e-mail do questionário ligado ao card. */
export async function iniciarManual(accountId: string, leadId: string, io?: Io, jaPerguntadoEm?: string): Promise<Q | null> {
  const { vistoriaConcluida, interEmailTexto } = require('./inter-email.service') as typeof import('./inter-email.service');
  const rows = await prisma.emailMessage.findMany({ where: { leadId, folder: 'INBOX', emailAccount: { accountId } }, orderBy: { date: 'desc' }, take: 15, select: { id: true, textBody: true, htmlBody: true } });
  const row = rows.find((r) => { const t = interEmailTexto(r.textBody, r.htmlBody); return pedeQuestionarioContratacao(t) && vistoriaConcluida(t); });
  if (!row) throw new Error('Não achei o e-mail do Inter com o questionário ligado a este card');
  return iniciarQuestionarioInter(accountId, leadId, row.id, io, { manual: true, jaPerguntadoEm });
}
