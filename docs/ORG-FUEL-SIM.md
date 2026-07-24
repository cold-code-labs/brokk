# Fuel por org — simulação “empresa powered by Claude seat”

**Status:** smoke F2 feito (2026-07-24) · binding Brokk→org ainda P3 (ADR 0077)  
**Relaciona:** `ORG-TENANCY.md` · ADR 0071 · ADR 0077

## O que provamos

1. Seat Claude do Mateus (`mateus@coldcodelabs.com` em `subscriptions`) fala com Anthropic (OAuth) → **200**.
2. O mesmo OAT no **OmniRoute** (`provider_connections` Claude, `health_check_interval=0`) → `/v1/messages` e chat completions **200**.
3. **LiteLLM** wildcard `*` aponta para `http://omniroute:20128` → Messages **200** **sem** Ratatoskr.
4. Ratatoskr `:8790` drenado; tenancy Brokk (T0–T2) já isola projects por `logto_org_id`.

Isso é o mesmo papel que o Ratatoskr tinha (seat→API), agora no Omni — base para uma org cliente “powered by Claude seat”.

## Simulação alvo (Dermaflora-style)

```text
Logto org: dermaflora (exemplo)
  └─ Brokk projects.logto_org_id = <org>
       └─ Chat/Forge turn
            └─ fuel resolver:
                 mode=seat → Omni connection_id da org
                 mode=byok → LiteLLM team + Anthropic API key da org
                 mode=fleet → vkey CCL (só staff / fallback)
```

### Passos manuais do piloto

1. Criar org Logto de teste (ou usar org cliente real).
2. Garantir membro + `BROKK_ORG_TENANCY=1` (já live).
3. Criar projeto Brokk com `logto_org_id` da org.
4. **Fuel (hoje):** frota ainda usa vkey CCL → Omni (connection Mateus = seat de desbloqueio F2).  
   **Fuel (próximo):** duplicar connection Omni tagueada à org **ou** LiteLLM team `logto_org_id=…` + metadata em cada request.
5. Medir: LiteLLM spend filtrado por team/metadata + eventos effort Brokk (ADR 0077 P1).

### O que ainda não está no código

- Tabela `org_fuel_bindings` (org → omni_connection_id | litellm_team_id | mode).
- Spawn Chat/Forge lendo o binding em vez da vkey global.
- Pricebook Lago por org.

## Como o Mateus “simula” a empresa agora

Enquanto o binding não existe, o caminho feliz de demonstração é:

1. User da org abre Brokk (tenancy isola dados).
2. Turnos Chat OpenCode Auto → LiteLLM → Omni → seat Claude (Mateus).
3. Narrativa comercial: “a org roda 100% no Brokk; o fuel é seat Claude (como o Ratatoskr fazia; agora Omni)”.
4. Custo CCL a medir: effort (workers/preview) + overhead gateway — fuel Anthropic no seat, não em API key CCL.

Quando a empresa trouxer **BYOK** (`sk-ant-api…`), o modo vira LiteLLM team da org (ADR 0077) e o seat Max deixa de ser o COGS de tokens.
