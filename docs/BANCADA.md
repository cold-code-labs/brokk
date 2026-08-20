# Bancada — runbook

A bancada é o ambiente **quente** de um projeto: um workspace do Coder com o
checkout, o dev server com HMR, o agente e o Playwright. Ver
[ADR 0100](adr/0100-brokk-sobre-coder.md) para o porquê.

## Quente × frio

| | onde | branch | quem monta |
|---|---|---|---|
| bancada (quente) | `coder.coldcodelabs.com/@brokk/<ws>.main/apps/bancada/` | a lane (`dev`) | Brokk → Coder |
| preview (frio) | `<app>.preview.coldcodelabs.com` | `preview` (ou `dev`) | push → Gjallarhorn → Coolify + Hauldr `<base>_dev` |
| prod (frio) | `<app>.coldcodelabs.com` | `main` | push → Gjallarhorn → Coolify + Hauldr `<base>` |

Mexeu em schema, banco ou sidecar? **Não é coisa de bancada** — vai no
commit/push para a branch de preview, e o ambiente frio se monta.

## Operar

```bash
# abrir/adotar a bancada da lane dev de um projeto
curl -X POST "$BROKK/bancadas" -H 'Content-Type: application/json' \
  -d '{"projectId":"<uuid>"}'

# estado real (esta rota RE-LÊ o Coder e reconcilia o registro)
curl "$BROKK/bancadas/<id>"

# falar com o agente que está lá dentro
curl -X POST "$BROKK/bancadas/<id>/agent" -H 'Content-Type: application/json' \
  -d '{"content":"suba o contraste do botão primário"}'

# parar (mantém o disco) · recriar do zero
curl -X POST "$BROKK/bancadas/<id>/stop"
curl -X DELETE "$BROKK/bancadas/<id>"
```

## Quando algo não sobe

1. **`status: failed` com "startup falhou"** — o motivo está DENTRO do workspace:
   `/tmp/bancada.log` (o script), `/tmp/dev.log` (o dev server). Pela surtr:
   ```bash
   docker exec bancada-<owner>-<ws> tail -50 /tmp/bancada.log
   ```
2. **"projeto não tem runtime detectado"** — o `fastPath` não reconheceu o repo.
   Isso é uma recusa, não um bug: a alternativa seria chutar o comando de dev, e
   é assim que uma bancada nasce quebrada dizendo que está pronta.
3. **`pronta` mas a página não carrega** — o app só é marcado pronto depois de um
   `curl` interno responder na porta. Se a porta responde e o iframe não, o
   navegador precisa de sessão no Coder (o app está em `share: authenticated`).
4. **push recusado dentro da bancada** — o `credential.helper` troca o segredo da
   bancada por um token de instalação. Um 404 ali significa que a bancada foi
   recriada (segredo novo) ou apagada; um 503 significa GitHub App sem chave no
   `brokk-api`.

## Segredo com quebra de linha

⚠️ A chave do GitHub App vai na env **em uma linha**, com `\n` escapado. O
Coolify materializa as variáveis num `.env` para o container: uma PEM
multi-linha faz cada linha da chave virar "variável" e o deploy morre em
`unexpected character "/" in variable name "MIIEpQ..."` — depois de já ter
removido os containers antigos. Ou seja: derruba o app.

## Template

Mora em [`deploy/coder/bancada`](../deploy/coder/bancada/main.tf). Empurrar
versão nova:

```bash
coder templates push bancada -d deploy/coder/bancada --yes
```

Os workspaces são provisionados na **surtr** por SSH sobre a WireGuard — não no
ymir, que é o bastion. Mudar de host é trocar a variável `docker_host`.
