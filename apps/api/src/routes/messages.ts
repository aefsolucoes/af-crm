import { Router, Response } from 'express';
import { z } from 'zod';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { loadPerms } from '../middleware/permission';
import { validate } from '../middleware/validate';
import { getMessages, createMessage, getConversations, sendOutboundWhatsApp, sendOutboundWhatsAppTemplate, markConversationRead, getAttachment, sendOutboundMedia, forwardMessage, findOrCreateLeadByPhone, deleteMessage, reactToMessage, setMessagePinned, setMessageStarred, getScopeNumberIds } from '../services/message.service';
import { downloadDriveFile } from '../services/google.service';
import { getScopeDepartmentIds } from '../services/department.service';
import { runAutomations } from '../services/automation.service';
import { logActivity } from '../services/activity.service';

/** Registro silencioso: "Fulano respondeu <cliente>". Fire-and-forget. */
function logClientReply(req: AuthRequest, leadId: string) {
  logActivity({
    accountId: req.user!.accountId,
    userId: req.user!.id,
    action: 'client_replied',
    leadId,
    summary: 'respondeu o cliente',
    channel: 'WHATSAPP',
  });
}

const router = Router();
router.use(authMiddleware);

/** Diagnóstico temporário (16/09/2026) — guarda só o ÚLTIMO áudio de voz que
 *  passou pelo /send-media com transcodeAudio (bruto + convertido), pra dar
 *  pra investigar por que a Meta recusa mesmo depois da conversão no
 *  servidor. Sem persistência (cai ao reiniciar), só ADMIN acessa. Remover
 *  as rotas /debug/last-audio* junto com isto depois de resolvido. */
let lastAudioDebug: { raw: Buffer; transcoded: Buffer | null; mimeType: string; error: string | null; at: Date } | null = null;

router.get('/debug/last-audio/info', (req: AuthRequest, res: Response) => {
  if (req.user!.role !== 'ADMIN') return res.status(403).json({ error: 'Só admin' });
  if (!lastAudioDebug) return res.status(404).json({ error: 'Nenhum áudio capturado ainda' });
  res.json({
    mimeType: lastAudioDebug.mimeType,
    rawLength: lastAudioDebug.raw.length,
    rawHeaderHex: lastAudioDebug.raw.subarray(0, 32).toString('hex'),
    transcodedLength: lastAudioDebug.transcoded?.length ?? null,
    transcodedHeaderHex: lastAudioDebug.transcoded?.subarray(0, 32).toString('hex') ?? null,
    error: lastAudioDebug.error,
    at: lastAudioDebug.at,
  });
});

router.get('/debug/last-audio', (req: AuthRequest, res: Response) => {
  if (req.user!.role !== 'ADMIN') return res.status(403).json({ error: 'Só admin' });
  if (!lastAudioDebug) return res.status(404).json({ error: 'Nenhum áudio capturado ainda' });
  const which = req.query.which === 'transcoded' ? 'transcoded' : 'raw';
  const buf = which === 'transcoded' ? lastAudioDebug.transcoded : lastAudioDebug.raw;
  if (!buf) return res.status(404).json({ error: 'Não disponível' });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${which}.bin"`);
  res.send(buf);
});

