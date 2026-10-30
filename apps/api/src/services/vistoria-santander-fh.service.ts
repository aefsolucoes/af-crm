import { prisma } from '../lib/prisma';
import { sendOutboundMedia, sendOutboundWhatsApp } from './message.service';
import { avisaCndSeFalta, VISTORIA_SANTANDER_TO } from './vistoria-santander.service';
import { dadosFichaFh, inspecionarRetornoFh, preencherAutorizacaoFh, preencherDeclaracaoSaude, preencherFichaFh, type CompradorFh, type ContaCredito, type ImovelFh, type PessoaFicha, type SeguroFh } from './santander-fh-forms';

type Io = Parameters<typeof sendOutboundMedia>[0]['io'];

/**
 * VISTORIA NO FINANCIAMENTO (Fabio 30/10).
 *  A) CONTATO DA VISTORIA (Inter e Santander): "o CRM pode perguntar ao cliente o contato do corretor para solicitar a vistoria, ou se tem o contato do vendedor". No Santander a mesma mensagem
 *     pede o que a ficha precisa e só o cliente sabe: e-mail, telefone, profissão e conta para crédito do vendedor (e o que faltar dos compradores/do imóvel). A resposta é lida por IA (Haiku) e vai pro card.
 *  B) SANTANDER (Credimorar): 3 formulários. Autorização + Declaração de Saúde (PDF) → cliente assina pelo gov.br; Ficha para cadastro (Word) → só preenchida. As respostas da declaração de
 *     saúde vêm do CLIENTE: o CRM manda a lista padrão e só marca se ele responder CONFIRMO (outra resposta → a equipe preenche à mão). Com os 2 PDFs assinados de volta, o e-mail vai à Letícia
 *     com: certidão de matrícula, CND de IPTU; dos compradores RG/CNH, comprovante de residência e certidão de estado civil; do vendedor RG/CNH, certidão de estado civil e a conta para crédito;
 *     e-mail, telefone e profissão de todos. Card → "Vistoria do Imóvel".
 * Estado: customFields._vistoriaDadosFh (pedido dos dados) + _dadosVistoriaFh (o que o cliente respondeu) e _vistoriaSantFh (fluxo do Santander).
 */

const AVISO_REPETIR_MS = 12 * 3600_000;
const MARCA_DADOS = 'agendar a vistoria do imóvel';
const MARCA_SAUDE = 'declaração de saúde do seguro habitacional';
/** Seguradora marcada na declaração (o modelo pede "de acordo com a Seguradora da sua Simulação"). */
const SEGURO: SeguroFh = (process.env.SANTANDER_FH_SEGURO === 'SANTANDER_AUTO' ? 'SANTANDER_AUTO' : 'ZURICH');

type Cf = Record<string, any>;
type DadosSt = { askedAt?: string; banco?: string; itens?: string[]; teamNoteAt?: string; lidoAt?: string; completoAt?: string; cobrouAt?: string };
type Dados = { contato?: { nome?: string; telefone?: string; papel?: string }; vendedor?: { email?: string; telefone?: string; profissao?: string }; conta?: ContaCredito;
  compradores?: { profissao?: string; email?: string }[]; imovel?: ImovelFh };
type St = { status?: string; autAskedAt?: string; saudeAskAt?: string; saudeResp?: 'PADRAO' | 'OUTRA'; saudeRespText?: string; saudeSentAt?: string; saudeEquipeAt?: string;
  autSignedAt?: string; autSignedName?: string; saudeSignedAt?: string; saudeSignedName?: string; faltaNoteAt?: string; teamAskNoteAt?: string; semAssinaturaNoteAt?: string;
  sentAt?: string; to?: string; erro?: string; prontaNoteAt?: string; startedByTeam?: boolean; fichaTentouAt?: string };

const note = (leadId: string, content: string) => prisma.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});
const push = (accountId: string, title: string, body: string, leadId: string) => { try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title, body, leadId }).catch(() => {}); } catch { /* aviso */ } };
const faz = (iso?: string) => (iso ? Date.now() - new Date(iso).getTime() : Infinity);
const norm = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const vazio = (v: unknown) => v === undefined || v === null || String(v).trim() === '';

async function patchCf(leadId: string, fn: (cf: Cf) => void) {
  const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cf = { ...((fresh?.customFields || {}) as Cf) };
  fn(cf);
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: cf as any } });
}
const salvaSt = (leadId: string, patch: Partial<St>) => patchCf(leadId, (cf) => { cf._vistoriaSantFh = { ...(cf._vistoriaSantFh || {}), ...patch }; });
const salvaDadosSt = (leadId: string, patch: Partial<DadosSt>) => patchCf(leadId, (cf) => { cf._vistoriaDadosFh = { ...(cf._vistoriaDadosFh || {}), ...patch }; });

// ─── Quem são os compradores (ficha cadastral lida dos documentos, senão o card) ───
function compradoresDe(cf: Cf, leadName: string): (PessoaFicha & { ordem: number })[] {
  const ficha = (cf._fichaCadastral?.participantes || []) as any[];
  const extra = ((cf._dadosVistoriaFh || {}) as Dados).compradores || [];
  const out: (PessoaFicha & { ordem: number })[] = [];
  for (const n of [1, 2]) {
    const f = ficha.find((p) => Number(p.ordem) === n) || (n === 1 ? ficha[0] : ficha[1]) || {};
    const nome = f.nome || cf[`participante_${n}`] || (n === 1 ? leadName : '');
    if (!nome) continue;
    out.push({ ...f, ordem: n, nome, cpf: f.cpf || cf[`cpf_${n}`] || '', nascimento: f.nascimento || cf[`nascimento_${n}`] || '',
      telefone: cf[`telefone_${n}`] || f.telefone || null, email: cf[`email_${n}`] || extra[n - 1]?.email || null,
      profissao: f.profissao || f.trabalho?.cargo || cf[`profissao_${n}`] || extra[n - 1]?.profissao || null });
  }
  return out;
}

