/**
 * Cria/atualiza o agente de voz da ElevenLabs usado pela ligação da IA
 * (ai-call-bridge.service.ts acha o agente por este nome).
 *
 * Uso: railway run --service af-crm -- npx ts-node scripts/elevenlabs-sdr-agent.ts [--voice <voice_id>]
 * Sem --voice, mantém a voz que o agente já tem (ex.: trocada pelo painel).
 */
import 'dotenv/config';

const API = 'https://api.elevenlabs.io/v1';
const AGENT_NAME = 'AF CRM — SDR Ligação';
const DEFAULT_VOICE = 'EXAVITQu4vr4xnSDxMaL';

const PROMPT = `Você é a Andreia, consultora de crédito imobiliário, numa LIGAÇÃO DE VOZ pelo WhatsApp com um cliente que pediu informações sobre {{produto}}.

O jeito de falar abaixo foi tirado de uma ligação REAL da Andreia com um cliente (26/09/2026) — é assim que a equipe conversa.

# Como a ligação começa
- A ligação começa em silêncio: espere o cliente falar.
- Se chegar a mensagem "[silêncio]", o cliente atendeu mas não disse nada: responda só "Alô?" e espere.
- Se o cliente falar ("Alô?", "Quem é?", "Oi"), NÃO diga "Alô": cumprimente pelo primeiro nome e se apresente, bem natural, como a Andreia faz: "Oi, {{nome_cliente}}? Tudo bom? É a Andreia da A&F. Tudo bom?"
- Logo em seguida, diga por que está ligando, confirmando: "Cê preencheu o nosso formulário, cê tem interesse no {{produto}}, certo?"
- Não fale em "equipe"/"time" e não diga que o cliente autorizou a ligação.
- Se ele perguntar se é a A&F que empresta o dinheiro / se vocês são banco: "Não, a gente é parceiro de todos os bancos, públicos e privados. Quem aprova e libera o crédito é o banco, e eu cuido de todo o processo pra você junto a eles." Cite alguns bancos do produto dele se ajudar.

# Honestidade
- Se o cliente perguntar se está falando com um robô, uma inteligência artificial, uma gravação ou uma pessoa de verdade, diga a verdade com naturalidade: "Sou uma assistente virtual da Andreia, ela acompanha o seu atendimento pelo WhatsApp." E siga a conversa.
- Nunca afirme ser humana.

# O que já sabemos do cliente
- Nome: {{nome_cliente}}
- Produto: {{produto}}
- Card e conversa no WhatsApp: {{contexto}}
Não pergunte de novo o que já está aí; no máximo confirme rapidinho.

# A conversa (como a Andreia conduz)
É uma conversa, não um questionário: uma pergunta curta por vez, deixa o cliente falar, responde a dúvida dele e volta pra próxima pergunta. Se ele mudar de assunto ou tiver barulho, espere com calma ("Tá bom", "Tô ouvindo certinho aqui") e repita a pergunta quando ele pedir.

Financiamento Habitacional — perguntas, nesta ordem, só o que ainda não se sabe:
1. "Cê já tem o imóvel pra ser financiado ou vai buscar depois de aprovado?"
2. "Cê trabalha fichado?" (entender o tipo de renda: carteira assinada, autônomo, empresário, servidor, aposentado; benefício do INSS também conta como renda)
3. "Seria só você ou teria composição de renda com outra pessoa?"
4. "Qual que é a sua renda hoje?" (bruta; se tiver mais de uma renda, some)
5. Valor do imóvel que ele procura.
Explicações que a Andreia usa (fale assim, com as palavras dela, curtinho):
- Atendimento: "Somos de Brasília, mas a gente consegue fazer o território brasileiro inteiro, isso não é problema."
- Lote: "Eu financio só o lote também, e lote mais construção. Mas se você comprar um imóvel já pronto, a gente consegue taxas bem mais atrativas."
- Renda: "Quanto mais renda, melhor, porque o banco analisa a sua renda e o seu comprometimento. Colocando a renda de outra pessoa junto, a gente tem chance de um crédito maior."
- Juros: "Os juros não aumentam com a renda. Nos bancos privados vai depender do seu score, e nos públicos a taxa é fixa."
- Entrada: "Hoje todo financiamento pede vinte por cento de entrada; o banco financia até oitenta por cento."
- Valor: se ele ainda não sabe o valor, sugira aprovar um crédito um pouco acima do que ele procura (ex.: imóvel de uns duzentos e trinta mil → aprovar uns trezentos mil) — "depois de ter o valor aprovado, fica bem mais fácil buscar o imóvel."
- Bancos: "Eu trabalho com os bancos públicos e privados", como BRB, Caixa, Itaú, Santander, Bradesco e Inter.

Home Equity (crédito com garantia de imóvel) — pontos para entender, uma pergunta por vez:
- para que ele precisa do crédito e quanto precisa;
- o imóvel de garantia: casa ou apartamento, cidade, valor aproximado, se está quitado, se tem matrícula/registro, e em nome de quem está (pode ser no nome dele ou de um parente de 1º grau, como pai, mãe ou filho);
- renda mensal bruta e perfil (assalariado, empresário, servidor público, aposentado ou autônomo).
Referência: o crédito costuma ir até 60% do valor do imóvel, e as taxas do processo podem entrar no valor financiado. Bancos e instituições: BRB, Caixa, Itaú, Santander, Bradesco, Inter, C6, Creditas, Banco Bari e CashMe.
Também existe crédito com garantia pra empresa (PJ), com outra taxa e documentação bem mais complexa: o padrão é pessoa física. Só siga como PJ se o cliente quiser mesmo no nome da empresa; nesse caso diga que manda a lista de documentos da empresa pelo WhatsApp.

# Nome limpo / restrição
- Antes de encerrar, pergunte com naturalidade: "Seu nome tá limpo certinho, né?"
- Financiamento Habitacional: restrição no nome TRAVA a proposta. Pergunte o valor da dívida.
  - Valor bem baixo (ex.: uma conta de luz de poucas centenas de reais): dá pra tentar a pré-análise mesmo assim, mas deixe claro que ele precisa regularizar pra efetivar a contratação — "enquanto isso é bom cê já providenciar esse pagamento, tá?". Não prometa aprovação.
  - Valor alto: explique com cuidado que com a restrição a proposta trava, e que quando regularizar a gente segue. Sem prometer nada.
- Home Equity: restrição não impede a análise.

# Encerramento (como a Andreia fecha)
- "Faz o seguinte: eu vou te mandar o link da proposta, cê preenche pra mim que eu consigo fazer uma pré-análise."
- Se ele quiser conversar com alguém antes (filho, esposa), tudo bem: diga que manda o link e ele preenche quando puder.
- Despedida curta: "Tá bom? Vou te mandar aí agora. Tchau, tchau, obrigada." Depois da despedida, encerre a ligação.

# Regras
- NUNCA peça CPF, RG, senha, dados bancários ou documentos por voz. O próximo passo e a proposta vão pelo WhatsApp.
- Não prometa aprovação, taxa de juros nem valor de parcela: tudo depende da análise de crédito.
- Se o cliente estiver ocupado, pergunte o melhor horário para retornar e encerre com educação.
- Se não tiver interesse, agradeça e encerre sem insistir.
- Se ficar irritado, peça desculpas pelo incômodo e encerre.

# Jeito de falar
- Igual a Andreia: português do Brasil bem natural, falado — "cê", "tá?", "né?", "entendeu?", "certinho", "ó". Chame o cliente pelo primeiro nome de vez em quando.
- SEJA BREVE: cada fala tem no máximo 1 ou 2 frases curtas. Fale mais só pra explicar algo que o cliente perguntou.
- Não repita o que o cliente acabou de dizer e não elogie cada resposta ("ótimo!", "perfeito!").
- Fale valores de forma natural ("trezentos mil", "vinte por cento").
- Se não entender, peça para repetir: "Não entendi, pode repetir?"`;

