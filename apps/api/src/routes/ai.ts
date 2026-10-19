import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { generateReplySuggestion } from '../services/ai-reply-suggestion.service';
import { usageReport } from '../lib/anthropic-usage';

const router = Router();

/** Sugestão AUTOMÁTICA (a que aparece sozinha ao abrir a conversa): guarda a última por card + última mensagem do cliente. Abrir de novo a mesma conversa sem mensagem nova do cliente
 *  repetia a chamada à IA (~19 mil tokens, sem cache) — era a 2ª maior despesa com a Anthropic (Fabio 19/10: "o que está consumindo tanto o saldo?"). O botão manual "Sugerir resposta" gera sempre uma nova. */
const autoSuggestionCache = new Map<string, { at: number; value: { suggestion: string } }>();
const AUTO_SUGGESTION_TTL_MS = 12 * 3_600_000;
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
  const { leadId, auto } = req.body as { leadId?: string; auto?: boolean };
  if (!leadId) {
    res.status(400).json({ error: 'leadId obrigatório' });
    return;
  }
  try {
    let cacheKey: string | null = null;
    if (auto === true) {
      const last = await prisma.message.findFirst({ where: { leadId, lead: { accountId: req.user!.accountId }, direction: 'INBOUND', channel: { not: 'EMAIL' } }, orderBy: { createdAt: 'desc' }, select: { id: true } });
      cacheKey = last ? `${leadId}:${last.id}` : null;
      const hit = cacheKey ? autoSuggestionCache.get(cacheKey) : null;
      if (hit && Date.now() - hit.at < AUTO_SUGGESTION_TTL_MS) { res.json(hit.value); return; }
    }
    const result = await generateReplySuggestion(req.user!.accountId, leadId);
    if (!result) {
      res.status(422).json({ error: 'Não consegui gerar uma sugestão agora (sem histórico de conversa, ou IA indisponível).' });
      return;
    }
    if (cacheKey) {
      if (autoSuggestionCache.size > 500) autoSuggestionCache.delete(autoSuggestionCache.keys().next().value as string);
      autoSuggestionCache.set(cacheKey, { at: Date.now(), value: result });
    }
    res.json(result);
  } catch (err) {
    console.error('[AI] Erro ao sugerir resposta:', err);
    res.status(500).json({ error: 'Erro interno ao gerar sugestão' });
  }
});

export default router;
