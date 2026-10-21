import { cachedSystem } from '../lib/anthropic-usage';
import { PrismaClient } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { downloadDriveFileForVision } from './google.service';
import { getDocInfo, isStickerAttachment, isScreenshotAttachment, isPropertyDocType } from './received-docs.service';
import { todayContextLine } from './ai-shared.service';


/* A IA LÊ o conteúdo de cada documento que o cliente manda (imagem ou PDF) e diz se está CORRETO pra ir ao banco: legível, atualizado, no nome certo,
 * com frente e verso quando é RG/CNH (Fabio 14/10: "preciso que a IA também passe a ler os documentos e saiba se estão corretos ou não").
 * A conferência de "chegou tudo?" (docs-checker) só olhava tipo e titular; aqui é a qualidade. Cada arquivo é lido uma vez e fica guardado no card
 * (customFields._docReview, por id do anexo). */

const MAX_REVIEW_BYTES = 10_000_000;

export interface DocReview {
  tipo: string;
  titular: string;
  resultado: 'OK' | 'PROBLEMA' | 'NAO_DOCUMENTO' | 'DUVIDA';
  problemas: string[];
  lado: 'frente' | 'verso' | 'ambos' | '';
  emissao: string;
  observacao: string;
  /** Só AUTORIZACAO SCR BACEN: GOVBR = assinatura eletrônica do gov.br (não precisa de identidade); PUNHO = assinada à mão (precisa do documento com foto). */
  assinatura?: 'GOVBR' | 'PUNHO';
  /** Documento do imóvel: nome do proprietário ATUAL e como ele se relaciona com os participantes (Home Equity). OUTRO_SEM_RELACAO = dono é outra pessoa e a conversa ainda não explica o vínculo → a conferência pergunta ao cliente. */
  dono?: string;
  donoSituacao?: 'PARTICIPANTE' | 'OUTRO_SEM_RELACAO' | 'PARENTE_1GRAU';
  /** Só MATRICULA/CERTIDAO DE ONUS aceita COM RESSALVA: CONSULTA (marca "para simples consulta", não é certidão oficial) ou ANTIGA (emissão há mais de 30 dias) — o banco pode não aceitar; o cliente recebe uma observação. */
  ressalva?: 'CONSULTA' | 'ANTIGA';
  /** Documento do imóvel: número da matrícula e cartório de registro como aparecem (vão pro card — servem pra emitir a certidão). */
  matricula?: string;
  cartorio?: string;
  /** Só MATRICULA/CERTIDAO DE ONUS: alienação fiduciária/hipoteca/penhora VIGENTE (sem cancelamento) que a leitura achou — ex.: "ALIENACAO FIDUCIARIA - CAIXA - R$ 86.692 (11/06/2024)". Vazio = nada vigente. */
  gravame?: string;
  /** MATRICULA/CERTIDAO DE ONUS: a matrícula foi ENCERRADA (averbação "Encerramento de matrícula": o imóvel foi desmembrado/renumerado e ganhou matrícula(s) nova(s)). A certidão NÃO serve — precisa de uma nova com o número novo. */
  encerrada?: { quando?: string; novas: string[] };
  /** MATRICULA: números ANTERIORES da mesma matrícula (renumeração: "renumerada de Matrícula nº 159") — pra conferir com o número que o cliente mandou. */
  anteriores?: string[];
  /** Documento do imóvel: endereço do imóvel como aparece (logradouro, número, complemento) e, no IPTU/cadastro imobiliário, a inscrição imobiliária — a conferência compara o IPTU com o imóvel do cliente (caso Pedro 19/10: guia de IPTU de OUTRO imóvel, nº 1834). */
  endereco?: string;
  inscricao?: string;
  /** Documento OFICIAL DA PREFEITURA (capa/guia de IPTU, certidão de IPTU, cadastro imobiliário) que MOSTRA as metragens (área do terreno/construída) — a conferência aceita a capa ou outro documento da prefeitura; matrícula/escritura NÃO valem pra esse item (Fabio 20/10). */
  metragens?: boolean;
  /** DUVIDA: a pergunta pra equipe (a IA não tem segurança se o documento serve). */
  duvida?: string;
  /** Depois da resposta da equipe: regra geral que vale pra outros clientes (vazio = foi só desse caso). */
  regra?: string;
}

