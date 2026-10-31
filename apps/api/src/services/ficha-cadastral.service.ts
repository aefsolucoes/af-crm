import { prisma } from '../lib/prisma';
import { logActivity } from './activity.service';

/* FICHA DE CADASTRO (Fabio 29/10): "os dados devem vir dos documentos do cliente, o CRM deve gravar esses dados do cadastro em anotações para puxar de lá as
 * informações que deverá colocar no cadastro, ela puxa esses dados da pasta do cliente no Drive". Base do cadastro dos participantes na CAIXA (Caixa Aqui:
 * Oportunidades de Negócios → Cadastro de Clientes → análise) e no BRB (PCN).
 *  - Lê os documentos PESSOAIS da pasta do cliente no Drive (`link_pasta_drive`): COMPRADOR e soltos na raiz; IMÓVEL, VENDEDOR e MINUTA ficam de fora.
 *    Sem pasta: os anexos que o cliente mandou na conversa (Fabio 31/10).
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
{"tipo":"<RG|CNH|CERTIDAO DE CASAMENTO|CERTIDAO DE NASCIMENTO|COMPROVANTE DE RESIDENCIA|CONTRACHEQUE|CARTEIRA DE TRABALHO|IMPOSTO DE RENDA|EXTRATO FGTS|EXTRATO BANCARIO|DOCUMENTO DO IMOVEL|OUTRO>",
"pessoas":[{"nome":null,"cpf":null,"nascimento":"dd/mm/aaaa","sexo":"M|F|null","nacionalidade":null,"naturalidade":{"cidade":null,"uf":null},
"rg":{"numero":null,"orgao":null,"uf":null,"emissao":"dd/mm/aaaa"},"cnh":{"numero":null,"emissao":"dd/mm/aaaa","validade":"dd/mm/aaaa","primeiraHabilitacao":"dd/mm/aaaa","orgao":null,"uf":null},
"mae":null,"pai":null,"estadoCivil":null,"regimeBens":null,"dataCasamento":"dd/mm/aaaa","conjuge":{"nome":null,"cpf":null},
"endereco":{"logradouro":null,"numero":null,"complemento":null,"bairro":null,"cidade":null,"uf":null,"cep":null,"comprovanteMesAno":"mm/aaaa"},
"pis":null,"ctps":{"numero":null,"serie":null},"profissao":null,"escolaridade":null,
"empregador":{"nome":null,"cnpj":null},"cargo":null,"admissao":"dd/mm/aaaa","competencia":"mm/aaaa","rendaBruta":null,"rendaLiquida":null,"irRetido":null,"tipoRenda":"salario|aposentadoria|pensao|null","inicioBeneficio":null,"verbasEventuais":[{"descricao":null,"valor":null}],
"fontesPagadoras":[{"nome":null,"cnpj":null}],"lucrosDividendos":[{"fonte":null,"cnpj":null,"valorAnual":null}],"anoCalendario":null,"contratos":[{"empregador":null,"cnpj":null,"cargo":null,"admissao":null,"saida":null}],
"outrasRendas":[{"tipo":"aposentadoria|pensao|aluguel|outra","valor":null}],"patrimonioTotal":null}],
"observacao":"<1 frase: o que é o documento e qualquer ponto de atenção (ilegível, vencido, cortado, de outra pessoa)>"}
Regras: uma entrada em "pessoas" por pessoa que o documento identifica como titular (certidão de casamento = os DOIS cônjuges, com estadoCivil "CASADO(A)", o regime e a data do casamento; o nome de cada um pode mudar com o casamento — use o nome que a certidão diz que passou a usar). CNH: cnh.numero = Nº REGISTRO da CNH (11 dígitos — não o número do espelho/formulário), cnh.orgao = órgão emissor da CNH (DETRAN), cnh.uf = UF da CNH, cnh.emissao = DATA DE EMISSÃO da CNH, cnh.validade = VALIDADE, cnh.primeiraHabilitacao = data da 1ª HABILITAÇÃO; o RG que aparece impresso na CNH vai em "rg". Comprovante de residência: a pessoa é o titular da conta, o endereço é o da conta e endereco.comprovanteMesAno = mês/ano de referência da conta (mm/aaaa). Contracheque/demonstrativo de benefício: competencia = mês de referência; rendaBruta = SÓ as verbas que se repetem todo mês (salário, adicionais fixos, suplemento/benefício mensal) — verba EVENTUAL (saque ou resgate de plano de previdência, férias e 1/3, 13º, rescisão, PLR, adiantamento) NÃO é renda: vai em "verbasEventuais" e fica fora da rendaBruta; rendaLiquida = líquido a receber SEM a verba eventual (desconte só os descontos regulares; imposto em percentual sobre o total = o mesmo percentual sobre a renda recorrente) — sem verba eventual, é o líquido a receber (Fabio 30/10: suplemento de aposentadoria R$ 1.390,85 + saque do plano R$ 12.272,23 não é renda de R$ 13.663,08). irRetido = desconto de IMPOSTO DE RENDA RETIDO NA FONTE (IRRF) do mês (só a parte da renda recorrente quando há verba eventual; sem esse desconto = null) — Fabio 30/10: a CAIXA tem o campo e ele precisa ir preenchido. Aposentadoria/benefício: "tipoRenda":"aposentadoria", "inicioBeneficio" = data de início do benefício se o documento mostrar. Imposto de renda: liste em "fontesPagadoras" cada fonte de "rendimentos tributáveis recebidos de pessoa jurídica" com nome e CNPJ; em "lucrosDividendos" cada empresa de "Lucros e dividendos recebidos" (rendimentos isentos, do TITULAR — não os de dependente) com nome, CNPJ e valor do ano; "anoCalendario" = ano-calendário da declaração; carteira de trabalho: liste em "contratos" cada contrato (empregador, CNPJ do estabelecimento, cargo, admissão, saída ou null se ativo). Datas sempre dd/mm/aaaa; valores em reais como número puro (ex.: 12296.77); CPF e CEP só com os dígitos.`;

const SYSTEM_JUNTA = `Você monta a FICHA DE CADASTRO dos participantes de uma operação de crédito imobiliário juntando as leituras de vários documentos (cada leitura diz de qual arquivo veio). Use SÓ o que as leituras trazem — nunca invente. IDENTIDADE = O DOCUMENTO APRESENTADO (Fabio 29/10): se a pessoa apresentou CNH, a identidade é a CNH — tipo "CNH", número = Nº REGISTRO da CNH, órgão/UF/emissão da CNH — mesmo que a CNH traga também o número do RG; RG só quando não há CNH. CNH VENCIDA NÃO É PROBLEMA pro cadastro: não aponte em conflitos nem em faltando.
Quando dois documentos discordam, fique com o mais confiável pro campo (filiação/naturalidade: o documento de identidade apresentado; estado civil/regime/data do casamento/nome de casado: certidão de casamento; endereço: o comprovante de residência mais recente; trabalho e renda: contracheques mais recentes e carteira de trabalho; PIS: carteira de trabalho ou contracheque; patrimônio: imposto de renda) e registre a divergência em "conflitos".
Os participantes da operação vêm em PARTICIPANTES DO CARD (nome e CPF digitados na proposta — servem só pra saber quem é quem; o dado da ficha é o do documento). Ignore pessoas que não são participantes (ex.: vendedor do imóvel, dono da conta de luz que não é participante — nesse caso diga em "conflitos" que o comprovante está em nome de outra pessoa). Cônjuge que não é participante aparece só dentro de "conjuge".
ENDEREÇO: participante sem comprovante de residência próprio que é CÔNJUGE do 1º participante ou compõe renda usa o endereço do comprovante do 1º participante (fonte "comprovante do 1º participante") — não é falta.
SEM RENDA: participante sem nenhum documento de renda (contracheque, IR, extrato de benefício, extrato bancário) fica com "semRenda": true, renda e trabalho null — no cadastro do banco ele entra como SEM RENDA; não liste trabalho/renda em "faltando".
RENDA INFORMAL (Fabio 29/10): participante SEM comprovante formal (nenhum contracheque, IR, CTPS ativa ou extrato de benefício) que trouxe APENAS extrato bancário fica com "rendaInformal": true e "semRenda": false — no cadastro da CAIXA a renda formal vai SEM RENDA e a informal R$ 3.000.
RENDAS (Fabio 30/10): um item em "contracheques" por CONTRACHEQUE lido (cada mês de cada fonte pagadora — o cadastro escolhe, por fonte, o válido de maior recebimento), com a renda RECORRENTE do mês (verba eventual — saque/resgate de plano, férias, 13º, rescisão — nunca entra), "cargo" e "admissao" DAQUELA fonte (carteira de trabalho/contracheque dela; aposentadoria: "tipo":"aposentadoria", cargo null e admissao = data de início do benefício se algum documento mostrar). SÓCIO/EMPRESÁRIO (Fabio 31/10: a CAIXA não aceita pró-labore nem DECORE): sem contracheque e com "lucrosDividendos" no imposto de renda, a renda é a DISTRIBUIÇÃO DE LUCROS ÷ 12 — um item em "contracheques" por empresa com "tipo":"lucros", empregador = a empresa, cnpj, bruto = liquido = valorAnual ÷ 12 (2 casas), cargo "DIRETOR DE EMPRESAS", competencia "12/<anoCalendario>", admissao null (o CRM busca a entrada na sociedade pelo CNPJ), irRetido null; trabalho = vinculo "EMPRESARIO" + a empresa de maior lucro (empregador/cnpj, cargo "DIRETOR DE EMPRESAS"); nesse caso empregador/cargo/admissão NÃO vão em "faltando" (só o CNPJ, se o IR não trouxer). Contracheque SEM CNPJ: pegue o CNPJ da mesma fonte no IMPOSTO DE RENDA ("fontesPagadoras") ou na CARTEIRA DE TRABALHO ("contratos"), pelo nome; ainda sem → "faltando": "CNPJ de <fonte>". Aposentadoria sem data de início → "faltando": "data de início do benefício (<fonte>)".
PIS: preencha só se algum documento trouxer. Só entra em "faltando" quando USA FGTS = sim.
Responda SOMENTE com JSON:
{"participantes":[{"ordem":1,"nome":null,"cpf":null,"nascimento":null,"sexo":null,"nacionalidade":null,"naturalidade":{"cidade":null,"uf":null},
"identidade":{"tipo":"RG|CNH","numero":null,"orgao":null,"uf":null,"emissao":null,"validade":null,"primeiraHabilitacao":null},"mae":null,"pai":null,
"estadoCivil":null,"regimeBens":null,"dataCasamento":null,"conjuge":{"nome":null,"cpf":null},
"endereco":{"logradouro":null,"numero":null,"complemento":null,"bairro":null,"cidade":null,"uf":null,"cep":null,"comprovanteMesAno":null},
"pis":null,"profissao":null,"escolaridade":null,
"trabalho":{"vinculo":"CLT|SERVIDOR PUBLICO|AUTONOMO|EMPRESARIO|APOSENTADO|OUTRO|null","empregador":null,"cnpj":null,"cargo":null,"admissao":null},
"contracheques":[{"competencia":null,"empregador":null,"cnpj":null,"bruto":null,"liquido":null,"irRetido":null,"tipo":"salario|aposentadoria|pensao|lucros","cargo":null,"admissao":null}],"semRenda":false,"rendaInformal":false,"rendaBrutaMensal":null,"rendaLiquidaMensal":null,
"outrasRendas":[{"tipo":null,"valor":null}],"patrimonioTotal":null,
"fontes":{"<campo>":"<nome do arquivo>"},"faltando":["<campo que nenhum documento trouxe e o cadastro do banco pede>"]}],
"conflitos":["<divergência entre documentos ou entre documento e card, em 1 frase>"],"observacao":"<1 frase>"}
rendaBrutaMensal/rendaLiquidaMensal = soma da renda RECORRENTE do mês mais recente de cada fonte (dois empregos/aposentadoria + emprego = some). "faltando" considera: identidade (número, órgão, UF, emissão), naturalidade, filiação, estado civil, endereço com CEP e, de quem tem renda, empregador/cargo/admissão (PIS só com FGTS). Datas dd/mm/aaaa; valores número puro; CPF/CEP só dígitos.`;

const hoje = () => new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
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
    .filter((f) => !/matricula|iptu|escritura|onus|habite|simulac|minuta|boleto|evolucao|parcelas|proposta|^aef_/.test(norm(f.name)))
    .slice(0, MAX_ARQUIVOS);
}

/** Renda do SÓCIO montada no código pela leitura do imposto de renda (Fabio 31/10: "pegar a distribuição de lucro e dividir por 12"; a junção por IA marcou o
 *  João Pedro como SEM RENDA com o IR dele na pasta). Só pra quem não tem contracheque/aposentadoria: por empresa, o ano-calendário mais recente, valor ÷ 12.
 *  IR da pessoa na pasta sem lucro lido e ela "sem renda" → vai pro "faltando" (o cadastro automático espera a equipe em vez de cadastrar SEM RENDA). */
