import { prisma } from '../lib/prisma';
import { logActivity } from './activity.service';

/* MINUTA na escritura/registro (Fabio 28/10): "a gente irá receber a minuta do cliente na fase de escritura/registro; nessa etapa o CRM deve buscar essa pasta
 * escrito MINUTA, deverá ler e corrigir os valores de crédito e de compra e venda para ajustar no card". Home Equity não tem entrada.
 *  - Cards ABERTOS nos funis "Em contratação" da Análise Jurídica em diante (Análise Jurídica, Registro em Cartório, Pagamento ao Vendedor) com a pasta do
 *    Drive no card (`link_pasta_drive`): procura arquivo dentro de uma pasta "MINUTA" (ou com "minuta" no nome), até 3 níveis.
 *  - Lê com a IA (PDF direto; Word/Google Docs pelo texto) e corrige no card: crédito (valor_credito + Valor da venda) e, no Financiamento, compra e venda
 *    (valor_imovel) e entrada (compra e venda − financiado). Valor de avaliação, quando vier. Provisão de comissão em aberto: a base passa a ser o crédito da minuta.
 *  - Cada arquivo é lido uma vez (`_minuta.lidos`); minuta nova (outra versão) é lida de novo. Nota no card com "era X" + push. Só age quando há alteração (abaixo).
 *  - Padrão da pasta (Fabio 29/10: "se não tiver a pasta MINUTA, renomeia para MINUTA, esse será o padrão"): dentro da pasta do cliente fica uma subpasta
 *    "MINUTA" — se existir uma com "minuta" no nome (ex.: "Minuta do contrato"), vira "MINUTA"; se não existir nenhuma, o CRM cria (pra equipe soltar o arquivo). */

type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | null | undefined;
type Leitura = { tipo: string; valorCredito: number | null; valorLiquido: number | null; valorCompraVenda: number | null; valorAvaliacao: number | null; valorEntrada: number | null; prazoMeses: number | null; banco: string | null; taxaEfetiva?: string | null; sistema?: string | null; primeiraParcela?: number | null; observacao: string };

const SYSTEM = `Você lê a MINUTA (rascunho do contrato) de uma operação de crédito imobiliário de um banco brasileiro: financiamento habitacional (compra de imóvel) ou crédito com garantia de imóvel (home equity). Extraia SÓ o que está escrito no documento — nunca calcule nem invente.
Responda SOMENTE com JSON:
{"tipo":"FINANCIAMENTO|HOME_EQUITY|OUTRO","valorCredito":<número ou null — valor TOTAL do financiamento/empréstimo/crédito concedido (o que o contrato chama de valor do financiamento, valor do empréstimo, valor do crédito, valor total da dívida na assinatura)>,"valorLiquido":<número ou null — valor líquido liberado ao cliente, se o contrato separar>,"valorCompraVenda":<número ou null — preço de compra e venda do imóvel (só financiamento)>,"valorAvaliacao":<número ou null — valor de avaliação do imóvel / valor da garantia para leilão>,"valorEntrada":<número ou null — recursos próprios/entrada, se estiver escrito>,"prazoMeses":<número ou null>,"banco":"<nome do banco ou null>","taxaEfetiva":"<taxa de juros EFETIVA anual como está escrita, ex.: 10,49% a.a. + TR, ou null>","sistema":"<SAC|PRICE|null>","primeiraParcela":<número ou null — valor da 1ª prestação/encargo inicial>,"observacao":"<1 frase: o que é o documento e qualquer ponto de atenção (ex.: valor diferente do esperado, minuta de outro cliente)>"}
Números em reais como número puro (ex.: 250000.5), sem R$ nem pontos de milhar.`;

