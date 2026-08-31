export type Role = 'ADMIN' | 'MANAGER' | 'AGENT';
export type FieldType = 'TEXT' | 'NUMBER' | 'DATE' | 'SELECT' | 'EMAIL' | 'PHONE' | 'LINK';

export interface FieldDefinition {
  id: string;
  accountId: string;
  tab: string;
  name: string;
  key: string;
  type: FieldType;
  options: string[];
  order: number;
  createdAt: string;
}
export type LeadStatus = 'OPEN' | 'WON' | 'LOST';
export type NoteType = 'COMMENT' | 'CALL' | 'EMAIL' | 'STAGE_CHANGE' | 'DATA_EDIT';
export type Direction = 'INBOUND' | 'OUTBOUND';
export type Channel = 'WHATSAPP' | 'INSTAGRAM' | 'TELEGRAM' | 'WEBCHAT' | 'EMAIL';

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  accountId: string;
  themeColor?: string;
  themeImage?: string | null;
  themeOpacity?: number;
  // Permissões efetivas (as "caixinhas"). Pode faltar em sessões antigas — nesse
  // caso o front recalcula pelo papel via effectivePermissions().
  permissions?: Record<string, boolean>;
  // Setor(es) do colaborador — array vazio/ausente = sem setor definido
  // (vê tudo, por ora). Pode pertencer a mais de um.
  departmentIds?: string[];
}

export interface Account {
  id: string;
  name: string;
}

export interface Company {
  id: string;
  name: string;
  email?: string;
  phone?: string;
}

export interface Contact {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  whatsappPhone?: string;
  company?: Company;
  companyId?: string;
}

export interface Stage {
  id: string;
  name: string;
  color: string;
  order: number;
  pipelineId: string;
}

export interface Pipeline {
  id: string;
  name: string;
  stages: Stage[];
  department?: { id: string; name: string } | null;
}

export interface Lead {
  id: string;
  name: string;
  value?: number;
  status: LeadStatus;
  pipelineId: string;
  stageId: string;
  stage: Stage;
  userId: string;
  user: Pick<User, 'id' | 'name' | 'email'>;
  contactId?: string;
  contact?: Contact;
  companyId?: string;
  company?: Company;
  tags: string[];
  customFields?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  archived?: boolean;
  messages?: Message[];
  _count?: { messages: number };
}

export interface LeadDetail extends Lead {
  pipeline: Pipeline & { stages: Stage[] };
  tasks: Task[];
  notes: Note[];
  messages: Message[];
}

export interface Task {
  id: string;
  title: string;
  dueAt: string;
  done: boolean;
  userId: string;
  user: Pick<User, 'id' | 'name'>;
  leadId?: string;
  lead?: Pick<Lead, 'id' | 'name'>;
}

export type TransactionType = 'INCOME' | 'EXPENSE' | 'SAVINGS';

export interface Transaction {
  id: string;
  description: string;
  amount: number;
  type: TransactionType;
  date: string;
  userId?: string;
  user?: Pick<User, 'id' | 'name'>;
  createdAt: string;
  /** true no lançamento "molde" que repete todo mês sozinho. */
  isRecurring?: boolean;
  /** preenchido nas ocorrências geradas automaticamente a partir de um molde fixo. */
  recurringParentId?: string | null;
}

export type CommissionSuggestionStatus = 'PENDING' | 'CONFIRMED' | 'DISMISSED';

export interface CommissionSuggestion {
  id: string;
  leadId: string;
  leadName: string;
  baseAmount: number;
  suggestedAmount: number;
  status: CommissionSuggestionStatus;
  createdAt: string;
}

export interface Note {
  id: string;
  content: string;
  type: NoteType;
  leadId: string;
  userId?: string;
  user?: Pick<User, 'id' | 'name'>;
  updatedAt: string;
  createdAt: string;
}

export type MsgStatus = 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';

export interface MessageAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  driveFileId?: string | null;
}

export interface Message {
  id: string;
  content: string;
  direction: Direction;
  channel: Channel;
  leadId: string;
  read: boolean;
  externalId?: string;
  status?: MsgStatus;
  statusError?: string | null;
  whatsappNumberId?: string | null;
  attachments?: MessageAttachment[];
  createdAt: string;
  /** Preenchido quando esta mensagem foi encaminhada de outra conversa. */
  forwardedFromLeadId?: string | null;
  forwardedFromLeadName?: string | null;
  /** Preenchido quando esta mensagem é um contato compartilhado no WhatsApp. */
  sharedContactName?: string | null;
  sharedContactPhone?: string | null;
  /** Preenchido quando esta mensagem é uma resposta com citação a outra. */
  replyToExternalId?: string | null;
  replyToContent?: string | null;
  replyToSender?: string | null;
  /** Menu de mensagem estilo WhatsApp — apagar/reagir/fixar/favoritar. */
  deleted?: boolean;
  reactions?: { emoji: string; fromMe: boolean; at: string }[] | null;
  pinned?: boolean;
  pinnedAt?: string | null;
  starred?: boolean;
}

export interface WhatsAppNumber {
  id: string;
  label: string;
  phone?: string | null;
  status?: string;
}

export interface Conversation {
  id: string;
  name: string;
  contact?: Contact;
  messages: Message[];
  _count: { messages: number };
  updatedAt: string;
  isGroup?: boolean;
  whatsappNumberId?: string | null;
  whatsappNumber?: { id: string; label: string; phone?: string | null } | null;
  aiAutoReplyActive?: boolean;
  // getConversations() devolve o Lead inteiro (sem `select`) — customFields
  // vem junto mesmo sem estar listado aqui antes; usado na busca avançada da
  // Inbox (nome corrigido no card pode estar em participante_1/2, não em
  // contact.name — esse é só o nome que veio do perfil do WhatsApp).
  customFields?: Record<string, string> | null;
}

export interface SalesBot {
  id: string;
  name: string;
  active: boolean;
  flow: Record<string, unknown>;
}

export interface ReportSummary {
  totalRevenue: number;
  newLeads: number;
  conversionRate: number;
  totalLeads: number;
  monthlyRevenue: { month: string; revenue: number }[];
}

export interface ReportConversion {
  stages: { name: string; count: number; color: string }[];
  topAgents: { name: string; leads: number; revenue: number }[];
  weeklyData: { week: string; rate: number }[];
}