const SYSTEM = `Você é a conferente de documentos de um correspondente bancário (crédito com garantia de imóvel e financiamento habitacional). Olhe o ARQUIVO que o cliente mandou pelo WhatsApp e diga se ele está CORRETO para seguir ao banco. Responda SOMENTE com JSON:
{"tipo":"<nome curto: RG, CNH, CPF, CERTIDAO DE NASCIMENTO, CERTIDAO DE CASAMENTO, AUTORIZACAO SCR BACEN, COMPROVANTE DE RESIDENCIA, CONTRACHEQUE, EXTRATO BANCARIO, IMPOSTO DE RENDA, CERTIDAO DE ONUS REAIS (SÓ a do CARTÓRIO de Registro de Imóveis), CERTIDAO DE CADASTRO IMOBILIARIO (da PREFEITURA), MATRICULA, CND IPTU (SÓ a certidão negativa), GUIA IPTU (guia/carnê de pagamento), CAPA IPTU, ESCRITURA ou outro nome curto>","titular":"<nome completo como está no documento, ou vazio>","resultado":"OK|PROBLEMA|NAO_DOCUMENTO|DUVIDA","problemas":["<frase dirigida AO CLIENTE (você), educada e curta, dizendo o que está errado e o que fazer — ex.: \"Manda uma foto mais nítida, a data não dá pra ler.\" Nunca escreva \"peça ao cliente\">"],"lado":"<só RG/CNH: frente, verso ou ambos (o que aparece nesta imagem); senão vazio>","emissao":"<AAAA-MM-DD da emissão/competência se aparecer, senão vazio>","assinatura":"<só AUTORIZACAO SCR BACEN assinada: GOVBR (assinatura eletrônica/carimbo do gov.br) ou PUNHO (assinatura à mão); senão vazio>","ressalva":"<SÓ MATRICULA ou CERTIDAO DE ONUS aceita mesmo assim: CONSULTA (tem a marca \"para simples consulta\"/não vale como certidão) ou ANTIGA (emissão há mais de 30 dias); senão vazio>",
"matricula":"<SÓ documento do imóvel: número da matrícula como aparece (ex.: 36.267); senão vazio>","matriculasAnteriores":"<SÓ MATRICULA: se houver averbação de RENUMERAÇÃO, o(s) número(s) anterior(es) da matrícula separados por ponto e vírgula (ex.: 159); senão vazio>","matriculaEncerrada":<true SÓ se MATRICULA/CERTIDAO DE ONUS traz averbação de ENCERRAMENTO DA MATRÍCULA (sem reabertura); senão false>","encerradaEm":"<data do encerramento DD/MM/AAAA, ou vazio>","matriculasNovas":"<se encerrada: as matrículas NOVAS que a averbação diz que foram abertas, separadas por ponto e vírgula, com a descrição, ex.: 438.308 (Apartamento 203); 438.309 (Vaga de garagem); senão vazio>","cartorio":"<SÓ documento do imóvel: cartório de registro de imóveis (nome/cidade); senão vazio>",
"dono":"<SÓ documento do IMÓVEL (matrícula, ônus, IPTU, escritura): nome do proprietário ATUAL; senão vazio>","donoSituacao":"<SÓ documento do imóvel em Home Equity: PARTICIPANTE | OUTRO_SEM_RELACAO | PARENTE_1GRAU; senão vazio>",
"enderecoImovel":"<SÓ documento do IMÓVEL (matrícula, ônus, IPTU, cadastro imobiliário, escritura): endereço do imóvel como está escrito (logradouro, número, complemento/apto, bairro); senão vazio>","inscricao":"<SÓ IPTU/guia/carnê/cadastro imobiliário: inscrição imobiliária exatamente como aparece; senão vazio>",
"metragens":<true SÓ se o documento é OFICIAL DA PREFEITURA do município (capa/guia/carnê de IPTU, certidão de IPTU, cadastro imobiliário/BCI) E MOSTRA a área do terreno e/ou a área construída; matrícula, escritura e qualquer documento de cartório NÃO contam; senão false>,
"gravame":"<SÓ MATRICULA ou CERTIDAO DE ONUS: se constar alienação fiduciária, hipoteca ou penhora ainda VIGENTE (sem averbação de cancelamento/baixa), escreva curto: TIPO - CREDOR - valor original (data), ex.: ALIENACAO FIDUCIARIA - CAIXA - R$ 86.692 (11/06/2024); senão vazio>",
"observacao":"<detalhe INTERNO útil pra equipe (ex.: constam ônus ou alienação fiduciária na matrícula, validade do documento); senão vazio>","duvida":"<SÓ se resultado DUVIDA: a pergunta objetiva pra equipe, 1 a 2 frases, dizendo o que você viu e o que precisa saber; senão vazio>","regra":"<SÓ quando a equipe já respondeu: a regra geral, em 1 frase, que vale pra OUTROS clientes; se foi só sobre este caso, vazio>"}

Critérios — aponte PROBLEMA só quando for real; documento legível e correto é OK, não invente defeito:
- Legibilidade: foto desfocada, escura, com reflexo, cortada ou com dado importante ilegível → PROBLEMA ("manda uma foto mais nítida/inteira").
- RG/CNH: NÃO dê problema por mostrar só um lado (o cliente pode mandar frente e verso em fotos separadas): só preencha "lado". CNH digital (print do app) conta como "ambos". CNH vencida → PROBLEMA.
- Atualização (use a data de hoje): comprovante de residência com mais de 90 dias; CND de IPTU vencida; contracheque que não seja dos últimos 3 meses → PROBLEMA, dizendo o prazo exigido. Para a A&F, certidão de ônus reais e matrícula (inteiro teor) são o MESMO tipo de documento: número da matrícula, metragens e todos os REGISTROS (R-) e AVERBAÇÕES (AV-) — um histórico completo do imóvel. CERTIDÃO DE ÔNUS REAIS e MATRÍCULA NÃO têm prazo: a A&F aceita antiga/vencida, aceita a versão "PARA SIMPLES CONSULTA, NÃO VALE COMO CERTIDÃO" (consulta do ONR) e aceita incompleta ou com páginas faltando (Fabio 15/10). NUNCA marque PROBLEMA nem peça ao cliente pra tirar outra no cartório por causa de data, marca de consulta ou páginas: aceite, preencha "ressalva" (CONSULTA ou ANTIGA) quando for o caso — o banco decide e o cliente recebe uma observação — e anote detalhes em "observacao" (a A&F emite a certidão pelo endereço ou número da matrícula). A data que vale na matrícula/certidão é a de EMISSÃO da certidão (carimbo/linha "certidão emitida em…", em geral no topo ou no fim), NÃO as datas dos registros e averbações dentro dela (um registro de 2011 não torna a certidão antiga). Se a data de emissão/validade não aparecer mas o documento parece inteiro e legível, é OK: anote "sem data de emissão visível" na observação.
- MATRÍCULA ENCERRADA (Fabio 16/10): se a MATRICULA/CERTIDAO DE ONUS tem averbação de "ENCERRAMENTO DE MATRÍCULA" (imóvel desmembrado/renumerado: "foram ABERTAS as matrículas nº …"), a certidão NÃO serve pro banco — marque "matriculaEncerrada": true, preencha "encerradaEm" e "matriculasNovas" e dê resultado PROBLEMA com o texto: "a matrícula nº X foi encerrada em DD/MM; o imóvel agora tem a matrícula nº Y — precisa da certidão da matrícula nova". Renumeração ("Av. … RENUMERAÇÃO", só muda o número) NÃO é encerramento.
- Titular: compare com os participantes do card. RG/CNH/CPF/certidão/documento de renda em nome de OUTRA pessoa → PROBLEMA ("está no nome de X; o participante é Y"). Comprovante de residência em nome de parente/outra pessoa NÃO é problema por si só. DOCUMENTOS DO IMÓVEL (matrícula, ônus, IPTU, escritura): olhe o PROPRIETÁRIO ATUAL (o último registro de propriedade, não os antigos) e preencha "dono". Em Home Equity ele precisa ser um dos participantes do card OU parente de 1º grau deles (pai, mãe, filho/a; cônjuge também vale): participante → donoSituacao PARTICIPANTE (resultado OK). Outra pessoa e a "CONVERSA RECENTE" (se vier) NÃO explica quem ela é → donoSituacao OUTRO_SEM_RELACAO e resultado OK (o documento em si está certo; a conferência vai perguntar ao cliente de quem é o imóvel — não chute parentesco por sobrenome). Se a CONVERSA RECENTE traz o cliente explicando o vínculo: pai/mãe/filho/filha/cônjuge → PARENTE_1GRAU (OK); qualquer outro vínculo (irmão, tio, amigo, empresa, ex-cônjuge…) ou resposta confusa → resultado DUVIDA, com a pergunta pra equipe citando o que o cliente disse. No Financiamento Habitacional o imóvel é do VENDEDOR e isso é normal (deixe donoSituacao vazio; não é problema nem dúvida).
- CERTIDÃO DE CADASTRO IMOBILIÁRIO (Fabio 19/10): documento da PREFEITURA/município (ex.: "Certidão de Cadastro de Imóvel", Departamento de Tributos) com inscrição imobiliária, proprietários e endereço. NÃO é certidão de ônus nem matrícula (essas são do CARTÓRIO de Registro de Imóveis) e NUNCA entra como "CERTIDAO DE ONUS REAIS": use o tipo CERTIDAO DE CADASTRO IMOBILIARIO. Ela traz a inscrição imobiliária, mas não substitui a matrícula/ônus.
- GUIA/CARNÊ DE PAGAMENTO do IPTU (parcelas com vencimento e código de barras) NÃO é CND: use o tipo GUIA IPTU, sem regra de validade de CND (não dê PROBLEMA por "vencida"). Só é CND IPTU o documento escrito "Certidão" negativa de débitos.
- CAPA IPTU (Home Equity: capa do IPTU/carnê com as metragens e a inscrição imobiliária): precisa mostrar as METRAGENS (área do terreno/construída) e a inscrição; se a capa NÃO mostrar as metragens, NÃO dê PROBLEMA (Fabio 20/10: as metragens podem estar em OUTRO documento OFICIAL DA PREFEITURA — certidão de IPTU ou cadastro imobiliário): só marque "metragens": false (a conferência aceita as metragens de outro documento OFICIAL DA PREFEITURA: certidão de IPTU ou cadastro imobiliário; matrícula e escritura não servem pra esse item). Não exija CND de IPTU no Home Equity (a lista agora pede a capa e a inscrição; a A&F emite a CND).
- ESCRITURA PÚBLICA de compra e venda (Home Equity): é válida como documento do imóvel — resultado OK; leia nela o número da matrícula e o cartório ("matricula"/"cartorio") e o proprietário. CONTRATO DE COMPRA E VENDA particular ("de gaveta", sem registro em cartório) ou documento do imóvel que você não sabe se serve: resultado DUVIDA, pergunta pra equipe analisar. Nenhum dos dois substitui a certidão de ônus/matrícula; só ajudam a emiti-la.
- Documento de várias páginas (matrícula, ônus, escritura, IR) que parece parcial: NÃO marque PROBLEMA; escreva em "observacao" que parece parcial.
- Se não for documento (selfie, figurinha, print de conversa, foto qualquer): resultado NAO_DOCUMENTO.
- AUTORIZACAO SCR BACEN (formulário "Autorização SCR Bacen" que a Creditas pede): só vale ASSINADA. Assinada = carimbo/assinatura eletrônica do gov.br ("Assinado digitalmente/de forma digital por NOME … gov.br", com CPF) ou assinatura de próprio punho no campo de assinatura; "titular" = a PESSOA QUE ASSINOU/preencheu (nome do participante). Preencha "assinatura" com GOVBR ou PUNHO. Formulário em branco ou sem assinatura → PROBLEMA (diga ao cliente: "assine pelo gov.br e me devolva o PDF assinado"; se for assinar à mão, "assine igual ao seu documento de identidade e mande o formulário junto com a foto do documento"). O CRM já manda o formulário preenchido (local, data de hoje, nome e CPF no campo do proponente); o cliente só assina. Sem o nome do participante ou sem data → PROBLEMA ("esse formulário veio sem data/nome; assine o que eu te mandei, já preenchido"). Assinatura legível e nome batendo com o participante → OK.
- DÚVIDA: se você NÃO tem segurança pra dizer que o documento serve ou não (documento raro ou que você não reconhece; nome com grafia diferente que pode ou não ser a mesma pessoa; suspeita de montagem ou adulteração; documento que contradiz o card; regra do banco que você não conhece), NÃO chute: resultado DUVIDA e escreva a pergunta pra equipe em "duvida". Não use DUVIDA por preguiça — documento legível e claro é OK ou PROBLEMA. A equipe vai abrir ESTE arquivo e responder; as respostas anteriores aparecem em "REGRAS APRENDIDAS COM A EQUIPE" (siga-as antes de perguntar de novo).`;

