// Linguagem falada (transcrições de vídeo): separa o CONTEÚDO da conversa.
//
// Problema real encontrado: num vídeo de bate-papo, o motor tratava "cara", "entendeu",
// "rapaziada", o nome do apresentador e o cupom do patrocinador como conceitos, e montava
// perguntas com frases como "Cara, _____, de onde você tirou isso?". Aqui fica tudo que
// distingue fala de conteúdo:
//   1. scrub()        — tira vícios de linguagem, vocativos e perguntas-muleta ("tá?", "entendeu?")
//   2. isPromo()      — propaganda, cupom, "se inscreva", redes sociais, abertura/encerramento
//   3. speakerNames() — nomes usados como vocativo ("…, Ana?") ou em cupom: não são conceito
//   4. infoScore()    — quanto a frase EXPLICA algo (termos de conteúdo, causa, número, definição)
import { tokenize, isStop } from './text.js';

// Palavras de conversa que nunca são conceito (PT e EN).
export const SPOKEN_WORDS = new Set(`
cara caras mano manos velho véi véio irmão mermão brother bro galera rapaziada pessoal gente família
parada paradas negócio negócios lance bagulho trem treco coisa coisinha
entendeu entende entendi entenderam sabe sabia sacou ligado ligada beleza fechou show top massa maneiro legal bacana
pô poxa porra caramba caraca nossa cacete putz vish eita opa aham uhum hein
basicamente literalmente simplesmente realmente justamente exatamente obviamente provavelmente geralmente normalmente
praticamente certamente claramente totalmente absolutamente principalmente especialmente inclusive tipo
pouquinho pouco poucos pouca poucas muito muita muitos muitas bastante demais algum alguma alguns algumas nenhum nenhuma
vários várias certo certa verdade enfim acho achar achei acha achamos falar falei falou fala falando falamos dizer disse digo
explicar explico expliquei explicando mostrar mostro mostrei lembrar lembra lembro imagina imagine olha olhar
querer quero quer queria queriam saber vamos vou vai vão estava estavam tava tavam tô tamo
hoje ontem amanhã semana semanas mês meses ano anos agora daqui ali lá aqui noite noites manhã tarde dia dias
vídeo vídeos canal canais live comentário comentários link descrição inscrito inscritos cupom desconto
deus amém obrigado obrigada valeu tchau abraço beijo repente verdade jeito questão
guys dude man bro yeah yep nope okay ok like literally basically actually honestly totally really pretty
stuff thing things kinda sorta gonna wanna gotta
posso pode podem poderia poderiam podemos temos tenho tem tinha tinham teria faço fazemos fazer fiz fez feito
consigo conseguimos consegue conseguir preciso precisamos precisa quero queremos sei sabemos fica ficar ficou
coloca coloco colocar colocamos vejo vemos ver vimos chegar chega chegou passa passar pega pegar pegamos
através dentro fora junto onde aonde então daí aí tipo né tá
`.trim().split(/\s+/));

// Expressões inteiras que não são conceito
export const SPOKEN_PHRASES = ['amor de deus', 'pelo amor', 'meu deus', 'graças a deus', 'tá ligado', 'tipo assim', 'de repente',
  'de verdade', 'hoje em dia', 'no caso', 'nesse caso', 'pra caramba', 'pra caralho', 'por exemplo', 'sei lá', 'quer dizer',
  'you know', 'i mean', 'kind of', 'sort of'];

