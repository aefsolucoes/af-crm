import { prisma } from '../lib/prisma';

/* ── Corretor/vendedor indicado pelo cliente do Financiamento Habitacional ──
 * Fabio 11/11 (Jaime mandou o cartão do corretor e o CRM descartou): "É normal o cliente passar o contato do corretor para solicitarmos a documentação
 * … o CRM chamar o corretor e solicitar a documentação do imóvel e do vendedor" + "isso pode ocorrer em caso de corretor e vendedor".
 *
 * 1. Cartão de contato que chega na conversa de um card do FH → fica em `_contatosIndicados` (PENDENTE).
 * 2. Poller (1 min): passados 2 min (o cliente costuma explicar logo depois, por áudio), a IA (Haiku) lê a conversa e diz se é o CORRETOR, o VENDEDOR ou outra
 *    pessoa. Outra pessoa → só anotação.
 * 3. Corretor/vendedor → card próprio pelo telefone (Caixa de Entrada), com a IA DESLIGADA e ligado ao card do cliente (`_terceiroDe`). Número que já é card
 *    de outro processo → só anotação + push (a equipe decide).
 * 4. Conversa aberta (24 h) → o pedido da documentação do imóvel e do vendedor sai na hora. Fechada → modelo da Meta (DOC_TEMPLATE, UTILITY; sem aprovação
 *    ainda, "ola_tudo_bem") e o pedido fica guardado pra sair na 1ª resposta (reply-pending).
 * 5. Arquivo que o corretor/vendedor manda → copiado pro card do cliente (conferência de documentos e pasta do Drive dele, como se o cliente tivesse mandado —
 *    Fabio 11/11: "Sim, pro card do cliente").
 * 6. Fabio 12/11 (Pedro Paulo: mandou os documentos dos vendedores e DEPOIS o cartão do corretor "que acompanhará o avaliador" — o CRM pediu tudo de novo ao
 *    corretor): só pede o que ainda NÃO está no card (arquivo classificado ou dado já mandado na conversa); com tudo no card, não chama ninguém. Contato
 *    passado pra ACOMPANHAR A VISTORIA vai pro campo "Contato vistoria" (se vazio). */

type Cf = Record<string, any>;
type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } };
export type ContatoIndicado = {
  nome: string; telefone: string; messageId: string | null; at: string;
  status: 'PENDENTE' | 'ENVIADO' | 'TEMPLATE' | 'IGNORADO' | 'EQUIPE' | 'FALHOU' | 'JA_TINHA';
  papel?: 'corretor' | 'vendedor' | 'outro'; terceiroLeadId?: string; enviadoAt?: string; motivo?: string;
  vistoria?: boolean; pedidos?: string[];
};
export type TerceiroDe = { leadId: string; cliente: string; papel: 'corretor' | 'vendedor'; at: string };

/** Modelo novo (UTILITY) pra abrir a conversa com quem o cliente indicou — {{1}} = nome do cliente. Enquanto a Meta não aprova, vai o "ola_tudo_bem". */
export const DOC_TEMPLATE = 'documentacao_imovel_indicacao';
export const DOC_TEMPLATE_BODY = 'Olá, tudo bem? {{1}} nos passou o seu contato para a documentação do imóvel do financiamento habitacional. Podemos te enviar por aqui a lista do que precisamos?';
const ESPERA_MS = 2 * 60_000;

const nota = (leadId: string, content: string) => prisma.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});
const soDigitos = (v: string) => String(v || '').replace(/\D/g, '');
const titulo = (s: string) => String(s || '').toLowerCase().replace(/(^|\s)(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase()).replace(/\s(D[aeo]s?|E)\s/g, (m) => m.toLowerCase()).trim();

async function gravarIndicados(leadId: string, lista: ContatoIndicado[]): Promise<void> {
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_contatosIndicados}', ${JSON.stringify(lista.slice(-10))}::jsonb, true) WHERE id = ${leadId}`;
}
async function atualizarIndicado(leadId: string, telefone: string, patch: Partial<ContatoIndicado>): Promise<void> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const lista: ContatoIndicado[] = Array.isArray(((l?.customFields || {}) as Cf)._contatosIndicados) ? ((l!.customFields as Cf)._contatosIndicados) : [];
  await gravarIndicados(leadId, lista.map((c) => (soDigitos(c.telefone) === soDigitos(telefone) ? { ...c, ...patch } : c)));
}

