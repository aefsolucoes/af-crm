import LeadDetailClient from './lead-detail-client';

export async function generateStaticParams() {
  return [{ id: 'placeholder' }];
}

export default function LeadDetailPage() {
  return <LeadDetailClient />;
}
