import LeadRedirect from './lead-redirect';

export async function generateStaticParams() {
  return [{ id: 'placeholder' }];
}

// A tela antiga de detalhe do lead foi aposentada (Fabio não usa — 09/10):
// qualquer link antigo pra /leads/:id abre o card na Inbox.
export default function LeadDetailPage() {
  return <LeadRedirect />;
}
