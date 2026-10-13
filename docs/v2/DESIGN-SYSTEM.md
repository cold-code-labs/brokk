# Contrato de design do Brokk

O design system do projeto conecta valores, decisões semânticas, objetos de interface e composição de telas. A referência NFCS usa a direção Autos da Aurora para verificar essa cadeia com uma página existente. O contrato `brokk.design-system/1` é a fonte do laboratório, dos arquivos exportados e do contexto preparado para desenvolvimento.

## Fluxo de trabalho

1. Criar o projeto e registrar objetivo, escopo e critérios de aceite.
2. Importar um manifesto Brokk ou cadastrar tokens e componentes. O exemplo NFCS inclui 86 tokens, 16 componentes e seis áreas da página publicada.
3. Inspecionar valores resolvidos, consumidores, variantes, estados e propriedades. As prévias usam o contrato e fontes locais; não executam código trazido pelo operador.
4. Validar o conjunto e resolver erros de tipos, referências, ciclos, composição e contraste declarado.
5. Revisar as especificações e exportar a revisão acordada para desenvolvimento.

O cadastro e a importação são ações de operador ou administração. Clientes podem acompanhar, exportar e revisar; leitores não alteram o conjunto. Cada leitura e mutação usa o projeto e a organização autorizados no servidor.

## Nomes e camadas

As chaves são estáveis, minúsculas e separadas por pontos. Nomes legíveis e descrições ficam separados dessa identidade. Uma chave é única dentro do projeto; um token não pode ocupar simultaneamente o caminho de um grupo e de um valor.

| Camada | Papel | Exemplo NFCS |
| --- | --- | --- |
| Primitivo | Valor material da marca | `color.highlight.yellow = #f4d33b` |
| Semântico | Decisão de uso, ligada à origem | `color.surface.highlight = {color.highlight.yellow}` |
| Componente | Decisão específica de um elemento | Um token que referencia a decisão semântica e é usado pelo objeto |

Primitivos guardam valores. Aliases preservam a chave de origem e o tipo; copiar o mesmo hex em dois registros não cria uma relação. O projeto mantém sua própria paleta, independente do tema laranja do Brokk.

## Valores e objetos

O perfil atual suporta `color`, `dimension`, `fontFamily`, `fontWeight`, `number`, `duration`, `cubicBezier`, `shadow` e `typography`. Dimensões usam px ou rem. Cor usa hex com alfa opcional. Peso tipográfico é numérico. Sombra tem camadas com cor, offsets, blur, spread e inset. Tipografia tem família, tamanho, peso, tracking e entrelinha; cada campo pode referenciar um token do tipo correspondente.

Os exports de tokens usam os valores nativos e aliases do [DTCG Format Module 2025.10](https://www.designtokens.org/tr/2025.10/format/), com metadados Brokk em `$extensions`. Este é um perfil de exportação dos tipos suportados; o importador recebe o manifesto Brokk, não um importador universal de todos os módulos e referências DTCG.

Na NFCS, tracking originalmente escrito em em é registrado em rem para o tamanho máximo do objeto. A regra proporcional e os valores fluidos de clamp permanecem no comportamento responsivo do componente. O consumidor de código deve aplicar essa regra ao implementar a tela.

## Componentes e telas

Um componente declara:

- Identidade e tipo de prévia controlada.
- Vínculos propriedade → token, com tipos compatíveis.
- Variantes e estados que sobrescrevem os vínculos de base.
- Propriedades do objeto, com tipo, valor padrão e obrigatoriedade.
- Outros componentes da composição.
- Critérios de aceite, comportamento responsivo, acessibilidade e evidência de origem.

Uma tela lista chaves de componentes existentes no mesmo projeto. Alterar uma cor ou medida não exige copiar valores entre objetos: o resolvedor recalcula aliases, tipografia, sombras e vínculos. Recursos de mídia permanecem referenciados; a prévia não reproduz arquivos externos.

As prévias são exemplares do contrato. A disposição final, os assets e a interação da página continuam sendo responsabilidade da implementação. A fonte original NFCS também registra uma revisão necessária de teclado no localizador: a receita exige seleção por setas, Home/End e foco móvel, além do estado selecionado.

## Validação e histórico

A API valida a importação inteira numa transação. Um erro não cria metade do conjunto. Uma repetição idêntica é idempotente; uma chave existente com conteúdo diferente exige uma decisão explícita, sem sobrescrita automática.

Criação e edição estruturadas recusam valores inválidos, aliases ausentes, tipos incompatíveis, ciclos, conflitos de caminho, componentes ausentes e combinações declaradas de contraste insuficiente. Valores numéricos são verificados também no contexto da propriedade que os utiliza.

Tokens sem consumidores são observações de biblioteca, não relações inventadas para preencher cobertura. A NFCS mantém 11 primitivas de reserva na extração atual. A verificação de contraste contempla 37 combinações com foreground e background explícitos. Imagens, fundos translúcidos, foco e comportamento completo da página exigem verificação no contexto implementado.

Editar uma especificação incrementa sua versão. Dependentes transitivos também avançam, recebem snapshots e voltam a rascunho se estavam aprovados. Revisões aprovadas ou pendentes desses itens passam a ajustes; uma decisão antiga não pode aprovar uma aparência nova. A auditoria mantém a origem da alteração e a versão revisada.

## Entrega para código

Os arquivos disponíveis são:

| Arquivo | Uso |
| --- | --- |
| Contrato completo JSON | Revisões, checksum, valores resolvidos, objetos, estados, componentes e telas |
| Tokens `.tokens.json` | Intercâmbio dos tokens e metadados de origem |
| CSS | Variáveis e regras de componentes preservando aliases |
| Manifesto Brokk JSON | Reimportação do conjunto estruturado |

O CSS usa um escopo por projeto, com `data-design-system` no container. Elementos recebem `data-component`; variantes usam `data-variant` e estados declarados usam `data-state`. Estados nativos apropriados também recebem seletores CSS. Objetos tipográficos emitem variáveis por campo, sem perder os aliases internos.

O contrato completo tem checksum SHA-256 de conteúdo canônico e lista a versão de cada especificação. O contexto preparado para o Devin recebe esse mesmo contrato e o checksum. Ele não perde tokens por um corte silencioso dos primeiros 50 itens e não trunca JSON: conjuntos acima do limite de contexto são recusados com uma ação de correção.

Preparar ou exportar o contexto não inicia uma sessão paga. A execução continua exigindo escopo aprovado, repositório autorizado e limites do provedor. Aprovação de design não concede permissão para deploy do código do cliente.

## API e manutenção

`GET /api/projects/:id/design` retorna contrato e validação. `POST /api/projects/:id/design/import` recebe o manifesto. `GET /api/projects/:id/design/export?format=contract|tokens|css|manifest` exporta um conjunto válido com controle de acesso e cache privado.

`shared/design.ts` contém o esquema, resolvedor, análise de relações, contraste e exportação. `server/design.ts` adiciona o checksum. `src/DesignSystem.tsx` implementa biblioteca, editores e laboratório. A amostra curada fica em `shared/examples/nfcs.ts`, com origem na página e em `lps/nfcs/src` da Aurora.

Verificações necessárias: tipos, lint, suíte com PostgreSQL isolado, build e navegador. Os testes cobrem propagação, ciclos, tipos, round trip, isolamento, importação atômica/idempotente, versões, invalidação de revisão e contexto de desenvolvimento.