type Att = { id: string; driveFileId: string | null; data?: Uint8Array | null; mimeType: string; fileName?: string; createdAt?: Date };

function cleanText(v: unknown, max: number): string {
  const t = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  // corta no fim da última frase/palavra inteira (a mensagem ao cliente saía cortada no meio da palavra: "…não essa consulta informat")
  const cut = t.slice(0, max);
  const frase = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return frase > max * 0.5 ? cut.slice(0, frase + 1) : cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : max).replace(/[,;:\s]+$/, '') + '…';
}

/** Lê UM arquivo. undefined = não deu pra ler (tipo, tamanho, erro de rede/API) — tenta de novo na próxima conferência. */
export async function reviewAttachment(accountId: string, att: Att, context: string, opts: { learned?: string; teamAnswer?: { pergunta: string; resposta: string } } = {}): Promise<DocReview | undefined> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return undefined;
  const isPdf = att.mimeType === 'application/pdf';
  const isImage = /^image\//.test(att.mimeType);
  if (!isPdf && !isImage) return undefined;
  let buffer: Buffer;
  let mimeType = att.mimeType;
  try {
    if (att.data && att.data.length) buffer = Buffer.from(att.data);
    else if (att.driveFileId) ({ buffer, mimeType } = await downloadDriveFileForVision(accountId, att.driveFileId, att.mimeType));
    else return undefined;
  } catch { return undefined; }
  if (buffer.length > MAX_REVIEW_BYTES) return undefined;
  const mediaType = isPdf ? 'application/pdf' : mimeType;
  if (!isPdf && !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mediaType)) return undefined;
  const source = { type: 'base64', media_type: mediaType, data: buffer.toString('base64') };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 4096, // o raciocínio do modelo conta nesse limite: com 700 matrícula e foto de IPTU saíam cortadas e ficavam sem leitura (Maria Antônia, 15/10)
      system: cachedSystem(SYSTEM, opts.learned ? `REGRAS APRENDIDAS COM A EQUIPE (respostas anteriores a dúvidas de documento — valem pra qualquer cliente):\n${opts.learned}` : undefined),
      messages: [{ role: 'user', content: [{ type: isPdf ? 'document' : 'image', source }, { type: 'text', text: opts.teamAnswer
        ? `${context}\n\nVocê teve uma dúvida sobre ESTE arquivo e a EQUIPE já olhou e respondeu. Dúvida: ${opts.teamAnswer.pergunta}\nResposta da equipe: ${opts.teamAnswer.resposta}\nDecida agora: resultado OK (a equipe aceitou o documento) ou PROBLEMA (a equipe disse que não serve — em "problemas" escreva o que o cliente deve fazer). NÃO devolva DUVIDA. Preencha "regra" se a resposta vale pra outros clientes.`
        : context }] }],
    }),
  }).catch(() => null);
  if (!res || !res.ok) {
    if (res) console.error('[DocReview] Erro Anthropic:', res.status, (await res.text()).slice(0, 200));
    return undefined;
  }
  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  const raw = data.content?.find((b) => b.type === 'text')?.text || '';
  try {
    const j = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{}');
    const resultado = j.resultado === 'OK' || j.resultado === 'PROBLEMA' || j.resultado === 'NAO_DOCUMENTO' || j.resultado === 'DUVIDA' ? j.resultado : null;
    if (!resultado) return undefined;
    const duvida = cleanText(j.duvida, 400);
    if (resultado === 'DUVIDA' && (opts.teamAnswer || !duvida)) return undefined; // com a resposta da equipe não pode voltar a duvidar; sem pergunta não dá pra levar pra equipe
    const lado = j.lado === 'frente' || j.lado === 'verso' || j.lado === 'ambos' ? j.lado : '';
    const problemas = (Array.isArray(j.problemas) ? j.problemas : []).map((p: unknown) => cleanText(p, 320)).filter(Boolean).slice(0, 4);
    const assinatura = j.assinatura === 'GOVBR' || j.assinatura === 'PUNHO' ? j.assinatura : undefined;
    const matricula = cleanText(j.matricula, 40), cartorio = cleanText(j.cartorio, 80);
    const ressalva = j.ressalva === 'CONSULTA' || j.ressalva === 'ANTIGA' ? j.ressalva : undefined;
    const donoSituacao = j.donoSituacao === 'PARTICIPANTE' || j.donoSituacao === 'OUTRO_SEM_RELACAO' || j.donoSituacao === 'PARENTE_1GRAU' ? j.donoSituacao : undefined;
    const dono = cleanText(j.dono, 80);
    const endereco = cleanText(j.enderecoImovel, 140), inscricao = cleanText(j.inscricao, 40);
    const ehMat = /^(MATRICULA|CERTIDAO DE ONUS)/.test(cleanText(j.tipo, 50).toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
    const novas = ehMat && j.matriculaEncerrada === true ? String(j.matriculasNovas || '').split(/\s*;\s*/).map((x) => cleanText(x, 80)).filter(Boolean).slice(0, 6) : [];
    const anteriores = ehMat ? String(j.matriculasAnteriores || '').split(/\s*;\s*/).map((x) => cleanText(x, 40)).filter(Boolean).slice(0, 4) : [];
    const encerrada = ehMat && j.matriculaEncerrada === true ? { quando: cleanText(j.encerradaEm, 12) || undefined, novas } : undefined;
    const gravame = /^(MATRICULA|CERTIDAO DE ONUS)/.test(cleanText(j.tipo, 50).toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '')) ? cleanText(j.gravame, 160) : '';
    const resultadoFinal = encerrada ? 'PROBLEMA' : resultado;
    const problemasFinal = encerrada
      ? [`a matrícula${matricula ? ` nº ${matricula}` : ''} foi ENCERRADA${encerrada.quando ? ` em ${encerrada.quando}` : ''}${novas.length ? `; o imóvel agora tem ${novas.length > 1 ? 'as matrículas' : 'a matrícula'} ${novas.join(' e ')}` : ''} — precisa da certidão da matrícula nova`, ...problemas.filter((p: string) => !/encerr/i.test(p))].slice(0, 4)
      : problemas;
    return { ...(endereco ? { endereco } : {}), ...(inscricao ? { inscricao } : {}), metragens: j.metragens === true && /IPTU|CADASTRO IMOBILIARIO/.test(cleanText(j.tipo, 50).toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')), tipo: cleanText(j.tipo, 50).toUpperCase(), titular: cleanText(j.titular, 80), resultado: resultadoFinal, ...(encerrada ? { encerrada } : {}), ...(anteriores.length ? { anteriores } : {}), problemas: resultadoFinal === 'PROBLEMA' ? problemasFinal : [], lado, emissao: cleanText(j.emissao, 10), observacao: cleanText(j.observacao, 400), ...(assinatura ? { assinatura } : {}), ...(gravame ? { gravame } : {}), ...(matricula ? { matricula } : {}), ...(cartorio ? { cartorio } : {}), ...(ressalva ? { ressalva } : {}), ...(donoSituacao ? { donoSituacao, ...(dono ? { dono } : {}) } : {}), ...(resultado === 'DUVIDA' ? { duvida } : {}), ...(opts.teamAnswer && cleanText(j.regra, 300) ? { regra: cleanText(j.regra, 300) } : {}) };
  } catch { return undefined; }
}

/** Conversa recente (cliente/atendente) — só entra quando a conferência já perguntou ao cliente de quem é o imóvel, pra o leitor ver a resposta. */
async function recentConversation(leadId: string): Promise<string> {
  const msgs = await prisma.message.findMany({ where: { leadId, callWaCallId: null }, orderBy: { createdAt: 'desc' }, take: 14, select: { direction: true, content: true } });
  return msgs.reverse().map((m) => `${m.direction === 'INBOUND' ? 'Cliente' : 'Atendente'}: ${(m.content || '').replace(/\s+/g, ' ').slice(0, 220)}`).join('\n');
}

export function participantsContext(cf: Record<string, any>, leadName: string, setor = ''): string {
  const parts = [
    cf.participante_1 && `1) ${cf.participante_1}${cf.cpf_1 ? ` (CPF ${String(cf.cpf_1).replace(/\D/g, '').replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4')})` : ''}`,
    cf.participante_2 && `2) ${cf.participante_2}${cf.cpf_2 ? ` (CPF ${String(cf.cpf_2).replace(/\D/g, '').replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4')})` : ''}`,
  ].filter(Boolean).join('\n') || `1) ${leadName}`;
  return `${todayContextLine()}${setor ? `\nSetor: ${setor}` : ''}\nParticipantes do card:\n${parts}\n\nConfira este arquivo.`;
}

/** Regras que a equipe já ensinou respondendo dúvidas de documento (balão "Dúvidas da IA"): as mais recentes que a IA marcou como regra geral e que ninguém desfez. */
export async function learnedDocRules(accountId: string): Promise<string> {
  const rows = await prisma.aiTeamQuestion.findMany({
    where: { accountId, kind: 'DOC_QUESTION', status: 'ANSWERED', knowledgeTitle: { not: null } },
    orderBy: { answeredAt: 'desc' }, take: 25, select: { knowledgeTitle: true, question: true, answer: true },
  });
  return rows.map((r) => `- ${r.knowledgeTitle} (dúvida: ${cleanText(r.question, 200)} → equipe: ${cleanText(r.answer, 300)})`).join('\n');
}

/** A equipe respondeu a dúvida de um documento: a IA reconfere o MESMO arquivo com a resposta e grava o veredito no card (cache). Devolve o veredito (undefined = não deu pra reler). */
export async function resolveDocDoubt(accountId: string, leadId: string, attachmentId: string, pergunta: string, resposta: string): Promise<DocReview | undefined> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true, pipeline: { select: { department: { select: { name: true } } } } } });
  const att = await prisma.messageAttachment.findFirst({ where: { id: attachmentId, leadId }, select: { id: true, driveFileId: true, data: true, mimeType: true, fileName: true, createdAt: true } });
  if (!lead || !att) return undefined;
  const cf0 = (lead.customFields || {}) as Record<string, any>;
  const r = await reviewAttachment(accountId, att, participantsContext(cf0, lead.name, lead.pipeline?.department?.name || ''), { teamAnswer: { pergunta, resposta }, learned: await learnedDocRules(accountId).catch(() => '') });
  if (!r) return undefined;
  const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cache = { ...((((fresh?.customFields || {}) as any)._docReview as Record<string, DocReview>) || {}), [attachmentId]: r };
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...((fresh?.customFields || {}) as any), _docReview: cache, _docProblemSig: null } } });
  return r;
}

