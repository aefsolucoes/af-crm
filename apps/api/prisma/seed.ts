import { PrismaClient, Role, LeadStatus, NoteType, Direction, Channel } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Iniciando seed...');

  // Account
  const account = await prisma.account.create({
    data: { name: 'A&F Soluções Financeiras' },
  });

  // Users
  const hash = await bcrypt.hash('af2026', 10);
  const admin = await prisma.user.create({
    data: {
      name: 'Admin AF',
      email: 'admin@af.com.br',
      password: hash,
      role: Role.ADMIN,
      accountId: account.id,
    },
  });
  const gerente = await prisma.user.create({
    data: {
      name: 'Carlos Gerente',
      email: 'gerente@af.com.br',
      password: hash,
      role: Role.MANAGER,
      accountId: account.id,
    },
  });
  const agente = await prisma.user.create({
    data: {
      name: 'Ana Agente',
      email: 'agente@af.com.br',
      password: hash,
      role: Role.AGENT,
      accountId: account.id,
    },
  });

  // Companies
  const companies = await Promise.all([
    prisma.company.create({ data: { name: 'Tech Solutions Ltda', email: 'contato@techsolutions.com.br', phone: '11999990001', accountId: account.id } }),
    prisma.company.create({ data: { name: 'Construtora Alpha', email: 'alpha@construtora.com.br', phone: '11999990002', accountId: account.id } }),
    prisma.company.create({ data: { name: 'Indústria Beta S.A.', email: 'beta@industria.com.br', phone: '11999990003', accountId: account.id } }),
  ]);

  // Contacts
  const contacts = await Promise.all([
    prisma.contact.create({ data: { name: 'Roberto Alves', email: 'roberto@techsolutions.com.br', phone: '11988880001', companyId: companies[0].id, accountId: account.id } }),
    prisma.contact.create({ data: { name: 'Mariana Costa', email: 'mariana@construtora.com.br', phone: '11988880002', companyId: companies[1].id, accountId: account.id } }),
    prisma.contact.create({ data: { name: 'Felipe Souza', email: 'felipe@industria.com.br', phone: '11988880003', companyId: companies[2].id, accountId: account.id } }),
    prisma.contact.create({ data: { name: 'Juliana Lima', email: 'juliana@gmail.com', phone: '11988880004', accountId: account.id } }),
    prisma.contact.create({ data: { name: 'Paulo Mendes', email: 'paulo@empresa.com.br', phone: '11988880005', accountId: account.id } }),
  ]);

  // Pipeline
  const pipeline = await prisma.pipeline.create({
    data: {
      name: 'Pipeline Principal',
      accountId: account.id,
      stages: {
        create: [
          { name: 'Prospecção', color: '#3b82f6', order: 1 },
          { name: 'Qualificação', color: '#f59e0b', order: 2 },
          { name: 'Proposta', color: '#8b5cf6', order: 3 },
          { name: 'Negociação', color: '#f97316', order: 4 },
          { name: 'Fechado', color: '#10b981', order: 5 },
        ],
      },
    },
    include: { stages: { orderBy: { order: 'asc' } } },
  });

  const [s1, s2, s3, s4, s5] = pipeline.stages;
  const users = [admin, gerente, agente];

  // Leads
  const leadsData = [
    { name: 'Financiamento Imobiliário - Roberto', value: 450000, stageId: s1.id, userId: admin.id, contactId: contacts[0].id, companyId: companies[0].id, tags: ['imobiliário', 'prioritário'] },
    { name: 'Consórcio Veículos - Mariana', value: 85000, stageId: s2.id, userId: gerente.id, contactId: contacts[1].id, companyId: companies[1].id, tags: ['consórcio'] },
    { name: 'Crédito Empresarial - Indústria Beta', value: 320000, stageId: s2.id, userId: agente.id, contactId: contacts[2].id, companyId: companies[2].id, tags: ['empresarial', 'grande-porte'] },
    { name: 'Refinanciamento - Juliana Lima', value: 75000, stageId: s3.id, userId: admin.id, contactId: contacts[3].id, tags: ['refinanciamento'] },
    { name: 'Seguro Vida - Paulo Mendes', value: 12000, stageId: s3.id, userId: gerente.id, contactId: contacts[4].id, tags: ['seguro'] },
    { name: 'Previdência Privada - Roberto Alves', value: 150000, stageId: s4.id, userId: admin.id, contactId: contacts[0].id, companyId: companies[0].id, tags: ['previdência', 'prioritário'] },
    { name: 'Financiamento Maquinário - Alpha', value: 280000, stageId: s4.id, userId: agente.id, contactId: contacts[1].id, companyId: companies[1].id, tags: ['industrial'] },
    { name: 'Crédito Pessoal - Mariana Costa', value: 35000, stageId: s5.id, userId: gerente.id, contactId: contacts[1].id, tags: ['pessoal'] },
    { name: 'Seguro Empresarial - Beta S.A.', value: 48000, stageId: s5.id, userId: agente.id, contactId: contacts[2].id, companyId: companies[2].id, tags: ['seguro', 'empresarial'] },
    { name: 'Consórcio Imóvel - Paulo Mendes', value: 200000, stageId: s1.id, userId: admin.id, contactId: contacts[4].id, tags: ['consórcio', 'imobiliário'] },
  ];

  const leads = await Promise.all(
    leadsData.map((l) =>
      prisma.lead.create({
        data: {
          ...l,
          pipelineId: pipeline.id,
          accountId: account.id,
          status: l.stageId === s5.id ? LeadStatus.WON : LeadStatus.OPEN,
        },
      })
    )
  );

  // Messages
  const channels = [Channel.WHATSAPP, Channel.INSTAGRAM, Channel.TELEGRAM];
  for (const lead of leads.slice(0, 6)) {
    const ch = channels[Math.floor(Math.random() * channels.length)];
    await prisma.message.createMany({
      data: [
        { content: 'Olá! Gostaria de mais informações sobre o produto.', direction: Direction.INBOUND, channel: ch, leadId: lead.id, read: true, createdAt: new Date(Date.now() - 86400000 * 3) },
        { content: 'Claro! Posso te apresentar nossas condições. Qual o melhor horário para conversar?', direction: Direction.OUTBOUND, channel: ch, leadId: lead.id, read: true, createdAt: new Date(Date.now() - 86400000 * 2) },
        { content: 'Pode ser amanhã às 14h.', direction: Direction.INBOUND, channel: ch, leadId: lead.id, read: false, createdAt: new Date(Date.now() - 3600000) },
      ],
    });
  }

  // Notes
  await prisma.note.createMany({
    data: [
      { content: 'Cliente muito interessado, aguarda proposta formal.', type: NoteType.COMMENT, leadId: leads[0].id },
      { content: 'Ligação realizada. Confirmou interesse no produto.', type: NoteType.CALL, leadId: leads[1].id },
      { content: 'E-mail com proposta enviado.', type: NoteType.EMAIL, leadId: leads[2].id },
      { content: 'Lead movido para Proposta.', type: NoteType.STAGE_CHANGE, leadId: leads[3].id },
    ],
  });

  // Tasks
  const now = new Date();
  const past = (d: number) => new Date(now.getTime() - 86400000 * d);
  const future = (d: number) => new Date(now.getTime() + 86400000 * d);

  await prisma.task.createMany({
    data: [
      { title: 'Enviar proposta para Roberto Alves', dueAt: past(2), done: false, userId: admin.id, leadId: leads[0].id },
      { title: 'Ligar para Mariana Costa', dueAt: past(1), done: false, userId: gerente.id, leadId: leads[1].id },
      { title: 'Reunião com Indústria Beta', dueAt: future(1), done: false, userId: agente.id, leadId: leads[2].id },
      { title: 'Enviar documentação de refinanciamento', dueAt: future(2), done: false, userId: admin.id, leadId: leads[3].id },
      { title: 'Follow-up seguro vida Paulo', dueAt: future(3), done: false, userId: gerente.id, leadId: leads[4].id },
      { title: 'Apresentar simulação previdência', dueAt: future(5), done: true, userId: admin.id, leadId: leads[5].id },
      { title: 'Vistoria financiamento maquinário', dueAt: past(3), done: true, userId: agente.id, leadId: leads[6].id },
      { title: 'Confirmar assinatura contrato Alpha', dueAt: future(7), done: false, userId: gerente.id, leadId: leads[7].id },
    ],
  });

  console.log('✅ Seed concluído!');
  console.log('');
  console.log('Usuários criados:');
  console.log('  admin@af.com.br    / af2026 (Admin)');
  console.log('  gerente@af.com.br  / af2026 (Manager)');
  console.log('  agente@af.com.br   / af2026 (Agent)');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
