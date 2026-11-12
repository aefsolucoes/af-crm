import { prisma } from '../lib/prisma';
import { sendPushToAccount } from './push.service';

/**
 * SIMULAÇÃO NO SIMULADOR DA CAIXA (Fabio 12/11: "sempre que um cliente aprovar na CAIXA, faz aquela mensagem de aprovação, encaminha ao cliente junto com a
 * simulação no simulador da CAIXA; no simulador ele pede um número — o CRM ou a extensão pode colocar o número da API, aí o código vai chegar e ele insere";
 * "na simulação da CAIXA precisa marcar taxa bonificada, quando houver").
 * simuladorhabitacao.caixa.gov.br: "Simulação Completa" (FH) / "Empréstimo com garantia de imóvel" (HE). Etapa 1 = CPF, nascimento, celular (= número da API),
 * renda bruta (soma de quem participa), 3 anos de FGTS, mais de um comprador e o aceite (Fabio: "pode marcar"). Ao avançar a CAIXA manda um código pelo WhatsApp
 * pro número da API → chega na Inbox → `codigoSimulacao` acha → a extensão digita. Etapas 2–4 em mapeamento: a extensão manda o que viu (`MAPEAR`) e para.
 */

type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | null | undefined;

/** Número da API Oficial (WhatsApp do CRM) — o código da CAIXA chega aqui. */
export const NUMERO_API_SIMULADOR = process.env.CAIXA_SIMULADOR_TELEFONE || '61981721313';
const LEASE_MS = 15 * 60_000;

const num = (v: unknown) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  let t = String(v ?? '').replace(/[^\d.,-]/g, '');
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  return Number(t) || 0;
};
const brl = (v: number) => v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dataBr = (v: unknown) => { const s = String(v || '').trim(); const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/); return iso ? `${iso[3]}/${iso[2]}/${iso[1]}` : /^\d{2}\/\d{2}\/\d{4}$/.test(s) ? s : ''; };

async function gravar(leadId: string, patch: Record<string, any>): Promise<void> {
  const fresh = ((await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }))?.customFields || {}) as Record<string, any>;
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...fresh, _caixaSimulacao: { ...(fresh._caixaSimulacao || {}), ...patch, atualizadoEm: new Date().toISOString() } } } });
}
async function nota(leadId: string, content: string, userId?: string | null) {
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content, ...(userId ? { userId } : {}) } }).catch(() => {});
}

/** Pede a simulação oficial (botão/teste agora; depois, sozinho quando a CAIXA aprovar). */
export async function pedirSimulacaoCaixa(accountId: string, leadId: string, por: { id?: string; nome: string }): Promise<{ erro: string } | { mensagem: string }> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  if (!lead) return { erro: 'Card não encontrado' };
  const st = ((lead.customFields || {}) as any)._caixaSimulacao?.status;
  if (['FILA', 'RODANDO'].includes(st)) return { erro: 'A simulação da CAIXA deste cliente já está em andamento.' };
  // Sem o WhatsApp do código conectado (QR), o código da CAIXA se perde — não roda (Fabio 12/11).
  if (!(require('./caixa-codigo-qr.service') as typeof import('./caixa-codigo-qr.service')).numeroQr(accountId)) return { erro: 'O WhatsApp do código da CAIXA (QR) está desconectado — escaneie em /caixa-codigo e peça de novo.' };
  const d = dadosDoCard((lead.customFields || {}) as Record<string, any>);
  if (d.cpf.length !== 11) return { erro: 'Sem o CPF do tomador (ficha de cadastro ou card).' };
  if (!d.nascimento) return { erro: 'Sem a data de nascimento do tomador.' };
  if (!d.renda) return { erro: 'Sem a renda (card ou ficha de cadastro).' };
  await gravar(leadId, { status: 'FILA', pedidoEm: new Date().toISOString(), por: por.nome, leaseAt: null, erro: null });
  await nota(leadId, `🧮 Simulação no simulador da CAIXA pedida por ${por.nome} — a extensão SIOPI (A&F) roda com o número da API pro código de verificação.`, por.id || null);
  return { mensagem: 'Pedido na fila: a extensão roda a simulação da CAIXA no próximo minuto.' };
}