const num = (v: unknown): number | null => { const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[^\d.,-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null; };
const brl = (n: number | null | undefined) => (n ? n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '—');
const norm = (s: string) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

async function lerMinuta(accountId: string, file: { id: string; name: string; mimeType: string; size: number }): Promise<Leitura | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const google = await import('./google.service');
  let content: any[];
  if (file.mimeType === 'application/pdf' && file.size <= 25 * 1024 * 1024) {
    const buf = await google.downloadDriveFile(accountId, file.id, file.mimeType);
    content = [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } }, { type: 'text', text: `Arquivo: ${file.name}` }];
  } else {
    const texto = file.mimeType === 'application/vnd.google-apps.document'
      ? (await google.downloadDriveFile(accountId, file.id, file.mimeType)).toString('utf-8')
      : await google.ocrDriveFileToText(accountId, file.id); // Word/imagem: o Drive converte e devolve o texto
    if (!texto.trim()) return null;
    content = [{ type: 'text', text: `Arquivo: ${file.name}\n\n${texto.slice(0, 180_000)}` }];
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 8192, system: SYSTEM, messages: [{ role: 'user', content }] }),
  }).catch(() => null);
  if (!res || !res.ok) { console.error('[Minuta] Anthropic', res?.status, res ? (await res.text()).slice(0, 200) : ''); return null; }
  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  const raw = data.content?.find((b) => b.type === 'text')?.text || '';
  try {
    const j = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '');
    return {
      tipo: String(j.tipo || 'OUTRO'), valorCredito: num(j.valorCredito), valorLiquido: num(j.valorLiquido), valorCompraVenda: num(j.valorCompraVenda),
      valorAvaliacao: num(j.valorAvaliacao), valorEntrada: num(j.valorEntrada), prazoMeses: num(j.prazoMeses), banco: j.banco ? String(j.banco).slice(0, 60) : null,
      observacao: String(j.observacao || '').slice(0, 300),
    };
  } catch { return null; }
}

/** Etapas da Análise Jurídica em diante nos funis "Em contratação". */
async function etapasDaMinuta(accountId: string): Promise<string[]> {
  const funis = await prisma.pipeline.findMany({ where: { accountId, name: { startsWith: 'Em contratação', mode: 'insensitive' } }, select: { stages: { select: { id: true, name: true, order: true } } } });
  return funis.flatMap((f) => {
    const juridica = f.stages.find((st) => /juridic|registro|escritura/.test(norm(st.name)));
    return juridica ? f.stages.filter((st) => st.order >= juridica.order).map((st) => st.id) : [];
  });
}

/* Só age quando há alteração (Fabio 29/10: "não precisa ser de 10 em 10 min, só quando houver alteração"):
 *  - card que ENTROU nas etapas da minuta e ainda não tem a pasta MINUTA conferida → cria/renomeia (a checagem é no banco; o Drive só é chamado pro card novo);
 *  - ARQUIVO NOVO no Drive: o CRM lê o registro de mudanças do Google Drive (changes.list — só o que mudou desde a última leitura) e, se o arquivo caiu numa pasta
 *    MINUTA de um desses cards, lê a minuta. Depois de reiniciar o servidor, uma única varredura das pastas MINUTA pega o que chegou nesse meio-tempo. */
let tokenMudancas: string | null = null;
let varreduraFeita = false;
let ultimaMudanca = 0;
/** Lê AGORA a minuta de um card (Jarvis "lê a minuta do Pedro"): cria/acha a pasta MINUTA e lê o que ainda não foi lido. */
export async function lerMinutaDoCard(accountId: string, leadId: string, io?: Io, releitura = false): Promise<{ lidas: number; arquivos: string[] }> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { id: true, name: true, value: true, customFields: true, pipeline: { select: { department: { select: { name: true } } } } } });
  if (!l) throw new Error('card não encontrado');
  const cf = (l.customFields || {}) as Record<string, any>;
  if (!String(cf.link_pasta_drive || '').trim()) throw new Error('o card não tem a pasta do Drive');
  if (releitura && cf._minuta?.lidos) { const c2 = { ...cf, _minuta: { ...cf._minuta, lidos: [] } }; await prisma.lead.update({ where: { id: leadId }, data: { customFields: c2 as any } }); l.customFields = c2; }
  const google = await import('./google.service');
  if (!cf._minuta?.pasta) await garantirPastaMinuta(accountId, l.id, google.extractFolderId(String(cf.link_pasta_drive)), cf).catch(() => {});
  const antes = await prisma.note.count({ where: { leadId } });
  await conferirPasta(accountId, l, io);
  const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const m = (fresh?.customFields as any)?._minuta || {};
  return { lidas: Math.max(0, (await prisma.note.count({ where: { leadId } })) - antes), arquivos: m.arquivo ? [m.arquivo] : [] };
}