export interface ReviewSummary {
  /** Revisões novas desta rodada (pra nota no card). */
  novas: { arquivo: string; r: DocReview; attId?: string }[];
  /** Problemas que valem agora (a revisão MAIS RECENTE de cada tipo+titular; frente/verso de RG/CNH somados). */
  problemas: { doc: string; texto: string[] }[];
  /** Documentos em DÚVIDA (a IA levou a pergunta pra equipe, no balão): seguram o card até a equipe responder. */
  duvidas: { attachmentId: string; arquivo: string; doc: string; pergunta: string }[];
  /** Documento do imóvel em nome de OUTRA pessoa sem vínculo explicado: a conferência pergunta ao cliente de quem é. */
  donoPendente: { attachmentId: string; doc: string; dono: string }[];
  /** Documentos conferidos e OK (rótulo). */
  ok: string[];
}

const docKey = (r: DocReview) => `${r.tipo}|${r.titular.split(' ').slice(0, 2).join(' ')}`.toUpperCase();
const docLabel = (r: DocReview) => (r.titular ? `${r.tipo} (${r.titular.split(' ').slice(0, 2).join(' ')})` : r.tipo);

const soDigitos = (x: string | undefined) => String(x || '').replace(/\D/g, '');
const normEnd = (x: string) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const STOP_END = new Set(['R', 'RUA', 'AV', 'AVENIDA', 'TRAV', 'TRAVESSA', 'DA', 'DE', 'DO', 'DAS', 'DOS', 'N', 'NO', 'APTO', 'AP', 'APT', 'APARTAMENTO', 'BLOCO', 'BL', 'ED', 'EDIFICIO', 'RES', 'RESIDENCIAL', 'BAIRRO', 'CEP']);

