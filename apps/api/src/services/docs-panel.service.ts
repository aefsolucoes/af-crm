import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { isStickerAttachment, isScreenshotAttachment, isPropertyDocType } from './received-docs.service';
import { situacaoDosDocumentos, type DocReview } from './doc-review.service';
import { conferenciaEmAndamento, filtrarRendaDispensada } from './docs-checker.service';
import { logActivity } from './activity.service';

/* PAINEL DE DOCUMENTOS do card (Fabio 03/11: "preciso de um botão pra verificar qual documento falta do cliente, a IA listar quais documentos já foram recebidos e a gente
 * corrigir eles, caso esteja errado"). Abre SEM chamar a IA: RECEBIDOS = a leitura que a IA já guardou de cada arquivo (customFields._docReview / _docInfo); FALTANDO = a
 * situação de cada documento pela MESMA regra da conferência (situacaoDosDocumentos: lados do RG/CNH, IPTU de outro imóvel, dúvidas, dono do imóvel) + o que a última conferência
 * achou faltando da lista do banco (_docsConferencia). A equipe CORRIGE uma leitura errada (tipo, titular, situação, dono do imóvel): grava SÓ aquela chave (jsonb), marca
 * corrigidoPor/corrigidoEm e a conferência automática passa a usar a correção — a IA não relê o arquivo. Nada vai pro cliente e o card não sai do lugar. */

const semAcento = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
/** Tipo como a leitura grava: CAIXA ALTA, sem acento (as regras da conferência comparam assim — /^(RG|CNH)\b/, MATRICULA, IPTU…). */
const normTipo = (s: unknown) => semAcento(s).toUpperCase().replace(/[^A-Z0-9 /().-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50);
/** Mesmo formato do classificador (_docInfo "TIPO|TITULAR"): só letras/números. */
const limpo = (s: unknown, max: number) => semAcento(s).replace(/[^A-Za-z0-9 ]/g, '').replace(/\s+/g, ' ').trim().toUpperCase().slice(0, max);
const ehDocDoImovel = (tipo: string) => isPropertyDocType(limpo(tipo, 50)) || /CADASTRO IMOBILIARIO|ESCRITURA|MATRICULA|ONUS/.test(tipo);
const ehIdentidade = (tipo: string) => /^(RG|CNH)\b/.test(tipo);

const SITUACOES = ['PARTICIPANTE', 'PARENTE_1GRAU', 'OUTRO_SEM_RELACAO', 'EMPRESA'] as const;
const RESULTADOS = ['OK', 'PROBLEMA', 'NAO_DOCUMENTO'] as const;
const ROTULO: Record<string, string> = { OK: 'OK', PROBLEMA: 'com problema', NAO_DOCUMENTO: 'não é documento', DUVIDA: 'em dúvida', PARTICIPANTE: 'participante', PARENTE_1GRAU: 'parente de 1º grau', OUTRO_SEM_RELACAO: 'outra pessoa sem vínculo', EMPRESA: 'empresa' };

type Situacao = 'OK' | 'PROBLEMA' | 'DUVIDA' | 'NAO_DOCUMENTO' | 'PROTEGIDO' | 'SO_CLASSIFICADO' | 'SEM_LEITURA';

const anexosDoCliente = async (leadId: string) => (await prisma.messageAttachment.findMany({
  where: { leadId, message: { direction: 'INBOUND' } },
  orderBy: { createdAt: 'asc' },
  select: { id: true, fileName: true, mimeType: true, createdAt: true },
})).filter((a) => !/^(audio|video)\//.test(a.mimeType) && !isStickerAttachment(a) && !isScreenshotAttachment(a)); // mesmo filtro da conferência

export async function painelDocumentos(accountId: string, leadId: string) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true, stage: { select: { name: true } }, pipeline: { select: { department: { select: { name: true } } } } } });
  if (!lead) return null;
  const cf = (lead.customFields || {}) as Record<string, any>;
  const atts = await anexosDoCliente(leadId);
  const rev = (cf._docReview || {}) as Record<string, DocReview>;
  const info = (cf._docInfo || {}) as Record<string, string>;
  const prot = (cf._docsProtegidos || {}) as Record<string, unknown>;

  const recebidos = atts.map((a) => {
    const r = rev[a.id];
    const i = typeof info[a.id] === 'string' ? info[a.id] : undefined;
    const [tipoInfo = '', titularInfo = ''] = i && i !== 'IGNORAR' ? i.split('|') : [];
    const situacao: Situacao = r ? r.resultado
      : i === 'IGNORAR' ? 'NAO_DOCUMENTO'
      : tipoInfo === 'PROTEGIDO' || prot[a.id] ? 'PROTEGIDO'
      : i ? 'SO_CLASSIFICADO' : 'SEM_LEITURA';
    return { id: a.id, fileName: a.fileName, mimeType: a.mimeType, createdAt: a.createdAt, situacao, tipo: r?.tipo || tipoInfo, titular: r?.titular || titularInfo, leitura: r || null };
  });

  // O que falta: a MESMA regra da conferência sobre as leituras guardadas; tira o que a consolidação da última conferência viu que outro arquivo já atende e, com a renda
  // dispensada, os documentos de renda (igual checkDocsComplete).
  const sit = situacaoDosDocumentos(atts, rev, cf);
  const atendidos = (Array.isArray(cf._docsAtendidos) ? cf._docsAtendidos : []) as { doc: string; texto: string; por: string }[];
  for (const a of atendidos) { const p = sit.problemas.find((x) => x.doc === a.doc); if (p) p.texto = p.texto.filter((t) => t !== a.texto); }
  sit.problemas = sit.problemas.filter((p) => p.texto.length);
  await filtrarRendaDispensada(leadId, sit).catch(() => {});
  const perguntados = new Set<string>(((cf._donoAskedFor as string[]) || []).map((x) => String(x).toUpperCase()));

  const conf = cf._docsConferencia as { em: string; listaUsada: string; completo: boolean; faltando: string[]; emitir: string[]; emitirPendente: string[] } | undefined;
  const conferencia = conf || (cf._docsFaltando ? { em: null, listaUsada: '', completo: false, faltando: String(cf._docsFaltando).split(/;\s+/).filter(Boolean), emitir: [], emitirPendente: [] } : null);

  return {
    emAndamento: conferenciaEmAndamento(leadId),
    recebidos,
    conferencia,
    problemas: sit.problemas,
    duvidas: sit.duvidas,
    donoPendente: sit.donoPendente.map((d) => ({ ...d, perguntado: perguntados.has(d.dono.toUpperCase()) })),
  };
}

