// Helpers de interface: criação de elementos, avisos, destaques e ícones desenhados à mão.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Destaca os termos-chave com "marca-texto" — ajuda a ancorar a atenção.
export function highlight(text, terms = []) {
  const out = esc(text);
  const sorted = [...new Set(terms)].filter(Boolean).sort((a, b) => b.length - a.length);
  if (!sorted.length) return out;
  // uma única passada (alternância, mais longo primeiro) evita marcas aninhadas
  const alt = sorted.map(t => esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return out.replace(new RegExp(`«?(${alt})»?`, 'gi'), (m, w) => `<mark>${w}</mark>`);
}

export function toast(msg, kind = '') {
  const wrap = document.getElementById('toasts');
  const t = h('div', { class: 'toast ' + kind, role: 'status' }, msg);
  wrap.append(t);
  setTimeout(() => t.remove(), 4200);
}

// Confirmação para ações sem volta (ex.: excluir estudo). Usa <dialog> nativo: foco preso,
// Esc cancela, e o botão perigoso NÃO é o foco inicial (evita apagar com um Enter distraído).
export function confirmDialog({ title, body, confirm = 'Confirmar', cancel = 'Cancelar', danger = false }) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'dialog', 'aria-labelledby': 'dlg-title' });
    const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    const cancelBtn = h('button', { class: 'btn ghost', type: 'button', onclick: () => done(false) }, cancel);
    dlg.append(
      h('h2', { id: 'dlg-title' }, title),
      typeof body === 'string' ? h('p', {}, body) : body,
      h('div', { class: 'row', style: { justifyContent: 'flex-end' } },
        cancelBtn,
        h('button', { class: 'btn ' + (danger ? 'danger' : ''), type: 'button', onclick: () => done(true) }, confirm)));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });
    document.body.append(dlg);
    dlg.showModal();
    cancelBtn.focus();
  });
}

export function fmtTime(sec) {
  if (sec == null) return '';
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60), r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

export function pct(v) { return v == null ? '—' : Math.round(v * 100) + '%'; }

export function timeAgo(ts) {
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return 'agora';
  if (d < 3600) return `há ${Math.floor(d / 60)} min`;
  if (d < 86400) return `há ${Math.floor(d / 3600)} h`;
  return `há ${Math.floor(d / 86400)} d`;
}

export function words(text) { return (String(text).match(/\S+/g) || []).length; }

export function sourceLabel(t) {
  return { youtube: 'Vídeo', pdf: 'PDF', web: 'Página', text: 'Texto' }[t] || t;
}

// Link para o trecho exato da fonte: minuto no YouTube, página no PDF.
export function sourceLink(src, study) {
  if (!src) return null;
  if (study?.videoId && src.start != null) {
    return h('a', { class: 'ts-link', href: `https://www.youtube.com/watch?v=${study.videoId}&t=${Math.floor(src.start)}s`, target: '_blank', rel: 'noopener' }, 'rever em ' + fmtTime(src.start));
  }
  if (src.page) {
    const href = study?.sourceUrl ? `${study.sourceUrl}#page=${src.page}` : null;
    return href ? h('a', { class: 'ts-link', href, target: '_blank', rel: 'noopener' }, `página ${src.page}`) : h('span', { class: 'ts-link' }, `página ${src.page}`);
  }
  return null;
}

