import { prisma } from '../lib/prisma';
import { logActivity } from './activity.service';

/* MINUTA na escritura/registro (Fabio 28/10): "a gente irá receber a minuta do cliente na fase de escritura/registro; nessa etapa o CRM deve buscar essa pasta
 * escrito MINUTA, deverá ler e corrigir os valores de crédito e de compra e venda para ajustar no card". Home Equity não tem entrada.
 *  - Cards ABERTOS nos funis "Em contratação" da Análise Jurídica em diante (Análise Jurídica, Registro em Cartório, Pagamento ao Vendedor) com a pasta do
 *    Drive no card (`link_pasta_drive`): procura arquivo dentro de uma pasta "MINUTA" (ou com "minuta" no nome), até 3 níveis.
 *  - Lê com a IA (PDF direto; Word/Google Docs pelo texto) e corrige no card: crédito (valor_credito + Valor da venda) e, no Financiamento, compra e venda
 *    (valor_imovel) e entrada (compra e venda − financiado). Valor de avaliação, quando vier. Provisão de comissão em aberto: a base passa a ser o crédito da minuta.
 *  - Cada arquivo é lido uma vez (`_minuta.lidos`); minuta nova (outra versão) é lida de novo. Nota no card com "era X" + push.
 *  - Padrão da pasta (Fabio 29/10: "se não tiver a pasta MINUTA, renomeia para MINUTA, esse será o padrão"): dentro da pasta do cliente fica uma subpasta
 *    "MINUTA" — se existir uma com "minuta" no nome (ex.: "Minuta do contrato"), vira "MINUTA"; se não existir nenhuma, o CRM cria (pra equipe soltar o arquivo). */

type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | null | undefined;
type Leitura = { tipo: string; valorCredito: number | null; valorLiquido: number | null; valorCompraVenda: number | null; valorAvaliacao: number | null; valorEntrada: number | null; prazoMeses: number | null; banco: string | null; observacao: string };

const SYSTEM = `Você lê a MINUTA (rascunho do contrato) de uma operação de crédito imobiliário de um banco brasileiro: financiamento habitacional (compra de imóvel) ou crédito com garantia de imóvel (home equity). Extraia SÓ o que está escrito no documento — nunca calcule nem invente.
Responda SOMENTE com JSON:
{"tipo":"FINANCIAMENTO|HOME_EQUITY|OUTRO","valorCredito":<número ou null — valor TOTAL do financiamento/empréstimo/crédito concedido (o que o contrato chama de valor do financiamento, valor do empréstimo, valor do crédito, valor total da dívida na assinatura)>,"valorLiquido":<número ou null — valor líquido liberado ao cliente, se o contrato separar>,"valorCompraVenda":<número ou null — preço de compra e venda do imóvel (só financiamento)>,"valorAvaliacao":<número ou null — valor de avaliação do imóvel / valor da garantia para leilão>,"valorEntrada":<número ou null — recursos próprios/entrada, se estiver escrito>,"prazoMeses":<número ou null>,"banco":"<nome do banco ou null>","observacao":"<1 frase: o que é o documento e qualquer ponto de atenção (ex.: valor diferente do esperado, minuta de outro cliente)>"}
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

let ultimaRodada = 0;
/** Poller (a cada 10 min): uma minuta nova por rodada (cada leitura é um PDF inteiro). */
export async function processMinutas(accountId: string, io?: Io): Promise<void> {
  if (Date.now() - ultimaRodada < 10 * 60_000 || !process.env.ANTHROPIC_API_KEY) return;
  ultimaRodada = Date.now();
  const etapas = await etapasDaMinuta(accountId);
  if (!etapas.length) return;
  const leads = await prisma.lead.findMany({
    where: { accountId, status: 'OPEN', archived: false, stageId: { in: etapas } },
    select: { id: true, name: true, value: true, customFields: true, pipeline: { select: { department: { select: { name: true } } } } },
  });
  const google = await import('./google.service');
  for (const l of leads) {
    const cf = (l.customFields || {}) as Record<string, any>;
    const link = String(cf.link_pasta_drive || '').trim();
    if (!link) continue;
    await garantirPastaMinuta(accountId, l.id, google.extractFolderId(link), cf).catch((e) => console.error('[Minuta] pasta:', e?.message));
    let arquivos: { id: string; name: string; mimeType: string; path: string; size: number }[] = [];
    try { arquivos = await google.listAllFilesInFolderTree(accountId, google.extractFolderId(link), 3); } catch { continue; }
    const lidos = new Set<string>(Array.isArray(cf._minuta?.lidos) ? cf._minuta.lidos : []);
    const minuta = arquivos.find((f) => (/minuta/i.test(f.path) || /minuta/i.test(f.name)) && !lidos.has(f.id) && /pdf|document|word|officedocument|image/.test(f.mimeType));
    if (!minuta) continue;
    const leitura = await lerMinuta(accountId, minuta).catch((e) => { console.error('[Minuta] leitura:', e?.message); return null; });
    await aplicarMinuta(accountId, l, minuta, leitura, io);
    return; // uma por rodada
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
  troca('valor_credito', 'Crédito', leitura.valorCredito);
  if (financiamento) {
    troca('valor_imovel', 'Compra e venda', leitura.valorCompraVenda);
    const compra = num(cf.valor_imovel);
    troca('valor_entrada', 'Entrada', leitura.valorEntrada || (compra && compra > leitura.valorCredito ? Math.round((compra - leitura.valorCredito) * 100) / 100 : null));
  }
  troca('valor_avaliacao', 'Avaliação do imóvel', leitura.valorAvaliacao);
  const valorAntes = fresh?.value || null;
  const novoValor = leitura.valorCredito;
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
