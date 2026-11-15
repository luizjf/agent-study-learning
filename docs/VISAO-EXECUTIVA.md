# Visão executiva: a Trilha por três lentes

O mesmo produto, avaliado por quem responde pela tecnologia (CTO), pelo negócio (CEO) e pela relação com o cliente e a receita (CCO). Cada lente traz o diagnóstico, o que já foi resolvido nesta rodada e a próxima decisão.

O ponto de partida foi um teste com um vídeo real, uma conversa informal de quase meia hora. A prova saiu cheia de perguntas sobre gírias ("cara", "entendeu"), sobre o nome do apresentador e sobre o cupom do patrocinador. **Pergunta sem sentido é a falha mais cara que este produto pode ter**: ela destrói a confiança na nota de 75%, que é a promessa central.

## CTO: a prova tem que ser confiável, barata e auditável

**Diagnóstico**

- O motor local foi calibrado com texto escrito e didático. Fala é outra coisa: menos densa, cheia de muletas, propaganda e histórias pessoais. Faltava uma etapa explícita para separar conteúdo de conversa.
- Dois tipos de pergunta avaliavam a estrutura do texto, não o entendimento: trocar uma palavra dentro da frase original e "o que aparece antes".
- O agente Examinador só reescrevia as perguntas locais, uma por uma. Se a pergunta local era sobre bate-papo, a reescrita continuava sendo sobre bate-papo.

**Resolvido**

- Nó `limpar` no grafo de análise (propaganda, apresentador, vícios de linguagem, densidade de conteúdo por frase) e um gerador local novo, que gera candidatas e escolhe com cobertura de todo o conteúdo.
- Grafo `aprofundar`: o Cartógrafo e o Examinador leem o **conteúdo inteiro** e escrevem mapa, ideias-chave e prova. A saída passa por validação estrita antes de entrar no banco. No teste real: 18 de 18 questões válidas, 77 s, cerca de 40 mil tokens.
- Provedor `claude-code`: os agentes usam a assinatura do usuário, sem chave de API, isolados (sem ferramentas, sem MCP, sem sessão salva).
- Exclusão completa com `secure_delete`. 40 testes automatizados (incluindo segurança), teste de interface no navegador e 100 usuários simultâneos sem erro.

**Próxima decisão**

1. **Medir a qualidade de cada pergunta com dados.** Calcular, para cada questão, a dificuldade (% de acerto) e o índice de discriminação (quem foi bem na prova acerta mais esta questão do que quem foi mal?). Questão com discriminação ≤ 0 está errada ou ambígua: o sistema a desativa sozinho e avisa o professor. Isso transforma qualidade de prova de opinião em métrica.
2. **Vídeo sem legenda**: transcrição local com Whisper (sem custo de API) para cobrir aulas gravadas, Vimeo e arquivos MP4.
3. **Escala**: o modo assinatura é pessoal por desenho. Para turmas, o caminho é a API com fila e cache por estudo (a prova é gerada uma vez e servida para todos). Acima de ~300 usuários simultâneos: `node:cluster`, Redis para o tempo real, Postgres.
4. **Dependência frágil**: a leitura de legendas usa uma API interna do YouTube, que pode mudar sem aviso. Precisa de monitoramento e de alternativa (a aba "Colar texto" já cobre o pior caso).

## CEO: a promessa é "eu sei que entendi", não "fiz um quiz"

**Posição**

Quizlet e Anki ajudam a decorar. NotebookLM e ferramentas parecidas resumem e conversam. Nenhum deles **certifica o entendimento** com um critério claro e mostra o caminho de volta. A Trilha junta quatro coisas:

1. Prova gerada do próprio material do aluno.
2. Nota de corte explícita (75%).
3. Mapa de pré-requisitos que diz **por onde** recomeçar.
4. Experiência desenhada para quem tem dificuldade de foco.

**O que mudou nesta rodada**

- A promessa ficou de pé com conteúdo real e não só com texto escrito. Isso abre o maior volume de conteúdo educacional que existe: vídeos de YouTube em português, que são falados, informais e patrocinados.
- O custo marginal de IA pode ser zero para o usuário individual (motor local ou a assinatura que ele já paga). Isso sustenta um plano gratuito de verdade.

**Modelo de negócio (hipóteses para validar)**

| Segmento | Dor | Oferta |
| --- | --- | --- |
| Estudante individual (concursos, faculdade, carreira em tecnologia) | "Assisti 3 horas e não sei se aprendi" | Grátis com o motor local; agentes pela própria assinatura ou por um plano barato |
| Professores, cursinhos e cursos livres | Montar avaliação dá trabalho e não escala | Plano por turma: provas pelos agentes, painel da turma, ajuste de notas |
| Criadores de conteúdo educacional | Audiência que assiste mas não engaja | "Prove que entendeu este vídeo": link da prova no fim de cada aula |
| Treinamento corporativo | Comprovar que o treinamento foi absorvido | Turmas com relatório de domínio por conceito |

**Métrica norte**: conceitos dominados por aluno por semana (domínio ≥ 75%, confirmado na revisão espaçada). Ela mede aprendizagem, não tempo de tela.

**Riscos**: aprovação falsa (prova fácil demais) e reprovação injusta (pergunta errada). Os dois se combatem com o índice de discriminação (ver CTO) e com o professor ajustando notas.

## CCO: confiança se vende com transparência e controle

**O que o cliente precisa sentir**

1. **"A prova é sobre o que eu estudei."** Toda pergunta mostra o minuto ou a página de onde veio, e cada conceito a rever tem um link para o trecho exato. Isso responde à objeção "a IA inventou isso".
2. **"Eu controlo os meus dados."** Agora dá para excluir um estudo de vez (o professor apaga tudo; o aluno tira o estudo da própria mesa), com confirmação clara e sem volta. Para escolas, esse é um requisito de compra (LGPD).
3. **"Sei em que pé está."** Enquanto os agentes estudam o conteúdo, a tela mostra a etapa (estudar → perguntar → auditar) e um tempo honesto: 1 a 2 minutos para um vídeo de 15 minutos.
4. **"Sei quem corrigiu."** Cada correção mostra se foi o motor local ou um agente, e qual modelo.

**Objeções comuns e respostas**

| Objeção | Resposta |
| --- | --- |
| "IA erra pergunta." | Validação automática de cada questão, trecho-fonte visível, professor edita e ajusta notas; métrica de qualidade por questão (próximo passo). |
| "Vai me cobrar por token." | Funciona sem IA. Com IA, pode usar a assinatura Claude que a pessoa já tem, com teto diário. |
| "Meu aluno tem TDAH e larga no meio." | Uma pergunta por tela, rodadas de 5 com pausa, retorno imediato, dica que risca duas alternativas, retomada se fechar a aba. |
| "E os dados dos alunos?" | Tudo fica no servidor da escola; excluir é de verdade (páginas zeradas no banco). |

**Canais de aquisição a testar**

- Parceria com criadores: o link "faça a prova deste vídeo" na descrição traz aluno qualificado sem custo de mídia.
- Professores como multiplicadores: cada turma traz de 20 a 40 alunos.
- Comunidades de concurso e de tecnologia, onde "provar que entendeu" tem valor imediato.

**Próxima decisão**: escolher **um** segmento para o piloto. A recomendação é professores e cursos livres: uma venda traz uma turma inteira, o painel do professor já existe e o feedback sobre a qualidade das perguntas chega rápido e qualificado.
