/** SEXO PELO NOME (Fabio 06/11: "o CRM deveria entender pelo nome e informar o sexo, quando não houver e for necessário").
 *  Só serve de reserva: documento/proposta com o sexo informado vem sempre primeiro. Olha o PRIMEIRO nome ("José Maria" = M,
 *  "Maria José" = F) com as terminações dos nomes brasileiros + listas de exceção. null = nome que não dá pra dizer (Darci, Juraci…).
 *  A MESMA lógica está copiada na extensão do Credimorar (background.js, sexoPeloNome) — mudou aqui, muda lá. Pura (testável). */

const F_LISTA = new Set(('beatriz liz laiz thaiz taiz raquel rachel isabel mabel maribel abigail muriel cristel christel ester esther ruth rute judith judite edith '
  + 'elizabeth elisabeth elizabet elisabet margaret janet juliet scarlet lourdes lurdes ines mercedes dolores gladys iris thais tais lais doris agnes '
  + 'carmen carmem miriam mirian myriam karen karin kristen ellen hellen helen evelyn evelin jocelyn jocelin marilyn marlyn jaquelin lilian lillian vivian jilian '
  + 'susan suzan megan ingrid astrid sigrid yasmin yasmim jasmin jasmim nair lucimar rosimar dulcimar guiomar mary nancy daisy deisy shirley kelly kely nely '
  + 'suely cely sirley marly socorro zoe chloe noemi naomi marilu malu lu sirlei rosinei lucinei gracinei').split(' '));
const M_LISTA = new Set(('luca lucca nicola joshua jeova juca mustafa jose rene wallace noe davi levi henri ari eli rui ruy luigi giovanni gianni yuri iuri ravi '
  + 'rony roni willy jhony jhonny johnny wesley henry harry jimmy danny fredy andy rudy kenneth keith seth joseph ralph franklin').split(' '));
const DUVIDA = new Set('darci darcy juraci jaci jacy ariel kim jordan sasha'.split(' '));

const semAcento = (t: unknown) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function sexoPeloNome(nome: unknown): 'M' | 'F' | null {
  if (/ã$/i.test(String(nome ?? '').trim().split(/\s+/)[0] || '')) return 'M'; // Kauã, Cauã, Ruã (sem o til viraria "-a")
  const n = semAcento(nome).replace(/[^a-z\s]/g, ' ').trim().split(/\s+/)[0] || '';
  if (n.length < 2 || DUVIDA.has(n)) return null;
  if (F_LISTA.has(n)) return 'F';
  if (M_LISTA.has(n)) return 'M';
  if (/a$/.test(n)) return 'F';
  if (/e$/.test(n)) return /(ane|ene|ine|one|une|ele|elle|ise|isse|ice|ce|ete|ette|ide|ilde|ude|ie|ze|se|ange)$/.test(n) ? 'F' : 'M';
  if (/(ah|len|lyn)$/.test(n)) return 'F';                         // Sarah, Suelen, Evelyn
  if (/eci$/.test(n)) return 'M';                                  // Valdeci, Aldeci
  if (/(li|ni|si|zi|ri|ly|ny)$/.test(n)) return 'F';               // Sueli, Marli, Ivani, Rosi, Suzi, Mari, Rosemeri
  if (/y$/.test(n)) return null;
  return 'M';                                                      // o, r, s, l, n, m, d, z, u, ei, i… (Pedro, Osmar, Lucas, Daniel, Ivan, William, Luiz, Claudinei)
}

const MF = (v: unknown): 'M' | 'F' | null => { const n = semAcento(v).trim(); return /^f/.test(n) ? 'F' : /^m/.test(n) ? 'M' : null; };

/** Gênero do card (campos "Gênero"/"Gênero 2" = genero_1/genero_2, Fabio 06/11) do participante com esse nome. `equipe` = alguém pôs à mão (o que o CRM
 *  gravou sozinho fica em `_generoAuto`). Pura. */
export function generoDoCard(cf: Record<string, any> | null | undefined, nome: unknown): { sexo: 'M' | 'F'; equipe: boolean } | null {
  const n = semAcento(nome).replace(/[^a-z\s]/g, ' ').trim().split(/\s+/);
  if (!cf || !n[0]) return null;
  for (const i of [1, 2]) {
    const p = semAcento(cf[`participante_${i}`]).replace(/[^a-z\s]/g, ' ').trim().split(/\s+/);
    if (!p[0] || p[0] !== n[0] || (p.length > 1 && n.length > 1 && p[p.length - 1] !== n[n.length - 1])) continue;
    const sexo = MF(cf[`genero_${i}`]);
    return sexo ? { sexo, equipe: String(cf._generoAuto?.[i] ?? '') !== String(cf[`genero_${i}`]) } : null;
  }
  return null;
}

/** Sexo pra formulário/portal: o "Gênero" do card posto pela EQUIPE → o do documento/proposta → o do card (CRM) → o primeiro nome. Pura. */
export function sexoParaFormulario(cf: Record<string, any> | null | undefined, nome: unknown, doDocumento?: unknown): 'M' | 'F' | null {
  const card = generoDoCard(cf, nome);
  if (card?.equipe) return card.sexo;
  return MF(doDocumento) || card?.sexo || sexoPeloNome(nome);
}

/** "Feminino" | "Masculino" | "" — pro formato que os portais/formulários pedem. */
export function generoPeloNome(nome: unknown): 'Feminino' | 'Masculino' | '' {
  const s = sexoPeloNome(nome);
  return s === 'F' ? 'Feminino' : s === 'M' ? 'Masculino' : '';
}