/** Mesmo imóvel? true/false quando dá pra afirmar; null quando falta dado (nunca acusa sem certeza). Inscrição imobiliária manda; sem ela, compara rua + número da porta. Pura (testável). */
export function sameProperty(a: { endereco?: string; inscricao?: string }, b: { endereco?: string; inscricao?: string }): boolean | null {
  const ia = soDigitos(a.inscricao), ib = soDigitos(b.inscricao);
  if (ia.length >= 8 && ib.length >= 8) return ia === ib;
  if (!a.endereco || !b.endereco) return null;
  const ta = normEnd(a.endereco).split(' '), tb = normEnd(b.endereco).split(' ');
  const rua = (t: string[]) => t.filter((w) => !STOP_END.has(w) && !/^\d+$/.test(w));
  const compartilhaRua = rua(ta).some((w) => w.length > 3 && rua(tb).includes(w));
  if (!compartilhaRua) return null; // descrição de outro jeito (matrícula antiga: "esquina com..."): não dá pra afirmar
  // números dos dois endereços (porta, apto): só acusa "outro imóvel" quando NÃO há nenhum número em comum — conservador (um doc com só a porta e outro com porta+apto contam como o mesmo)
  const nums = (t: string[]) => t.filter((w) => /^\d{1,5}$/.test(w));
  const na = nums(ta), nb = nums(tb);
  if (!na.length || !nb.length) return null;
  return na.some((n) => nb.includes(n));
}

