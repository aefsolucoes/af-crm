import { prisma } from '../lib/prisma';

/* ── LAUDO da vistoria da CAIXA (Fabio 18/11, Fernanda: "Já salvou o laudo na pasta dela? Precisa checar se o laudo foi aceito como garantia pelo engenheiro").
 * Depois do boleto da vistoria (`_vistoriaCaixa.status = ENVIADA`), a extensão "SIOPI (A&F)" confere a OS pelo código do imóvel (Individual → Ordens de Serviço do
 * imóvel). OS Concluída com laudo → Dados de Engenharia (valor atribuído, compra e venda, "Imóvel Válido como Garantia?", data e validade do laudo) + o PDF do laudo
 * (anexo "Laudo de Engenharia Credenciado" da OS) → pasta IMOVEL ("LAUDO VISTORIA CAIXA.pdf") + anotação + push. Sem laudo ainda → confere de novo em 6 h.
 * Estado próprio: `_laudoCaixa` = { status: FILA | RODANDO | AGUARDANDO | SALVO | REPROVADO | ERRO, codigoImovel, situacao, laudo, driveId, proximaEm, tentativas }. */

type Cf = Record<string, any>;
const LEASE_MS = 10 * 60_000;
const RECHECAR_MS = 6 * 3600_000;

async function salvarL(leadId: string, mut: (c: Cf) => void): Promise<Cf> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const c: Cf = { ...(((l?.customFields || {}) as Cf)._laudoCaixa || {}) };
  mut(c);
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_laudoCaixa}', ${JSON.stringify(c)}::jsonb, true) WHERE id = ${leadId}`;
  return c;
}
const note = (leadId: string, content: string) => prisma.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});
const push = (accountId: string, title: string, body: string, leadId: string) => {
  try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title, body: body.slice(0, 180), leadId }).catch(() => {}); } catch { /* só aviso */ }
};
const brl = (v: unknown) => { const n = Number(String(v ?? '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.')); return n > 0 ? n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : String(v || '—'); };

/** O laudo em PDF lido pela IA (Fabio 18/11: "ou se deu alguma pendência — isso é essencial para prosseguir com a proposta"): conclusão, garantia e TODA pendência/
 *  ressalva que o engenheiro apontou (documentação, área, habite-se/averbação, construção irregular, condicionantes). Só o que está escrito. null = não leu. */
async function lerLaudoPdf(base64: string): Promise<{ garantiaAceita: boolean | null; conclusao: string; pendencias: string[]; ressalvas: string[]; observacoes: string } | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !base64 || base64.length > 27_000_000) return null;
  const system = `Você lê um LAUDO DE AVALIAÇÃO DE IMÓVEL da CAIXA (engenharia credenciada) pra um correspondente bancário que vai seguir com a contratação do financiamento. Extraia SÓ o que está escrito. Responda SOMENTE com JSON:
{"garantiaAceita":true|false|null,"conclusao":"<a conclusão do laudo, curta>","pendencias":["<cada PENDÊNCIA, exigência, condicionante ou impedimento que precisa ser resolvido antes da contratação — documental (matrícula/averbação/habite-se/área divergente), construção irregular/ampliação não averbada, ocupação, risco, etc.>"],"ressalvas":["<observações/ressalvas que não impedem, mas o colaborador deve saber>"],"observacoes":"<algo importante que não coube acima, ou vazio>"}
"garantiaAceita" = o laudo diz que o imóvel é aceito/válido como garantia (true), recusado/inaceitável (false), ou não diz (null). Sem pendência escrita → "pendencias": [].`;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 2500, system, messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }, { type: 'text', text: 'Leia o laudo e responda o JSON.' }] }] }),
  }).catch(() => null);
  if (!res || !res.ok) return null;
  try {
    const data = (await res.json()) as { content: { type: string; text?: string }[] };
    const j = JSON.parse((data.content?.find((b) => b.type === 'text')?.text || '').match(/\{[\s\S]*\}/)?.[0] || '');
    const lista = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 15) : []);
    return { garantiaAceita: typeof j.garantiaAceita === 'boolean' ? j.garantiaAceita : null, conclusao: String(j.conclusao || '').slice(0, 600), pendencias: lista(j.pendencias), ressalvas: lista(j.ressalvas), observacoes: String(j.observacoes || '').slice(0, 600) };
  } catch { return null; }
}

