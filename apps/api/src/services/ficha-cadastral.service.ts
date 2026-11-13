import { prisma } from '../lib/prisma';
import { logActivity } from './activity.service';
import { comRegrasCaixa, regrasRendaCaixa } from './caixa-cr016';
import { sexoParaFormulario } from './sexo-pelo-nome';
import { comEmissaoDoRg } from './rg-emissao';

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
"fontesPagadoras":[{"nome":null,"cnpj":null,"valorAnual":null,"contribPrev":null,"irRetido":null}],"lucrosDividendos":[{"fonte":null,"cnpj":null,"valorAnual":null}],"anoCalendario":null,"contratos":[{"empregador":null,"cnpj":null,"cargo":null,"admissao":null,"saida":null}],
"outrasRendas":[{"tipo":"aposentadoria|pensao|aluguel|outra","valor":null}],"patrimonioTotal":null}],
"observacao":"<1 frase: o que é o documento e qualquer ponto de atenção (ilegível, vencido, cortado, de outra pessoa)>"}
Regras: uma entrada em "pessoas" por pessoa que o documento identifica como titular (certidão de casamento = os DOIS cônjuges, com estadoCivil "CASADO(A)", o regime e a data do casamento; o nome de cada um pode mudar com o casamento — use o nome que a certidão diz que passou a usar). RG/CIN (carteira de identidade): rg.orgao = o órgão que está no CABEÇALHO do documento, abaixo da UF (ex.: "Distrito Federal — Secretaria de Estado de Segurança Pública" → "SSP"), NUNCA o instituto/polícia que aparece em outro lugar (ex.: "INSTITUTO DE IDENTIFICAÇÃO PCDF") — Fabio 01/11; rg.uf = a UF do cabeçalho. CNH: cnh.numero = Nº REGISTRO da CNH (11 dígitos — não o número do espelho/formulário), cnh.orgao = órgão emissor da CNH (DETRAN), cnh.uf = UF da CNH, cnh.emissao = DATA DE EMISSÃO da CNH, cnh.validade = VALIDADE, cnh.primeiraHabilitacao = data da 1ª HABILITAÇÃO; o RG que aparece impresso na CNH vai em "rg". Comprovante de residência: a pessoa é o titular da conta, o endereço é o da conta e endereco.comprovanteMesAno = mês/ano de referência da conta (mm/aaaa). Contracheque/demonstrativo de benefício (Fabio 31/10: "SEMPRE colocar a renda bruta e a renda líquida que vêm no contracheque" — direto do documento, nunca tirando verba nem somando rubricas): competencia = mês de referência; rendaBruta = TOTAL BRUTO (total de vencimentos) impresso; rendaLiquida = LÍQUIDO A RECEBER impresso — sempre, com qualquer verba do mês (férias e 1/3, 13º, PLR, saque/resgate de plano de previdência, rescisão…: cada uma vai também em "verbasEventuais" com o valor, só pra informação; o cadastro prefere outro contracheque de até 2 meses sem elas). irRetido = desconto de IMPOSTO DE RENDA RETIDO NA FONTE (IRRF) do mês — várias rubricas de IR de adiantamento somam; o IR À PARTE de 13º, férias ou PLR (rubrica própria, ex.: "IRRF 13º", "IRRF férias") NÃO entra; sem esse desconto = null — Fabio 30/10: a CAIXA tem o campo e ele precisa ir preenchido. Aposentadoria/benefício: "tipoRenda":"aposentadoria", "inicioBeneficio" = data de início do benefício se o documento mostrar. Imposto de renda: liste em "fontesPagadoras" cada fonte de "rendimentos tributáveis recebidos de pessoa jurídica" (do TITULAR) com nome, CNPJ, valorAnual = "rend. recebidos de pes. jurídica", contribPrev = "contr. previd. oficial" e irRetido = "imposto retido na fonte" do ano; em "lucrosDividendos" cada empresa de "Lucros e dividendos recebidos" (rendimentos isentos, do TITULAR — não os de dependente) com nome, CNPJ e valor do ano; "anoCalendario" = ano-calendário da declaração; carteira de trabalho: liste em "contratos" cada contrato (empregador, CNPJ do estabelecimento, cargo, admissão, saída ou null se ativo). Datas sempre dd/mm/aaaa; valores em reais como número puro (ex.: 12296.77); CPF e CEP só com os dígitos.`;

const SYSTEM_JUNTA = `Você monta a FICHA DE CADASTRO dos participantes de uma operação de crédito imobiliário juntando as leituras de vários documentos (cada leitura diz de qual arquivo veio). Use SÓ o que as leituras trazem — nunca invente. IDENTIDADE = O DOCUMENTO APRESENTADO (Fabio 29/10): se a pessoa apresentou CNH, a identidade é a CNH — tipo "CNH", número = Nº REGISTRO da CNH, órgão/UF/emissão da CNH — mesmo que a CNH traga também o número do RG; RG só quando não há CNH. CNH VENCIDA NÃO É PROBLEMA pro cadastro: não aponte em conflitos nem em faltando.
Quando dois documentos discordam, fique com o mais confiável pro campo (filiação/naturalidade: o documento de identidade apresentado; estado civil/regime/data do casamento/nome de casado: certidão de casamento; endereço: o comprovante de residência mais recente; trabalho e renda: contracheques mais recentes e carteira de trabalho; PIS: carteira de trabalho ou contracheque; patrimônio: imposto de renda) e registre a divergência em "conflitos".
Os participantes da operação vêm em PARTICIPANTES DO CARD (nome e CPF digitados na proposta — servem só pra saber quem é quem; o dado da ficha é o do documento). Ignore pessoas que não são participantes (ex.: vendedor do imóvel, dono da conta de luz que não é participante — nesse caso diga em "conflitos" que o comprovante está em nome de outra pessoa). CÔNJUGE TAMBÉM É PARTICIPANTE DO CADASTRO (Fabio 12/11: "sempre cadastrar proponente e segundo participante, mesmo que ele não tenha renda" — "a CAIXA não faz análise de crédito se não tiver o 2º participante cadastrado"): SÓ quando a mensagem traz "CADASTRO NA CAIXA: sim" (com "não", o cônjuge fora dos participantes do card aparece só dentro de "conjuge", como sempre foi), o cônjuge/companheiro(a) de um participante que HOJE está CASADO ou em UNIÃO ESTÁVEL e que não está em PARTICIPANTES DO CARD entra em "participantes" também, logo depois dos do card (ordem seguinte), com "conjugeIncluido": true, os dados dos documentos DELE (RG/CNH, CPF, certidão de casamento — o nome que passou a usar —, comprovante de renda se houver) e, sem nenhum documento de renda dele, "semRenda": true; o CPF ou o documento de identidade que nenhum documento trouxer vai em "faltando". Ele continua aparecendo dentro de "conjuge" do participante (e o participante dentro do "conjuge" dele). Solteiro, divorciado, separado ou viúvo não tem cônjuge a incluir — e certidão de casamento com AVERBAÇÃO de separação ou divórcio (ou o cliente dizendo na documentação que se separou) quer dizer SEPARADO/DIVORCIADO: o ex-cônjuge NUNCA entra, nem em "participantes" nem em "conjuge" (12/11: um ex-marido entrou na ficha por causa da certidão antiga e o CRM perguntou dele à cliente); se os documentos não dizem com quem o participante é casado, não inclua ninguém.
ENDEREÇO: participante sem comprovante de residência próprio que é CÔNJUGE do 1º participante ou compõe renda usa o endereço do comprovante do 1º participante (fonte "comprovante do 1º participante") — não é falta.
SEM RENDA: participante sem nenhum documento de renda (contracheque, IR, extrato de benefício, extrato bancário) fica com "semRenda": true, renda e trabalho null — no cadastro do banco ele entra como SEM RENDA; não liste trabalho/renda em "faltando".
SERVIDOR PÚBLICO (Fabio 12/11: "sempre que o cliente for servidor público, colocar isso na profissão: servidor público federal, estadual ou municipal"): trabalho.vinculo = "SERVIDOR PUBLICO" pra quem trabalha em órgão público, autarquia, fundação pública, EMPRESA PÚBLICA ou SOCIEDADE DE ECONOMIA MISTA — ministério, secretaria, tribunal, prefeitura, câmara, universidade/instituto público, polícia, forças armadas, SERPRO, Dataprev, Correios, Embrapa, Banco do Brasil, CAIXA, Petrobras, companhia estadual ou municipal de água/energia/transporte… — mesmo contratado pela CLT (o contracheque é de celetista, mas o vínculo aqui é SERVIDOR PUBLICO); e trabalho.esfera = "FEDERAL", "ESTADUAL" ou "MUNICIPAL" conforme o ente dono do órgão/da empresa (União = FEDERAL; Estado e Distrito Federal = ESTADUAL; município = MUNICIPAL). Empresa privada = "CLT" e esfera null. Em dúvida se o empregador é público, use o que os documentos dizem (ex.: "natureza da ocupação" do imposto de renda) e, sem isso, deixe "CLT".
RENDA INFORMAL (Fabio 29/10): participante SEM comprovante formal (nenhum contracheque, IR, CTPS ativa ou extrato de benefício) que trouxe APENAS extrato bancário fica com "rendaInformal": true e "semRenda": false — no cadastro da CAIXA a renda formal vai SEM RENDA e a informal R$ 3.000.
RENDAS (Fabio 30/10 e 31/10): um item em "contracheques" por CONTRACHEQUE lido (cada mês de cada fonte pagadora — o cadastro escolhe, por fonte, o válido mais recente — o de maior renda só com bruta mais de R$ 1.000 acima —, de preferência sem verba eventual), com bruto e líquido EXATAMENTE como a leitura trouxe (Fabio 31/10: sempre os valores impressos no contracheque, com qualquer verba — nunca tire nem recalcule), "verbasEventuais" = as verbas eventuais que estão DENTRO desses valores (férias e 1/3, 13º, PLR, saque/resgate de plano, rescisão — ex.: ["férias + 1/3"]; mês normal = []), "cargo" e "admissao" DAQUELA fonte (carteira de trabalho/contracheque dela; aposentadoria: "tipo":"aposentadoria", cargo null e admissao = data de início do benefício se algum documento mostrar). SÓCIO/EMPRESÁRIO (Fabio 31/10: a CAIXA não aceita pró-labore nem DECORE): sem contracheque e com "lucrosDividendos" no imposto de renda, a renda é a DISTRIBUIÇÃO DE LUCROS ÷ 12 — um item em "contracheques" por empresa com "tipo":"lucros", empregador = a empresa, cnpj, bruto = liquido = valorAnual ÷ 12 (2 casas), cargo "PROPRIETARIO DE ESTABELECIMENTO COMERCIAL", competencia "12/<anoCalendario>", admissao null (o CRM busca a entrada na sociedade pelo CNPJ), irRetido null; trabalho = vinculo "EMPRESARIO" + a empresa de maior lucro (empregador/cnpj, cargo "PROPRIETARIO DE ESTABELECIMENTO COMERCIAL"); nesse caso empregador/cargo/admissão NÃO vão em "faltando" (só o CNPJ, se o IR não trouxer). Contracheque SEM CNPJ: pegue o CNPJ da mesma fonte no IMPOSTO DE RENDA ("fontesPagadoras") ou na CARTEIRA DE TRABALHO ("contratos"), pelo nome; ainda sem → "faltando": "CNPJ de <fonte>". Aposentadoria sem data de início → "faltando": "data de início do benefício (<fonte>)".
PIS: preencha só se algum documento trouxer. Só entra em "faltando" quando USA FGTS = sim.
Responda SOMENTE com JSON:
{"participantes":[{"ordem":1,"nome":null,"cpf":null,"nascimento":null,"sexo":null,"nacionalidade":null,"naturalidade":{"cidade":null,"uf":null},
"identidade":{"tipo":"RG|CNH","numero":null,"orgao":null,"uf":null,"emissao":null,"validade":null,"primeiraHabilitacao":null},"mae":null,"pai":null,
"estadoCivil":null,"regimeBens":null,"dataCasamento":null,"conjuge":{"nome":null,"cpf":null},
"endereco":{"logradouro":null,"numero":null,"complemento":null,"bairro":null,"cidade":null,"uf":null,"cep":null,"comprovanteMesAno":null},
"pis":null,"profissao":null,"escolaridade":null,
"trabalho":{"vinculo":"CLT|SERVIDOR PUBLICO|AUTONOMO|EMPRESARIO|APOSENTADO|OUTRO|null","esfera":"FEDERAL|ESTADUAL|MUNICIPAL|null","empregador":null,"cnpj":null,"cargo":null,"admissao":null},
"contracheques":[{"competencia":null,"empregador":null,"cnpj":null,"bruto":null,"liquido":null,"irRetido":null,"verbasEventuais":[],"tipo":"salario|aposentadoria|pensao|lucros","cargo":null,"admissao":null}],"semRenda":false,"rendaInformal":false,"rendaBrutaMensal":null,"rendaLiquidaMensal":null,
"outrasRendas":[{"tipo":null,"valor":null}],"patrimonioTotal":null,
"fontes":{"<campo>":"<nome do arquivo>"},"faltando":["<campo que nenhum documento trouxe e o cadastro do banco pede>"]}],
"conflitos":["<divergência entre documentos ou entre documento e card, em 1 frase>"],"observacao":"<1 frase>"}
rendaBrutaMensal/rendaLiquidaMensal = soma, por fonte, do contracheque mais recente SEM verba eventual (sem esse, o mais recente) (dois empregos/aposentadoria + emprego = some). "faltando" considera: identidade (número, órgão, UF, emissão), naturalidade, filiação, estado civil, endereço com CEP e, de quem tem renda, empregador/cargo/admissão (PIS só com FGTS). Datas dd/mm/aaaa; valores número puro; CPF/CEP só dígitos.`;

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
    // Renda de contracheque/benefício de verdade: fica. A que a junção por IA montou do IR (lucros/pró-labore) é refeita aqui, pelo código (Fabio 05/11, Flávia: o pró-labore não entrava).
    if (ccs.some((c: any) => (Number(c?.bruto) > 0 || Number(c?.liquido) > 0) && !/lucro|pro.?labore/i.test(String(c?.tipo || '')))) continue;
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
    const doLucro = fontes.map((x) => ({ tipo: 'lucros', empregador: x.fonte || null, cnpj: x.cnpj || null, bruto: r2(x.valor), liquido: r2(x.valor), irRetido: null, cargo: 'PROPRIETARIO DE ESTABELECIMENTO COMERCIAL', admissao: null, competencia: x.ano ? `12/${x.ano}` : null }));
    // PRÓ-LABORE (Fabio 05/11, Flávia: "todo cliente que for dono de empresa e tiver pró-labore… aparece aqui com os dados da empresa dele, deve constar como
    // administrador e pegar esse valor e dividir por 12"): rendimento TRIBUTÁVEL recebido da PRÓPRIA empresa (mesmo CNPJ base de onde vem o lucro) — renda SEPARADA
    // (a CAIXA cadastra uma pra lucros e outra pro pró-labore; muda só a ocupação: ADMINISTRADOR). Bruto = líquido = valor ÷ 12, sem descontos (Fabio 05/11, Tarcisio: renda pelo IRPF é o total ÷ 12 — o líquido saía menor, com INSS e IR tirados).
    const raizes = new Set(fontes.map((x) => x.cnpj.slice(0, 8)).filter((r) => r.length === 8));
    const nomesEmp = new Set(fontes.map((x) => norm(x.fonte).split(/\s+/).slice(0, 2).join(' ')).filter(Boolean));
    const prolabore = new Map<string, { fonte: string; cnpj: string; valor: number; inss: number; ir: number; ano: number }>();
    for (const { leitura } of leituras) {
      if (!/IMPOSTO DE RENDA/i.test(String(leitura?.tipo || ''))) continue;
      for (const pe of Array.isArray(leitura?.pessoas) ? leitura.pessoas : []) {
        const mesmo = (dig(pe?.cpf).length === 11 && dig(pe.cpf) === dig(p.cpf)) || (!!pu(pe?.nome) && pu(pe.nome) === pu(p.nome));
        if (!mesmo) continue;
        const ano = Number(pe.anoCalendario || leitura.anoCalendario) || 0;
        for (const fp of Array.isArray(pe.fontesPagadoras) ? pe.fontesPagadoras : []) {
          const valor = Number(fp?.valorAnual);
          const cnpj = dig(fp?.cnpj);
          const daEmpresa = (cnpj.length === 14 && raizes.has(cnpj.slice(0, 8))) || nomesEmp.has(norm(String(fp?.nome || '')).split(/\s+/).slice(0, 2).join(' '));
          if (!(valor > 0) || !daEmpresa) continue;
          const k = cnpj || norm(String(fp.nome || ''));
          const atual = prolabore.get(k);
          if (!atual || ano > atual.ano) prolabore.set(k, { fonte: String(fp.nome || '').trim(), cnpj, valor, inss: Number(fp.contribPrev) || 0, ir: Number(fp.irRetido) || 0, ano });
        }
      }
    }
    const doProlabore = [...prolabore.values()].map((x) => ({ tipo: 'prolabore', empregador: x.fonte || null, cnpj: x.cnpj || null, bruto: r2(x.valor), liquido: r2(x.valor), irRetido: x.ir > 0 ? r2(x.ir) : null, cargo: 'ADMINISTRADOR', admissao: null, competencia: x.ano ? `12/${x.ano}` : null }));
    if (doProlabore.length) console.log(`[Ficha cadastral] pró-labore ${pu(p.nome)}: ${doProlabore.map((x) => `${x.empregador} ${x.bruto}`).join(', ')}`);
    p.contracheques = [...doLucro, ...doProlabore].sort((a, b) => Number(b.bruto) - Number(a.bruto)); // a maior renda primeiro (a 1ª tela da CAIXA leva a profissão dela)
    p.semRenda = false; p.rendaInformal = false;
    p.rendaBrutaMensal = Math.round(p.contracheques.reduce((s: number, x: any) => s + Number(x.bruto), 0) * 100) / 100;
    p.rendaLiquidaMensal = Math.round(p.contracheques.reduce((s: number, x: any) => s + Number(x.liquido), 0) * 100) / 100;
    const maior = p.contracheques[0];
    p.trabalho = { ...(p.trabalho || {}), vinculo: 'EMPRESARIO', empregador: maior.empregador || fontes[0].fonte || null, cnpj: maior.cnpj || fontes[0].cnpj || null, cargo: maior.cargo, admissao: null };
    p.profissao = maior.tipo === 'prolabore' ? 'ADMINISTRADOR' : (p.profissao || 'PROPRIETARIO DE ESTABELECIMENTO COMERCIAL');
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

/** Documentos que a EQUIPE anexou direto no card (cliente sem conversa nem pasta — Fabio 06/11, Windson: "faz o cadastro desse cliente na CAIXA, não
 *  precisa criar pasta"). Ficam no Drive numa pasta técnica "DOCUMENTOS SEM PASTA", ao lado dos anexos do WhatsApp; a ficha lê junto com os da conversa. */
function documentosDaEquipe(cf: Record<string, any>): Arquivo[] {
  return (Array.isArray(cf._documentosEquipe) ? cf._documentosEquipe : [])
    .filter((d: any) => d?.id && d?.mimeType)
    .map((d: any) => ({ id: String(d.id), name: String(d.nome || 'documento'), mimeType: String(d.mimeType), path: 'EQUIPE', size: 0 }));
}

export async function anexarDocumentosEquipe(accountId: string, leadId: string, arquivos: { nome: string; mimeType: string; base64: string }[], userId: string | null): Promise<{ erro: string } | { anexados: string[]; links: (string | null)[] }> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { id: true, name: true } });
  if (!lead) return { erro: 'Lead não encontrado' };
  const validos = arquivos.filter((a) => /pdf|^image\//.test(String(a?.mimeType || '')) && a?.base64);
  if (!validos.length) return { erro: 'Mande PDF ou foto' };
  const conn = await prisma.googleConnection.findUnique({ where: { accountId } });
  const pai = conn?.whatsappAttachmentsFolderId || conn?.rootFolderId;
  if (!conn?.refreshToken || !pai) return { erro: 'Google Drive não conectado' };
  const google = await import('./google.service');
  // Pasta do próprio cliente (a dos anexos do WhatsApp dele) — Fabio 12/11: o card ganha o link dela pra conferência da ficha. Antes ia tudo junto na pasta
  // técnica "DOCUMENTOS SEM PASTA", com o nome do cliente na frente do arquivo.
  const doCliente = await google.leadAttachmentsFolder(accountId, leadId).catch(() => null);
  const pasta = doCliente || await google.createFolder(accountId, 'DOCUMENTOS SEM PASTA', pai);
  const novos: { id: string; nome: string; mimeType: string; em: string; link: string | null }[] = [];
  for (const a of validos) {
    const data = Buffer.from(a.base64, 'base64');
    if (data.length < 500) continue;
    const limpo = String(a.nome || 'documento').replace(/[\\/]/g, '-');
    const nome = (doCliente ? limpo : `${lead.name} - ${limpo}`).slice(0, 180);
    const up = await google.uploadFile(accountId, { name: nome, mimeType: a.mimeType, parentId: pasta.id, data });
    novos.push({ id: up.id, nome: String(a.nome || 'documento'), mimeType: a.mimeType, em: new Date().toISOString(), link: up.webViewLink });
  }
  if (!novos.length) return { erro: 'Arquivos vazios' };
  // Relê na hora de gravar (corrida no customFields).
  const fresh = ((await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }))?.customFields || {}) as Record<string, any>;
  const antes = Array.isArray(fresh._documentosEquipe) ? fresh._documentosEquipe : [];
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...fresh, _documentosEquipe: [...antes, ...novos] } as any } });
  await prisma.note.create({ data: { leadId, ...(userId ? { userId } : {}), type: 'COMMENT', content: `📎 Documentos anexados pela equipe (sem pasta nem conversa):\n${novos.map((n) => `• ${n.nome}${n.link ? ` — ${n.link}` : ''}`).join('\n')}` } }).catch(() => {});
  await linkarPastaDoCadastro(accountId, leadId).catch((e: any) => console.error('[Ficha cadastral] link da pasta:', e?.message));
  return { anexados: novos.map((n) => n.nome), links: novos.map((n) => n.link) };
}

/** Link "cru": a pasta dos anexos do cliente que o CRM ligou ao card pro cadastro da CAIXA, ainda não organizada (sem COMPRADOR/IMÓVEL). Pura. */
export function pastaDoCadastroCrua(cf: Record<string, any> | null | undefined): boolean {
  const link = String(cf?.link_pasta_drive || '').trim();
  return !!link && cf?._pastaCadastroLink === link && !cf?._driveOrganizedAt;
}

/** CADASTRO DA CAIXA: o card ganha o link da pasta do cliente no Drive pra equipe conferir a ficha de cadastro (Fabio 12/11: "pode colocar o link da pasta do
 *  drive, não precisa mover para leads ativos, só coloca o link para a gente fazer a conferência da ficha cadastro"). A pasta é a dos anexos do cliente (a do
 *  WhatsApp: telefone, ou o nome de quem não tem) e os documentos que a equipe anexou no card vão pra dentro dela, com o nome limpo. Nada é criado nem movido em
 *  LEADS ATIVOS: isso continua sendo da organização, na contratação (que reconhece esta pasta como a dos anexos e segue igual). Card que já tem link não muda. */
export async function linkarPastaDoCadastro(accountId: string, leadId: string): Promise<string | null> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  const cf = (lead?.customFields || {}) as Record<string, any>;
  if (!lead || String(cf.link_pasta_drive || '').trim()) return null;
  const google = await import('./google.service');
  const pasta = await google.leadAttachmentsFolder(accountId, leadId);
  if (!pasta) return null;
  for (const d of (Array.isArray(cf._documentosEquipe) ? cf._documentosEquipe : [])) {
    if (!d?.id) continue;
    await google.putFileInFolder(accountId, String(d.id), pasta.id, String(d.nome || '').trim() || undefined).catch((e: any) => console.error('[Ficha cadastral] documento da equipe fora da pasta do cliente:', e?.message));
  }
  const patch = JSON.stringify({ link_pasta_drive: pasta.link, _pastaCadastroLink: pasta.link });
  const mudou = await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = COALESCE("customFields", '{}'::jsonb) || ${patch}::jsonb WHERE id = ${leadId} AND COALESCE("customFields"->>'link_pasta_drive', '') = ''`;
  if (!mudou) return null;
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `📁 Pasta do cliente no Drive ligada ao card, pra conferência da ficha de cadastro (ela continua onde está — não foi pra LEADS ATIVOS): ${pasta.link}` } }).catch(() => {});
  return pasta.link;
}

