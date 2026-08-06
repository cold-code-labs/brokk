// Registro de lentes — o único ponto de expansão de revisão do Brokk (ADR 0087 §1).
// Plugar lente nova = uma entrada aqui. O pipeline não muda.
//
// Contrato:
//   id     — funcional, nunca codinome (ADR 0039)
//   axis   — review | qa | ui | arch | product | sec(federado)
//   scope  — diff | repo | runtime
//   trigger— pr | nightly | campaign
//   proof  — executable | advisory   ← o corte que decide se pode fechar sozinha
//   cost   — cheap | heavy
//   prompt({ context, outPath }) → string
//   normalize(raw) → finding canônico

const SEV = ["critical", "high", "medium", "low", "info"]
const sev = (s) => (SEV.includes(String(s).toLowerCase()) ? String(s).toLowerCase() : "medium")

const OUT_CONTRACT = (outPath, extra = "") => `
## Saída (OBRIGATÓRIA)

Escreva o arquivo \`${outPath}\` com JSON no shape:

\`\`\`json
{"findings":[{
  "rule":"slug-curto-estavel-da-regra",
  "title":"uma linha, o defeito em si",
  "body":"por que é defeito + cenário concreto de falha",
  "file":"caminho/relativo.ts",
  "line_start":123,
  "line_end":130,
  "severity":"critical|high|medium|low|info",
  "confidence":0.0,
  "proof_ref":"o teste/cenário que falharia HOJE e passaria depois do fix"
}]}
\`\`\`

Regras duras:
- \`rule\` é um slug ESTÁVEL da classe do problema (ex.: \`inline-style-bypassa-token\`).
  O mesmo problema em runs diferentes precisa gerar o mesmo \`rule\`.
- NÃO invente arquivos, símbolos ou linhas que você não leu. Cite só o que abriu.
- NÃO modifique NENHUM arquivo do repositório. Só leitura + escrever \`${outPath}\`.
- Se não achar nada, escreva \`{"findings":[]}\`. Achado inventado é pior que zero achado.
- Português brasileiro, direto, sem marketing.
- NÃO peça confirmação. Escreva o arquivo e encerre.
${extra}`

/** review.correctness — o eixo do Eitri, agora com ledger. */
export const reviewCorrectness = {
  id: "review.correctness",
  axis: "review",
  scope: "diff",
  trigger: "pr",
  proof: "executable",
  cost: "cheap",
  budget: 8,
  label: "Correção (diff)",
  prompt: ({ context, outPath }) => `Você é revisor sênior da Cold Code Labs revisando um diff.

Procure APENAS defeitos de correção que quebram em execução: lógica invertida,
condição de contorno, null/undefined, race, erro engolido, contrato de API violado,
migração destrutiva, query sem índice em caminho quente, permissão/RLS ausente no
código que a exige. NÃO comente estilo, naming, formatação ou preferência.

Para cada achado, \`proof_ref\` deve descrever o TESTE que falha no código atual —
se você não consegue descrever esse teste, o achado não é de correção: descarte.

## Diff em revisão

\`\`\`diff
${context.diff}
\`\`\`

Você tem o repositório inteiro em ${"`"}.${"`"} para ler contexto ao redor do diff.
${OUT_CONTRACT(outPath)}`,
  normalize: (r) => ({
    rule: r.rule ?? null,
    title: r.title ?? "(sem título)",
    body: r.body ?? "",
    filePath: r.file ?? r.file_path ?? null,
    lineStart: r.line_start ?? null,
    lineEnd: r.line_end ?? null,
    severity: sev(r.severity),
    confidence: typeof r.confidence === "number" ? r.confidence : null,
    proofRef: r.proof_ref ?? null,
  }),
}

/** arch.debt — advisory por desenho: dívida não tem controle negativo. */
export const archDebt = {
  id: "arch.debt",
  axis: "arch",
  scope: "repo",
  trigger: "nightly",
  proof: "advisory",
  cost: "heavy",
  budget: 10,
  label: "Dívida arquitetural (repo)",
  prompt: ({ context, outPath }) => `Você é arquiteto sênior auditando um repositório inteiro.

Alvo: **${context.project}** (${context.stackHint ?? "stack a inferir do repo"}).

Procure dívida estrutural que custa caro e é objetivamente verificável:
- god-component / arquivo que acumulou responsabilidade demais (cite LOC real)
- código morto: import/arquivo/config que nada alcança (prove o caminho morto)
- duplicação de fonte de verdade (dois lugares decidindo a mesma coisa)
- documentação que descreve um stack/fluxo que não é mais o do repo
- token/design-system definido e furado sistematicamente (cite ocorrências)

NÃO reclame de preferência pessoal, nem proponha reescrita ampla. Cada achado
precisa de evidência que qualquer um confere abrindo o arquivo citado.

Comece mapeando o repo (\`ls\`, \`git ls-files\`, wc -l nos maiores) antes de opinar.
Máximo ${10} achados — priorize os de maior custo real.
${OUT_CONTRACT(outPath)}`,
  normalize: (r) => reviewCorrectness.normalize(r),
}

/** qa.a11y — barata, e a11y é assertivo o bastante para ter prova executável. */
export const qaA11y = {
  id: "qa.a11y",
  axis: "qa",
  scope: "repo",
  trigger: "nightly",
  proof: "executable",
  cost: "cheap",
  budget: 8,
  label: "Acessibilidade (WCAG 2.1 AA)",
  prompt: ({ context, outPath }) => `Você audita acessibilidade no CÓDIGO-FONTE de **${context.project}**.

Procure violações WCAG 2.1 AA verificáveis estaticamente:
- controle interativo sem nome acessível (ícone-botão sem aria-label/texto)
- \`div\`/\`span\` com onClick sem papel nem foco por teclado
- imagem sem alt (ou alt redundante), input sem label associado
- ordem de heading quebrada, landmark ausente
- foco visível removido (\`outline: none\` sem substituto)

\`proof_ref\` = a asserção axe/Playwright que falha hoje.
NÃO reporte contraste (precisa de render, não de fonte).
Comece localizando os componentes de UI antes de opinar.
${OUT_CONTRACT(outPath)}`,
  normalize: (r) => reviewCorrectness.normalize(r),
}

export const LENSES = {
  [reviewCorrectness.id]: reviewCorrectness,
  [archDebt.id]: archDebt,
  [qaA11y.id]: qaA11y,
}

export function getLens(id) {
  const l = LENSES[id]
  if (!l) throw new Error(`lente desconhecida: ${id} (tenho: ${Object.keys(LENSES).join(", ")})`)
  return l
}