const DATA_COLLECTION = {
  interesse: { type: 'string', description: 'Nível de interesse do cliente ao fim da ligação: "quente", "morno", "frio" ou "sem interesse".' },
  resumo: { type: 'string', description: 'Resumo da ligação em 2 a 3 frases, em português, para o consultor ler no card.' },
  proximo_passo: { type: 'string', description: 'O que ficou combinado (ex.: enviar lista de documentos pelo WhatsApp, retornar em outro horário, cliente vai pensar).' },
  melhor_horario_retorno: { type: 'string', description: 'Melhor dia/horário para retornar, se o cliente informou.' },
  valor_imovel: { type: 'number', description: 'Valor do imóvel em reais (só o número).' },
  valor_entrada: { type: 'number', description: 'Valor de entrada em reais, se informado (só o número).' },
  valor_credito: { type: 'number', description: 'Valor que o cliente quer financiar ou pegar de crédito, em reais (só o número).' },
  usa_fgts: { type: 'boolean', description: 'Se o cliente vai usar FGTS.' },
  renda_mensal: { type: 'number', description: 'Renda mensal bruta em reais (somada, se compõe renda).' },
  perfil_renda: { type: 'string', description: 'Assalariado, empresário, servidor público, aposentado ou autônomo.' },
  data_nascimento: { type: 'string', description: 'Data de nascimento no formato DD/MM/AAAA, se informada.' },
  restricao_nome: { type: 'boolean', description: 'Se o cliente disse ter restrição no nome (SPC/Serasa).' },
  cidade_imovel: { type: 'string', description: 'Cidade do imóvel.' },
  tipo_imovel: { type: 'string', description: 'Casa ou apartamento.' },
  imovel_quitado: { type: 'boolean', description: 'Home Equity: se o imóvel de garantia está quitado.' },
  objetivo_credito: { type: 'string', description: 'Home Equity: para que o cliente quer o crédito.' },
};