/** IPTU/cadastro de OUTRO imóvel: compara cada documento de IPTU com o imóvel do cliente (cadastro imobiliário/matrícula em nome do participante primeiro). Devolve o texto do problema por documento. Pura (testável). */
export function iptuDeOutroImovel(docs: DocReview[]): Map<DocReview, string> {
  const out = new Map<DocReview, string>();
  const ehIptu = (r: DocReview) => /IPTU|CADASTRO IMOBILIARIO/.test(r.tipo.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase());
  const iptus = docs.filter((r) => ehIptu(r) && (r.endereco || r.inscricao));
  if (!iptus.length) return out;
  const emNomeDoCliente = (r: DocReview) => r.donoSituacao === 'PARTICIPANTE';
  const refs = [
    ...docs.filter((r) => /CADASTRO IMOBILIARIO/.test(r.tipo.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase()) && emNomeDoCliente(r) && (r.endereco || r.inscricao)),
    ...docs.filter((r) => /^(MATRICULA|CERTIDAO DE ONUS)/.test(r.tipo) && r.endereco),
  ];
  for (const r of iptus) {
    for (const ref of refs) {
      if (ref === r) continue;
      if (sameProperty(r, ref) === false) {
        out.set(r, `esse IPTU é de outro imóvel${r.endereco ? ` (${r.endereco})` : ''} — o seu é ${ref.endereco ? cleanText(ref.endereco, 85) : 'o imóvel da proposta'}. Manda o IPTU do imóvel da proposta`);
        break;
      }
    }
  }
  return out;
}