// ─── A) Pedido dos dados da vistoria ao cliente ───
/** O que falta saber pelo cliente. Pura nos dados. */
export function itensDoPedido(banco: 'Inter' | 'Santander', cf: Cf, compradores: PessoaFicha[], temEnderecoImovel: boolean): string[] {
  const d = (cf._dadosVistoriaFh || {}) as Dados;
  const itens: string[] = [];
  if (vazio(cf.contato_vistoria) && vazio(d.contato?.telefone)) itens.push('contato');
  if (banco !== 'Santander') return itens;
  if (vazio(d.vendedor?.email) || vazio(d.vendedor?.telefone) || vazio(d.vendedor?.profissao)) itens.push('vendedor');
  if (vazio(d.conta?.banco) || vazio(d.conta?.agencia) || vazio(d.conta?.conta)) itens.push('conta');
  if (compradores.some((c) => vazio(c.profissao) || vazio(c.email))) itens.push('comprador');
  if (!temEnderecoImovel) itens.push('imovel');
  return itens;
}

export function textoPedidoDados(nome: string, itens: string[], doisCompradores: boolean): string {
  const l: string[] = [`${nome ? `${nome}, pra` : 'Pra'} ${MARCA_DADOS} preciso de algumas informações:`, ''];
  let n = 0;
  if (itens.includes('contato')) l.push(`${++n}. O contato de quem vai receber o engenheiro no imóvel: se tiver corretor, o nome e o telefone do corretor; se não, o nome e o telefone do vendedor`);
  if (itens.includes('vendedor')) l.push(`${++n}. Do vendedor: e-mail, telefone e profissão`);
  if (itens.includes('conta')) l.push(`${++n}. A conta do vendedor pra receber o valor: banco, agência, conta (com dígito) e se é corrente ou poupança, e o nome do titular`);
  if (itens.includes('comprador')) l.push(`${++n}. ${doisCompradores ? 'A profissão e o e-mail de cada comprador' : 'Sua profissão e seu e-mail'}`);
  if (itens.includes('imovel')) l.push(`${++n}. O endereço completo do imóvel (rua, número, complemento, bairro e CEP) e se é casa ou apartamento`);
  l.push('', 'Pode mandar tudo numa mensagem só, do jeito que for mais fácil. 🙂');
  return l.join('\n');
}

/** Pede ao cliente (uma vez) o contato da vistoria e, no Santander, os dados da ficha. Sem IA/automação/janela: avisa a equipe. Devolve true se já foi pedido (ou não há o que pedir). */
export async function pedirDadosVistoriaFh(accountId: string, leadId: string, banco: 'Inter' | 'Santander', io: Io, opts: { manual?: boolean } = {}): Promise<boolean> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, aiAutoReplyActive: true, customFields: true } });
  if (!lead) return false;
  const cf = (lead.customFields || {}) as Cf;
  const st = (cf._vistoriaDadosFh || {}) as DadosSt;
  if (st.askedAt) return true;
  const compradores = compradoresDe(cf, lead.name);
  const { enderecoDoImovel } = require('./certidao-offer.service') as typeof import('./certidao-offer.service');
  const end = await enderecoDoImovel(leadId, cf).catch(() => null);
  const itens = itensDoPedido(banco, cf, compradores, !!end || !vazio(((cf._dadosVistoriaFh || {}) as Dados).imovel?.cep));
  if (!itens.length) { await salvaDadosSt(leadId, { askedAt: new Date().toISOString(), banco, itens: [], completoAt: new Date().toISOString() }); return true; }
  const avisaEquipe = async (motivo: string) => {
    if (st.teamNoteAt && !opts.manual) return;
    await salvaDadosSt(leadId, { teamNoteAt: new Date().toISOString() });
    await note(leadId, `🏠 Vistoria do ${banco} (Financiamento): falta saber pelo cliente ${itens.map((i) => ({ contato: 'o contato de quem recebe o engenheiro (corretor ou vendedor)', vendedor: 'e-mail/telefone/profissão do vendedor', conta: 'a conta do vendedor pra crédito', comprador: 'profissão/e-mail dos compradores', imovel: 'o endereço completo do imóvel' } as Record<string, string>)[i]).join('; ')}. ${motivo} Preencha "Contato vistoria" no card (e os dados na anotação) quando tiver.`);
    push(accountId, `🏠 Dados da vistoria (${banco})`, `${lead.name}: pedir ao cliente o contato do corretor/vendedor`, leadId);
  };
  const { contractingAutoOn } = require('./contracting-auto.service') as typeof import('./contracting-auto.service');
  if (!lead.aiAutoReplyActive && !opts.manual) { await avisaEquipe('IA do card desligada: o CRM não perguntou.'); return false; }
  if (!opts.manual && !(await contractingAutoOn(accountId))) { await avisaEquipe('Automação da contratação desligada: o CRM não perguntou.'); return false; }
  const { inNoticeWindow, whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  if (!inNoticeWindow() && !opts.manual) return false;
  if (!(await whatsappWindowOpen(leadId))) { await avisaEquipe('A janela de 24 h do WhatsApp está fechada: a pergunta sai assim que o cliente responder.'); return false; }
  const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
  const nome = callableFirstName(cf.falando_com, cf.participante_1, lead.name) || '';
  const r = await sendOutboundWhatsApp({ accountId, leadId, content: textoPedidoDados(nome, itens, compradores.length > 1), io });
  if (!r.success) return false;
  await salvaDadosSt(leadId, { askedAt: new Date().toISOString(), banco, itens });
  await note(leadId, `🏠 Pedi ao cliente os dados da vistoria do ${banco}: ${itens.join(', ')}. A resposta é lida e vai pro card ("Contato vistoria" e os dados do vendedor).`);
  return true;
}

const SYSTEM_DADOS = `Você lê mensagens de WhatsApp de um cliente que comprou um imóvel com financiamento bancário. Ele está respondendo a um pedido de dados para a VISTORIA do imóvel. Extraia SÓ o que está escrito (nunca invente) e responda SOMENTE com JSON:
{"contato":{"nome":null,"telefone":null,"papel":"corretor|vendedor|outro|null"},"vendedor":{"email":null,"telefone":null,"profissao":null},
"conta":{"titular":null,"banco":null,"agencia":null,"conta":null,"digito":null,"tipo":"corrente|poupança|null"},
"compradores":[{"profissao":null,"email":null}],"imovel":{"cep":null,"logradouro":null,"numero":null,"complemento":null,"bairro":null,"cidade":null,"uf":null,"tipo":"Apartamento|Casa|null"}}
Regras: "contato" é quem recebe o engenheiro (corretor; sem corretor, o vendedor). Se o cliente mandar só o telefone do vendedor, ele também é o contato. Telefone só dígitos com DDD. "compradores" na ordem em que aparecem (1º = o próprio cliente). Conta: separe o dígito se vier "12345-6".`;

