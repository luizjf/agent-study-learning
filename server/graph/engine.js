// Mini motor de grafos de estado (inspirado em LangGraph), sem dependências.
// Cada nó recebe o estado e devolve um patch; arestas podem ser condicionais.
// O trace de cada execução é guardado e exibido no site ("como isso foi feito").

export const END = '__end__';

export class StateGraph {
  constructor(name) {
    this.name = name;
    this.nodes = new Map();
    this.edges = new Map();
    this.conditional = new Map();
    this.entry = null;
  }

  addNode(name, fn, meta = {}) {
    if (this.nodes.has(name)) throw new Error(`Nó duplicado: ${name}`);
    this.nodes.set(name, { fn, meta });
    return this;
  }

  addEdge(from, to) {
    this.edges.set(from, to);
    return this;
  }

  addConditionalEdges(from, router, mapping) {
    this.conditional.set(from, { router, mapping });
    return this;
  }

  setEntry(name) {
    this.entry = name;
    return this;
  }

  compile({ maxSteps = 64 } = {}) {
    if (!this.entry || !this.nodes.has(this.entry)) throw new Error(`[${this.name}] nó de entrada inválido`);
    const known = n => n === END || this.nodes.has(n);
    for (const [from, to] of this.edges) {
      if (!known(from) || !known(to)) throw new Error(`[${this.name}] aresta inválida ${from} → ${to}`);
    }
    for (const [from, { mapping }] of this.conditional) {
      for (const to of Object.values(mapping)) if (!known(to)) throw new Error(`[${this.name}] rota inválida ${from} → ${to}`);
    }
    const graph = this;
    return {
      name: graph.name,
      async invoke(initial, ctx = {}) {
        let state = { ...initial };
        const trace = [];
        let current = graph.entry;
        let steps = 0;
        while (current !== END) {
          if (++steps > maxSteps) throw new Error(`[${graph.name}] excedeu ${maxSteps} passos (ciclo?)`);
          const { fn, meta } = graph.nodes.get(current);
          const t0 = performance.now();
          let patch;
          try {
            patch = await fn(state, ctx);
          } catch (err) {
            err.node = current;
            err.graph = graph.name;
            throw err;
          }
          if (patch && typeof patch === 'object') state = { ...state, ...patch };
          // subgrafo executado em outro lugar (ex.: worker thread) devolve seu próprio trace
          if (Array.isArray(patch?._trace)) trace.push(...patch._trace.map(t => ({ ...t, via: current })));
          trace.push({ node: current, label: meta.label || current, agent: meta.agent || 'local', ms: +(performance.now() - t0).toFixed(1), note: patch?._note });
          delete state._note;
          delete state._trace;
          if (graph.conditional.has(current)) {
            const { router, mapping } = graph.conditional.get(current);
            const route = router(state, ctx);
            current = mapping[route] ?? route;
          } else {
            current = graph.edges.get(current) ?? END;
          }
        }
        return { state, trace };
      },
      describe() {
        const lines = ['flowchart TD'];
        for (const [name, { meta }] of graph.nodes) lines.push(`  ${name}["${meta.label || name}${meta.agent ? `<br/><i>${meta.agent}</i>` : ''}"]`);
        for (const [from, to] of graph.edges) lines.push(`  ${from} --> ${to === END ? 'fim((fim))' : to}`);
        for (const [from, { mapping }] of graph.conditional) {
          for (const [k, to] of Object.entries(mapping)) lines.push(`  ${from} -- ${k} --> ${to === END ? 'fim((fim))' : to}`);
        }
        return lines.join('\n');
      },
    };
  }
}
