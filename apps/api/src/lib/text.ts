/** Nome de cliente (Lead/Contact) sempre em CAIXA ALTA, não importa como
 *  chegou — digitado num formulário, perfil do WhatsApp, cartão de contato
 *  compartilhado, importação de CSV, ou ferramenta do assistente de IA.
 *  Regra pedida pra manter os cards padronizados, mesmo que o colaborador
 *  (ou o cliente, via WhatsApp) escreva em caixa baixa/mista. */
export function normalizeClientName(name: string): string {
  return name.trim().toUpperCase();
}