function rendaDeSocio(participantes: any[], leituras: { arquivo: string; leitura: any }[]): void {
  const dig = (v: unknown) => String(v ?? '').replace(/\D/g, '');
  const pu = (s: unknown) => { const n = norm(String(s || '')).split(/\s+/).filter(Boolean); return n.length ? `${n[0]} ${n[n.length - 1]}` : ''; };
  for (const p of participantes || []) {
    const ccs = Array.isArray(p?.contracheques) ? p.contracheques : [];
    if (ccs.some((c: any) => Number(c?.bruto) > 0 || Number(c?.liquido) > 0)) continue;
    const lucros = new Map<string, { fonte: string; cnpj: string; valor: number; ano: number; arquivo: string }>();
    let temIr = false;
    for (const { arquivo, leitura } of leituras) {
      if (!/IMPOSTO DE RENDA/i.test(String(leitura?.tipo || ''))) continue;
      for (const pe of Array.isArray(leitura?.pessoas) ? leitura.pessoas : []) {
        const mesmo = (dig(pe?.cpf).length === 11 && dig(pe.cpf) === dig(p.cpf)) || (!!pu(pe?.nome) && pu(pe.nome) === pu(p.nome));
        if (!mesmo) continue;
        temIr = true;
        for (const ld of Array.isArray(pe.lucrosDividendos) ? pe.lucrosDividendos : []) {
          const valor = Number(ld?.valorAnual);
          if (!(valor > 0)) continue;
          const k = dig(ld.cnpj) || norm(String(ld.fonte || ''));
          const ano = Number(pe.anoCalendario || leitura.anoCalendario) || 0;
          const atual = lucros.get(k);
          if (!atual || ano > atual.ano) lucros.set(k, { fonte: String(ld.fonte || '').trim(), cnpj: dig(ld.cnpj), valor, ano, arquivo });
        }
      }
    }
    console.log(`[Ficha cadastral] sócio? ${pu(p.nome)}: IR ${temIr ? 'sim' : 'não'}, lucros ${[...lucros.values()].map((x) => `${x.ano}:${x.valor}`).join(',') || '—'}`);
    if (!lucros.size) {
      if (temIr && p.semRenda) p.faltando = [...(Array.isArray(p.faltando) ? p.faltando : []), 'renda: o imposto de renda está na pasta, mas nenhuma renda/lucro foi lido — conferir antes de cadastrar SEM RENDA'];
      continue;
    }
    const fontes = [...lucros.values()].sort((a, b) => b.valor - a.valor);
    const r2 = (n: number) => Math.round((n / 12) * 100) / 100;
    p.contracheques = fontes.map((x) => ({ tipo: 'lucros', empregador: x.fonte || null, cnpj: x.cnpj || null, bruto: r2(x.valor), liquido: r2(x.valor), irRetido: null, cargo: 'DIRETOR DE EMPRESAS', admissao: null, competencia: x.ano ? `12/${x.ano}` : null }));
    p.semRenda = false; p.rendaInformal = false;
    p.rendaBrutaMensal = p.rendaLiquidaMensal = Math.round(fontes.reduce((s, x) => s + x.valor / 12, 0) * 100) / 100;
    p.trabalho = { ...(p.trabalho || {}), vinculo: 'EMPRESARIO', empregador: fontes[0].fonte || null, cnpj: fontes[0].cnpj || null, cargo: 'DIRETOR DE EMPRESAS', admissao: null };
    p.profissao = p.profissao || 'DIRETOR DE EMPRESAS';
    p.fontes = { ...(p.fontes || {}), trabalho: fontes[0].arquivo, renda: fontes[0].arquivo };
    p.faltando = [...(Array.isArray(p.faltando) ? p.faltando : []).filter((f: unknown) => !/empregador|cargo|admiss|renda/i.test(String(f))), ...fontes.filter((x) => x.cnpj.length !== 14).map((x) => `CNPJ de ${x.fonte || 'empresa do IR'}`)];
  }
}

