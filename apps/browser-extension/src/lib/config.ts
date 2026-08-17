// Fase 0: sem build de dev/prod separado ainda (a extensão não passa pelo
// pipeline de deploy do CRM — "publicar" é você recarregar em
// chrome://extensions). Aponta pra produção por padrão; troque pra
// 'http://localhost:3001' aqui mesmo se for testar contra a API local.
export const API_URL = 'https://af-crm-production.up.railway.app';