/** Webhook: cartão de contato recebido. Só Financiamento Habitacional, card aberto, cliente (não grupo nem card de corretor/vendedor). */
export async function registrarContatoIndicado(accountId: string, leadId: string, contato: { nome: string; telefone: string }, messageId: string | null): Promise<void> {
  if (soDigitos(contato.telefone).length < 10) return;
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId, status: 'OPEN', isGroup: false }, select: { customFields: true, contact: { select: { phone: true, whatsappPhone: true } }, pipeline: { select: { department: { select: { name: true } } } } } });
  if (!l || !/habitacional/i.test(l.pipeline?.department?.name || '')) return;
  const cf = (l.customFields || {}) as Cf;
  if (cf._terceiroDe) return;
  const tel = soDigitos(contato.telefone);
  const proprio = [l.contact?.phone, l.contact?.whatsappPhone].map((x) => soDigitos(String(x || ''))).filter(Boolean);
  if (proprio.some((p) => p.slice(-8) === tel.slice(-8))) return; // o cliente mandou o próprio contato
  const lista: ContatoIndicado[] = Array.isArray(cf._contatosIndicados) ? cf._contatosIndicados : [];
  if (lista.some((c) => soDigitos(c.telefone).slice(-8) === tel.slice(-8))) return; // mesmo contato de novo (o WhatsApp manda o cartão duas vezes às vezes)
  lista.push({ nome: contato.nome, telefone: contato.telefone, messageId, at: new Date().toISOString(), status: 'PENDENTE' });
  await gravarIndicados(leadId, lista);
}

type Leitura = { papel: 'corretor' | 'vendedor' | 'outro'; vistoria: boolean; jaMandou: number[] };
export type ListasPedido = { imovel: string[]; vendedor: string[] };

/** Corretor, vendedor ou outra pessoa? Passou pra acompanhar a vistoria? Quais itens do pedido já foram mandados na conversa? Lê as últimas mensagens (com a
 *  transcrição dos áudios e os nomes dos arquivos). */
async function lerContato(leadId: string, nome: string, itens: string[]): Promise<Leitura | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const hist = await prisma.message.findMany({ where: { leadId, deleted: false }, orderBy: { createdAt: 'desc' }, take: 40, select: { direction: true, content: true } });
  const conversa = hist.reverse().map((m) => `${m.direction === 'INBOUND' ? 'CLIENTE' : 'ATENDENTE'}: ${String(m.content || '').replace(/\s+/g, ' ').slice(0, 300)}`).join('\n');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 200,
      system: [
        'Conversa de um correspondente bancário (financiamento habitacional) com o cliente que está COMPRANDO um imóvel. O cliente mandou um cartão de contato ("📇 Contato: …"). Responda SÓ com JSON: {"papel":"corretor"|"vendedor"|"outro","vistoria":true|false,"jaMandou":[números]}.',
        '- papel: quem é essa pessoa, pelo que o cliente disse antes ou depois do cartão — "corretor" (corretor/imobiliária que está vendendo o imóvel), "vendedor" (dono/proprietário que está vendendo o imóvel) ou "outro" (parente, cônjuge, inquilino, gerente de banco, outro cliente, ou não dá pra saber).',
        '- vistoria: true se o contato foi passado como quem vai ACOMPANHAR A VISTORIA/avaliação do imóvel (ex.: "ele vai acompanhar o avaliador", "contato pra vistoria", ou é a resposta a um pedido do contato da vistoria); senão false.',
        '- jaMandou: os números dos itens da LISTA que JÁ foram mandados na conversa — arquivo ("📎 RG - Fulano.pdf", "📎 Certidão de ônus.pdf") ou o dado escrito (e-mail, telefone, banco/agência/conta). Só o que aparece claramente; na dúvida, deixe de fora.',
      ].join('\n'),
      messages: [{ role: 'user', content: `Contato compartilhado: ${nome || '(sem nome)'}\n\nLISTA:\n${itens.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\nConversa:\n${conversa}` }],
    }),
  }).catch(() => null);
  if (!res?.ok) return null;
  const data = (await res.json().catch(() => null)) as { content?: { type: string; text?: string }[] } | null;
  const out = (data?.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('');
  const m = /"papel"\s*:\s*"(corretor|vendedor|outro)"/i.exec(out);
  if (!m) return null;
  const ja = /"jaMandou"\s*:\s*\[([^\]]*)\]/.exec(out);
  return {
    papel: m[1].toLowerCase() as Leitura['papel'],
    vistoria: /"vistoria"\s*:\s*true/i.test(out),
    jaMandou: ja ? ja[1].split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0) : [],
  };
}

