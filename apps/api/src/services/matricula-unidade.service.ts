import { prisma } from '../lib/prisma';

/**
 * MATRÍCULA DO TERRENO × MATRÍCULA DA UNIDADE (Fabio 14/11, Nalia — apartamento na planta, matrícula 416.028 tirada do contrato e IPTU ainda do lote inteiro):
 * "caso seja [a do terreno], o CRM deve conferir a matrícula solicitada e verificar nessa matrícula se há a unidade da cliente com o número da matrícula e solicita uma nova
 * com a matrícula correta da cliente". Roda quando sai a certidão de um APARTAMENTO (certidao-followup.afterCertidaoSaved):
 *  - é a matrícula da UNIDADE → segue o fluxo normal;
 *  - é a do TERRENO/empreendimento e ela traz a matrícula aberta pra unidade da cliente → grava o número no card e pede a certidão dessa matrícula (PIX ao cliente, em mensagem
 *    separada);
 *  - é a do TERRENO e não achei a da unidade → nota + push pra equipe conferir.
 * Em todos os casos a certidão do terreno VAI ao cliente, com a explicação (Fabio 14/11: "toda certidão que for emitida por nós deve ser encaminhada ao cliente").
 */

type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | undefined;
export type LeituraMatricula = { tipo: 'UNIDADE' | 'TERRENO' | 'OUTRO'; matriculaUnidade: string; unidadeEncontrada: string; observacao: string };

const SYSTEM = `Você lê uma CERTIDÃO DE MATRÍCULA / ÔNUS de cartório de registro de imóveis. O cliente comprou um APARTAMENTO (unidade autônoma). Responda SOMENTE com JSON:
{"tipo":"UNIDADE|TERRENO|OUTRO","matriculaUnidade":"<número da matrícula aberta para a unidade do cliente, só dígitos e pontos; vazio se não aparecer>","unidadeEncontrada":"<como a unidade do cliente aparece no documento (ex.: apartamento 72 da Torre 2); vazio se não aparecer>","observacao":"<1 frase>"}
- "UNIDADE": a matrícula descreve UMA unidade autônoma (apartamento/sala/vaga) com área privativa e fração ideal própria.
- "TERRENO": a matrícula é do terreno/lote ou do EMPREENDIMENTO inteiro (matrícula-mãe): descreve o terreno, a incorporação, a instituição de condomínio ou várias unidades.
- Se for "TERRENO", procure nas averbações/registros (abertura de matrículas das unidades, instituição/especificação do condomínio, "matrícula nº … referente ao apartamento …") a matrícula aberta para a UNIDADE DO CLIENTE descrita na mensagem. Só preencha "matriculaUnidade" se o documento ligar claramente esse número a essa unidade. Não invente.`;

/** Número da matrícula normalizado (só dígitos). Pura. */
export const soDigitos = (m: string) => String(m || '').replace(/\D/g, '');

/** O que descreve a unidade da cliente, juntando o card e a leitura dos documentos (contrato, IPTU…). Pura (testável). */
export function descricaoDaUnidade(cf: Record<string, any>): string {
  const partes = [cf.imovel_complemento && `complemento ${cf.imovel_complemento}`, cf.endereco_imovel && `endereço ${cf.endereco_imovel}`];
  for (const r of Object.values((cf._docReview || {}) as Record<string, any>)) {
    const t = `${r?.observacao || ''} ${(r?.problemas || []).join(' ')}`;
    const m = /(unidade|apartamento|apto|torre|bloco)[^.;]{0,80}/i.exec(t);
    if (m) partes.push(m[0]);
  }
  return Array.from(new Set(partes.filter(Boolean) as string[])).join(' | ').slice(0, 600);
}

async function lerMatricula(pdf: Buffer, unidade: string): Promise<LeituraMatricula | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || pdf.length > 10_000_000) return null;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 4096,
      system: SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') } }, { type: 'text', text: `Unidade do cliente (do contrato/card): ${unidade || '(não informada)'}` }] }],
    }),
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const data = (await res.json().catch(() => null)) as { content?: { type: string; text?: string }[] } | null;
  try {
    const j = JSON.parse((data?.content?.find((c) => c.type === 'text')?.text || '').match(/\{[\s\S]*\}/)?.[0] || '{}');
    const tipo = ['UNIDADE', 'TERRENO', 'OUTRO'].includes(j.tipo) ? j.tipo : 'OUTRO';
    return { tipo, matriculaUnidade: String(j.matriculaUnidade || '').trim(), unidadeEncontrada: String(j.unidadeEncontrada || '').trim().slice(0, 120), observacao: String(j.observacao || '').trim().slice(0, 300) };
  } catch { return null; }
}