/** Lê UM documento pessoal (RG/CNH/comprovante…) que o cliente mandou na conversa, pelo arquivo no Drive — usado pela proposta montada com os documentos (proposta-documento.service). */
export async function lerDocumentoPessoal(accountId: string, f: { driveFileId: string; fileName: string; mimeType: string }): Promise<any | null> {
  return lerArquivo(accountId, { id: f.driveFileId, name: f.fileName, mimeType: f.mimeType, path: 'CONVERSA', size: 0 });
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

const SYSTEM_NOMES = `Você confere a GRAFIA dos nomes impressos num documento de identidade brasileiro (RG, CIN ou CNH). As imagens são recortes ampliados do MESMO documento em quatro orientações (0°, 90°, 180° e 270°): o RG antigo aberto costuma vir deitado, com o texto de cada página virado pra um lado. Use SÓ os recortes em que o texto que você vai ler está DE PÉ e leia LETRA POR LETRA — letras parecidas enganam (m/n, rn/m, i/l, u/v, c/e, a/o, h/b). Copie o que está impresso, sem corrigir nem completar, mesmo que o nome pareça incomum.
Responda SOMENTE com JSON, sem texto antes ou depois:
{"soletrado":{"nome":"<letra por letra, com hífen entre as letras e espaço entre as palavras>","pai":"...","mae":"..."},"nome":"<nome do titular>","pai":"<nome do pai>","mae":"<nome da mãe>"}
Nome que o documento não traz ou que você não consegue ler com segurança = null (nos dois lugares).`;

/** Documento de identidade em foto/escaneado: relê os nomes (titular, pai e mãe) com o documento de pé e ampliado e fica a grafia mais votada entre a 1ª leitura,
 *  a releitura e o que os outros documentos trazem (Fabio 12/11: o RG escaneado deitado foi lido "Rosa Belen" duas vezes; no documento, na certidão de casamento
 *  e na CAIXA é "Rosa Belem" — a ficha ficava com o erro e o cadastro ia trocar o nome certo da CAIXA). Corrige a própria leitura, antes da junção; o que mudou
 *  vai na observação dela. PDF de texto (CNH digital) não tem foto pra reler e fica como está. */
export async function conferirNomesDasIdentidades(accountId: string, lidos: { f: Arquivo; leitura: any }[], nomesDoCard: string[]): Promise<void> {
  const { recortesDePe, grafiaMaisVotada, mesmoNome, quaseOMesmoNome } = require('./identidade-de-pe') as typeof import('./identidade-de-pe');
  const google = await import('./google.service');
  const ids = lidos
    .filter((x) => /^(RG|CNH)$/i.test(String(x.leitura?.tipo || '').trim()) && Array.isArray(x.leitura.pessoas) && x.leitura.pessoas.length === 1)
    .filter((x) => (x.f.mimeType === 'application/pdf' ? x.f.size <= MAX_PDF : /^image\//.test(x.f.mimeType)))
    .slice(0, 6);
  await Promise.all(ids.map(async ({ f, leitura }) => {
    try {
      const pessoa = leitura.pessoas[0] || {};
      if (!pessoa.nome && !pessoa.pai && !pessoa.mae) return;
      const { buffer, mimeType } = f.mimeType === 'application/pdf'
        ? { buffer: await google.downloadDriveFile(accountId, f.id, f.mimeType), mimeType: f.mimeType }
        : await google.downloadDriveFileForVision(accountId, f.id, f.mimeType);
      const recortes = await recortesDePe(buffer, mimeType);
      if (!recortes.length) return;
      const outras = lidos.filter((x) => x.leitura !== leitura).flatMap((x) => (Array.isArray(x.leitura?.pessoas) ? x.leitura.pessoas : []));
      const vistos: Record<'nome' | 'pai' | 'mae', unknown[]> = {
        nome: [...outras.flatMap((p: any) => [p?.nome, p?.conjuge?.nome]), ...nomesDoCard],
        pai: outras.map((p: any) => p?.pai),
        mae: outras.map((p: any) => p?.mae),
      };
      const rotulo = { nome: 'nome', pai: 'pai', mae: 'mãe' } as const;
      const campos = ['nome', 'pai', 'mae'] as const;
      // Grafia parecida que outro documento traz: a IA diz qual das duas está impressa NESTE (pode não ser nenhuma).
      const parecidas = campos.flatMap((c) => [...new Set(vistos[c].filter((v) => quaseOMesmoNome(v, pessoa[c])).map((v) => String(v).trim()))].map((v) => `${rotulo[c]}: "${pessoa[c]}" ou "${v}"`));
      const content: any[] = recortes.flatMap((r, i) => [{ type: 'text', text: `Recorte ${i + 1} (${r.rotulo}):` }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: r.jpeg.toString('base64') } }]);
      content.push({ type: 'text', text: `A primeira leitura deste documento, feita com ele como foi enviado, trouxe — nome: ${JSON.stringify(pessoa.nome ?? null)}; pai: ${JSON.stringify(pessoa.pai ?? null)}; mãe: ${JSON.stringify(pessoa.mae ?? null)}.${parecidas.length ? `\nOutro documento do cliente traz grafia parecida — diga qual está impressa NESTE documento (pode não ser nenhuma das duas): ${parecidas.join('; ')}.` : ''}\nConfira cada nome no documento.` });
      const r = await chamarIA(SYSTEM_NOMES, content, 4096);
      if (!r) { console.error('[Ficha cadastral] releitura dos nomes da identidade não respondeu'); return; }
      const mudou: string[] = [];
      for (const c of campos) {
        const antes = pessoa[c];
        const fica = grafiaMaisVotada(antes, r[c], vistos[c]);
        if (fica && antes && !mesmoNome(fica, antes)) { pessoa[c] = fica; mudou.push(`${rotulo[c]} "${antes}" → "${fica}"`); }
      }
      if (!mudou.length) return;
      leitura.observacao = `${String(leitura.observacao || '').trim()} Nomes conferidos com o documento de pé e ampliado (a 1ª leitura, com o texto de lado, trocou letra): ${mudou.join('; ')}.`.trim();
      console.log(`[Ficha cadastral] releitura da identidade corrigiu ${mudou.length} nome(s)`);
    } catch (e: any) { console.error('[Ficha cadastral] releitura dos nomes', e?.message); }
  }));
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
  add('Trabalho', [t.vinculo && `${t.vinculo}${t.esfera ? ` ${t.esfera}` : ''}`, t.empregador && `${t.empregador}${t.cnpj ? ` (CNPJ ${t.cnpj})` : ''}`, t.cargo && `cargo ${t.cargo}`, t.admissao && `admissão ${t.admissao}`].filter(Boolean).join(' — ') || null);
  const chs = Array.isArray(p.contracheques) ? p.contracheques.filter((c: any) => c && (c.bruto || c.liquido)) : [];
  if (chs.length) add('Contracheques', chs.map((c: any) => `${c.competencia || '?'}${c.empregador ? ` ${c.empregador}` : ''}: bruto ${brl(c.bruto) || '—'} / líquido ${brl(c.liquido) || '—'}${comVerbas(c) ? ` (com ${c.verbasEventuais.join(', ')})` : ''}`).join('; '));
  if (p.semRenda) add('Renda', 'SEM RENDA (no cadastro da CAIXA: marcar sem renda e salvar)');
  add('Renda mensal', [brl(p.rendaBrutaMensal) && `bruta ${brl(p.rendaBrutaMensal)}`, brl(p.rendaLiquidaMensal) && `líquida ${brl(p.rendaLiquidaMensal)}`].filter(Boolean).join(' / ') || null);
  const outras = Array.isArray(p.outrasRendas) ? p.outrasRendas.filter((o: any) => o && brl(o.valor)) : [];
  if (outras.length) add('Outras rendas', outras.map((o: any) => `${o.tipo || 'outra'} ${brl(o.valor)}`).join('; '));
  add('Patrimônio (IR)', brl(p.patrimonioTotal));
  if (Array.isArray(p.faltando) && p.faltando.length) L.push(`⚠️ Não achei nos documentos: ${p.faltando.join(', ')}`);
  return L.join('\n');
}

/** Contracheque com verba eventual (férias, 13º, PLR, saque de plano, rescisão) dentro do bruto/líquido — Fabio 31/10: vale sempre o valor impresso, mas o
 *  cadastro prefere outro contracheque válido sem essas verbas. */
const comVerbas = (c: any) => Array.isArray(c?.verbasEventuais) && c.verbasEventuais.some((v: unknown) => String(v ?? '').trim());

/** BRB (Fabio 27/10): renda = SOMA dos LÍQUIDOS de todos os contracheques num campo só — o mais recente de cada fonte pagadora (desde 31/10, o mais recente
 *  SEM verba eventual, que agora vem dentro do líquido; só com esse, ele). */
function liquidoBrb(p: any): { total: number; partes: string[] } {
  const ultimo = new Map<string, any>();
  const mes = (c: string) => { const m = /(\d{1,2})\/(\d{4})/.exec(String(c || '')); return m ? Number(m[2]) * 100 + Number(m[1]) : 0; };
  for (const c of Array.isArray(p.contracheques) ? p.contracheques : []) {
    if (!c || !(Number(c.liquido) > 0)) continue;
    const k = norm(String(c.empregador || 'contracheque')).split(' ').slice(0, 2).join(' ');
    const atual = ultimo.get(k);
    if (!atual || (comVerbas(atual) && !comVerbas(c)) || (comVerbas(atual) === comVerbas(c) && mes(c.competencia) > mes(atual.competencia))) ultimo.set(k, c);
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
    const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { id: true, name: true, customFields: true, stage: { select: { name: true } }, pipeline: { select: { department: { select: { name: true } } } } } });
    if (!lead) return 'Lead não encontrado';
    const cf = (lead.customFields || {}) as Record<string, any>;
    // Cônjuge como participante da ficha só no cadastro da CAIXA (Fabio 12/11) — fora dele (Inter, Santander, Creditas, Itaú…) a ficha fica só com os participantes do card.
    const cadastroCaixa = !!cf._caixaRota || !!cf._caixaCadastro || !!cf._optouCaixa?.banco || !!cf._fhDocsCompradorAt || !!cf._caixaDocsAt || /^an[aá]lise\s+caixa/i.test(String(lead.stage?.name || ''));
    // Link "cru" (a pasta dos anexos ligada ao card pro cadastro da CAIXA): lê como card sem pasta — conversa + o que a equipe anexou.
    const link = pastaDoCadastroCrua(cf) ? '' : String(cf.link_pasta_drive || '').trim();
    const google = await import('./google.service');
    // Com a pasta, os anexos da conversa já estão nela (organizados). Sem a pasta (Fabio 31/10: "o CRM deve coletar os dados para o cadastro através da
    // documentação encaminhada na própria conversa"): os anexos que o cliente mandou na conversa, que ficam no Drive pelo driveFileId.
    const todos: Arquivo[] = link ? await google.listAllFilesInFolderTree(accountId, google.extractFolderId(link), 3) : [...(await anexosDaConversa(leadId)), ...documentosDaEquipe(cf)];
    const arquivos = arquivosPessoais(todos);
    if (!arquivos.length) return link ? 'Não achei documento pessoal (PDF/foto) na pasta do Drive' : 'O card não tem a pasta do Drive nem documento (PDF/foto) na conversa';
    const origem = link ? 'da pasta do Drive' : documentosDaEquipe(cf).length ? 'anexados pela equipe/enviados na conversa' : 'enviados na conversa';

    // 1) Cada arquivo sozinho, 4 de cada vez.
    const leituras: { arquivo: string; leitura: any }[] = [];
    const comArquivo: { f: Arquivo; leitura: any }[] = [];
    const naoLidos: string[] = [];
    for (let i = 0; i < arquivos.length; i += 4) {
      const lote = arquivos.slice(i, i + 4);
      const r = await Promise.all(lote.map((f) => lerArquivo(accountId, f).catch(() => null)));
      r.forEach((leitura, k) => { if (leitura && Array.isArray(leitura.pessoas)) { leituras.push({ arquivo: lote[k].name, leitura }); comArquivo.push({ f: lote[k], leitura }); } else naoLidos.push(lote[k].name); });
    }
    // 1b) RG/CNH em foto: os nomes (titular, pai e mãe) relidos com o documento de pé e ampliado, antes de juntar (Fabio 12/11: "Belem" lido "Belen").
    await conferirNomesDasIdentidades(accountId, comArquivo, [1, 2, 3].map((n) => String(cf[`participante_${n}`] || '')).filter(Boolean));
    const pessoais = leituras.filter((x) => !/DOCUMENTO DO IMOVEL/i.test(String(x.leitura.tipo || '')));
    if (!pessoais.length) return 'Não consegui ler nenhum documento pessoal da pasta';

    // 2) Junta por participante.
    const participantesCard = [1, 2, 3].map((n) => ({ ordem: n, nome: cf[`participante_${n}`] || null, cpf: String(cf[`cpf_${n}`] || '').replace(/\D/g, '') || null })).filter((p) => p.nome || p.cpf);
    const usaFgts = /^(s|sim|true|1)/i.test(String(cf.usa_fgts ?? '').trim());
    // Normativo CR016 da Base de Conhecimento (Fabio 31/10): só aponta, não mexe na renda que as regras da A&F montam.
    const juntaComCr016 = comRegrasCaixa(SYSTEM_JUNTA, await regrasRendaCaixa(accountId), 'Na FICHA as regras da A&F acima mandam na renda; o normativo serve pra apontar em "conflitos" (1 frase cada, começando com "CR016:") o comprovante de renda que a CAIXA não aceita e por quê, e a renda que só um comprovante fora de contracheque/IR/benefício comprova (extrato do FGTS, aluguel, aplicação, nota fiscal rural, conta salário), com o valor pela regra do normativo — essa a equipe lança à mão. Não mude "contracheques", "semRenda", "rendaInformal" nem "faltando" por causa do normativo.');
    const ficha = await chamarIA(juntaComCr016, [{ type: 'text', text: `Hoje é ${hoje()} (documento de 2026 não é "data futura").\nUSA FGTS: ${usaFgts ? 'sim' : 'não'}\nCADASTRO NA CAIXA: ${cadastroCaixa ? 'sim' : 'não'}\n\nPARTICIPANTES DO CARD:\n${JSON.stringify(participantesCard)}\n\nLEITURAS DOS DOCUMENTOS:\n${JSON.stringify(pessoais).slice(0, 180_000)}` }], 16000);
    if (!ficha || !Array.isArray(ficha.participantes) || !ficha.participantes.length) return 'Não consegui montar a ficha com as leituras';
    // Rede de segurança: fora do cadastro da CAIXA, cônjuge incluído pela junção sai da lista (a regra é só da CAIXA).
    if (!cadastroCaixa) ficha.participantes = ficha.participantes.filter((p: any) => p && p.conjugeIncluido !== true);
    if (!ficha.participantes.length) return 'Não consegui montar a ficha com as leituras';
    rendaDeSocio(ficha.participantes, pessoais);
    // RG com frente e verso separados: a data do verso (sem nome) vai pra pessoa do mesmo número/CPF (Fabio 10/11, Sueli).
    ficha.participantes = comEmissaoDoRg(ficha.participantes, pessoais, cf._docReview);
    // Sexo (Fabio 06/11): o "Gênero" do card posto pela equipe manda; senão o do documento; documento sem sexo (RG antigo/CNH não trazem) = o do card ou o primeiro nome.
    for (const p of ficha.participantes) { const s = sexoParaFormulario(cf, p?.nome, /^[MF]$/.test(String(p?.sexo || '')) ? p.sexo : null); if (s) p.sexo = s; }
    await completarSocios(ficha.participantes).catch((e) => console.error('[Ficha cadastral] sócio:', e?.message));

    const agora = new Date();
    const registro = { at: agora.toISOString(), usaFgts, participantes: ficha.participantes, conflitos: Array.isArray(ficha.conflitos) ? ficha.conflitos : [], observacao: String(ficha.observacao || ''), arquivos: pessoais.map((x) => ({ nome: x.arquivo, tipo: x.leitura.tipo })), naoLidos };
    const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
    await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...((fresh?.customFields || {}) as Record<string, unknown>), _fichaCadastral: registro } as any } });
    // A renda bruta lida dos comprovantes vai pro card (Fabio 05/11).
    await (require('./renda-comprovante.service') as typeof import('./renda-comprovante.service')).atualizarRendaPeloComprovante(leadId).catch((e: any) => console.error('[Renda comprovante]', e?.message || e));
    // Nome certo pelos documentos (Fabio 13/11): participantes, card e pasta do Drive com o nome completo do documento — só quando é a mesma pessoa (CPF ou nome que contém o do card).
    await (require('./nome-pelo-documento.service') as typeof import('./nome-pelo-documento.service')).renomearPelosDocumentos(accountId, leadId).catch((e: any) => console.error('[Nome pelo documento]', e?.message || e));

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
    // Card sem pasta: liga a pasta dos anexos do cliente, só o link, pra equipe conferir a ficha (Fabio 12/11).
    await linkarPastaDoCadastro(accountId, leadId).catch((e: any) => console.error('[Ficha cadastral] link da pasta:', e?.message));
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
const ORGAO_PUBLICO = /\b(min|ministerio|secretaria|prefeitura|municipio|governo|tribunal|camara|assembleia|senado|policia|universidade federal|instituto federal|inss|ibama|incra|embrapa|detran|exercito|marinha|aeronautica|comando da|forca aerea|defensoria|procuradoria|ministerio publico|advocacia geral)\b/i;
export async function pedirCnpjAoCliente(accountId: string, leadId: string, participantes: any[], _io?: Io): Promise<void> {
  const faltas = faltasDeRenda(participantes);
  if (!faltas.length) return;
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const ja = (((lead?.customFields || {}) as Record<string, any>)._fichaCnpjPedido || {}) as Record<string, string>;
  const novas = faltas.filter((f) => !ja[f.chave] || /^pendente:/.test(ja[f.chave]));
  if (!novas.length) return;
  const lista = novas.map((f) => f.texto).join('; ');
  // Órgão público (Fabio 11/11, Deborah: o contracheque do SIGEPE não traz CNPJ): quem declara IR manda a declaração (Fabio 12/11: "é mais prático"); servidor
  // novo, ainda sem IR, confirma o CNPJ com a
  // instituição — nunca CNPJ achado na internet.
  const orgaoPublico = novas.some((f) => f.cnpj && ORGAO_PUBLICO.test(f.chave.normalize('NFD').replace(/[̀-ͯ]/g, '')));
  const texto = `Para concluir o seu cadastro no banco, preciso de: ${lista}.${!novas.some((f) => f.cnpj) ? '' : orgaoPublico ? ' Se você já declara Imposto de Renda, pode me mandar a declaração completa, que lá consta o CNPJ. Se ainda não declara, o CNPJ do órgão você consegue com o RH (setor de pessoal) da sua instituição — me manda escrito, por favor, que não pode ter erro no cadastro.' : ' O CNPJ aparece no contracheque ou no informe de rendimentos — se preferir, pode me mandar a declaração completa do seu Imposto de Renda, que lá também consta.'}`;
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
  // Card com ficha de cadastro (ou documento anexado pela equipe) e ainda sem o link da pasta: liga a pasta do cliente, um por rodada (Fabio 12/11). Sem Drive
  // ou com erro, tenta de novo só depois de 6 h.
  const semLink = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false AND "isGroup" = false
      AND COALESCE("customFields"->>'link_pasta_drive', '') = ''
      AND ("customFields"->'_fichaCadastral' IS NOT NULL OR (jsonb_typeof("customFields"->'_documentosEquipe') = 'array' AND jsonb_array_length("customFields"->'_documentosEquipe') > 0))
      AND COALESCE("customFields"->>'_pastaCadastroErro', '') < ${new Date(Date.now() - 6 * 3600_000).toISOString()}
    ORDER BY "updatedAt" DESC LIMIT 1`.catch(() => []);
  if (semLink[0]) {
    const feito = await linkarPastaDoCadastro(accountId, semLink[0].id).catch((e: any) => { console.error('[Ficha cadastral] link da pasta:', e?.message); return null; });
    if (!feito) await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = COALESCE("customFields", '{}'::jsonb) || ${JSON.stringify({ _pastaCadastroErro: new Date().toISOString() })}::jsonb WHERE id = ${semLink[0].id}`.catch(() => {});
    else io?.to(`lead:${semLink[0].id}`).emit('lead_updated', { leadId: semLink[0].id });
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
        -- Pediu a CAIXA (HE e FH) com a documentação conferida na Pré-Análise — Fabio 01/11.
        OR ((l."customFields"->>'_fhDocsCompradorAt' IS NOT NULL OR l."customFields"->>'_caixaDocsAt' IS NOT NULL) AND l."customFields"->'_fichaCadastral' IS NULL)
        -- Card na etapa "Análise CAIXA" (Fabio 11/11: "rodar o cadastro sozinho sempre que tiver todos os documentos ou todas as informações"): com documento pra
        -- ler (anexado pela equipe, pasta do Drive ou conferido na conversa) e ainda sem ficha → lê já, sem esperar a conferência da documentação fechar. O cadastro
        -- só sai com a ficha completa (faltaParaCadastro); dado que falta e a equipe informa também solta.
        OR (s.name ILIKE 'An_lise CAIXA%' AND l."customFields"->'_fichaCadastral' IS NULL
          AND ((jsonb_typeof(l."customFields"->'_documentosEquipe') = 'array' AND jsonb_array_length(l."customFields"->'_documentosEquipe') > 0)
            OR COALESCE(l."customFields"->>'link_pasta_drive', '') LIKE 'http%'
            OR (jsonb_typeof(l."customFields"->'_docReview') = 'object'
              AND EXISTS (SELECT 1 FROM jsonb_each(l."customFields"->'_docReview') dr WHERE COALESCE(dr.value->>'resultado', '') <> 'NAO_DOCUMENTO'))))
        -- Fora da contratação não há pasta organizada: na rota da CAIXA (Pré-Análise) ou com a renda dos dois do casal pedida (renda-casal, OS_DOIS), arquivo novo na
        -- conversa depois da ficha → lê de novo quando ela tem dado faltando ou falta a renda do outro (Fabio 01/11).
        OR (l."customFields"->'_fichaCadastral'->>'at' IS NOT NULL
          AND (l."customFields"->'_caixaRota' IS NOT NULL OR s.name ILIKE 'An_lise CAIXA%' OR l."customFields"->'_rendaCasal'->>'status' = 'OS_DOIS')
          AND (EXISTS (SELECT 1 FROM "MessageAttachment" a JOIN "Message" m ON m.id = a."messageId"
              WHERE a."leadId" = l.id AND m.direction = 'INBOUND' AND a."mimeType" !~ '^(audio|video)/' AND a."createdAt" > (l."customFields"->'_fichaCadastral'->>'at')::timestamptz)
            -- documento que a equipe anexou no card depois da ficha (datas em ISO: comparam como texto)
            OR (jsonb_typeof(l."customFields"->'_documentosEquipe') = 'array'
              AND EXISTS (SELECT 1 FROM jsonb_array_elements(l."customFields"->'_documentosEquipe') de WHERE de->>'em' > l."customFields"->'_fichaCadastral'->>'at')))
          AND (l."customFields"->'_rendaCasal'->>'status' = 'OS_DOIS'
            OR (jsonb_typeof(l."customFields"->'_fichaCadastral'->'participantes') = 'array'
              AND EXISTS (SELECT 1 FROM jsonb_array_elements(l."customFields"->'_fichaCadastral'->'participantes') fp
                WHERE jsonb_typeof(fp->'faltando') = 'array' AND jsonb_array_length(fp->'faltando') > 0)))))
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