/** Dados do card/ficha que o simulador pede. Tomador = 1º participante. */
function dadosDoCard(cf: Record<string, any>) {
  const ps: any[] = Array.isArray(cf._fichaCadastral?.participantes) ? cf._fichaCadastral.participantes : [];
  const p1 = ps.find((x, i) => (Number(x?.ordem) || i + 1) === 1) || {};
  const cpf = String(p1.cpf || cf.cpf_1 || '').replace(/\D/g, '');
  const nascimento = dataBr(p1.nascimento) || dataBr(cf.nascimento_1);
  const rendaFicha = ps.reduce((s, x) => s + num(x?.rendaBrutaMensal), 0);
  const renda = rendaFicha || num(cf.renda_1) + num(cf.renda_2);
  const maisDeUm = ps.length > 1 || !!String(cf.participante_2 || '').trim();
  const fgts = /sim|s\b|true/i.test(String(cf.fgts_3_anos ?? cf.usa_fgts ?? cf.fgts ?? ''));
  return { cpf, nascimento, renda, maisDeUm, fgts };
}

/** Etapa 2 do simulador ("Dados do imóvel"). Cidade/UF do imóvel → senão a do endereço do tomador (ficha) → senão Brasília/DF (12/11, Windson: o card não tinha a cidade). */
function imovelDoCard(cf: Record<string, any>, he: boolean) {
  const ps: any[] = Array.isArray(cf._fichaCadastral?.participantes) ? cf._fichaCadastral.participantes : [];
  const end = (ps.find((x, i) => (Number(x?.ordem) || i + 1) === 1) || {}).endereco || {};
  const ufImovel = String(cf.uf_imovel || cf.imovel_uf || '').trim().toUpperCase();
  const cidadeImovel = String(cf.cidade_imovel || cf.imovel_cidade || '').trim();
  const [uf, cidade0] = ufImovel && cidadeImovel ? [ufImovel, cidadeImovel] : end.uf && end.cidade ? [String(end.uf).toUpperCase(), String(end.cidade)] : ['DF', 'BRASILIA'];
  // DF: Taguatinga, Ceilândia etc. são regiões administrativas — o município é Brasília (Windson: imóvel na CSG 3, Taguatinga).
  const cidade = uf === 'DF' ? 'BRASILIA' : cidade0;
  const tipo = `${cf.imovel_tipo || ''} ${cf.tipo_imovel || ''} ${cf.condicao_imovel || ''}`;
  const deseja = he ? 'emprestimo' : /terreno|lote/i.test(tipo) ? 'terreno' : /constru/i.test(tipo) ? 'construir' : /novo|planta|lan[çc]amento/i.test(tipo) ? 'novo' : 'usado';
  const sim = (v: unknown) => /^(s|sim|true|1)/i.test(String(v ?? '').trim());
  return {
    tipoImovel: /comercial|sala|loja/i.test(tipo) ? 'comercial' : 'residencial',
    deseja,
    valorImovel: brl(num(cf.valor_imovel)),
    uf, cidade,
    subsidio: sim(cf.subsidio || cf.recebeu_subsidio),
    outroImovelCidade: sim(cf.outro_imovel_cidade || cf.possui_imovel_cidade),
    origemCidade: ufImovel && cidadeImovel ? 'card' : end.uf && end.cidade ? 'endereço do tomador' : 'padrão DF',
  };
}