/** Itens (linhas com •) de uma Resposta Rápida — a equipe muda a lista por lá. */
async function itensDaResposta(accountId: string, nome: string): Promise<string[]> {
  const t = await prisma.messageTemplate.findFirst({ where: { accountId, name: { equals: nome, mode: 'insensitive' } }, select: { body: true } });
  return String(t?.body || '').split('\n').map((l) => l.trim()).filter((l) => /^[•\-–]/.test(l)).map((l) => l.replace(/^[•\-–]\s*/, '').replace(/:\s*$/, '').trim())
    .filter((l) => l && !/^(e-?mail|telefone)$/i.test(l));
}

/** Lista completa do pedido (Respostas Rápidas "Documentos imóvel para vistoria" e "Documentos vendedor do imóvel"). */
export async function listasDoPedido(accountId: string): Promise<ListasPedido> {
  const imovelBase = await itensDaResposta(accountId, 'Documentos imóvel para vistoria');
  const vendBase = await itensDaResposta(accountId, 'Documentos vendedor do imóvel');
  return {
    imovel: imovelBase.length ? imovelBase : ['Certidão de ônus', 'CND de IPTU'],
    vendedor: [...(vendBase.length ? vendBase : ['Documento de identificação', 'Comprovante de residência', 'Estado civil', 'Conta para crédito']), 'E-mail e telefone'],
  };
}

const semAcento = (s: string) => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const ID_RX = /^(RG|CNH|CIN|IDENTIDADE|CARTEIRA DE IDENTIDADE|DOCUMENTO DE IDENTIFICACAO|RNE|CRNM)\b/;
const RESID_RX = /COMPROVANTE DE (RESIDENCIA|ENDERECO)|CONTA DE (ENERGIA|LUZ|AGUA|GAS|TELEFONE|INTERNET)|FATURA/;
const CIVIL_RX = /CERTIDAO DE (CASAMENTO|NASCIMENTO|OBITO)|UNIAO ESTAVEL|DIVORCIO|AVERBACAO|ESTADO CIVIL/;

/** O item já está no card do cliente (arquivo classificado; ônus/matrícula antiga não conta)? `null` = não dá pra saber pelos arquivos (conta pra crédito,
 *  e-mail, telefone — a leitura da conversa decide). Documento do vendedor = de quem está como dono na ônus (cada um); sem a ônus lida, de quem não é
 *  comprador. */
export function itemNoCard(item: string, cf: Cf, compradores: string[]): boolean | null {
  const rd = require('./received-docs.service') as typeof import('./received-docs.service');
  const antigos = (cf._docsImovelAntigo || {}) as Record<string, unknown>;
  const arqs = Object.entries((cf._docInfo || {}) as Record<string, unknown>)
    .filter(([id, v]) => !antigos[id] && typeof v === 'string')
    .map(([, v]) => { const [t, h] = String(v).split('|'); return { tipo: semAcento(t), titulares: String(h || '').split(/\s*;\s*|\s+E\s+/i).map((x) => x.trim()).filter(Boolean) }; });
  const vendedores = rd.vendedoresDoImovel(cf);
  const ehComprador = (h: string) => compradores.some((b) => rd.mesmaPessoa(h, b));
  const doVendedor = (re: RegExp, cadaUm: boolean) => {
    const docs = arqs.filter((a) => re.test(a.tipo));
    if (!vendedores.length) return docs.some((a) => a.titulares.some((h) => !ehComprador(h)));
    const tem = (v: string) => docs.some((a) => a.titulares.some((h) => rd.mesmaPessoa(h, v)));
    return cadaUm ? vendedores.every(tem) : vendedores.some(tem);
  };
  const i = semAcento(item);
  if (/ONUS|MATRICULA/.test(i)) return arqs.some((a) => /^(CERTIDAO DE ONUS|MATRICULA)/.test(a.tipo));
  if (/IPTU/.test(i)) return arqs.some((a) => /IPTU/.test(a.tipo));
  if (/ESCRITURA/.test(i)) return arqs.some((a) => /ESCRITURA/.test(a.tipo));
  if (/IDENTIFICA|\bRG\b|\bCNH\b/.test(i)) return doVendedor(ID_RX, true);
  if (/RESIDENCIA|ENDERECO/.test(i)) return doVendedor(RESID_RX, false);
  if (/ESTADO CIVIL|CASAMENTO|NASCIMENTO/.test(i)) return doVendedor(CIVIL_RX, true);
  return null;
}