/** Sócio (renda = lucros ÷ 12 — Fabio 31/10): a CAIXA pede a "data de admissão" da renda — vale a entrada na sociedade, pelo quadro de sócios do CNPJ (BrasilAPI,
 *  dado público da Receita); sem o sócio no quadro, a abertura da empresa. Completa também o nome da empresa e tira a admissão do "faltando". */
async function completarSocios(participantes: any[]): Promise<void> {
  for (const p of participantes || []) {
    for (const c of Array.isArray(p?.contracheques) ? p.contracheques : []) {
      const cnpj = String(c?.cnpj || '').replace(/\D/g, '');
      if (!/lucro/i.test(String(c?.tipo || '')) || c.admissao || cnpj.length !== 14) continue;
      const r = await dadosDoCnpj(cnpj);
      if (!r) { console.warn(`[Ficha cadastral] sócio: CNPJ sem resposta das consultas públicas`); }
      const nome = norm(p.nome).split(/\s+/);
      const socio = (r?.socios || []).find((q) => { const n = norm(q.nome).split(/\s+/); return n[0] === nome[0] && n[n.length - 1] === nome[nome.length - 1]; });
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(socio?.entrada || r?.abertura || ''));
      if (m) c.admissao = `${m[3]}/${m[2]}/${m[1]}`;
      if (!c.empregador && r?.razao) c.empregador = r.razao;
      const t = p.trabalho || (p.trabalho = {});
      if (!t.cnpj || String(t.cnpj).replace(/\D/g, '') === cnpj) Object.assign(t, { cnpj: t.cnpj || cnpj, empregador: t.empregador || c.empregador, admissao: t.admissao || c.admissao, cargo: t.cargo || c.cargo });
      if (c.admissao) p.faltando = (Array.isArray(p.faltando) ? p.faltando : []).filter((f: unknown) => !/admiss|empregador|cargo/i.test(String(f)));
    }
    // Sem a data (consultas fora do ar): fica no "faltando" — a CAIXA recusa renda sem admissão e o cadastro automático não pode sair assim.
    for (const c of Array.isArray(p?.contracheques) ? p.contracheques : []) {
      if (/lucro/i.test(String(c?.tipo || '')) && !c.admissao) p.faltando = [...(Array.isArray(p.faltando) ? p.faltando : []), `data de entrada na sociedade (${c.empregador || 'empresa do IR'})`];
    }
  }
}