export class PainelErro extends Error { constructor(msg: string, public status = 400) { super(msg); } }

export interface CorrecaoInput { tipo?: string; titular?: string; resultado?: string; problemas?: string[] | string; lado?: string; dono?: string; donoSituacao?: string | null }

/** A equipe corrige a leitura de UM arquivo. Grava só `_docReview.<id>` (e `_docInfo.<id>`, se o tipo/titular/situação mudou) por SQL — nunca o card inteiro. */
export async function corrigirLeituraDocumento(params: { accountId: string; leadId: string; attachmentId: string; userId: string; userName: string; body: CorrecaoInput; io?: any }) {
  const { accountId, leadId, attachmentId, userId, userName, body, io } = params;
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { id: true, name: true, customFields: true } });
  if (!lead) throw new PainelErro('Lead não encontrado', 404);
  const att = (await anexosDoCliente(leadId)).find((a) => a.id === attachmentId);
  if (!att) throw new PainelErro('Arquivo não encontrado neste card', 404);
  const cf = (lead.customFields || {}) as Record<string, any>;
  const antes = ((cf._docReview || {}) as Record<string, DocReview>)[attachmentId];
  const infoAntes = typeof cf._docInfo?.[attachmentId] === 'string' ? String(cf._docInfo[attachmentId]) : undefined;
  const [tipoInfo = '', titularInfo = ''] = infoAntes && infoAntes !== 'IGNORAR' ? infoAntes.split('|') : [];

  // Base: a leitura da IA (ou, se o arquivo nunca foi lido por completo, a classificação rápida).
  const base: DocReview = antes ? { ...antes } : { tipo: normTipo(tipoInfo === 'PROTEGIDO' ? '' : tipoInfo), titular: titularInfo, resultado: infoAntes === 'IGNORAR' ? 'NAO_DOCUMENTO' : 'OK', problemas: [], lado: '', emissao: '', observacao: '' };
  const novo: DocReview = { ...base };
  // Mesmo texto com outra caixa/acento não é correção (a leitura da IA pode ter vindo "Maria Souza" ou com acento): fica como estava.
  const igual = (a: unknown, b: unknown) => semAcento(a).toUpperCase().replace(/\s+/g, ' ').trim() === semAcento(b).toUpperCase().replace(/\s+/g, ' ').trim();
  if (body.tipo !== undefined && !igual(body.tipo, base.tipo)) novo.tipo = normTipo(body.tipo);
  if (body.titular !== undefined && !igual(body.titular, base.titular)) novo.titular = String(body.titular || '').replace(/\s+/g, ' ').trim().toUpperCase().slice(0, 160);
  if (body.resultado !== undefined) {
    if (!(RESULTADOS as readonly string[]).includes(String(body.resultado))) throw new PainelErro('Situação inválida (OK, PROBLEMA ou NAO_DOCUMENTO)');
    novo.resultado = body.resultado as DocReview['resultado'];
  }
  if (novo.resultado === 'DUVIDA') throw new PainelErro('Diga se o documento está OK, com problema ou se não é documento');
  if (novo.resultado !== 'NAO_DOCUMENTO' && !novo.tipo) throw new PainelErro('Diga qual é o documento (tipo)');
  if (novo.resultado === 'PROBLEMA') {
    const lista = body.problemas === undefined ? base.problemas : (Array.isArray(body.problemas) ? body.problemas : String(body.problemas).split('\n'));
    novo.problemas = lista.map((p) => String(p || '').replace(/\s+/g, ' ').trim().slice(0, 320)).filter(Boolean).slice(0, 4);
    if (!novo.problemas.length) throw new PainelErro('Diga qual é o problema do documento');
  } else novo.problemas = [];
  delete novo.duvida; // a equipe decidiu: não fica mais "em dúvida"
  // RG/CNH: o lado da foto (27/10: as duas fotos saíam como "frente" e o cliente era cobrado do verso).
  if (ehIdentidade(novo.tipo)) {
    if (body.lado !== undefined) {
      if (!['frente', 'verso', 'ambos', ''].includes(String(body.lado))) throw new PainelErro('Lado inválido');
      novo.lado = String(body.lado) as DocReview['lado'];
    }
  } else novo.lado = '';
  // Documento do imóvel: dono e a relação dele com os participantes. Outro tipo não tem dono — senão a conferência continuaria perguntando "de quem é o imóvel".
  if (ehDocDoImovel(novo.tipo) && novo.resultado !== 'NAO_DOCUMENTO') {
    if (body.dono !== undefined && !igual(body.dono, base.dono)) novo.dono = String(body.dono || '').replace(/\s+/g, ' ').trim().toUpperCase().slice(0, 80) || undefined;
    if (body.donoSituacao !== undefined) {
      const s = String(body.donoSituacao || '');
      if (s && !(SITUACOES as readonly string[]).includes(s)) throw new PainelErro('Relação do dono inválida');
      novo.donoSituacao = (s || undefined) as DocReview['donoSituacao'];
    }
    if (!novo.dono) delete novo.dono;
    if (!novo.donoSituacao) delete novo.donoSituacao;
  } else { delete novo.dono; delete novo.donoSituacao; }

  const mud: string[] = [];
  if ((base.tipo || '') !== novo.tipo) mud.push(`tipo ${base.tipo || '—'} → ${novo.tipo || '—'}`);
  if ((base.titular || '') !== novo.titular) mud.push(`titular ${base.titular || '—'} → ${novo.titular || '—'}`);
  if (base.resultado !== novo.resultado || (!antes && !infoAntes)) mud.push(`situação ${antes || infoAntes ? ROTULO[base.resultado] || base.resultado : 'sem leitura'} → ${ROTULO[novo.resultado]}`);
  if (novo.resultado === 'PROBLEMA' && JSON.stringify(base.problemas || []) !== JSON.stringify(novo.problemas)) mud.push(`problema: ${novo.problemas.join('; ')}`);
  if ((base.lado || '') !== (novo.lado || '') && ehIdentidade(novo.tipo)) mud.push(`lado ${base.lado || '—'} → ${novo.lado || '—'}`);
  if ((base.dono || '') !== (novo.dono || '')) mud.push(`dono do imóvel ${base.dono || '—'} → ${novo.dono || '—'}`);
  if ((base.donoSituacao || '') !== (novo.donoSituacao || '')) mud.push(`relação do dono ${ROTULO[base.donoSituacao || ''] || '—'} → ${ROTULO[novo.donoSituacao || ''] || '—'}`);
  if (!mud.length) throw new PainelErro('Nada mudou na leitura');

  const agora = new Date().toISOString();
  novo.corrigidoPor = userName;
  novo.corrigidoEm = agora;
  if (!novo.antesDaCorrecao && (antes || infoAntes)) novo.antesDaCorrecao = { tipo: base.tipo, titular: base.titular, resultado: base.resultado, ...(base.donoSituacao ? { donoSituacao: base.donoSituacao } : {}), ...(base.dono ? { dono: base.dono } : {}), ...(base.lado ? { lado: base.lado } : {}) };

  // Classificação rápida (_docInfo) coerente com a correção: a conferência ("chegou tudo?") e o organizador da pasta leem o tipo/titular dali.
  const tipoLimpo = limpo(novo.tipo, 40);
  const infoNovo = novo.resultado === 'NAO_DOCUMENTO' ? 'IGNORAR' : `${tipoLimpo}|${ehDocDoImovel(novo.tipo) ? '' : limpo(String(novo.titular || '').split(';')[0], 60)}`;
  const mexeInfo = infoNovo !== infoAntes;

  // Só as chaves deste arquivo, num UPDATE só (corrida no customFields, 29/10): a leitura, a classificação, e sai da lista de "protegido por senha"/"falhou a leitura" (a equipe já viu o arquivo).
  const obj = (k: string) => Prisma.sql`COALESCE(CASE WHEN jsonb_typeof("customFields"->${k}::text) = 'object' THEN "customFields"->${k}::text END, '{}'::jsonb)`;
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = (
      COALESCE("customFields", '{}'::jsonb)
      || jsonb_build_object('_docReview', ${obj('_docReview')} || jsonb_build_object(${attachmentId}::text, ${JSON.stringify(novo)}::jsonb))
      ${mexeInfo ? Prisma.sql`|| jsonb_build_object('_docInfo', ${obj('_docInfo')} || jsonb_build_object(${attachmentId}::text, ${infoNovo}::text))` : Prisma.empty}
    ) #- ARRAY['_docsProtegidos', ${attachmentId}::text] #- ARRAY['_docLeituraFalhas', ${attachmentId}::text]
    WHERE id = ${leadId}`;

  // Dúvida da IA sobre ESTE arquivo ainda aberta no balão: a equipe já decidiu aqui — fecha (senão a resposta depois relia o arquivo por cima da correção).
  const fechadas = await prisma.aiTeamQuestion.updateMany({
    where: { accountId, leadId, attachmentId, kind: 'DOC_QUESTION', status: 'OPEN' },
    data: { status: 'DISMISSED', answeredByUserId: userId, answeredByName: userName, answeredAt: new Date(), answer: `Corrigido no painel de documentos: ${mud.join('; ')}`.slice(0, 1000) },
  }).catch(() => ({ count: 0 }));

  // Sem userId de propósito: anotação de PESSOA é lida por heurísticas (ex.: "banco não aceitou a certidão") e o texto do problema não pode disparar nada.
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `📝 ${userName} corrigiu a leitura de "${att.fileName}": ${mud.join('; ')}.${fechadas.count ? ' A dúvida da IA sobre esse arquivo foi fechada.' : ''} A conferência passa a usar a correção (a IA não relê esse arquivo). Nenhuma mensagem foi enviada ao cliente.` } }).catch(() => {});
  logActivity({ accountId, userId, userName, action: 'lead_edited', leadId, leadName: lead.name, summary: `corrigiu a leitura do documento "${att.fileName}" (${mud.join('; ')})`.slice(0, 300) });
  // Dono do imóvel mudou: o Santander sai/volta (imóvel em nome de terceiro — Fabio 03/11). Só nota/push pra equipe.
  if ((base.dono || '') !== (novo.dono || '') || (base.donoSituacao || '') !== (novo.donoSituacao || '')) {
    await (require('./imovel-terceiro.service') as typeof import('./imovel-terceiro.service')).avisarSantanderTerceiro(accountId, leadId).catch((e: any) => console.error('[Santander terceiro]', e?.message || e));
  }
  io?.to?.(`lead:${leadId}`)?.emit?.('lead_updated', { leadId });
  return { ok: true, leitura: novo };
}
