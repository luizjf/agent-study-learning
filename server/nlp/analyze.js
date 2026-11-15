// Subgrafo de análise (CPU pesado): roda dentro de uma worker thread para não travar
// o event loop do servidor enquanto outros alunos respondem provas.
import { StateGraph, END } from '../graph/engine.js';
import { detectLang, detectTechnical, wordCount } from './text.js';
import { extractConcepts, buildGraph, summarize } from './knowledge.js';
import { generateQuestions } from './questions.js';
import { prepareSpoken, looksSpoken } from './spoken.js';

const analysisGraph = new StateGraph('analise')
  .addNode('analisar', (s) => {
    const all = s.sentences.map(x => x.text).join(' ');
    const spoken = s.sourceType === 'youtube' || looksSpoken(s.sentences);
    return { lang: detectLang(all), words: wordCount(all), tech: detectTechnical(all), spoken };
  }, { label: 'Entendendo o tipo de conteúdo' })
  // Fala ≠ conteúdo: tira propaganda, abertura/encerramento, vícios de linguagem e relatos pessoais.
  .addNode('limpar', (s) => {
    const { sentences, ignore, dropped } = prepareSpoken(s.sentences);
    if (sentences.length < 8) return { _note: 'pouco conteúdo após a limpeza; mantido o original' };
    return { sentences, ignore: [...ignore], contentWords: wordCount(sentences.map(x => x.text).join(' ')), _note: `${dropped} trechos de conversa/propaganda removidos` };
  }, { label: 'Separando conteúdo de conversa' })
  .addNode('conceitos', (s) => {
    const { concepts, prepared } = extractConcepts(s.sentences.map((x, i) => ({ ...x, i })), { spoken: s.spoken, ignore: new Set(s.ignore || []) });
    if (concepts.length < 4) {
      const e = new Error('Não encontrei conceitos suficientes nesse conteúdo para montar uma prova.');
      e.status = 422; throw e;
    }
    return { concepts, prepared, _note: `${concepts.length} conceitos` };
  }, { label: 'Encontrando os conceitos' })
  .addNode('mapa', (s) => ({ graph: buildGraph(s.concepts, s.prepared) }), { label: 'Montando o mapa (base → topo)' })
  .addNode('resumo', (s) => ({ summary: summarize(s.prepared, s.concepts) }), { label: 'Separando as frases-chave' })
  .addNode('perguntas', (s) => {
    const questions = generateQuestions({ graph: s.graph, prepared: s.prepared, technical: s.tech.technical, codeLang: s.tech.codeLang, words: s.contentWords ?? s.words, seed: s.id, spoken: s.spoken });
    return { questions, _note: `${questions.length} questões` };
  }, { label: 'Criando as perguntas' })
  .setEntry('analisar')
  .addConditionalEdges('analisar', (s) => (s.spoken ? 'fala' : 'texto'), { fala: 'limpar', texto: 'conceitos' })
  .addEdge('limpar', 'conceitos').addEdge('conceitos', 'mapa').addEdge('mapa', 'resumo').addEdge('resumo', 'perguntas').addEdge('perguntas', END)
  .compile();

export async function analyze({ id, sentences, sourceType }) {
  const { state, trace } = await analysisGraph.invoke({ id, sentences, sourceType });
  return {
    lang: state.lang, words: state.words, tech: state.tech, spoken: state.spoken, graph: state.graph, summary: state.summary, questions: state.questions,
    // só o necessário volta para a thread principal (sem os tokens pré-processados)
    sentences: state.prepared.map(p => ({ text: p.text, start: p.start ?? null, page: p.page ?? null })),
    trace,
  };
}

export const describeAnalysis = () => analysisGraph.describe();
