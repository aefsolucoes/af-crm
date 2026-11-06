import { prisma } from '../lib/prisma';
import { sendPushToAccount } from './push.service';
import { pedirContatoVistoria } from './vistoria-creditas.service';
import { arquivosDoImovel, moverParaVistoria } from './vistoria-inter.service';

/**
 * VISTORIA DA CAIXA PELO SIOPI (Fabio 06/11: "uma extensão para solicitar a vistoria de um imóvel na CAIXA"; "todo o processo do SIOPI será nessa extensão").
 * Botão "Solicitar vistoria CAIXA" no bloco CAIXA do card → o CRM:
 *  1. lê a certidão de matrícula/ônus (pasta IMOVEL do Drive) + o IPTU e monta a ficha do imóvel (`_vistoriaCaixa.ficha`);
 *  2. confere o contato da vistoria: campo "Contato vistoria" do card → senão lê a conversa (já foi pedido/respondido?) → senão pergunta ao cliente (mesmo fluxo da Creditas);
 *  3. põe na fila da extensão "SIOPI (A&F)" (GET /api/vistoria-caixa/fila): ela CADASTRA o imóvel (Serviços → Cadastro de Imóveis → Individual) e monta a OS de engenharia
 *     até a última tela — e PARA ali (`OS_PRONTA`). A OS só é criada no clique "Enviar OS" (status ENVIAR) — no começo, com a conferência do Fabio.
 * Regras do Fabio (06/11): só os campos obrigatórios; DF não tem número → "0"; área comum 0 quando o documento não traz; descrição IGUAL à certidão + matrícula e cartório;
 * cartório pela pesquisa do SIOPI (UF + cidade); OS: FH = finalidade 1 (Avaliação Financiamento Habitacional), HE = 4 (Avaliação Garantia Empréstimos); Laudo Simplificado;
 * valor = "Valor do crédito" do card; atribuição A413-F30-P171 (220); deslocamento Terrestre; motivo "FINANCIAMENTO HABITACIONAL".
 */

type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | null | undefined;
type Estado = 'LENDO' | 'AGUARDANDO_CONTATO' | 'FILA' | 'RODANDO' | 'OS_PRONTA' | 'ENVIAR' | 'ENVIANDO' | 'DOCUMENTOS' | 'ANEXANDO' | 'TAXA_PRONTA' | 'BOLETO' | 'BAIXANDO_BOLETO' | 'ENVIADA' | 'JA_TEM_OS' | 'OUTRO_CCA' | 'ERRO';

const MODELO = 'claude-sonnet-5';
const LEASE_MS = 20 * 60_000;
const MAX_PDF = 20_000_000;

const SYSTEM_IMOVEL = `Você lê a CERTIDÃO DE MATRÍCULA / CERTIDÃO DE ÔNUS de um imóvel (às vezes junto vem um documento do IPTU do mesmo imóvel) para cadastrar o imóvel no SIOPI da CAIXA.
Extraia SÓ o que está escrito — nunca invente. Campo que os documentos não mostram = null. Responda APENAS um JSON:
{
 "matricula": "só os dígitos do número da matrícula (14.421 → 14421)",
 "livro": "número do livro (\\"Livro 2 - Registro Geral\\" → \\"2\\")",
 "cartorio": { "nome": "nome do cartório EXATAMENTE como no cabeçalho", "ordinal": número do ofício/serviço (\\"4º Ofício\\" → 4; sem número → null), "cidade": "cidade/comarca do cartório", "uf": "UF" },
 "descricao": "o parágrafo que DESCREVE o imóvel, palavra por palavra como está na certidão (o texto depois de \\"IMÓVEL:\\" até antes de \\"Proprietário\\"/\\"Proprietária\\"/\\"Registro anterior\\"); mantenha maiúsculas/minúsculas, aspas e pontuação",
 "tipo": "APARTAMENTO" | "CASA" | "TERRENO" | "SALA" | "LOJA" | "GALPAO" | "OUTRO" (o estado ATUAL: averbação de construção de casa num terreno → CASA),
 "areaPrivativa": número em m² (apartamento/sala: área privativa ou útil da unidade; casa: área construída averbada; terreno: área do terreno),
 "areaComum": número em m² ou null, "areaTerreno": número em m² ou null, "fracaoIdeal": "texto" ou null,
 "endereco": { "logradouro": "como nos Correios, sem o bloco/unidade (\\"QI 10\\", \\"Rua das Flores\\", \\"Avenida Brasil\\")", "numero": "número da porta ou null", "bloco": "letra/número do bloco ou null", "unidade": "apartamento/sala/lote ou null", "bairro": "bairro/setor", "cidade": "cidade", "uf": "UF", "cep": "só se escrito" },
 "inscricaoMunicipal": "inscrição do IPTU, se algum documento trouxer",
 "condominio": true se é unidade em condomínio/prédio (apartamento, sala, loja em prédio), senão false,
 "problemas": ["o que impede o cadastro: ilegível, mais de um imóvel, matrícula encerrada etc."]
}`;

const SYSTEM_CONTATO = `Você lê a conversa de WhatsApp entre a equipe de uma correspondente bancária e o cliente. Responda APENAS um JSON:
{ "perguntado": true se a equipe/IA já perguntou quem acompanha (ou o contato para) a vistoria do imóvel,
  "contato": { "nome": "...", "telefone": "só dígitos com DDD" } se o cliente (ou a equipe) já disse quem acompanha a vistoria — "pode ser eu" = o próprio cliente; senão null }
Use só o que está na conversa. Telefone que não aparece = null.`;

async function chamarIA(system: string, content: any[], maxTokens: number): Promise<any | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODELO, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] }),
    }).catch(() => null);
    if (!res || !res.ok) { console.error('[Vistoria CAIXA] Anthropic', res?.status, res ? (await res.text()).slice(0, 200) : ''); continue; }
    const data = (await res.json()) as { content: { type: string; text?: string }[] };
    const raw = data.content?.find((b) => b.type === 'text')?.text || '';
    try { return JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || ''); } catch { /* JSON cortado: tenta de novo */ }
  }
  return null;
}

