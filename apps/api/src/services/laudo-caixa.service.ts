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
export async function gravarLaudoCaixa(accountId: string, leadId: string, b: { etapa?: string; erro?: string; situacao?: string; laudoStatus?: string; os?: string; laudo?: Cf; pdf?: { nome?: string; base64?: string } }): Promise<void> {
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
  const status = garantia === false ? 'REPROVADO' : 'SALVO';
  await salvarL(leadId, (x) => { x.status = status; x.situacao = b.situacao || null; x.laudoStatus = b.laudoStatus || null; x.os = b.os || x.os || null; x.laudo = { ...lau, garantiaValida: garantia }; x.driveId = driveId; x.pdfNome = b.pdf?.nome || null; x.fim = new Date().toISOString(); delete x.inicio; delete x.proximaEm; });
  if (antes.status === status && antes.driveId) return; // já anotado
  const linhas = [
    `• Imóvel válido como garantia (engenheiro): ${garantia === true ? '✅ SIM' : garantia === false ? '❌ NÃO' : `— (${lau.garantia || 'não li'})`}`,
    `• Valor atribuído: ${brl(lau.valorAtribuido)} · compra e venda: ${brl(lau.compraVenda)}`,
    `• Laudo de ${lau.dataPeca || '—'}, válido até ${lau.validade || '—'}${lau.prazo ? ` (${lau.prazo})` : ''}`,
    lau.empresa ? `• Engenharia: ${lau.empresa}` : '',
  ].filter(Boolean);
  await note(leadId, `🏠 LAUDO DA CAIXA — OS${b.os ? ` ${b.os}` : ''} ${b.situacao || ''}${b.laudoStatus ? ` (laudo ${b.laudoStatus})` : ''}\n${linhas.join('\n')}\n${driveId ? '📄 PDF do laudo salvo na pasta IMOVEL do Drive (LAUDO VISTORIA CAIXA.pdf).' : pdfOk ? '⚠️ Não consegui salvar o PDF no Drive (o card tem a pasta?).' : '⚠️ A extensão não conseguiu baixar o PDF do laudo do SIOPI.'}`);
  push(accountId, garantia === false ? `❌ ${l.name}: laudo NÃO aceitou a garantia` : `🏠 ${l.name}: laudo da CAIXA pronto`, garantia === false ? 'O engenheiro não validou o imóvel como garantia — confira o laudo.' : `Garantia ${garantia ? 'aceita' : '?'} · valor atribuído ${brl(lau.valorAtribuido)}`, leadId);
}