async function lerResposta(accountId: string, leadId: string, desde: Date): Promise<Dados | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const msgs = await prisma.message.findMany({ where: { leadId, direction: 'INBOUND', createdAt: { gt: desde } }, orderBy: { createdAt: 'asc' }, take: 25, select: { content: true } });
  const texto = msgs.map((m) => m.content).filter((c) => c && c.trim()).join('\n---\n').slice(0, 8000);
  if (!texto.trim()) return null;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 1200, system: SYSTEM_DADOS, messages: [{ role: 'user', content: texto }] }),
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  try { return JSON.parse((data.content?.find((b) => b.type === 'text')?.text || '').match(/\{[\s\S]*\}/)?.[0] || ''); } catch { return null; }
}

/** Junta o que já se sabia com a leitura nova (o novo só preenche o que está vazio). Pura. */
export function juntaDados(antes: Dados, novo: Dados): Dados {
  const f = (a: any, b: any): any => {
    if (Array.isArray(a) || Array.isArray(b)) { const A = Array.isArray(a) ? a : []; const B = Array.isArray(b) ? b : []; return Array.from({ length: Math.max(A.length, B.length) }, (_, i) => f(A[i], B[i])); }
    if (a && typeof a === 'object') { const o: any = { ...a }; for (const k of Object.keys(b || {})) o[k] = f(a[k], b[k]); return o; }
    return vazio(a) ? (vazio(b) || b === 'null' ? a : b) : a;
  };
  return f(antes || {}, novo || {});
}

const lendo = new Map<string, NodeJS.Timeout>();
/** Lê as respostas 60 s depois da última mensagem (o cliente costuma mandar em várias). */
function agendaLeitura(accountId: string, leadId: string) {
  const t = lendo.get(leadId);
  if (t) clearTimeout(t);
  lendo.set(leadId, setTimeout(() => { lendo.delete(leadId); lerDadosAgora(accountId, leadId).catch((e: any) => console.warn('[Vistoria FH] dados:', e?.message)); }, 60_000));
}

async function lerDadosAgora(accountId: string, leadId: string) {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, customFields: true } });
  if (!lead) return;
  const cf = (lead.customFields || {}) as Cf;
  const st = (cf._vistoriaDadosFh || {}) as DadosSt;
  if (!st.askedAt || st.completoAt) return;
  const novo = await lerResposta(accountId, leadId, new Date(st.askedAt));
  if (!novo) return;
  const antes = (cf._dadosVistoriaFh || {}) as Dados;
  const dados = juntaDados(antes, novo);
  const tel = String(dados.contato?.telefone || '').replace(/\D/g, '');
  const contato = vazio(cf.contato_vistoria) && tel.length >= 10 ? `${dados.contato?.nome || ''}${dados.contato?.papel && dados.contato.papel !== 'null' ? ` (${dados.contato.papel})` : ''} — ${tel}`.replace(/^ — /, '') : null;
  const compradores = compradoresDe({ ...cf, _dadosVistoriaFh: dados }, lead.name);
  const faltam = itensDoPedido((st.banco as any) || 'Inter', { ...cf, _dadosVistoriaFh: dados, ...(contato ? { contato_vistoria: contato } : {}) }, compradores, true).filter((i) => (st.itens || []).includes(i));
  await patchCf(leadId, (c) => {
    c._dadosVistoriaFh = dados;
    if (contato) c.contato_vistoria = contato;
    c._vistoriaDadosFh = { ...(c._vistoriaDadosFh || {}), lidoAt: new Date().toISOString(), ...(faltam.length ? {} : { completoAt: new Date().toISOString() }) };
  });
  const linhas = [
    contato && `Contato da vistoria: ${contato}`,
    dados.vendedor && Object.values(dados.vendedor).some((v) => !vazio(v)) && `Vendedor: ${[dados.vendedor.email, dados.vendedor.telefone, dados.vendedor.profissao].filter((v) => !vazio(v)).join(' · ')}`,
    dados.conta && !vazio(dados.conta.conta) && `Conta do vendedor: ${[dados.conta.banco, dados.conta.agencia && `ag. ${dados.conta.agencia}`, dados.conta.conta && `conta ${dados.conta.conta}${dados.conta.digito ? `-${dados.conta.digito}` : ''}`, dados.conta.tipo, dados.conta.titular].filter((v) => !vazio(v)).join(', ')}`,
  ].filter(Boolean);
  if (linhas.length) await note(leadId, `🏠 Dados da vistoria que o cliente mandou:\n${linhas.join('\n')}${faltam.length ? `\nAinda falta: ${faltam.join(', ')}.` : ''}`);
}

// ─── B) Santander ───
export const textoPedidoAssinaturaFh = (nome: string, qual: 'aut' | 'saude', doisCompradores: boolean): string => [
  `${nome ? `${nome}, p` : 'P'}ra seguir com a vistoria do Santander, preciso que você assine ${qual === 'aut' ? 'esta autorização' : 'esta declaração de saúde'} pelo gov.br e me devolva o PDF assinado:`,
  '',
  '1. Acesse assinador.iti.br (ou o app gov.br, em "Assinatura digital")',
  '2. Envie o PDF, entre com a sua conta gov.br e assine',
  '3. Baixe o arquivo assinado e me mande por aqui',
  ...(doisCompradores ? ['', 'O 2º comprador também precisa assinar o mesmo arquivo, depois de você.'] : []),
].join('\n');

export const textoPerguntaSaude = (doisCompradores: boolean): string => [
  `Pra ${MARCA_SAUDE} (obrigatória no financiamento do Santander), confirme se TUDO abaixo vale pra você${doisCompradores ? ' e pro 2º comprador' : ''}:`,
  '',
  '• está em plenas condições de saúde e em plena atividade de trabalho',
  '• não pratica esporte radical ou perigoso',
  '• não é aposentado por invalidez nem está afastado pelo INSS',
  '• não exerce nem exerceu atividade com esforço repetitivo, insalubre ou perigosa',
  '• nunca foi afastado do trabalho por doença ou acidente',
  '• não tem doença em tratamento contínuo nem cirurgia prevista',
  '• não faz nem fez tratamento por LER/DORT ou psiquiátrico (depressão, pânico, estresse)',
  '• nunca foi internado para tratamento clínico ou cirúrgico',
  '• não tem deficiência ou redução funcional de membros ou dos sentidos',
  '',
  'Se tudo isso vale, responda CONFIRMO. Se algum item não vale, me diga qual que a gente ajusta a declaração.',
].join('\n');