/** Certidão do TERRENO: o CRM trata (pede a da unidade ou avisa a equipe) e devolve o TEXTO que acompanha a certidão ao cliente. null = é a da unidade (fluxo normal). */
export async function conferirMatriculaDaUnidade(p: { accountId: string; leadId: string; requestId: string; matricula: string; pdf: Buffer; io?: Io }): Promise<string | null> {
  const lead = await prisma.lead.findFirst({ where: { id: p.leadId, accountId: p.accountId }, select: { name: true, customFields: true } });
  if (!lead) return null;
  const cf = (lead.customFields || {}) as Record<string, any>;
  const { apartamentoPelosDocumentos } = require('./laudo-ask.service') as typeof import('./laudo-ask.service');
  if (!/apart/i.test(String(cf.imovel_tipo || '')) && !apartamentoPelosDocumentos(cf)) return null; // só apartamento
  const unidade = descricaoDaUnidade(cf);
  const r = await lerMatricula(p.pdf, unidade);
  if (!r || r.tipo !== 'TERRENO') return null;
  const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
  const nome = callableFirstName(cf.falando_com, cf.nome_social_1, cf.participante_1, lead.name) || '';
  const abre = `${nome ? `${nome}, s` : 'S'}aiu a certidão da matrícula ${p.matricula}, mas ela é do terreno do prédio, e não da sua unidade. Segue em anexo mesmo assim.`;
  const note = (content: string) => prisma.note.create({ data: { leadId: p.leadId, type: 'COMMENT', content } }).catch(() => {});
  const push = (title: string, body: string) => { try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(p.accountId, { title, body, leadId: p.leadId }).catch(() => {}); } catch { /* aviso */ } };
  const nova = soDigitos(r.matriculaUnidade);
  if (!nova || nova === soDigitos(p.matricula)) {
    await note(`🏢 A certidão da matrícula ${p.matricula} é do TERRENO/empreendimento, não da unidade da cliente${r.observacao ? ` (${r.observacao})` : ''}, e não achei nela a matrícula aberta pro apartamento (${unidade || 'unidade não identificada'}). A certidão foi à cliente com a explicação; confira no PDF (pasta IMOVEL) qual é a matrícula da unidade e peça a certidão dela.`);
    push(`🏢 ${lead.name}: certidão é do terreno`, 'Não achei a matrícula da unidade nela — confira e peça a certidão certa.');
    return `${abre}\n\nA gente vai conferir qual é a matrícula do seu apartamento e te avisa por aqui.`;
  }
  const req = await prisma.certidaoRequest.findUnique({ where: { id: p.requestId }, select: { uf: true, cidade: true, cartorio: true } });
  if (!req) return `${abre}\n\nA gente vai pedir a certidão da matrícula do seu apartamento (nº ${r.matriculaUnidade}) e te avisa por aqui.`;
  const ja = await prisma.certidaoRequest.findFirst({ where: { leadId: p.leadId, matricula: { in: [nova, r.matriculaUnidade] }, status: { notIn: ['CANCELLED', 'FAILED'] } }, select: { id: true } });
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{numero_matricula}', to_jsonb(${r.matriculaUnidade}::text), true) WHERE id = ${p.leadId}`;
  if (ja) {
    await note(`🏢 A certidão da matrícula ${p.matricula} é do terreno; a da unidade (${r.unidadeEncontrada || 'apartamento da cliente'}) é a matrícula ${r.matriculaUnidade}, que já tem pedido em andamento.`);
    return `${abre}\n\nA certidão da matrícula do seu apartamento (nº ${r.matriculaUnidade}) já está pedida.`;
  }
  try {
    const { createCertidaoRequest } = require('./certidao.service') as typeof import('./certidao.service');
    await createCertidaoRequest(prisma as any, { accountId: p.accountId, leadId: p.leadId, uf: req.uf, cidade: req.cidade, cartorio: req.cartorio, matricula: nova, source: 'AI', sendPix: true, clientIntro: 'segue o PIX da certidão da matrícula do seu apartamento' });
    await note(`🏢 A certidão da matrícula ${p.matricula} é do TERRENO/empreendimento. Nela, ${r.unidadeEncontrada || 'a unidade da cliente'} tem a matrícula ${r.matriculaUnidade}: gravei no card e pedi a certidão dessa matrícula (o PIX vai à cliente em mensagem separada). A do terreno foi à cliente com a explicação.`);
    push(`🏢 ${lead.name}: pedi a certidão da unidade`, `A ${p.matricula} era do terreno; pedida a da unidade (${r.matriculaUnidade}).`);
    return `${abre}\n\nJá pedi a certidão certa, da matrícula do seu apartamento (nº ${r.matriculaUnidade}): o PIX dela chega aqui em seguida.`;
  } catch (e: any) {
    await note(`⚠️ A certidão da matrícula ${p.matricula} é do terreno; a da unidade é a ${r.matriculaUnidade}, mas não consegui pedir a certidão dela: ${e?.message || e}. Peça pelo card.`);
    push(`⚠️ ${lead.name}: certidão da unidade não pedida`, String(e?.message || e).slice(0, 100));
    return `${abre}\n\nA gente vai pedir a certidão da matrícula do seu apartamento (nº ${r.matriculaUnidade}) e te avisa por aqui.`;
  }
}