/** Dados públicos do CNPJ (Receita): BrasilAPI e, se não responder, publica.cnpj.ws. Datas em AAAA-MM-DD. */
async function dadosDoCnpj(cnpj: string): Promise<{ razao: string; abertura: string; socios: { nome: string; entrada: string }[] } | null> {
  const get = (url: string) => fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (AF CRM)', Accept: 'application/json' }, signal: AbortSignal.timeout(10000) })
    .then((x) => (x.ok ? x.json() : null)).catch(() => null) as Promise<any>;
  const b = await get(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`);
  if (b?.data_inicio_atividade) return { razao: b.razao_social || '', abertura: b.data_inicio_atividade, socios: (b.qsa || []).map((q: any) => ({ nome: q?.nome_socio || '', entrada: q?.data_entrada_sociedade || '' })) };
  const w = await get(`https://publica.cnpj.ws/cnpj/${cnpj}`);
  if (w?.estabelecimento?.data_inicio_atividade) return { razao: w.razao_social || '', abertura: w.estabelecimento.data_inicio_atividade, socios: (w.socios || []).map((q: any) => ({ nome: q?.nome || '', entrada: q?.data_entrada || '' })) };
  return null;
}

/** Anexos (PDF/foto) que o cliente mandou na conversa e já subiram pro Drive — os mais recentes primeiro. */
async function anexosDaConversa(leadId: string): Promise<Arquivo[]> {
  const rows = await prisma.messageAttachment.findMany({
    where: { leadId, driveFileId: { not: null }, message: { direction: 'INBOUND' } },
    orderBy: { createdAt: 'desc' }, take: MAX_ARQUIVOS, select: { driveFileId: true, fileName: true, mimeType: true },
  });
  return rows.map((r) => ({ id: r.driveFileId as string, name: r.fileName, mimeType: r.mimeType, path: 'CONVERSA', size: 0 }));
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
  content.push({ type: 'text', text: `Hoje é ${hoje()}.\nArquivo: ${f.path ? `${f.path} > ` : ''}${f.name}` });
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
  if (p.semRenda) add('Renda', 'SEM RENDA (no cadastro da CAIXA: marcar sem renda e salvar)');
  add('Renda mensal', [brl(p.rendaBrutaMensal) && `bruta ${brl(p.rendaBrutaMensal)}`, brl(p.rendaLiquidaMensal) && `líquida ${brl(p.rendaLiquidaMensal)}`].filter(Boolean).join(' / ') || null);
  const outras = Array.isArray(p.outrasRendas) ? p.outrasRendas.filter((o: any) => o && brl(o.valor)) : [];
  if (outras.length) add('Outras rendas', outras.map((o: any) => `${o.tipo || 'outra'} ${brl(o.valor)}`).join('; '));
  add('Patrimônio (IR)', brl(p.patrimonioTotal));
  if (Array.isArray(p.faltando) && p.faltando.length) L.push(`⚠️ Não achei nos documentos: ${p.faltando.join(', ')}`);
  return L.join('\n');
}

/** BRB (Fabio 27/10): renda = SOMA dos LÍQUIDOS de todos os contracheques num campo só — o mais recente de cada fonte pagadora. */
function liquidoBrb(p: any): { total: number; partes: string[] } {
  const ultimo = new Map<string, any>();
  const mes = (c: string) => { const m = /(\d{1,2})\/(\d{4})/.exec(String(c || '')); return m ? Number(m[2]) * 100 + Number(m[1]) : 0; };
  for (const c of Array.isArray(p.contracheques) ? p.contracheques : []) {
    if (!c || !(Number(c.liquido) > 0)) continue;
    const k = norm(String(c.empregador || 'contracheque')).split(' ').slice(0, 2).join(' ');
    const atual = ultimo.get(k);
    if (!atual || mes(c.competencia) > mes(atual.competencia)) ultimo.set(k, c);
  }
  const lista = [...ultimo.values()];
  if (!lista.length) return { total: Number(p.rendaLiquidaMensal) || 0, partes: [] };
  return { total: Math.round(lista.reduce((t, c) => t + Number(c.liquido), 0) * 100) / 100, partes: lista.map((c) => `${c.empregador || 'contracheque'} ${c.competencia || ''}: ${brl(c.liquido)}`) };
}

/** Ficha do BRB (PCN) — na ordem das etapas do cadastro; só quem participa do financiamento (cônjuge sem renda aparece só no estado civil — Fabio 27/10). */
function fichaBrb(participantes: any[], cf: Record<string, any>, quando: string): string {
  const linha = (rot: string, v: unknown) => (v !== null && v !== undefined && String(v).trim() ? `• ${rot}: ${v}` : null);
  const bloco = (p: any, n: number) => {
    const id = p.identidade || {}; const nat = p.naturalidade || {}; const conj = p.conjuge || {}; const e = p.endereco || {}; const t = p.trabalho || {};
    const cep = String(e.cep || '').replace(/\D/g, '');
    const liq = liquidoBrb(p);
    return [
      `👤 ${n === 1 ? 'Cliente' : 'Coadquirente'}: ${p.nome || '—'}`,
      '1) Dados pessoais',
      linha('Sexo', p.sexo === 'M' ? 'Masculino' : p.sexo === 'F' ? 'Feminino' : p.sexo),
      linha('CPF', cpfFmt(p.cpf)),
      linha('Nascimento', p.nascimento),
      linha('Identidade', id.numero ? `${id.tipo || 'RG'} nº ${id.numero}` : null),
      linha('Órgão expedidor / UF', [id.orgao, id.uf].filter(Boolean).join(' / ') || null),
      linha('Data de emissão', id.emissao),
      linha('Naturalidade (UF / cidade)', [nat.uf, nat.cidade].filter(Boolean).join(' / ') || null),
      linha('Nacionalidade', p.nacionalidade),
      linha('Valor do patrimônio (IR)', brl(p.patrimonioTotal)),
      '2) Dados complementares',
      linha('Mãe', p.mae),
      linha('Pai', p.pai),
      linha('Grau de instrução', p.escolaridade),
      linha('Estado civil', p.estadoCivil),
      linha('Regime', p.regimeBens),
      linha('Cônjuge', conj.nome ? `${conj.nome}${conj.cpf ? ` — CPF ${cpfFmt(conj.cpf)}` : ''}` : null),
      '3) Endereço e contatos',
      linha('Endereço', [e.logradouro && `${e.logradouro}${e.numero ? `, ${e.numero}` : ''}`, e.complemento, e.bairro, [e.cidade, e.uf].filter(Boolean).join('/')].filter(Boolean).join(' — ') || null),
      linha('CEP', cep ? `${cepFmt(cep)}${cep.startsWith('0') ? ' ⚠️ começa com 0: o PCN perde o zero da frente — conferir na ficha impressa' : ''}` : null),
      linha('Telefone', cf[`telefone_${n}`]),
      linha('E-mail', cf[`email_${n}`]),
      '4) Dados profissionais',
      linha('Tipo de funcionário', /clt/i.test(String(t.vinculo || '')) ? 'COMUM' : t.vinculo),
      linha('Razão social', t.empregador),
      linha('Cargo (lista CBO)', t.cargo),
      linha('Início', t.admissao),
      linha('Renda mensal líquida', liq.total ? `${brl(liq.total)}${liq.partes.length > 1 ? ` (soma: ${liq.partes.join(' + ')})` : ''}` : null),
      liq.partes.length > 1 ? '• Aposentadoria/pensão: deixar zerado (já está somada na renda líquida)' : null,
    ].filter(Boolean).join('\n');
  };
  const comRenda = participantes.filter((p, i) => i === 0 || !p.semRenda);
  const semRenda = participantes.filter((p, i) => i > 0 && p.semRenda);
  const operacao = [linha('Valor da operação (imóvel)', brl(Number(cf.valor_imovel))), linha('Valor pleiteado', brl(Number(cf.valor_credito))), linha('Tipo do imóvel', cf.tipo_imovel)].filter(Boolean).join('\n');
  return `📋 FICHA DE CADASTRO — BRB (PCN) — lida dos documentos da pasta do Drive em ${quando}.\n\n${operacao ? `${operacao}\n\n` : ''}${comRenda.map((p, i) => bloco(p, i + 1)).join('\n\n')}${semRenda.length ? `\n\nℹ️ ${semRenda.map((p) => p.nome).join(', ')}: sem renda — não entra como coadquirente no BRB (só no estado civil).` : ''}`;
}

/** Atualiza a anotação da ficha (uma por banco) ou cria. */
async function gravarNota(leadId: string, prefixos: string[], texto: string, userId?: string | null): Promise<void> {
  const anterior = await prisma.note.findFirst({ where: { leadId, OR: prefixos.map((p) => ({ content: { startsWith: p } })) }, orderBy: { createdAt: 'desc' }, select: { id: true } });
  if (anterior) await prisma.note.update({ where: { id: anterior.id }, data: { content: texto } });
  else await prisma.note.create({ data: { leadId, userId: userId || null, type: 'COMMENT', content: texto } });
}

const emAndamento = new Set<string>();

/** Lê a pasta do Drive do cliente e grava a ficha (customFields `_fichaCadastral` + anotação). Devolve a mensagem de erro, ou null quando gravou. */
export async function gerarFichaCadastral(accountId: string, leadId: string, opts: { userId?: string | null; io?: Io } = {}): Promise<string | null> {
  if (!process.env.ANTHROPIC_API_KEY) return 'IA indisponível';
  if (emAndamento.has(leadId)) return 'A ficha deste cliente já está sendo lida';
  emAndamento.add(leadId);
  try {
    const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { id: true, name: true, customFields: true, pipeline: { select: { department: { select: { name: true } } } } } });
    if (!lead) return 'Lead não encontrado';
    const cf = (lead.customFields || {}) as Record<string, any>;
    const link = String(cf.link_pasta_drive || '').trim();
    const google = await import('./google.service');
    // Com a pasta, os anexos da conversa já estão nela (organizados). Sem a pasta (Fabio 31/10: "o CRM deve coletar os dados para o cadastro através da
    // documentação encaminhada na própria conversa"): os anexos que o cliente mandou na conversa, que ficam no Drive pelo driveFileId.
    const todos: Arquivo[] = link ? await google.listAllFilesInFolderTree(accountId, google.extractFolderId(link), 3) : await anexosDaConversa(leadId);
    const arquivos = arquivosPessoais(todos);
    if (!arquivos.length) return link ? 'Não achei documento pessoal (PDF/foto) na pasta do Drive' : 'O card não tem a pasta do Drive nem documento (PDF/foto) na conversa';
    const origem = link ? 'da pasta do Drive' : 'enviados na conversa';

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
    const usaFgts = /^(s|sim|true|1)/i.test(String(cf.usa_fgts ?? '').trim());
    const ficha = await chamarIA(SYSTEM_JUNTA, [{ type: 'text', text: `Hoje é ${hoje()} (documento de 2026 não é "data futura").\nUSA FGTS: ${usaFgts ? 'sim' : 'não'}\n\nPARTICIPANTES DO CARD:\n${JSON.stringify(participantesCard)}\n\nLEITURAS DOS DOCUMENTOS:\n${JSON.stringify(pessoais).slice(0, 180_000)}` }], 16000);
    if (!ficha || !Array.isArray(ficha.participantes) || !ficha.participantes.length) return 'Não consegui montar a ficha com as leituras';
    rendaDeSocio(ficha.participantes, pessoais);
    await completarSocios(ficha.participantes).catch((e) => console.error('[Ficha cadastral] sócio:', e?.message));

    const agora = new Date();
    const registro = { at: agora.toISOString(), usaFgts, participantes: ficha.participantes, conflitos: Array.isArray(ficha.conflitos) ? ficha.conflitos : [], observacao: String(ficha.observacao || ''), arquivos: pessoais.map((x) => ({ nome: x.arquivo, tipo: x.leitura.tipo })), naoLidos };
    const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
    await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...((fresh?.customFields || {}) as Record<string, unknown>), _fichaCadastral: registro } as any } });

    const quando = agora.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }).slice(0, 17);
    const blocos = ficha.participantes.map((p: any, i: number) => {
      const n = Number(p.ordem) || i + 1;
      return `👤 ${n}º participante: ${p.nome || '—'}\n${linhaParticipante(p, { telefone: cf[`telefone_${n}`] || undefined, email: cf[`email_${n}`] || undefined })}`;
    });
    const conflitos = registro.conflitos.length ? `\n\n⚠️ Divergências:\n${registro.conflitos.map((c: string) => `• ${c}`).join('\n')}` : '';
    const lidos = `\n\n📁 Lidos (${pessoais.length}): ${pessoais.map((x) => `${x.arquivo} (${x.leitura.tipo})`).join('; ')}${naoLidos.length ? `\n⛔ Não consegui ler: ${naoLidos.join('; ')}` : ''}`;
    // Uma anotação por banco: gerar de novo (documento novo na pasta) atualiza a mesma. A ficha do BRB é outra (Fabio 29/10) e só existe no Financiamento.
    await gravarNota(leadId, ['📋 FICHA DE CADASTRO — CAIXA', '📋 FICHA DE CADASTRO — lida'], `📋 FICHA DE CADASTRO — CAIXA — lida dos documentos ${origem} em ${quando}.\n\n${blocos.join('\n\n')}${conflitos}${lidos}`, opts.userId);
    if (/habitacional|financiamento/i.test(lead.pipeline?.department?.name || '')) await gravarNota(leadId, ['📋 FICHA DE CADASTRO — BRB'], fichaBrb(ficha.participantes, cf, quando), opts.userId);
    opts.io?.to(`lead:${leadId}`).emit('lead_updated', { leadId });
    await pedirCnpjAoCliente(accountId, leadId, ficha.participantes, opts.io).catch((e) => console.error('[Ficha cadastral] pedido de CNPJ:', e?.message));
    logActivity({ accountId, userId: opts.userId || null, userName: opts.userId ? undefined : 'Assistente IA', action: 'lead_note_added', leadId, leadName: lead.name, summary: 'gravou a ficha de cadastro lida dos documentos do Drive' });
    console.log(`[Ficha cadastral] ${lead.name}: ${ficha.participantes.length} participante(s), ${pessoais.length} arquivo(s)`);
    return null;
  } finally {
    emAndamento.delete(leadId);
  }
}