/** Pedido da documentação do imóvel e do vendedor — só os itens de `itens` (sem `itens`, a lista toda). */
export async function textoPedido(accountId: string, p: { nome: string; cliente: string; papel: 'corretor' | 'vendedor' }, itens?: ListasPedido): Promise<string> {
  const { imovel, vendedor } = itens || (await listasDoPedido(accountId));
  const primeiro = (p.nome || '').trim().split(/\s+/)[0] || '';
  const oi = `Oi${primeiro ? ` ${titulo(primeiro)}` : ''}, tudo bem? Cuidamos do financiamento habitacional de ${p.cliente}, que nos passou o seu contato.`;
  const doVend = p.papel === 'vendedor' ? 'a sua' : 'do vendedor';
  const oQue = imovel.length && vendedor.length ? `da documentação do imóvel e ${doVend}` : imovel.length ? 'da documentação do imóvel' : `da documentação ${p.papel === 'vendedor' ? 'sua' : 'do vendedor'}`;
  const blocos = [
    imovel.length ? `*Do imóvel:*\n${imovel.map((i) => `• ${i}`).join('\n')}` : '',
    vendedor.length ? `${p.papel === 'vendedor' ? '*Seus documentos (vendedor):*' : '*Do vendedor:*'}\n${vendedor.map((i) => `• ${i}`).join('\n')}` : '',
  ].filter(Boolean);
  return `${oi} Pra seguir com o processo, a gente precisa ${oQue}:\n\n${blocos.join('\n\n')}\n\nPode mandar por aqui mesmo. Obrigado!`;
}

/** "Contato vistoria" do card do cliente, se vazio: "Nome — (DDD) número". */
async function gravarContatoVistoria(leadId: string, c: { nome: string; telefone: string }): Promise<boolean> {
  let d = soDigitos(c.telefone);
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  if (d.length < 10) return false;
  const tel = `(${d.slice(0, 2)}) ${d.slice(2, -4)}-${d.slice(-4)}`;
  const texto = `${titulo(c.nome || '').trim() || 'Contato indicado pelo cliente'} — ${tel}`;
  const n = await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{contato_vistoria}', to_jsonb(${texto}::text), true) WHERE id = ${leadId} AND COALESCE(TRIM("customFields"->>'contato_vistoria'), '') = ''`;
  return n > 0;
}