const semAcento = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
// O card guarda número com PONTO decimal ("292998.84"); documento/IA pode mandar no formato BR ("1.234,56"). Só com vírgula o ponto é milhar.
const num = (v: unknown) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let t = String(v ?? '').replace(/[^\d.,-]/g, '');
  if (!t) return null;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const brlSemSimbolo = (v: unknown) => { const n = num(v); return n && n > 0 ? n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : ''; };
const area4 = (v: unknown) => { const n = num(v); return (n && n > 0 ? n : 0).toLocaleString('pt-BR', { minimumFractionDigits: 4, maximumFractionDigits: 4, useGrouping: false }); };
const fmtMatricula = (m: string) => Number(m).toLocaleString('pt-BR');

async function gravar(leadId: string, patch: Record<string, any>): Promise<Record<string, any>> {
  const fresh = ((await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }))?.customFields || {}) as Record<string, any>;
  const atual = { ...(fresh._vistoriaCaixa || {}), ...patch, atualizadoEm: new Date().toISOString() };
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...fresh, _vistoriaCaixa: atual } } });
  return atual;
}
async function nota(leadId: string, content: string, userId?: string | null) {
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content, ...(userId ? { userId } : {}) } }).catch(() => {});
}
async function push(accountId: string, leadId: string, title: string, body: string) {
  await sendPushToAccount(accountId, { title, body, leadId }).catch(() => {});
}

/** Certidão de matrícula/ônus (+ IPTU) da pasta IMOVEL → ficha do imóvel. */
async function lerFichaImovel(accountId: string, cf: Record<string, any>): Promise<{ ficha: any } | { erro: string }> {
  const arquivos = await arquivosDoImovel(accountId, cf);
  const nomeTipo = (n: string) => semAcento(n).toUpperCase();
  const certidao = arquivos.find((f) => /CERTIDAO DE ONUS|MATRICULA|INTEIRO TEOR/.test(nomeTipo(f.name)) && !/ 2\.PDF$/.test(nomeTipo(f.name)));
  if (!certidao) return { erro: 'Não achei a certidão de matrícula/ônus na pasta IMOVEL do Drive do cliente.' };
  const iptu = arquivos.find((f) => /IPTU|CADASTRO IMOBILIARIO/.test(nomeTipo(f.name)));
  const google = await import('./google.service');
  const content: any[] = [];
  for (const f of [certidao, iptu].filter(Boolean) as typeof arquivos) {
    try {
      if (f.mimeType === 'application/pdf' && (f.size || 0) <= MAX_PDF) {
        const buf = await google.downloadDriveFile(accountId, f.id, f.mimeType);
        content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } });
      } else {
        const texto = await google.ocrDriveFileToText(accountId, f.id);
        if (texto.trim()) content.push({ type: 'text', text: texto.slice(0, 120_000) });
      }
      content.push({ type: 'text', text: `Arquivo acima: ${f.path} > ${f.name}` });
    } catch (e: any) { console.error('[Vistoria CAIXA] download', f.name, e?.message); }
  }
  if (!content.length) return { erro: 'Não consegui abrir a certidão do imóvel no Drive.' };
  const ficha = await chamarIA(SYSTEM_IMOVEL, content, 6000);
  if (!ficha?.matricula || !ficha?.descricao) return { erro: 'Não consegui ler a matrícula e a descrição do imóvel na certidão.' };
  ficha.arquivo = certidao.name;
  ficha.arquivoId = certidao.id; // a extensão anexa esse arquivo na OS ("Incluir Documentos" → Certidão da Matrícula)
  ficha.arquivoMime = certidao.mimeType;
  return { ficha };
}

/** CEP pelo endereço (ViaCEP): a QI do DF tem um CEP por bloco/conjunto — escolhe o do bloco. */
async function cepDoImovel(ficha: any, cf: Record<string, any>): Promise<string | null> {
  const doc = String(ficha?.endereco?.cep || cf.imovel_cep || '').replace(/\D/g, '');
  if (doc.length === 8) return doc;
  const e = ficha?.endereco || {};
  const uf = String(e.uf || ficha?.cartorio?.uf || '').toUpperCase();
  const cidade = uf === 'DF' ? 'Brasilia' : semAcento(e.cidade || '');
  const logr = String(e.logradouro || '').trim();
  if (!uf || !cidade || logr.length < 3) return null;
  try {
    // ViaCEP às vezes não responde do servidor (06/11, 2ª leitura da Fernanda): tenta 3x; sem CEP a extensão procura pelo navegador.
    let lista: { cep: string; logradouro: string; complemento: string; bairro: string }[] = [];
    for (let i = 0; i < 3 && !lista.length; i++) {
      try {
        const r = await fetch(`https://viacep.com.br/ws/${encodeURIComponent(uf)}/${encodeURIComponent(cidade)}/${encodeURIComponent(logr.replace(/([A-Za-z])-(\d)/g, '$1 $2'))}/json/`, { signal: AbortSignal.timeout(12000) });
        const j = await r.json();
        if (Array.isArray(j)) lista = j;
      } catch { await new Promise((ok) => setTimeout(ok, 1500)); }
    }
    if (!Array.isArray(lista) || !lista.length) return null;
    const norm = (s: string) => semAcento(s).toUpperCase().replace(/\s+/g, ' ').trim();
    const bairro = norm(String(e.bairro || '').split(/[\/,-]/).pop() || '');
    const doBairro = lista.filter((x) => !bairro || norm(x.bairro).includes(bairro) || bairro.includes(norm(x.bairro)));
    const base = doBairro.length ? doBairro : lista;
    const bloco = String(e.bloco || '').trim();
    const comBloco = bloco ? base.find((x) => new RegExp(`\\b(BLOCO|CONJUNTO|CONJ\\.?)\\s+${bloco.toUpperCase()}\\b`).test(norm(`${x.logradouro} ${x.complemento}`))) : null;
    const exato = base.find((x) => norm(x.logradouro) === norm(logr) || norm(x.logradouro).endsWith(` ${norm(logr)}`));
    return String((comBloco || exato || (base.length === 1 ? base[0] : null))?.cep || '').replace(/\D/g, '') || null;
  } catch { return null; }
}

