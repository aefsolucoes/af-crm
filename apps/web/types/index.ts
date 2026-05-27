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
export type NoteType = 'COMMENT' | 'CALL' | 'EMAIL' | 'STAGE_CHANGE';
export type Direction = 'INBOUND' | 'OUTBOUND';
export type Channel = 'WHATSAPP' | 'INSTAGRAM' | 'TELEGRAM' | 'WEBCHAT' | 'EMAIL';

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  accountId: string;
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

export interface Note {
  id: string;
  content: string;
  type: NoteType;
  leadId: string;
  createdAt: string;
}

export type MsgStatus = 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';

export interface Message {
  id: string;
  content: string;
  direction: Direction;
  channel: Channel;
  leadId: string;
  read: boolean;
  externalId?: string;
  status?: MsgStatus;
  createdAt: string;
}

export interface Conversation {
  id: string;
  name: string;
  contact?: Contact;
  messages: Message[];
  _count: { messages: number };
  updatedAt: string;
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