export async function processMinutas(accountId: string, io?: Io): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) return;
  const etapas = await etapasDaMinuta(accountId);
  if (!etapas.length) return;
  const leads = await prisma.lead.findMany({
    where: { accountId, status: 'OPEN', archived: false, stageId: { in: etapas } },
    select: { id: true, name: true, value: true, customFields: true, pipeline: { select: { department: { select: { name: true } } } } },
  });
  const comPasta = leads.filter((l) => String(((l.customFields || {}) as any).link_pasta_drive || '').trim());
  if (!comPasta.length) return;
  const google = await import('./google.service');
  // 1) Card novo na etapa: pasta MINUTA (uma vez por card).
  for (const l of comPasta) {
    const cf = (l.customFields || {}) as Record<string, any>;
    if (cf._minuta?.pasta) continue;
    await garantirPastaMinuta(accountId, l.id, google.extractFolderId(String(cf.link_pasta_drive)), cf).catch((e) => console.error('[Minuta] pasta:', e?.message));
  }
  // 2) Arquivos: varredura única depois de reiniciar; depois só pelo registro de mudanças do Drive (a cada 2 min, uma chamada leve).
  if (!varreduraFeita) {
    varreduraFeita = true;
    try { const drive = await google.getDrive(accountId); tokenMudancas = (await drive.changes.getStartPageToken({ supportsAllDrives: true })).data.startPageToken || null; } catch (e: any) { console.error('[Minuta] token de mudanças:', e?.message); }
    for (const l of comPasta) await conferirPasta(accountId, l, io).catch((e) => console.error('[Minuta] varredura:', e?.message));
    return;
  }
  if (!tokenMudancas || Date.now() - ultimaMudanca < 2 * 60_000) return;
  ultimaMudanca = Date.now();
  const pastasMinuta = new Map<string, (typeof comPasta)[number]>(); // pasta MINUTA → card
  const pastasCliente = new Map<string, (typeof comPasta)[number]>(); // pasta do cliente → card (arquivo com "minuta" no nome solto lá)
  for (const l of comPasta) {
    const cf = (l.customFields || {}) as any;
    if (cf._minuta?.pasta) pastasMinuta.set(cf._minuta.pasta, l);
    pastasCliente.set(google.extractFolderId(String(cf.link_pasta_drive)), l);
  }
  const tocados = new Set<string>();
  try {
    const drive = await google.getDrive(accountId);
    let token: string | null | undefined = tokenMudancas;
    while (token) {
      const r: any = await drive.changes.list({ pageToken: token, fields: 'nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,parents,trashed))', pageSize: 200, supportsAllDrives: true, includeItemsFromAllDrives: true });
      for (const c of r.data.changes || []) {
        if (c.removed || c.file?.trashed) continue;
        for (const pai of c.file?.parents || []) {
          const l = pastasMinuta.get(pai) || (/minuta/i.test(c.file?.name || '') ? pastasCliente.get(pai) : undefined);
          if (l) tocados.add(l.id);
        }
      }
      if (r.data.newStartPageToken) tokenMudancas = r.data.newStartPageToken;
      token = r.data.nextPageToken;
    }
  } catch (e: any) { console.error('[Minuta] mudanças do Drive:', e?.message); return; }
  for (const l of comPasta.filter((x) => tocados.has(x.id))) await conferirPasta(accountId, l, io).catch((e) => console.error('[Minuta] leitura:', e?.message));
}

/** Lê a minuta ainda não lida da pasta do cliente (arquivo dentro da MINUTA ou com "minuta" no nome). */
async function conferirPasta(accountId: string, l: { id: string; name: string; value: number | null; customFields: unknown; pipeline: { department: { name: string } | null } | null }, io: Io): Promise<void> {
  const google = await import('./google.service');
  const cf = (l.customFields || {}) as Record<string, any>;
  const arquivos = await google.listAllFilesInFolderTree(accountId, google.extractFolderId(String(cf.link_pasta_drive)), 3);
  const fresh = await prisma.lead.findUnique({ where: { id: l.id }, select: { customFields: true } });
  const lidos = new Set<string>(Array.isArray((fresh?.customFields as any)?._minuta?.lidos) ? (fresh?.customFields as any)._minuta.lidos : []);
  const minutas = arquivos.filter((f) => (/minuta/i.test(f.path) || /minuta/i.test(f.name)) && !lidos.has(f.id) && /pdf|document|word|officedocument|image/.test(f.mimeType));
  for (const minuta of minutas) {
    const leitura = await lerMinuta(accountId, minuta).catch((e) => { console.error('[Minuta] leitura:', e?.message); return null; });
    await aplicarMinuta(accountId, l, minuta, leitura, io);
  }
}

