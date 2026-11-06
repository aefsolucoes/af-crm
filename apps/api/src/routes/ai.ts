import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { generateReplySuggestion, generateTemplateSuggestion } from '../services/ai-reply-suggestion.service';
import { usageReport } from '../lib/anthropic-usage';

const router = Router();

router.use(authMiddleware);

type AIMode = 'grammar' | 'professional' | 'friendly' | 'fun';

const SYSTEM_PROMPTS: Record<AIMode, string> = {
  grammar: 'Você é um assistente de escrita. Corrija APENAS erros gramaticais e ortográficos do texto a seguir, mantendo o tom e as palavras originais. Retorne somente o texto corrigido, sem explicações.',
  professional: 'Você é um especialista em comunicação corporativa. Reescreva o texto a seguir com tom profissional, formal e objetivo, mantendo o mesmo significado. Retorne somente o texto reescrito, sem explicações.',
  friendly: 'Você é um especialista em comunicação. Reescreva o texto a seguir com tom amigável, caloroso e próximo ao cliente, mantendo o mesmo significado. Retorne somente o texto reescrito, sem explicações.',
  fun: 'Você é um especialista em comunicação criativa. Reescreva o texto a seguir com tom divertido, leve e descontraído, mantendo o mesmo significado. Use emojis adequados. Retorne somente o texto reescrito, sem explicações.',
};

// Uso da API da Anthropic por dia × função × modelo (só administrador) — ver lib/anthropic-usage.ts. `estUsd` usa preço de tabela SUPOSTO (confira no console da Anthropic).
router.get('/usage', async (req: AuthRequest, res: Response) => {
  if (req.user?.role !== 'ADMIN') { res.status(403).json({ error: 'Só administrador' }); return; }
  try { res.json(await usageReport(Number(req.query.days) || 7)); } catch (err: any) { res.status(500).json({ error: err?.message || 'Erro ao ler o uso' }); }
});

