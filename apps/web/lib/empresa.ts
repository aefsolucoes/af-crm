// Nome da empresa nas telas (plano do piloto, Fabio 23/11: "abrir o CRM para outras pessoas"). Cada cópia do CRM de outro correspondente define
// NEXT_PUBLIC_EMPRESA_NOME / NEXT_PUBLIC_EMPRESA_CURTO no build; sem elas = A&F (igual a antes). Os dados usados nos e-mails e na IA ficam na API
// (Account.empresa — GET/PUT /api/settings/empresa).
export const EMPRESA_NOME = process.env.NEXT_PUBLIC_EMPRESA_NOME || 'A&F Soluções Financeiras';
export const EMPRESA_CURTO = process.env.NEXT_PUBLIC_EMPRESA_CURTO || 'A&F Soluções';