/** Lê os documentos que ainda não foram lidos e devolve a situação atual de cada um. */
export async function reviewReceivedDocs(accountId: string, leadId: string): Promise<ReviewSummary | null> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true, pipeline: { select: { department: { select: { name: true } } } } } });
  if (!lead) return null;
  const atts = (await prisma.messageAttachment.findMany({
    where: { leadId, message: { direction: 'INBOUND' } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, driveFileId: true, data: true, mimeType: true, fileName: true, createdAt: true },
  })).filter((a) => !/^(audio|video)\//.test(a.mimeType) && !isStickerAttachment(a) && !isScreenshotAttachment(a));
  if (!atts.length) return null;

  const info = await getDocInfo(accountId, leadId, atts); // classificação barata: pula o que não é documento
  const cf0 = (lead.customFields || {}) as Record<string, any>;
  const cache: Record<string, DocReview> = { ...((cf0._docReview as Record<string, DocReview>) || {}) };
  let context = participantsContext(cf0, lead.name, lead.pipeline?.department?.name || '');
  // Já perguntamos de quem é o imóvel: com texto novo do cliente depois da pergunta, relê o documento com a conversa (a resposta dele decide).
  const donoPerguntadoEm: string | undefined = cf0._donoAskedAt;
  let releDono = false;
  if (donoPerguntadoEm) {
    releDono = (await prisma.message.count({ where: { leadId, direction: 'INBOUND', createdAt: { gt: new Date(donoPerguntadoEm) }, content: { not: '' }, attachments: { none: {} } } })) > 0;
    context = `${context}\n\nCONVERSA RECENTE:\n${await recentConversation(leadId)}`;
  }
  const learned = await learnedDocRules(accountId).catch(() => '');
  const novas: ReviewSummary['novas'] = [];
  // O leitor completo (com raciocínio) acerta mais que o classificador barato: documento do IMÓVEL que o classificador tratou como pessoal
  // (capa de IPTU lida como "comprovante de residência" em nome de empresa — Maria Antônia, 15/10) passa a valer pelo que o leitor disse.
  const infoFix: Record<string, string> = {};
  for (const a of atts) {
    const reler = releDono && cache[a.id]?.donoSituacao === 'OUTRO_SEM_RELACAO';
    // Leitura antiga de documento da PREFEITURA (IPTU/cadastro) sem o campo "metragens": relê uma vez pra saber se ele mostra as metragens (Fabio 20/10).
    const semMetragens = !!cache[a.id] && /IPTU|CADASTRO IMOBILIARIO/.test(String(cache[a.id].tipo || '')) && cache[a.id].metragens === undefined;
    if ((cache[a.id] && !reler && !semMetragens) || info[a.id] === null || info[a.id] === undefined) continue;
    let r = await reviewAttachment(accountId, a, context, { learned });
    if (!r) continue;
    // Renda DISPENSADA neste card (marca _rendaDispensada, Fabio 21/10 — Luiz): documento de renda não tem o que conferir — sem problema e sem pergunta à equipe (o extrato de abril virou "dúvida" à toa).
    if (cf0._rendaDispensada && /EXTRATO BANC|CONTRACHEQUE|HOLERITE|IMPOSTO DE RENDA|DECLARACAO DE RENDA|COMPROVANTE DE RENDA/.test(String(r.tipo || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')) && (r.resultado === 'DUVIDA' || r.resultado === 'PROBLEMA')) {
      r = { ...r, resultado: 'OK', problemas: [], duvida: '', observacao: `${r.observacao ? r.observacao + ' ' : ''}(renda dispensada neste card)`.trim() };
    }
    cache[a.id] = r;
    novas.push({ arquivo: a.fileName || a.id, r, attId: a.id });
    const tipoLido = r.tipo.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 ]/g, '').trim().toUpperCase();
    if (tipoLido && r.resultado !== 'NAO_DOCUMENTO' && isPropertyDocType(tipoLido) && !isPropertyDocType(info[a.id]!.type)) infoFix[a.id] = `${tipoLido}|`;
    if (r.resultado === 'DUVIDA') {
      // Não chuta: leva o documento e a pergunta pra equipe (balão "Dúvidas da IA"); uma pergunta por arquivo.
      const { createDocQuestion } = require('./ai-team-question.service') as typeof import('./ai-team-question.service');
      await createDocQuestion({ accountId, leadId, attachmentId: a.id, fileName: a.fileName || 'documento', docType: r.tipo, question: r.duvida || 'Não tenho segurança se este documento serve.' }).catch((e) => console.error('[DocReview] não abriu a dúvida:', e?.message || e));
    }
  }
  if (novas.length) {
    const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
    const freshCf = (fresh?.customFields || {}) as any;
    // Número da matrícula e cartório lidos no documento vão pro card (se ainda não estiverem preenchidos) — é o que a A&F precisa pra emitir a certidão.
    const mat = novas.map((n) => n.r).find((r) => r.matricula);
    const matCampos = mat && !String(freshCf.numero_matricula || '').trim() ? { numero_matricula: mat.matricula, ...(mat.cartorio && !String(freshCf.cartorio_registro || '').trim() ? { cartorio_registro: mat.cartorio } : {}) } : {};
    // MATRÍCULA ENCERRADA (16/10, Pedro: a certidão do cliente era da matrícula 383.297, encerrada na véspera; o apartamento ganhou a 438.308): marca no card pra IA e a conferência
    // saberem que a certidão NÃO vale e que a A&F precisa emitir a da matrícula nova — antes de pedir vistoria.
    const enc = novas.map((n) => n.r).find((r) => r.encerrada);
    let marcador: Record<string, unknown> = {};
    if (enc?.encerrada && !freshCf._matriculaEncerrada) {
      marcador = { _matriculaEncerrada: { antiga: enc.matricula || '', quando: enc.encerrada.quando || '', novas: enc.encerrada.novas, at: new Date().toISOString() } };
      await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🏛️ MATRÍCULA ENCERRADA: a certidão que o cliente enviou é da matrícula${enc.matricula ? ` nº ${enc.matricula}` : ''}, encerrada${enc.encerrada.quando ? ` em ${enc.encerrada.quando}` : ''}${enc.encerrada.novas.length ? `; o imóvel agora tem ${enc.encerrada.novas.join('; ')}` : ''}. Essa certidão NÃO serve: a A&F precisa emitir a certidão da matrícula NOVA (ONR) antes de solicitar a vistoria.` } }).catch(() => {});
    }
    // CONFERE O NÚMERO (Fabio 16/10): a matrícula/certidão lida tem que bater com a que o CLIENTE mandou (ou ser a mesma renumerada). Se não bate, o erro pode ser NOSSO (pedimos o número errado):
    // NÃO avisa o cliente — leva a pergunta pra equipe.
    const soDig = (x: string) => String(x || '').replace(/\D/g, '');
    const jaTinha = soDig(String(freshCf.numero_matricula || ''));
    const lida = novas.find((n) => n.r.matricula && n.r.tipo.startsWith('MATRIC'));
    if (jaTinha && lida && lida.attId) {
      const numeros = [lida.r.matricula!, ...(lida.r.anteriores || []), ...((lida.r.encerrada?.novas || []).map((x) => x.split(' ')[0]))].map(soDig).filter(Boolean);
      if (!numeros.includes(jaTinha)) {
        const { createDocQuestion } = require('./ai-team-question.service') as typeof import('./ai-team-question.service');
        await createDocQuestion({ accountId, leadId, attachmentId: lida.attId || '', fileName: lida.arquivo || 'matrícula', docType: 'MATRÍCULA', question: `O número desta matrícula (${lida.r.matricula}${(lida.r.anteriores || []).length ? `, antiga ${(lida.r.anteriores || []).join('/')}` : ''}) NÃO bate com o que o cliente mandou (${freshCf.numero_matricula}). Pode ter sido erro nosso ao pedir a certidão: confira qual é o número certo. Não avisei o cliente.` }).catch(() => {});
      }
    }
    await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...freshCf, ...matCampos, ...marcador, _docReview: cache, ...(Object.keys(infoFix).length ? { _docInfo: { ...(freshCf._docInfo || {}), ...infoFix } } : {}) } } });
  }

  // Situação atual: a leitura mais recente de cada tipo+titular (reenviou corrigido → o problema antigo some); RG/CNH somam os lados.
  const ordered = atts.map((a) => cache[a.id]).filter((r): r is DocReview => !!r && r.resultado !== 'NAO_DOCUMENTO' && r.resultado !== 'DUVIDA');
  const latest = new Map<string, DocReview>();
  const lados = new Map<string, Set<string>>();
  const isId = (r: DocReview) => /^(RG|CNH)\b/.test(r.tipo);
  for (const r of ordered) {
    // RG/CNH sem nome legível (ex.: foto só do verso): não vira documento à parte — o lado conta pro RG/CNH do titular que já chegou.
    if (isId(r) && !r.titular) {
      const donos = [...latest.entries()].filter(([, v]) => v.tipo === r.tipo);
      if (donos.length && r.lado && r.resultado === 'OK') {
        for (const [k] of donos) {
          const s = lados.get(k) || new Set<string>();
          if (r.lado === 'ambos') { s.add('frente'); s.add('verso'); } else s.add(r.lado);
          lados.set(k, s);
        }
      }
      continue;
    }
    latest.set(docKey(r), r);
    if (/^(RG|CNH)\b/.test(r.tipo) && r.lado && r.resultado === 'OK') {
      const s = lados.get(docKey(r)) || new Set<string>();
      if (r.lado === 'ambos') { s.add('frente'); s.add('verso'); } else s.add(r.lado);
      lados.set(docKey(r), s);
    }
  }
  const problemas: ReviewSummary['problemas'] = [];
  const ok: string[] = [];
  const iptuErrado = iptuDeOutroImovel([...latest.values()]);
  for (const [k, r] of latest) {
    const texto = r.resultado === 'PROBLEMA' ? [...r.problemas] : [];
    if (iptuErrado.has(r)) texto.push(iptuErrado.get(r)!);
    if (/^(RG|CNH)\b/.test(r.tipo) && r.resultado === 'OK') {
      const s = lados.get(k) || new Set<string>();
      if (!(s.has('frente') && s.has('verso'))) texto.push(`só chegou ${s.has('frente') ? 'a frente' : s.has('verso') ? 'o verso' : 'um lado'} — manda ${s.has('frente') ? 'também o verso' : s.has('verso') ? 'também a frente' : 'frente e verso'}`);
    }
    // Documento que "não serve pro processo" (ex.: declaração de quitação do condomínio — resposta da equipe) NÃO é um problema a corrigir: não trava a documentação nem volta a ser cobrado (Fabio 21/10).
    const bloqueantes = texto.filter((t) => !/n[ãa]o serve (pro|para o|para) processo/i.test(t));
    if (bloqueantes.length) problemas.push({ doc: docLabel(r), texto: bloqueantes });
    else ok.push(docLabel(r));
  }
  const duvidas = atts.filter((a) => cache[a.id]?.resultado === 'DUVIDA').map((a) => ({ attachmentId: a.id, arquivo: a.fileName || a.id, doc: cache[a.id].tipo || 'documento', pergunta: cache[a.id].duvida || '' }));
  // Dono do imóvel em nome de OUTRA pessoa sem vínculo explicado (a leitura mais recente de cada documento).
  const donoPendente: ReviewSummary['donoPendente'] = [];
  const vistos = new Set<string>();
  for (const a of (cf0._transferenciaPendente ? [] : [...atts].reverse())) { // cliente já disse que não transferiu a escritura: não pergunta de quem é o imóvel
    const r = cache[a.id];
    if (!r || r.donoSituacao !== 'OUTRO_SEM_RELACAO' || !r.dono || vistos.has(r.dono.toUpperCase())) continue;
    vistos.add(r.dono.toUpperCase());
    donoPendente.push({ attachmentId: a.id, doc: r.tipo, dono: r.dono });
  }
  return { novas, problemas, duvidas, donoPendente, ok };
}

/** Mensagem ao cliente com o que precisa ser corrigido (curta, educada, sem jargão). */
export function buildDocProblemsMessage(s: ReviewSummary): string {
  const linhas = s.problemas.map((p) => `⚠️ *${p.doc}* — ${p.texto.join('; ')}`);
  // Fabio 15/10: não repete o que já chegou certo — só o que precisa de ajuste.
  return `Preciso de um ajuste:\n\n${linhas.join('\n')}\n\nAssim que você reenviar, eu confiro de novo!`;
}

/** O banco não aceitou a certidão que o cliente mandou (muito antiga / só consulta) — sem campo, por ANOTAÇÃO no card (Fabio 15/10): o CRM anota sozinho quando o resultado do banco pede/recusa a certidão
 *  e esta função lê o marcador; anotação escrita por PESSOA (45 dias) citando certidão/matrícula, banco e não aceitação também vale. */
export async function bancoRecusouCertidao(leadId: string): Promise<boolean> {
  // O próprio CRM anota (marcador "🏛️ CERTIDÃO RECUSADA PELO BANCO", quando o resultado do banco pede/recusa a certidão) e lê aqui; anotação de pessoa também vale.
  const marcada = await prisma.note.findFirst({ where: { leadId, content: { startsWith: '🏛️ CERTIDÃO RECUSADA PELO BANCO' }, createdAt: { gte: new Date(Date.now() - 45 * 86_400_000) } }, select: { id: true } });
  if (marcada) return true;
  const notas = await prisma.note.findMany({ where: { leadId, userId: { not: null }, createdAt: { gte: new Date(Date.now() - 45 * 86_400_000) } }, orderBy: { createdAt: 'desc' }, take: 30, select: { content: true } });
  const sem = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return notas.some((n) => { const t = sem(n.content); return /(certidao|matricula|onus)/.test(t) && /(nao (foi )?aceit|nao aceita|nao aceitou|recusou|recusad|reprovou|muito antiga|simples consulta)/.test(t) && /(banco|inter|creditas|santander|caixa|bradesco|itau)/.test(t); });
}

/** Bloco pro prompt da IA de conversa: o que cada documento recebido tem de bom/ruim (só leitura). Vazio se nada foi conferido. */
export async function aiDocsContext(leadId: string): Promise<string> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cf = (lead?.customFields || {}) as Record<string, any>;
  const rev = (cf._docReview || {}) as Record<string, DocReview>;
  const items = Object.values(rev).filter((r) => r.resultado !== 'NAO_DOCUMENTO');
  if (!items.length) return '';
  const latest = new Map<string, DocReview>();
  for (const r of items) latest.set(docKey(r), r);
  const linhas = [...latest.values()].map((r) => `- ${docLabel(r)}: ${r.resultado === 'OK' ? 'OK' : r.resultado === 'DUVIDA' ? 'EM ANÁLISE PELA EQUIPE (não diga que está certo nem errado; diga que a equipe está conferindo e retorna)' : `PROBLEMA — ${r.problemas.join('; ')}`}${r.emissao ? ` (emissão ${r.emissao})` : ''}${r.lado ? ` [${r.lado}]` : ''}`);
  const falta = cf._docsFaltando ? `\nAinda falta (lista do banco): ${cf._docsFaltando}` : '';
  const recusada = (await bancoRecusouCertidao(leadId).catch(() => false)) ? '\nO BANCO NÃO ACEITOU a certidão de ônus/matrícula que o cliente enviou (muito antiga ou só consulta): avise o cliente e ofereça emitir uma nova pelo ONR (custo de R$ 40 a R$ 100, só com o OK dele).' : '';
  const me = cf._matriculaEncerrada as { antiga?: string; quando?: string; novas?: string[] } | undefined;
  const encerrada = me ? `\nMATRÍCULA ENCERRADA: a certidão que o cliente mandou é da matrícula${me.antiga ? ` nº ${me.antiga}` : ''}, que foi ENCERRADA${me.quando ? ` em ${me.quando}` : ''} — o imóvel agora tem ${(me.novas || []).join('; ') || 'matrícula nova'}. Essa certidão NÃO serve. A A&F vai EMITIR a certidão da matrícula nova (por isso a vistoria só depois). Se o cliente perguntar, explique isso com calma; NÃO peça que ele tire outra no cartório e NÃO diga que a vistoria já foi solicitada com essa matrícula.` : '';
  return `DOCUMENTOS DESTE CLIENTE (a IA LEU os arquivos que ele mandou — frente/verso, legibilidade, validade e titular):\n${linhas.join('\n')}${falta}${recusada}${encerrada}`;
}

export const DOCS_REVIEW_RULES = `DOCUMENTOS — quando o bloco "DOCUMENTOS DESTE CLIENTE" aparecer abaixo, ele traz o que a IA leu dos arquivos que o cliente mandou. Use SÓ ele pra dizer se um documento está certo ou o que falta corrigir ("tá certo?", "faltou alguma coisa?"): nunca diga que um documento está OK se ele não está no bloco como OK, e nunca invente defeito. Se o cliente perguntar de um documento que NÃO está no bloco, diga que ainda não chegou/ainda está sendo conferido. Quando houver PROBLEMA, peça só o ajuste que o bloco descreve, em 1 frase curta. A conferência automática já avisa o cliente do que precisa corrigir quando ele manda os arquivos — não repita a mesma cobrança se ela já está na conversa. NUNCA enumere os documentos que já chegaram ("recebi X e Y"): se falar de documentos, cite só o que FALTA ou o que está com PROBLEMA (Fabio 15/10). Cliente que AVISA "já enviei os documentos" (botão do lembrete ou texto): NUNCA responda só "recebi, tô conferindo" — olhe o bloco DOCUMENTOS e peça exatamente o que falta ou está com problema (ex.: "falta o verso da CNH"); se o bloco não mostra falta nenhuma, diga que conferiu e que a documentação segue (Fabio 16/10).`;