/** "Contato vistoria" do card → { nome, telefone }. Sem telefone = incompleto. */
function partirContato(texto: string): { nome: string; telefone: string } | null {
  const t = String(texto || '').trim();
  if (!t) return null;
  const fone = (t.match(/\(?\d{2}\)?\s*9?\s*\d{4}[-\s.]?\d{4}/) || [])[0] || '';
  const digitos = fone.replace(/\D/g, '');
  const nome = t.replace(fone, '').replace(/[\-–—:|,;/()]+/g, ' ').replace(/\b(tel|telefone|cel|celular|whats(app)?|fone)\b\.?/gi, ' ').replace(/\s+/g, ' ').trim();
  if (digitos.length < 10 || !nome) return null;
  return { nome: nome.slice(0, 44), telefone: digitos };
}

/** Lê a conversa antes de perguntar (Fabio 06/11: "o CRM também lê a conversa antes para verificar se já não foi pedido isso"). */
async function contatoDaConversa(leadId: string, cf: Record<string, any>, nomeCliente: string, foneCliente: string): Promise<{ perguntado: boolean; contato: { nome: string; telefone: string } | null }> {
  const msgs = await prisma.message.findMany({ where: { leadId, channel: 'WHATSAPP', callWaCallId: null }, orderBy: { createdAt: 'desc' }, take: 80, select: { direction: true, content: true, createdAt: true } });
  if (!msgs.length) return { perguntado: false, contato: null };
  const texto = msgs.reverse().map((m) => `[${m.createdAt.toISOString().slice(0, 16).replace('T', ' ')}] ${m.direction === 'INBOUND' ? 'CLIENTE' : 'EQUIPE'}: ${String(m.content || '').slice(0, 500)}`).join('\n');
  const r = await chamarIA(SYSTEM_CONTATO, [{ type: 'text', text: `Cliente: ${nomeCliente} (telefone ${foneCliente || 'não informado'})\n\n${texto}` }], 600);
  const c = r?.contato;
  const tel = String(c?.telefone || '').replace(/\D/g, '') || (c?.nome && semAcento(c.nome).toUpperCase().includes(semAcento(nomeCliente).toUpperCase().split(' ')[0]) ? foneCliente : '');
  return { perguntado: !!r?.perguntado, contato: c?.nome && tel.length >= 10 ? { nome: String(c.nome).slice(0, 44), telefone: tel } : null };
}

const ehHE = (dep: string) => /home|garantia/i.test(dep || '');

/** Ficha do imóvel + card → o que a extensão preenche no SIOPI (só os obrigatórios). */
function montarDadosSiopi(ficha: any, cf: Record<string, any>, cep: string | null, he: boolean) {
  const e = ficha.endereco || {};
  const tipo = String(ficha.tipo || '').toUpperCase();
  const construcao = { APARTAMENTO: 1, CASA: 2, TERRENO: 7, SALA: 9, LOJA: 10 }[tipo as 'CASA'] || (ficha.condominio ? 6 : 4);
  const tipoImovel = tipo === 'TERRENO' ? 3 : /SALA|LOJA|GALPAO/.test(tipo) ? 2 : 1;
  const uf = String(e.uf || ficha.cartorio?.uf || '').toUpperCase();
  const cidadeCartorio = String(ficha.cartorio?.cidade || e.cidade || '');
  const descricao = `${String(ficha.descricao).trim().replace(/\s+/g, ' ')}${/[.]$/.test(String(ficha.descricao).trim()) ? '' : '.'} Matrícula nº ${fmtMatricula(ficha.matricula)} do ${String(ficha.cartorio?.nome || 'cartório de registro de imóveis').trim()}, Livro ${ficha.livro || '2'}.`;
  return {
    imovel: {
      matricula: String(ficha.matricula).replace(/\D/g, ''),
      livro: String(ficha.livro || '2').replace(/\D/g, '') || '2',
      cartorio: { uf: String(ficha.cartorio?.uf || uf).toUpperCase(), cidade: uf === 'DF' ? 'BRASILIA' : semAcento(cidadeCartorio).toUpperCase(), ordinal: ficha.cartorio?.ordinal ?? null, nome: ficha.cartorio?.nome || '' },
      cep,
      logradouro: e.logradouro || '',
      bloco: e.bloco || '',
      bairro: e.bairro || '',
      uf,
      municipio: uf === 'DF' ? 'BRASILIA' : semAcento(e.cidade || '').toUpperCase(),
      numero: String(e.numero || '').replace(/\D/g, '').slice(0, 5) || '0', // DF não tem número → 0 (Fabio 06/11)
      areaPrivativa: area4(ficha.areaPrivativa),
      areaComum: area4(ficha.areaComum), // sem área comum no documento → 0 (Fabio 06/11)
      descricao,
      tipoImovel,
      categoria: 2, // Usado
      construcao,
      valorCompraVenda: brlSemSimbolo(cf.valor_imovel),
      implantacao: ficha.condominio ? 1 : 2,
      testada: '0,00',
      conservacaoCondominio: 1,
      uniao: 'N',
    },
    os: {
      finalidade: he ? 4 : 1, // HE = Avaliação Garantia Empréstimos; FH = Avaliação Financiamento Habitacional (Fabio 06/11)
      peca: 1, // Laudo Simplificado
      valor: brlSemSimbolo(cf.valor_credito),
      atribuicao: 220, // A413 - F30 - P171 - Avaliação Finan. Habitacional
      laudoLinha: 42, // 042 - Valor de Mercado (obrigatório; a confirmar com o Fabio)
      deslocamento: 1, // Terrestre
      motivo: 'FINANCIAMENTO HABITACIONAL',
    },
  };
}