// Abertura, encerramento, propaganda e pedidos de engajamento
const PROMO_RE = new RegExp([
  'inscrev', 'se inscreve', 'deix[ae] (o |seu |aquele )?like', 'curt[ea] o v[íi]deo', 'sininho', 'notifica[çc]',
  'cupom', 'desconto', 'c[óo]digo promocional', 'link (t[áa] |est[áa] )?(aqui )?na descri[çc]', 'na descri[çc][ãa]o',
  'redes sociais', 'me segue', 'me siga', 'segue l[áa]', 'instagram', 'tiktok', 'twitter', 'patroc[íi]n', 'parceir[oa] d[oe] canal',
  'parceria', 'compartilh', 'coment(a|e|em|ar) (aqui|a[íi]|embaixo|abaixo)', 'nos coment[áa]rios', 'pr[óo]ximo v[íi]deo',
  'v[íi]deo passado', '[úu]ltimo v[íi]deo', 'fala,? (pessoal|galera|rapaziada|meu povo)', 'e a[íi],? (pessoal|galera|rapaziada)',
  'bem[- ]vind[oa]s?', 'at[ée] o pr[óo]ximo', 'at[ée] a pr[óo]xima', 'um abra[çc]o', 'um beijo', 'membro do canal', 'seja membro',
  'subscribe', 'like (button|the video)', 'hit the bell', 'sponsor', 'promo code', 'discount', 'link in the description',
  'follow me', 'patreon', 'merch', 'comment below', 'next video', 'thanks for watching', 'see you (next|in the)',
  // autopromoção do canal: cursos, guias, formações, mentorias, "acesse/confira o link"
  'nosso curso', 'nossa forma[çc][ãa]o', 'nossa mentoria', 'inscri[çc][õo]es abertas', 'acess[ae] o link', 'confir[ao] o link',
  'link (aqui )?(embaixo|abaixo)', 'oferecimento', 'apoio d[oa] ', 'e-?book gratuito', 'material gratuito',
].join('|'), 'i');

// Perguntas-muleta no fim de oração: "é difícil, tá?" → "é difícil."
const TAG_Q = /[,\s]+(t[áa] ligad[oa]|t[áa] bom|t[áa] certo|t[áa]|n[ée]|entendeu|entende|sabe|certo|beleza|fechou|ok|okay|viu|sacou|concorda|percebe|show|right|you know|okay)\s*\?/gi;
// Vocativos entre vírgulas ou no começo: "Então, cara, isso…" → "Então, isso…"
const VOCATIVE = /(^|[,;:.!?]\s*)(cara|mano|velho|v[ée]io?|irm[ãa]o|merm[ãa]o|brother|bro|galera|rapaziada|pessoal|gente|meu amigo|minha amiga|meus amigos|meu querido|fam[íi]lia|guys|man|dude)\s*(?=[,;:.!?]|$)[,]?/gi;
// Interjeições e marcadores no começo da frase (podem vir vários seguidos)
const LEAD = /^((eh+|ah+|oh+|hum+|hm+|uh+|ahn+|p[ôo]|poxa|caramba|caraca|nossa|putz|vish|eita|opa|tipo assim|tipo|assim|enfim|olha( s[óo])?|bom|bem|ent[ãa]o|a[íi]|e a[íi]|da[íi]|beleza|mas assim|sabe|cara|mano|velho|so|well|like|okay|ok|um+|uh+)\s*[,.]?\s+)+/i;
// Muletas no meio da frase
const MID = /,?\s*\b(como eu (falei|disse|expliquei)( (para|pra) voc[êe]s?)?|como eu t[ôo] falando|vou explicar (para|pra) voc[êe]s?( um pouco)?|deixa eu (te |lhes )?(falar|explicar)|vamos l[áa]|presta aten[çc][ãa]o|olha s[óo]|pra voc[êe] ter uma ideia|(para|pra) voc[êe]s?|tipo assim|sei l[áa]|quer dizer|n[ée]|t[áa] ligad[oa]|entendeu|basicamente|literalmente|you know|i mean|kind of|sort of|eh+|ahn+|hum+|uh+)\b\s*,?/gi;