// Roda o ffmpeg de verdade em cima do áudio capturado e devolve o que ele
// "vê" (duração, stream, codec) — `ffmpeg -i` sem saída sempre "falha" (não
// gerou arquivo nenhum), mas o stderr tem o dump de metadados que queremos.
// Bem mais confiável que só olhar os primeiros bytes do arquivo.
router.get('/debug/last-audio/probe', async (req: AuthRequest, res: Response) => {
  if (req.user!.role !== 'ADMIN') return res.status(403).json({ error: 'Só admin' });
  if (!lastAudioDebug) return res.status(404).json({ error: 'Nenhum áudio capturado ainda' });
  const which = req.query.which === 'transcoded' ? 'transcoded' : 'raw';
  const buf = which === 'transcoded' ? lastAudioDebug.transcoded : lastAudioDebug.raw;
  if (!buf) return res.status(404).json({ error: 'Não disponível' });
  try {
    const { execFile } = require('child_process') as typeof import('child_process');
    const { promisify } = require('util') as typeof import('util');
    const { mkdtemp, writeFile, rm } = require('fs/promises') as typeof import('fs/promises');
    const { tmpdir } = require('os') as typeof import('os');
    const path = require('path') as typeof import('path');
    const ffmpegPath = require('ffmpeg-static') as string;
    const execFileAsync = promisify(execFile);
    const dir = await mkdtemp(path.join(tmpdir(), 'af-probe-'));
    const inputPath = path.join(dir, which === 'transcoded' ? 'input.ogg' : 'input.bin');
    try {
      await writeFile(inputPath, buf);
      let stderr = '';
      try {
        await execFileAsync(ffmpegPath, ['-i', inputPath], { timeout: 15_000 });
      } catch (err: any) {
        stderr = err?.stderr || err?.message || String(err);
      }
      res.json({ which, length: buf.length, ffmpegOutput: stderr });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

const messageSchema = z.object({
  content: z.string().min(1),
  direction: z.enum(['INBOUND', 'OUTBOUND']),
  channel: z.enum(['WHATSAPP', 'INSTAGRAM', 'TELEGRAM', 'WEBCHAT', 'EMAIL']),
  leadId: z.string(),
  // Resposta com citação (como no WhatsApp) — id/remetente/conteúdo da
  // mensagem original, escolhida pelo usuário na Inbox.
  replyToExternalId: z.string().optional(),
  replyToFromMe: z.boolean().optional(),
  replyToContent: z.string().optional(),
  replyToSender: z.string().optional(),
  // Botão de uma Resposta rápida com botão — um OU outro, nunca os dois (ver
  // sendOutboundWhatsApp). Vem da tela de Templates → Respostas rápidas.
  buttons: z.array(z.string().min(1).max(20)).max(3).optional(),
  ctaButton: z.object({ text: z.string().min(1).max(20), url: z.string().min(1) }).optional(),
});

router.get('/', async (req: AuthRequest, res: Response) => {
  const { leadId } = req.query;
  const scopeDepartmentIds = await getScopeDepartmentIds(req.user!.accountId, req.user!.id, req.user!.role);
  const scopeNumberIds = await getScopeNumberIds(req.user!.accountId, req.user!.id, req.user!.role);
  if (leadId) {
    try {
      const messages = await getMessages(leadId as string, req.user!.accountId, scopeDepartmentIds, scopeNumberIds);
      if (messages === null) { res.status(404).json({ error: 'Conversa não encontrada' }); return; }
      res.json(messages);
    } catch {
      res.status(500).json({ error: 'Erro ao buscar mensagens' });
    }
  } else {
    try {
      const conversations = await getConversations(req.user!.accountId, scopeDepartmentIds, scopeNumberIds);
      res.json(conversations);
    } catch {
      res.status(500).json({ error: 'Erro ao buscar conversas' });
    }
  }
});

// Serve os bytes de um anexo (imagem/documento) recebido no WhatsApp
router.get('/attachment/:id', async (req: AuthRequest, res: Response) => {
  try {
    const att = await getAttachment(req.params.id, req.user!.accountId);
    if (!att) return res.status(404).json({ error: 'Anexo não encontrado' });
    const isImage = att.mimeType.startsWith('image/');

    // Bytes ainda no banco → serve direto.
    if (att.data) {
      res.setHeader('Content-Type', att.mimeType);
      res.setHeader('Content-Disposition', `${isImage ? 'inline' : 'attachment'}; filename="${encodeURIComponent(att.fileName)}"`);
      return res.send(Buffer.from(att.data as any));
    }

    // Já arquivado no Drive → busca de volta e serve (miniatura inline / download).
    if (att.driveFileId) {
      try {
        const buf = await downloadDriveFile(req.user!.accountId, att.driveFileId, att.mimeType);
        res.setHeader('Content-Type', att.mimeType);
        res.setHeader('Content-Disposition', `${isImage ? 'inline' : 'attachment'}; filename="${encodeURIComponent(att.fileName)}"`);
        res.setHeader('Cache-Control', 'private, max-age=86400');
        return res.send(buf);
      } catch (err) {
        console.error('[Attachment] Falha ao baixar do Drive:', (err as any)?.message);
        return res.status(410).json({ error: 'Arquivo no Google Drive', driveFileId: att.driveFileId });
      }
    }

    return res.status(410).json({ error: 'Arquivo indisponível', driveFileId: att.driveFileId });
  } catch {
    res.status(500).json({ error: 'Erro ao carregar anexo' });
  }
});

// Envia um documento/imagem pelo WhatsApp (base64). Limite de corpo elevado só aqui.
router.post('/send-media', async (req: AuthRequest, res: Response) => {
  const { leadId, fileName, mimeType, dataBase64, caption, transcodeAudio } = req.body as {
    leadId?: string; fileName?: string; mimeType?: string; dataBase64?: string; caption?: string;
    /** true = veio do gravador de voz da Inbox (microfone), não de um arquivo
     *  já pronto — precisa passar pelo ffmpeg do servidor antes de ir pro
     *  WhatsApp (ver services/audio-transcode.service.ts). */
    transcodeAudio?: boolean;
  };
  if (!leadId || !fileName || !mimeType || !dataBase64) {
    return res.status(400).json({ error: 'leadId, fileName, mimeType e dataBase64 são obrigatórios' });
  }
  try {
    const perms = await loadPerms(req);
    if (!perms.inbox_reply) return res.status(403).json({ error: 'Você não tem permissão para enviar mensagens.' });
    let buffer: Buffer = Buffer.from(dataBase64, 'base64');
    if (buffer.length > 25 * 1024 * 1024) {
      return res.status(413).json({ error: 'Arquivo muito grande (máx. 25 MB)' });
    }
    let finalFileName = fileName;
    let finalMimeType = mimeType;
    if (transcodeAudio) {
      // Diagnóstico temporário (16/09/2026): a Meta segue recusando o áudio
      // (131053) mesmo depois da conversão rodar no servidor — precisa ver o
      // arquivo de verdade pra saber por quê. Ver GET /debug/last-audio* logo
      // abaixo. Remover depois de resolvido.
      console.log(`[Audio] recebido do gravador: ${buffer.length} bytes, mimeType="${mimeType}", header=${buffer.subarray(0, 16).toString('hex')}`);
      lastAudioDebug = { raw: buffer, transcoded: null, mimeType, error: null, at: new Date() };
      try {
        const { transcodeToOggOpus } = require('../services/audio-transcode.service') as typeof import('../services/audio-transcode.service');
        buffer = await transcodeToOggOpus(buffer, mimeType);
        console.log(`[Audio] convertido: ${buffer.length} bytes, header=${buffer.subarray(0, 16).toString('hex')}`);
        lastAudioDebug.transcoded = buffer;
        finalFileName = `audio-${Date.now()}.ogg`;
        // O WhatsApp só reconhece como NOTA DE VOZ de verdade (tocável, com
        // forma de onda) com esse mimetype EXATO, "codecs=opus" incluído —
        // sem isso a Meta aceita o envio (fica ✓ no CRM) mas o áudio não
        // toca no destinatário. Incidente real: "audio/ogg" sozinho passava
        // pela validação de upload mas nunca virava um áudio reproduzível.
        finalMimeType = 'audio/ogg; codecs=opus';
      } catch (err) {
        console.error('[Audio] Falha ao converter áudio gravado:', err);
        lastAudioDebug.error = (err as Error)?.message || String(err);
        return res.status(422).json({ error: 'Não consegui converter o áudio gravado. Tente gravar de novo.' });
      }
    }
    const io = req.app.get('io');
    const result = await sendOutboundMedia({
      accountId: req.user!.accountId, leadId, buffer, fileName: finalFileName, mimeType: finalMimeType, caption, userId: req.user!.id, io,
    });
    if (!result.success) return res.status(400).json({ error: result.error });
    res.status(201).json(result.message);
    logClientReply(req, leadId);
  } catch {
    res.status(500).json({ error: 'Erro ao enviar o arquivo' });
  }
});

// Envia um template aprovado pela Meta (API oficial) — único jeito de reabrir
// conversa fora da janela de 24h de atendimento gratuito.
router.post('/send-template', async (req: AuthRequest, res: Response) => {
  const { leadId, templateName, language, bodyParams, previewText } = req.body as {
    leadId?: string; templateName?: string; language?: string; bodyParams?: string[]; previewText?: string;
  };
  if (!leadId || !templateName || !previewText) {
    return res.status(400).json({ error: 'leadId, templateName e previewText são obrigatórios' });
  }
  try {
    const perms = await loadPerms(req);
    if (!perms.inbox_reply) return res.status(403).json({ error: 'Você não tem permissão para enviar mensagens.' });
    const io = req.app.get('io');
    const result = await sendOutboundWhatsAppTemplate({
      accountId: req.user!.accountId, leadId, templateName, language: language || 'pt_BR',
      bodyParams: Array.isArray(bodyParams) ? bodyParams.map(String) : [], previewText, userId: req.user!.id, io,
    });
    if (!result.success) return res.status(400).json({ error: result.error, code: (result as any).code });
    res.status(201).json(result.message);
    logClientReply(req, leadId);
  } catch {
    res.status(500).json({ error: 'Erro ao enviar o template' });
  }
});

// Encaminha uma mensagem (texto ou anexo) para outra conversa/lead — reenvia
// de verdade pelo WhatsApp da conversa de destino.
router.post('/:id/forward', async (req: AuthRequest, res: Response) => {
  const { toLeadId } = req.body as { toLeadId?: string };
  if (!toLeadId) return res.status(400).json({ error: 'toLeadId é obrigatório' });
  try {
    const perms = await loadPerms(req);
    if (!perms.inbox_reply) return res.status(403).json({ error: 'Você não tem permissão para enviar mensagens.' });
    const io = req.app.get('io');
    const result = await forwardMessage({
      accountId: req.user!.accountId, messageId: req.params.id, toLeadId, userId: req.user!.id, io,
    });
    if (!result.success) return res.status(400).json({ error: result.error });
    res.status(201).json(result.message);
  } catch {
    res.status(500).json({ error: 'Erro ao encaminhar a mensagem' });
  }
});

// Menu de mensagem estilo WhatsApp: apagar/reagir/fixar/favoritar — mesmo
// gate de permissão das outras ações de escrever na conversa.
router.post('/:id/delete', async (req: AuthRequest, res: Response) => {
  try {
    const perms = await loadPerms(req);
    if (!perms.inbox_reply) return res.status(403).json({ error: 'Você não tem permissão para apagar mensagens.' });
    const io = req.app.get('io');
    const result = await deleteMessage({ accountId: req.user!.accountId, messageId: req.params.id, io });
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json(result.message);
  } catch {
    res.status(500).json({ error: 'Erro ao apagar a mensagem' });
  }
});

router.post('/:id/react', async (req: AuthRequest, res: Response) => {
  const { emoji } = req.body as { emoji?: string };
  try {
    const perms = await loadPerms(req);
    if (!perms.inbox_reply) return res.status(403).json({ error: 'Você não tem permissão para reagir a mensagens.' });
    const io = req.app.get('io');
    const result = await reactToMessage({ accountId: req.user!.accountId, messageId: req.params.id, emoji: String(emoji || ''), io });
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json(result.message);
  } catch {
    res.status(500).json({ error: 'Erro ao reagir à mensagem' });
  }
});

router.post('/:id/pin', async (req: AuthRequest, res: Response) => {
  const { pinned } = req.body as { pinned?: boolean };
  try {
    const perms = await loadPerms(req);
    if (!perms.inbox_reply) return res.status(403).json({ error: 'Você não tem permissão para fixar mensagens.' });
    const io = req.app.get('io');
    const result = await setMessagePinned({ accountId: req.user!.accountId, messageId: req.params.id, pinned: !!pinned, io });
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json(result.message);
  } catch {
    res.status(500).json({ error: 'Erro ao fixar a mensagem' });
  }
});

router.post('/:id/star', async (req: AuthRequest, res: Response) => {
  const { starred } = req.body as { starred?: boolean };
  try {
    const perms = await loadPerms(req);
    if (!perms.inbox_reply) return res.status(403).json({ error: 'Você não tem permissão para favoritar mensagens.' });
    const io = req.app.get('io');
    const result = await setMessageStarred({ accountId: req.user!.accountId, messageId: req.params.id, starred: !!starred, io });
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json(result.message);
  } catch {
    res.status(500).json({ error: 'Erro ao favoritar a mensagem' });
  }
});

// Resolve um contato compartilhado no WhatsApp (nome + telefone extraídos do
// cartão) pro botão "Conversar"/"Criar lead" na mensagem — acha o lead se já
// existir (pelo telefone) ou cria um novo, sem precisar digitar nada.
router.post('/contact-card/resolve', async (req: AuthRequest, res: Response) => {
  const { name, phone } = req.body as { name?: string; phone?: string };
  if (!phone?.trim()) return res.status(400).json({ error: 'phone é obrigatório' });
  try {
    const perms = await loadPerms(req);
    if (!perms.inbox_reply) return res.status(403).json({ error: 'Você não tem permissão para criar leads pela Inbox.' });
    const result = await findOrCreateLeadByPhone(req.user!.accountId, phone, name);
    if (!result) return res.status(400).json({ error: 'Não foi possível criar o lead (funil/usuário não configurado)' });
    res.json(result);
    if (result.created) {
      runAutomations({ accountId: req.user!.accountId, trigger: 'NEW_LEAD', leadId: result.leadId, io: (req as any).app.get('io') }).catch(() => {});
    }
  } catch {
    res.status(500).json({ error: 'Erro ao resolver o contato' });
  }
});

// Marca as mensagens recebidas de um lead como lidas (some o contador de não lidas)
router.post('/read', async (req: AuthRequest, res: Response) => {
  const leadId = (req.body?.leadId || req.query.leadId) as string | undefined;
  if (!leadId) return res.status(400).json({ error: 'leadId é obrigatório' });
  try {
    const result = await markConversationRead(leadId, req.user!.accountId);
    res.json(result);
  } catch {
    res.status(500).json({ error: 'Erro ao marcar como lida' });
  }
});

router.post('/', validate(messageSchema), async (req: AuthRequest, res: Response) => {
  try {
    // Enviar mensagem exige permissão "responder no Inbox".
    if (req.body.direction === 'OUTBOUND') {
      const perms = await loadPerms(req);
      if (!perms.inbox_reply) return res.status(403).json({ error: 'Você não tem permissão para enviar mensagens.' });
    }
    // If sending OUTBOUND via WhatsApp, use the shared send helper
    if (req.body.direction === 'OUTBOUND' && req.body.channel === 'WHATSAPP') {
      const io = req.app.get('io');
      const result = await sendOutboundWhatsApp({
        accountId: req.user!.accountId,
        leadId: req.body.leadId,
        content: req.body.content,
        userId: req.user!.id,
        replyToExternalId: req.body.replyToExternalId,
        replyToFromMe: req.body.replyToFromMe,
        replyToContent: req.body.replyToContent,
        replyToSender: req.body.replyToSender,
        buttons: req.body.buttons,
        ctaButton: req.body.ctaButton,
        io,
      });
      if (!result.success) {
        return res.status(400).json({ error: result.error, code: (result as any).code });
      }
      res.status(201).json(result.message);
      logClientReply(req, req.body.leadId);
      return;
    }

    const message = await createMessage(req.body);

    const io = req.app.get('io');
    if (io) {
      io.to(`lead:${message.leadId}`).emit('new_message', message);
      io.to(`account_${req.user!.accountId}`).emit('new_notification', { leadId: message.leadId, message });
    }

    res.status(201).json(message);
    if (req.body.direction === 'OUTBOUND') logClientReply(req, message.leadId);
  } catch {
    res.status(500).json({ error: 'Erro ao enviar mensagem' });
  }
});

export default router;
