// Ingestão de conteúdo: YouTube (legendas públicas), PDF (upload/URL), artigo web e texto colado.
// Nenhuma API paga: legendas vêm do próprio player do YouTube; PDF é lido localmente.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { extractText } from 'unpdf';
import { clean, splitSentences } from '../nlp/text.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_CHARS = 400_000; // ~60 mil palavras: um livro curto

export class IngestError extends Error {
  constructor(message, hint) { super(message); this.hint = hint; this.status = 422; }
}

// ---------- proteção contra SSRF
// O servidor busca links enviados pelo usuário. Sem cuidado, um link pode apontar para a rede
// interna (roteador, metadados de nuvem em 169.254.169.254, serviços em localhost). Bloqueamos
// pelo ENDEREÇO RESOLVIDO (não pelo nome), no momento da conexão (fecha DNS rebinding), e
// revalidamos a cada redirecionamento.
// Listas separadas: num BlockList único, uma faixa IPv6 mapeada (::ffff:0:0/96) casaria com TODO IPv4.
const blocked4 = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) {
  blocked4.addSubnet(a, p, 'ipv4');
}
const blocked6 = new net.BlockList();
// ::/96 (IPv4-compatível, inclui :: e ::1), NAT64 (global e local), 6to4, Teredo, documentação, ULA, link-local, multicast
for (const [a, p] of [['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) {
  blocked6.addSubnet(a, p, 'ipv6');
}

// "::ffff:127.0.0.1" e "::ffff:7f00:1" são o IPv4 127.0.0.1 escrito em IPv6
function mappedIPv4(ip) {
  const m = ip.toLowerCase().match(/^(?:0{0,4}:){0,5}:?ffff:(.+)$/);
  if (!m) return null;
  if (net.isIPv4(m[1])) return m[1];
  const h = m[1].match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!h) return null;
  const hi = parseInt(h[1], 16), lo = parseInt(h[2], 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
}

export function isPrivateAddress(ip) {
  const v = net.isIP(ip);
  if (!v) return true;
  if (v === 4) return blocked4.check(ip, 'ipv4');
  const v4 = mappedIPv4(ip);
  return v4 ? blocked4.check(v4, 'ipv4') : blocked6.check(ip, 'ipv6');
}

function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true }, (err, addrs) => {
    if (err) return callback(err);
    if (!addrs.length || addrs.some(a => isPrivateAddress(a.address))) {
      return callback(new IngestError('Links para a rede interna não são permitidos.'));
    }
    if (options?.all) return callback(null, addrs);
    callback(null, addrs[0].address, addrs[0].family);
  });
}

function requestOnce(url, { headers, timeout }) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.get(url, {
      lookup: safeLookup, timeout,
      headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8', 'Accept-Encoding': 'identity', ...headers },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve({ redirect: res.headers.location });
      }
      if (res.statusCode >= 400) { res.resume(); return reject(new IngestError(`O servidor respondeu ${res.statusCode} ao buscar o conteúdo.`)); }
      if (Number(res.headers['content-length'] || 0) > MAX_BYTES) { res.destroy(); return reject(new IngestError('Arquivo grande demais (limite de 25 MB).')); }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES) { res.destroy(); reject(new IngestError('Arquivo grande demais (limite de 25 MB).')); } else chunks.push(c);
      });
      res.on('end', () => resolve({ buf: Buffer.concat(chunks), type: String(res.headers['content-type'] || '') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new IngestError('Não consegui baixar o conteúdo (tempo esgotado).')));
    // `timeout` acima é de inatividade; este é o prazo TOTAL (um servidor que manda um byte por
    // vez não segura a conexão e o buffer para sempre)
    const total = setTimeout(() => req.destroy(new IngestError('Não consegui baixar o conteúdo (tempo esgotado).')), timeout * 3);
    req.on('close', () => clearTimeout(total));
    req.on('error', e => reject(e instanceof IngestError ? e : new IngestError('Não consegui baixar o conteúdo (' + e.message + ').')));
  });
}

const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtube-nocookie.com']);
export function youtubeId(url) {
  let host;
  try { host = new URL(String(url)).hostname.toLowerCase(); } catch { return null; }
  if (!YT_HOSTS.has(host)) return null; // "youtube.com/watch?v=…" no meio de outro link não conta
  const m = String(url).match(/(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/))([\w-]{11})/);
  return m ? m[1] : null;
}

export function assertPublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new IngestError('Link inválido.'); }
  if (!/^https?:$/.test(u.protocol)) throw new IngestError('Use um link http(s).');
  if (u.username || u.password) throw new IngestError('Links com usuário e senha não são aceitos.');
  const h = u.hostname.replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || (net.isIP(h) && isPrivateAddress(h))) {
    throw new IngestError('Links para a rede interna não são permitidos.');
  }
  return u;
}

