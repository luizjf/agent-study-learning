// Mapa mental "base → topo": árvore organizada (tidy tree) com a raiz embaixo.
const NS = 'http://www.w3.org/2000/svg';
const LABEL_W = 150; // espaço à esquerda para os nomes das faixas (Base, Fundamentos…)
const svgEl = (tag, attrs = {}) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

export function masteryClass(m) {
  if (!m) return 'm-none';
  if (m.score >= 0.75) return 'm-ok';
  if (m.score >= 0.5) return 'm-mid';
  return 'm-weak';
}

export function layout(nodes, root) {
  const kids = new Map(nodes.map(n => [n.id, []]));
  for (const n of nodes) if (n.parent && kids.has(n.parent)) kids.get(n.parent).push(n);
  for (const list of kids.values()) list.sort((a, b) => b.score - a.score);
  const width = n => Math.min(200, Math.max(76, n.label.length * 7.6 + 28));
  const pos = new Map();
  let cursor = 0;
  const GAP = 18;
  const place = (n) => {
    const ch = kids.get(n.id) || [];
    if (!ch.length) {
      const w = width(n);
      pos.set(n.id, { x: cursor + w / 2, w });
      cursor += w + GAP;
      return;
    }
    ch.forEach(place);
    const first = pos.get(ch[0].id), last = pos.get(ch[ch.length - 1].id);
    pos.set(n.id, { x: (first.x + last.x) / 2, w: width(n) });
  };
  const rootNode = nodes.find(n => n.id === root) || nodes[0];
  if (rootNode) place(rootNode);
  // nós soltos (sem caminho até a raiz) vão para o lado
  for (const n of nodes) if (!pos.has(n.id)) place(n);
  const maxLevel = Math.max(0, ...nodes.map(n => n.level));
  const ROW = 108;
  for (const n of nodes) {
    const p = pos.get(n.id);
    p.y = (maxLevel - n.level) * ROW + 70;
  }
  return { pos, kids, width: Math.max(cursor, 300), height: (maxLevel + 1) * ROW + 60, maxLevel, ROW };
}

export function drawMap(container, study, { onSelect } = {}) {
  const { nodes, root } = study.graph;
  const L = layout(nodes, root);
  const svg = svgEl('svg', { role: 'img', 'aria-label': 'Mapa de conceitos do básico ao avançado' });
  const world = svgEl('g');
  svg.append(world);

  const tierName = lvl => ['Base', 'Fundamentos', 'Aplicação', 'Avançado', 'Topo'][Math.min(lvl, 4)] + (lvl > 4 ? ` +${lvl - 4}` : '');
  for (let lv = 0; lv <= L.maxLevel; lv++) {
    const y = (L.maxLevel - lv) * L.ROW + 70;
    if (lv % 2 === 0) world.append(svgEl('rect', { class: 'map-band', x: -2000, y: y - L.ROW / 2, width: L.width + 4000, height: L.ROW }));
    const t = svgEl('text', { class: 'map-tier', x: -LABEL_W + 10, y: y + 4, 'text-anchor': 'start' });
    t.textContent = tierName(lv);
    world.append(t);
  }
  const top = svgEl('text', { class: 'map-tier', x: L.width / 2, y: 18, 'text-anchor': 'middle' });
  top.textContent = '↑ topo';
  world.append(top);

  for (const n of nodes) {
    if (!n.parent || !L.pos.has(n.parent)) continue;
    const a = L.pos.get(n.parent), b = L.pos.get(n.id);
    const y1 = a.y - 17, y2 = b.y + 17, my = (y1 + y2) / 2;
    world.append(svgEl('path', { class: 'map-edge', d: `M${a.x},${y1} C${a.x},${my} ${b.x},${my} ${b.x},${y2}` }));
  }

  const groups = new Map();
  for (const n of nodes) {
    const p = L.pos.get(n.id);
    const g = svgEl('g', { class: `map-node ${masteryClass(n.mastery)}${n.id === root ? ' root' : ''}`, transform: `translate(${p.x - p.w / 2},${p.y - 17})`, tabindex: 0, role: 'button', 'aria-label': `${n.label}, ${n.tier}${n.mastery ? ', domínio ' + Math.round(n.mastery.score * 100) + '%' : ', ainda não avaliado'}` });
    g.append(svgEl('rect', { width: p.w, height: 34, rx: 8 }));
    const t = svgEl('text', { x: p.w / 2, y: 22, 'text-anchor': 'middle' });
    t.textContent = n.label.length > 26 ? n.label.slice(0, 25) + '…' : n.label;
    g.append(t);
    if (n.mastery) {
      const pctT = svgEl('text', { x: p.w - 6, y: -5, 'text-anchor': 'end', style: 'font-size:10px;fill:var(--ink-2)' });
      pctT.textContent = Math.round(n.mastery.score * 100) + '%';
      g.append(pctT);
    }
    if (n.notes) {
      g.append(svgEl('circle', { cx: 4, cy: 2, r: 8, fill: 'var(--note)', stroke: 'var(--warn)' }));
      const nt = svgEl('text', { x: 4, y: 6, 'text-anchor': 'middle', style: 'font-size:10px' });
      nt.textContent = n.notes;
      g.append(nt);
    }
    const pick = () => { groups.forEach(x => x.classList.remove('sel')); g.classList.add('sel'); onSelect?.(n); };
    g.addEventListener('click', pick);
    g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    groups.set(n.id, g);
    world.append(g);
  }

  // ---- pan & zoom pelo viewBox
  const home = () => ({ x: -LABEL_W, y: 0, w: L.width + LABEL_W + 30, h: L.height + 20 });
  let vb = home();
  const apply = () => svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
  const fit = () => { vb = home(); apply(); };
  fit();
  let drag = null;
  svg.addEventListener('pointerdown', e => {
    if (e.target.closest('.map-node')) return;
    drag = { x: e.clientX, y: e.clientY, vb: { ...vb } };
    svg.setPointerCapture(e.pointerId);
    svg.classList.add('dragging');
  });
  svg.addEventListener('pointermove', e => {
    if (!drag) return;
    const k = vb.w / svg.clientWidth;
    vb.x = drag.vb.x - (e.clientX - drag.x) * k;
    vb.y = drag.vb.y - (e.clientY - drag.y) * k;
    apply();
  });
  const end = () => { drag = null; svg.classList.remove('dragging'); };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  const zoom = (f, cx = 0.5, cy = 0.5) => {
    const nw = Math.min(Math.max(vb.w * f, 200), (L.width + 160) * 4);
    const nh = vb.h * (nw / vb.w);
    vb.x += (vb.w - nw) * cx; vb.y += (vb.h - nh) * cy; vb.w = nw; vb.h = nh;
    apply();
  };
  svg.addEventListener('wheel', e => {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    zoom(e.deltaY > 0 ? 1.12 : 0.89, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  }, { passive: false });

  container.append(svg);
  return {
    zoomIn: () => zoom(0.8), zoomOut: () => zoom(1.25), fit,
    select: id => groups.get(id)?.dispatchEvent(new Event('click')),
  };
}
