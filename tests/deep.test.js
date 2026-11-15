// Agentes que leem o conteúdo inteiro: validação do que o LLM devolve, provedor Claude Code,
// exclusão de estudo e a dica 50/50. Nada aqui chama um modelo de verdade.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.TRILHA_DB = ':memory:';
process.env.TRILHA_LLM = 'local';

const { db } = await import('../server/db.js');
const P = await import('../server/pipelines.js');
const { graphFromConcepts, questionsFromExam, essentialsFrom, numberedContent } = await import('../server/agents/normalize.js');
const { claudeCodeArgs, AGENTS } = await import('../server/agents/index.js');

const sentences = [
  'A consolidação da memória transforma lembranças frágeis em estáveis.',
  'O hipocampo registra o que você aprende durante o dia.',
  'No sono profundo, o hipocampo reativa as lembranças e as envia ao córtex.',
  'As ondas lentas acompanham essa reativação no sono profundo.',
  'O sono REM ajuda memórias emocionais e a criatividade.',
  'Adultos devem dormir de sete a nove horas.',
].map((text, i) => ({ text, start: i * 30 }));

test('mapa do Cartógrafo: uma raiz, sem ciclos, profundidade ≤ 4 e conceitos inventados fora', () => {
  const g = graphFromConcepts([
    { id: 'a', label: 'consolidação da memória', definition: 'Fixar lembranças.', parent: '', evidence: [0] },
    { id: 'b', label: 'hipocampo', definition: 'Registra o novo.', parent: 'a', evidence: [1] },
    { id: 'c', label: 'sono profundo', definition: 'Fase de ondas lentas.', parent: 'd', evidence: [2] }, // ciclo c ↔ d
    { id: 'd', label: 'ondas lentas', definition: 'Ondas grandes.', parent: 'c', evidence: [3] },
    { id: 'e', label: 'sono REM', definition: 'Fase dos sonhos.', parent: 'd', evidence: [4] },
    { id: 'f', label: 'teletransporte quântico', definition: 'Inventado.', parent: 'a', evidence: [] }, // não está no texto
    { id: 'g', label: 'sono profundo', definition: 'duplicado', parent: 'a', evidence: [2] },
  ], sentences);
  assert.ok(g);
  assert.equal(g.nodes.filter(n => !n.parent).length, 1, 'uma raiz só');
  assert.ok(!g.nodes.some(n => n.label.includes('teletransporte')), 'conceito que não aparece no conteúdo sai');
  assert.equal(g.nodes.filter(n => n.label === 'sono profundo').length, 1, 'sem duplicata');
  const byId = new Map(g.nodes.map(n => [n.id, n]));
  for (const n of g.nodes) {
    let cur = n, steps = 0;
    while (cur.parent && steps < 20) { cur = byId.get(cur.parent); steps++; }
    assert.ok(steps < 20, 'sem ciclo');
    assert.ok(n.level <= 4);
  }
  // reaproveita o id do mapa anterior quando o conceito é o mesmo (notas e domínio continuam valendo)
  const again = graphFromConcepts([{ id: 'x', label: 'hipocampo', parent: '', evidence: [1] }, { id: 'y', label: 'sono REM', parent: 'x', evidence: [4] },
    { id: 'z', label: 'ondas lentas', parent: 'x', evidence: [3] }, { id: 'w', label: 'sono profundo', parent: 'x', evidence: [2] }], sentences, g);
  assert.equal(again.nodes.find(n => n.label === 'hipocampo').id, g.nodes.find(n => n.label === 'hipocampo').id);
});