/** Dado da renda que a CAIXA exige e nenhum documento trouxe (Fabio 30/10): CNPJ da fonte pagadora (nem contracheque, nem IR, nem carteira de trabalho) e
 *  data de admissão (aposentadoria: início do benefício; sócio: entrada na sociedade). Fabio 31/10: "não peça nenhum documento ao cliente antes de me perguntar"
 *  → o CRM NÃO manda nada ao cliente: anotação + push pra equipe com a mensagem sugerida (uma vez por item). Se a equipe pedir e o cliente responder com o
 *  CNPJ/data, a resposta volta pra ficha (capturarCnpjDaResposta). */
const chaveFonte = (s: unknown) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim().split(/\s+/).slice(0, 2).join(' ');
function faltasDeRenda(participantes: any[]): { chave: string; texto: string; cnpj: boolean }[] {
  const out: { chave: string; texto: string; cnpj: boolean }[] = [];
  for (const p of participantes || []) {
    const t = p?.trabalho || {};
    for (const c of Array.isArray(p?.contracheques) ? p.contracheques : []) {
      if (!c || !(Number(c.bruto) > 0 || Number(c.liquido) > 0)) continue;
      const fonte = String(c.empregador || t.empregador || '').trim();
      if (!fonte) continue;
      const apos = /aposent|pens/i.test(String(c.tipo || '')) || /seguridade|previd|aposent/i.test(fonte);
      const lucros = /lucro/i.test(String(c.tipo || ''));
      const semCnpj = String(c.cnpj || '').replace(/\D/g, '').length !== 14;
      const semAdm = !c.admissao && !(apos ? c.inicioBeneficio : (chaveFonte(t.empregador) === chaveFonte(fonte) && t.admissao));
      if (semCnpj && !out.some((x) => x.chave === `cnpj:${fonte}`)) out.push({ chave: `cnpj:${fonte}`, texto: `o CNPJ ${apos ? 'de' : 'da empresa'} ${fonte}`, cnpj: true });
      if (semAdm && !out.some((x) => x.chave === `adm:${fonte}`)) out.push({ chave: `adm:${fonte}`, texto: apos ? `a data de início da aposentadoria (${fonte})` : lucros ? `a data de entrada na sociedade (${fonte})` : `a sua data de admissão em ${fonte}`, cnpj: false });
    }
  }
  return out;
}
export async function pedirCnpjAoCliente(accountId: string, leadId: string, participantes: any[], _io?: Io): Promise<void> {
  const faltas = faltasDeRenda(participantes);
  if (!faltas.length) return;
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const ja = (((lead?.customFields || {}) as Record<string, any>)._fichaCnpjPedido || {}) as Record<string, string>;
  const novas = faltas.filter((f) => !ja[f.chave] || /^pendente:/.test(ja[f.chave]));
  if (!novas.length) return;
  const lista = novas.map((f) => f.texto).join('; ');
  const texto = `Para concluir o seu cadastro no banco, preciso de: ${lista}.${novas.some((f) => f.cnpj) ? ' O CNPJ aparece no contracheque ou no informe de rendimentos — se preferir, pode me mandar a declaração completa do seu Imposto de Renda, que lá também consta.' : ''}`;
  const agora = new Date().toISOString();
  const marca = { ...ja, ...Object.fromEntries(novas.map((f) => [f.chave, `equipe:${agora}`])) };
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_fichaCnpjPedido}', ${JSON.stringify(marca)}::jsonb, true) WHERE id = ${leadId}`;
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `📋 A ficha de cadastro ficou sem ${lista} — nenhum documento traz. O CRM não pede nada ao cliente sem a sua autorização. Se for pedir, sugestão:\n"${texto}"` } }).catch(() => {});
  const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
  sendPushToAccount(accountId, { title: '📋 Ficha sem dado da renda', body: `Falta ${lista} — pedir ao cliente?`.slice(0, 160), leadId }).catch(() => {});
}

