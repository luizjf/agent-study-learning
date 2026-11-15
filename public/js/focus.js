// Recursos de foco pensados para TDAH:
//  - rodadas curtas com pausa ativa entre elas (evita fadiga e "deriva")
//  - recompensa imediata (som curto, XP flutuante, combo)
//  - leitura em voz alta (canal auditivo como âncora)
//  - "bem-vindo de volta": se a aba perde o foco, retoma com contexto, sem culpa
//  - tudo configurável: movimento, som, timer, tamanho da letra
import { store, patch } from './api.js';

export const DEFAULT_PREFS = { sound: true, timer: false, motion: true, size: 'normal', theme: 'auto', roundSize: 5, breakSeconds: 20, voice: true };

export function prefs() {
  return { ...DEFAULT_PREFS, ...store.local('prefs', {}) };
}

export function savePrefs(next, sync = true) {
  const merged = { ...prefs(), ...next };
  store.setLocal('prefs', merged);
  applyPrefs(merged);
  if (sync && store.token) patch('/me', { prefs: merged }).catch(() => {});
  return merged;
}

export function applyPrefs(p = prefs()) {
  const root = document.documentElement;
  root.dataset.size = p.size;
  root.dataset.motion = p.motion ? 'on' : 'off';
  if (p.theme === 'auto') delete root.dataset.theme; else root.dataset.theme = p.theme;
}

let audioCtx = null;
export function sound(kind) {
  if (!prefs().sound) return;
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const notes = { ok: [660, 880], combo: [660, 880, 1100], bad: [300], chest: [523, 659, 784, 1047], done: [523, 784] }[kind] || [440];
    notes.forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      const t = audioCtx.currentTime + i * 0.09;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(kind === 'bad' ? 0.05 : 0.08, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      o.connect(g).connect(audioCtx.destination);
      o.start(t); o.stop(t + 0.25);
    });
  } catch { /* sem áudio */ }
}

export function speak(text) {
  if (!('speechSynthesis' in window)) return false;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(String(text).replace(/[«»“”_]+/g, ' '));
  u.lang = 'pt-BR';
  u.rate = 1;
  const v = speechSynthesis.getVoices().find(x => x.lang?.startsWith('pt'));
  if (v) u.voice = v;
  speechSynthesis.speak(u);
  return true;
}

export function stopSpeaking() {
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

// Chama `onReturn(segundosFora)` quando o aluno volta depois de >15s fora da aba.
export function watchReturn(onReturn, minSeconds = 15) {
  let leftAt = null;
  const handler = () => {
    if (document.hidden) leftAt = Date.now();
    else if (leftAt) {
      const s = (Date.now() - leftAt) / 1000;
      leftAt = null;
      if (s >= minSeconds) onReturn(s);
    }
  };
  document.addEventListener('visibilitychange', handler);
  return () => document.removeEventListener('visibilitychange', handler);
}

export function floatXp(anchor, text) {
  if (!prefs().motion) return;
  const r = anchor.getBoundingClientRect();
  const el = document.createElement('div');
  el.className = 'xp-float';
  el.textContent = text;
  el.style.left = r.left + r.width / 2 - 20 + 'px';
  el.style.top = r.top - 10 + 'px';
  document.body.append(el);
  setTimeout(() => el.remove(), 1200);
}