/** GET com limite de tamanho e tempo, bloqueio de rede interna e redirecionamentos revalidados. */
export async function fetchWithLimit(raw, { timeout = 20000, headers = {}, maxRedirects = 5 } = {}) {
  let url = assertPublicUrl(raw);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const r = await requestOnce(url, { headers, timeout });
    if (!r.redirect) return r;
    url = assertPublicUrl(new URL(r.redirect, url).href);
  }
  throw new IngestError('O link redireciona vezes demais.');
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m; // &#99999999; não derruba a requisição
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

// ---------- YouTube ----------
export function parseCaptionXml(xml) {
  const out = [];
  // formato clássico <text start="1.2" dur="3">...</text>
  for (const m of xml.matchAll(/<text start="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g)) {
    out.push({ start: parseFloat(m[1]), text: decodeEntities(decodeEntities(m[2]).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim() });
  }
  if (!out.length) {
    // formato srv3 <p t="1200" d="...">...</p>
    for (const m of xml.matchAll(/<p t="(\d+)"[^>]*>([\s\S]*?)<\/p>/g)) {
      out.push({ start: parseInt(m[1], 10) / 1000, text: decodeEntities(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim() });
    }
  }
  return out.filter(c => c.text);
}

async function youtubeTranscript(url) {
  const id = youtubeId(url);
  if (!id) throw new IngestError('Não reconheci esse link do YouTube.');
  const { buf } = await fetchWithLimit(`https://www.youtube.com/watch?v=${id}&hl=pt-BR`);
  const html = buf.toString('utf8');
  const key = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
  let title = decodeEntities(html.match(/<title>([^<]*)<\/title>/)?.[1] || '').replace(/ - YouTube$/, '');
  let tracks = null;
  if (key) {
    const res = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38' } }, videoId: id }),
    }).catch(() => null);
    if (res?.ok) {
      const data = await res.json();
      tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || null;
      title = data?.videoDetails?.title || title;
    }
  }
  if (!tracks) {
    const raw = html.match(/"captionTracks":(\[.*?\])/)?.[1];
    if (raw) { try { tracks = JSON.parse(raw); } catch { /* ignora */ } }
  }
  if (!tracks?.length) {
    throw new IngestError('Esse vídeo não tem legendas públicas.',
      'No YouTube, abra "…Mais > Mostrar transcrição", copie o texto e use a aba "Colar texto".');
  }
  const rank = t => (t.languageCode?.startsWith('pt') ? 0 : t.languageCode?.startsWith('en') ? 2 : 4) + (t.kind === 'asr' ? 1 : 0);
  const track = [...tracks].sort((a, b) => rank(a) - rank(b))[0];
  const { buf: xmlBuf } = await fetchWithLimit(track.baseUrl.replace(/&fmt=[^&]+/, ''));
  const captions = parseCaptionXml(xmlBuf.toString('utf8'));
  if (!captions.length) throw new IngestError('A legenda veio vazia.', 'Tente colar a transcrição manualmente.');
  return { title: title || 'Vídeo do YouTube', captions, lang: track.languageCode };
}

// Junta as legendas em frases mantendo o tempo de início de cada uma.
export function captionsToSentences(captions) {
  let full = '';
  const marks = [];
  for (const c of captions) {
    marks.push({ offset: full.length, start: c.start });
    full += clean(c.text) + ' ';
  }
  full = full.replace(/\s+/g, ' ').trim();
  const sentences = splitSentences(full);
  let cursor = 0, mi = 0;
  return sentences.map(text => {
    const probe = text.slice(1, 25);
    const pos = full.indexOf(probe, Math.max(0, cursor - 5));
    const at = pos >= 0 ? pos : cursor;
    cursor = at + text.length;
    while (mi + 1 < marks.length && marks[mi + 1].offset <= at + 1) mi++;
    return { text, start: marks[mi]?.start ?? 0 };
  });
}

// ---------- PDF ----------
async function pdfToSentences(buffer) {
  if (buffer.subarray(0, 5).toString() !== '%PDF-') throw new IngestError('O arquivo não parece ser um PDF.');
  let res;
  try {
    res = await extractText(new Uint8Array(buffer), { mergePages: false });
  } catch (e) {
    throw new IngestError('Não consegui ler esse PDF (' + e.message + ').');
  }
  const pages = Array.isArray(res.text) ? res.text : [res.text];
  const sentences = [];
  let budget = MAX_TEXT_CHARS; // mesmo teto do texto colado, somado sobre as páginas
  for (let i = 0; i < pages.length && budget > 0; i++) {
    const page = capText(clean(pages[i])).slice(0, budget);
    budget -= page.length;
    for (const text of splitSentences(page)) sentences.push({ text, page: i + 1 });
  }
  if (sentences.length < 3) {
    throw new IngestError('O PDF não tem texto selecionável (talvez seja escaneado).', 'PDFs escaneados precisam de OCR; cole o texto se tiver.');
  }
  return { sentences, pages: pages.length };
}

// ---------- Página web ----------
// HTML → texto em UMA passada (tempo linear). Auditoria de segurança: as regex anteriores
// (`<(script|…)[\s\S]*?<\/\1>` e `<[^>]+>`) eram quadráticas em marcação maliciosa com
// muitas tags sem fechamento e travavam a thread principal para todos os usuários.
const SKIP_TAGS = new Set(['script', 'style', 'nav', 'header', 'footer', 'aside', 'noscript', 'svg', 'form', 'template', 'iframe', 'title']);
const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'pre', 'blockquote', 'tr', 'div', 'br', 'section', 'article']);
export function htmlToText(html) {
  const lower = html.toLowerCase();
  const t0 = lower.indexOf('<title');
  const t1 = t0 >= 0 ? lower.indexOf('</title', t0) : -1;
  const titleRaw = t0 >= 0 && t1 > t0 ? html.slice(html.indexOf('>', t0) + 1, t1) : '';
  const title = decodeEntities(titleRaw.replace(/</g, ' ')).trim().slice(0, 200);
  const out = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { out.push(html.slice(i)); break; }
    out.push(html.slice(i, lt));
    const gt = html.indexOf('>', lt + 1);
    if (gt < 0) break; // '<' sem '>' até o fim: o resto não é texto confiável
    const m = /^<\/?\s*([a-z0-9]+)/i.exec(html.slice(lt, Math.min(gt + 1, lt + 40)));
    const name = m ? m[1].toLowerCase() : '';
    const closing = html[lt + 1] === '/';
    i = gt + 1;
    if (!closing && SKIP_TAGS.has(name) && html[gt - 1] !== '/') {
      const end = lower.indexOf('</' + name, i); // busca única para frente: sem retrocesso
      if (end < 0) break;
      const endGt = html.indexOf('>', end);
      i = endGt < 0 ? html.length : endGt + 1;
      out.push(' ');
      continue;
    }
    out.push(BLOCK_TAGS.has(name) ? '\n' : ' ');
  }
  return { title, text: decodeEntities(out.join('')).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n') };
}

