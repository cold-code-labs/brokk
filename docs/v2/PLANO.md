# Brokk como plataforma de desenvolvimento

O Brokk organiza o trabalho de desenvolvimento da Cold Code Labs, do pedido do cliente à revisão de uma entrega. Profissionais direcionam escopo, experiência e prioridades em uma plataforma própria; o servidor controla organizações, permissões, versões e integrações. O produto será acessado diretamente ou pelo agente de desenvolvimento no catálogo do Var.

## Produto e modelo de operação

Uma organização reúne seus projetos. Cada projeto registra objetivo, público, entregas, restrições, itens fora de escopo e critérios de aceite. O escopo aprovado é a referência para o desenvolvimento: uma alteração posterior cria uma nova versão e pede uma nova validação. O histórico preserva o que foi combinado, quem propôs e quem decidiu.

O trabalho é dividido em tarefas pequenas, relacionadas ao escopo e às telas. Cada tarefa tem descrição, critério de aceite, prioridade e estado. Telas possuem propósito, fluxo e especificação; o design system registra tokens e componentes sem executar HTML ou código fornecido pelo usuário. Reviews guardam o alvo e a versão revisada, comentários e decisão. Aprovação de produto não equivale a permissão de deploy.

A relação comercial é uma operação contínua de desenvolvimento assistido: carteira por organização, escopo e entregas aprováveis, solicitações de mudança e acompanhamento. Nesta entrega, a plataforma registra esse ciclo; contratação, cobrança e precificação ficam no sistema comercial da CCL. Nenhum preço ou plano de assinatura será inventado no produto.

## Experiência

O workspace tem navegação por organização, carteira de projetos e abas de visão geral, escopo, trabalho, telas, design system, revisões, calls e atividade. A interface usa português, linguagem de produto e estados reais: vazio, carregamento, falha, conflito de versão, integração indisponível e sucesso. O usuário pode criar registros, editar, revisar e acompanhar atividades sem conhecimento de Git ou SQL.

O painel de desenvolvimento mostra sessões do Devin, estado, mensagens e resultados disponíveis. Pedidos adicionais são enviados pelo backend depois da autorização. O contexto enviado inclui apenas escopo, tarefa, especificações e feedback autorizados. Credenciais, contratos, dados bancários e acesso à infraestrutura não entram no prompt.

A call de review reúne vídeo e compartilhamento de tela com um painel de observações: gostou, ajuste, dúvida e decisão. Cada observação pode ser ligada a uma tela. O fechamento produz um resumo das decisões e tarefas de ajuste, preservando as notas originais. A extração assistida sugere mudanças; nunca aprova escopo nem executa desenvolvimento automaticamente. Câmera e microfone dependem da ação do participante; captura/transcrição depende de consentimento explícito na call.

## Papéis e organizações

| Papel | Capacidades |
| --- | --- |
| Administrador técnico | Criar organizações, atribuir membros, configurar repositórios permitidos e políticas de integração. |
| Operador | Planejar, editar especificações, criar tarefas, solicitar trabalho ao Devin, organizar reviews e calls nas organizações atribuídas. |
| Cliente | Consultar seu projeto, registrar feedback e decidir reviews; sem delegação ao Devin nem configuração técnica. |
| Leitor | Consultar registros e atividade autorizados. |

Identidade é verificada no servidor por OIDC/CCL ID. Sessões são opacas, expiram e usam cookies HttpOnly, Secure em produção e SameSite. Papéis vêm do cadastro no banco, nunca do navegador. Um administrador inicial é definido por allowlist de e-mail no ambiente. Domínio de e-mail não concede acesso. Todas as leituras, eventos, exportações e mutações validam associação à organização; IDs de outra organização retornam inacessível.

Convites e mudanças de papel são auditados. O operador não pode atribuir papel administrativo, escolher credenciais, alterar uma URL interna, consultar SQL nem executar comandos. Links de mídia e resultados são validados antes de aparecer na interface. A API limita payloads, exige origem nas mutações de sessão, rejeita campos inesperados e protege contra conflitos com versão esperada.