/** Fila da extensão. */
export async function proximaSimulacaoCaixa(accountId: string): Promise<any | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND "customFields"->'_caixaSimulacao'->>'status' IN ('FILA','RODANDO')
     ORDER BY "updatedAt" ASC LIMIT 5`;
  for (const { id } of rows) {
    const lead = await prisma.lead.findUnique({ where: { id }, select: { name: true, customFields: true, pipeline: { select: { department: { select: { name: true } } } } } });
    const cf = (lead?.customFields || {}) as Record<string, any>;
    const s = cf._caixaSimulacao || {};
    if (s.status === 'RODANDO' && !(s.leaseAt && Date.now() - Date.parse(s.leaseAt) > LEASE_MS)) continue;
    if (!(require('./caixa-codigo-qr.service') as typeof import('./caixa-codigo-qr.service')).numeroQr(accountId)) return null; // espera o QR voltar
    const he = /home|garantia/i.test(lead?.pipeline?.department?.name || '');
    const d = dadosDoCard(cf);
    await gravar(id, { status: 'RODANDO', leaseAt: new Date().toISOString(), inicio: new Date().toISOString() });
    return {
      leadId: id,
      leadName: lead?.name || '',
      produto: he ? 'HE' : 'FH',
      // Número conectado por QR (recebe o código — a API Oficial não lê a mensagem da CAIXA, erro 131051); sem QR, o da API (o código se perde).
      celular: (require('./caixa-codigo-qr.service') as typeof import('./caixa-codigo-qr.service')).numeroQr(accountId)!,
      dados: {
        cpf: d.cpf, nascimento: d.nascimento, renda: brl(d.renda), maisDeUm: d.maisDeUm, fgts3anos: d.fgts,
        valorFinanciamento: brl(num(cf.valor_credito)),
        prazoMeses: num(cf._fhPrazo || cf.prazo_meses || cf.prazo) || null,
        ...imovelDoCard(cf, he),
      },
    };
  }
  return null;
}

/** Código de verificação que a CAIXA mandou pro WhatsApp da API depois de `desde` (a extensão pergunta a cada poucos segundos). */
export async function codigoSimulacao(accountId: string, desde: Date): Promise<{ codigo: string; em: string } | null> {
  const doQr = (require('./caixa-codigo-qr.service') as typeof import('./caixa-codigo-qr.service')).codigoQr(accountId, desde);
  if (doQr) return doQr;
  const msgs = await prisma.message.findMany({
    where: { direction: 'INBOUND', createdAt: { gte: new Date(desde.getTime() - 30_000) }, lead: { accountId } },
    orderBy: { createdAt: 'desc' }, take: 30, select: { content: true, createdAt: true },
  });
  for (const m of msgs) {
    const t = String(m.content || '');
    if (!/c[óo]digo|verifica|caixa|simula/i.test(t)) continue;
    const c = (t.match(/\b(\d{4,8})\b/) || [])[1];
    if (c) return { codigo: c, em: m.createdAt.toISOString() };
  }
  return null;
}

/** Resultado/andamento da extensão → card. MAPEAR = tela que a extensão ainda não sabe preencher (vai o retrato dela pra eu mapear). */
export async function gravarSimulacaoCaixa(accountId: string, leadId: string, body: { etapa: string; texto?: string; campos?: any[]; erro?: string; tela?: string }, _io?: Io): Promise<void> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true } });
  if (!lead) throw new Error('Card não encontrado');
  const etapa = String(body.etapa || '').toUpperCase();
  const campos = (body.campos || []).map((c: any) => `• ${c.rotulo || c.label || '?'}${c.tipo ? ` [${c.tipo}]` : ''}${c.opcoes?.length ? ` — opções: ${c.opcoes.join(' | ')}` : ''}${c.valor ? ` = ${c.valor}` : ''}`).join('\n');
  if (etapa === 'CODIGO_ENVIADO') { await gravar(leadId, { codigoPedidoEm: new Date().toISOString() }); return; }
  if (etapa === 'MAPEAR') {
    await gravar(leadId, { status: 'MAPEAR', leaseAt: null, tela: body.tela || null, retrato: { texto: (body.texto || '').slice(0, 4000), campos: body.campos || [] } });
    await nota(leadId, `🧮 Simulação CAIXA parou numa tela que a extensão ainda não conhece (${body.tela || '—'}):\n${(body.texto || '').slice(0, 1500)}${campos ? `\n\nCampos:\n${campos}` : ''}`);
    return;
  }
  const status = etapa === 'PRONTA' ? 'PRONTA' : 'ERRO';
  await gravar(leadId, { status, leaseAt: null, erro: body.erro || null, resultado: etapa === 'PRONTA' ? { texto: (body.texto || '').slice(0, 4000), campos: body.campos || [] } : undefined });
  await nota(leadId, etapa === 'PRONTA' ? `🧮 Simulação da CAIXA pronta:\n${(body.texto || '').slice(0, 2000)}` : `⚠️ Simulação da CAIXA parou: ${String(body.erro || etapa).slice(0, 400)}${body.texto ? `\n${body.texto.slice(0, 600)}` : ''}`);
  if (etapa !== 'PRONTA') await sendPushToAccount(accountId, { title: `🧮 ${lead.name}: simulação CAIXA parou`, body: String(body.erro || etapa).slice(0, 120), leadId }).catch(() => {});
}