// Texto extraído de QUALQUER fonte (página, PDF, colado) passa pelo mesmo teto.
function capText(t) {
  return t.length > MAX_TEXT_CHARS ? t.slice(0, MAX_TEXT_CHARS) : t;
}
const MAX_HTML_BYTES = 5 * 1024 * 1024;

export async function loadSource({ type, url, text, buffer, title }) {
  if (type === 'text') {
    if (String(text || '').length > MAX_TEXT_CHARS) throw new IngestError('Texto grande demais (limite de ~60 mil palavras).', 'Divida o material em partes e crie um estudo para cada uma.');
    const t = clean(text);
    if (t.split(/\s+/).length < 80) throw new IngestError('O texto está curto demais para gerar uma prova (mínimo de ~80 palavras).');
    return { title: title || t.split(/\n/)[0].slice(0, 80), sourceType: 'text', sourceUrl: null, sentences: splitSentences(t).map(s => ({ text: s })) };
  }
  if (type === 'pdf') {
    const { sentences, pages } = await pdfToSentences(buffer);
    return { title: title || 'Documento PDF', sourceType: 'pdf', sourceUrl: null, sentences, pages };
  }
  if (type === 'url') {
    assertPublicUrl(url);
    if (youtubeId(url)) {
      const yt = await youtubeTranscript(url);
      return { title: title || yt.title, sourceType: 'youtube', sourceUrl: url, videoId: youtubeId(url), sentences: captionsToSentences(yt.captions) };
    }
    const { buf, type: ctype } = await fetchWithLimit(url);
    if (ctype.includes('pdf') || buf.subarray(0, 5).toString() === '%PDF-') {
      const { sentences, pages } = await pdfToSentences(buf);
      let name = url.split('/').pop() || 'PDF';
      try { name = decodeURIComponent(name); } catch { /* %-sequência malformada: usa o nome cru */ }
      return { title: title || name.slice(0, 160), sourceType: 'pdf', sourceUrl: url, sentences, pages };
    }
    if (ctype.includes('html') || ctype.includes('text')) {
      if (buf.length > MAX_HTML_BYTES) throw new IngestError('Página grande demais (limite de 5 MB de HTML).', 'Cole o texto do artigo na aba "Texto".');
      const page = htmlToText(buf.toString('utf8'));
      const t = capText(clean(page.text));
      if (t.split(/\s+/).length < 80) throw new IngestError('Encontrei pouco texto nessa página.');
      return { title: title || page.title || url, sourceType: 'web', sourceUrl: url, sentences: splitSentences(t).map(s => ({ text: s })) };
    }
    throw new IngestError('Tipo de conteúdo não suportado: ' + ctype,
      'Vídeos fora do YouTube precisam de transcrição. Cole o texto ou use um PDF.');
  }
  throw new IngestError('Tipo de fonte desconhecido.');
}