/** Poller (1 min, laço do credit-auto). */
export async function processContatosIndicados(accountId: string, io?: Io): Promise<void> {
  const { inNoticeWindow } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  if (!inNoticeWindow()) return;
  const leads = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false
      AND jsonb_typeof("customFields"->'_contatosIndicados') = 'array'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements("customFields"->'_contatosIndicados') c WHERE c->>'status' = 'PENDENTE')
    LIMIT 5`;
  for (const { id } of leads) await processarCard(accountId, id, io).catch((e) => console.error('[Contato indicado]', e?.message));
}

async function processarCard(accountId: string, leadId: string, io?: Io): Promise<void> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, userId: true, customFields: true } });
  const cf = (l?.customFields || {}) as Cf;
  const lista: ContatoIndicado[] = Array.isArray(cf._contatosIndicados) ? cf._contatosIndicados : [];
  for (const c of lista.filter((x) => x.status === 'PENDENTE')) {
    if (Date.now() - Date.parse(c.at) < ESPERA_MS) continue;
    await chamarIndicado(accountId, leadId, { name: l!.name, userId: l!.userId, cf }, c, io);
  }
}

/** Chama o corretor/vendedor indicado. Exportada pra rodar à mão num contato que se perdeu antes da correção (Jaime, 11/11). */
export async function chamarIndicado(accountId: string, leadId: string, lead: { name: string; userId: string | null; cf: Cf }, c: Pick<ContatoIndicado, 'nome' | 'telefone'> & { papel?: ContatoIndicado['papel'] }, io?: Io): Promise<string> {
  const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
  const pushColab = (title: string, body: string) => sendPushToAccount(accountId, { title, body, leadId }, lead.userId ? [lead.userId] : undefined).catch(() => {});
  const listas = await listasDoPedido(accountId);
  const todos = [...listas.imovel.map((t) => `${t} (do imóvel)`), ...listas.vendedor.map((t) => `${t} (do vendedor)`)];
  const leitura = await lerContato(leadId, c.nome, todos);
  if (!leitura) return 'não consegui ler a conversa agora (tento de novo no próximo minuto)';
  const papel = c.papel && c.papel !== 'outro' ? c.papel : leitura.papel;
  const quem = `${c.nome || 'sem nome'} (${c.telefone})`;
  // Contato pra acompanhar a vistoria → "Contato vistoria" do card do cliente (se vazio) — Fabio 12/11 (Pedro: "ele é quem acompanhará o avaliador").
  const vistoriaGravada = leitura.vistoria ? await gravarContatoVistoria(leadId, c).catch(() => false) : false;
  const vistoriaTxt = leitura.vistoria ? ` Ele vai acompanhar a vistoria${vistoriaGravada ? ' — gravei no campo "Contato vistoria"' : ''}.` : '';
  if (papel === 'outro') {
    await atualizarIndicado(leadId, c.telefone, { status: 'IGNORADO', papel, vistoria: leitura.vistoria });
    await nota(leadId, leitura.vistoria
      ? `📇 O cliente mandou o contato de ${quem} para acompanhar a vistoria${vistoriaGravada ? ' — gravei no campo "Contato vistoria"' : ''}. Não é o corretor nem o vendedor, então o CRM não pediu documentos a essa pessoa.`
      : `📇 O cliente mandou o contato de ${quem}. Pela conversa não é o corretor nem o vendedor do imóvel, então o CRM não chamou essa pessoa. Se for, chame você.`);
    return leitura.vistoria ? 'contato da vistoria (não é corretor/vendedor)' : 'ignorado (não é corretor/vendedor)';
  }
  const rotulo = papel === 'corretor' ? 'corretor' : 'vendedor';
  // Só o que ainda falta (Fabio 12/11): arquivo já classificado no card ou item já mandado na conversa sai do pedido.
  const compradores = [lead.cf.participante_1, lead.cf.participante_2, ...String(lead.name || '').split('/')].map((x) => String(x || '').trim()).filter((x) => x.split(/\s+/).length >= 2);
  const jaTem = (item: string, n: number) => itemNoCard(item, lead.cf, compradores) === true || leitura.jaMandou.includes(n);
  const faltam: ListasPedido = {
    imovel: listas.imovel.filter((t, i) => !jaTem(t, i + 1)),
    vendedor: listas.vendedor.filter((t, i) => !jaTem(t, listas.imovel.length + i + 1)),
  };
  const pedidos = [...faltam.imovel, ...faltam.vendedor];
  const jaVeio = [...listas.imovel, ...listas.vendedor].filter((t) => !pedidos.includes(t));
  if (!pedidos.length) {
    await atualizarIndicado(leadId, c.telefone, { status: 'JA_TINHA', papel, vistoria: leitura.vistoria, pedidos: [] });
    await nota(leadId, `📇 O cliente passou o contato do ${rotulo} ${quem}.${vistoriaTxt} A documentação do imóvel e do vendedor já está no card, então o CRM não pediu nada a ele.`);
    return 'documentação já estava no card (não chamou)';
  }
  const cliente = titulo(String(lead.cf.participante_1 || lead.name.split('/')[0] || lead.name));
  const { findOrCreateLeadByPhone, sendOutboundWhatsApp, sendOutboundWhatsAppTemplate } = require('./message.service') as typeof import('./message.service');
  const r = await findOrCreateLeadByPhone(accountId, c.telefone, c.nome || undefined);
  if (!r) {
    await atualizarIndicado(leadId, c.telefone, { status: 'FALHOU', papel, motivo: 'não criou o card do contato' });
    await nota(leadId, `⚠️ O cliente mandou o contato do ${rotulo} ${quem}, mas não consegui criar a conversa com ele. Chame você e peça a documentação do imóvel e do vendedor.`);
    pushColab(`⚠️ ${lead.name}: chamar o ${rotulo}`, `${quem} — o CRM não conseguiu abrir a conversa`);
    return 'falhou ao criar o card';
  }
  const t = await prisma.lead.findUnique({ where: { id: r.leadId }, select: { name: true, status: true, customFields: true, pipeline: { select: { department: { select: { name: true } } } } } });
  const tcf = (t?.customFields || {}) as Cf;
  const deOutroProcesso = !r.created && !(tcf._terceiroDe?.leadId === leadId) && (!!t?.pipeline?.department || !!tcf._terceiroDe);
  if (deOutroProcesso) {
    await atualizarIndicado(leadId, c.telefone, { status: 'EQUIPE', papel, terceiroLeadId: r.leadId, motivo: 'número já é de outro card' });
    await nota(leadId, `📇 O cliente mandou o contato do ${rotulo} ${quem}, mas esse número já é de outro card ("${t?.name || '—'}"), então o CRM não mandou nada sozinho. Peça você a documentação do imóvel e do vendedor.`);
    pushColab(`📇 ${lead.name}: contato do ${rotulo}`, `${quem} já tem card no CRM — peça você a documentação`);
    return 'número já é de outro card';
  }
  const vinculo: TerceiroDe = { leadId, cliente, papel, at: new Date().toISOString() };
  await prisma.$executeRaw`UPDATE "Lead" SET "aiAutoReplyActive" = false, "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_terceiroDe}', ${JSON.stringify(vinculo)}::jsonb, true) WHERE id = ${r.leadId}`;
  await nota(r.leadId, `📇 ${titulo(rotulo)} do imóvel de ${cliente} (card "${lead.name}"), indicado pelo cliente. A IA fica DESLIGADA nesta conversa; os arquivos que chegarem aqui vão sozinhos pro card do cliente.`);
  const texto = await textoPedido(accountId, { nome: c.nome, cliente, papel }, faltam);
  const { whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  let status: ContatoIndicado['status'];
  let como: string;
  if (await whatsappWindowOpen(r.leadId)) {
    const env = await sendOutboundWhatsApp({ accountId, leadId: r.leadId, content: texto, io: io as any });
    if (!env.success) { await atualizarIndicado(leadId, c.telefone, { status: 'FALHOU', papel, terceiroLeadId: r.leadId, motivo: env.error }); await nota(leadId, `⚠️ Não consegui mandar o pedido da documentação ao ${rotulo} ${quem}: ${env.error}.`); pushColab(`⚠️ ${lead.name}: chamar o ${rotulo}`, String(env.error || '').slice(0, 100)); return 'falhou ao enviar'; }
    status = 'ENVIADO'; como = 'mandou o pedido da documentação do imóvel e do vendedor';
  } else {
    const first = cliente.split(' ')[0] ? cliente : 'O cliente';
    let tpl = await sendOutboundWhatsAppTemplate({ accountId, leadId: r.leadId, templateName: DOC_TEMPLATE, language: 'pt_BR', bodyParams: [first], previewText: DOC_TEMPLATE_BODY.replace('{{1}}', first), io: io as any });
    if (!tpl.success) tpl = await sendOutboundWhatsAppTemplate({ accountId, leadId: r.leadId, templateName: 'ola_tudo_bem', language: 'pt_BR', bodyParams: [], previewText: 'Olá, tudo bem?', io: io as any });
    if (!tpl.success) { await atualizarIndicado(leadId, c.telefone, { status: 'FALHOU', papel, terceiroLeadId: r.leadId, motivo: tpl.error }); await nota(leadId, `⚠️ Não consegui abrir a conversa com o ${rotulo} ${quem} (modelo da Meta): ${tpl.error}. Chame você.`); pushColab(`⚠️ ${lead.name}: chamar o ${rotulo}`, String(tpl.error || '').slice(0, 100)); return 'falhou o modelo'; }
    const { queueOnReply } = require('./reply-pending.service') as typeof import('./reply-pending.service');
    await queueOnReply(prisma as any, { leadId: r.leadId, label: 'documentação do imóvel e do vendedor', text: texto, noteText: `⏳ O pedido da documentação do imóvel e do vendedor sai assim que ${c.nome || 'o contato'} responder.` });
    status = 'TEMPLATE'; como = 'abriu a conversa com o modelo da Meta; o pedido da documentação do imóvel e do vendedor sai quando ele responder';
  }
  await atualizarIndicado(leadId, c.telefone, { status, papel, terceiroLeadId: r.leadId, enviadoAt: new Date().toISOString(), vistoria: leitura.vistoria, pedidos });
  await nota(leadId, `📇 O cliente passou o contato do ${rotulo} ${quem}.${vistoriaTxt} O CRM ${como}${jaVeio.length ? ` — só o que falta: ${pedidos.join(', ')} (o resto já está no card: ${jaVeio.join(', ')})` : ''}. Os arquivos que ele mandar vêm sozinhos pra este card.`);
  pushColab(`📇 ${lead.name}: ${rotulo} chamado`, `${c.nome || c.telefone}: pedido ${jaVeio.length ? pedidos.join(', ') : 'a documentação do imóvel e do vendedor'}`.slice(0, 160));
  return status === 'ENVIADO' ? 'pedido enviado' : 'modelo enviado, pedido guardado';
}

