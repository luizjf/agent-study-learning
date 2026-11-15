# Segurança · Security

**PT** — A Trilha é um protótipo de estudo. Não use com dados sensíveis: o login é só nome + token, sem senha.

**EN** — Trilha is a study prototype. Do not use it with sensitive data: login is name + token only, with no password.

## Relatar uma vulnerabilidade · Reporting a vulnerability

**PT** — Abra uma issue **sem detalhes exploráveis** pedindo um contato privado, ou use "Report a vulnerability" na aba *Security* do repositório (GitHub Private Vulnerability Reporting). Tentamos responder em até 7 dias.

**EN** — Open an issue **without exploitable details** asking for a private contact, or use "Report a vulnerability" in the repository's *Security* tab (GitHub Private Vulnerability Reporting). We aim to respond within 7 days.

## O que já é tratado · What is already handled

| Risco · Risk | Mitigação · Mitigation |
| --- | --- |
| SSRF (links enviados pelo usuário · user-submitted URLs) | Bloqueio pelo IP resolvido no momento da conexão, IPv4/IPv6/mapeado, redirecionamentos revalidados · Resolved-IP check at connect time, IPv4/IPv6/mapped, redirects revalidated |
| Prompt injection (transcrição/resposta · transcript/answer) | Skills tratam conteúdo como dado; Claude Code roda sem ferramentas nem MCP; saída validada por schema · Skills treat content as data; Claude Code runs with no tools or MCP; schema-validated output |
| Código do aluno · Student code | Nunca executado no servidor (só compilado); no navegador roda em Web Worker sem rede, 3 s · Never executed server-side (compile only); browser Web Worker, no network, 3 s |
| XSS | Texto sempre como nó de texto; CSP restritiva · Text always as text nodes; strict CSP |
| Acesso a dados de outros · Cross-user access | Checagem de dono/membro em toda rota · Owner/member checks on every route |
| Abuso · Abuse | Limite por usuário e por IP; teto diário de tokens dos agentes · Per-user and per-IP rate limits; daily agent token budget |
| Exposição da assinatura Claude · Claude subscription exposure | Modo `claude-code` só em localhost · `claude-code` mode only on localhost |
| Dados apagados · Deleted data | `PRAGMA secure_delete = ON` |

## Auditoria · Audit

**PT** — Antes da publicação, o código passou por revisão manual e pela skill [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill), em modo de auditoria completa com perfil `quick` (passada parcial). Foram 6 agentes caçadores, 1 crítico de cobertura e 4 verificadores independentes, só sobre o código-fonte. Resultado:

- nenhum achado confirmado;
- 1 candidato rejeitado na verificação;
- 3 pistas de disponibilidade e custo, já corrigidas:
  - teto diário de tokens por conta: agora há reserva e teto global;
  - HTML e PDF sem limite: remoção de HTML linear e teto de texto em todas as fontes;
  - limpeza de fala de custo cúbico: agora O(log n), com prazo por análise.

**EN** — Before publishing, the code went through a manual review and the [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill), in full audit mode with the `quick` profile (a partial pass). It used 6 hunter agents, 1 coverage critic and 4 independent verifiers, source-only. Result:

- no confirmed findings;
- 1 candidate rejected on verification;
- 3 availability and cost leads, now fixed:
  - per-account daily token budget: now with reservation and a global cap;
  - uncapped HTML and PDF: linear HTML stripping and a text cap on every source;
  - cubic speech cleanup: now O(log n), with a per-analysis deadline.

## Fora do escopo do protótipo · Out of scope for the prototype

**PT** — Autenticação forte (senha, OAuth), HTTPS (use um proxy reverso), criptografia do banco em repouso e auditoria de acesso.

**EN** — Strong authentication (password, OAuth), HTTPS (use a reverse proxy), encryption at rest and access auditing.