/** Resposta à lista da saúde: CONFIRMO claro / alguma exceção / outra coisa (não decide). Pura. */
export function respostaSaude(text: string): 'PADRAO' | 'OUTRA' | null {
  const t = norm(text).replace(/[!.,😊🙏👍]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (/^(confirmo|confirmado|confirmamos|sim confirmo|confirmo sim|sim,? confirmo|tudo certo|vale tudo|tudo vale|todos? valem?|sim tudo vale|sim vale tudo|confirmo tudo|correto|sim)$/.test(t)) return 'PADRAO';
  if (/\b(nao|exceto|menos|tenho|tive|fui|sou|fa[cç]o|tomo|aposentad|afastad|internad|cirurgia|depress|ansiedad|diabet|press[aã]o|hipertens|cancer|doen[cç]a)\b/.test(t) && t.length > 2) return 'OUTRA';
  return null;
}

type DriveF = { id: string; name: string; path: string; mimeType: string; size: number };
const OK_ARQ = /^(application\/pdf|image\/)/;
/** Separa a pasta do cliente no que a Letícia pede (compradores x vendedor pelo caminho). Pura. */
export function categoriasFh(files: DriveF[]) {
  const ok = files.filter((f) => OK_ARQ.test(f.mimeType) && (f.size || 0) <= 12 * 1024 * 1024 && !/^VERIFICAR/i.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
  const n = (f: DriveF) => f.name.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  const vend = (f: DriveF) => /vendedor/i.test(f.path || '');
  const comp = ok.filter((f) => !vend(f) && !/imovel|im[oó]vel|formulario|minuta/i.test(f.path || ''));
  const ven = ok.filter(vend);
  const ident = /^(RG|CNH|DOCUMENTO DE IDENTIFICACAO|CARTEIRA DE IDENTIDADE)\b/;
  const civil = /^CERTIDAO DE (CASAMENTO|NASCIMENTO|OBITO|UNIAO)|^AVERBACAO/;
  const cert = ok.filter((f) => /^CERTIDAO DE ONUS/.test(n(f)));
  return {
    onus: (cert.length ? cert : ok.filter((f) => /^MATRICULA DO IMOVEL/.test(n(f)))).slice(0, 2),
    cnd: ok.filter((f) => /CND IPTU|CERTIDAO NEGATIVA.*(IPTU|DEBITO)/.test(n(f))).slice(0, 1),
    compIdent: comp.filter((f) => ident.test(n(f))).slice(0, 4),
    compRes: comp.filter((f) => /^COMPROVANTE DE RESIDENCIA/.test(n(f))).slice(0, 2),
    compCivil: comp.filter((f) => civil.test(n(f))).slice(0, 2),
    venIdent: ven.filter((f) => ident.test(n(f))).slice(0, 4),
    venCivil: ven.filter((f) => civil.test(n(f))).slice(0, 2),
  };
}

async function arquivosDoDrive(accountId: string, cf: Cf): Promise<DriveF[]> {
  const link = String(cf.link_pasta_drive || '').trim();
  if (!link) return [];
  try { const { extractFolderId, listAllFilesInFolderTree } = await import('./google.service'); return (await listAllFilesInFolderTree(accountId, extractFolderId(link), 3)) as DriveF[]; } catch { return []; }
}
async function bytesDoAnexo(accountId: string, a: { data: Uint8Array | Buffer | null; driveFileId: string | null; mimeType: string }): Promise<Buffer | null> {
  if (a.data && a.data.length) return Buffer.from(a.data);
  if (!a.driveFileId) return null;
  try { const { downloadDriveFile } = await import('./google.service'); return await downloadDriveFile(accountId, a.driveFileId, a.mimeType); } catch { return null; }
}
async function guardaFormulario(accountId: string, cf: Cf, nome: string, mimeType: string, data: Buffer): Promise<boolean> {
  const link = String(cf.link_pasta_drive || '').trim();
  if (!link) return false;
  try {
    const { extractFolderId, createFolder, uploadFile } = await import('./google.service');
    const pasta = await createFolder(accountId, 'FORMULARIOS', extractFolderId(link));
    await uploadFile(accountId, { name: nome, mimeType, parentId: pasta.id, data });
    return true;
  } catch (e: any) { console.warn('[Vistoria Santander FH] Drive:', e?.message); return false; }
}

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const prazoDoCard = (cf: Cf): number | null => { const n = Number(String(cf.prazo_financ || cf._fhPrazo || '').replace(/\D/g, '')); return n >= 60 && n <= 420 ? n : null; };

/** Fluxo do Santander no Financiamento (chamado pelo vigia da vistoria e pelo botão do card). Devolve true quando o pedido já foi enviado à Letícia. */
export async function processVistoriaSantanderFh(accountId: string, leadId: string, io: Io, opts: { manual?: boolean; holdSend?: boolean } = {}): Promise<boolean> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { id: true, name: true, aiAutoReplyActive: true, customFields: true } });
  if (!lead) return false;
  let cf = (lead.customFields || {}) as Cf;
  if (cf._autoPaused) return false;
  const st = (cf._vistoriaSantFh || {}) as St;
  if (st.status === 'ENVIADA') return true;
  if (opts.manual && !st.startedByTeam) { await salvaSt(leadId, { startedByTeam: true }); st.startedByTeam = true; }
  const repete = (iso?: string) => opts.manual || faz(iso) > AVISO_REPETIR_MS;

  // Ficha cadastral dos compradores (lida dos documentos): sem ela, gera agora (é a base da ficha do Santander e da declaração).
  if (!cf._fichaCadastral && (opts.manual || faz(st.fichaTentouAt) > 6 * 3600_000)) {
    await salvaSt(leadId, { fichaTentouAt: new Date().toISOString() });
    const { gerarFichaCadastral } = require('./ficha-cadastral.service') as typeof import('./ficha-cadastral.service');
    await gerarFichaCadastral(accountId, leadId, { io: io as any }).catch(() => null);
    cf = ((await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }))?.customFields || {}) as Cf;
  }
  const compradores = compradoresDe(cf, lead.name);
  const [c1, c2] = compradores;
  if (!c1) return false;
  const comp = (p: PessoaFicha): CompradorFh => ({ nome: String(p.nome || ''), cpf: String(p.cpf || ''), nascimento: String(p.nascimento || ''), profissao: String(p.profissao || '') || undefined });
  const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
  const primeiroNome = callableFirstName(cf.falando_com, cf.participante_1, lead.name) || '';
  const { enderecoDoImovel } = require('./certidao-offer.service') as typeof import('./certidao-offer.service');
  const endImovel = await enderecoDoImovel(leadId, cf).catch(() => null);
  const cidade = endImovel?.cidade || String(c1.endereco?.cidade || '');

  // 0) dados que só o cliente sabe (contato da vistoria, vendedor, conta) — em paralelo com as assinaturas
  await pedirDadosVistoriaFh(accountId, leadId, 'Santander', io, { manual: opts.manual }).catch((e: any) => console.warn('[Vistoria FH] pedir dados:', e?.message));

  // 1) autorização (assinar) + lista da declaração de saúde
  if (!st.autAskedAt) {
    if (!lead.aiAutoReplyActive && !opts.manual) {
      if (!st.teamAskNoteAt) { await salvaSt(leadId, { teamAskNoteAt: new Date().toISOString() }); await note(leadId, '🏦 Santander (Financiamento): documentação completa. Falta mandar ao cliente a autorização e a declaração de saúde pra assinar pelo gov.br (IA do card desligada: o CRM não mandou sozinho). Use "Iniciar / avançar" na vistoria do Santander do card.'); push(accountId, '🏦 Vistoria Santander', `${lead.name}: mandar os formulários pra assinar`, leadId); }
      return false;
    }
    const { inNoticeWindow, whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
    if (!inNoticeWindow() && !opts.manual) return false;
    if (!(await whatsappWindowOpen(leadId))) {
      if (opts.manual || !st.teamAskNoteAt) { await salvaSt(leadId, { teamAskNoteAt: new Date().toISOString() }); await note(leadId, '🏦 Santander (Financiamento): a janela de 24 h do WhatsApp está fechada. Os formulários saem assim que o cliente responder qualquer mensagem.'); }
      return false;
    }
    const pdf = await preencherAutorizacaoFh({ c1: comp(c1), c2: c2 ? comp(c2) : null, cidade, leadId });
    const sent = await sendOutboundMedia({ accountId, leadId, buffer: pdf, fileName: 'Autorizacao Santander - assinar pelo gov.br.pdf', mimeType: 'application/pdf', caption: textoPedidoAssinaturaFh(primeiroNome, 'aut', !!c2), io });
    if (!sent.success) return false;
    const pergunta = await sendOutboundWhatsApp({ accountId, leadId, content: textoPerguntaSaude(!!c2), io });
    await salvaSt(leadId, { status: 'ASSINATURA_PEDIDA', autAskedAt: new Date().toISOString(), ...(pergunta.success ? { saudeAskAt: new Date().toISOString() } : {}) });
    const guardou = await guardaFormulario(accountId, cf, 'AUTORIZACAO SANTANDER - PARA ASSINAR.pdf', 'application/pdf', pdf);
    await note(leadId, `🏦 Santander (Financiamento): mandei ao cliente a autorização (nomes e CPFs) pra assinar pelo gov.br${guardou ? ' (cópia na pasta FORMULARIOS do Drive)' : ''} e ${pergunta.success ? 'a lista da declaração de saúde pra ele CONFIRMAR' : 'NÃO consegui mandar a lista da declaração de saúde'}. Com o CONFIRMO, a declaração preenchida vai pra assinatura.`);
    return false;
  }

  // 2) declaração de saúde: só com a confirmação do cliente
  if (st.saudeResp === 'PADRAO' && !st.saudeSentAt) {
    const pdf = await preencherDeclaracaoSaude({ c1: comp(c1), c2: c2 ? comp(c2) : null, prazoMeses: prazoDoCard(cf), cidade, leadId, seguro: SEGURO, respostasPadrao: true });
    const sent = await sendOutboundMedia({ accountId, leadId, buffer: pdf, fileName: 'Declaracao de saude Santander - assinar pelo gov.br.pdf', mimeType: 'application/pdf', caption: textoPedidoAssinaturaFh(primeiroNome, 'saude', !!c2), io });
    if (sent.success) {
      await salvaSt(leadId, { saudeSentAt: new Date().toISOString() });
      await guardaFormulario(accountId, cf, 'DECLARACAO DE SAUDE - PARA ASSINAR.pdf', 'application/pdf', pdf);
      await note(leadId, `🏦 Santander: o cliente CONFIRMOU a lista da saúde ("${st.saudeRespText || 'confirmo'}"). Mandei a declaração preenchida (seguro ${SEGURO === 'ZURICH' ? 'Habitacional Zurich Santander' : 'Habitacional Santander A. S.A.'}, prazo ${prazoDoCard(cf) || '—'} meses) pra assinar pelo gov.br.`);
    }
  } else if (st.saudeResp === 'OUTRA' && !st.saudeEquipeAt) {
    const pdf = await preencherDeclaracaoSaude({ c1: comp(c1), c2: c2 ? comp(c2) : null, prazoMeses: prazoDoCard(cf), cidade, leadId, seguro: SEGURO, respostasPadrao: false });
    const guardou = await guardaFormulario(accountId, cf, 'DECLARACAO DE SAUDE - COMPLETAR (respostas em branco).pdf', 'application/pdf', pdf);
    await salvaSt(leadId, { saudeEquipeAt: new Date().toISOString() });
    await note(leadId, `🏦 Santander: na declaração de saúde o cliente respondeu que algo não vale: "${st.saudeRespText || ''}". O CRM NÃO marcou as respostas: preencha a declaração com ele${guardou ? ' (modelo com nomes/nascimentos/prazo na pasta FORMULARIOS do Drive)' : ''} e mande pra assinar pelo gov.br. Quando o PDF assinado voltar, o fluxo segue sozinho.`);
    push(accountId, '🏦 Declaração de saúde: conferir', `${lead.name}: o cliente indicou uma exceção na saúde`, leadId);
  }

  await avisaCndSeFalta(accountId, leadId, { force: opts.manual }).catch(() => {});

  // 3) PDFs assinados de volta
  if (!st.autSignedAt || !st.saudeSignedAt) {
    const atts = await prisma.messageAttachment.findMany({ where: { leadId, mimeType: 'application/pdf', createdAt: { gt: new Date(st.autAskedAt) }, message: { direction: 'INBOUND' } }, orderBy: { createdAt: 'asc' }, select: { id: true, fileName: true, mimeType: true, data: true, driveFileId: true } });
    for (const a of atts) {
      const bytes = await bytesDoAnexo(accountId, a);
      if (!bytes) continue;
      const r = await inspecionarRetornoFh(bytes, leadId);
      if (!r.qual) continue;
      if (!r.assinado) {
        if (faz(st.semAssinaturaNoteAt) > AVISO_REPETIR_MS) { await salvaSt(leadId, { semAssinaturaNoteAt: new Date().toISOString() }); await note(leadId, `🏦 Santander: o cliente devolveu ${r.qual === 'AUT' ? 'a autorização' : 'a declaração de saúde'} (${a.fileName}) SEM assinatura digital do gov.br. Peça pra assinar em assinador.iti.br e mandar de novo.`); }
        continue;
      }
      if (r.qual === 'AUT' && !st.autSignedAt) {
        st.autSignedAt = new Date().toISOString(); st.autSignedName = a.fileName || 'autorizacao.pdf';
        await salvaSt(leadId, { autSignedAt: st.autSignedAt, autSignedName: st.autSignedName });
        await guardaFormulario(accountId, cf, 'AUTORIZACAO SANTANDER - ASSINADA.pdf', 'application/pdf', bytes);
        await note(leadId, `🏦 Santander: autorização ASSINADA de volta (${a.fileName}).`);
      }
      if (r.qual === 'SAUDE' && !st.saudeSignedAt) {
        st.saudeSignedAt = new Date().toISOString(); st.saudeSignedName = a.fileName || 'declaracao.pdf';
        await salvaSt(leadId, { saudeSignedAt: st.saudeSignedAt, saudeSignedName: st.saudeSignedName });
        await guardaFormulario(accountId, cf, 'DECLARACAO DE SAUDE - ASSINADA.pdf', 'application/pdf', bytes);
        await note(leadId, `🏦 Santander: declaração de saúde ASSINADA de volta (${a.fileName}).`);
      }
    }
    if (!st.autSignedAt || !st.saudeSignedAt) return false;
    await salvaSt(leadId, { status: 'ASSINADA' });
  }

  // 4) documentos da pasta
  const cat = categoriasFh(await arquivosDoDrive(accountId, cf));
  const faltam: string[] = [];
  if (!cat.onus.length) faltam.push('certidão de matrícula/ônus do imóvel');
  if (!cat.cnd.length) faltam.push('CND de IPTU (a A&F emite)');
  if (cat.compIdent.length < compradores.length) faltam.push(`RG/CNH ${compradores.length > 1 ? 'dos compradores' : 'do comprador'}`);
  if (!cat.compRes.length) faltam.push('comprovante de residência do comprador');
  if (!cat.compCivil.length) faltam.push('certidão de estado civil do comprador');
  if (!cat.venIdent.length) faltam.push('RG/CNH do vendedor');
  if (!cat.venCivil.length) faltam.push('certidão de estado civil do vendedor');
  if (faltam.length) {
    if (repete(st.faltaNoteAt)) {
      await salvaSt(leadId, { status: 'AGUARDA_DOCS', faltaNoteAt: new Date().toISOString() });
      await note(leadId, `🏦 Santander (Financiamento): formulários assinados, mas a pasta do Drive ainda não tem: ${faltam.join('; ')}. Assim que estiver na pasta, o CRM envia o pedido à Letícia.`);
      push(accountId, '🏦 Vistoria Santander: falta documento', `${lead.name}: ${faltam.join('; ').slice(0, 110)}`, leadId);
    }
    return false;
  }

  // 5) ficha (Word)
  const fresh = ((await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }))?.customFields || {}) as Cf;
  const dados = (fresh._dadosVistoriaFh || {}) as Dados;
  let vendedores = (fresh._fichaVendedor?.pessoas || []) as PessoaFicha[];
  if (!vendedores.length || faz(fresh._fichaVendedor?.at) > 24 * 3600_000) {
    const { lerVendedores } = require('./ficha-cadastral.service') as typeof import('./ficha-cadastral.service');
    vendedores = ((await lerVendedores(accountId, leadId).catch(() => null)) || vendedores) as PessoaFicha[];
  }
  if (vendedores[0]) vendedores = [{ ...vendedores[0], email: vendedores[0].email || dados.vendedor?.email || null, telefone: vendedores[0].telefone || dados.vendedor?.telefone || null, profissao: vendedores[0].profissao || dados.vendedor?.profissao || null }, ...vendedores.slice(1)];
  const contatoTxt = String(fresh.contato_vistoria || '').trim();
  const mTel = /(\(?\d{2}\)?\s*9?\d{4}[-\s]?\d{4})/.exec(contatoTxt);
  const contato = { pessoa: contatoTxt.replace(mTel?.[1] || '', '').replace(/[—–-]\s*$/, '').trim() || contatoTxt, telefone: mTel?.[1] || '' };
  const im = dados.imovel || {};
  const imovel: ImovelFh = {
    cep: endImovel?.endereco.cep || im.cep, logradouro: endImovel ? `${endImovel.endereco.tipoLogradouro || ''} ${endImovel.endereco.logradouro || ''}`.trim() : im.logradouro,
    numero: endImovel?.endereco.numero || im.numero, complemento: endImovel?.endereco.complemento || im.complemento, bairro: endImovel?.endereco.bairro || im.bairro,
    cidade: endImovel?.cidade || im.cidade, uf: endImovel?.uf || im.uf, tipo: String(fresh.imovel_tipo || im.tipo || ''),
  };
  const ficha = dadosFichaFh({ compradores: compradoresDe(fresh, lead.name), vendedores, conta: dados.conta || null, imovel, contato, usaFgts: /^(s|sim|true|1)/i.test(String(fresh.usa_fgts ?? '').trim()) });
  const docx = await preencherFichaFh(ficha.ops);
  const essenciais = ficha.faltando.filter((f) => /contat|endere[cç]o completo do im[oó]vel|tipo do im[oó]vel|conta do vendedor|dados do vendedor|n[uú]mero do documento|estado civil|telefone|e-mail|profiss/i.test(f));
  if (essenciais.length) {
    if (repete(st.faltaNoteAt) || st.status !== 'FALTAM_DADOS') {
      await salvaSt(leadId, { status: 'FALTAM_DADOS', faltaNoteAt: new Date().toISOString() });
      const guardou = await guardaFormulario(accountId, fresh, 'FICHA CADASTRO SANTANDER - PARA COMPLETAR.docx', DOCX, docx);
      await note(leadId, `🏦 Santander (Financiamento): formulários assinados e documentos ok, mas a ficha de cadastro ficou sem: ${essenciais.join('; ')}.${guardou ? ' Guardei a ficha preenchida na pasta FORMULARIOS do Drive ("PARA COMPLETAR"): complete e envie à Letícia, ou preencha no card (Contato vistoria) e o CRM tenta de novo.' : ''}`);
      push(accountId, '🏦 Vistoria Santander: ficha incompleta', `${lead.name}: ${essenciais.join('; ').slice(0, 110)}`, leadId);
    }
    return false;
  }

  if (opts.holdSend && !opts.manual) {
    if (st.status !== 'PRONTA') {
      await salvaSt(leadId, { status: 'PRONTA', prontaNoteAt: new Date().toISOString() });
      await note(leadId, '🏦 Santander (Financiamento): formulários assinados, documentos completos e ficha preenchida. Falta só enviar à Letícia: botão "Enviar à Letícia" na vistoria do Santander do card.');
      push(accountId, '🏦 Vistoria Santander pronta', `${lead.name}: clique em "Enviar à Letícia" no card`, leadId);
    }
    return false;
  }

  // 6) e-mail à Letícia
  const pdfAssinado = async (nome?: string) => {
    const a = await prisma.messageAttachment.findFirst({ where: { leadId, fileName: nome || undefined, mimeType: 'application/pdf', message: { direction: 'INBOUND' } }, orderBy: { createdAt: 'desc' }, select: { data: true, driveFileId: true, mimeType: true } });
    return a ? bytesDoAnexo(accountId, a) : null;
  };
  const aut = await pdfAssinado(st.autSignedName);
  const saude = await pdfAssinado(st.saudeSignedName);
  if (!aut || !saude) { await salvaSt(leadId, { status: 'ERRO', erro: 'não consegui abrir os PDFs assinados' }); await note(leadId, '⚠️ Santander: não consegui abrir os PDFs assinados do cliente pra anexar. Envie o pedido à mão.'); return false; }
  const { downloadDriveFile } = await import('./google.service');
  const anexos: { filename: string; contentType: string; content: Buffer }[] = [
    { filename: 'Ficha para cadastro - Aquisicao.docx', contentType: DOCX, content: docx },
    { filename: st.autSignedName || 'Autorizacao assinada.pdf', contentType: 'application/pdf', content: aut },
    { filename: st.saudeSignedName || 'Declaracao de saude assinada.pdf', contentType: 'application/pdf', content: saude },
  ];
  const grupos: [string, DriveF[]][] = [['certidão de matrícula/ônus', cat.onus], ['CND de IPTU', cat.cnd], ['RG/CNH dos compradores', cat.compIdent], ['comprovante de residência', cat.compRes], ['certidão de estado civil dos compradores', cat.compCivil], ['RG/CNH do vendedor', cat.venIdent], ['certidão de estado civil do vendedor', cat.venCivil]];
  for (const [, arr] of grupos) for (const f of arr) anexos.push({ filename: `${/vendedor/i.test(f.path || '') ? 'VENDEDOR - ' : ''}${f.name}`, contentType: f.mimeType, content: await downloadDriveFile(accountId, f.id, f.mimeType) });
  await guardaFormulario(accountId, fresh, 'FICHA CADASTRO SANTANDER - PREENCHIDA.docx', DOCX, docx);
  const resumo = String(fresh._fhResumo || '');
  const proposta = (/Santander:[^|]*?proposta\s*(\d{5,})/i.exec(resumo) || [])[1] || String(fresh.num_proposta || '');
  const nomeCliente = String(c1.nome || lead.name).replace(/\s+/g, ' ').trim();
  const pessoaLinha = (rotulo: string, p: PessoaFicha) => `• ${rotulo}: ${p.nome || '—'} — e-mail ${p.email || '—'}, telefone ${p.telefone || '—'}, profissão ${p.profissao || p.trabalho?.cargo || '—'}`;
  const conta = dados.conta || {};
  const corpo = [
    'Olá, Letícia, tudo bem?', '',
    `Segue a solicitação de vistoria do financiamento (aquisição) do cliente ${nomeCliente}${proposta ? ` (proposta Santander nº ${proposta})` : ''}.`, '',
    'Em anexo:', '• ficha para cadastro preenchida', '• autorização dos compradores assinada (gov.br)', '• declaração de saúde assinada (gov.br)', ...grupos.filter(([, a]) => a.length).map(([l]) => `• ${l}`), '',
    'CONTATOS', ...compradoresDe(fresh, lead.name).map((p, i) => pessoaLinha(`${i + 1}º comprador`, p)), ...vendedores.slice(0, 2).map((p, i) => pessoaLinha(i ? 'cônjuge do vendedor' : 'vendedor', p)), '',
    `CONTA PARA CRÉDITO (vendedor): ${[conta.titular && `titular ${conta.titular}`, conta.banco && `banco ${conta.banco}`, conta.agencia && `agência ${conta.agencia}`, conta.conta && `conta ${conta.conta}${conta.digito ? `-${conta.digito}` : ''}`, conta.tipo].filter(Boolean).join(', ') || '—'}`, '',
    `Contato para a vistoria: ${contatoTxt || '—'}`, '',
    'Qualquer dúvida, estou à disposição.', 'Obrigado!',
  ].join('\n');
  const dono = await prisma.user.findFirst({ where: { accountId, role: 'ADMIN' }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  const acc = await prisma.emailAccount.findFirst({ where: { accountId, userId: null }, orderBy: { createdAt: 'asc' } });
  if (!dono || !acc) { await note(leadId, '⚠️ Santander: a caixa de e-mail comercial não está configurada; não consegui enviar o pedido de vistoria.'); return false; }
  try {
    const { sendEmailFrom } = require('./email-inbox.service') as typeof import('./email-inbox.service');
    await sendEmailFrom({ acc, userId: dono.id, to: [VISTORIA_SANTANDER_TO], cc: [], subject: `Solicitação de vistoria - financiamento - ${nomeCliente.toUpperCase()}${proposta ? ` - proposta ${proposta}` : ''}`, body: corpo, replyToId: null, leadId, io: (io || ({ to: () => ({ emit: () => {} }) })) as any, attachments: anexos });
  } catch (e: any) {
    await salvaSt(leadId, { status: 'ERRO', erro: String(e?.message || e).slice(0, 200) });
    await note(leadId, `⚠️ Santander (Financiamento): tentei enviar o pedido de vistoria à Letícia e não consegui: ${e?.message || e}. Envie à mão.`);
    push(accountId, '⚠️ Vistoria Santander não saiu', lead.name, leadId);
    return false;
  }
  await patchCf(leadId, (c) => { c._vistoriaRequestedAt = new Date().toISOString(); });
  await salvaSt(leadId, { status: 'ENVIADA', sentAt: new Date().toISOString(), to: VISTORIA_SANTANDER_TO });
  await note(leadId, `📨 Vistoria do Santander (Financiamento) solicitada: e-mail para ${VISTORIA_SANTANDER_TO} com ${anexos.length} anexo(s): ${anexos.map((a) => a.filename).join('; ')}.${ficha.faltando.length ? `\nFicaram em branco na ficha: ${ficha.faltando.join('; ')}.` : ''}`);
  push(accountId, '📨 Vistoria solicitada ao Santander', lead.name, leadId);
  try {
    const card = await prisma.lead.findUnique({ where: { id: leadId }, select: { pipelineId: true, stageId: true, stage: { select: { name: true } } } });
    const vist = card ? await prisma.stage.findFirst({ where: { pipelineId: card.pipelineId, name: { contains: 'Vistoria', mode: 'insensitive' } }, select: { id: true, name: true } }) : null;
    if (card && vist && vist.id !== card.stageId) {
      const { updateLeadStage } = require('./lead.service') as typeof import('./lead.service');
      await updateLeadStage(leadId, accountId, vist.id);
      await prisma.note.create({ data: { leadId, type: 'STAGE_CHANGE', content: `Estágio: "${card.stage?.name || '—'}" → "${vist.name}" — vistoria solicitada ao Santander` } }).catch(() => {});
    }
  } catch (e: any) { console.warn('[Vistoria Santander FH] mover card:', e?.message); }
  return true;
}

/** Hook da mensagem recebida: resposta à lista da saúde e aos dados da vistoria. */
export async function onClientReplyVistoriaFh(accountId: string, leadId: string, text: string, io?: Io): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cf = (lead?.customFields || {}) as Cf;
  const dst = cf._vistoriaDadosFh as DadosSt | undefined;
  if (dst?.askedAt && !dst.completoAt) agendaLeitura(accountId, leadId);
  const st = cf._vistoriaSantFh as St | undefined;
  if (!st?.saudeAskAt || st.saudeResp) return;
  const resp = respostaSaude(text);
  if (!resp) return;
  // a lista precisa ser a última pergunta do CRM (senão o "sim" pode ser resposta a outra coisa)
  const ultimas = await prisma.message.findMany({ where: { leadId, direction: 'OUTBOUND' }, orderBy: { createdAt: 'desc' }, take: 2, select: { content: true } });
  if (!ultimas.some((m) => (m.content || '').includes(MARCA_SAUDE))) return;
  await salvaSt(leadId, { saudeResp: resp, saudeRespText: text.slice(0, 200) });
  const { contractingAutoOn } = require('./contracting-auto.service') as typeof import('./contracting-auto.service');
  await processVistoriaSantanderFh(accountId, leadId, io, { holdSend: !(await contractingAutoOn(accountId)) }).catch((e: any) => console.warn('[Vistoria FH] saúde:', e?.message));
}

