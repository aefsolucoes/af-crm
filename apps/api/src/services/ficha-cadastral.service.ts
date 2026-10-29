import { prisma } from '../lib/prisma';
import { logActivity } from './activity.service';

/* FICHA DE CADASTRO (Fabio 29/10): "os dados devem vir dos documentos do cliente, o CRM deve gravar esses dados do cadastro em anotações para puxar de lá as
 * informações que deverá colocar no cadastro, ela puxa esses dados da pasta do cliente no Drive". Base do cadastro dos participantes na CAIXA (Caixa Aqui:
 * Oportunidades de Negócios → Cadastro de Clientes → análise) e no BRB (PCN).
 *  - Lê os documentos PESSOAIS da pasta do cliente no Drive (`link_pasta_drive`): COMPRADOR e soltos na raiz; IMÓVEL, VENDEDOR e MINUTA ficam de fora.
 *  - Cada arquivo é lido sozinho (o que está escrito, nunca inventado); depois uma consolidação junta por pessoa, aponta o que falta e o que diverge.
 *  - Grava `_fichaCadastral` no card (o que a extensão lê) e uma ANOTAÇÃO legível com os mesmos dados. Telefone/e-mail vêm do card (documento não tem).
 *  - Roda sozinho quando o card chega em "Documentação Recebida" (uma vez) e pelo botão/rota (POST /api/leads/:id/ficha-cadastral) quando chegar documento novo. */

type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | null | undefined;
type Arquivo = { id: string; name: string; mimeType: string; path: string; size: number };

const MODELO = 'claude-sonnet-5';
const MAX_ARQUIVOS = 30;
const MAX_PDF = 20_000_000;
const MAX_IMG = 4_500_000; // a API recusa imagem acima de 5 MB — maior que isso vai pelo OCR do Drive

const SYSTEM_DOC = `Você lê UM documento pessoal de cliente de crédito imobiliário no Brasil (RG, CNH, certidão de casamento/nascimento, comprovante de residência, contracheque/holerite, carteira de trabalho, declaração de imposto de renda, extrato do FGTS/PIS, documento de empresa etc.). Extraia SÓ o que está escrito — nunca deduza, calcule ou invente. Campo que o documento não mostra = null.
Responda SOMENTE com JSON:
{"tipo":"<RG|CNH|CERTIDAO DE CASAMENTO|CERTIDAO DE NASCIMENTO|COMPROVANTE DE RESIDENCIA|CONTRACHEQUE|CARTEIRA DE TRABALHO|IMPOSTO DE RENDA|EXTRATO FGTS|DOCUMENTO DO IMOVEL|OUTRO>",
"pessoas":[{"nome":null,"cpf":null,"nascimento":"dd/mm/aaaa","sexo":"M|F|null","nacionalidade":null,"naturalidade":{"cidade":null,"uf":null},
"rg":{"numero":null,"orgao":null,"uf":null,"emissao":"dd/mm/aaaa"},"cnh":{"numero":null,"validade":"dd/mm/aaaa","orgao":null,"uf":null},
"mae":null,"pai":null,"estadoCivil":null,"regimeBens":null,"dataCasamento":"dd/mm/aaaa","conjuge":{"nome":null,"cpf":null},
"endereco":{"logradouro":null,"numero":null,"complemento":null,"bairro":null,"cidade":null,"uf":null,"cep":null},
"pis":null,"ctps":{"numero":null,"serie":null},"profissao":null,"escolaridade":null,
"empregador":{"nome":null,"cnpj":null},"cargo":null,"admissao":"dd/mm/aaaa","competencia":"mm/aaaa","rendaBruta":null,"rendaLiquida":null,
"outrasRendas":[{"tipo":"aposentadoria|pensao|aluguel|outra","valor":null}],"patrimonioTotal":null}],
"observacao":"<1 frase: o que é o documento e qualquer ponto de atenção (ilegível, vencido, cortado, de outra pessoa)>"}
Regras: uma entrada em "pessoas" por pessoa que o documento identifica como titular (certidão de casamento = os DOIS cônjuges, com estadoCivil "CASADO(A)", o regime e a data do casamento; o nome de cada um pode mudar com o casamento — use o nome que a certidão diz que passou a usar). Comprovante de residência: a pessoa é o titular da conta e o endereço é o da conta. Contracheque: rendaBruta = total de vencimentos/proventos, rendaLiquida = líquido a receber, competencia = mês de referência. Datas sempre dd/mm/aaaa; valores em reais como número puro (ex.: 12296.77); CPF e CEP só com os dígitos.`;

