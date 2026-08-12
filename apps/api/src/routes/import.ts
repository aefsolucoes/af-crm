import { Router, Response } from 'express';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import { getOrCreateWhatsAppPipeline } from '../services/whatsapp.service';

const router = Router();
const prisma = new PrismaClient();
router.use(authMiddleware);
// Reaproveita a mesma permissão de "gerenciar cards do funil" — importar
// clientes é, na prática, criar leads em massa.
router.use(requirePermission('funnel_manage'));

// Formato genérico de uma linha do arquivo importado (Kommo ou outro CRM),
// já mapeada pelo front para os campos que o CRM entende. Tudo opcional
// exceto o nome — o arquivo real do Kommo ainda não foi visto, então o
// mapeamento de colunas acontece no front, não aqui.
const importRowSchema = z.object({
  name: z.string().min(1),
  phone: z.string().optional(),
  cpf: z.string().optional(),
  email: z.string().optional(),
  valorCredito: z.string().optional(),
});

/** Núcleo do telefone (últimos 8 dígitos) — mesma lógica do find_lead da IA,
 *  ignora formatação, DDI 55 e o 9º dígito do celular. */
function phoneCore(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  const core = digits.length > 8 ? digits.slice(-8) : digits;
  return core.length >= 8 ? core : null;
}

function cpfDigits(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  return digits.length === 11 ? digits : null;
}

// POST /api/import/check-duplicates
// Recebe as linhas já mapeadas e devolve cada uma anotada com o possível
// lead já existente que bate por telefone ou CPF — a decisão de importar ou
// pular cada duplicata fica com quem está importando (caso a caso).
router.post('/check-duplicates', async (req: AuthRequest, res: Response) => {
  try {
    const rows = z.array(importRowSchema).min(1).max(5000).parse(req.body.rows);
    const accountId = req.user!.accountId;

    const leads = await prisma.lead.findMany({
      where: { accountId, archived: false },
      include: { contact: true },
      take: 5000,
    });

    const byPhoneCore = new Map<string, { id: string; name: string }>();
    const byCpf = new Map<string, { id: string; name: string }>();
    for (const l of leads) {
      const cf = (l.customFields && typeof l.customFields === 'object' ? l.customFields : {}) as Record<string, unknown>;
      const phones = [l.contact?.phone, l.contact?.whatsappPhone, cf.telefone_1].filter(
        (v): v is string => typeof v === 'string'
      );
      for (const p of phones) {
        const core = phoneCore(p);
        if (core && !byPhoneCore.has(core)) byPhoneCore.set(core, { id: l.id, name: l.name });
      }
      const cpf = cpfDigits(typeof cf.cpf_1 === 'string' ? cf.cpf_1 : null);
      if (cpf && !byCpf.has(cpf)) byCpf.set(cpf, { id: l.id, name: l.name });
    }

    const annotated = rows.map((row, idx) => {
      const core = phoneCore(row.phone);
      const cpf = cpfDigits(row.cpf);
      const duplicateOf = (core && byPhoneCore.get(core)) || (cpf && byCpf.get(cpf)) || null;
      return { idx, ...row, duplicateOf };
    });

    res.json({ rows: annotated, duplicateCount: annotated.filter(r => r.duplicateOf).length });
  } catch (err: any) {
    if (err?.issues) return res.status(400).json({ error: 'Arquivo inválido', details: err.issues });
    console.error('[Import] check-duplicates error:', err);
    res.status(500).json({ error: 'Erro ao verificar duplicados' });
  }
});

// POST /api/import/commit
// Cria Contact + Lead para cada linha não marcada como "skip". Leads entram
// na Caixa de Entrada (mesmo funil usado por leads criados via WhatsApp),
// atribuídos a quem está importando, com a tag "Kommo" para identificar a
// origem depois.
router.post('/commit', async (req: AuthRequest, res: Response) => {
  try {
    const rows = z.array(importRowSchema.extend({ skip: z.boolean().optional() })).min(1).max(5000).parse(req.body.rows);
    const accountId = req.user!.accountId;
    const userId = req.user!.id;
    // Setor de destino (opcional) — importante quando a conta tem mais de um
    // (ex: importar uma leva de clientes do Consórcio separada da de
    // Financiamento). Sem escolha, cai na Caixa de Entrada "genérica".
    const departmentId = req.body.departmentId ? String(req.body.departmentId) : null;
    if (departmentId) {
      const dept = await prisma.department.findFirst({ where: { id: departmentId, accountId } });
      if (!dept) return res.status(400).json({ error: 'Departamento inválido' });
    }

    const pipeline = await getOrCreateWhatsAppPipeline(accountId, departmentId);
    if (!pipeline.stages.length) {
      return res.status(500).json({ error: 'Não foi possível encontrar/criar um estágio de destino para os leads importados' });
    }
    const stageId = pipeline.stages[0].id;

    let created = 0;
    let skipped = 0;

    for (const row of rows) {
      if (row.skip) { skipped++; continue; }

      const contact = await prisma.contact.create({
        data: {
          name: row.name.trim(),
          phone: row.phone?.trim() || null,
          email: row.email?.trim() || null,
          accountId,
        },
      });

      const customFields: Record<string, string> = { participante_1: row.name.trim() };
      if (row.phone) customFields.telefone_1 = row.phone.trim();
      if (row.cpf) customFields.cpf_1 = row.cpf.trim();
      if (row.email) customFields.email_1 = row.email.trim();
      if (row.valorCredito) customFields.valor_credito = row.valorCredito.trim();

      await prisma.lead.create({
        data: {
          name: row.name.trim(),
          accountId,
          pipelineId: pipeline.id,
          stageId,
          userId,
          contactId: contact.id,
          status: 'OPEN',
          tags: ['Kommo'],
          customFields: customFields as any,
        },
      });
      created++;
    }

    res.json({ success: true, created, skipped });
  } catch (err: any) {
    if (err?.issues) return res.status(400).json({ error: 'Arquivo inválido', details: err.issues });
    console.error('[Import] commit error:', err);
    res.status(500).json({ error: 'Erro ao importar clientes' });
  }
});

export default router;
