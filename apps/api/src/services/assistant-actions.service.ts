import crypto from 'crypto';
import { prisma } from '../lib/prisma';

/**
 * AÇÕES DO ASSISTENTE ("Jarvis", Fabio 29/10: "todas, pode confirmar antes, no botão flutuante"; "preciso que ele entre na conversa também na tela, abra as coisas").
 * - Diretas (não mexem com cliente): consultas, anotação, tarefa, conferir análise (só lê o portal), abrir uma tela do CRM.
 * - Com CONFIRMAÇÃO (mexem com cliente ou com o processo): mandar mensagem, mover card, ganho/perdido/reabrir, rodar análise, pedir vistoria, pedir certidão.
 *   Essas viram uma "ação pendente" (memória, 30 min) com o texto do que vai acontecer; só rodam quando a pessoa confirma (botão ou "sim" falado).
 * Executam pelas MESMAS rotas da tela, com o login de quem confirmou — assim valem as permissões e todas as regras automáticas (notas, automações, funil Concluído/Perdidos, comissão…).
 */

export type PendingAction = { id: string; accountId: string; userId: string; tipo: string; descricao: string; params: Record<string, any>; at: number };
export type ScreenNav = { path: string; label: string };
export type AudioReq = { leadId: string; leadName: string };
export type CopyReq = { label: string; texto: string };

const pendentes = new Map<string, PendingAction>();
const TTL = 30 * 60_000;
const limpar = () => { const agora = Date.now(); for (const [k, v] of pendentes) if (agora - v.at > TTL) pendentes.delete(k); };