const SYSTEM_JUNTA = `Você monta a FICHA DE CADASTRO dos participantes de uma operação de crédito imobiliário juntando as leituras de vários documentos (cada leitura diz de qual arquivo veio). Use SÓ o que as leituras trazem — nunca invente. Quando dois documentos discordam, fique com o mais confiável pro campo (identidade/filiação/naturalidade: RG ou CNH; estado civil/regime/data do casamento/nome de casado: certidão de casamento; endereço: o comprovante de residência mais recente; trabalho e renda: contracheques mais recentes e carteira de trabalho; PIS: carteira de trabalho ou contracheque; patrimônio: imposto de renda) e registre a divergência em "conflitos".
Os participantes da operação vêm em PARTICIPANTES DO CARD (nome e CPF digitados na proposta — servem só pra saber quem é quem; o dado da ficha é o do documento). Ignore pessoas que não são participantes (ex.: vendedor do imóvel, dono da conta de luz que não é participante — nesse caso diga em "conflitos" que o comprovante está em nome de outra pessoa). Cônjuge que não é participante aparece só dentro de "conjuge".
Responda SOMENTE com JSON:
{"participantes":[{"ordem":1,"nome":null,"cpf":null,"nascimento":null,"sexo":null,"nacionalidade":null,"naturalidade":{"cidade":null,"uf":null},
"identidade":{"tipo":"RG|CNH","numero":null,"orgao":null,"uf":null,"emissao":null},"mae":null,"pai":null,
"estadoCivil":null,"regimeBens":null,"dataCasamento":null,"conjuge":{"nome":null,"cpf":null},
"endereco":{"logradouro":null,"numero":null,"complemento":null,"bairro":null,"cidade":null,"uf":null,"cep":null},
"pis":null,"profissao":null,"escolaridade":null,
"trabalho":{"vinculo":"CLT|SERVIDOR PUBLICO|AUTONOMO|EMPRESARIO|APOSENTADO|OUTRO|null","empregador":null,"cnpj":null,"cargo":null,"admissao":null},
"contracheques":[{"competencia":null,"empregador":null,"bruto":null,"liquido":null}],"rendaBrutaMensal":null,"rendaLiquidaMensal":null,
"outrasRendas":[{"tipo":null,"valor":null}],"patrimonioTotal":null,
"fontes":{"<campo>":"<nome do arquivo>"},"faltando":["<campo que nenhum documento trouxe e o cadastro do banco pede>"]}],
"conflitos":["<divergência entre documentos ou entre documento e card, em 1 frase>"],"observacao":"<1 frase>"}
rendaBrutaMensal/rendaLiquidaMensal = do mês mais recente (se a pessoa tem DOIS empregos com contracheque do mesmo mês, some os dois). "faltando" considera: identidade (número, órgão, UF, emissão), naturalidade, filiação, estado civil, endereço com CEP, PIS, empregador/cargo/admissão e renda. Datas dd/mm/aaaa; valores número puro; CPF/CEP só dígitos.`;

const norm = (s: string) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const brl = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : null; };
const cpfFmt = (v: unknown) => { const d = String(v ?? '').replace(/\D/g, ''); return d.length === 11 ? d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4') : (d || null); };
const cepFmt = (v: unknown) => { const d = String(v ?? '').replace(/\D/g, ''); return d.length === 8 ? d.replace(/(\d{5})(\d{3})/, '$1-$2') : (d || null); };

async function chamarIA(system: string, content: any[], maxTokens: number): Promise<any | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODELO, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] }),
    }).catch(() => null);
    if (!res || !res.ok) { console.error('[Ficha cadastral] Anthropic', res?.status, res ? (await res.text()).slice(0, 200) : ''); continue; }
    const data = (await res.json()) as { content: { type: string; text?: string }[] };
    const raw = data.content?.find((b) => b.type === 'text')?.text || '';
    try { return JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || ''); } catch { /* JSON cortado: tenta de novo */ }
  }
  return null;
}