/** Subpasta "MINUTA" na pasta do cliente: renomeia a que tiver "minuta" no nome ou cria. Uma vez por card (`_minuta.pasta`). */
async function garantirPastaMinuta(accountId: string, leadId: string, pastaCliente: string, cf: Record<string, any>): Promise<void> {
  if (cf._minuta?.pasta) return;
  const google = await import('./google.service');
  const subpastas = await google.listFolders(accountId, pastaCliente);
  const exata = subpastas.find((f) => f.name.trim() === 'MINUTA');
  const parecida = exata ? null : subpastas.find((f) => /minuta/i.test(norm(f.name)));
  let id = exata?.id || '';
  let nota = '';
  if (parecida) {
    await google.renameFile(accountId, parecida.id, 'MINUTA');
    id = parecida.id;
    nota = `📁 Pasta "${parecida.name}" do Drive do cliente renomeada pra "MINUTA" (padrão).`;
  } else if (!exata) {
    const criada = await google.createFolder(accountId, 'MINUTA', pastaCliente);
    id = criada.id;
    nota = '📁 Criei a pasta "MINUTA" no Drive do cliente (padrão) — quando a minuta chegar, é só colocar lá que o CRM lê e corrige os valores do card.';
  }
  const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const c = { ...((fresh?.customFields || {}) as Record<string, any>) };
  c._minuta = { ...(c._minuta || {}), pasta: id };
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: c as any } });
  cf._minuta = c._minuta;
  if (nota) await prisma.note.create({ data: { leadId, type: 'COMMENT', content: nota } }).catch(() => {});
}