export function scrub(text) {
  let t = ' ' + String(text) + ' ';
  t = t.replace(/\b(\p{L}+)( \1\b)+/giu, '$1');            // "que que", "o o"
  t = t.replace(TAG_Q, '.');
  t = t.replace(VOCATIVE, '$1');
  t = t.replace(MID, (m) => (m.trim().startsWith(',') ? ',' : ' '));
  t = t.trim().replace(LEAD, '');
  t = t.replace(/\s+([,.;:!?])/g, '$1').replace(/([,;:])(?=[,.;:!?])/g, '').replace(/^[,;:.\s]+/, '')
    .replace(/,\s*\./g, '.').replace(/\.{2,}/g, '.').replace(/\s{2,}/g, ' ').trim();
  if (!t) return '';
  if (!/[.!?…]$/.test(t)) t += '.';
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// Tira marcadores do começo de um trecho ("Né, você vai…" → "você vai…")
export function stripLead(text) {
  return String(text).trim().replace(LEAD, '').replace(/^(n[ée]|t[áa])\s*[,.]?\s+/i, '');
}

export function isPromo(text) {
  return PROMO_RE.test(text);
}

// Nomes próprios que aparecem como vocativo ("…, Ana?") ou junto de cupom/patrocínio.
export function speakerNames(sentences) {
  const voc = new Map(), total = new Map();
  for (const s of sentences) {
    for (const m of s.text.matchAll(/(?<=[,]\s*|^)(\p{Lu}\p{Ll}{2,})(?=\s*[,?!.]|$)/gu)) voc.set(m[1], (voc.get(m[1]) || 0) + 1);
    for (const m of s.text.matchAll(/(?<!^)(?<![.!?]\s)\b(\p{Lu}\p{Ll}{2,})\b/gu)) total.set(m[1], (total.get(m[1]) || 0) + 1);
    if (isPromo(s.text)) {
      for (const m of s.text.matchAll(/\b(?:cupom|c[óo]digo|code)\s+(\p{L}+)/giu)) voc.set(cap(m[1]), (voc.get(cap(m[1])) || 0) + 2);
    }
  }
  const names = new Set();
  for (const [name, n] of voc) if (n >= 1 && n >= (total.get(name) || 0) * 0.3) names.add(name.toLowerCase());
  return names;
}
const cap = s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

// Marcas citadas na propaganda ("…na Lumina", "…na Loja X"): somem junto com o bloco de anúncio.
function promoBrands(sentences) {
  const brands = new Set();
  for (const s of sentences) {
    if (!isPromo(s.text)) continue;
    for (const m of s.text.matchAll(/\b(?:na|no|da|do|at|on)\s+(\p{Lu}[\p{L}\d]+)/gu)) brands.add(m[1].toLowerCase());
  }
  return brands;
}

const EXPLAIN_RE = /\b(porque|pois|j[áa] que|uma vez que|por isso|portanto|ou seja|significa|consiste|depende|faz com que|leva a|resulta|causa|aumenta|diminui|reduz|melhora|piora|evita|permite|garante|serve para|é (um|uma|o|a) |s[ãa]o (os|as) |quanto mais|quanto menos|se voc[êe]|quando voc[êe]|because|therefore|which means|depends|leads to|results in|increases|decreases|reduces|improves|avoids|allows|is an? )\b/i;
const FIRST_PERSON = /\b(eu|me|meu|minha|comigo|t[ôo]|tava|i|my|me)\b/gi;

// Quanto a frase ensina algo. Usado para escolher frases-fonte de perguntas e o resumo.
export function infoScore(text, contentWords) {
  const toks = tokenize(text);
  if (!toks.length) return 0;
  const content = contentWords ?? toks.filter(t => !isStop(t) && !SPOKEN_WORDS.has(t.toLowerCase()) && t.length >= 4).length;
  const fp = (text.match(FIRST_PERSON) || []).length / toks.length;
  let s = content;
  if (EXPLAIN_RE.test(text)) s += 3;
  if (/\d/.test(text) || /\b(duas?|tr[êe]s|quatro|cinco|seis|sete|oito|nove|dez|vinte|trinta|cem)\b/i.test(text)) s += 1;
  if (/\?\s*$/.test(text)) s -= 4;          // pergunta retórica raramente afirma algo
  if (/\b(v[íi]deo|canal|video|channel)\b/i.test(text)) s -= 3; // fala sobre o vídeo, não sobre o assunto
  if (fp > 0.12) s -= 3;                     // relato pessoal ("eu não tô com a camiseta hoje")
  return s;
}

/**
 * Prepara frases faladas: remove propaganda/abertura/encerramento e relatos sem conteúdo,
 * limpa os vícios de linguagem e devolve também o que deve ser ignorado como conceito.
 * Cada frase mantém o `start` (minuto no vídeo).
 */
export function prepareSpoken(sentences) {
  const names = speakerNames(sentences);
  const brands = promoBrands(sentences);
  const promoIdx = new Set();
  sentences.forEach((s, i) => { if (isPromo(s.text)) promoIdx.add(i); });
  // bloco de anúncio: frases vizinhas (±3) de uma promo que citam a marca, ou presas entre duas promos
  // Índices ordenados + busca binária: O(log P) por frase. (Auditoria de segurança: a versão
  // anterior refazia e varria a lista dentro de some() aninhado, custo ~N·P² — texto com muita
  // "propaganda" prendia a thread de análise.)
  const promos = [...promoIdx].sort((a, b) => a - b);
  const firstAfter = (i) => { let lo = 0, hi = promos.length; while (lo < hi) { const m = (lo + hi) >> 1; if (promos[m] > i) hi = m; else lo = m + 1; } return lo; };
  const prevOf = i => { const k = firstAfter(i - 1) - 1; return k >= 0 ? promos[k] : null; }; // maior promo < i
  const nextOf = i => { const k = firstAfter(i); return k < promos.length ? promos[k] : null; };      // menor promo > i
  const near = i => { const p = prevOf(i), n = nextOf(i); return (p != null && i - p <= 3) || (n != null && n - i <= 3) || promoIdx.has(i); };
  const between = i => { const p = prevOf(i), n = nextOf(i); return p != null && n != null && n - p <= 6; };
  const brandRe = brands.size ? new RegExp(`\\b(${[...brands].map(b => b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i') : null;

  // "…, Ana, …" → "…, …": o nome de quem fala sai da frase (o scrub limpa as vírgulas)
  const nameRe = names.size ? new RegExp(`([,;:.!?]|^)\\s*(${[...names].join('|')})\\s*(?=[,;:.!?]|$)`, 'giu') : null;
  const kept = [];
  let dropped = 0;
  sentences.forEach((s, i) => {
    const promo = promoIdx.has(i) || between(i) || (brandRe && near(i) && brandRe.test(s.text));
    if (promo) { dropped++; return; }
    const text = scrub(nameRe ? s.text.replace(nameRe, '$1') : s.text);
    const toks = tokenize(text);
    const content = toks.filter(t => !isStop(t) && !SPOKEN_WORDS.has(t.toLowerCase()) && !names.has(t.toLowerCase()) && t.length >= 4).length;
    if (toks.length < 5 || content < 3) { dropped++; return; }
    kept.push({ ...s, text, info: infoScore(text, content) });
  });
  return { sentences: kept, ignore: new Set([...names, ...brands]), dropped };
}

// Heurística: a fonte é fala (vídeo/aula transcrita) e não texto escrito?
export function looksSpoken(sentences) {
  const sample = sentences.slice(0, 400).map(s => s.text).join(' ').toLowerCase();
  const words = sample.split(/\s+/).length || 1;
  const hits = (sample.match(/\b(tá|né|cara|mano|galera|pessoal|entendeu|beleza|tipo|gente|aí|então|you know|guys|gonna|okay)\b/g) || []).length;
  return hits / words > 0.012;
}