/** Documentos pessoais da pasta: COMPRADOR (se existir) + soltos na raiz; nunca IMÓVEL/VENDEDOR/MINUTA. */
function arquivosPessoais(todos: Arquivo[]): Arquivo[] {
  const temComprador = todos.some((f) => /comprador/.test(norm(f.path)));
  return todos
    .filter((f) => /pdf|^image\//.test(f.mimeType))
    .filter((f) => !/imovel|vendedor|minuta|contrato|vistoria|laudo/.test(norm(f.path)))
    .filter((f) => !temComprador || !f.path || /comprador/.test(norm(f.path)))
    .filter((f) => !/matricula|iptu|escritura|onus|habite|simulac|minuta|boleto/.test(norm(f.name)))
    .slice(0, MAX_ARQUIVOS);
}

async function lerArquivo(accountId: string, f: Arquivo): Promise<any | null> {
  const google = await import('./google.service');
  const ehPdf = f.mimeType === 'application/pdf';
  let content: any[];
  try {
    if (ehPdf && f.size <= MAX_PDF) {
      const buf = await google.downloadDriveFile(accountId, f.id, f.mimeType);
      content = [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } }];
    } else {
      const { buffer, mimeType } = ehPdf ? { buffer: Buffer.alloc(0), mimeType: f.mimeType } : await google.downloadDriveFileForVision(accountId, f.id, f.mimeType);
      if (!ehPdf && buffer.length <= MAX_IMG && ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mimeType)) {
        content = [{ type: 'image', source: { type: 'base64', media_type: mimeType, data: buffer.toString('base64') } }];
      } else {
        const texto = await google.ocrDriveFileToText(accountId, f.id); // grande demais / formato que a IA não lê: vai pelo texto
        if (!texto.trim()) return null;
        content = [{ type: 'text', text: texto.slice(0, 150_000) }];
      }
    }
  } catch (e: any) { console.error('[Ficha cadastral] download', f.name, e?.message); return null; }
  content.push({ type: 'text', text: `Arquivo: ${f.path ? `${f.path} > ` : ''}${f.name}` });
  return chamarIA(SYSTEM_DOC, content, 8192);
}

function linhaParticipante(p: any, card: { telefone?: string; email?: string }): string {
  const L: string[] = [];
  const add = (rot: string, v: unknown) => { if (v !== null && v !== undefined && String(v).trim()) L.push(`• ${rot}: ${v}`); };
  add('CPF', cpfFmt(p.cpf));
  add('Nascimento', p.nascimento);
  add('Sexo', p.sexo === 'M' ? 'Masculino' : p.sexo === 'F' ? 'Feminino' : p.sexo);
  const id = p.identidade || {};
  if (id.numero) add('Identidade', `${id.tipo || 'RG'} nº ${id.numero}${id.orgao ? ` — ${id.orgao}${id.uf ? `/${id.uf}` : ''}` : ''}${id.emissao ? ` — emissão ${id.emissao}` : ''}`);
  const nat = p.naturalidade || {};
  add('Naturalidade', [nat.cidade, nat.uf].filter(Boolean).join('/') || null);
  add('Nacionalidade', p.nacionalidade);
  add('Mãe', p.mae);
  add('Pai', p.pai);
  const conj = p.conjuge || {};
  add('Estado civil', [p.estadoCivil, p.regimeBens && `regime ${p.regimeBens}`, p.dataCasamento && `casamento em ${p.dataCasamento}`, conj.nome && `cônjuge ${conj.nome}${conj.cpf ? ` (CPF ${cpfFmt(conj.cpf)})` : ''}`].filter(Boolean).join(' — ') || null);
  const e = p.endereco || {};
  add('Endereço', [e.logradouro && `${e.logradouro}${e.numero ? `, ${e.numero}` : ''}`, e.complemento, e.bairro, [e.cidade, e.uf].filter(Boolean).join('/'), e.cep && `CEP ${cepFmt(e.cep)}`].filter(Boolean).join(' — ') || null);
  add('Telefone (card)', card.telefone);
  add('E-mail (card)', card.email);
  add('PIS', p.pis);
  add('Profissão', p.profissao);
  add('Escolaridade', p.escolaridade);
  const t = p.trabalho || {};
  add('Trabalho', [t.vinculo, t.empregador && `${t.empregador}${t.cnpj ? ` (CNPJ ${t.cnpj})` : ''}`, t.cargo && `cargo ${t.cargo}`, t.admissao && `admissão ${t.admissao}`].filter(Boolean).join(' — ') || null);
  const chs = Array.isArray(p.contracheques) ? p.contracheques.filter((c: any) => c && (c.bruto || c.liquido)) : [];
  if (chs.length) add('Contracheques', chs.map((c: any) => `${c.competencia || '?'}${c.empregador ? ` ${c.empregador}` : ''}: bruto ${brl(c.bruto) || '—'} / líquido ${brl(c.liquido) || '—'}`).join('; '));
  add('Renda mensal', [brl(p.rendaBrutaMensal) && `bruta ${brl(p.rendaBrutaMensal)}`, brl(p.rendaLiquidaMensal) && `líquida ${brl(p.rendaLiquidaMensal)}`].filter(Boolean).join(' / ') || null);
  const outras = Array.isArray(p.outrasRendas) ? p.outrasRendas.filter((o: any) => o && brl(o.valor)) : [];
  if (outras.length) add('Outras rendas', outras.map((o: any) => `${o.tipo || 'outra'} ${brl(o.valor)}`).join('; '));
  add('Patrimônio (IR)', brl(p.patrimonioTotal));
  if (Array.isArray(p.faltando) && p.faltando.length) L.push(`⚠️ Não achei nos documentos: ${p.faltando.join(', ')}`);
  return L.join('\n');
}

