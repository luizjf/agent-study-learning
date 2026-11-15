import { get, patch } from '../api.js';
import { h, toast } from '../ui.js';

const TYPE = { mc: 'Múltipla escolha', reasoning: 'Raciocínio', code: 'Código', interview: 'Entrevista' };

// Modo professor: revisar o que o motor gerou, corrigir o gabarito ou desligar uma questão.
export async function editorView(ctx, [studyId]) {
  const [{ study }, { questions }] = await Promise.all([get('/studies/' + studyId), get(`/studies/${studyId}/questions`)]);

  const card = (q) => {
    const prompt = h('textarea', { rows: 3 });
    prompt.value = q.prompt;
    const enabled = h('input', { type: 'checkbox', checked: q.enabled });
    let answer = q.answer;
    const optInputs = (q.options || []).map((o, i) => {
      const inp = h('input', { type: 'text', value: o, 'aria-label': `Opção ${'ABCD'[i]}` });
      const radio = h('input', { type: 'radio', name: 'ans-' + q.id, checked: i === q.answer, 'aria-label': 'Marcar como correta', onchange: () => { answer = i; } });
      return { inp, el: h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, radio, inp) };
    });
    const save = async () => {
      try {
        await patch('/questions/' + encodeURIComponent(q.id), {
          prompt: prompt.value, enabled: enabled.checked,
          ...(q.type === 'mc' ? { options: optInputs.map(o => o.inp.value), answer } : {}),
        });
        toast('Questão salva.');
      } catch (err) { toast(err.message, 'bad'); }
    };
    return h('div', { class: 'card stack', style: { opacity: q.enabled ? 1 : 0.7 } },
      h('div', { class: 'row between' },
        h('span', { class: 'chip' }, `${q.idx + 1}. ${TYPE[q.type]} · nível ${q.level === 99 ? 'final' : q.level}`),
        h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center', margin: 0 } }, enabled, 'ativa')),
      prompt,
      q.type === 'mc' ? h('div', { class: 'stack' }, optInputs.map(o => o.el)) : null,
      q.rubric?.keywords ? h('p', { class: 'muted', style: { margin: 0, fontSize: '.85rem' } }, 'Termos que a correção espera: ', q.rubric.keywords.map(k => k.term).join(', '),
        q.rubric.codeTokens ? ' · código: ' + q.rubric.codeTokens.join(', ') : '') : null,
      q.source?.text ? h('p', { class: 'excerpt', style: { margin: 0 } }, q.source.text) : null,
      h('div', {}, h('button', { class: 'btn small', onclick: save }, 'Salvar')));
  };

  return h('div', { style: { maxWidth: '820px', margin: '0 auto' } },
    h('a', { href: `#/estudo/${studyId}`, class: 'muted', style: { fontSize: '.85rem' } }, '← ' + study.title),
    h('h1', { style: { marginTop: '6px' } }, 'Revisar questões'),
    h('p', { class: 'muted' }, 'As perguntas foram geradas automaticamente a partir da fonte. Corrija o que soar estranho, troque o gabarito ou desative o que não fizer sentido. Alunos só veem as ativas.'),
    h('div', { class: 'stack' }, questions.map(card)));
}