## Stack e dados

React 19 com Vite para a SPA; Hono em Node para API e arquivos estáticos; TypeScript compartilhado e Zod para contratos; Postgres para persistência. O frontend não possui chaves de serviço nem acesso direto ao banco. Fontes são locais, assets versionados e o build não depende de um registry privado de design system. O CSS estabelece os componentes e tokens do próprio Brokk.

Um serviço HTTP entrega SPA e API na mesma origem. Um namespace novo no banco mantém dados legados intactos. Migrações são versionadas, idempotentes e aplicadas por conta técnica no boot. Organizações, membros, sessões e projetos são entidades relacionais; artefatos de produto têm conteúdo estruturado, versão e histórico. Atividade e revisões são registros duráveis. Escritas relacionadas são atômicas.

Desenvolvimento local e testes podem usar identidade de teste somente fora de produção. Produção exige banco, origem HTTPS e autenticação real. Sem integração configurada, ações externas retornam indisponível com explicação; a plataforma não simula uma sessão paga nem uma sala de vídeo.

## Devin

Usar a API v3 por organização, com credencial exclusivamente no servidor. O administrador configura a organização do provedor, repositórios autorizados e teto de ACU por sessão. Cada tarefa possui uma reserva durável de execução e chave de correlação: duplo clique, concorrência ou timeout não podem criar duas sessões automaticamente. Resultado incerto permanece em reconciliação e não é relançado silenciosamente.

O operador vê o contexto antes de enviar. A instrução limita o trabalho ao repositório configurado, solicita PR e validações e veta deploy, infraestrutura e segredos. Essa instrução é complementar: as permissões reais do provedor devem restringir repositórios e credenciais. Status e mensagens são sincronizados no backend. Acompanhamento usa eventos do projeto; comandos novos são mensagens de produto, nunca shell.

## Calls e inteligência de review

Salas privadas Daily, tokens de participante com duração limitada, autorização por organização e limite de criação. Chaves Daily ficam no servidor. A interface inclui vídeo, tela compartilhada, notas colaborativas e contexto das telas. O resumo determinístico transforma observações de ajuste em propostas de tarefa; quando disponível, o gateway de IA pode aprofundar critérios de aceite a partir das notas. O original é preservado e a revisão humana decide o que entra no backlog.

Transcrição nativa do provedor é opt-in e condicionada às capacidades habilitadas na conta. O ciclo de review não depende de transcrição: notas manuais e decisões continuam disponíveis. Recording, armazenamento de áudio e infraestrutura de streaming própria são uma etapa posterior.

## Integração com o Var

O catálogo apresenta Brokk como agente de desenvolvimento. Um endpoint exclusivamente servidor recebe empresa, projeto e usuário já autorizados pelo Var. O contrato é idempotente e organiza vínculos externos por empresa/projeto. Um ticket opaco, curto e de uso único abre o workspace com o papel limitado ao que o Var concedeu. O ticket não permite escolher repositório nem papel administrativo. Nenhum segredo de integração entra no bundle.

As instruções do agente explicam seu papel: aprofundar objetivo, propor escopo e critérios de aceite e encaminhar ao workspace. A operação técnica continua no Brokk. Os fluxos antigos do Var que já chamam o Brokk devem receber uma adaptação explícita ou uma resposta de migração, evitando gravações acidentais no modelo legado.

## Cutover e entrega

Preservar a recuperação de mimir em uma referência Git e iniciar a reconstrução sobre a main atual. O novo serviço substitui a plataforma antiga desligada. Código legado permanece recuperável pelo histórico; containers de workers e previews não fazem parte do novo deploy. O domínio oficial continua no Coolify, com healthcheck e identificação da revisão implantada.