const emAndamento = new Set<string>();

/** Lê a pasta do Drive do cliente e grava a ficha (customFields `_fichaCadastral` + anotação). Devolve a mensagem de erro, ou null quando gravou. */
export async function gerarFichaCadastral(accountId: string, leadId: string, opts: { userId?: string | null; io?: Io } = {}): Promise<string | null> {
  if (!process.env.ANTHROPIC_API_KEY) return 'IA indisponível';
  if (emAndamento.has(leadId)) return 'A ficha deste cliente já está sendo lida';
  emAndamento.add(leadId);
  try {
    const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { id: true, name: true, customFields: true } });
    if (!lead) return 'Lead não encontrado';
    const cf = (lead.customFields || {}) as Record<string, any>;
    const link = String(cf.link_pasta_drive || '').trim();
    if (!link) return 'O card não tem a pasta do Drive';
    const google = await import('./google.service');
    const todos = await google.listAllFilesInFolderTree(accountId, google.extractFolderId(link), 3);
    const arquivos = arquivosPessoais(todos);
    if (!arquivos.length) return 'Não achei documento pessoal (PDF/foto) na pasta do Drive';

    // 1) Cada arquivo sozinho, 4 de cada vez.
    const leituras: { arquivo: string; leitura: any }[] = [];
    const naoLidos: string[] = [];
    for (let i = 0; i < arquivos.length; i += 4) {
      const lote = arquivos.slice(i, i + 4);
      const r = await Promise.all(lote.map((f) => lerArquivo(accountId, f).catch(() => null)));
      r.forEach((leitura, k) => { if (leitura && Array.isArray(leitura.pessoas)) leituras.push({ arquivo: lote[k].name, leitura }); else naoLidos.push(lote[k].name); });
    }
    const pessoais = leituras.filter((x) => !/DOCUMENTO DO IMOVEL/i.test(String(x.leitura.tipo || '')));
    if (!pessoais.length) return 'Não consegui ler nenhum documento pessoal da pasta';

    // 2) Junta por participante.
    const participantesCard = [1, 2, 3].map((n) => ({ ordem: n, nome: cf[`participante_${n}`] || null, cpf: String(cf[`cpf_${n}`] || '').replace(/\D/g, '') || null })).filter((p) => p.nome || p.cpf);
    const ficha = await chamarIA(SYSTEM_JUNTA, [{ type: 'text', text: `PARTICIPANTES DO CARD:\n${JSON.stringify(participantesCard)}\n\nLEITURAS DOS DOCUMENTOS:\n${JSON.stringify(pessoais).slice(0, 180_000)}` }], 16000);
    if (!ficha || !Array.isArray(ficha.participantes) || !ficha.participantes.length) return 'Não consegui montar a ficha com as leituras';

    const agora = new Date();
    const registro = { at: agora.toISOString(), participantes: ficha.participantes, conflitos: Array.isArray(ficha.conflitos) ? ficha.conflitos : [], observacao: String(ficha.observacao || ''), arquivos: pessoais.map((x) => ({ nome: x.arquivo, tipo: x.leitura.tipo })), naoLidos };
    const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
    await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...((fresh?.customFields || {}) as Record<string, unknown>), _fichaCadastral: registro } as any } });

    const quando = agora.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }).slice(0, 17);
    const blocos = ficha.participantes.map((p: any, i: number) => {
      const n = Number(p.ordem) || i + 1;
      return `👤 ${n}º participante: ${p.nome || '—'}\n${linhaParticipante(p, { telefone: cf[`telefone_${n}`] || undefined, email: cf[`email_${n}`] || undefined })}`;
    });
    const conflitos = registro.conflitos.length ? `\n\n⚠️ Divergências:\n${registro.conflitos.map((c: string) => `• ${c}`).join('\n')}` : '';
    const lidos = `\n\n📁 Lidos (${pessoais.length}): ${pessoais.map((x) => `${x.arquivo} (${x.leitura.tipo})`).join('; ')}${naoLidos.length ? `\n⛔ Não consegui ler: ${naoLidos.join('; ')}` : ''}`;
    await prisma.note.create({ data: { leadId, userId: opts.userId || null, type: 'COMMENT', content: `📋 FICHA DE CADASTRO — lida dos documentos da pasta do Drive em ${quando}. É daqui que sai o cadastro na CAIXA e no BRB.\n\n${blocos.join('\n\n')}${conflitos}${lidos}` } });
    opts.io?.to(`lead:${leadId}`).emit('lead_updated', { leadId });
    logActivity({ accountId, userId: opts.userId || null, userName: opts.userId ? undefined : 'Assistente IA', action: 'lead_note_added', leadId, leadName: lead.name, summary: 'gravou a ficha de cadastro lida dos documentos do Drive' });
    console.log(`[Ficha cadastral] ${lead.name}: ${ficha.participantes.length} participante(s), ${pessoais.length} arquivo(s)`);
    return null;
  } finally {
    emAndamento.delete(leadId);
  }
}