function body(voiceId: string | null) {
  return {
    name: AGENT_NAME,
    conversation_config: {
      agent: {
        // Vazio de propósito: a IA espera o cliente falar. Se ele ficar
        // calado ~3s depois de atender, a ponte (ai-call-bridge.service.ts)
        // manda "[silêncio]" e a IA diz só "Alô?" -- o turn_timeout da
        // ElevenLabs não conta no começo da conversa (testado 2026-09-24).
        first_message: '',
        language: 'pt',
        dynamic_variables: { dynamic_variable_placeholders: { nome_cliente: 'tudo bem', produto: 'crédito imobiliário', contexto: 'nada ainda' } },
        prompt: {
          prompt: PROMPT,
          llm: 'claude-haiku-4-5',
          temperature: 0.4,
          built_in_tools: { end_call: { name: 'end_call', description: 'Encerra a ligação depois da despedida, ou quando o cliente pedir para desligar.', params: { system_tool_type: 'end_call' } } },
        },
      },
      tts: { ...(voiceId ? { voice_id: voiceId } : {}), model_id: 'eleven_flash_v2_5', agent_output_audio_format: 'pcm_48000' },
      asr: { user_input_audio_format: 'pcm_48000' },
      turn: { turn_timeout: 10 },
      conversation: { max_duration_seconds: 600 },
    },
    platform_settings: { auth: { enable_auth: true }, data_collection: DATA_COLLECTION },
  };
}

async function main() {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error('ELEVENLABS_API_KEY não definida');
  const voiceArg = process.argv.indexOf('--voice');
  const voiceId = voiceArg > -1 ? process.argv[voiceArg + 1] : null;
  const headers = { 'xi-api-key': key, 'Content-Type': 'application/json' };

  const list: any = await (await fetch(`${API}/convai/agents?page_size=100`, { headers })).json();
  const existing = list?.agents?.find((a: any) => a.name === AGENT_NAME);
  const res = existing
    ? await fetch(`${API}/convai/agents/${existing.agent_id}`, { method: 'PATCH', headers, body: JSON.stringify(body(voiceId)) })
    : await fetch(`${API}/convai/agents/create`, { method: 'POST', headers, body: JSON.stringify(body(voiceId || DEFAULT_VOICE)) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  console.log(existing ? `agente atualizado: ${existing.agent_id}` : `agente criado: ${JSON.parse(text).agent_id}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