/** A equipe pede a conferência do laudo agora (botão/rota). */
export async function pedirLaudoCaixa(accountId: string, leadId: string, por: string): Promise<string | null> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  if (!l) return 'Lead não encontrado';
  const vc = (((l.customFields || {}) as Cf)._vistoriaCaixa || {}) as Cf;
  if (!vc.codigoImovel) return 'O card não tem o código do imóvel no SIOPI (a vistoria da CAIXA não foi pedida pelo CRM)';
  await salvarL(leadId, (x) => { x.status = 'FILA'; x.pedidoEm = new Date().toISOString(); x.por = por; x.tentativas = 0; x.codigoImovel = vc.codigoImovel; delete x.inicio; });
  return null;
}

/** Próximo laudo pra extensão: pedido pela equipe, ou vistoria com boleto enviado e laudo ainda não salvo (de 6 em 6 h). */
export async function proximoLaudoCaixa(accountId: string): Promise<any | null> {
  const agora = new Date().toISOString();
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false
      AND COALESCE("customFields"->'_vistoriaCaixa'->>'codigoImovel', '') <> ''
      AND (
        "customFields"->'_laudoCaixa'->>'status' IN ('FILA', 'RODANDO')
        OR ("customFields"->'_vistoriaCaixa'->>'status' = 'ENVIADA' AND "customFields"->'_laudoCaixa' IS NULL)
        OR ("customFields"->'_laudoCaixa'->>'status' IN ('AGUARDANDO', 'ERRO') AND COALESCE("customFields"->'_laudoCaixa'->>'proximaEm', '') <= ${agora})
      )
    ORDER BY COALESCE("customFields"->'_laudoCaixa'->>'pedidoEm', "customFields"->'_vistoriaCaixa'->>'atualizadoEm') ASC LIMIT 5`;
  for (const { id } of ids) {
    const l = await prisma.lead.findUnique({ where: { id }, select: { name: true, customFields: true } });
    const cf = (l?.customFields || {}) as Cf;
    const st = (cf._laudoCaixa || {}) as Cf;
    if (st.status === 'RODANDO' && st.inicio && Date.now() - Date.parse(st.inicio) < LEASE_MS) return null; // um por vez
    if ((st.tentativas || 0) >= 3 && ['RODANDO', 'ERRO'].includes(st.status)) { await salvarL(id, (x) => { x.status = 'ERRO'; x.proximaEm = new Date(Date.now() + RECHECAR_MS).toISOString(); x.tentativas = 0; }); continue; }
    const codigo = String(cf._vistoriaCaixa?.codigoImovel || '');
    await salvarL(id, (x) => { x.status = 'RODANDO'; x.inicio = new Date().toISOString(); x.tentativas = (x.tentativas || 0) + 1; x.codigoImovel = codigo; });
    return { tipo: 'laudo', leadId: id, leadName: l!.name, codigoImovel: codigo, os: cf._vistoriaCaixa?.os?.numero || null };
  }
  return null;
}

/** Retorno da extensão. */
export async function gravarLaudoCaixa(accountId: string, leadId: string, b: { etapa?: string; erro?: string; situacao?: string; laudoStatus?: string; os?: string; laudo?: Cf; pdf?: { nome?: string; base64?: string }; pendOs?: Cf | null; blocoPend?: string; dadosEng?: string; erroPdf?: string }): Promise<void> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true } });
  if (!l) return;
  const cf = (l.customFields || {}) as Cf;
  const antes = (cf._laudoCaixa || {}) as Cf;
  if (b.etapa === 'AGUARDANDO_LOGIN') { await salvarL(leadId, (x) => { x.status = 'FILA'; delete x.inicio; }); return; }
  if (b.etapa === 'ERRO' || b.erro) {
    await salvarL(leadId, (x) => { x.status = 'ERRO'; x.erro = String(b.erro || 'erro').slice(0, 300); x.fim = new Date().toISOString(); x.proximaEm = new Date(Date.now() + 30 * 60_000).toISOString(); delete x.inicio; });
    if (antes.status === 'FILA' || (antes.tentativas || 0) >= 2) await note(leadId, `⚠️ Laudo da CAIXA: a extensão não conseguiu conferir a OS no SIOPI — ${b.erro || 'erro'}. Tento de novo em 30 min.`);
    return;
  }
  const lau = b.laudo || null;
  if (!lau) {
    // OS ainda sem laudo (Emitida, Vistoria Concluída…): confere de novo em 6 h. Anota só quando a situação muda.
    await salvarL(leadId, (x) => { x.status = 'AGUARDANDO'; x.situacao = b.situacao || null; x.laudoStatus = b.laudoStatus || null; x.os = b.os || x.os || null; x.fim = new Date().toISOString(); x.proximaEm = new Date(Date.now() + RECHECAR_MS).toISOString(); delete x.inicio; x.tentativas = 0; });
    if (antes.situacao !== b.situacao || antes.status === 'FILA') await note(leadId, `🏠 Laudo da CAIXA: a OS${b.os ? ` ${b.os}` : ''} está "${b.situacao || '—'}"${b.laudoStatus ? ` (laudo: ${b.laudoStatus})` : ''} no SIOPI — ainda sem laudo. Confiro de novo em 6 h.`);
    return;
  }
  // Laudo pronto: PDF na pasta IMOVEL.
  let driveId: string | null = null;
  const data = Buffer.from(String(b.pdf?.base64 || ''), 'base64');
  const pdfOk = data.length > 1000 && data.subarray(0, 4).toString('latin1') === '%PDF';
  const link = String(cf.link_pasta_drive || '').trim();
  if (pdfOk && link) {
    try {
      const google = await import('./google.service');
      const pasta = await google.createFolder(accountId, 'IMOVEL', google.extractFolderId(link));
      const nome = 'LAUDO VISTORIA CAIXA.pdf';
      for (const velho of (await google.listFolderContents(accountId, pasta.id)).filter((f: any) => f.name === nome)) await google.trashDriveItem(accountId, velho.id).catch(() => {});
      driveId = (await google.uploadFile(accountId, { name: nome, mimeType: 'application/pdf', parentId: pasta.id, data })).id;
    } catch (e: any) { console.error('[Laudo CAIXA] Drive', e?.message); }
  }
  const garantia = /^s(im)?$/i.test(String(lau.garantia || '').trim()) ? true : /^n(ao|ão)?$/i.test(String(lau.garantia || '').trim()) ? false : null;
  // Pendências (Fabio 18/11: "isso é essencial para prosseguir com a proposta"): as marcas da OS + o que o engenheiro escreveu no laudo (lido pela IA).
  const sim = (v: unknown) => /^s(im)?\b/i.test(String(v || '').trim());
  const po = (b.pendOs || {}) as Cf;
  const leitura = pdfOk ? await lerLaudoPdf(String(b.pdf?.base64 || '')).catch(() => null) : null;
  const marcas = [sim(po.existePendencia) || sim(lau.existePendencia) ? `a OS diz "Existe Pendência: Sim"${b.blocoPend ? ` — ${String(b.blocoPend).replace(/\s+/g, ' ').slice(0, 300)}` : ''}` : '', sim(po.validacaoCaixa) ? 'a OS "Necessita de Validação CAIXA"' : '', sim(po.revisaoLaudo) ? 'o laudo está em "Revisão do Laudo"' : '', /inv[áa]lid|vencid/i.test(String(b.laudoStatus || '')) ? `o laudo está "${b.laudoStatus}"` : ''].filter(Boolean);
  const pendencias = [...marcas, ...(leitura?.pendencias || [])];
  const garantiaFinal = garantia ?? leitura?.garantiaAceita ?? null;
  const status = garantiaFinal === false ? 'REPROVADO' : pendencias.length ? 'PENDENCIA' : 'SALVO';
  await salvarL(leadId, (x) => { x.status = status; x.situacao = b.situacao || null; x.laudoStatus = b.laudoStatus || null; x.os = b.os || x.os || null; x.laudo = { ...lau, garantiaValida: garantiaFinal }; x.pendencias = pendencias; x.ressalvas = leitura?.ressalvas || []; x.conclusao = leitura?.conclusao || null; x.pendOs = po; x.leuPdf = !!leitura; x.driveId = driveId; x.pdfNome = b.pdf?.nome || null; x.erroPdf = pdfOk ? null : String(b.erroPdf || 'sem PDF').slice(0, 200); x.fim = new Date().toISOString(); delete x.inicio; delete x.proximaEm; delete x.erro; });
  // Valor do laudo no card (Fabio 18/11: "precisa preencher o valor do laudo no campo valor laudo") — campo "Valor de avaliação" (chave valor_de_avaliacao).
  const valorLaudo = Number(String(lau.valorAtribuido || '').replace(/[^\d,]/g, '').replace(',', '.'));
  const valorAntes = String(cf.valor_de_avaliacao ?? '').trim();
  if (valorLaudo > 0 && Number(valorAntes.replace(/[^\d.]/g, '')) !== valorLaudo) {
    await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{valor_de_avaliacao}', to_jsonb(${String(valorLaudo)}::text), true) WHERE id = ${leadId}`;
    await note(leadId, `✏️ Valor de avaliação do card = ${brl(lau.valorAtribuido)} (valor atribuído no laudo da CAIXA)${valorAntes ? ` — era ${valorAntes}` : ''}.`);
  }
  if (antes.status === status && antes.driveId && antes.leuPdf) return; // já anotado (com o PDF salvo e lido)
  const linhas = [
    `• Imóvel válido como garantia (engenheiro): ${garantiaFinal === true ? '✅ SIM' : garantiaFinal === false ? '❌ NÃO' : `— (${lau.garantia || 'não li'})`}`,
    `• Pendências: ${pendencias.length ? `⚠️ ${pendencias.length}\n${pendencias.map((p) => `   – ${p}`).join('\n')}` : `✅ nenhuma (OS: pendência ${po.existePendencia || lau.existePendencia || '—'}, validação CAIXA ${po.validacaoCaixa || '—'}, revisão ${po.revisaoLaudo || '—'}${leitura ? '; laudo lido' : '; o PDF não foi lido'})`}`,
    leitura?.ressalvas?.length ? `• Ressalvas do laudo:\n${leitura.ressalvas.map((r) => `   – ${r}`).join('\n')}` : '',
    leitura?.conclusao ? `• Conclusão: ${leitura.conclusao}` : '',
    `• Valor atribuído: ${brl(lau.valorAtribuido)} · compra e venda: ${brl(lau.compraVenda)}`,
    `• Laudo de ${lau.dataPeca || '—'}, válido até ${lau.validade || '—'}${lau.prazo ? ` (${lau.prazo})` : ''}`,
    lau.empresa ? `• Engenharia: ${lau.empresa}` : '',
  ].filter(Boolean);
  const veredito = status === 'SALVO' ? '✅ Laudo sem pendência — pode seguir com a proposta no SIOPI.' : status === 'PENDENCIA' ? '⚠️ Laudo COM PENDÊNCIA — resolver antes de seguir com a proposta.' : '❌ O engenheiro NÃO aceitou o imóvel como garantia — não seguir com a proposta.';
  await note(leadId, `🏠 LAUDO DA CAIXA — OS${b.os ? ` ${b.os}` : ''} ${b.situacao || ''}${b.laudoStatus ? ` (laudo ${b.laudoStatus})` : ''}\n${veredito}\n${linhas.join('\n')}\n${driveId ? '📄 PDF do laudo salvo na pasta IMOVEL do Drive (LAUDO VISTORIA CAIXA.pdf).' : pdfOk ? '⚠️ Não consegui salvar o PDF no Drive (o card tem a pasta?).' : '⚠️ A extensão não conseguiu baixar o PDF do laudo do SIOPI.'}`);
  push(accountId, status === 'REPROVADO' ? `❌ ${l.name}: laudo NÃO aceitou a garantia` : status === 'PENDENCIA' ? `⚠️ ${l.name}: laudo com pendência` : `🏠 ${l.name}: laudo sem pendência`, status === 'REPROVADO' ? 'O engenheiro não validou o imóvel como garantia — confira o laudo.' : status === 'PENDENCIA' ? pendencias.join(' · ') : `Garantia aceita · valor atribuído ${brl(lau.valorAtribuido)} — pode seguir com a proposta`, leadId);
}