/** Card que chegou em "Documentação Recebida" (funis Em contratação) com a pasta do Drive e ainda sem ficha → lê. Um por rodada do poller.
 *  Por SQL: filtro de JSON do Prisma com NOT dá NULL em card sem a chave e some com a linha (ver fila parada de 15/10). */
export async function processFichasCadastrais(accountId: string, io?: Io): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY || emAndamento.size >= 2) return;
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT l.id FROM "Lead" l JOIN "Stage" s ON s.id = l."stageId" JOIN "Pipeline" p ON p.id = l."pipelineId"
    WHERE l."accountId" = ${accountId} AND l.status = 'OPEN' AND l.archived = false AND l."isGroup" = false
      AND s.name ILIKE '%Documentação Recebida%' AND p.name ILIKE 'Em contratação%'
      AND COALESCE(l."customFields"->>'link_pasta_drive', '') LIKE 'http%' AND l."customFields"->'_fichaCadastral' IS NULL
      AND COALESCE(l."customFields"->>'_fichaCadastralErro', '') < ${new Date(Date.now() - 6 * 3600_000).toISOString()}
    ORDER BY l."stageEnteredAt" ASC NULLS LAST LIMIT 1`;
  if (!ids[0] || emAndamento.has(ids[0].id)) return;
  // Sem esperar: a leitura leva minutos e o poller tem as outras rotinas da mesma rodada (emAndamento segura a repetição).
  rodar(accountId, ids[0].id, io).catch((e) => console.error('[Ficha cadastral]', e?.message));
}

async function rodar(accountId: string, leadId: string, io: Io): Promise<void> {
  const erro = await gerarFichaCadastral(accountId, leadId, { io }).catch((e: any) => e?.message || 'erro');
  if (!erro) return;
  // Sem pasta/sem documento: tenta de novo em 6 h (não fica lendo o Drive a cada minuto).
  const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...((fresh?.customFields || {}) as Record<string, unknown>), _fichaCadastralErro: new Date().toISOString() } as any } }).catch(() => {});
  console.log(`[Ficha cadastral] ${leadId}: ${erro}`);
}