/** Botão "Solicitar vistoria CAIXA". Responde na hora; a leitura da certidão segue em segundo plano. */
export async function solicitarVistoriaCaixa(accountId: string, leadId: string, user: { id: string; nome: string }, io?: Io): Promise<{ erro: string } | { mensagem: string }> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  if (!lead) return { erro: 'Card não encontrado' };
  const cf = (lead.customFields || {}) as Record<string, any>;
  const vc = cf._vistoriaCaixa || {};
  if (['LENDO', 'FILA', 'RODANDO', 'ENVIAR', 'ENVIANDO', 'DOCUMENTOS', 'ANEXANDO'].includes(vc.status)) return { erro: 'A vistoria da CAIXA deste cliente já está em andamento.' };
  if (vc.status === 'ENVIADA' || vc.status === 'TAXA_PRONTA') return { erro: `A vistoria da CAIXA já foi solicitada${vc.os?.numero ? ` (OS ${vc.os.numero})` : ''}.` };
  if (!String(cf.link_pasta_drive || '').trim()) return { erro: 'O card não tem a pasta do Drive (a certidão do imóvel fica na pasta IMOVEL).' };
  if (!brlSemSimbolo(cf.valor_credito)) return { erro: 'Preencha o "Valor do crédito" do card (vai como valor proposto a financiar).' };
  if (!brlSemSimbolo(cf.valor_imovel)) return { erro: 'Preencha o "Valor do imóvel" do card (vai como valor de compra e venda).' };
  await gravar(leadId, { status: 'LENDO', pedidoEm: new Date().toISOString(), por: user.nome, porId: user.id, erro: null, tentativas: 0 });
  await nota(leadId, `🏠 Vistoria CAIXA pedida por ${user.nome} — lendo a certidão do imóvel pra cadastrar no SIOPI.`, user.id);
  prepararVistoria(accountId, leadId, user, io).catch(async (e) => {
    console.error('[Vistoria CAIXA]', leadId, e?.message);
    await gravar(leadId, { status: 'ERRO', erro: e?.message || 'erro ao preparar' });
  });
  return { mensagem: 'Lendo a certidão do imóvel. Em seguida a extensão do SIOPI cadastra o imóvel e prepara a OS da vistoria.' };
}

async function prepararVistoria(accountId: string, leadId: string, user: { id: string; nome: string }, io?: Io): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, customFields: true, contact: { select: { phone: true } }, pipeline: { select: { department: { select: { name: true } } } } } });
  if (!lead) return;
  const cf = (lead.customFields || {}) as Record<string, any>;
  const lida = await lerFichaImovel(accountId, cf);
  if ('erro' in lida) {
    await gravar(leadId, { status: 'ERRO', erro: lida.erro });
    await nota(leadId, `⚠️ Vistoria CAIXA: ${lida.erro}`);
    await push(accountId, leadId, `🏠 ${lead.name}: vistoria CAIXA parada`, lida.erro);
    return;
  }
  const ficha = lida.ficha;
  const cep = await cepDoImovel(ficha, cf);
  const dados = montarDadosSiopi(ficha, cf, cep, ehHE(lead.pipeline?.department?.name || ''));
  // CEP achado fica no card ("CEP do imóvel"): a próxima leitura usa ele e não depende do ViaCEP.
  if (cep && !String(cf.imovel_cep || '').replace(/\D/g, '')) {
    const fresh = ((await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }))?.customFields || {}) as Record<string, any>;
    await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...fresh, imovel_cep: cep.replace(/^(\d{5})(\d{3})$/, '$1-$2') } } });
  }
  const faltas = [!dados.imovel.logradouro && 'logradouro', !dados.imovel.bairro && 'bairro', !(num(ficha.areaPrivativa) || 0) && 'área do imóvel', ...(Array.isArray(ficha.problemas) ? ficha.problemas : [])].filter(Boolean) as string[];
  await gravar(leadId, { ficha, dados, faltas });
  await nota(leadId, [
    `🏠 Vistoria CAIXA — dados do imóvel lidos da certidão (${ficha.arquivo}):`,
    `Matrícula ${fmtMatricula(ficha.matricula)} • ${ficha.cartorio?.nome || 'cartório?'} • Livro ${dados.imovel.livro}`,
    `Endereço: ${dados.imovel.logradouro}${dados.imovel.bloco ? ` Bloco ${dados.imovel.bloco}` : ''}, ${dados.imovel.bairro} — ${dados.imovel.municipio}/${dados.imovel.uf} • CEP ${cep || '— (a extensão procura pelo endereço, se precisar cadastrar)'}`,
    `Área privativa ${dados.imovel.areaPrivativa} m² • ${String(ficha.tipo || '').toLowerCase()}${ficha.condominio ? ' em condomínio' : ''} • compra e venda R$ ${dados.imovel.valorCompraVenda} • a financiar R$ ${dados.os.valor}`,
    `Descrição: ${dados.imovel.descricao}`,
    faltas.length ? `⚠️ Falta/conferir: ${faltas.join('; ')}` : '',
  ].filter(Boolean).join('\n'));
  if (!dados.imovel.logradouro) {
    await gravar(leadId, { status: 'ERRO', erro: `Falta ${faltas.join(', ')}` });
    await push(accountId, leadId, `🏠 ${lead.name}: vistoria CAIXA parada`, `Falta ${faltas.join(', ')} — preencha "CEP do imóvel" no card e clique de novo.`);
    return;
  }
  await conferirContato(accountId, leadId, user, io);
}

/** Contato da vistoria: card → conversa → pergunta ao cliente. Com contato completo → fila da extensão. */
async function conferirContato(accountId: string, leadId: string, user: { id: string; nome: string } | null, io?: Io): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, customFields: true, contact: { select: { phone: true } } } });
  if (!lead) return;
  const cf = (lead.customFields || {}) as Record<string, any>;
  let contato = partirContato(cf.contato_vistoria);
  if (!contato) {
    const nomeCliente = String(cf.participante_1 || lead.name || '').trim();
    const fone = String(cf.telefone_1 || lead.contact?.phone || '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
    const conversa = await contatoDaConversa(leadId, cf, nomeCliente, fone);
    if (conversa.contato) {
      contato = conversa.contato;
      const texto = `${contato.nome} - ${contato.telefone.replace(/^(\d{2})(\d{4,5})(\d{4})$/, '($1) $2-$3')}`;
      const fresh = ((await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }))?.customFields || {}) as Record<string, any>;
      if (!String(fresh.contato_vistoria || '').trim()) await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...fresh, contato_vistoria: texto } } });
      await nota(leadId, `🏠 Contato da vistoria achado na conversa: ${texto} (gravado no campo "Contato vistoria").`);
    } else if (conversa.perguntado) {
      await gravar(leadId, { status: 'AGUARDANDO_CONTATO' });
      await nota(leadId, '🏠 Vistoria CAIXA esperando o contato: o cliente já foi perguntado na conversa e ainda não respondeu quem acompanha a vistoria. Quando o campo "Contato vistoria" for preenchido, a extensão segue sozinha.');
      return;
    } else {
      const r = await pedirContatoVistoria(accountId, leadId, user?.id || '', io as any).catch((e: any) => { console.error('[Vistoria CAIXA] contato', e?.message); return 'erro' as const; });
      await gravar(leadId, { status: 'AGUARDANDO_CONTATO' });
      if (r === 'erro') {
        await nota(leadId, '⚠️ Vistoria CAIXA: não consegui perguntar ao cliente quem acompanha a vistoria. Preencha o campo "Contato vistoria" (nome e telefone) — a extensão segue sozinha.');
        await push(accountId, leadId, `🏠 ${lead.name}: falta o contato da vistoria`, 'Preencha "Contato vistoria" no card (nome e telefone).');
      }
      return;
    }
  }
  await gravar(leadId, { status: 'FILA', contato, erro: null, leaseAt: null });
}