/** Resposta do cliente ao pedido acima (Fabio 30/10): CNPJ (14 dígitos) e data dd/mm/aaaa na mensagem → gravados na ficha, na fonte que estava sem;
 *  o cadastro da CAIXA que não saiu volta pra fila. Só quando o CRM pediu (não lê CNPJ solto de qualquer conversa). */
export async function capturarCnpjDaResposta(accountId: string, leadId: string, text: string): Promise<void> {
  const cnpjs = [...String(text || '').matchAll(/(\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2})/g)].map((m) => m[1].replace(/\D/g, '')).filter((c) => c.length === 14);
  const datas = [...String(text || '').matchAll(/\b(\d{2})\/(\d{2})\/(\d{4})\b/g)].map((m) => `${m[1]}/${m[2]}/${m[3]}`);
  if (!cnpjs.length && !datas.length) return;
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  const cf = (lead?.customFields || {}) as Record<string, any>;
  const pedido = (cf._fichaCnpjPedido || {}) as Record<string, string>;
  const abertos = Object.entries(pedido).filter(([, v]) => /^(cliente|equipe):/.test(String(v))).map(([k]) => k);
  const ficha = cf._fichaCadastral;
  if (!abertos.length || !Array.isArray(ficha?.participantes)) return;
  const gravou: string[] = [];
  for (const chave of abertos) {
    const [tipo, ...resto] = chave.split(':'); const fonte = resto.join(':');
    const valor = tipo === 'cnpj' ? cnpjs.shift() : datas.shift();
    if (!valor) continue;
    for (const p of ficha.participantes) {
      let achou = false;
      for (const c of Array.isArray(p.contracheques) ? p.contracheques : []) {
        if (chaveFonte(c?.empregador || p.trabalho?.empregador) !== chaveFonte(fonte)) continue;
        achou = true;
        if (tipo === 'cnpj') c.cnpj = valor; else if (/aposent|pens/i.test(String(c.tipo || ''))) c.inicioBeneficio = valor; else c.admissao = valor;
      }
      if (achou && p.trabalho && chaveFonte(p.trabalho.empregador) === chaveFonte(fonte)) { if (tipo === 'cnpj') p.trabalho.cnpj = p.trabalho.cnpj || valor; else p.trabalho.admissao = p.trabalho.admissao || valor; }
      if (achou) p.faltando = (Array.isArray(p.faltando) ? p.faltando : []).filter((f: string) => !(tipo === 'cnpj' ? /cnpj/i : /admiss|inicio do benef|início do benef/i).test(String(f)));
    }
    pedido[chave] = `respondido:${new Date().toISOString()}`;
    gravou.push(`${tipo === 'cnpj' ? 'CNPJ' : 'data'} de ${fonte}: ${tipo === 'cnpj' ? valor.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : valor}`);
  }
  if (!gravou.length) return;
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_fichaCadastral}', ${JSON.stringify(ficha)}::jsonb, true), '{_fichaCnpjPedido}', ${JSON.stringify(pedido)}::jsonb, true) WHERE id = ${leadId}`;
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `📋 O cliente respondeu e gravei na ficha de cadastro: ${gravou.join('; ')}.` } }).catch(() => {});
  const { reenfileirarCadastrosPendentes } = require('./caixa-cadastro.service') as typeof import('./caixa-cadastro.service');
  await reenfileirarCadastrosPendentes(leadId, 'dado da renda respondido pelo cliente').catch(() => {});
}

