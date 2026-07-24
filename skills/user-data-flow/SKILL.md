---
name: user-data-flow
description: >-
  Spec and gate for user-facing data lifecycles (CRUD + archive + empty CTA) on
  entity rooms. Use when building or reviewing Brokk Hero/prototype screens,
  room maps, "missing Add button", list-only mockups, or when the user mentions
  user data flow, entity lifecycle, arquivar, excluir, or fluxo de dados.
---

# User Data Flow Spec

Lista sem verbo = vitrine. Protótipo de gestão precisa **mostrar o ciclo** que
o usuário vive — mesmo com mock/local state.

## Uma linha

```
entidade citada → sala dona → verbos na UI → empty CTA → vínculo com outras salas
```

## Quando rodar

- Hero forge / profundidade de salas de console
- Review de preview (“parece imaturo”, “cadê adicionar?”)
- Depois do room map Litr (`docs/litr/rooms.md`)
- Antes de marcar aceite de uma sala **entity**

Companion: `litr` / `litr-frontend-design` cuidam de alma e hot spot;
**esta skill** cuida do **fluxo de dados do usuário**.

## Tipos de sala

| Tipo | Exemplo | Verbos mínimos |
|---|---|---|
| **entity** | Representantes, produtos, clientes | **Novo** · ver · **editar** · **arquivar** (soft) · empty CTA |
| **pipeline** | Funil, arte | Mover estágio · abrir detalhe · (criar card se a esteira começa aqui) |
| **tool** | Cotação, frete | Calcular · **salvar como entidade** (proposta/orçamento) se o fluxo cria registro |
| **ledger** | Financeiro P/R | Mudar status (aberto→pago) · gerar cobrança mock — sem “excluir contábil” solto |
| **study** | Estoque estudo | Read-only **explícito** (“estudo”) — sem fingir CRUD |

Se a sala **filtra/cita** uma entidade e não é a dona dela, a dona precisa existir
(ou a sala ganha create inline). Mesma regra do room map: cita → hot spot ou sala.

## Artefato

Gravar `docs/litr/data-flow.md` (ou seção em `rooms.md`) com uma linha por entidade:

```markdown
| Entidade | Sala dona | Create | Edit | Archive | Delete hard? | Sai para |
|---|---|---|---|---|---|---|
| Representante | /representantes | + Novo | card | Arquivar | não (protótipo) | /funil?rep= |
```

**Delete hard** no Hero: default **não**. Prefira arquivar + filtro “ativos /
arquivados”. Hard delete só se o brief do cliente exigir.

## Checklist por sala entity

```
- [ ] Primary CTA visível no head da sala ("+ Novo …")
- [ ] Empty state com o mesmo CTA (não só lista vazia)
- [ ] Cada item: editar + arquivar (ou menu … com os dois)
- [ ] Create/edit: campos que o brief citou (não formulário genérico de 20 inputs)
- [ ] Persistência do protótipo: useState / localStorage / mock mutável — declare no data-flow
- [ ] Vínculo: depois de criar, dá pra ver o efeito noutra sala (funil, proposta, …) ou deep-link
- [ ] Copy de arquivo/exclusão em pt-BR claro (Arquivar ≠ Excluir)
```

## Anti-padrões

- Roster só leitura com regras bonitas e zero gesto de cadastro
- “Excluir” sem confirmação em entidade que outras salas citam
- CRUD escondido só no chat Sindri — a **tela** é o contrato da demo
- Inventar BaaS/auth só pra ter POST — mock mutável basta no Hero

## Gate (antes de “pronto”)

Para cada rota `entity` no hero_set / rooms:

1. Abrir a sala → CTA Novo existe sem scroll hunt  
2. Criar um item → aparece na lista  
3. Arquivar → some dos ativos (ou badge Arquivado)  
4. Editar → mudança visível  
5. Se outra sala cita a entidade → deep-link ou filtro ainda faz sentido  

Falhou algum → não fechar o card; completar o data-flow.

## Brokk / one-shot

No forge: depois do Litr room map, **rodar esta skill** nas salas entity do
`hero_set` (e nas de profundidade quando o card for entity). Anotar gaps em
`docs/litr/data-flow.md` — deferred explícito > omitir o botão.