const API = () => `http://127.0.0.1:${process.env.PORT || 3001}/api`;
async function callApi(token: string, method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(`${API()}${path}`, { method, headers: { Authorization: token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const txt = await r.text();
  let j: any = null; try { j = txt ? JSON.parse(txt) : null; } catch { j = { raw: txt.slice(0, 200) }; }
  if (!r.ok) throw new Error((j && (j.error || j.message)) || `erro ${r.status}`);
  return j;
}

const quando = (d: Date | null | undefined) => (d ? d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
const norm = (s: string) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export const ACTION_TOOLS = [
  // ── diretas ──
  { name: 'abrir_na_tela', description: 'Abre uma tela do CRM pra pessoa ver AGORA (a tela dela muda). Use quando pedirem pra abrir/mostrar algo ou quando ajudar a acompanhar ("abre a conversa do Pedro", "mostra o funil"). destino: conversa (precisa leadId), funil_home_equity, funil_habitacao, analise_credito, supervisao, tarefas, dashboard, email, financeiro, remarketing, templates.', input_schema: { type: 'object', properties: { destino: { type: 'string' }, leadId: { type: 'string' } }, required: ['destino'] } },
  { name: 'clientes_parados', description: 'Clientes ABERTOS sem nenhuma mensagem (do cliente ou nossa) há pelo menos N dias, do mais parado pro menos. Filtros opcionais: etapa, funil.', input_schema: { type: 'object', properties: { dias: { type: 'number' }, etapa: { type: 'string' }, funil: { type: 'string' } }, required: ['dias'] } },
  { name: 'resumo_funil', description: 'Quantos clientes abertos há em cada etapa (de todos os funis ou de um funil pelo nome).', input_schema: { type: 'object', properties: { funil: { type: 'string' } } } },
  { name: 'criar_anotacao', description: 'Grava uma anotação interna no card (não vai pro cliente).', input_schema: { type: 'object', properties: { leadId: { type: 'string' }, texto: { type: 'string' } }, required: ['leadId', 'texto'] } },
  { name: 'criar_lembrete', description: 'Cria um LEMBRETE/tarefa pra quem está falando ("me lembra de falar com o Pedro amanhã às 10h", "sexta 14h ligar pra Maria"), opcionalmente ligado a um cliente. Na hora marcada o CRM manda push no celular E o assistente FALA o lembrete em voz alta na tela (se o CRM estiver aberto). quando = data/hora ISO 8601 com fuso -03:00, calculada a partir de "Agora"; sem hora dita, use 09:00; se a data/hora já passou, pergunte. titulo curto, no infinitivo (ex.: "Falar com o Pedro sobre a vistoria").', input_schema: { type: 'object', properties: { titulo: { type: 'string' }, quando: { type: 'string' }, leadId: { type: 'string' } }, required: ['titulo', 'quando'] } },
  { name: 'conferir_analise', description: 'Pede pra extensão do banco CONFERIR (só ler) o resultado da análise de crédito no portal. bancos: INTER, CREDITAS, CREDIMORAR (Santander). Não cria proposta nova.', input_schema: { type: 'object', properties: { leadId: { type: 'string' }, bancos: { type: 'array', items: { type: 'string' } } }, required: ['leadId', 'bancos'] } },
  { name: 'ver_pasta', description: 'Mostra a pasta do cliente no Google Drive: onde ela está (LEADS ATIVOS, LEADS FRIOS, CONCLUÍDOS…) e os arquivos (com subpastas).', input_schema: { type: 'object', properties: { leadId: { type: 'string' } }, required: ['leadId'] } },
  { name: 'ver_regras_ia', description: 'Procura nas REGRAS da IA (Base de Conhecimento — o que a IA que conversa com o cliente, a Sugestão de resposta e a conferência seguem). termo = palavra pra filtrar (vazio = as 20 mais recentes). Devolve id, título, setor e texto.', input_schema: { type: 'object', properties: { termo: { type: 'string' } } } },
  { name: 'consultar_conhecimento', description: 'Busca na BASE DE CONHECIMENTO do CRM (a MESMA fonte que a IA do cliente, a Sugestão de resposta e a conferência de documentos usam): regras do processo, bancos, taxas, documentos exigidos, correções ensinadas pela equipe e os arquivos do Drive de conhecimento. Use ANTES de responder qualquer dúvida de processo/regra/banco/documento. pergunta = o que quer saber, em linguagem natural.', input_schema: { type: 'object', properties: { pergunta: { type: 'string' } }, required: ['pergunta'] } },
  // ── com confirmação ──
  { name: 'mover_pasta', description: 'PREPARA mover a pasta do cliente no Drive (confirmação antes). destino: ATIVOS (LEADS ATIVOS), FRIOS (LEADS FRIOS) ou CONCLUIDOS (CONCLUÍDOS/ano/mês de hoje). Fica na mesma área (Home Equity ou Habitação) onde a pasta já está.', input_schema: { type: 'object', properties: { leadId: { type: 'string' }, destino: { type: 'string', enum: ['ATIVOS', 'FRIOS', 'CONCLUIDOS'] } }, required: ['leadId', 'destino'] } },
  { name: 'enviar_email', description: 'PREPARA um e-mail pela caixa comercial do CRM (confirmação antes). Se tiver leadId e já houver e-mail desse destinatário no cliente, responde no MESMO fio. anexos = nomes (ou parte do nome) de arquivos da pasta do cliente no Drive (use ver_pasta antes). Escreva como a A&F escreve: cordial, objetivo, com saudação e "Atenciosamente".', input_schema: { type: 'object', properties: { para: { type: 'string' }, cc: { type: 'string' }, assunto: { type: 'string' }, texto: { type: 'string' }, leadId: { type: 'string' }, anexos: { type: 'array', items: { type: 'string' } } }, required: ['para', 'assunto', 'texto'] } },
  { name: 'alterar_regra_ia', description: 'PREPARA uma mudança nas REGRAS da IA (Base de Conhecimento) — é assim que se muda o comportamento da IA do CRM sem mexer no código (confirmação antes). acao: CRIAR (titulo+conteudo), EDITAR (id+conteudo, titulo opcional), APAGAR (id). setor: "Home Equity", "Habitação" ou "todos" (padrão: o da regra, ou todos). Use ver_regras_ia antes pra não duplicar; prefira EDITAR a regra que já existe.', input_schema: { type: 'object', properties: { acao: { type: 'string', enum: ['CRIAR', 'EDITAR', 'APAGAR'] }, id: { type: 'string' }, titulo: { type: 'string' }, conteudo: { type: 'string' }, setor: { type: 'string' } }, required: ['acao'] } },
  { name: 'ver_formulario', description: 'Mostra o FORMULÁRIO (cadastro) do card do cliente: todos os campos por aba, com o nome que aparece na tela, a chave, o tipo, as opções (se for lista) e o valor atual. Use antes de preencher.', input_schema: { type: 'object', properties: { leadId: { type: 'string' }, aba: { type: 'string', description: 'filtrar por aba (opcional)' } }, required: ['leadId'] } },
  { name: 'preencher_formulario', description: 'PREPARA o preenchimento de campos do formulário/cadastro do card (confirmação antes; mostra antes → depois). campos = objeto { "nome do campo como na tela" ou chave: valor }. Valor vazio "" apaga o campo. Use ver_formulario antes; em campo de lista use exatamente uma das opções. Datas dd/mm/aaaa; dinheiro só número (ex.: 250000).', input_schema: { type: 'object', properties: { leadId: { type: 'string' }, campos: { type: 'object' } }, required: ['leadId', 'campos'] } },
  { name: 'iniciar_supervisao', description: 'Inicia/atualiza a SUPERVISÃO DE SEXTA agora (só administrador): a IA resume cada card dos funis "Em contratação" que ainda não tem item nesta semana. Roda em segundo plano (pode levar alguns minutos) e abre a tela da Supervisão. Nada vai pro cliente.', input_schema: { type: 'object', properties: {} } },
  { name: 'ver_supervisao', description: 'Lista a supervisão desta semana: cada card com id do item, cliente, etapa, status (PENDING/SENT/SKIPPED/DONE), resumo, situação, pendências, mensagem sugerida, ação pra equipe e se a janela de 24 h está aberta. Use pra conduzir a supervisão card por card (comece pelos PENDING).', input_schema: { type: 'object', properties: { soPendentes: { type: 'boolean' } } } },
  { name: 'agir_supervisao', description: 'Age num item da supervisão. PULAR e FEITO são diretos. ENVIAR (janela aberta) e TEMPLATE (janela fechada: template de atualização + mensagem guardada pra quando responder) mandam a mensagem ao cliente e por isso PREPARAM com confirmação. texto = mensagem final (a sugerida ou a ajustada pela pessoa).', input_schema: { type: 'object', properties: { itemId: { type: 'string' }, acao: { type: 'string', enum: ['ENVIAR', 'TEMPLATE', 'PULAR', 'FEITO'] }, texto: { type: 'string' } }, required: ['itemId', 'acao'] } },
  { name: 'docs_para_andamento', description: 'Clientes que MANDARAM DOCUMENTOS nos últimos N dias (padrão 10) e o que falta pra dar andamento: situação da conferência (tudo OK / com problema / falta documento / dúvida com a equipe), etapa, quando chegou o último arquivo e se a equipe falou com ele depois. Os "PRONTO" vêm primeiro — use pra sugerir em quem dar andamento e qual o próximo passo.', input_schema: { type: 'object', properties: { dias: { type: 'number' }, funil: { type: 'string' } } } },
  { name: 'documentos_do_cliente', description: 'Os documentos que o cliente mandou e o que a IA leu em cada um: tipo, titular, OK/PROBLEMA/DÚVIDA, problemas, emissão, dono do imóvel, matrícula/cartório, gravame (alienação/hipoteca), ressalvas; e o que ainda falta.', input_schema: { type: 'object', properties: { leadId: { type: 'string' } }, required: ['leadId'] } },
  { name: 'conferir_documentos', description: 'Roda a conferência de documentos AGORA (lê com a IA os arquivos ainda não lidos e atualiza o card). Não manda nada ao cliente. Depois use documentos_do_cliente.', input_schema: { type: 'object', properties: { leadId: { type: 'string' } }, required: ['leadId'] } },
  { name: 'ler_documento', description: 'Abre UM documento do cliente e responde uma pergunta sobre ele lendo o arquivo de verdade (ex.: "a matrícula tem alienação vigente?", "qual a área do imóvel no IPTU?", "o comprovante está no nome de quem?"). arquivo = nome (ou parte) do arquivo ou o tipo (ex.: "matricula", "IPTU", "CNH").', input_schema: { type: 'object', properties: { leadId: { type: 'string' }, arquivo: { type: 'string' }, pergunta: { type: 'string' } }, required: ['leadId', 'arquivo', 'pergunta'] } },
  { name: 'ligar_para_cliente', description: 'PREPARA uma LIGAÇÃO pelo WhatsApp pro cliente (confirmação antes). Por enquanto quem FALA é o colaborador: o assistente só disca no navegador dele (o microfone dele é usado), abre a conversa do cliente e para de ouvir. Só funciona se o cliente já autorizou ligação; se não autorizou, diga isso e ofereça pedir_permissao_ligacao.', input_schema: { type: 'object', properties: { leadId: { type: 'string' } }, required: ['leadId'] } },
  { name: 'pedir_permissao_ligacao', description: 'PREPARA o pedido de permissão de ligação pelo WhatsApp pro cliente (a Meta manda pro cliente o botão "Permitir"; confirmação antes). Limite da Meta: 1 por dia, 2 por semana.', input_schema: { type: 'object', properties: { leadId: { type: 'string' } }, required: ['leadId'] } },
  { name: 'gravar_audio', description: 'Abre o GRAVADOR no balão pra pessoa gravar um áudio de voz pro cliente pelo WhatsApp (ela grava com a própria voz, ouve e só sai quando ela clicar em Enviar — você não fala nada no áudio). Use quando pedirem "quero mandar um áudio pro Pedro". Só com a janela de 24 h aberta.', input_schema: { type: 'object', properties: { leadId: { type: 'string' } }, required: ['leadId'] } },
  { name: 'enviar_mensagem', description: 'PREPARA uma mensagem de WhatsApp pro cliente (só sai depois que a pessoa confirmar). Se a janela de 24 h estiver fechada, o envio vira o template de atualização do processo + a mensagem guardada pra sair quando o cliente responder.', input_schema: { type: 'object', properties: { leadId: { type: 'string' }, texto: { type: 'string' } }, required: ['leadId', 'texto'] } },
  { name: 'mover_card', description: 'PREPARA a mudança de etapa do card (confirmação antes). etapa = nome da etapa; funil opcional (se a etapa for de outro funil).', input_schema: { type: 'object', properties: { leadId: { type: 'string' }, etapa: { type: 'string' }, funil: { type: 'string' } }, required: ['leadId', 'etapa'] } },
  { name: 'marcar_status', description: 'PREPARA marcar o card como GANHO, PERDIDO, REPROVADO (perdido por reprovação do banco) ou REABRIR (confirmação antes). motivo é obrigatório pra PERDIDO/REPROVADO.', input_schema: { type: 'object', properties: { leadId: { type: 'string' }, status: { type: 'string', enum: ['GANHO', 'PERDIDO', 'REPROVADO', 'REABRIR'] }, motivo: { type: 'string' } }, required: ['leadId', 'status'] } },
  { name: 'rodar_analise', description: 'PREPARA rodar a análise de crédito nos bancos (cria proposta nova no portal; confirmação antes). bancos: INTER, CREDITAS, CREDIMORAR (Santander).', input_schema: { type: 'object', properties: { leadId: { type: 'string' }, bancos: { type: 'array', items: { type: 'string' } } }, required: ['leadId', 'bancos'] } },
  { name: 'solicitar_vistoria', description: 'PREPARA o pedido de vistoria ao Inter: responde o e-mail do consultor com o contato e os documentos do imóvel da pasta do cliente (confirmação antes).', input_schema: { type: 'object', properties: { leadId: { type: 'string' } }, required: ['leadId'] } },
  { name: 'pedir_certidao', description: 'PREPARA o pedido da certidão de matrícula/ônus (inteiro teor) no RI Digital pela extensão, igual ao botão "Pedir certidão pelo ONR" do card; o PIX vai pro cliente (confirmação antes). Chame DIRETO com o leadId: a própria ferramenta acha a matrícula e a cidade/UF nos documentos (ou o endereço do imóvel). Só passe matricula/cidade/uf se a pessoa disser; cartorio só se ela disser (senão a extensão escolhe).', input_schema: { type: 'object', properties: { leadId: { type: 'string' }, matricula: { type: 'string' }, cidade: { type: 'string' }, uf: { type: 'string' }, cartorio: { type: 'string', description: 'como aparece no portal (ex.: "02º - BELÉM"); omita se não souber' }, porEndereco: { type: 'boolean', description: 'true quando a pessoa pede a certidão PELO ENDEREÇO (o CRM lê o endereço do imóvel nos documentos da conversa: matrícula, escritura, IPTU)' }, pixNoChat: { type: 'boolean', description: 'true quando a pessoa quer o PIX com ela (pra encaminhar ela mesma) em vez de ir direto ao cliente' } }, required: ['leadId'] } },
  { name: 'buscar_certidao', description: 'Manda a extensão do ONR ir AGORA ao RI Digital ver se a certidão do cliente saiu e, saindo, baixar e guardar na pasta do cliente no Drive (pasta IMOVEL). Use quando pedirem "baixa a certidão", "vê se a certidão saiu", "coloca a certidão na pasta". Só lê o portal: não paga nem cria pedido.', input_schema: { type: 'object', properties: { leadId: { type: 'string' } }, required: ['leadId'] } },
  { name: 'ver_extensoes', description: 'Situação de TODAS as extensões do Chrome (Inter, Creditas, Santander/Credimorar, Financiamento, Certidão ONR): ligada ou não, último sinal, o que está rodando agora e quantos pedidos na fila. Use quando perguntarem se as extensões estão funcionando, por que algo não andou, ou o que está rodando.', input_schema: { type: 'object', properties: {} } },
  { name: 'rodar_financiamento', description: 'PREPARA a análise do FINANCIAMENTO HABITACIONAL (cria proposta nova; confirmação antes): Credimorar (Bradesco, Itaú e Santander) e/ou o NOSSO portal do Inter. bancos: lista com CREDIMORAR e/ou INTER (padrão: os dois). Usa os valores do card.', input_schema: { type: 'object', properties: { leadId: { type: 'string' }, bancos: { type: 'array', items: { type: 'string' } } }, required: ['leadId'] } },
  { name: 'conferir_financiamento', description: 'Manda as extensões CONFERIREM (só ler) a situação do Financiamento do cliente nos bancos (Credimorar e Inter). Não cria proposta.', input_schema: { type: 'object', properties: { leadId: { type: 'string' } }, required: ['leadId'] } },
  { name: 'marcar_pix_pago', description: 'PREPARA marcar o PIX da certidão do cliente como PAGO (confirmação antes) — use quando a pessoa disser que o cliente pagou. Depois disso a extensão do ONR passa a buscar a certidão emitida sozinha.', input_schema: { type: 'object', properties: { leadId: { type: 'string' } }, required: ['leadId'] } },
  { name: 'enviar_onus_pos_registro', description: 'PREPARA o envio da CERTIDÃO DE ÔNUS PÓS-REGISTRO (a da pasta IMOVEL do Drive) ao consultor do INTER, respondendo a conversa do processo, pra pagamento ao vendedor (confirmação antes). Acontece sozinho quando o card vai pra "Pagamento ao Vendedor"; use pra mandar de novo ou quando faltou algo.', input_schema: { type: 'object', properties: { leadId: { type: 'string' } }, required: ['leadId'] } },
  { name: 'vincular_emails_banco', description: 'Procura em TODAS as caixas de e-mail ligadas ao CRM (comercial, Fabio, Andreia…) os e-mails dos BANCOS (Inter, Creditas, Credimorar/Santander, Bradesco, Itaú, CAIXA) que citam o cliente (nome completo, CPF ou nº da proposta) e liga ao card — aparecem na conversa dele. Só administrador. Use quando pedirem "vincula os e-mails do Inter no card do Pedro".', input_schema: { type: 'object', properties: { leadId: { type: 'string' }, termos: { type: 'array', items: { type: 'string' }, description: 'termos extras (nº da proposta, outro nome)' } }, required: ['leadId'] } },
  { name: 'renomear_onus_pos_registro', description: 'Renomeia no Drive (pasta IMOVEL) a certidão de ônus do cliente pra "CERTIDAO DE ONUS POS REGISTRO - MATRICULA X". Use quando pedirem pra marcar/renomear a ônus como pós-registro.', input_schema: { type: 'object', properties: { leadId: { type: 'string' } }, required: ['leadId'] } },
  { name: 'escolher_voz', description: 'Abre no balão a lista de VOZES do assistente (todas brasileiras) pra pessoa ouvir e escolher. Use quando pedirem pra mudar/trocar/escolher a voz, perguntarem que vozes existem ou reclamarem da voz.', input_schema: { type: 'object', properties: {} } },
  { name: 'consultar_cartorio', description: 'Mapa dos cartórios de Registro de Imóveis do RI Digital (todos os estados): quais cartórios ficam numa cidade, o número do Ofício, a abrangência (bairros/municípios atendidos) e se tem Certidão Digital. Use pra saber qual cartório atende um imóvel ou onde um "Nº Ofício" fica no portal (ex.: no DF o 3º fica em Águas Claras).', input_schema: { type: 'object', properties: { uf: { type: 'string' }, cidade: { type: 'string', description: 'omita pra listar as cidades do estado' } }, required: ['uf'] } },
  { name: 'ver_certidao', description: 'Situação dos pedidos de certidão do cliente (pedido, protocolo, valor, PIX, paga, emitida). Se o PIX já foi gerado, o código aparece no balão com botão Copiar pra pessoa encaminhar — NÃO leia o código em voz alta. O PIX demora alguns minutos depois do pedido (a extensão faz o pedido no portal).', input_schema: { type: 'object', properties: { leadId: { type: 'string' } }, required: ['leadId'] } },
];
export const ACTION_TOOL_NAMES = new Set(ACTION_TOOLS.map((t) => t.name));

const TELAS: Record<string, { path: string; label: string }> = {
  funil_home_equity: { path: '/funil-home-equity', label: 'Funil Home Equity' }, funil_habitacao: { path: '/funil-habitacao', label: 'Funil Habitação' },
  analise_credito: { path: '/analise-credito', label: 'Análise de Crédito' }, supervisao: { path: '/supervisao', label: 'Supervisão de sexta' }, tarefas: { path: '/tarefas', label: 'Tarefas' },
  dashboard: { path: '/dashboard', label: 'Dashboard' }, email: { path: '/email', label: 'E-mail' }, financeiro: { path: '/financeiro', label: 'Financeiro' },
  remarketing: { path: '/remarketing', label: 'Remarketing' }, templates: { path: '/templates', label: 'Templates' },
};

async function leadOf(accountId: string, leadId: string) {
  const l = await prisma.lead.findFirst({ where: { id: String(leadId || ''), accountId }, select: { id: true, name: true, status: true, stage: { select: { name: true } }, pipeline: { select: { id: true, name: true, department: { select: { name: true } } } }, customFields: true } });
  if (!l) throw new Error('cliente não encontrado (use buscar_clientes pra achar o leadId)');
  return l;
}
function pendente(p: { accountId: string; userId: string; tipo: string; descricao: string; params: Record<string, any> }, fila: PendingAction[]) {
  limpar();
  const a: PendingAction = { ...p, id: crypto.randomUUID(), at: Date.now() };
  pendentes.set(a.id, a); fila.push(a);
  return { aguardandoConfirmacao: true, oQueVaiAcontecer: p.descricao, instrucao: 'Diga à pessoa exatamente o que vai acontecer e pergunte se confirma. NÃO diga que já foi feito.' };
}

async function pastaDoCliente(accountId: string, leadId: string) {
  const l = await leadOf(accountId, leadId);
  const link = String(((l.customFields || {}) as any).link_pasta_drive || '');
  if (!link) throw new Error(`o ${l.name} não tem pasta do Drive no card (campo link_pasta_drive)`);
  const g = require('./google.service') as typeof import('./google.service');
  const pasta = g.extractFolderId(link);
  const drive = await g.getDrive(accountId);
  const info = (await drive.files.get({ fileId: pasta, fields: 'id,name,parents', supportsAllDrives: true })).data;
  const pai = info.parents?.[0] || '';
  const { loadAreas } = require('./drive-lifecycle.service') as typeof import('./drive-lifecycle.service');
  const areas = await loadAreas(accountId);
  let onde = 'fora das pastas de leads', area = areas.find((a) => a.ativos === pai);
  if (area) onde = `LEADS ATIVOS (${area.nome})`;
  else if ((area = areas.find((a) => a.frios === pai))) onde = `LEADS FRIOS (${area.nome})`;
  else {
    const avo = pai ? (await drive.files.get({ fileId: pai, fields: 'parents', supportsAllDrives: true }).catch(() => null))?.data.parents?.[0] : '';
    const bisavo = avo ? (await drive.files.get({ fileId: avo, fields: 'parents', supportsAllDrives: true }).catch(() => null))?.data.parents?.[0] : '';
    area = areas.find((a) => a.concluidos && (a.concluidos === avo || a.concluidos === bisavo));
    if (area) onde = `CONCLUÍDOS (${area.nome})`;
  }
  return { l, pasta, nome: info.name || '', onde, area, g };
}
const SETORES = async (accountId: string) => prisma.department.findMany({ where: { accountId }, select: { id: true, name: true } });
const janelaAberta = async (leadId: string) => {
  const u = await prisma.message.findFirst({ where: { leadId, direction: 'INBOUND', channel: 'WHATSAPP' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  return !!u && Date.now() - u.createdAt.getTime() < 23.5 * 3600_000;
};
const bancosValidos = (b: unknown): string[] => (Array.isArray(b) ? b : [b]).map((x) => String(x || '').toUpperCase()).map((x) => (/SANTANDER|CREDIMORAR/.test(x) ? 'CREDIMORAR' : /INTER/.test(x) ? 'INTER' : /CREDITAS/.test(x) ? 'CREDITAS' : '')).filter(Boolean);
const NOME_BANCO: Record<string, string> = { INTER: 'Inter', CREDITAS: 'Creditas', CREDIMORAR: 'Santander' };

/** Roda (ou prepara) uma ferramenta de ação. token = Authorization de quem está falando (pras ações diretas que passam pelas rotas). */
export async function runActionTool(p: { accountId: string; userId: string; token: string; name: string; input: any; fila: PendingAction[]; nav: ScreenNav[]; audio?: AudioReq[]; copiar?: CopyReq[]; ui?: string[] }): Promise<unknown> {
  const { accountId, userId, input } = p;
  switch (p.name) {
    case 'abrir_na_tela': {
      const d = norm(input?.destino);
      if (/conversa|card|cliente|inbox/.test(d)) { const l = await leadOf(accountId, input?.leadId); p.nav.push({ path: `/inbox?leadId=${l.id}`, label: `Conversa do ${l.name}` }); return { ok: true, abriu: `conversa do ${l.name}` }; }
      const k = Object.keys(TELAS).find((x) => d.replace(/\s+/g, '_').includes(x) || norm(TELAS[x].label) === d) || (/habita/.test(d) ? 'funil_habitacao' : /home|equity|funil/.test(d) ? 'funil_home_equity' : /analise|credito/.test(d) ? 'analise_credito' : /supervis/.test(d) ? 'supervisao' : /tarefa/.test(d) ? 'tarefas' : '');
      if (!k) return { erro: `não sei abrir "${input?.destino}"; opções: conversa, ${Object.keys(TELAS).join(', ')}` };
      p.nav.push(TELAS[k]); return { ok: true, abriu: TELAS[k].label };
    }
    case 'clientes_parados': {
      const dias = Math.max(1, Math.min(Number(input?.dias) || 3, 90));
      const corte = new Date(Date.now() - dias * 86400_000);
      const rows = await prisma.$queryRaw<any[]>`
        SELECT l.id, l.name, s.name AS etapa, p.name AS funil, max(m."createdAt") AS ultima, max(m."createdAt") FILTER (WHERE m.direction = 'INBOUND') AS ultima_cliente
        FROM "Lead" l JOIN "Stage" s ON s.id = l."stageId" JOIN "Pipeline" p ON p.id = l."pipelineId" LEFT JOIN "Message" m ON m."leadId" = l.id AND m.channel <> 'EMAIL'
        WHERE l."accountId" = ${accountId} AND l.status = 'OPEN' AND l.archived = false AND l."isGroup" = false
          AND (${input?.etapa ? `%${input.etapa}%` : '%'}::text = '%' OR s.name ILIKE ${input?.etapa ? `%${input.etapa}%` : '%'})
          AND (${input?.funil ? `%${input.funil}%` : '%'}::text = '%' OR p.name ILIKE ${input?.funil ? `%${input.funil}%` : '%'})
        GROUP BY l.id, l.name, s.name, p.name HAVING coalesce(max(m."createdAt"), l."createdAt") < ${corte}
        ORDER BY coalesce(max(m."createdAt"), l."createdAt") ASC LIMIT 25`;
      return { total: rows.length, clientes: rows.map((r) => ({ leadId: r.id, nome: r.name, funil: r.funil, etapa: r.etapa, ultimaMensagem: quando(r.ultima) || 'nunca', ultimaDoCliente: quando(r.ultima_cliente) || 'nunca' })) };
    }
    case 'resumo_funil': {
      const rows = await prisma.$queryRaw<any[]>`SELECT p.name AS funil, s.name AS etapa, s."order" AS ordem, count(l.id)::int AS n FROM "Lead" l JOIN "Stage" s ON s.id = l."stageId" JOIN "Pipeline" p ON p.id = l."pipelineId"
        WHERE l."accountId" = ${accountId} AND l.status = 'OPEN' AND l.archived = false AND l."isGroup" = false AND p.name ILIKE ${input?.funil ? `%${input.funil}%` : '%'}
        GROUP BY p.name, s.name, s."order" ORDER BY p.name, s."order"`;
      return rows.map((r) => ({ funil: r.funil, etapa: r.etapa, clientes: r.n }));
    }
    case 'criar_anotacao': {
      const l = await leadOf(accountId, input?.leadId);
      await callApi(p.token, 'POST', '/notes', { leadId: l.id, content: `🗣️ ${String(input?.texto || '').trim()}` });
      return { ok: true, anotadoEm: l.name };
    }
    case 'criar_lembrete': {
      const d = new Date(String(input?.quando || ''));
      if (isNaN(d.getTime())) return { erro: 'data/hora inválida (use ISO 8601, ex.: 2026-10-30T09:00:00-03:00)' };
      const l = input?.leadId ? await leadOf(accountId, input.leadId) : null;
      if (d.getTime() < Date.now() - 60_000) return { erro: `esse horário (${quando(d)}) já passou — confirme a data` };
      await callApi(p.token, 'POST', '/tasks', { title: String(input?.titulo || '').trim().slice(0, 200), dueAt: d.toISOString(), userId, ...(l ? { leadId: l.id } : {}) });
      return { ok: true, lembrete: input?.titulo, quando: quando(d), cliente: l?.name || null, aviso: 'Na hora: push no celular + eu falo o lembrete aqui na tela (com o CRM aberto).' };
    }
    case 'conferir_analise': {
      const l = await leadOf(accountId, input?.leadId);
      const banks = bancosValidos(input?.bancos);
      if (!banks.length) return { erro: 'bancos: INTER, CREDITAS ou CREDIMORAR (Santander)' };
      const r = await callApi(p.token, 'POST', '/credit-analysis/requests', { leadIds: [l.id], banks, kind: 'CHECK' });
      return { ok: true, conferencia: banks.map((b) => NOME_BANCO[b]).join(', '), cliente: l.name, retorno: r, aviso: 'A extensão confere em 1–2 min (Chrome com a extensão aberto).' };
    }
    case 'ver_pasta': {
      const x = await pastaDoCliente(accountId, input?.leadId);
      const arquivos = await x.g.listAllFilesInFolderTree(accountId, x.pasta, 2);
      return { cliente: x.l.name, pasta: x.nome, onde: x.onde, link: x.g.folderLink(x.pasta), arquivos: arquivos.filter((f) => !/folder$/.test(f.mimeType)).slice(0, 60).map((f) => f.path || f.name) };
    }
    case 'consultar_conhecimento': {
      const q = String(input?.pergunta || '').trim();
      if (!q) return { erro: 'diga o que quer saber' };
      const { searchKnowledge } = require('./knowledge.service') as typeof import('./knowledge.service');
      const deps = await SETORES(accountId);
      const lotes = await Promise.all([undefined, ...deps.map((d) => d.id)].map((d) => searchKnowledge(accountId, q, 6, d).catch(() => [])));
      const vistos = new Set<string>();
      const hits = lotes.flat().filter((h) => { const k = h.content.slice(0, 120); if (vistos.has(k)) return false; vistos.add(k); return true; }).sort((a, b) => b.score - a.score).slice(0, 14);
      return { total: hits.length, trechos: hits.map((h) => ({ fonte: h.fileName, texto: h.content.slice(0, 900) })), obs: hits.length ? 'Responda com base nestes trechos e cite a fonte; se não cobrirem a pergunta, diga que a Base não tem e ofereça registrar a regra (alterar_regra_ia).' : 'A Base de Conhecimento não tem nada sobre isso: diga isso, não invente, e ofereça registrar a regra (alterar_regra_ia).' };
    }
    case 'ver_regras_ia': {
      const t = String(input?.termo || '').trim();
      const deps = await SETORES(accountId);
      const rows = await prisma.knowledgeEntry.findMany({ where: { accountId, ...(t ? { OR: [{ title: { contains: t, mode: 'insensitive' } }, { content: { contains: t, mode: 'insensitive' } }] } : {}) }, orderBy: { updatedAt: 'desc' }, take: 20, select: { id: true, title: true, content: true, departmentId: true, updatedAt: true } });
      return { total: rows.length, regras: rows.map((r) => ({ id: r.id, titulo: r.title, setor: deps.find((d) => d.id === r.departmentId)?.name || 'todos', atualizada: quando(r.updatedAt), texto: r.content.slice(0, 1200) })) };
    }
    case 'mover_pasta': {
      const x = await pastaDoCliente(accountId, input?.leadId);
      const dest = String(input?.destino || '').toUpperCase();
      if (!x.area) return { erro: `a pasta "${x.nome}" está ${x.onde}; não sei em qual área (Home Equity/Habitação) ela fica` };
      if (dest === 'FRIOS' && !x.area.frios) return { erro: `não achei LEADS FRIOS de ${x.area.nome}` };
      if (dest === 'CONCLUIDOS' && !x.area.concluidos) return { erro: `não achei CONCLUÍDOS de ${x.area.nome}` };
      if (!['ATIVOS', 'FRIOS', 'CONCLUIDOS'].includes(dest)) return { erro: 'destino: ATIVOS, FRIOS ou CONCLUIDOS' };
      const nomeDest = dest === 'ATIVOS' ? 'LEADS ATIVOS' : dest === 'FRIOS' ? 'LEADS FRIOS' : 'CONCLUÍDOS / ano / mês de hoje';
      return pendente({ accountId, userId, tipo: 'mover_pasta', params: { leadId: x.l.id, dest }, descricao: `Mover a pasta "${x.nome}" do ${x.l.name} de ${x.onde} para ${nomeDest} (${x.area.nome}).` }, p.fila);
    }
    case 'enviar_email': {
      const para = String(input?.para || '').split(/[,;]/).map((e) => e.trim().toLowerCase()).filter(Boolean);
      if (!para.length || para.some((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))) return { erro: 'e-mail do destinatário inválido' };
      const assunto = String(input?.assunto || '').trim(), texto = String(input?.texto || '').trim();
      if (!assunto || !texto) return { erro: 'faltou assunto ou texto' };
      const l = input?.leadId ? await leadOf(accountId, input.leadId) : null;
      const caixa = await prisma.emailAccount.findFirst({ where: { accountId, userId: null }, orderBy: { createdAt: 'asc' }, select: { id: true, address: true } });
      if (!caixa) return { erro: 'a caixa de e-mail comercial não está configurada' };
      let replyToId: string | null = null, subject = assunto;
      if (l) {
        const ant = await prisma.emailMessage.findFirst({ where: { leadId: l.id, fromAddress: { in: para, mode: 'insensitive' } }, orderBy: { date: 'desc' }, select: { id: true, subject: true } });
        if (ant) { replyToId = ant.id; subject = /^re:/i.test(ant.subject || '') ? String(ant.subject) : `Re: ${ant.subject || assunto}`; }
      }
      const pedidos = (Array.isArray(input?.anexos) ? input.anexos : []).map((a: unknown) => norm(String(a))).filter(Boolean);
      const anexos: { driveFileId: string; filename: string; contentType: string }[] = [];
      if (pedidos.length) {
        if (!l) return { erro: 'pra anexar arquivo da pasta, diga de qual cliente (leadId)' };
        const x = await pastaDoCliente(accountId, l.id);
        const arquivos = (await x.g.listAllFilesInFolderTree(accountId, x.pasta, 2)).filter((f) => !/folder$/.test(f.mimeType));
        for (const q of pedidos) {
          const f = arquivos.find((a) => norm(a.name) === q) || arquivos.find((a) => norm(a.name).includes(q));
          if (!f) return { erro: `não achei "${q}" na pasta do cliente`, arquivos: arquivos.slice(0, 40).map((a) => a.path || a.name) };
          anexos.push({ driveFileId: f.id, filename: f.name, contentType: f.mimeType });
        }
      }
      const cc = String(input?.cc || '').trim();
      return pendente({ accountId, userId, tipo: 'enviar_email', params: { caixaId: caixa.id, to: para, cc, subject, body: texto, replyToId, leadId: l?.id || null, attachments: anexos }, descricao: `Enviar e-mail de ${caixa.address} para ${para.join(', ')}${cc ? ` (cc ${cc})` : ''}${replyToId ? ' respondendo no mesmo fio' : ''} — assunto "${subject}"${anexos.length ? ` — anexos: ${anexos.map((a) => a.filename).join('; ')}` : ' — sem anexo'}:\n\n${texto}` }, p.fila);
    }
    case 'alterar_regra_ia': {
      // Regras da IA valem pra todos os clientes: só administrador muda (colaborador pode ver).
      const quem = await prisma.user.findFirst({ where: { id: userId, accountId }, select: { role: true } });
      if (quem?.role !== 'ADMIN') return { erro: 'só administrador pode mudar as regras da IA — peça ao Fabio' };
      const acao = String(input?.acao || '').toUpperCase();
      const deps = await SETORES(accountId);
      const setorTxt = norm(input?.setor || '');
      const depId = !setorTxt ? undefined : /todo|geral|ambos/.test(setorTxt) ? null : deps.find((d) => norm(d.name).includes(setorTxt.slice(0, 6)) || (/habita/.test(setorTxt) && /habita/i.test(d.name)) || (/home|equity/.test(setorTxt) && /home/i.test(d.name)))?.id;
      if (setorTxt && depId === undefined) return { erro: `setor "${input?.setor}" não encontrado`, setores: deps.map((d) => d.name) };
      const nomeSetor = (id: string | null | undefined) => (id ? deps.find((d) => d.id === id)?.name : 'todos os setores');
      if (acao === 'CRIAR') {
        const titulo = String(input?.titulo || '').trim(), conteudo = String(input?.conteudo || '').trim();
        if (!titulo || !conteudo) return { erro: 'faltou título ou conteúdo' };
        return pendente({ accountId, userId, tipo: 'alterar_regra_ia', params: { acao, titulo, conteudo, departmentId: depId ?? null }, descricao: `Criar regra da IA (${nomeSetor(depId ?? null)}): "${titulo}"\n${conteudo}` }, p.fila);
      }
      const r = await prisma.knowledgeEntry.findFirst({ where: { id: String(input?.id || ''), accountId }, select: { id: true, title: true, content: true, departmentId: true } });
      if (!r) return { erro: 'regra não encontrada (use ver_regras_ia pra achar o id)' };
      if (acao === 'APAGAR') return pendente({ accountId, userId, tipo: 'alterar_regra_ia', params: { acao, id: r.id }, descricao: `APAGAR a regra da IA "${r.title}" (${nomeSetor(r.departmentId)}):\n${r.content.slice(0, 600)}` }, p.fila);
      if (acao === 'EDITAR') {
        const conteudo = String(input?.conteudo || '').trim();
        if (!conteudo) return { erro: 'faltou o novo conteúdo' };
        const titulo = String(input?.titulo || '').trim() || r.title;
        const dep = depId === undefined ? r.departmentId : depId;
        return pendente({ accountId, userId, tipo: 'alterar_regra_ia', params: { acao, id: r.id, titulo, conteudo, departmentId: dep }, descricao: `Mudar a regra da IA "${r.title}" (${nomeSetor(dep)}).\nANTES: ${r.content.slice(0, 500)}\nDEPOIS: ${conteudo}` }, p.fila);
      }
      return { erro: 'acao: CRIAR, EDITAR ou APAGAR' };
    }
    // ── com confirmação ──
    case 'ver_formulario': {
      const l = await leadOf(accountId, input?.leadId);
      const cf = (l.customFields || {}) as Record<string, any>;
      const aba = norm(input?.aba || '');
      const defs = await prisma.fieldDefinition.findMany({ where: { accountId }, orderBy: [{ tab: 'asc' }, { order: 'asc' }], select: { tab: true, name: true, key: true, type: true, options: true } });
      return { cliente: l.name, campos: defs.filter((d) => !aba || norm(d.tab).includes(aba)).map((d) => ({ aba: d.tab, campo: d.name, chave: d.key, tipo: d.type, ...(d.options?.length ? { opcoes: d.options } : {}), valor: cf[d.key] ?? '' })) };
    }
    case 'preencher_formulario': {
      const l = await leadOf(accountId, input?.leadId);
      const cf = (l.customFields || {}) as Record<string, any>;
      const pedidos = input?.campos && typeof input.campos === 'object' ? Object.entries(input.campos as Record<string, unknown>) : [];
      if (!pedidos.length) return { erro: 'nenhum campo pra preencher' };
      const defs = await prisma.fieldDefinition.findMany({ where: { accountId }, select: { name: true, key: true, type: true, options: true } });
      const mudar: Record<string, string> = {}; const linhas: string[] = []; const erros: string[] = [];
      for (const [k, v] of pedidos) {
        const d = defs.find((x) => x.key === k) || defs.find((x) => norm(x.name) === norm(k)) || defs.find((x) => norm(x.name).includes(norm(k)) || norm(k).includes(norm(x.name)));
        if (!d) { erros.push(`campo "${k}" não existe no formulário`); continue; }
        let val = v === null || v === undefined ? '' : String(v).trim();
        if (val && d.options?.length) { const op = d.options.find((o) => norm(o) === norm(val)); if (!op) { erros.push(`"${d.name}" aceita só: ${d.options.join(', ')}`); continue; } val = op; }
        if (String(cf[d.key] ?? '') === val) continue;
        mudar[d.key] = val;
        linhas.push(`• ${d.name}: ${String(cf[d.key] ?? '').trim() || '(vazio)'} → ${val || '(apagar)'}`);
      }
      if (erros.length && !linhas.length) return { erro: erros.join('; ') };
      if (!linhas.length) return { ok: true, aviso: 'os campos já estão com esses valores' };
      return { ...pendente({ accountId, userId, tipo: 'preencher_formulario', params: { leadId: l.id, mudar }, descricao: `Preencher o formulário do ${l.name}:\n${linhas.join('\n')}` }, p.fila), ...(erros.length ? { naoEntraram: erros } : {}) };
    }
    case 'iniciar_supervisao': {
      const u = await prisma.user.findFirst({ where: { id: userId, accountId }, select: { role: true } });
      if (u?.role !== 'ADMIN') return { erro: 'a supervisão de sexta é só pra administrador' };
      callApi(p.token, 'POST', '/supervision/generate').catch((e) => console.warn('[Assistente] supervisão:', e?.message));
      p.nav.push({ path: '/supervisao', label: 'Supervisão de sexta' });
      return { ok: true, aviso: 'Gerando em segundo plano: os cards aparecem na tela da Supervisão conforme ficam prontos (botão Atualizar lista). Os que já existiam continuam.' };
    }
    case 'ver_supervisao': {
      const r = await callApi(p.token, 'GET', '/supervision');
      const itens = (r?.items || []).filter((i: any) => !input?.soPendentes || i.status === 'PENDING');
      return { semana: r?.weekKey, total: r?.items?.length || 0, pendentes: (r?.items || []).filter((i: any) => i.status === 'PENDING').length, itens: itens.slice(0, 40).map((i: any) => ({ itemId: i.id, leadId: i.leadId, cliente: i.leadName, etapa: i.etapa, banco: i.banco, status: i.status, resumo: i.resumo, situacao: i.situacao, pendencias: i.pendencias, mensagemSugerida: i.sugestao || '(não falar com o cliente agora)', acaoEquipe: i.acao, janelaAberta: i.janelaAberta })) };
    }
    case 'agir_supervisao': {
      const acao = String(input?.acao || '').toUpperCase();
      const it = await prisma.supervisionItem.findFirst({ where: { id: String(input?.itemId || ''), accountId }, select: { id: true, leadId: true, sugestao: true } });
      if (!it) return { erro: 'item da supervisão não encontrado (use ver_supervisao)' };
      const l = await leadOf(accountId, it.leadId);
      if (acao === 'PULAR' || acao === 'FEITO') { await callApi(p.token, 'POST', `/supervision/${it.id}/${acao === 'PULAR' ? 'skip' : 'done'}`); return { ok: true, feito: `${l.name}: ${acao === 'PULAR' ? 'pulado' : 'marcado como feito'}` }; }
      const texto = String(input?.texto || it.sugestao || '').trim();
      if (!texto) return { erro: 'sem mensagem pra enviar' };
      if (acao !== 'ENVIAR' && acao !== 'TEMPLATE') return { erro: 'acao: ENVIAR, TEMPLATE, PULAR ou FEITO' };
      const aberta = await janelaAberta(it.leadId);
      const modo = aberta ? 'send' : 'template';
      return pendente({ accountId, userId, tipo: 'agir_supervisao', params: { itemId: it.id, modo, texto }, descricao: aberta ? `Supervisão — mandar pro ${l.name}: "${texto}"` : `Supervisão — janela do ${l.name} fechada: mandar o template de atualização agora; a mensagem "${texto}" sai quando ele responder.` }, p.fila);
    }
    case 'docs_para_andamento': {
      const t0 = Date.now();
      const dias = Math.max(1, Math.min(Number(input?.dias) || 10, 60));
      const corte = new Date(Date.now() - dias * 86400_000);
      const funil = input?.funil ? `%${input.funil}%` : '%';
      // 1) anexos recebidos no período (só o necessário), 2) os cards abertos deles — sem ler a conversa nem o texto dos documentos
      const anexos = await prisma.$queryRaw<{ id: string; leadId: string; createdAt: Date }[]>`
        SELECT a.id, a."leadId", a."createdAt" FROM "MessageAttachment" a JOIN "Message" m ON m.id = a."messageId"
        WHERE a."createdAt" >= ${corte} AND m.direction = 'INBOUND' AND a."mimeType" NOT LIKE 'audio/%' AND a."mimeType" NOT LIKE 'video/%' AND a."mimeType" <> 'image/webp'`;
      const porLead = new Map<string, { ultimo: Date; n: number }>();
      for (const x of anexos) { const v = porLead.get(x.leadId); if (!v) porLead.set(x.leadId, { ultimo: x.createdAt, n: 1 }); else { v.n++; if (x.createdAt > v.ultimo) v.ultimo = x.createdAt; } }
      const leads = await prisma.lead.findMany({ where: { id: { in: [...porLead.keys()] }, accountId, status: 'OPEN', archived: false, isGroup: false, ...(input?.funil ? { pipeline: { name: { contains: String(input.funil), mode: 'insensitive' } } } : {}) }, select: { id: true, name: true, customFields: true, stage: { select: { name: true } }, pipeline: { select: { name: true } } }, take: 80 });
      void funil;
      const equipe = await prisma.message.groupBy({ by: ['leadId'], where: { leadId: { in: leads.map((l) => l.id) }, direction: 'OUTBOUND', sentByUserId: { not: null } }, _max: { createdAt: true } });
      const ultEquipe = new Map(equipe.map((e) => [e.leadId, e._max.createdAt]));
      const datas = new Map((await prisma.messageAttachment.findMany({ where: { leadId: { in: leads.map((l) => l.id) } }, select: { id: true, createdAt: true } })).map((x) => [x.id, x.createdAt.getTime()]));
      const out = leads.map((l) => {
        const cf = (l.customFields || {}) as Record<string, any>;
        const rev = Object.entries((cf._docReview || {}) as Record<string, any>).filter(([, r]) => r && r.resultado !== 'NAO_DOCUMENTO');
        const ultimo = new Map<string, any>(); // a leitura mais recente de cada documento (tipo + titular + lado)
        for (const [id, r] of rev.sort((x, y) => (datas.get(x[0]) || 0) - (datas.get(y[0]) || 0))) ultimo.set(`${norm(r.tipo)}|${norm(r.titular)}|${r.lado || ''}`, r);
        const vals = [...ultimo.values()];
        const problemas = vals.filter((r) => r.resultado === 'PROBLEMA').map((r) => `${r.tipo}${r.titular ? ` (${r.titular})` : ''}: ${(r.problemas || []).join('; ')}`.slice(0, 160));
        const duvidas = vals.filter((r) => r.resultado === 'DUVIDA').map((r) => String(r.tipo));
        const falta = String(cf._docsFaltando || '').trim();
        const situacao = !vals.length ? 'NAO_CONFERIDO' : duvidas.length ? 'DUVIDA_COM_A_EQUIPE' : problemas.length ? 'COM_PROBLEMA' : falta ? 'FALTA_DOCUMENTO' : 'PRONTO';
        const d = porLead.get(l.id)!;
        const eq = ultEquipe.get(l.id);
        return { leadId: l.id, nome: l.name, funil: l.pipeline?.name, etapa: l.stage?.name, situacao, ultimoDocumento: quando(d.ultimo), arquivosNoPeriodo: d.n, conferidosOk: vals.filter((r) => r.resultado === 'OK').map((r) => r.tipo).slice(0, 12),
          equipeFalouDepois: !!(eq && eq > d.ultimo), ...(problemas.length ? { problemas } : {}), ...(falta ? { falta: falta.slice(0, 200) } : {}), ...(duvidas.length ? { duvidas } : {}), _t: d.ultimo.getTime() };
      });
      const ordem: Record<string, number> = { PRONTO: 0, DUVIDA_COM_A_EQUIPE: 1, NAO_CONFERIDO: 2, COM_PROBLEMA: 3, FALTA_DOCUMENTO: 4 };
      out.sort((a, b) => ordem[a.situacao] - ordem[b.situacao] || a._t - b._t);
      console.log(`[Assistente] docs_para_andamento ${out.length} clientes em ${Date.now() - t0} ms`);
      return { total: out.length, clientes: out.slice(0, 30).map(({ _t, ...r }) => r) };
    }
    case 'documentos_do_cliente': {
      const l = await leadOf(accountId, input?.leadId);
      const cf = (l.customFields || {}) as Record<string, any>;
      const rev = (cf._docReview || {}) as Record<string, any>;
      const atts = await prisma.messageAttachment.findMany({ where: { leadId: l.id, message: { direction: 'INBOUND' }, NOT: [{ mimeType: { startsWith: 'audio/' } }, { mimeType: { startsWith: 'video/' } }] }, orderBy: { createdAt: 'asc' }, select: { id: true, fileName: true, createdAt: true } });
      const { aiDocsContext } = require('./doc-review.service') as typeof import('./doc-review.service');
      return {
        cliente: l.name, etapa: l.stage?.name, resumo: (await aiDocsContext(l.id).catch(() => '')) || 'nenhum documento conferido ainda',
        arquivos: atts.slice(-40).map((a) => { const r = rev[a.id]; return { arquivo: a.fileName, chegou: quando(a.createdAt), ...(r ? { tipo: r.tipo, titular: r.titular, resultado: r.resultado, problemas: r.problemas?.length ? r.problemas : undefined, emissao: r.emissao || undefined, lado: r.lado || undefined, dono: r.dono, donoSituacao: r.donoSituacao, matricula: r.matricula, cartorio: r.cartorio, gravame: r.gravame || undefined, ressalva: r.ressalva, outros: r.outros, observacao: r.observacao || undefined } : { resultado: 'NAO_LIDO' }) }; }),
      };
    }
    case 'conferir_documentos': {
      const l = await leadOf(accountId, input?.leadId);
      const { reviewReceivedDocs } = require('./doc-review.service') as typeof import('./doc-review.service');
      const r = await reviewReceivedDocs(accountId, l.id);
      if (!r) return { ok: true, aviso: 'esse cliente não mandou documento' };
      return { ok: true, cliente: l.name, lidosAgora: r.novas.map((n) => `${n.arquivo}: ${n.r.tipo} — ${n.r.resultado}`), ok_: r.ok, problemas: r.problemas, duvidas: r.duvidas.map((d) => `${d.doc}: ${d.pergunta}`), donoPendente: r.donoPendente.map((d) => `${d.doc}: dono ${d.dono}`) };
    }
    case 'ler_documento': {
      const l = await leadOf(accountId, input?.leadId);
      const q = norm(input?.arquivo || '');
      const cf = (l.customFields || {}) as Record<string, any>;
      const rev = (cf._docReview || {}) as Record<string, any>;
      const atts = (await prisma.messageAttachment.findMany({ where: { leadId: l.id, message: { direction: 'INBOUND' } }, orderBy: { createdAt: 'desc' }, select: { id: true, fileName: true, mimeType: true, driveFileId: true, data: true } }))
        .filter((a) => a.mimeType === 'application/pdf' || /^image\/(jpeg|png|gif|webp)$/.test(a.mimeType));
      const att = atts.find((a) => norm(a.fileName).includes(q)) || atts.find((a) => norm(rev[a.id]?.tipo || '').includes(q));
      if (!att) return { erro: `não achei "${input?.arquivo}" entre os arquivos do cliente`, arquivos: atts.slice(0, 30).map((a) => `${a.fileName}${rev[a.id]?.tipo ? ` (${rev[a.id].tipo})` : ''}`) };
      let buffer: Buffer, mime = att.mimeType;
      if (att.data?.length) buffer = Buffer.from(att.data);
      else if (att.driveFileId) { const { downloadDriveFileForVision } = require('./google.service') as typeof import('./google.service'); ({ buffer, mimeType: mime } = await downloadDriveFileForVision(accountId, att.driveFileId, att.mimeType)); }
      else return { erro: 'o arquivo não está mais disponível (nem no banco nem no Drive)' };
      if (buffer.length > 10_000_000) return { erro: 'arquivo grande demais pra ler aqui (mais de 10 MB)' };
      const isPdf = att.mimeType === 'application/pdf';
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY || '', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 3000, system: 'Você analisa documentos de clientes de um correspondente bancário (crédito com garantia de imóvel e financiamento habitacional) para a EQUIPE. Responda em português, direto, citando o que está escrito no documento (números, nomes, datas). Se algo não aparece ou está ilegível, diga isso — nunca invente.', messages: [{ role: 'user', content: [{ type: isPdf ? 'document' : 'image', source: { type: 'base64', media_type: isPdf ? 'application/pdf' : mime, data: buffer.toString('base64') } }, { type: 'text', text: `Cliente: ${l.name}. Arquivo: ${att.fileName}.\nPergunta: ${String(input?.pergunta || 'O que é este documento e o que ele mostra de importante?')}` }] }] }),
      });
      if (!res.ok) return { erro: `não consegui ler o documento agora (${res.status})` };
      const j = (await res.json()) as { content: any[] };
      return { arquivo: att.fileName, resposta: (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim() || '(sem resposta)' };
    }
    case 'ligar_para_cliente': {
      const l = await leadOf(accountId, input?.leadId);
      const st = await callApi(p.token, 'GET', `/calls/permission-state?leadId=${l.id}`);
      if (!st?.permitted) return st?.canRequest === false
        ? { erro: `o ${l.name} ainda não autorizou ligação e o pedido de permissão já foi enviado — aguardando ele tocar em "Permitir"` }
        : { erro: `o ${l.name} ainda não autorizou ligação pelo WhatsApp`, podePedirPermissao: true };
      const tel = String(st.phone || '').replace(/^55(\d{2})(\d{4,5})(\d{4})$/, '($1) $2-$3');
      return pendente({ accountId, userId, tipo: 'ligar', params: { leadId: l.id, leadName: l.name }, descricao: `Ligar agora pro ${l.name}${tel ? ` — ${tel}` : ''} pelo WhatsApp. Você fala; eu só disco (uso o seu microfone e abro a conversa dele).` }, p.fila);
    }
    case 'pedir_permissao_ligacao': {
      const l = await leadOf(accountId, input?.leadId);
      const st = await callApi(p.token, 'GET', `/calls/permission-state?leadId=${l.id}`);
      if (st?.permitted) return { ok: true, aviso: `o ${l.name} já autorizou ligação — dá pra ligar (ligar_para_cliente)` };
      if (st?.canRequest === false) return { erro: 'o pedido de permissão já foi enviado recentemente — aguardando o cliente (limite da Meta: 1/dia, 2/semana)' };
      return pendente({ accountId, userId, tipo: 'pedir_permissao_ligacao', params: { leadId: l.id }, descricao: `Mandar pro ${l.name} o pedido de permissão de ligação do WhatsApp (ele recebe o botão "Permitir").` }, p.fila);
    }
    case 'gravar_audio': {
      const l = await leadOf(accountId, input?.leadId);
      if (!(await janelaAberta(l.id))) return { erro: `a janela de 24 h do ${l.name} está fechada: o WhatsApp não deixa mandar áudio agora. Dá pra mandar uma mensagem (vai o template de atualização e a mensagem sai quando ele responder) e mandar o áudio depois.` };
      p.audio?.push({ leadId: l.id, leadName: l.name });
      return { ok: true, aviso: `Gravador aberto no balão pro ${l.name}: a pessoa grava, ouve e clica em Enviar. Diga isso em 1 frase.` };
    }
    case 'enviar_mensagem': {
      const l = await leadOf(accountId, input?.leadId);
      const texto = String(input?.texto || '').trim();
      if (!texto) return { erro: 'mensagem vazia' };
      const aberta = await janelaAberta(l.id);
      return pendente({ accountId, userId, tipo: 'enviar_mensagem', params: { leadId: l.id, texto, aberta }, descricao: aberta ? `Mandar pro ${l.name} pelo WhatsApp: "${texto}"` : `A janela de 24 h do ${l.name} está fechada: mandar o template de atualização do processo agora, e a mensagem "${texto}" sai quando ele responder.` }, p.fila);
    }
    case 'mover_card': {
      const l = await leadOf(accountId, input?.leadId);
      const etapa = norm(input?.etapa), funil = norm(input?.funil || '');
      const stages = await prisma.stage.findMany({ where: { pipeline: { accountId } }, select: { id: true, name: true, pipeline: { select: { id: true, name: true } } } });
      let c = stages.filter((s) => norm(s.name) === etapa); if (!c.length) c = stages.filter((s) => norm(s.name).includes(etapa));
      if (funil) c = c.filter((s) => norm(s.pipeline.name).includes(funil));
      // Sem funil dito pela pessoa, o card FICA no funil em que está (Fabio 29/10): só procura a etapa nele; se não existir lá, avisa em vez de mandar pra outro funil.
      if (!funil && l.pipeline?.id) {
        const mesmoFunil = c.filter((s) => s.pipeline.id === l.pipeline?.id);
        if (!mesmoFunil.length && c.length) {
          const doFunil = stages.filter((s) => s.pipeline.id === l.pipeline?.id).map((s) => s.name);
          return { erro: `o funil "${l.pipeline.name}" não tem a etapa "${input?.etapa}" (ela existe em outro funil e eu não troco de funil sem você pedir)`, etapasDoFunil: doFunil };
        }
        c = mesmoFunil;
      }
      if (!c.length) return { erro: `não achei a etapa "${input?.etapa}"${funil ? ` no funil "${input?.funil}"` : ''}` };
      if (c.length > 1) return { erro: 'mais de uma etapa com esse nome — diga o funil', opcoes: c.slice(0, 8).map((s) => `${s.pipeline.name} → ${s.name}`) };
      return pendente({ accountId, userId, tipo: 'mover_card', params: { leadId: l.id, stageId: c[0].id }, descricao: `Mover o ${l.name} de "${l.pipeline?.name} → ${l.stage?.name}" para "${c[0].pipeline.name} → ${c[0].name}".` }, p.fila);
    }
    case 'marcar_status': {
      const l = await leadOf(accountId, input?.leadId);
      const st = String(input?.status || '').toUpperCase(), motivo = String(input?.motivo || '').trim();
      if ((st === 'PERDIDO' || st === 'REPROVADO') && !motivo) return { erro: 'preciso do motivo pra marcar como perdido/reprovado' };
      const body = st === 'GANHO' ? { status: 'WON' } : st === 'REABRIR' ? { status: 'OPEN' } : st === 'REPROVADO' ? { status: 'LOST', lostReason: motivo, rejected: true } : st === 'PERDIDO' ? { status: 'LOST', lostReason: motivo } : null;
      if (!body) return { erro: 'status: GANHO, PERDIDO, REPROVADO ou REABRIR' };
      const efeito = st === 'GANHO' ? ' (vai pro funil Concluído e a pasta vai pra CONCLUÍDOS)' : st === 'REABRIR' ? ' (a pasta volta pra LEADS ATIVOS se estiver em LEADS FRIOS)' : ' (vai pro funil Perdidos e a pasta vai pra LEADS FRIOS)';
      return pendente({ accountId, userId, tipo: 'marcar_status', params: { leadId: l.id, body }, descricao: `Marcar o ${l.name} como ${st}${motivo ? ` — motivo: ${motivo}` : ''}${efeito}.` }, p.fila);
    }
    case 'rodar_analise': {
      const l = await leadOf(accountId, input?.leadId);
      const banks = bancosValidos(input?.bancos);
      if (!banks.length) return { erro: 'bancos: INTER, CREDITAS ou CREDIMORAR (Santander)' };
      return pendente({ accountId, userId, tipo: 'rodar_analise', params: { leadId: l.id, banks }, descricao: `Rodar a análise de crédito do ${l.name} no ${banks.map((b) => NOME_BANCO[b]).join(', ')} (cria proposta nova no portal do banco).` }, p.fila);
    }
    case 'solicitar_vistoria': {
      const l = await leadOf(accountId, input?.leadId);
      const prev = await callApi(p.token, 'GET', `/vistorias/preview?leadId=${l.id}`);
      if (!prev?.to) return { erro: 'não achei o e-mail do consultor do Inter pra esse cliente (o e-mail de engajamento ainda não chegou?)', avisos: prev?.avisos };
      const anexos = (prev.anexos || []).filter((a: any) => a.checked);
      if (!anexos.length) return { erro: 'não há documento do imóvel marcado pra anexar (o pedido vai sempre com anexo)', avisos: prev.avisos };
      return pendente({ accountId, userId, tipo: 'solicitar_vistoria', params: { leadId: l.id, prev: { to: prev.to, cc: prev.cc, subject: prev.subject, body: prev.body, replyToId: prev.replyToId, ids: anexos.map((a: any) => a.id) } }, descricao: `${prev.jaSolicitadaEm ? `ATENÇÃO: a vistoria já foi pedida em ${quando(new Date(prev.jaSolicitadaEm))}. ` : ''}Responder o e-mail do Inter (${prev.to}) pedindo a vistoria do ${l.name}, com ${anexos.length} anexo(s): ${anexos.map((a: any) => a.name).join('; ')}.` }, p.fila);
    }
    case 'ver_extensoes': {
      const live = (await callApi(p.token, 'GET', '/credit-analysis/live')) as any[];
      const fh = await prisma.creditAnalysis.groupBy({ by: ['bank', 'status'], where: { accountId, bank: { in: ['CREDIMORAR_FH', 'INTER_FH'] }, status: { in: ['REQUESTED', 'RUNNING'] } }, _count: true }).catch(() => [] as any[]);
      const cert = await prisma.certidaoRequest.groupBy({ by: ['status'], where: { accountId, status: { in: ['REQUESTED', 'IN_PROGRESS', 'AWAITING_PAYMENT'] } }, _count: true }).catch(() => [] as any[]);
      const certUlt = await prisma.certidaoRequest.findFirst({ where: { accountId }, orderBy: { updatedAt: 'desc' }, select: { updatedAt: true, status: true, detail: true } });
      return {
        bancos: (live || []).map((b: any) => ({ banco: b.bank, ligada: b.online, ultimoSinal: b.lastSeenAt, precisaLogin: b.loginNeeded, foraDoHorario: b.foraDoHorario, rodandoAgora: (b.running || []).map((r: any) => `${r.leadName} (${r.kind}) — ${r.step || ''}`), naFila: (b.queue || []).length })),
        financiamento: fh.map((x: any) => `${x.bank === 'INTER_FH' ? 'Inter (nosso portal)' : 'Credimorar'}: ${x._count} ${x.status === 'RUNNING' ? 'rodando' : 'na fila'}`),
        certidaoOnr: { pedidos: cert.map((x: any) => `${x._count} ${x.status === 'AWAITING_PAYMENT' ? 'aguardando pagamento/emissão' : x.status === 'IN_PROGRESS' ? 'em andamento' : 'na fila'}`), ultimaAtividade: certUlt ? `${certUlt.updatedAt.toISOString()} — ${String(certUlt.detail || certUlt.status).slice(0, 120)}` : null },
        obs: 'O Financiamento do Inter roda pela extensão do Inter; o do Credimorar pela extensão do Credimorar. Extensão sem sinal há mais de 3 min = Chrome fechado, computador dormindo ou extensão desligada.',
      };
    }
    case 'rodar_financiamento': {
      const l = await leadOf(accountId, input?.leadId);
      const pedidos = (Array.isArray(input?.bancos) ? input.bancos : []).map((b: unknown) => String(b).toUpperCase());
      const banks = [...(pedidos.length === 0 || pedidos.some((b: string) => /CREDIMORAR|BRADESCO|ITAU|ITAÚ|SANTANDER/.test(b)) ? ['CREDIMORAR_FH'] : []), ...(pedidos.length === 0 || pedidos.some((b: string) => /INTER/.test(b)) ? ['INTER_FH'] : [])];
      const cf = (l.customFields || {}) as Record<string, any>;
      const quais = banks.map((b) => (b === 'INTER_FH' ? 'Inter (nosso portal)' : 'Credimorar (Bradesco, Itaú e Santander)')).join(' e ');
      return pendente({ accountId, userId, tipo: 'rodar_financiamento', params: { leadId: l.id, banks }, descricao: `Rodar o Financiamento do ${l.name} no ${quais} — cria proposta nova. Valores do card: imóvel ${cf.valor_imovel || '?'}, crédito ${cf.valor_credito || '?'}, entrada ${cf.valor_entrada || '?'}.` }, p.fila);
    }
    case 'conferir_financiamento': {
      const l = await leadOf(accountId, input?.leadId);
      await callApi(p.token, 'POST', '/credit-analysis/fh-request', { leadId: l.id, kind: 'CHECK' });
      return { ok: true, obs: `Pedi pras extensões lerem a situação do Financiamento do ${l.name} (Credimorar e Inter). O resultado entra no card em alguns minutos.` };
    }
    case 'marcar_pix_pago': {
      const l = await leadOf(accountId, input?.leadId);
      const r = await prisma.certidaoRequest.findFirst({ where: { leadId: l.id, accountId, status: 'AWAITING_PAYMENT', paidAt: null }, orderBy: { createdAt: 'desc' }, select: { id: true, protocolo: true, valorCents: true } });
      if (!r) return { naoDa: `o ${l.name} não tem certidão aguardando pagamento` };
      return pendente({ accountId, userId, tipo: 'marcar_pix_pago', params: { id: r.id }, descricao: `Marcar como PAGO o PIX da certidão do ${l.name}${r.protocolo ? ` (protocolo ${r.protocolo})` : ''}${r.valorCents ? `, R$ ${(r.valorCents / 100).toFixed(2).replace('.', ',')}` : ''} — a extensão do ONR passa a buscar a certidão emitida e guardar no Drive.` }, p.fila);
    }
    case 'buscar_certidao': {
      const l = await leadOf(accountId, input?.leadId);
      const r = await prisma.certidaoRequest.findFirst({ where: { leadId: l.id, accountId, status: { in: ['AWAITING_PAYMENT', 'REQUESTED', 'IN_PROGRESS'] }, protocolo: { not: null } }, orderBy: { createdAt: 'desc' }, select: { id: true, protocolo: true, paidAt: true } });
      if (!r) return { naoDa: `o ${l.name} não tem pedido de certidão feito no portal esperando emissão (veja com ver_certidao)` };
      const out = await callApi(p.token, 'POST', `/certidoes/${r.id}/collect-now`, {});
      return { ok: true, protocolo: r.protocolo, fora_do_horario: !!(out as any)?.queuedUntilMorning, obs: `A extensão vai ao portal agora (protocolo ${r.protocolo}); se a certidão já saiu, ela baixa e guarda na pasta IMOVEL do Drive e anota no card. Se ainda não saiu, o pedido segue aguardando.${r.paidAt ? '' : ' O PIX não está marcado como pago no CRM.'}` };
    }
    case 'enviar_onus_pos_registro': {
      const l = await leadOf(accountId, input?.leadId);
      return pendente({ accountId, userId, tipo: 'enviar_onus_pos_registro', params: { leadId: l.id }, descricao: `Enviar ao consultor do Inter (respondendo a conversa do processo) a certidão de ônus pós-registro do ${l.name}, pra pagamento ao vendedor.` }, p.fila);
    }
    case 'vincular_emails_banco': {
      const eu = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
      if (eu?.role !== 'ADMIN') return { naoPode: 'só administrador vincula e-mails de outras caixas' };
      const l = await leadOf(accountId, input?.leadId);
      const cf = (l.customFields || {}) as Record<string, any>;
      const nome = String(cf.participante_1 || l.name || '').split('/')[0].trim();
      const cpf = String(cf.cpf_1 || '').replace(/\D/g, '');
      const termos = [nome, cpf.length === 11 ? `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}` : '', cpf, String(cf.num_proposta || ''), ...((Array.isArray(input?.termos) ? input.termos : []) as string[])].map((t) => String(t || '').trim()).filter((t) => t.length >= 6);
      if (!termos.length) return { erro: 'sem nome/CPF/proposta pra procurar' };
      const BANCO = ['inter.co', 'bancointer.com.br', 'creditas.com', 'credimorar', 'santander.com.br', 'bradesco', 'itau', 'caixa.gov.br'];
      const achados = await prisma.emailMessage.findMany({
        where: {
          emailAccount: { accountId },
          AND: [
            { OR: termos.flatMap((t) => [{ subject: { contains: t, mode: 'insensitive' as const } }, { textBody: { contains: t, mode: 'insensitive' as const } }, { htmlBody: { contains: t, mode: 'insensitive' as const } }]) },
            { OR: BANCO.flatMap((d) => [{ fromAddress: { contains: d, mode: 'insensitive' as const } }, { folder: 'SENT', toList: { string_contains: d } } as any]) },
          ],
        },
        orderBy: { date: 'asc' }, take: 60,
        select: { id: true, leadId: true, subject: true, fromAddress: true, folder: true, date: true, emailAccount: true },
      });
      const { linkEmailToLead } = require('./email-inbox.service') as typeof import('./email-inbox.service');
      const ligados: string[] = [];
      for (const m of achados) {
        if (m.leadId === l.id) continue;
        if (m.leadId && m.leadId !== l.id) continue; // já é de outro card: não mexe
        try { await linkEmailToLead(m.emailAccount as any, m.id, l.id, (p as any).io || ({ to: () => ({ emit: () => {} }) } as any)); ligados.push(`${m.date.toISOString().slice(0, 10)} ${m.fromAddress} — ${String(m.subject || '').slice(0, 80)} (caixa ${m.emailAccount.address})`); } catch { /* segue */ }
      }
      return { procurei: termos, encontrados: achados.length, ligadosAgora: ligados, jaEramDoCard: achados.filter((m) => m.leadId === l.id).length };
    }
    case 'renomear_onus_pos_registro': { const l = await leadOf(accountId, input?.leadId); return (require('./onus-pos-registro.service') as typeof import('./onus-pos-registro.service')).renomearOnusPosRegistro(accountId, l.id); }
    case 'escolher_voz': p.ui?.push('escolherVoz'); return { ok: true, instrucao: 'A lista de vozes abriu no balão: diga em 1 frase que é só tocar no ▶ pra ouvir e em Escolher.' };
    case 'consultar_cartorio': return (require('./ri-cartorios.service') as typeof import('./ri-cartorios.service')).consultarCartorios(String(input?.uf || ''), input?.cidade ? String(input.cidade) : undefined);
    case 'ver_certidao': {
      const l = await leadOf(accountId, input?.leadId);
      const rs = await prisma.certidaoRequest.findMany({ where: { leadId: l.id, accountId }, orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, status: true, matricula: true, pedidoPor: true, cidade: true, uf: true, protocolo: true, valorCents: true, pixCode: true, pixExpiresAt: true, pixSentAt: true, paidAt: true, detail: true, createdAt: true, sendPix: true } });
      if (!rs.length) return { pedidos: [], obs: `o ${l.name} não tem pedido de certidão` };
      const pix = rs.find((r) => r.pixCode && r.pixCode !== 'ADOTADO' && !r.paidAt && ['REQUESTED', 'IN_PROGRESS', 'AWAITING_PAYMENT'].includes(r.status));
      if (pix) p.copiar?.push({ label: `PIX da certidão do ${l.name}${pix.valorCents ? ` (R$ ${(pix.valorCents / 100).toFixed(2).replace('.', ',')})` : ''}`, texto: pix.pixCode! });
      return {
        pedidos: rs.map((r) => ({ status: r.status, matricula: r.pedidoPor === 'ENDERECO' ? 'pelo endereço' : r.matricula, cidade: `${r.cidade}/${r.uf}`, protocolo: r.protocolo, valor: r.valorCents ? r.valorCents / 100 : null, pixGerado: !!(r.pixCode && r.pixCode !== 'ADOTADO'), pixEnviadoAoCliente: !!r.pixSentAt, pago: !!r.paidAt, pixVence: r.pixExpiresAt, situacao: r.detail, pedidoEm: r.createdAt })),
        pixNoBalao: !!pix,
        ...(rs[0]?.status === 'FAILED' && /não existe em/i.test(String(rs[0]?.detail || '')) ? { obsCartorio: 'A extensão agora procura o mesmo número de cartório nas OUTRAS cidades do estado (no DF cada Ofício fica numa região) e memoriza. NÃO sugira trocar por outro cartório: ofereça refazer o pedido com o MESMO cartório (pedir_certidao com a mesma matrícula/cidade/UF/cartório).' } : {}),
        instrucao: pix ? 'O código PIX está no balão com o botão Copiar. Diga só o valor e que está pronto pra copiar.' : 'Se o PIX ainda não foi gerado, diga que a extensão ainda está fazendo o pedido no portal e que é só perguntar de novo em alguns minutos.',
      };
    }
    case 'pedir_certidao': {
      const l = await leadOf(accountId, input?.leadId);
      const pixNoChat = input?.pixNoChat === true;
      const ondePix = pixNoChat ? 'o PIX NÃO vai pro cliente: fica com você (peça "o PIX da certidão" que eu mostro pra copiar)' : 'o PIX da certidão vai pro cliente';
      const matricula = String(input?.matricula || '').replace(/\D/g, ''), cidade = String(input?.cidade || '').trim(), uf = String(input?.uf || '').trim().toUpperCase();
      if (matricula && cidade && uf) {
        const params = { leadId: l.id, uf, cidade, cartorio: String(input?.cartorio || '').trim() || 'AUTO', matricula, sendPix: !pixNoChat };
        return pendente({ accountId, userId, tipo: 'pedir_certidao', params, descricao: `Pedir a certidão da matrícula nº ${matricula} (${params.cartorio === 'AUTO' ? cidade : params.cartorio}/${uf}) do ${l.name} no RI Digital — ${ondePix}.` }, p.fila);
      }
      // Sem os dados na fala: o mesmo caminho do botão do card (matrícula + cidade/UF dos documentos, ou o endereço do imóvel).
      const { previewCertidaoDosDocs } = require('./certidao-offer.service') as typeof import('./certidao-offer.service');
      const porEndereco = input?.porEndereco === true;
      const pv = await previewCertidaoDosDocs(accountId, l.id, { porEndereco });
      if (pv?.existe) return { naoPrecisa: `o ${l.name} já tem um pedido de certidão andando (veja na aba Financiamento do card)` };
      if (!pv?.possible) return { naoDaPraPedir: `não achei a matrícula nem o endereço completo do imóvel do ${l.name} nos documentos e no card`, falta: 'número da matrícula + cidade/UF do imóvel (o cartório é opcional), ou CEP, rua e número do imóvel', instrucao: 'Diga isso em 1 frase e peça a matrícula e a cidade; com elas chame pedir_certidao de novo. Não procure em outras ferramentas.' };
      return pendente({ accountId, userId, tipo: 'pedir_certidao_docs', params: { leadId: l.id, sendPix: !pixNoChat, porEndereco }, descricao: `Pedir a certidão ${/^pelo endere/.test(String(pv.matricula)) ? pv.matricula : `da matrícula nº ${pv.matricula}`} (${pv.cidade}/${pv.uf}) do ${l.name} no RI Digital — ${ondePix}.${pv.jaTemCertidao ? ' Atenção: o cliente já mandou uma certidão.' : ''}` }, p.fila);
    }
    default: return { erro: `ferramenta desconhecida: ${p.name}` };
  }
}

/** A pessoa confirmou (botão ou "sim"): executa pela rota da tela, com o login dela. */
export async function confirmPendingAction(p: { accountId: string; userId: string; token: string; id: string }): Promise<{ ok: true; resultado: string; call?: { leadId: string; leadName: string } }> {
  limpar();
  const a = pendentes.get(p.id);
  if (!a || a.accountId !== p.accountId || a.userId !== p.userId) throw new Error('Essa ação expirou ou não é sua. Peça de novo.');
  pendentes.delete(p.id);
  const x = a.params, x0 = a.params;
  switch (a.tipo) {
    case 'mover_pasta': {
      const x = await pastaDoCliente(a.accountId, x0.leadId);
      if (!x.area) throw new Error('a pasta saiu do lugar desde a pergunta');
      let destino = x.area.ativos, caminho = 'LEADS ATIVOS';
      if (x0.dest === 'FRIOS') { destino = x.area.frios!; caminho = 'LEADS FRIOS'; }
      if (x0.dest === 'CONCLUIDOS') { const { monthFolderFor } = require('./drive-lifecycle.service') as typeof import('./drive-lifecycle.service'); const m = await monthFolderFor(a.accountId, x.area.concluidos!, new Date()); destino = m.id; caminho = `CONCLUÍDOS / ${m.caminho}`; }
      await x.g.moveDriveItem(a.accountId, x.pasta, destino);
      await callApi(p.token, 'POST', '/notes', { leadId: x.l.id, content: `📁 Pasta movida pelo assistente para ${caminho} (${x.area.nome}). ${x.g.folderLink(x.pasta)}` }).catch(() => {});
      return { ok: true, resultado: `Pasta movida pra ${caminho}.` };
    }
    case 'ligar': return { ok: true, resultado: `Discando pro ${x0.leadName}…`, call: { leadId: x0.leadId, leadName: x0.leadName } };
    case 'pedir_permissao_ligacao': await callApi(p.token, 'POST', '/calls/permission-request', { leadId: x0.leadId }); return { ok: true, resultado: 'Pedido de permissão enviado; quando ele tocar em "Permitir" dá pra ligar.' };
    case 'agir_supervisao': {
      await callApi(p.token, 'POST', `/supervision/${x0.itemId}/${x0.modo}`, { text: x0.texto });
      return { ok: true, resultado: x0.modo === 'send' ? 'Mensagem enviada e o item saiu da lista.' : 'Template enviado; a mensagem sai quando o cliente responder.' };
    }
    case 'preencher_formulario': {
      const atual = await prisma.lead.findFirst({ where: { id: x0.leadId, accountId: a.accountId }, select: { customFields: true } });
      if (!atual) throw new Error('card não encontrado');
      const cf: Record<string, any> = { ...((atual.customFields || {}) as Record<string, any>) };
      for (const [k, v] of Object.entries(x0.mudar as Record<string, string>)) { if (v === '') delete cf[k]; else cf[k] = v; }
      await callApi(p.token, 'PUT', `/leads/${x0.leadId}`, { customFields: cf });
      return { ok: true, resultado: `Formulário preenchido (${Object.keys(x0.mudar).length} campo(s)).` };
    }
    case 'enviar_email': {
      await callApi(p.token, 'POST', `/email/accounts/${x0.caixaId}/send`, { to: x0.to, cc: x0.cc, subject: x0.subject, body: x0.body, replyToId: x0.replyToId, leadId: x0.leadId, attachments: x0.attachments });
      return { ok: true, resultado: 'E-mail enviado.' };
    }
    case 'alterar_regra_ia': {
      if (x0.acao === 'CRIAR') await callApi(p.token, 'POST', '/knowledge/entries', { title: x0.titulo, content: x0.conteudo, departmentId: x0.departmentId });
      else if (x0.acao === 'EDITAR') await callApi(p.token, 'PUT', `/knowledge/entries/${x0.id}`, { title: x0.titulo, content: x0.conteudo, departmentId: x0.departmentId });
      else await callApi(p.token, 'DELETE', `/knowledge/entries/${x0.id}`);
      return { ok: true, resultado: x0.acao === 'CRIAR' ? 'Regra criada — a IA já usa a partir da próxima mensagem.' : x0.acao === 'EDITAR' ? 'Regra alterada — vale a partir da próxima mensagem.' : 'Regra apagada.' };
    }
    case 'enviar_mensagem': {
      if (await janelaAberta(x.leadId)) {
        await callApi(p.token, 'POST', '/messages', { leadId: x.leadId, content: x.texto, direction: 'OUTBOUND', channel: 'WHATSAPP' });
        return { ok: true, resultado: 'Mensagem enviada.' };
      }
      const l = await leadOf(a.accountId, x.leadId);
      const habit = /habita/i.test(l.pipeline?.department?.name || '');
      const nomeTpl = habit ? 'atualizacao_processo_habitacional' : 'atualizacao_processo_credito';
      const cf = (l.customFields || {}) as Record<string, any>;
      const w = String(cf.falando_com || cf.participante_1 || l.name || '').trim().split(/\s+/)[0] || '';
      const nome = w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : 'tudo bem';
      const corpo = `Oi ${nome}, tudo bem? Temos uma atualização sobre o seu processo de ${habit ? 'financiamento habitacional' : 'crédito com garantia de imóvel'}. Responda esta mensagem para que a gente possa te passar os detalhes.`;
      await callApi(p.token, 'POST', '/messages/send-template', { leadId: x.leadId, templateName: nomeTpl, language: 'pt_BR', bodyParams: [nome], previewText: corpo });
      const { queueOnReply } = require('./reply-pending.service') as typeof import('./reply-pending.service');
      await queueOnReply(prisma as any, { leadId: x.leadId, label: `assistente ${new Date().toISOString().slice(0, 16)}`, text: x.texto, noteText: '⏳ Assistente: template de atualização enviado; a mensagem sai quando o cliente responder.' });
      return { ok: true, resultado: 'Janela fechada: mandei o template de atualização, e a mensagem sai quando ele responder.' };
    }
    case 'mover_card': await callApi(p.token, 'PATCH', `/leads/${x.leadId}/stage`, { stageId: x.stageId }); return { ok: true, resultado: 'Card movido.' };
    case 'marcar_status': await callApi(p.token, 'PUT', `/leads/${x.leadId}`, x.body); return { ok: true, resultado: 'Status alterado.' };
    case 'rodar_analise': { const r = await callApi(p.token, 'POST', '/credit-analysis/requests', { leadIds: [x.leadId], banks: x.banks, kind: 'RUN' }); return { ok: true, resultado: `Análise pedida${r?.created ? ` (${r.created} na fila)` : ''}; a extensão roda com o Chrome aberto.` }; }
    case 'solicitar_vistoria': { const v = x.prev; await callApi(p.token, 'POST', '/vistorias/request', { leadId: x.leadId, to: v.to, cc: v.cc, subject: v.subject, body: v.body, replyToId: v.replyToId, attachDriveFileIds: v.ids }); return { ok: true, resultado: 'Pedido de vistoria enviado ao Inter.' }; }
    case 'enviar_onus_pos_registro': {
      const { enviarOnusPosRegistroInter } = require('./onus-pos-registro.service') as typeof import('./onus-pos-registro.service');
      const r = await enviarOnusPosRegistroInter({ accountId: a.accountId, leadId: x0.leadId, userId: a.userId, manual: true });
      if (!r.ok) throw new Error(`não enviei: ${r.motivo}`);
      return { ok: true, resultado: `Certidão (${r.anexo}) enviada a ${r.to}.` };
    }
    case 'rodar_financiamento': await callApi(p.token, 'POST', '/credit-analysis/fh-request', { leadId: x0.leadId, kind: 'RUN', banks: x0.banks }); return { ok: true, resultado: 'Financiamento pedido; as extensões rodam em seguida e o resultado entra no card.' };
    case 'marcar_pix_pago': await callApi(p.token, 'POST', `/certidoes/${x0.id}/paid`, {}); return { ok: true, resultado: 'PIX marcado como pago; a extensão do ONR vai buscar a certidão.' };
    case 'pedir_certidao_docs': await callApi(p.token, 'POST', '/certidoes/from-docs', { leadId: x0.leadId, sendPix: x0.sendPix !== false, porEndereco: x0.porEndereco === true }); return { ok: true, resultado: x0.sendPix === false ? 'Certidão pedida; quando o PIX sair (alguns minutos) você recebe um aviso — é só me pedir o PIX que eu mostro pra copiar.' : 'Certidão pedida; a extensão do ONR faz o pedido e o PIX vai pro cliente.' };
    case 'pedir_certidao': await callApi(p.token, 'POST', '/certidoes', x); return { ok: true, resultado: x.sendPix === false ? 'Certidão pedida; quando o PIX sair (alguns minutos) você recebe um aviso — é só me pedir o PIX que eu mostro pra copiar.' : 'Certidão pedida; a extensão do ONR faz o pedido e o PIX vai pro cliente.' };
    default: throw new Error('ação desconhecida');
  }
}

export function cancelPendingAction(accountId: string, userId: string, id: string) {
  const a = pendentes.get(id);
  if (a && a.accountId === accountId && a.userId === userId) pendentes.delete(id);
  return { ok: true };
}