export const icon = {
  logo: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M5 24c3-1 4-7 9-8s6 3 12-7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><circle cx="5" cy="24" r="2.6" fill="currentColor"/><circle cx="26" cy="9" r="2.6" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  flame: '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M10 2c1 3 4 4.5 4 8.5A4 4 0 0 1 6 10.6c0-1.6.8-2.6 1.6-3.4.2 1.2.8 2 1.6 2.2C8.6 7 9.2 4.4 10 2z" fill="currentColor"/></svg>',
  speak: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 8h3l4-3v10l-4-3H3z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M13 7c1 .8 1.5 1.8 1.5 3s-.5 2.2-1.5 3M15.5 5c1.6 1.3 2.5 3 2.5 5s-.9 3.7-2.5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  bulb: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 14h6M8 17h4M10 2a5 5 0 0 0-3 9c.6.5 1 1.2 1 2h4c0-.8.4-1.5 1-2a5 5 0 0 0-3-9z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  pause: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 5v10M13 5v10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  gear: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="2.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 2.5v2.2M10 15.3v2.2M2.5 10h2.2M15.3 10h2.2M4.7 4.7l1.5 1.5M13.8 13.8l1.5 1.5M4.7 15.3l1.5-1.5M13.8 6.2l1.5-1.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  map: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="16" r="2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="5" cy="5" r="2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="15" cy="5" r="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 14V10M10 10 6 6.5M10 10l4-3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  play: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 4l10 6-10 6z" fill="currentColor"/></svg>',
  back: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12 4l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  plus: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  trash: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10M9 9v4M11 9v4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  spark: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5 11.6 8.4 17.5 10l-5.9 1.6L10 17.5l-1.6-5.9L2.5 10l5.9-1.6z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  // "Pipoca", o aluno virtual do modo Ensinar de volta — traço de caneta, nada de mascote 3D
  pupil: `<svg viewBox="0 0 80 80" aria-hidden="true"><circle cx="40" cy="42" r="26" fill="var(--card)" stroke="var(--ink)" stroke-width="2.2"/>
    <path d="M18 34c2-14 14-20 24-19 10 0 19 6 21 17" fill="none" stroke="var(--ink)" stroke-width="2.2" stroke-linecap="round"/>
    <path d="M24 26c6-6 10-8 16-8" fill="none" stroke="var(--ink)" stroke-width="2.2" stroke-linecap="round"/>
    <circle cx="31" cy="42" r="2.6" fill="var(--ink)"/><circle cx="49" cy="42" r="2.6" fill="var(--ink)"/>
    <path d="M33 53c4 3 10 3 14 0" fill="none" stroke="var(--ink)" stroke-width="2.2" stroke-linecap="round"/>
    <path d="M57 20l6-6M60 26l8-2" stroke="var(--warn)" stroke-width="2.2" stroke-linecap="round"/></svg>`,
  emptyDesk: `<svg viewBox="0 0 160 110" aria-hidden="true"><path d="M10 92h140" stroke="var(--ink-3)" stroke-width="2" stroke-linecap="round"/>
    <rect x="36" y="38" width="62" height="44" rx="3" fill="var(--card)" stroke="var(--ink-2)" stroke-width="2" transform="rotate(-6 67 60)"/>
    <path d="M44 52h40M44 60h34M44 68h28" stroke="var(--rule)" stroke-width="2" transform="rotate(-6 67 60)"/>
    <path d="M108 86l22-44" stroke="var(--ink-2)" stroke-width="5" stroke-linecap="round"/><path d="M130 42l3-7" stroke="var(--warn)" stroke-width="5" stroke-linecap="round"/></svg>`,
};

export function badgeIcon(id, earned = true) {
  const color = earned ? 'var(--warn)' : 'var(--ink-3)';
  return `<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="20" r="14" fill="var(--warn-soft)" stroke="${color}" stroke-width="2.2"/>
    <path d="M16 31l-4 12 7-3 5 5 3-12M32 31l4 12-7-3" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round"/>
    <text x="24" y="25" text-anchor="middle" font-family="Fraunces, serif" font-weight="800" font-size="13" fill="${color}">${esc((id || '?').slice(0, 2).toUpperCase())}</text></svg>`;
}

// Medidor semicircular com a linha dos 75%
export function gauge(score, passMark = 0.75) {
  const r = 80, cx = 100, cy = 100;
  const pt = v => { const a = Math.PI * (1 - v); return [cx + r * Math.cos(a), cy - r * Math.sin(a)]; };
  const [ex, ey] = pt(Math.max(0.001, Math.min(0.999, score)));
  const a = Math.PI * (1 - passMark);
  const inner = [cx + (r - 14) * Math.cos(a), cy - (r - 14) * Math.sin(a)];
  const outer = [cx + (r + 14) * Math.cos(a), cy - (r + 14) * Math.sin(a)];
  const color = score >= passMark ? 'var(--ok)' : 'var(--bad)';
  return `<svg class="gauge" viewBox="0 0 200 122" width="260" role="img" aria-label="Nota ${Math.round(score * 100)}%">
    <path d="M20 100a80 80 0 0 1 160 0" fill="none" stroke="var(--paper-2)" stroke-width="16" stroke-linecap="round"/>
    <path d="M20 100A80 80 0 0 1 ${ex.toFixed(1)} ${ey.toFixed(1)}" fill="none" stroke="${color}" stroke-width="16" stroke-linecap="round"/>
    <line x1="${inner[0].toFixed(1)}" y1="${inner[1].toFixed(1)}" x2="${outer[0].toFixed(1)}" y2="${outer[1].toFixed(1)}" stroke="var(--ink)" stroke-width="2.5" stroke-dasharray="3 2"/>
    <text x="${(outer[0] + 4).toFixed(1)}" y="${(outer[1] - 4).toFixed(1)}" font-size="10" font-weight="700" fill="var(--ink-2)">75%</text>
    <text x="100" y="96" text-anchor="middle" font-family="Fraunces, serif" font-weight="700" font-size="38" fill="var(--ink)">${Math.round(score * 100)}%</text></svg>`;
}
