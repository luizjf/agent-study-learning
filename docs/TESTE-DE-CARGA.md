# Teste de carga — 100 usuários simultâneos

**Ambiente:** Windows 10, 4 núcleos, Node 24, SQLite em arquivo (WAL), servidor e gerador de carga **na mesma máquina** (o gerador disputa CPU com o servidor; números reais tendem a ser melhores).

**Script:** `npm run loadtest -- <url> <usuários> <pensar_ms> <%_que_criam_estudo>`

Cada usuário virtual faz o fluxo completo, todos começando juntos (como uma turma que recebe o código ao mesmo tempo):
cadastro → entra na turma → abre conexão em tempo real (SSE) → abre o estudo → (parte deles cria um estudo novo) → faz as 10 questões (MC, raciocínio, código, entrevista) → finaliza → vê o resultado → anota → abre um conceito do mapa → abre a turma.

O `Server-Timing` de cada resposta separa o tempo **dentro do servidor** da latência total vista pelo cliente.

## O que aconteceu e o que foi corrigido

| # | Problema encontrado | Evidência | Correção |
|---|---|---|---|
| 1 | **Turma atrás do mesmo IP recebia 429.** O limite para quem ainda não tem login era por IP: 100 alunos de uma escola (mesmo NAT) se cadastrando no mesmo minuto estouravam o limite | 2ª rodada seguida: `GET /health 429` | Logado: limite por token. Anônimo: limite por IP 5× maior. `/health` isento. `Retry-After` no 429 |
| 2 | **Tempo real O(N²).** Cada resposta virava um evento para *todos* os alunos conectados; no navegador, cada evento ainda recarregava o placar | ~**1.200 eventos por aluno** numa prova de 10 questões | Eventos agrupados num `tick` a cada 1,5 s, com placar pronto. Presença também agrupada. Professor recarrega o painel no máximo a cada 5 s |
| 3 | **Criação de estudo travava o event loop** (até ~100 ms de CPU cada); com 20 criações juntas, todos esperavam | `POST /studies` p95 de 103 ms *dentro do servidor*, enquanto as outras rotas levavam ~1 ms | Análise de texto movida para um **pool de worker threads**, com fila limitada (503 amigável se lotar) |
| 4 | **SQL recompilado a cada requisição** | ~0,9 ms de servidor por rota simples | Cache de statements preparados → ~0,5 ms |
| 5 | **Placar O(membros × tentativas)**: o `LEFT JOIN` varria todas as tentativas da turma para cada membro | `GET /rooms` com **22 ms** de servidor com 300 alunos; `EXPLAIN` mostrou busca só por `room_id` | Índice composto `attempts(room_id, user_id)`: **17,9 → 1,2 ms**; micro-cache de 1 s do placar |

Bugs encontrados nos testes automatizados e na revisão, durante o mesmo ciclo:
- `GET /attempts/:id` de uma prova **em andamento** devolvia o gabarito de todas as questões → agora só revela as já respondidas.
- Clique duplo em "Enviar" podia gerar erro 500 (havia um `await` entre a verificação e o `INSERT`) → `INSERT OR IGNORE` + 409.
- Workers seguravam o processo vivo (o `unref()` vinha antes do listener) e depois o soltavam no meio de um trabalho → `ref()` enquanto ocupado, `unref()` quando ocioso.

## Resultados

### Evolução — 100 usuários, cenário realista (pensar ~250 ms, 20% criam estudo)

| Métrica | Rodada 1 | Final |
|---|---|---|
| Usuários que concluíram | 100/100 | **100/100** |
| Erros HTTP | 0 | **0** |
| Tempo total | 6,7 s | **4,2 s** |
| Vazão | 288 req/s | **463 req/s** |
| Responder questão (p50 / p95) | 166 / 315 ms | **8 / 78 ms** |
| Eventos de tempo real por aluno | ~1.200 | **~3** |
| Memória do servidor | 52 → 81 MB | 61 → 172 MB (inclui 3 workers) |

### Final — outros cenários

| Cenário | Concluíram | Erros | Tempo | Vazão | Responder p50/p95 |
|---|---|---|---|---|---|
| 100 usuários, rajada (sem pausa, 50% criam estudo) | 100/100 | 0 | 3,6 s | 547 req/s | 96 / 209 ms |
| 300 usuários, realista | 300/300 | 0 | 11,1 s (antes: 17,1 s) | 518 req/s (antes: 337) | 211 / 643 ms |

**Leitura honesta:** com 300 usuários, um processo Node fica perto do teto (~570 req/s nesta máquina). Não houve erro, mas a latência sobe por fila. Na rajada sincronizada (100 cliques no mesmo milissegundo), o primeiro clique de cada um espera ~150–200 ms, que é a fila natural de uma única thread.

## Próximos passos para escalar além de ~300 simultâneos

1. Vários processos (`node:cluster`) com afinidade por turma.
2. Pub/sub (Redis) para os `tick`s de turma entre processos.
3. Postgres no lugar do SQLite quando houver mais de um servidor.
4. Cache HTTP das telas de estudo (o conteúdo de um estudo não muda).