test('prova do Examinador: só entra questão válida, com fonte e conceito', () => {
  const graph = graphFromConcepts([
    { id: 'a', label: 'consolidação da memória', parent: '', evidence: [0] },
    { id: 'b', label: 'hipocampo', parent: 'a', evidence: [1] },
    { id: 'c', label: 'sono profundo', parent: 'a', evidence: [2] },
    { id: 'd', label: 'sono REM', parent: 'a', evidence: [4] },
  ], sentences);
  const mc = (prompt, extra = {}) => ({ type: 'mc', kind: 'compreensao', prompt, options: ['Opção um aqui', 'Opção dois aqui', 'Opção três aqui', 'Opção quatro aqui'], answer: 1, explanation: 'Porque sim.', concepts: ['b'], evidence: [1], expected: '', keywords: [], lang: '', ...extra });
  const raw = { questions: [
    mc('O que o hipocampo faz durante o dia?'),
    mc('Pergunta com três opções apenas?', { options: ['a', 'b', 'c'] }),
    mc('Pergunta com gabarito fora do lugar?', { answer: 7 }),
    mc('Pergunta com opções repetidas aqui?', { options: ['x', 'x', 'y', 'z'] }),
    mc('O que acontece no sono profundo?', { concepts: [], evidence: [], options: ['O hipocampo reativa lembranças', 'Nada acontece', 'Só sonhos', 'O córtex desliga'] }),
    mc('Quanto tempo adultos devem dormir?', { concepts: ['zzz'], evidence: [5] }),
    mc('Para que serve o sono REM, segundo o conteúdo?', { concepts: ['d'], evidence: [4] }),
    mc('Qual é a função da consolidação da memória?', { concepts: ['a'], evidence: [0] }),
    mc('Complete a frase: o hipocampo registra o que você _____ durante o dia.'),
    mc('Qual alternativa descreve o papel do córtex na memória?', { options: ['Curta', 'O córtex guarda as lembranças de longo prazo que o hipocampo envia durante o sono profundo', 'Breve', 'Rápida'] }),
    mc('Segundo o vídeo: no sono profundo, o hipocampo reativa as lembranças e as envia ao córtex. Isso é verdade?'),
    { type: 'reasoning', kind: 'causa', prompt: 'Explique por que dormir depois de estudar ajuda a lembrar.', options: [], answer: -1, explanation: '', concepts: ['c', 'b'], evidence: [2], expected: 'Porque no sono profundo o hipocampo reativa e envia ao córtex.', keywords: ['hipocampo', 'córtex', 'sono profundo'], lang: '' },
    { type: 'code', kind: 'codigo', prompt: 'Escreva um código qualquer sobre o tema.', options: [], answer: -1, explanation: '', concepts: [], evidence: [], expected: 'x', keywords: ['dormir()'], lang: 'js' },
    { type: 'interview', kind: 'entrevista', prompt: 'Explique consolidação da memória a um gestor e cite um limite.', options: [], answer: -1, explanation: '', concepts: ['a'], evidence: [0], expected: 'Resposta modelo completa sobre consolidação.', keywords: ['hipocampo', 'sono profundo'], lang: '' },
  ] };
  const stats = {};
  const qs = questionsFromExam(raw, { graph, sentences, technical: false, codeLang: null }, stats);
  assert.ok(qs);
  assert.equal(stats.blank, 1, 'lacuna é descartada');
  assert.equal(stats.copy, 1, 'enunciado colado da transcrição é descartado');
  assert.equal(stats.cue, 1, 'certa muito mais longa que as erradas (pista de forma) é descartada');
  const mcs = qs.filter(q => q.type === 'mc');
  assert.equal(mcs.length, 5, 'as três MC inválidas saem');
  assert.ok(mcs.every(q => q.options.length === 4 && q.answer >= 0 && q.answer < 4));
  assert.ok(mcs.every(q => q.concepts.length && q.origin === 'examinador'));
  const sleep = mcs.find(q => q.prompt.startsWith('O que acontece no sono profundo'));
  assert.ok(sleep.concepts.includes(graph.nodes.find(n => n.label === 'sono profundo').id), 'conceito deduzido do texto da questão');
  assert.equal(mcs.find(q => q.prompt.startsWith('Para que serve')).source.at, '2:00', 'evidência vira o minuto do vídeo');
  assert.ok(!qs.some(q => q.type === 'code'), 'conteúdo não técnico não tem questão de código');
  const open = qs.find(q => q.type === 'reasoning');
  assert.ok(open.rubric.keywords.some(k => k.term === 'córtex') && open.rubric.expected && open.rubric.minWords === 25);
  assert.equal(qs.at(-1).type, 'interview', 'entrevista por último');
  // com menos de 5 MC válidas, a prova local continua valendo
  assert.equal(questionsFromExam({ questions: raw.questions.slice(0, 4) }, { graph, sentences, technical: false }), null);
});

test('ideias-chave e conteúdo numerado', () => {
  const e = essentialsFrom([{ text: 'O sono profundo é quando o hipocampo envia lembranças ao córtex.', evidence: [2] },
    { text: 'curto', evidence: [1] }, { text: 'Adultos precisam de sete a nove horas de sono por noite.', evidence: [5] },
    { text: 'O sono REM ajuda nas memórias emocionais e na criatividade.', evidence: [99, 4] }], sentences);
  assert.equal(e.length, 3);
  assert.deepEqual(e.map(x => x.i), [2, 5, 4]);
  const { text } = numberedContent(sentences);
  assert.match(text, /^\[0 · 0:00\] A consolidação/);
  const long = numberedContent(Array.from({ length: 2000 }, (_, i) => ({ text: 'frase de teste número ' + i })), 5000);
  assert.ok(long.sampled && long.text.length <= 5600, 'respeita o limite');
  const idx = [...long.text.matchAll(/^\[(\d+)\]/gm)].map(m => Number(m[1]));
  assert.ok(idx[0] === 0 && idx.at(-1) > 1900, `amostra uniforme cobre do início ao fim (${idx[0]}…${idx.at(-1)})`);
});

test('Claude Code: modo headless sem ferramentas, sem MCP e com JSON validado', () => {
  const args = claudeCodeArgs(AGENTS.examinador, 'examinador');
  assert.equal(args[0], '-p');
  assert.deepEqual(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2), ['--tools', '']);
  for (const f of ['--json-schema', '--system-prompt', '--strict-mcp-config', '--no-session-persistence']) assert.ok(args.includes(f), f);
  assert.ok(!args.includes('--bare'), '--bare ignora o login da assinatura');
  assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
  assert.match(args[args.indexOf('--system-prompt') + 1], /Examinador/);
});