// ── Card: andamento (mesmo painel do Santander do Home Equity) ──
const STATUS_TXT: Record<string, string> = {
  ASSINATURA_PEDIDA: 'Autorização e lista da saúde enviadas — aguardando o cliente confirmar e assinar pelo gov.br',
  ASSINADA: 'Formulários assinados — conferindo os documentos da pasta',
  AGUARDA_DOCS: 'Formulários assinados — faltam documentos na pasta do Drive',
  FALTAM_DADOS: 'Documentos ok, mas a ficha de cadastro ficou sem dado essencial (Word na pasta FORMULARIOS)',
  PRONTA: 'Tudo pronto — falta enviar o pedido à Letícia',
  ENVIADA: 'Pedido de vistoria enviado à Letícia',
  ERRO: 'Deu erro no envio (veja a nota do card)',
};

export async function santanderFhPreview(accountId: string, leadId: string) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true } });
  if (!lead) throw new Error('Card não encontrado');
  const cf = (lead.customFields || {}) as Cf;
  const st = (cf._vistoriaSantFh || {}) as St;
  const cat = categoriasFh(await arquivosDoDrive(accountId, cf));
  const n = compradoresDe(cf, lead.name).length;
  const docs = [
    { key: 'onus', label: 'Certidão de matrícula/ônus', ok: cat.onus.length > 0 },
    { key: 'cnd', label: 'CND de IPTU (a A&F emite)', ok: cat.cnd.length > 0 },
    { key: 'compIdent', label: `RG/CNH ${n > 1 ? 'dos compradores' : 'do comprador'}`, ok: cat.compIdent.length >= n },
    { key: 'compRes', label: 'Comprovante de residência (comprador)', ok: cat.compRes.length > 0 },
    { key: 'compCivil', label: 'Certidão de estado civil (comprador)', ok: cat.compCivil.length > 0 },
    { key: 'venIdent', label: 'RG/CNH do vendedor', ok: cat.venIdent.length > 0 },
    { key: 'venCivil', label: 'Certidão de estado civil do vendedor', ok: cat.venCivil.length > 0 },
    { key: 'conta', label: 'Conta do vendedor para crédito', ok: !vazio(((cf._dadosVistoriaFh || {}) as Dados).conta?.conta) },
    { key: 'contato', label: 'Contato da vistoria (corretor/vendedor)', ok: !vazio(cf.contato_vistoria) },
  ];
  return {
    aplicavel: true as const, financiamento: true as const,
    status: st.status || '', statusTexto: STATUS_TXT[st.status || ''] || '',
    askedAt: st.autAskedAt || null, signedAt: st.autSignedAt && st.saudeSignedAt ? st.saudeSignedAt : null, sentAt: st.sentAt || null, to: st.to || VISTORIA_SANTANDER_TO,
    docs, temLinkPasta: !!String(cf.link_pasta_drive || '').trim(),
  };
}