/** Webhook: arquivo que chegou na conversa de um corretor/vendedor indicado → cópia no card do cliente (Fabio 11/11). `buffer` = bytes do arquivo (o
 *  original sobe pro Drive e sai do banco logo depois). */
export async function repassarArquivoDoTerceiro(accountId: string, terceiroLeadId: string, arq: { fileName: string; mimeType: string; caption?: string | null; buffer: Buffer }, io?: Io): Promise<void> {
  const t = await prisma.lead.findFirst({ where: { id: terceiroLeadId, accountId }, select: { name: true, customFields: true } });
  const v = ((t?.customFields || {}) as Cf)._terceiroDe as TerceiroDe | undefined;
  if (!t || !v?.leadId) return;
  const cliente = await prisma.lead.findFirst({ where: { id: v.leadId, accountId }, select: { id: true, name: true, userId: true } });
  if (!cliente) return;
  const de = `${v.papel === 'corretor' ? 'Corretor' : 'Vendedor'} ${t.name}`;
  const message = await prisma.message.create({
    data: {
      content: `📎 ${arq.fileName}${arq.caption ? ` — ${arq.caption}` : ''}`, direction: 'INBOUND', channel: 'WHATSAPP', leadId: cliente.id, read: false, status: 'DELIVERED',
      forwardedFromLeadId: terceiroLeadId, forwardedFromLeadName: de,
      attachments: { create: { leadId: cliente.id, fileName: arq.fileName, mimeType: arq.mimeType, data: arq.buffer } },
    },
    include: { attachments: true },
  });
  if (io) io.to(`lead:${cliente.id}`).emit('new_message', message);
  const { autoUploadAttachmentToDrive } = require('./google.service') as typeof import('./google.service');
  for (const att of message.attachments || []) autoUploadAttachmentToDrive(accountId, cliente.id, att.id).catch((e: any) => console.error('[Drive] arquivo do corretor/vendedor:', e?.message));
  const { scheduleDocsCheck } = require('./docs-checker.service') as typeof import('./docs-checker.service');
  scheduleDocsCheck(accountId, cliente.id, io as any).catch(() => {});
  const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
  sendPushToAccount(accountId, { title: `📎 ${cliente.name}: documento do ${v.papel}`, body: `${arq.fileName} (de ${t.name}) — copiado pro card do cliente`, leadId: cliente.id }, cliente.userId ? [cliente.userId] : undefined).catch(() => {});
}

/** Linha pro ESTADO DO CARD da IA do cliente: quem o CRM já chamou (ela não promete chamar de novo nem pede o contato outra vez). */
export function aiContatosIndicadosTexto(cf: Cf): string {
  const lista: ContatoIndicado[] = Array.isArray(cf._contatosIndicados) ? cf._contatosIndicados : [];
  const feitos = lista.filter((c) => c.status === 'ENVIADO' || c.status === 'TEMPLATE');
  if (!feitos.length) return '';
  return feitos.map((c) => `${c.papel === 'vendedor' ? 'vendedor' : 'corretor'} ${c.nome || c.telefone} (indicado pelo cliente): o CRM já chamou e pediu a documentação do imóvel e do vendedor em ${String(c.enviadoAt || c.at).slice(0, 10).split('-').reverse().join('/')}${c.status === 'TEMPLATE' ? ' — esperando ele responder' : ''}; o que ele mandar vem pra este card`).join('; ');
}
