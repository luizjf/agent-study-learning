const KEY = 'trilha.token';

export const store = {
  get token() { try { return localStorage.getItem(KEY); } catch { return null; } },
  set token(v) { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch { /* modo privado */ } },
  local(key, fallback) {
    try { const v = localStorage.getItem('trilha.' + key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  setLocal(key, v) { try { localStorage.setItem('trilha.' + key, JSON.stringify(v)); } catch { /* ignora */ } },
};

export class ApiError extends Error {
  constructor(status, data) { super(data?.error || `Erro ${status}`); this.status = status; this.hint = data?.hint; }
}

export async function api(method, path, body, { raw } = {}) {
  const headers = {};
  if (store.token) headers.Authorization = 'Bearer ' + store.token;
  let payload;
  if (raw) { payload = raw; headers['Content-Type'] = 'application/pdf'; }
  else if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  let res;
  try {
    res = await fetch('/api' + path, { method, headers, body: payload });
  } catch {
    throw new ApiError(0, { error: 'Sem conexão com o servidor.' });
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) { store.token = null; location.hash = '#/'; }
    throw new ApiError(res.status, data);
  }
  return data;
}

export const get = p => api('GET', p);
export const post = (p, b) => api('POST', p, b ?? {});
export const patch = (p, b) => api('PATCH', p, b);
export const del = p => api('DELETE', p);
