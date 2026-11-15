# Proposta — Trilha

> Cole um vídeo ou PDF, prove que entendeu (75%) e veja o mapa do que você sabe, do básico ao topo.

## 1. O que existe no mercado

| Produto | O que faz bem | Onde deixa a desejar para o nosso objetivo |
|---|---|---|
| **Quizlet** | Flashcards, modo "Aprender", jogos rápidos, comunidade enorme | Material é criado à mão (ou por IA paga); avalia memorização, não entendimento; nenhuma ligação com o minuto do vídeo |
| **Anki** | Repetição espaçada excelente, gratuito, extensível | Você precisa escrever os cartões; interface árida; zero feedback sobre *por que* errou |
| **NotebookLM** (Google) | Lê PDFs/vídeos, gera resumos, mapas mentais e quizzes, cita a fonte | Depende de LLM na nuvem; o mapa mental não reflete o que *você* domina; não tem meta de aprovação, turma ou correção de código |
| **Geradores de quiz por IA** (Quizgecko, Questgen e similares) | Geram perguntas a partir de texto/URL em segundos | Cobram por geração (tokens); perguntas genéricas; não há plano de revisão nem progresso por conceito |
| **Khanmigo** (Khan Academy) | Tutor socrático, bom para raciocínio | Só funciona com o conteúdo da Khan; custo por aluno; cada conversa gasta LLM |
| **Duolingo** | Gamificação de referência: sequência, XP, ligas, sessões curtas | Só idiomas; o desenho é para hábito, não para provar entendimento de um material específico |
| **Kahoot / Quizizz** | Dinâmica professor–turma ao vivo, placar | O professor escreve as perguntas; foco em competição relâmpago, não em domínio |
| **Brainscape** | Confiança autodeclarada + repetição espaçada | Cartões manuais; sem análise do conteúdo de origem |

**Padrão que se repete:** ou a ferramenta *gera* bem mas não *acompanha* o aluno (NotebookLM, geradores), ou *acompanha* bem mas exige que alguém escreva o material (Anki, Quizlet, Kahoot). Quase todas que geram dependem de IA paga por uso.

## 2. O que a Trilha faz diferente

1. **Gera e acompanha.** A mesma análise que cria as perguntas cria o **mapa de conhecimento** (base → topo). Cada resposta acende ou apaga conceitos desse mapa, e a revisão é ordenada do básico para o avançado.
2. **Primeiro estudar, depois perguntar.** Com os agentes ligados, o Cartógrafo estuda o conteúdo inteiro, o Examinador escreve perguntas sobre o que foi estudado e o Auditor tira pistas de forma. Pode rodar pela assinatura do Claude que a pessoa já tem, sem chave de API. Sem IA, um motor local faz uma versão básica (~30 ms por estudo), sem custo.
3. **Feedback ancorado na fonte.** Todo erro aponta o trecho exato: **"rever em 3:12"** no YouTube ou **"página 4"** no PDF.
4. **Quatro tipos de pergunta**, em número proporcional ao tamanho do conteúdo:
   - 6 a 14 de **múltipla escolha** sobre o assunto (definição, compreensão, aplicação, causa, comparação, cenário); nunca "complete a frase";
   - 2 a 3 de **raciocínio** (abertas: relacionar conceitos, explicar por que importa);
   - 1 a 2 de **código**, quando o conteúdo é técnico (com editor e botão "Rodar" isolado no navegador);
   - 1 de **entrevista**, o "chefe final" (explicar, dar exemplo, citar limitação).
5. **75% para passar, sempre com plano.** Passando ou não: onde errou, a resposta certa, o trecho da fonte, e a lista do que rever na ordem certa.
6. **Aluno ⇄ professor.**
   - O professor revisa e edita as questões geradas, abre uma **turma com código**, vê **onde a turma mais erra** e ajusta notas de respostas abertas (a nota do aluno é recalculada).
   - O aluno também vira professor no modo **Ensinar de volta** (técnica de Feynman): explica um conceito para o "Pipoca", um colega virtual que pergunta o que ficou faltando.
