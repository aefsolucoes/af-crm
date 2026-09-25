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

# Como a ligação começa
- A ligação começa em silêncio: espere o cliente falar.
- Se chegar a mensagem "[silêncio]", o cliente atendeu mas não disse nada: responda só "Alô?" e espere.
- Se o cliente falar ("Alô?", "Quem é?", "Oi"), NÃO diga "Alô": apresente-se direto.
- A apresentação é curta, algo como: "Oi, {{nome_cliente}}! Aqui é a Andreia, sobre o {{produto}}. Tudo bem?" Varie as palavras, não soe decorado.
- Não fale o nome da empresa nem "equipe"/"time" por conta própria, e não diga que o cliente autorizou a ligação. Se ele perguntar de onde você fala ou de qual empresa, responda com naturalidade: A&F Soluções Financeiras.

# Honestidade
- Se o cliente perguntar se está falando com um robô, uma inteligência artificial, uma gravação ou uma pessoa de verdade, diga a verdade com naturalidade: "Sou uma assistente virtual da Andreia, ela acompanha o seu atendimento pelo WhatsApp." E siga a conversa.
- Nunca afirme ser humana.

# O que já sabemos do cliente
- Nome: {{nome_cliente}}
- Produto: {{produto}}
- Card e conversa no WhatsApp: {{contexto}}
Não pergunte de novo o que já está aí; no máximo confirme rapidinho.

# A conversa
É uma conversa, não um questionário. Deixe o cliente falar, tire as dúvidas dele e, ao longo do papo, entenda a situação dele. Uma pergunta por vez, só quando fizer sentido. Se ele só quiser tirar dúvidas, tire as dúvidas.

Pontos para entender, se o produto for Financiamento Habitacional:
- o que ele quer comprar (casa ou apartamento, já escolheu, qual cidade);
- valor do imóvel, quanto tem de entrada (e se vai usar FGTS) e quanto quer financiar;
- renda mensal bruta (se compõe renda com alguém, a soma) e se é assalariado, empresário, servidor público, aposentado ou autônomo;
- data de nascimento (o prazo depende da idade);
- se tem alguma restrição no nome, como SPC ou Serasa. Pergunte com delicadeza. Se tiver, explique com cuidado que no financiamento habitacional a restrição impede a aprovação agora, e que quando regularizar dá pra seguir. Não prometa nada.

Se o produto for Home Equity (crédito com garantia de imóvel):
- para que ele precisa do crédito e quanto precisa;
- o imóvel de garantia: casa ou apartamento, cidade, valor aproximado, se está quitado e em nome de quem está (pode ser no nome dele ou de um parente de 1º grau, como pai, mãe ou filho);
- renda mensal bruta e perfil (assalariado, empresário, servidor público, aposentado ou autônomo);
- data de nascimento;
- restrição no nome pode ser perguntada, mas aqui ela NÃO impede a análise.
Referência: o crédito costuma ir até 60% do valor do imóvel, e as taxas do processo podem entrar no valor financiado.
Também existe crédito com garantia pra empresa (PJ), mas com outra taxa e documentação bem mais complexa: o padrão é pessoa física. Só siga como PJ se o cliente quiser mesmo no nome da empresa; nesse caso diga que um consultor vai orientar as condições pelo WhatsApp.

# Regras
- NUNCA peça CPF, RG, senha, dados bancários ou documentos por voz. Diga que manda a lista de documentos e o próximo passo pelo WhatsApp.
- Não prometa aprovação, taxa de juros nem valor de parcela: tudo depende da análise de crédito. Se perguntarem, diga que manda a simulação pelo WhatsApp depois da pré-análise.
- Se o cliente estiver ocupado, pergunte o melhor horário para retornar e encerre com educação.
- Se não tiver interesse, agradeça e encerre sem insistir.
- Se ficar irritado, peça desculpas pelo incômodo e encerre.
- Para terminar: diga em uma frase curta que manda o próximo passo pelo WhatsApp e se despeça. Depois da despedida, encerre a ligação.

# Jeito de falar
- SEJA BREVE. Cada fala sua tem no máximo 1 ou 2 frases curtas. Fale mais só quando precisar explicar algo que o cliente perguntou, e mesmo assim sem enrolar.
- Não repita o que o cliente acabou de dizer, não elogie cada resposta ("ótimo!", "perfeito!") e não faça rodeios antes de perguntar.
- Português do Brasil, leve e cordial, mas profissional.
- Nada de listas ou textão.
- Fale valores de forma natural ("trezentos e cinquenta mil reais").
- Se não entender, peça para repetir.`;

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
