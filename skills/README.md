# `skills/` — estado em 24/08/2026

Este diretório está **órfão desde a ADR 0100** ("Brokk sobre Coder: o control
plane larga o runtime"). O `packages/agents/chat/src/load-skills.ts`, que era
quem o lia, foi deletado no commit `9b65cdb`.

Verificado neste commit: nenhum `Dockerfile` copia `skills/`, nenhum
`docker-compose` referencia, nenhuma rota do `apps/api` serve `/skills`.
O `apps/web/lib/chat.ts` ainda chama `GET /skills` — a implementação não está
mais aqui.

## Para onde foi

O método da casa passou a viver em **[cold-code-labs/galdr](https://github.com/cold-code-labs/galdr)**,
a biblioteca de skills da CCL. As canônicas de `litr` e `litr-frontend-design`
são as do Yggdrasil, que carregam a procedência (ADR 0028, pesquisa na Edda,
piloto no Svalinn) que as versões podadas daqui perderam.

Quem carrega skill hoje é o Coder, e o modelo dele é **workspace skill** —
descoberta no filesystem, sob `.agents/skills/`. É por isso que a rota nova é
`galdr sync . --perfil litr,assurance`, e não uma variável de ambiente.

## O que fazer com o que sobrou aqui

| arquivo | veredito |
|---|---|
| `litr/`, `litr-frontend-design/` | superadas pelas do Galdr |
| `user-data-flow/`, `qa-review/`, `full-qa/`, `svalinn-remediate/` | promovidas ao Galdr (perfis `assurance` e `security`) |

Nada foi apagado neste PR de propósito: a evidência de orfandade é forte, mas
apagar seis arquivos de instrução é decisão de quem toca o Brokk, não efeito
colateral de uma renomeação. Se o veredito for apagar, `galdr doctor` já garante
que o conteúdo não se perde — ele mora na biblioteca.