/** A cada 2 min: quem esperava o contato e já tem → fila; extensão que sumiu no meio (lease vencido) → volta pra fila (até 3x). */
export async function processVistoriaCaixa(io?: Io): Promise<void> {
  const rows = await prisma.$queryRaw<{ id: string; accountId: string; status: string; leaseAt: string | null; tentativas: number | null }[]>`
    SELECT id, "accountId", "customFields"->'_vistoriaCaixa'->>'status' AS status, "customFields"->'_vistoriaCaixa'->>'leaseAt' AS "leaseAt",
           ("customFields"->'_vistoriaCaixa'->>'tentativas')::int AS tentativas
      FROM "Lead" WHERE "customFields"->'_vistoriaCaixa'->>'status' IN ('AGUARDANDO_CONTATO','RODANDO','ENVIANDO','ANEXANDO','BAIXANDO_BOLETO')`;
  for (const r of rows) {
    try {
      if (r.status === 'AGUARDANDO_CONTATO') {
        const cf = ((await prisma.lead.findUnique({ where: { id: r.id }, select: { customFields: true } }))?.customFields || {}) as Record<string, any>;
        const contato = partirContato(cf.contato_vistoria);
        if (contato) { await gravar(r.id, { status: 'FILA', contato }); await nota(r.id, `🏠 Contato da vistoria preenchido (${cf.contato_vistoria}) — a vistoria CAIXA entrou na fila da extensão do SIOPI.`); }
        continue;
      }
      if (r.leaseAt && Date.now() - new Date(r.leaseAt).getTime() > LEASE_MS) {
        const tent = (r.tentativas || 0) + 1;
        if (tent >= 3) {
          await gravar(r.id, { status: 'ERRO', erro: 'A extensão do SIOPI começou 3 vezes e não terminou.' });
          await nota(r.id, '⚠️ Vistoria CAIXA: a extensão do SIOPI começou 3 vezes e não terminou. Confira o SIOPI aberto no Chrome (login) e clique de novo em "Solicitar vistoria CAIXA".');
          await push(r.accountId, r.id, '🏠 Vistoria CAIXA travou', 'A extensão do SIOPI não terminou — confira o Chrome.');
        } else await gravar(r.id, { status: r.status === 'ENVIANDO' ? 'ENVIAR' : r.status === 'ANEXANDO' ? 'DOCUMENTOS' : r.status === 'BAIXANDO_BOLETO' ? 'BOLETO' : 'FILA', leaseAt: null, tentativas: tent });
      }
    } catch (e: any) { console.error('[Vistoria CAIXA] poll', r.id, e?.message); }
  }
}