async function aplicarMinuta(
  accountId: string,
  l: { id: string; name: string; value: number | null; customFields: unknown; pipeline: { department: { name: string } | null } | null },
  arquivo: { id: string; name: string; path: string },
  leitura: Leitura | null,
  io: Io,
): Promise<void> {
  const fresh = await prisma.lead.findUnique({ where: { id: l.id }, select: { value: true, customFields: true } });
  const cf = { ...((fresh?.customFields || {}) as Record<string, any>) };
  const lidos: string[] = Array.isArray(cf._minuta?.lidos) ? cf._minuta.lidos : [];
  cf._minuta = { ...(cf._minuta || {}), lidos: [...lidos, arquivo.id], at: new Date().toISOString(), arquivo: arquivo.name };
  const onde = `${arquivo.path ? `${arquivo.path} › ` : ''}${arquivo.name}`;
  if (!leitura || !leitura.valorCredito) {
    await prisma.lead.update({ where: { id: l.id }, data: { customFields: cf as any } });
    await prisma.note.create({ data: { leadId: l.id, type: 'COMMENT', content: `📄 Achei a minuta no Drive (${onde}), mas não consegui ler o valor do crédito${leitura?.observacao ? ` — ${leitura.observacao}` : ''}. Confira os valores do card à mão.` } }).catch(() => {});
    return;
  }
  const financiamento = /habitacional|financiamento/i.test(l.pipeline?.department?.name || '');
  const mudancas: string[] = [];
  const troca = (chave: string, rotulo: string, novo: number | null) => {
    if (!novo) return;
    const antes = num(cf[chave]);
    if (antes && Math.abs(antes - novo) < 0.01) return;
    cf[chave] = String(novo);
    mudancas.push(`${rotulo}: ${brl(novo)} (era ${brl(antes)})`);
  };
  // Fabio 29/10 (Alexandro: crédito R$ 305 mil, líquido R$ 300 mil): "sempre o valor LÍQUIDO" — card, Valor da venda e comissão usam o líquido quando a minuta separa.
  const credito = leitura.valorLiquido || leitura.valorCredito;
  troca('valor_credito', leitura.valorLiquido ? 'Crédito (líquido)' : 'Crédito', credito);
  if (financiamento) {
    troca('valor_imovel', 'Compra e venda', leitura.valorCompraVenda);
    const compra = num(cf.valor_imovel);
    troca('valor_entrada', 'Entrada', leitura.valorEntrada || (compra && compra > credito ? Math.round((compra - credito) * 100) / 100 : null));
  }
  troca('valor_de_avaliacao', 'Avaliação do imóvel', leitura.valorAvaliacao); // a chave do campo é valor_de_avaliacao (antes gravava em valor_avaliacao, que não aparece no card)
  troca('primeira_parcela', 'Primeira parcela', leitura.primeiraParcela ?? null);
  // Banco, prazo e taxa (Fabio 29/10, Alexandro: "lê a minuta e preenche o card"): só o que a minuta traz escrito.
  const textoCampo = (chave: string, rotulo: string, novo: string | null | undefined) => {
    const v = String(novo || '').trim();
    if (!v || String(cf[chave] || '').trim() === v) return;
    mudancas.push(`${rotulo}: ${v}${cf[chave] ? ` (era ${cf[chave]})` : ''}`);
    cf[chave] = v;
  };
  const BANCOS: [RegExp, string][] = [[/caixa/i, 'Caixa'], [/bradesco/i, 'Bradesco'], [/ita[uú]/i, 'Itaú'], [/santander/i, 'Santander'], [/brasil|\bbb\b/i, 'BB'], [/brb|bras[ií]lia/i, 'BRB'], [/inter/i, 'Inter'], [/creditas/i, 'Creditas']];
  const banco = leitura.banco ? (BANCOS.find(([re]) => re.test(leitura.banco!))?.[1] || null) : null;
  textoCampo('instituicao', 'Instituição', banco);
  textoCampo('prazo_financ', 'Prazo', leitura.prazoMeses ? `${leitura.prazoMeses} meses` : null);
  textoCampo('taxa_efetiva', 'Taxa efetiva', leitura.taxaEfetiva || null);
  const valorAntes = fresh?.value || null;
  const novoValor = credito;
  if (!valorAntes || Math.abs(valorAntes - novoValor) >= 0.01) mudancas.push(`Valor da venda: ${brl(novoValor)} (era ${brl(valorAntes)})`);
  cf._minuta.valores = leitura;
  await prisma.lead.update({ where: { id: l.id }, data: { customFields: cf as any, value: novoValor } });

  // Provisão de comissão em aberto: a base passa a ser o crédito da minuta (mesma taxa).
  let provisao = '';
  const aberta = await prisma.commissionProvision.findFirst({ where: { leadId: l.id, status: 'OPEN' } });
  if (aberta && Math.abs(aberta.baseAmount - novoValor) >= 0.01) {
    const { commissionAmount } = require('./commission.service') as typeof import('./commission.service');
    const amount = commissionAmount(novoValor, aberta.ratePct);
    await prisma.commissionProvision.update({ where: { id: aberta.id }, data: { baseAmount: novoValor, amount } });
    provisao = ` Provisão de comissão atualizada: ${aberta.ratePct}% de ${brl(novoValor)} = ${brl(amount)} (era ${brl(aberta.amount)}).`;
  }
  const extras = [leitura.valorLiquido ? `líquido liberado ${brl(leitura.valorLiquido)}` : '', leitura.prazoMeses ? `${leitura.prazoMeses} meses` : '', leitura.banco || ''].filter(Boolean).join(' · ');
  await prisma.note.create({ data: { leadId: l.id, type: 'COMMENT', content: `📄 Minuta lida (${onde})${extras ? ` — ${extras}` : ''}. ${mudancas.length ? `Card corrigido: ${mudancas.join('; ')}.` : 'Os valores do card já batiam com a minuta.'}${provisao}${leitura.observacao ? `\n${leitura.observacao}` : ''}` } }).catch(() => {});
  if (mudancas.length) {
    const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
    sendPushToAccount(accountId, { title: `📄 Minuta lida: ${l.name}`, body: mudancas.join(' · ').slice(0, 180), leadId: l.id }).catch(() => {});
  }
  io?.to(`lead:${l.id}`).emit('lead_updated', { leadId: l.id });
  logActivity({ accountId, userId: null, userName: 'Assistente IA', action: 'lead_edited', leadId: l.id, leadName: l.name, summary: `leu a minuta e ${mudancas.length ? 'corrigiu os valores do card' : 'conferiu os valores do card'}` });
  console.log(`[Minuta] ${l.name}: ${mudancas.length ? mudancas.join('; ') : 'valores já batiam'}`);
}