7. **Jogo que respeita a atenção.** XP, combo, baú surpresa, conquistas, sequência de dias e placar da turma, sem vidas nem punição (detalhes na seção 4).

## 3. Possibilidades sem token de IA pago

| Necessidade | Solução gratuita | Status |
|---|---|---|
| Texto de vídeos do YouTube | Legendas públicas do próprio player | **Implementado** |
| Texto de PDF | `unpdf` (pdf.js) local | **Implementado** |
| Artigos da web | Extração de texto do HTML | **Implementado** |
| Conceitos, definições, mapa | NLP local: n-gramas + subsunção, padrões "X é um…", coocorrência → árvore de pré-requisitos | **Implementado** |
| Perguntas | Versão básica local e determinística (definição, "qual conceito é este", justificativa, conexão, raciocínio, código, entrevista); a completa vem dos agentes | **Implementado** |
| Agentes sem chave de API | Claude Code em modo headless com a assinatura do usuário (uso pessoal) | **Implementado** |
| Correção aberta | Cobertura de conceitos + tamanho + estrutura (exemplo/limitação) | **Implementado** |
| Correção de código | Compilação de JS sem executar (`vm.Script`) + elementos esperados | **Implementado** |
| Executar código do aluno | Web Worker isolado no navegador (sem rede, tempo limite de 3 s) | **Implementado** |
| Leitura em voz alta | Web Speech API do navegador | **Implementado** |
| LLM local, sem custo | **Ollama** (ex.: `qwen2.5:7b`) com o mesmo contrato dos agentes | **Implementado** (opcional) |
| Vídeo sem legenda | `whisper.cpp` local (transcrição) | Próximo passo |
| PDF escaneado | `tesseract.js` (OCR) | Próximo passo |
| Busca semântica / sinônimos | Embeddings locais com `transformers.js` | Próximo passo |

## 4. Princípios de TDAH aplicados

| Princípio | Como aparece na Trilha |
|---|---|
| Uma coisa por vez | Modo foco: uma pergunta por tela, sem menus |
| Tarefas curtas com fim visível | Rodadas de 5 (configurável: 3, 5 ou 8) e barra de progresso segmentada |
| Pausa ativa | Entre rodadas: círculo de respiração de 20 s (configurável ou desligável) |
| Recompensa imediata e variável | Resposta na hora, som curto, XP flutuante, combo, baú surpresa (12%) |
| Esforço também conta | Errar uma MC ainda dá 2 XP; terminar a prova dá bônus, passando ou não |
| Retomar sem culpa | Ao voltar para a aba depois de 15 s+: "De volta! Você está na questão 6, sobre «event loop»" |
| Progresso salvo | Fechou a aba? "Você tinha parado no meio. Continuar?" |
| Âncora de atenção | Termos-chave com marca-texto; botão Ouvir; atalhos 1–4/A–D, Enter, H (dica), L (ouvir) |
| Sem punição | Sem vidas, sem cronômetro por pergunta; o tempo da rodada é opcional |
| Travou? | "Estou travado" mostra o trecho da fonte (vale metade do XP, sem bloquear) |
| Ambiente calmo | Tipografia Atkinson Hyperlegible, linhas de até ~62 caracteres, contraste alto, animações desligáveis, respeita "reduzir movimento", letra grande, tema escuro |
| Estudar junto | Placar e "ao vivo" da turma (efeito de *body doubling*) |

## 5. Direção visual (sem "cara de IA")

Linguagem de **caderno de estudo**: papel creme, tinta azul-marinho, **marca-texto amarelo** que pinta só a metade de baixo da palavra, **fichas pautadas** com margem vermelha para cada estudo e anotações em **post-it** levemente tortos. Fontes com personalidade (Fraunces nos títulos, Atkinson Hyperlegible no texto, JetBrains Mono no código), servidas localmente. Ícones desenhados com traço de caneta. Nada de gradiente roxo, brilho ou ícone de "estrelinhas mágicas".