/** Card que chegou em "Documentação Recebida" (funis Em contratação) com a pasta do Drive e ainda sem ficha → lê. Um por rodada do poller.
 *  Por SQL: filtro de JSON do Prisma com NOT dá NULL em card sem a chave e some com a linha (ver fila parada de 15/10). */
export async function processFichasCadastrais(accountId: string, io?: Io): Promise<void> {
  // Pedido de CNPJ/admissão que ficou pendente (fora do horário/conversa fechada): manda quando der, um card por rodada.
  const pend = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false AND "customFields"->>'_fichaCnpjPedido' LIKE '%pendente:%' LIMIT 1`.catch(() => []);
  if (pend[0]) {
    const l = await prisma.lead.findUnique({ where: { id: pend[0].id }, select: { customFields: true } });
    const ps = ((l?.customFields || {}) as Record<string, any>)._fichaCadastral?.participantes;
    if (Array.isArray(ps)) await pedirCnpjAoCliente(accountId, pend[0].id, ps, io).catch((e) => console.error('[Ficha cadastral] pedido pendente:', e?.message));
  }
  if (!process.env.ANTHROPIC_API_KEY || emAndamento.size >= 2) return;
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT l.id FROM "Lead" l JOIN "Stage" s ON s.id = l."stageId" JOIN "Pipeline" p ON p.id = l."pipelineId"
    WHERE l."accountId" = ${accountId} AND l.status = 'OPEN' AND l.archived = false AND l."isGroup" = false
      AND ((p.name ILIKE 'Em contratação%'
        AND COALESCE(l."customFields"->>'link_pasta_drive', '') LIKE 'http%'
        AND ((s.name ILIKE '%Documentação Recebida%' AND l."customFields"->'_fichaCadastral' IS NULL)
          -- Ficha com dado faltando + documento novo organizado na pasta depois dela → lê de novo, em qualquer etapa da contratação (Fabio 29/10: RG/CNH da Bianca chegando depois).
          OR (l."customFields"->>'_driveOrganizedAt' > l."customFields"->'_fichaCadastral'->>'at'
            AND jsonb_typeof(l."customFields"->'_fichaCadastral'->'participantes') = 'array'
            AND EXISTS (SELECT 1 FROM jsonb_array_elements(l."customFields"->'_fichaCadastral'->'participantes') fp
              WHERE jsonb_typeof(fp->'faltando') = 'array' AND jsonb_array_length(fp->'faltando') > 0))))
        -- Financiamento pela CAIXA/BRB com a documentação do comprador completa (antes da contratação, pode não ter pasta: lê da conversa) — Fabio 31/10.
        OR (l."customFields"->>'_fhDocsCompradorAt' IS NOT NULL AND l."customFields"->'_fichaCadastral' IS NULL))
      AND COALESCE(l."customFields"->>'_fichaCadastralErro', '') < ${new Date(Date.now() - 6 * 3600_000).toISOString()}
    ORDER BY l."stageEnteredAt" ASC NULLS LAST LIMIT 1`;
  if (!ids[0] || emAndamento.has(ids[0].id)) return;
  // Sem esperar: a leitura leva minutos e o poller tem as outras rotinas da mesma rodada (emAndamento segura a repetição).
  rodar(accountId, ids[0].id, io).catch((e) => console.error('[Ficha cadastral]', e?.message));
}