/** Fila da extensão: o próximo card em FILA (cadastra + prepara a OS, sem enviar) ou ENVIAR (cria a OS). */
export async function proximaVistoriaCaixa(accountId: string): Promise<any | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND "customFields"->'_vistoriaCaixa'->>'status' IN ('FILA','ENVIAR','DOCUMENTOS','BOLETO')
     ORDER BY ("customFields"->'_vistoriaCaixa'->>'status' <> 'FILA') DESC, "updatedAt" ASC LIMIT 1`;
  if (!rows.length) return null;
  const lead = await prisma.lead.findUnique({ where: { id: rows[0].id }, select: { id: true, name: true, customFields: true } });
  if (!lead) return null;
  const cf = (lead.customFields || {}) as Record<string, any>;
  const vc = cf._vistoriaCaixa || {};
  const enviar = vc.status === 'ENVIAR';
  const modo = vc.status === 'BOLETO' ? 'BOLETO' : vc.status === 'DOCUMENTOS' ? 'DOCUMENTOS' : enviar ? 'ENVIAR' : 'PREPARAR';
  await gravar(lead.id, { status: modo === 'BOLETO' ? 'BAIXANDO_BOLETO' : modo === 'DOCUMENTOS' ? 'ANEXANDO' : enviar ? 'ENVIANDO' : 'RODANDO', leaseAt: new Date().toISOString() });
  return {
    leadId: lead.id,
    leadName: lead.name,
    modo,
    enviar,
    tituloBoleto: vc.boleto?.titulo || null,
    codigoImovel: vc.codigoImovel || null,
    imovel: vc.dados?.imovel,
    os: { ...(vc.dados?.os || {}), contatoNome: vc.contato?.nome || '', contatoTelefone: vc.contato?.telefone || '', cpf: String(cf.cpf_1 || '').replace(/\D/g, '') },
  };
}

/** Resultado da extensão → card (anotação/push/estado). */
export async function gravarVistoriaCaixa(accountId: string, leadId: string, body: { etapa: string; codigoImovel?: string; os?: { numero?: string; situacao?: string }; texto?: string; erro?: string; campos?: { rotulo: string; valor: string }[] }, io?: Io): Promise<void> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true } });
  if (!lead) throw new Error('Card não encontrado');
  const etapa = String(body.etapa || '').toUpperCase();
  const campos = (body.campos || []).filter((c) => c?.rotulo).map((c) => `• ${c.rotulo} ${String(c.valor ?? '').slice(0, 160)}`).join('\n');
  if (etapa === 'CADASTRADO' || etapa === 'IMOVEL_JA_EXISTIA') {
    await gravar(leadId, { codigoImovel: body.codigoImovel || null });
    await nota(leadId, `🏠 SIOPI: imóvel ${etapa === 'CADASTRADO' ? 'cadastrado' : 'já estava cadastrado'} — código do imóvel ${body.codigoImovel || '?'}.`);
    return;
  }
  // Imóvel cadastrado por OUTRO correspondente (Fabio 06/11): não dá pra abrir a OS — a equipe manda e-mail à agência pedindo a alteração. Por enquanto: nota + push.
  if (etapa === 'OUTRO_CCA') {
    await gravar(leadId, { status: 'OUTRO_CCA', leaseAt: null, codigoImovel: body.codigoImovel || null, outroCca: body.texto || null });
    await nota(leadId, `⚠️ Vistoria CAIXA parada: o imóvel${body.codigoImovel ? ` (código ${body.codigoImovel})` : ''} foi cadastrado no SIOPI por OUTRO correspondente${body.texto ? ` — ${body.texto}` : ''}. Precisa mandar e-mail à agência pedindo a alteração do imóvel pro nosso CCA (77001). Depois, clique de novo em "Solicitar vistoria CAIXA".`);
    await push(accountId, leadId, `🏠 ${lead.name}: imóvel de outro correspondente`, 'Imóvel cadastrado por outro CCA no SIOPI — mande e-mail à agência pedindo a alteração.');
    return;
  }
  if (etapa === 'OS_PRONTA') {
    await gravar(leadId, { status: 'OS_PRONTA', leaseAt: null, osPronta: { em: new Date().toISOString(), campos: body.campos || [] } });
    await nota(leadId, `🏠 Vistoria CAIXA PRONTA pra enviar (OS de engenharia preenchida no SIOPI, ainda NÃO criada). Confira e clique em "Enviar OS" no bloco CAIXA do card:\n${campos}`);
    await push(accountId, leadId, `🏠 ${lead.name}: vistoria CAIXA pronta`, 'Confira os dados e clique em "Enviar OS" no card.');
    return;
  }
  if (etapa === 'JA_TEM_OS') {
    await gravar(leadId, { status: 'JA_TEM_OS', leaseAt: null, os: body.os || null });
    await nota(leadId, `🏠 Vistoria CAIXA: esse imóvel já tem OS de engenharia no SIOPI${body.os?.numero ? ` (${body.os.numero}, ${body.os.situacao || '—'})` : ''} — não abri outra.${body.texto ? `\n${body.texto.slice(0, 600)}` : ''}`);
    await push(accountId, leadId, `🏠 ${lead.name}: já tem OS na CAIXA`, 'O imóvel já tem ordem de serviço de engenharia — não abri outra.');
    return;
  }
  // OS criada (Fabio 06/11: depois do Próximo vem "Incluir Documentos" — "precisa anexar a certidão de ônus do imóvel") → a extensão anexa a certidão e segue até a taxa.
  if (etapa === 'OS_CRIADA' || etapa === 'OS_ENVIADA') {
    await gravar(leadId, { status: 'DOCUMENTOS', leaseAt: null, os: body.os || null, enviadaEm: new Date().toISOString(), tentativas: 0 });
    await nota(leadId, `🏠 OS da vistoria CAIXA CRIADA no SIOPI${body.os?.numero ? ` — registro ${body.os.numero}` : ''}. Próximo passo: anexar a certidão de ônus e emitir a taxa.`);
    await moverParaVistoria(accountId, leadId, 'OS da vistoria criada no SIOPI (CAIXA)', io as any);
    return;
  }
  if (etapa === 'DOC_ANEXADO') {
    await nota(leadId, `📎 SIOPI: certidão de ônus anexada na OS da vistoria${body.texto ? ` (${body.texto.slice(0, 120)})` : ''}.`);
    return;
  }
  if (etapa === 'TAXA_PRONTA') {
    await gravar(leadId, { status: 'TAXA_PRONTA', leaseAt: null, taxa: { em: new Date().toISOString(), texto: (body.texto || '').slice(0, 2000), campos: body.campos || [] } });
    await nota(leadId, `🏠 Vistoria CAIXA: OS criada e certidão anexada — o SIOPI está na tela da TAXA (boleto), ainda NÃO emitida.${campos ? `\n${campos}` : ''}`);
    await push(accountId, leadId, `🏠 ${lead.name}: falta a taxa da vistoria`, 'OS criada e certidão anexada — falta emitir a taxa (boleto).');
    return;
  }
  // ERRO / AGUARDANDO_LOGIN / tela desconhecida: para e avisa (a pessoa confere o SIOPI e clica de novo).
  const vc = ((((await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }))?.customFields || {}) as any)._vistoriaCaixa) || {};
  const voltaPara: Estado = etapa === 'AGUARDANDO_LOGIN' ? (vc.status === 'ENVIANDO' ? 'ENVIAR' : vc.status === 'ANEXANDO' ? 'DOCUMENTOS' : vc.status === 'BAIXANDO_BOLETO' ? 'BOLETO' : 'FILA') : 'ERRO';
  await gravar(leadId, { status: voltaPara, leaseAt: null, erro: body.erro || etapa });
  if (etapa === 'AGUARDANDO_LOGIN') {
    if (!vc.avisoLoginEm || Date.now() - new Date(vc.avisoLoginEm).getTime() > 2 * 3600_000) {
      await gravar(leadId, { avisoLoginEm: new Date().toISOString() });
      await push(accountId, leadId, '🏠 SIOPI pedindo login', 'Entre no SIOPI no Chrome (ou salve a senha na extensão) — a vistoria CAIXA continua sozinha.');
    }
    return;
  }
  await nota(leadId, `⚠️ Vistoria CAIXA parou no SIOPI: ${String(body.erro || 'tela desconhecida').slice(0, 400)}${body.texto ? `\n${body.texto.slice(0, 600)}` : ''}\nNada foi enviado. Confira e clique de novo em "Solicitar vistoria CAIXA".`);
  await push(accountId, leadId, `🏠 ${lead.name}: vistoria CAIXA parou`, String(body.erro || 'Confira o SIOPI').slice(0, 120));
}

/** "Enviar OS": só depois da OS pronta (conferida). O clique é a ordem de criar a OS de engenharia no SIOPI. */
export async function enviarOsVistoriaCaixa(accountId: string, leadId: string, user: { id: string; nome: string }): Promise<{ erro: string } | { mensagem: string }> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  if (!lead) return { erro: 'Card não encontrado' };
  const vc = ((lead.customFields || {}) as any)._vistoriaCaixa || {};
  if (vc.status !== 'OS_PRONTA') return { erro: 'A OS ainda não está pronta pra enviar.' };
  await gravar(leadId, { status: 'ENVIAR', enviarPor: user.nome, enviarEm: new Date().toISOString(), tentativas: 0 });
  await nota(leadId, `🏠 ${user.nome} mandou enviar a OS da vistoria CAIXA — a extensão do SIOPI cria a ordem de serviço.`, user.id);
  return { mensagem: 'Pedido enviado: a extensão do SIOPI cria a OS da vistoria no próximo minuto.' };
}

/** Estado pro bloco CAIXA do card. */
export async function estadoVistoriaCaixa(accountId: string, leadId: string) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  if (!lead) return null;
  const cf = (lead.customFields || {}) as Record<string, any>;
  const vc = cf._vistoriaCaixa || {};
  return {
    status: (vc.status || null) as Estado | null,
    pedidoEm: vc.pedidoEm || null, por: vc.por || null,
    codigoImovel: vc.codigoImovel || null,
    os: vc.os || null, enviadaEm: vc.enviadaEm || null,
    erro: vc.erro || null, faltas: vc.faltas || [],
    contato: String(cf.contato_vistoria || '').trim() || null,
    campos: vc.osPronta?.campos || [],
  };
}

/** Contato da vistoria completo = nome + telefone com DDD (Fabio 06/11: "o CRM precisa identificar nome e telefone"). */
export function contatoVistoriaCompleto(texto: unknown): boolean {
  return !!partirContato(String(texto ?? ''));
}

/**
 * O cliente disse só QUEM acompanha a vistoria ("o corretor") → o CRM pede o nome e o telefone dessa pessoa (Fabio 06/11: "e também solicitar isso").
 * IA do card ligada: ela mesma pergunta na resposta (regra no campo contato_vistoria). Não repete em 12 h. Conversa fechada → template "Olá, tudo bem?" e a pergunta
 * sai quando o cliente responder.
 */
export async function pedirNomeTelefoneContato(accountId: string, leadId: string, quem: string, io?: Io): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true, aiAutoReplyActive: true } });
  if (!lead) return;
  const cf = (lead.customFields || {}) as Record<string, any>;
  const antes = cf._contatoVistoriaParcial?.at ? new Date(cf._contatoVistoriaParcial.at).getTime() : 0;
  if (Date.now() - antes < 12 * 3600_000) return;
  const fresh = ((await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }))?.customFields || {}) as Record<string, any>;
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...fresh, _contatoVistoriaParcial: { quem: String(quem).slice(0, 60), at: new Date().toISOString() } } } });
  if (lead.aiAutoReplyActive && !cf._autoPaused) return;
  const pessoa = String(quem || '').trim().replace(/^(o|a|os|as)\s+/i, '').toLowerCase();
  const de = /a$/.test(pessoa.split(' ').pop() || '') && !/^(meu|seu)\b/.test(pessoa) ? 'da' : 'do';
  const texto = pessoa
    ? `Pode me passar o nome e o telefone ${de} ${pessoa}, por favor? É pra agendarmos a vistoria do imóvel.`
    : 'Pode me passar o nome e o telefone de quem vai acompanhar a vistoria do imóvel, por favor?';
  const { whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  const { sendOutboundWhatsApp, sendOutboundWhatsAppTemplate } = require('./message.service') as typeof import('./message.service');
  if (await whatsappWindowOpen(leadId)) {
    const r = await sendOutboundWhatsApp({ accountId, leadId, content: texto, io: io as any });
    if (!r.success) throw new Error((r as any).error || 'falhou');
    await nota(leadId, `🏠 O cliente disse que a vistoria é com "${quem}" — pedi o nome e o telefone (o campo "Contato vistoria" só vale com os dois).`);
    return;
  }
  const t = await sendOutboundWhatsAppTemplate({ accountId, leadId, templateName: 'ola_tudo_bem', language: 'pt_BR', bodyParams: [], previewText: 'Olá, tudo bem?', io: io as any });
  if (!t.success) throw new Error(`template "Olá, tudo bem?" falhou: ${t.error}`);
  const { queueOnReply } = require('./reply-pending.service') as typeof import('./reply-pending.service');
  await queueOnReply(prisma, { leadId, label: 'contato da vistoria', text: texto, noteText: `🏠 O cliente disse que a vistoria é com "${quem}" e a janela de 24 h estava fechada — mandei o template "Olá, tudo bem?"; quando ele responder, sai o pedido de nome e telefone.` });
}

/** Certidão de ônus/matrícula usada na ficha → a extensão anexa na OS (base64). */
export async function certidaoDaVistoria(accountId: string, leadId: string): Promise<{ nome: string; mimeType: string; base64: string } | null> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  if (!lead) return null;
  const cf = (lead.customFields || {}) as Record<string, any>;
  const ficha = cf._vistoriaCaixa?.ficha || {};
  let id: string | null = ficha.arquivoId || null;
  let mime: string = ficha.arquivoMime || 'application/pdf';
  let nome: string = ficha.arquivo || 'CERTIDAO DE ONUS.pdf';
  if (!id) {
    const arq = (await arquivosDoImovel(accountId, cf)).find((f) => /CERTIDAO DE ONUS|MATRICULA|INTEIRO TEOR/.test(semAcento(f.name).toUpperCase()));
    if (!arq) return null;
    id = arq.id; mime = arq.mimeType; nome = arq.name;
  }
  const google = await import('./google.service');
  const buf = await google.downloadDriveFile(accountId, id, mime);
  return { nome: /\.pdf$/i.test(nome) || mime !== 'application/pdf' ? nome : `${nome}.pdf`, mimeType: mime, base64: buf.toString('base64') };
}

/**
 * Boleto da taxa da vistoria aberto no SIOPI (a equipe clicou em "Concluir" na tela "Emite Taxa" e o boleto abriu numa aba — Fabio 06/11: "era só clicar em concluir";
 * "já emiti, encaminhe à cliente"). A extensão manda o nº do título; o CRM liga ao card que está esperando a taxa (TAXA_PRONTA — só um; vários = push pra equipe) e põe
 * na fila pra extensão baixar o PDF dentro do SIOPI.
 */
export async function boletoAberto(accountId: string, titulo: string, leadId?: string | null): Promise<{ leadId: string } | { erro: string }> {
  const t = String(titulo || '').replace(/\D/g, '');
  if (!t) return { erro: 'título sem número' };
  let alvo = leadId || null;
  if (!alvo) {
    const ja = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND "customFields"->'_vistoriaCaixa'->'boleto'->>'titulo' = ${t} LIMIT 1`;
    if (ja.length) return { leadId: ja[0].id }; // já ligado (aba aberta de novo)
    const esperando = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND "customFields"->'_vistoriaCaixa'->>'status' = 'TAXA_PRONTA'`;
    if (esperando.length !== 1) {
      const quem = await prisma.user.findMany({ where: { accountId, role: 'ADMIN' }, select: { id: true } });
      await sendPushToAccount(accountId, { title: '🏠 Boleto da vistoria CAIXA aberto', body: esperando.length ? `Tem ${esperando.length} cards esperando a taxa — não sei de quem é o boleto ${t}. Mande pela Inbox.` : `Nenhum card esperando a taxa — boleto ${t} não foi ligado a ninguém.` }, quem.map((u) => u.id)).catch(() => {});
      return { erro: esperando.length ? 'mais de um card esperando a taxa' : 'nenhum card esperando a taxa' };
    }
    alvo = esperando[0].id;
  }
  await gravar(alvo, { status: 'BOLETO', leaseAt: null, tentativas: 0, boleto: { titulo: t, abertoEm: new Date().toISOString() } });
  await nota(alvo, `🧾 Taxa da vistoria CAIXA emitida no SIOPI (título ${t}) — a extensão baixa o boleto e o CRM manda ao cliente.`);
  return { leadId: alvo };
}

const TEXTO_BOLETO = (valor?: string) => `Segue o boleto da taxa de avaliação do imóvel (vistoria)${valor ? `, no valor de ${valor}` : ''}. Assim que for pago, a vistoria é agendada com o contato que você nos passou. Qualquer dúvida, estou à disposição.`;

/** PDF do boleto (baixado pela extensão no SIOPI) → pasta IMOVEL do Drive + WhatsApp do cliente (Fabio 06/11: "emitir e encaminhar à cliente"). */
export async function gravarBoletoVistoria(accountId: string, leadId: string, body: { nome?: string; base64?: string; valor?: string; titulo?: string }, io?: Io): Promise<{ erro: string } | { ok: true; enviado: boolean }> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true } });
  if (!lead) return { erro: 'Card não encontrado' };
  const data = Buffer.from(String(body.base64 || ''), 'base64');
  if (data.length < 1000 || data.subarray(0, 4).toString('latin1') !== '%PDF') return { erro: 'o arquivo do boleto não é um PDF' };
  const cf = (lead.customFields || {}) as Record<string, any>;
  const nome = 'BOLETO TAXA VISTORIA CAIXA.pdf';
  let driveId: string | null = null;
  const link = String(cf.link_pasta_drive || '').trim();
  if (link) {
    try {
      const google = await import('./google.service');
      const pasta = await google.createFolder(accountId, 'IMOVEL', google.extractFolderId(link));
      for (const velho of (await google.listFolderContents(accountId, pasta.id)).filter((f: any) => f.name === nome)) await google.trashDriveItem(accountId, velho.id).catch(() => {});
      driveId = (await google.uploadFile(accountId, { name: nome, mimeType: 'application/pdf', parentId: pasta.id, data })).id;
    } catch (e: any) { console.error('[Vistoria CAIXA] boleto no Drive', e?.message); }
  }
  const { whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  const { sendOutboundMedia } = require('./message.service') as typeof import('./message.service');
  let enviado = false;
  let erroEnvio = '';
  if (await whatsappWindowOpen(leadId)) {
    const valor = body.valor || (String((cf._vistoriaCaixa || {}).taxa?.texto || '').match(/Valor da Taxa:\s*(R\$\s*[\d.,]+)/) || [])[1] || '';
    const r = await sendOutboundMedia({ accountId, leadId, buffer: data, fileName: 'Boleto taxa vistoria.pdf', mimeType: 'application/pdf', caption: TEXTO_BOLETO(valor), io: io as any });
    enviado = r.success;
    if (!r.success) erroEnvio = (r as any).error || 'falhou';
  } else erroEnvio = 'a conversa está fechada (janela de 24 h)';
  await gravar(leadId, { status: 'ENVIADA', leaseAt: null, boleto: { ...((cf._vistoriaCaixa || {}).boleto || {}), titulo: body.titulo || (cf._vistoriaCaixa || {}).boleto?.titulo || null, driveId, baixadoEm: new Date().toISOString(), enviadoEm: enviado ? new Date().toISOString() : null } });
  if (enviado) {
    await nota(leadId, `✅ Boleto da taxa da vistoria CAIXA${body.valor ? ` (${body.valor})` : ''} enviado ao cliente pelo WhatsApp${driveId ? ' e salvo na pasta IMOVEL do Drive' : ''}.`);
    await push(accountId, leadId, `✅ ${lead.name}: boleto da vistoria enviado`, 'O cliente recebeu o boleto da taxa de avaliação.');
  } else {
    await nota(leadId, `⚠️ Boleto da taxa da vistoria CAIXA baixado${driveId ? ' e salvo na pasta IMOVEL do Drive' : ''}, mas NÃO foi enviado ao cliente: ${erroEnvio}. Mande pela Inbox (o arquivo está na pasta).`);
    await push(accountId, leadId, `🏠 ${lead.name}: boleto da vistoria não foi`, `Não enviei o boleto: ${erroEnvio}. Está na pasta IMOVEL.`);
  }
  return { ok: true, enviado };
}