router.post('/rewrite', async (req: AuthRequest, res: Response) => {
  const { text, mode } = req.body as { text?: string; mode?: AIMode };

  if (!text || !text.trim()) {
    res.status(400).json({ error: 'Texto obrigatório' });
    return;
  }
  if (!mode || !SYSTEM_PROMPTS[mode]) {
    res.status(400).json({ error: 'Modo inválido. Use: grammar | professional | friendly | fun' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada' });
    return;
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1024,
        system: SYSTEM_PROMPTS[mode],
        messages: [
          { role: 'user', content: text.trim() },
        ],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('[AI] Anthropic error:', response.status, err);
      res.status(502).json({ error: `Erro Anthropic ${response.status}: ${err}` });
      return;
    }

    const data = await response.json() as { content: { type: string; text: string }[] };
    const result = data.content?.[0]?.text ?? text;
    res.json({ result });
  } catch (err) {
    console.error('[AI] Erro:', err);
    res.status(500).json({ error: 'Erro interno ao processar IA' });
  }
});

// Sugestão de resposta sob demanda pro colaborador (Inbox → botão "Sugerir
// resposta") — nunca envia nada sozinha, só devolve o texto pro balão; quem
// manda é o colaborador, depois de revisar. Ver ai-reply-suggestion.service.ts.
router.post('/suggest-reply', async (req: AuthRequest, res: Response) => {
  const { leadId, auto, testeEsforco } = req.body as { leadId?: string; auto?: boolean; testeEsforco?: string };
  if (!leadId) {
    res.status(400).json({ error: 'leadId obrigatório' });
    return;
  }
  // Fabio 20/10: a sugestão só sai no CLIQUE do botão. Telas antigas ainda abertas disparavam `auto: true` a cada mensagem do cliente — agora o servidor ignora (não chama a IA).
  if (auto === true) { res.json({ suggestion: null }); return; }
  try {
    // testeEsforco (Fabio 06/11): só admin — 'normal' | 'low' | 'medium' | 'high'. A tela nunca manda; serve pra comparar tempo/texto do raciocínio.
    const teste = req.user!.role === 'ADMIN' && typeof testeEsforco === 'string' && ['normal', 'low', 'medium', 'high'].includes(testeEsforco)
      ? (testeEsforco === 'normal' ? {} : { esforco: testeEsforco as 'low' | 'medium' | 'high' }) : undefined;
    const t0 = Date.now();
    const result = await generateReplySuggestion(req.user!.accountId, leadId, teste);
    if (teste) { res.status(result ? 200 : 422).json({ ...(result || { suggestion: null }), ms: Date.now() - t0, esforco: testeEsforco }); return; }
    if (!result) {
      res.status(422).json({ error: 'Não consegui gerar uma sugestão agora (sem histórico de conversa, IA indisponível ou a resposta saiu fora do formato) — tente de novo.' });
      return;
    }
    res.json(result);
  } catch (err) {
    console.error('[AI] Erro ao sugerir resposta:', err);
    res.status(500).json({ error: 'Erro interno ao gerar sugestão' });
  }
});

// Botão "Resumo" da conversa (Fabio 03/11) — ver conversation-summary.service.ts. Só devolve o texto.
router.post('/conversation-summary', async (req: AuthRequest, res: Response) => {
  const { leadId } = req.body as { leadId?: string };
  if (!leadId) { res.status(400).json({ error: 'leadId obrigatório' }); return; }
  try {
    const { summarizeConversation } = require('../services/conversation-summary.service') as typeof import('../services/conversation-summary.service');
    const summary = await summarizeConversation(req.user!.accountId, leadId);
    if (!summary) { res.status(422).json({ error: 'Não consegui resumir agora (conversa vazia ou IA indisponível) — tente de novo.' }); return; }
    res.json({ summary });
  } catch (err) {
    console.error('[AI] Erro ao resumir a conversa:', err);
    res.status(500).json({ error: 'Erro interno ao resumir' });
  }
});

// "Converse sobre este cliente" no Resumo (Fabio 03/11) — ver client-chat.service.ts. Só responde/sugere; nada vai pro cliente.
router.post('/client-chat', async (req: AuthRequest, res: Response) => {
  const { leadId, pergunta, historico } = req.body as { leadId?: string; pergunta?: string; historico?: { role: 'user' | 'assistant'; text: string }[] };
  if (!leadId || !String(pergunta || '').trim()) { res.status(400).json({ error: 'leadId e pergunta obrigatórios' }); return; }
  try {
    const { perguntarSobreCliente } = require('../services/client-chat.service') as typeof import('../services/client-chat.service');
    const hist = (Array.isArray(historico) ? historico : []).filter((t) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.text === 'string');
    const r = await perguntarSobreCliente(req.user!.accountId, leadId, String(pergunta), hist);
    if (!r) { res.status(422).json({ error: 'Não consegui responder agora — tente de novo.' }); return; }
    res.json(r);
  } catch (err) {
    console.error('[AI] Erro no chat do cliente:', err);
    res.status(500).json({ error: 'Erro interno no chat do cliente' });
  }
});

// Sugestão de TEMPLATE pra conversa fechada (janela de 24 h do WhatsApp) — Inbox → "Sugerir resposta" quando a janela está fechada. Nunca envia: devolve o template (com a categoria) pro balão.
router.post('/suggest-template', async (req: AuthRequest, res: Response) => {
  const { leadId } = req.body as { leadId?: string };
  if (!leadId) { res.status(400).json({ error: 'leadId obrigatório' }); return; }
  try {
    const result = await generateTemplateSuggestion(req.user!.accountId, leadId);
    if (!result) { res.status(422).json({ error: 'Não consegui sugerir um template agora (IA ou Meta indisponível).' }); return; }
    res.json(result);
  } catch (err) {
    console.error('[AI] Erro ao sugerir template:', err);
    res.status(500).json({ error: 'Erro interno ao sugerir template' });
  }
});

export default router;