const fixture = fs.readFileSync(new URL('./fixtures/async-js.txt', import.meta.url), 'utf8');
db.prepare("INSERT INTO users (id, name, role, token, created_at) VALUES ('dono', 'Prof', 'professor', 't-dono', 0), ('aluno', 'Bia', 'aluno', 't-aluno', 0)").run();
const dono = db.prepare("SELECT * FROM users WHERE id = 'dono'").get();
const aluno = db.prepare("SELECT * FROM users WHERE id = 'aluno'").get();

test('dica de múltipla escolha tira duas erradas e nunca a certa', async () => {
  const study = await P.createStudy(dono, { type: 'text', text: fixture });
  const att = P.startAttempt(dono, study.id);
  for (const q of att.questions.filter(x => x.type === 'mc').slice(0, 4)) {
    const hint = P.hintFor(dono, att.id, q.id);
    assert.equal(hint.eliminate.length, 2);
    const r = await P.answerQuestion(dono, att.id, { questionId: q.id, response: hint.eliminate[0] });
    assert.ok(!hint.eliminate.includes(r.result.correctOption), 'a correta nunca é eliminada');
    assert.equal(r.result.correct, false);
  }
});

test('excluir: dono apaga tudo; aluno da turma só tira da própria mesa', async () => {
  const study = await P.createStudy(dono, { type: 'text', text: fixture });
  const rooms = await import('../server/rooms.js');
  const room = rooms.createRoom(dono, study.id, 'Turma');
  rooms.joinRoom(aluno, room.code);
  const a1 = P.startAttempt(aluno, study.id, { roomCode: room.code });
  await P.answerQuestion(aluno, a1.id, { questionId: a1.questions[0].id, response: 0 });
  await P.finishAttempt(aluno, a1.id);
  db.prepare("INSERT INTO notes (id, user_id, study_id, text, created_at, updated_at) VALUES ('n1', 'aluno', ?, 'nota', 0, 0), ('n2', 'dono', ?, 'nota', 0, 0)").run(study.id, study.id);
  db.prepare("INSERT INTO llm_cache (key, value, created_at, study_id) VALUES ('k1', '{}', 0, ?)").run(study.id);
  const count = (t, extra = '') => db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE study_id = ?${extra}`).get(study.id).n;

  assert.deepEqual(P.deleteStudy(aluno, study.id), { deleted: 'mine' });
  assert.equal(count('attempts', " AND user_id = 'aluno'"), 0);
  assert.equal(count('notes', " AND user_id = 'aluno'"), 0);
  assert.equal(count('mastery', " AND user_id = 'aluno'"), 0);
  assert.equal(count('notes', " AND user_id = 'dono'"), 1, 'dados do professor ficam');
  assert.ok(P.studyRow(study.id), 'estudo continua existindo');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM room_members WHERE user_id = ?').get('aluno').n, 0, 'aluno sai da turma');

  assert.deepEqual(P.deleteStudy(dono, study.id), { deleted: 'all' });
  assert.equal(P.studyRow(study.id), undefined);
  for (const t of ['questions', 'attempts', 'notes', 'rooms', 'mastery', 'llm_cache']) assert.equal(count(t), 0, t);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM answers WHERE attempt_id = ?').get(a1.id).n, 0, 'respostas saem em cascata');
});

test('auditoria de forma: só aceita reescrita que tira a pista e preserva a resposta certa', async () => {
  const { applyAudit, longestShare, lengthCues } = await import('../server/agents/normalize.js');
  const q = (id, options, answer = 0) => ({ id, type: 'mc', prompt: 'Pergunta?', options, answer });
  const exam = [
    q('a', ['Combinar dados de duas tabelas a partir da relação entre elas numa consulta', 'Apagar linhas', 'Criar índice', 'Copiar tabela']),
    q('b', ['Registrar a consulta do usuário em vetores para busca semântica rápida', 'Gerar texto', 'Treinar o modelo', 'Apagar dados']),
    q('c', ['Silver', 'Bronze', 'Gold', 'Landing'], 0),
  ];
  assert.equal(lengthCues(exam).length, 2);
  assert.ok(longestShare(exam) > 0.6);
  const { questions, fixed } = applyAudit(exam, { questions: [
    // bom: certa enxuta com o mesmo vocabulário, erradas com detalhe parecido
    { id: 'a', answer: 0, options: ['Combinar dados de duas tabelas pela relação entre elas', 'Apagar as linhas duplicadas das duas tabelas', 'Criar um índice novo para cada tabela', 'Copiar uma tabela inteira para dentro da outra tabela do banco'] },
    // ruim: trocou a ideia da certa
    { id: 'b', answer: 0, options: ['Gerar imagens', 'Gerar texto longo e criativo', 'Treinar o modelo do zero', 'Apagar todos os dados'] },
  ] });
  assert.equal(fixed, 1);
  assert.match(questions[0].options[1], /duplicadas/);
  assert.equal(questions[1].options[0], exam[1].options[0], 'reescrita que muda o sentido da certa é recusada');
  assert.ok(longestShare(questions) < longestShare(exam));
});