async function rodar(accountId: string, leadId: string, io: Io): Promise<void> {
  const antes = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const psAntes = ((antes?.customFields || {}) as Record<string, any>)._fichaCadastral?.participantes;
  const erro = await gerarFichaCadastral(accountId, leadId, { io }).catch((e: any) => e?.message || 'erro');
  if (!erro) {
    if (Array.isArray(psAntes)) {
      const { reenfileirarComFichaNova, reenfileirarCadastrosPendentes } = require('./caixa-cadastro.service') as typeof import('./caixa-cadastro.service');
      await reenfileirarComFichaNova(leadId, psAntes).catch((e) => console.error('[Ficha cadastral] fila da CAIXA:', e?.message));
      // Documento novo trouxe CNPJ/admissão que faltava (ex.: o IRPF que o CRM pediu) → cadastro que não saiu volta pra fila.
      const depois = ((await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }))?.customFields as Record<string, any> | null)?._fichaCadastral?.participantes;
      if (Array.isArray(depois) && faltasDeRenda(depois).length < faltasDeRenda(psAntes).length) await reenfileirarCadastrosPendentes(leadId, 'documento novo com o dado da renda').catch(() => {});
    }
    return;
  }
  // Sem pasta/sem documento: tenta de novo em 6 h (não fica lendo o Drive a cada minuto).
  const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...((fresh?.customFields || {}) as Record<string, unknown>), _fichaCadastralErro: new Date().toISOString() } as any } }).catch(() => {});
  console.log(`[Ficha cadastral] ${leadId}: ${erro}`);
}

/** VENDEDOR do Financiamento (Fabio 30/10, vistoria do Santander: a ficha leva os dados do vendedor). Lê os documentos da subpasta VENDEDOR do Drive com o mesmo leitor
 *  (o que está escrito, nunca inventado) e junta por pessoa (CPF, senão nome). Grava `_fichaVendedor` no card. Devolve as pessoas, ou null se não houver o que ler. */
export async function lerVendedores(accountId: string, leadId: string): Promise<any[] | null> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  const link = String(((lead?.customFields || {}) as Record<string, any>).link_pasta_drive || '').trim();
  if (!link) return null;
  const google = await import('./google.service');
  const todos = (await google.listAllFilesInFolderTree(accountId, google.extractFolderId(link), 3)) as Arquivo[];
  const arquivos = todos.filter((f) => /vendedor/.test(norm(f.path)) && /pdf|^image\//.test(f.mimeType)).slice(0, 12);
  if (!arquivos.length) return null;
  const leituras = (await Promise.all(arquivos.map((f) => lerArquivo(accountId, f).catch(() => null)))).filter((l) => l && Array.isArray(l.pessoas));
  const porPessoa = new Map<string, any>();
  const funde = (a: any, b: any): any => {
    if (a === null || a === undefined || a === '') return b;
    if (typeof a === 'object' && !Array.isArray(a) && b && typeof b === 'object') { const o = { ...a }; for (const k of Object.keys(b)) o[k] = funde(a[k], b[k]); return o; }
    return a;
  };
  for (const l of leituras) {
    for (const p of l.pessoas) {
      const chave = String(p.cpf || '').replace(/\D/g, '') || norm(String(p.nome || ''));
      if (!chave) continue;
      const tipo = String(l.tipo || '').toUpperCase();
      const comId = /^(RG|CNH)$/.test(tipo) ? { ...p, identidade: { tipo, numero: tipo === 'CNH' ? p.cnh?.numero : p.rg?.numero, orgao: tipo === 'CNH' ? p.cnh?.orgao : p.rg?.orgao, uf: tipo === 'CNH' ? p.cnh?.uf : p.rg?.uf, emissao: tipo === 'CNH' ? p.cnh?.emissao : p.rg?.emissao } } : p;
      porPessoa.set(chave, funde(porPessoa.get(chave), comId));
    }
  }
  const pessoas = Array.from(porPessoa.values());
  const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...((fresh?.customFields || {}) as Record<string, unknown>), _fichaVendedor: { at: new Date().toISOString(), pessoas, arquivos: arquivos.map((f) => f.name) } } as any } });
  return pessoas;
}
