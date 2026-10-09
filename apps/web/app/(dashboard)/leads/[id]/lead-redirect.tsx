'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** /leads/:id → /inbox?leadId=:id (export estático: o id vem da URL de verdade). */
export default function LeadRedirect() {
  const router = useRouter();
  useEffect(() => {
    const id = window.location.pathname.split('/').filter(Boolean)[1];
    router.replace(id && id !== 'placeholder' ? `/inbox?leadId=${id}` : '/inbox');
  }, [router]);
  return <div className="flex-1 flex items-center justify-center text-sm text-slate-400">Abrindo o card…</div>;
}
