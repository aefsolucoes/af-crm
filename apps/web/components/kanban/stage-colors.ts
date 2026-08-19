// Paleta de cores pras etapas do funil — mesma paleta já usada em
// chat-window.tsx (SENDER_COLORS, cor estável por remetente em grupos) por
// consistência visual entre as duas telas.
export const STAGE_COLORS = [
  '#2261a8', '#00a884', '#e542a3', '#ff7e00', '#6a5cff',
  '#0ea5e9', '#e0453e', '#7c9c00', '#b26bff', '#d97706',
];

/** Cor "aleatória, mas estável dentro da mesma sessão de criação" — só pra
 *  nunca cair no cinza padrão de novo quando o usuário não escolhe nenhuma. */
export function randomStageColor(): string {
  return STAGE_COLORS[Math.floor(Math.random() * STAGE_COLORS.length)];
}
