// Percorre o site como um usuário real (Edge/Chrome instalado + playwright-core),
// tira screenshots de cada tela e falha se houver erro de console ou de página.
//   node scripts/ui-smoke.js [baseUrl] [pastaDeSaida]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const base = process.argv[2] || 'http://localhost:3000';
const out = process.argv[3] || 'ui-shots';
fs.mkdirSync(out, { recursive: true });
const text = fs.readFileSync(new URL('../tests/fixtures/async-js.txt', import.meta.url), 'utf8');

const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
const errors = [];
const watch = (page, tag) => {
  page.on('console', m => { if (m.type() === 'error') errors.push(`[${tag}] console: ${m.text()}`); });
  page.on('pageerror', e => errors.push(`[${tag}] pageerror: ${e.message}`));
};
const shot = async (page, name) => page.screenshot({ path: path.join(out, name + '.png'), fullPage: false });

try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'pt-BR' });
  const page = await ctx.newPage();
  watch(page, 'desktop');
  await page.goto(base + '/#/');
  await page.waitForSelector('#nome');
  await shot(page, '01-boas-vindas');

  await page.fill('#nome', 'Ana Prof');
  await page.click('text=Vou dar aula');
  await page.click('button[type=submit]');
  await page.waitForSelector('text=Novo estudo');
  await shot(page, '02-mesa-vazia');

  await page.click('a.new-card');
  await page.click('role=tab[name="Texto"]');
  await page.fill('#src-text', text);
  await page.fill('#src-title', 'Programação assíncrona em JS');
  await shot(page, '03-novo-estudo');
  await page.click('text=Montar a prova');
  await page.waitForSelector('text=Pronto para provar?', { timeout: 15000 });
  await page.waitForTimeout(400);
  await shot(page, '04-estudo');

  // ---- prova
  await page.click('text=Começar a prova');
  await page.waitForSelector('.qcard');
  await shot(page, '05-prova-mc');
  let n = 0, sawBreak = false, sawCode = false, sawBoss = false;
  while (n++ < 40) {
    if (await page.locator('.result-head').count()) break;
    if (await page.locator('text=Pular a pausa').count()) {
      if (!sawBreak) { await shot(page, '07-pausa'); sawBreak = true; }
      await page.click('text=Pular a pausa');
      continue;
    }
    if (await page.locator('text=Estou pronto').count()) {
      if (!sawBoss) { await shot(page, '09-entrevista-intro'); sawBoss = true; }
      await page.click('text=Estou pronto');
      continue;
    }
    if (await page.locator('text=Somando tudo').count()) { await page.waitForTimeout(300); continue; }
    if (!(await page.locator('.qcard').count())) { await page.waitForTimeout(150); continue; }
    const hasCont = await page.locator('.qcard .toolbar button:has-text("Continuar"), .qcard .toolbar button:has-text("Ver resultado")').count();
    if (hasCont) {
      if (n === 2) await shot(page, '06-prova-feedback');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(120);
      continue;
    }
    if (await page.locator('.opt').count()) {
      await page.keyboard.press(String(1 + (n % 4)));
    } else if (await page.locator('.code-editor').count()) {
      await page.fill('.code-editor textarea', 'async function carregar(id) {\n  const [perfil, pedidos] = await Promise.all([buscarPerfil(id), buscarPedidos(id)]);\n  console.log(perfil, pedidos);\n}');
      await page.click('text=Rodar no navegador');
      await page.waitForSelector('.console div:nth-child(2)', { timeout: 5000 });
      const out = await page.textContent('.console');
      if (/Parado|Não consegui/.test(out)) errors.push('[desktop] executor de código falhou: ' + out);
      if (!sawCode) { await shot(page, '08-prova-codigo'); sawCode = true; }
      await page.click('text=Enviar resposta');
    } else {
      await page.fill('.qcard textarea', 'O event loop pega tarefas da fila de tarefas quando a call stack fica vazia. Por exemplo, num projeto real uso Promise.all para buscar dados em paralelo, mas preciso de cuidado com erros porque uma falha rejeita tudo.');
      await page.click('text=Enviar resposta');
    }
    await page.waitForSelector('.feedback', { timeout: 8000 });
  }
  await page.waitForSelector('.result-head', { timeout: 10000 });
  await page.waitForTimeout(500);
  await shot(page, '10-resultado');
  await page.locator('details.mistake').first().click().catch(() => {});
  await page.screenshot({ path: path.join(out, '11-resultado-completo.png'), fullPage: true });

  // ---- mapa
  await page.click('text=Ver no mapa');
  await page.waitForSelector('.map-node');
  await page.waitForTimeout(300);
  await shot(page, '12-mapa');
  await page.locator('.map-node').first().click();
  await page.waitForSelector('.drawer.open h2');
  await page.waitForTimeout(400);
  await shot(page, '13-mapa-conceito');
  await page.keyboard.press('Escape');

  // ---- ensinar de volta
  const studyUrl = page.url().replace(/#\/mapa\//, '#/estudo/').split('?')[0];
  await page.goto(studyUrl.replace('#/estudo/', '#/ensinar/'));
  await page.waitForSelector('.bubble');
  await page.fill('textarea', 'O event loop fica olhando a call stack e a fila de tarefas. Quando a pilha esvazia, ele pega a próxima tarefa da fila.');
  await page.click('button:has-text("Explicar")');
  await page.waitForSelector('.feedback');
  await shot(page, '14-ensinar');

  // ---- turma: professor abre, aluno entra e faz a prova
  await page.goto(studyUrl);
  await page.click('text=Abrir turma');
  await page.waitForSelector('.code-big');
  const code = (await page.textContent('.code-big')).trim();

  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'pt-BR', isMobile: true, hasTouch: true });
  const phone = await ctx2.newPage();
  watch(phone, 'celular');
  await phone.goto(base + '/#/');
  await phone.fill('#nome', 'Bia');
  await phone.click('button[type=submit]');
  await phone.waitForSelector('input[aria-label="Código da turma"]');
  await phone.fill('input[aria-label="Código da turma"]', code);
  await phone.click('text=Entrar na turma');
  await phone.waitForSelector('.code-big');
  await phone.click('text=Fazer a prova da turma');
  await phone.waitForSelector('.opt');
  await phone.screenshot({ path: path.join(out, '15-celular-prova.png') });
  await phone.locator('.opt').first().click();
  await phone.waitForSelector('.feedback');
  await phone.screenshot({ path: path.join(out, '16-celular-feedback.png') });

  await page.waitForTimeout(1500);
  await shot(page, '17-turma-professor');

  // ---- perfil + tema escuro
  await page.goto(base + '/#/perfil');
  await page.waitForSelector('.badges');
  await shot(page, '18-perfil');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(studyUrl);
  await page.waitForSelector('text=Pronto para provar?');
  await shot(page, '19-estudo-escuro');
  await page.goto(base + '/#/');
  await page.waitForSelector('.index-card');
  await shot(page, '20-mesa-escuro');

  // checagem de overflow horizontal no celular
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 1) errors.push(`[celular] rolagem horizontal de ${overflow}px`);

  // ---- aluno tira o estudo da mesa; professor exclui de vez (com confirmação)
  await phone.goto(base + '/#/');
  await phone.waitForSelector('.index-card');
  await phone.locator('.card-del').first().click();
  await phone.waitForSelector('dialog[open]');
  await phone.click('dialog[open] >> text=Tirar da mesa');
  await phone.waitForTimeout(500);
  if (await phone.locator('.index-card').count()) errors.push('[celular] estudo continuou na mesa do aluno');

  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(studyUrl);
  await page.click('text=Excluir estudo');
  await page.waitForSelector('dialog[open]');
  await shot(page, '21-confirmar-exclusao');
  if (!(await page.evaluate(() => document.activeElement?.textContent === 'Cancelar'))) errors.push('[desktop] foco inicial deveria estar em Cancelar');
  await page.keyboard.press('Escape');
  if (await page.locator('dialog[open]').count()) errors.push('[desktop] Esc não fechou o diálogo');
  await page.click('text=Excluir estudo');
  await page.click('dialog[open] >> text=Excluir de vez');
  await page.waitForSelector('a.new-card');
  await page.waitForTimeout(400);
  if (await page.locator('.index-card').count()) errors.push('[desktop] estudo excluído continuou na mesa');
  await shot(page, '22-mesa-depois-de-excluir');
} finally {
  await browser.close();
}

if (errors.length) {
  console.error('ERROS:\n' + [...new Set(errors)].join('\n'));
  process.exit(1);
}
console.log(`OK — screenshots em ${out}`);