Sequência: implementar contratos e persistência; autenticação e isolamento; workspace e artefatos; Devin; calls; integração no Var; testes de backend e browser; PRs; CI Woodpecker verde; merge; implantação oficial; verificar HTTPS, health, autenticação, isolamento e revisão implantada. Um bloqueio de credencial ou infraestrutura deve ser registrado como tal, sem chamar uma integração desconectada de funcional.

## Critérios de entrega

1. Criar organização e projeto; salvar e reabrir o escopo sem perda.
2. Isolar duas organizações e impedir escalada de leitor, cliente e operador.
3. Criar tarefas, telas, tokens e componentes; validar a edição com versão esperada.
4. Solicitar revisão e registrar aceite ou ajustes sobre a versão correta.
5. Abrir call autorizada, anotar feedback e criar ajustes rastreáveis.
6. Reservar uma execução Devin, enviar contexto limitado e acompanhar mensagens sem duplicação paga.
7. Abrir o Brokk pelo catálogo do Var com contexto e associação de organização corretos.
8. Servir a SPA em rotas diretas, passar checks e verificar o serviço oficial em produção.

## Etapa seguinte

Lanes de preview, Coder, execução de código, sandbox e promoção de ambientes entram depois deste núcleo. O futuro editor ao vivo recebe apenas ambientes isolados e efêmeros, com capacidades por projeto, proxy autenticado e separação entre preview e produção. Não existe terminal administrativo ou conexão de banco no workspace desta entrega.

## Referências técnicas

- [Devin v3 criação de sessão](https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions)
- [Devin v3 mensagens](https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions-messages)
- [Daily salas privadas](https://docs.daily.co/reference/rest-api/rooms/create-room)
- [Daily tokens de reunião](https://docs.daily.co/reference/rest-api/meeting-tokens/create-meeting-token)

## Reviews externas pela extensão Chrome (outubro de 2026)

O endereço canônico é https://brokk.a4.ia.br. A equipe A⁴ acessa o Brokk pela área interna. O agendamento permanece no calendário habitual; não existe automação de calendário nesta etapa. Mateus cria/seleciona uma review no projeto, gera uma conexão limitada a quatro horas e a cola na extensão Brokk Review. O ZIP interno em `/downloads/brokk-review.zip` contém somente os assets da extensão MV3, sem segredos. Instalação e privacidade estão disponíveis na área Calls de review.

A captura explícita reúne áudio da aba selecionada e microfone em PCM pelo AudioWorklet. O documento offscreen mantém o áudio quando o painel fecha; o worker persiste estado e fila no Chrome. O servidor fornece apenas um token temporário de transcrição AssemblyAI com janela de resgate de dez segundos e sessão máxima de duas horas; a chave principal nunca vai ao navegador. Tokens temporários do provedor não são de uso único. A extensão não lê páginas, histórico, calendário ou vídeo. O operador precisa avisar os participantes. Os termos de retenção dos provedores continuam aplicáveis.

A conexão é limitada a uma review e revalida identidade, associação e papel a cada envio. IDs estáveis tornam reenvios idempotentes. Capture ativa bloqueia encerramento; o operador deve parar e sincronizar ou revogar explicitamente uma conexão abandonada. A revogação bloqueia novos envios; parar a extensão interrompe o áudio. Originais, versões e autores ficam preservados. O gateway de análise recebe somente texto e exige propostas com referências às observações existentes. Falha de transcrição ou análise é visível e não produz sucesso fictício.

Encerrar gera resumo e propostas pendentes, sem tarefas automáticas. A equipe edita título, descrição, critérios de aceite e referência opcional de arquivo/linha, confirma ou descarta. A confirmação transacional cria uma tarefa única no backlog com rastreio à call/proposta; execução continua sendo uma ação no Desenvolvimento. Referências de código são indicações da equipe, não afirmações de inspeção ou alterações já aplicadas. O fluxo existente de executor → PR → Woodpecker → preview continua obrigatório.
