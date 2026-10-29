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
  // ── com confirmação ──
  { name: 'mover_pasta', description: 'PREPARA mover a pasta do cliente no Drive (confirmação antes). destino: ATIVOS (LEADS ATIVOS), FRIOS (LEADS FRIOS) ou CONCLUIDOS (CONCLUÍDOS/ano/mês de hoje). Fica na mesma área (Home Equity ou Habitação) onde a pasta já está.', input_schema: { type: 'object', properties: { leadId: { type: 'string' }, destino: { type: 'string', enum: ['ATIVOS', 'FRIOS', 'CONCLUIDOS'] } }, required: ['leadId', 'destino'] } },
  { name: 'enviar_email', description: 'PREPARA um e-mail pela caixa comercial do CRM (confirmação antes). Se tiver leadId e já houver e-mail desse destinatário no cliente, responde no MESMO fio. anexos = nomes (ou parte do nome) de arquivos da pasta do cliente no Drive (use ver_pasta antes). Escreva como a A&F escreve: cordial, objetivo, com saudação e "Atenciosamente".', input_schema: { type: 'object', properties: { para: { type: 'string' }, cc: { type: 'string' }, assunto: { type: 'string' }, texto: { type: 'string' }, leadId: { type: 'string' }, anexos: { type: 'array', items: { type: 'string' } } }, required: ['para', 'assunto', 'texto'] } },
  { name: 'alterar_regra_ia', description: 'PREPARA uma mudança nas REGRAS da IA (Base de Conhecimento) — é assim que se muda o comportamento da IA do CRM sem mexer no código (confirmação antes). acao: CRIAR (titulo+conteudo), EDITAR (id+conteudo, titulo opcional), APAGAR (id). setor: "Home Equity", "Habitação" ou "todos" (padrão: o da regra, ou todos). Use ver_regras_ia antes pra não duplicar; prefira EDITAR a regra que já existe.', input_schema: { type: 'object', properties: { acao: { type: 'string', enum: ['CRIAR', 'EDITAR', 'APAGAR'] }, id: { type: 'string' }, titulo: { type: 'string' }, conteudo: { type: 'string' }, setor: { type: 'string' } }, required: ['acao'] } },
  { name: 'enviar_mensagem', description: 'PREPARA uma mensagem de WhatsApp pro cliente (só sai depois que a pessoa confirmar). Se a janela de 24 h estiver fechada, o envio vira o template de atualização do processo + a mensagem guardada pra sair quando o cliente responder.', input_schema: { type: 'object', properties: { leadId: { type: 'string' }, texto: { type: 'string' } }, required: ['leadId', 'texto'] } },
  { name: 'mover_card', description: 'PREPARA a mudança de etapa do card (confirmação antes). etapa = nome da etapa; funil opcional (se a etapa for de outro funil).', input_schema: { type: 'object', properties: { leadId: { type: 'string' }, etapa: { type: 'string' }, funil: { type: 'string' } }, required: ['leadId', 'etapa'] } },
  { name: 'marcar_status', description: 'PREPARA marcar o card como GANHO, PERDIDO, REPROVADO (perdido por reprovação do banco) ou REABRIR (confirmação antes). motivo é obrigatório pra PERDIDO/REPROVADO.', input_schema: { type: 'object', properties: { leadId: { type: 'string' }, status: { type: 'string', enum: ['GANHO', 'PERDIDO', 'REPROVADO', 'REABRIR'] }, motivo: { type: 'string' } }, required: ['leadId', 'status'] } },
  { name: 'rodar_analise', description: 'PREPARA rodar a análise de crédito nos bancos (cria proposta nova no portal; confirmação antes). bancos: INTER, CREDITAS, CREDIMORAR (Santander).', input_schema: { type: 'object', properties: { leadId: { type: 'string' }, bancos: { type: 'array', items: { type: 'string' } } }, required: ['leadId', 'bancos'] } },
  { name: 'solicitar_vistoria', description: 'PREPARA o pedido de vistoria ao Inter: responde o e-mail do consultor com o contato e os documentos do imóvel da pasta do cliente (confirmação antes).', input_schema: { type: 'object', properties: { leadId: { type: 'string' } }, required: ['leadId'] } },
  { name: 'pedir_certidao', description: 'PREPARA o pedido da certidão de matrícula (inteiro teor) no RI Digital pela extensão; o PIX vai pro cliente (confirmação antes). cartorio como aparece no portal (ex.: "02º - BELÉM").', input_schema: { type: 'object', properties: { leadId: { type: 'string' }, uf: { type: 'string' }, cidade: { type: 'string' }, cartorio: { type: 'string' }, matricula: { type: 'string' } }, required: ['leadId', 'uf', 'cidade', 'cartorio', 'matricula'] } },
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
export async function runActionTool(p: { accountId: string; userId: string; token: string; name: string; input: any; fila: PendingAction[]; nav: ScreenNav[] }): Promise<unknown> {
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
      const mesmoFunil = c.filter((s) => s.pipeline.id === l.pipeline?.id);
      if (mesmoFunil.length === 1) c = mesmoFunil;
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
    case 'pedir_certidao': {
      const l = await leadOf(accountId, input?.leadId);
      const params = { leadId: l.id, uf: String(input?.uf || '').toUpperCase(), cidade: String(input?.cidade || ''), cartorio: String(input?.cartorio || ''), matricula: String(input?.matricula || '').replace(/\D/g, ''), sendPix: true };
      return pendente({ accountId, userId, tipo: 'pedir_certidao', params, descricao: `Pedir a certidão de matrícula nº ${params.matricula} (${params.cartorio}/${params.uf}) do ${l.name} no RI Digital — o PIX da certidão vai pro cliente.` }, p.fila);
    }
    default: return { erro: `ferramenta desconhecida: ${p.name}` };
  }
}

/** A pessoa confirmou (botão ou "sim"): executa pela rota da tela, com o login dela. */
export async function confirmPendingAction(p: { accountId: string; userId: string; token: string; id: string }): Promise<{ ok: true; resultado: string }> {
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
    case 'pedir_certidao': await callApi(p.token, 'POST', '/certidoes', x); return { ok: true, resultado: 'Certidão pedida; a extensão do ONR faz o pedido e o PIX vai pro cliente.' };
    default: throw new Error('ação desconhecida');
  }
}

export function cancelPendingAction(accountId: string, userId: string, id: string) {
  const a = pendentes.get(id);
  if (a && a.accountId === accountId && a.userId === userId) pendentes.delete(id);
  return { ok: true };
}
