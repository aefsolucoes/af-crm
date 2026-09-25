import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { getScopeDepartmentIds } from '../services/department.service';
import {
  listAiTeamQuestions, answerAiTeamQuestion, dismissAiTeamQuestion, forgetAiTeamKnowledge,
} from '../services/ai-team-question.service';

/** Balão "Dúvidas da IA" — ver ai-team-question.service.ts. */
const router = Router();
router.use(authMiddleware);

router.get('/', async (req: AuthRequest, res: Response) => {
  const scope = await getScopeDepartmentIds(req.user!.accountId, req.user!.id, req.user!.role);
  res.json(await listAiTeamQuestions(req.user!.accountId, scope));
});

router.post('/:id/answer', async (req: AuthRequest, res: Response) => {
  try {
    const q = await answerAiTeamQuestion({
      accountId: req.user!.accountId, questionId: req.params.id, userId: req.user!.id,
      answer: String(req.body?.answer || ''), io: (req as any).app.get('io'),
    });
    res.json(q);
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Não deu pra responder' });
  }
});

router.post('/:id/dismiss', async (req: AuthRequest, res: Response) => {
  try {
    res.json(await dismissAiTeamQuestion({ accountId: req.user!.accountId, questionId: req.params.id, userId: req.user!.id, io: (req as any).app.get('io') }));
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Não deu pra fechar a dúvida' });
  }
});

router.post('/:id/forget', async (req: AuthRequest, res: Response) => {
  try {
    res.json(await forgetAiTeamKnowledge({ accountId: req.user!.accountId, questionId: req.params.id, io: (req as any).app.get('io') }));
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Não deu pra desfazer' });
  }
});

export default router;
