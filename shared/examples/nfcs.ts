import type {
  Binding,
  ComponentSpec,
  DesignManifest,
  DesignSpec,
  TokenSpec,
} from "../design.ts";

const url = "https://aurora.coldcodelabs.com/nfcs/";
const source = (
  path: string,
  note = "Extraído do código da Aurora e conferido na página publicada em 13/10/2026.",
) => ({ url, path: `lps/nfcs/src/${path}`, note, capturedAt: "" });
const items: DesignManifest["items"] = [];
function token(
  key: string,
  type: TokenSpec["type"],
  value: TokenSpec["value"],
  body: string,
  layer: TokenSpec["layer"] = "primitive",
  path = "index.css",
) {
  items.push({
    title: key,
    body,
    acceptance:
      "Resolver com o tipo declarado, preservar referências e propagar alterações aos consumidores.",
    design: { kind: "token", key, type, value, layer, source: source(path) },
  });
}
const palette = {
  "paper.base": "#e7e5e0",
  "paper.dark": "#dbd8d1",
  "paper.edge": "#c5c1b8",
  "paper.sheet": "#f3f1ec",
  "ink.base": "#1b1d20",
  "ink.raised": "#272a2e",
  "ink.hover": "#3a3e43",
  "ink.muted": "#5b5e62",
  "highlight.yellow": "#f4d33b",
};
for (const [name, value] of Object.entries(palette))
  token(
    `color.${name}`,
    "color",
    value,
    `Paleta Autos: ${name}. O amarelo é reservado ao grifo, não aos botões.`,
  );
for (const [i, value] of ["#d9d6cf", "#c8c4ba", "#e2dfd9", "#bdb9ae"].entries())
  token(
    `color.folder.${i + 1}`,
    "color",
    value,
    "Tom material de uma pasta na estante.",
    "primitive",
    "Arquivo.tsx",
  );
for (const [name, value] of Object.entries({
  "ink.divider": "#1b1d2026",
  "paper.divider": "#e7e5e026",
  "shadow.soft": "#0000000f",
  "shadow.deep": "#0000008c",
}))
  token(
    `color.${name}`,
    "color",
    value,
    "Cor com alfa explícito, correspondente à composição observada no código.",
  );
for (const [name, value] of Object.entries({
  display: '"Newsreader", ui-serif, Georgia, serif',
  body: '"Public Sans", ui-sans-serif, system-ui, sans-serif',
  data: '"Courier Prime", ui-monospace, "Courier New", monospace',
}))
  token(
    `font.family.${name}`,
    "fontFamily",
    value,
    "Família original. A prévia usa arquivos locais Fontsource; mantenha a fonte e os fallbacks no código.",
  );
for (const value of [400, 500, 600, 700])
  token(
    `font.weight.${value}`,
    "fontWeight",
    value,
    "Peso tipográfico do sistema Autos.",
  );
for (const [name, value] of Object.entries({
  xs: "0.75rem",
  sm: "0.875rem",
  base: "1rem",
  lg: "1.125rem",
  xl: "1.25rem",
  heading: "3.6rem",
  hero: "5.6rem",
}))
  token(
    `font.size.${name}`,
    "dimension",
    value,
    "Escala observada. Títulos fluidos têm mínimo e regra de viewport no contrato do componente.",
  );
for (const [name, value] of Object.entries({
  hero: 0.96,
  heading: 1,
  tight: 1.25,
  snug: 1.375,
  relaxed: 1.625,
}))
  token(`font.line.${name}`, "number", value, "Altura de linha sem unidade.");
for (const [name, value] of Object.entries({
  normal: "0px",
  hero: "-0.1792rem",
  heading: "-0.09rem",
  label: "0.1225rem",
}))
  token(
    `font.tracking.${name}`,
    "dimension",
    value,
    "Tracking em rem no tamanho máximo da composição. A implementação fluida preserva a proporção em em documentada no componente.",
  );
for (const step of [0, 2, 3, 4, 5, 6, 8, 10, 14, 16, 20, 28])
  token(
    `space.${step}`,
    "dimension",
    `${step * 0.25}rem`,
    "Escala de espaçamento Tailwind utilizada pela NFCS: passo de 4px.",
  );
for (const [name, value] of Object.entries({
  radius: "0px",
  border: "1px",
  control: "3rem",
  compact: "2.75rem",
  hero: "3.5rem",
  nav: "4.25rem",
  content: "76rem",
  margin: "13rem",
  folder: "13rem",
}))
  token(
    `size.${name}`,
    "dimension",
    value,
    "Medida de estrutura extraída dos componentes da página.",
  );
for (const [name, value] of Object.entries({
  grifo: "950ms",
  reveal: "700ms",
  typewriter: "420ms",
  signature: "1600ms",
  control: "300ms",
}))
  token(
    `motion.duration.${name}`,
    "duration",
    value,
    "Duração observada. Respeitar prefers-reduced-motion e manter o conteúdo visível sem animação.",
  );
for (const [name, value] of Object.entries({
  grifo: "cubic-bezier(0.65, 0, 0.35, 1)",
  reveal: "cubic-bezier(0.16, 1, 0.3, 1)",
}))
  token(
    `motion.easing.${name}`,
    "cubicBezier",
    value,
    "Curva de movimento da referência.",
  );
const aliases = {
  "color.surface.page": "color.paper.base",
  "color.surface.sheet": "color.paper.sheet",
  "color.surface.inverse": "color.ink.base",
  "color.surface.highlight": "color.highlight.yellow",
  "color.text.default": "color.ink.base",
  "color.text.muted": "color.ink.muted",
  "color.text.inverse": "color.paper.base",
  "color.action.background": "color.ink.base",
  "color.action.hover": "color.ink.hover",
  "color.action.foreground": "color.paper.base",
  "color.border.default": "color.ink.divider",
  "color.border.inverse": "color.paper.divider",
};
for (const [key, target] of Object.entries(aliases))
  token(
    key,
    "color",
    `{${target}}`,
    "Alias semântico: uma decisão de uso que referencia a paleta, sem copiar a cor.",
    "semantic",
  );
for (const [name, size, weight, line, tracking, family] of [
  ["body", "base", "400", "relaxed", "normal", "body"],
  ["heading", "heading", "500", "heading", "heading", "display"],
  ["hero", "hero", "500", "hero", "hero", "display"],
  ["annotation", "sm", "400", "snug", "normal", "data"],
  ["control", "base", "600", "tight", "normal", "body"],
])
  token(
    `typography.${name}`,
    "typography",
    {
      fontFamily: `{font.family.${family}}`,
      fontSize: `{font.size.${size}}`,
      fontWeight: `{font.weight.${weight}}`,
      lineHeight: `{font.line.${line}}`,
      letterSpacing: `{font.tracking.${tracking}}`,
    },
    "Objeto tipográfico composto. Cada propriedade continua ligada ao token de origem.",
    "semantic",
  );
token(
  "shadow.sheet",
  "shadow",
  [
    {
      color: "{color.shadow.soft}",
      offsetX: "0px",
      offsetY: "1px",
      blur: "0px",
      spread: "0px",
      inset: false,
    },
    {
      color: "{color.shadow.deep}",
      offsetX: "0px",
      offsetY: "26px",
      blur: "40px",
      spread: "-26px",
      inset: false,
    },
  ],
  "Sombras da folha de autos no hero. O objeto exporta offsets, blur, spread, cor e inset.",
  "semantic",
  "App.tsx",
);
const bind = (property: Binding["property"], token: string): Binding => ({
  property,
  token,
});
function component(
  key: string,
  title: string,
  preview: ComponentSpec["preview"],
  bindings: Binding[],
  body: string,
  extra: Partial<
    Omit<ComponentSpec, "kind" | "key" | "preview" | "bindings">
  > = {},
  path = "App.tsx",
) {
  const design: ComponentSpec = {
    kind: "component",
    key,
    preview,
    bindings,
    variants: [],
    states: [],
    properties: [
      {
        name: "label",
        type: "text",
        options: [],
        defaultValue: title,
        required: true,
      },
    ],
    children: [],
    accessibility:
      "Nome acessível, foco visível, contraste e operação por teclado. Elementos decorativos fora da árvore assistiva.",
    responsive:
      "Preservar legibilidade e alvos de toque de no mínimo 44px. Não depender de hover em telas de toque.",
    source: source(path),
    ...extra,
  };
  items.push({
    title,
    body,
    acceptance:
      "Usar os tokens vinculados, preservar variantes/estados e cumprir o contrato de acessibilidade e responsividade.",
    design,
  });
}
const textBase = [
  bind("color", "color.text.default"),
  bind("typography", "typography.body"),
];
component(
  "button.primary",
  "Ação principal",
  "button",
  [
    bind("color", "color.action.foreground"),
    bind("backgroundColor", "color.action.background"),
    bind("typography", "typography.control"),
    bind("paddingInline", "space.8"),
    bind("minHeight", "size.hero"),
    bind("borderRadius", "size.radius"),
    bind("gap", "space.3"),
    bind("transitionDuration", "motion.duration.control"),
  ],
  "CTA retangular em grafite. O grifo amarelo é informação, não a cor de preenchimento da ação.",
  {
    variants: [
      {
        name: "compact",
        bindings: [
          bind("minHeight", "size.compact"),
          bind("paddingInline", "space.5"),
        ],
      },
      {
        name: "regular",
        bindings: [
          bind("minHeight", "size.control"),
          bind("paddingInline", "space.6"),
        ],
      },
    ],
    states: [
      {
        name: "hover",
        bindings: [bind("backgroundColor", "color.action.hover")],
      },
      {
        name: "focus",
        bindings: [
          bind("outlineColor", "color.text.default"),
          bind("outlineWidth", "size.border"),
        ],
      },
      { name: "disabled", bindings: [] },
    ],
    properties: [
      {
        name: "label",
        type: "text",
        options: [],
        defaultValue: "Descobrir meu prazo",
        required: true,
      },
      {
        name: "external",
        type: "boolean",
        options: [],
        defaultValue: false,
        required: false,
      },
    ],
    accessibility:
      "Link para navegação, botão para ação. Ícone decorativo; foco por teclado visível. Em link externo, informar destino. Disabled não deve se disfarçar de link funcional.",
  },
);
component(
  "button.secondary",
  "Ação secundária",
  "button",
  [
    ...textBase,
    bind("backgroundColor", "color.surface.page"),
    bind("minHeight", "size.compact"),
    bind("paddingInline", "space.6"),
    bind("borderColor", "color.text.default"),
    bind("borderWidth", "size.border"),
    bind("borderRadius", "size.radius"),
  ],
  "Ação secundária com grafite e contorno/linha. O hover pode usar o grifo.",
  {
    states: [
      {
        name: "hover",
        bindings: [bind("backgroundColor", "color.surface.highlight")],
      },
      {
        name: "focus",
        bindings: [
          bind("outlineColor", "color.text.default"),
          bind("outlineWidth", "size.border"),
        ],
      },
    ],
  },
);
component(
  "text.hero",
  "Título de abertura",
  "text",
  [bind("color", "color.text.default"), bind("typography", "typography.hero")],
  "Headline editorial em Newsreader. O texto é conteúdo; a forma tipográfica é um objeto de tokens.",
  {
    children: ["text.grifo"],
    responsive:
      "Fonte original clamp(2.7rem, 6.4vw, 5.6rem); entrelinhas .96 e tracking -0.032em. Usar o tamanho máximo como token e preservar a regra fluida na implementação.",
    properties: [
      {
        name: "label",
        type: "text",
        options: [],
        defaultValue: "Quando a empresa para.",
        required: true,
      },
    ],
  },
);
component(
  "text.heading",
  "Título de seção",
  "text",
  [
    bind("color", "color.text.default"),
    bind("typography", "typography.heading"),
  ],
  "Títulos das folhas do processo.",
  {
    responsive:
      "Fonte original clamp(2rem,4.6vw,3.6rem); entrelinhas 1 e tracking -0.025em. Não fixar o tamanho máximo no celular.",
  },
);
component(
  "text.annotation",
  "Anotação dos autos",
  "text",
  [
    bind("color", "color.text.muted"),
    bind("typography", "typography.annotation"),
  ],
  "Metadados datilografados: fls., rótulos e notas. Não usar a fonte mono como corpo geral.",
);
component(
  "text.grifo",
  "Grifo",
  "text",
  [
    bind("color", "color.text.default"),
    bind("backgroundColor", "color.surface.highlight"),
    bind("fontFamily", "font.family.display"),
    bind("transitionDuration", "motion.duration.grifo"),
    bind("transitionTimingFunction", "motion.easing.grifo"),
  ],
  "O único gesto vivo de marca: destacar a palavra que decide. Não pintar botões, campos ou todas as frases de amarelo.",
  {
    properties: [
      {
        name: "label",
        type: "text",
        options: [],
        defaultValue: "organizar",
        required: true,
      },
      {
        name: "visible",
        type: "boolean",
        options: [],
        defaultValue: true,
        required: false,
      },
    ],
    accessibility:
      "O texto permanece legível antes e depois do grifo. Com movimento reduzido, mostrar conteúdo e grifo sem esperar animação.",
    responsive:
      "Herdar a escala do contexto e permitir grifo em múltiplas linhas; box-decoration-break: clone.",
  },
  "Grifo.tsx",
);
component(
  "surface.sheet",
  "Folha de autos",
  "surface",
  [
    ...textBase,
    bind("backgroundColor", "color.surface.sheet"),
    bind("padding", "space.5"),
    bind("borderRadius", "size.radius"),
    bind("boxShadow", "shadow.sheet"),
  ],
  "Objeto material de papel, sem converter toda seção em cartão. Fonte de composição para mídia e guia de prazo.",
  {
    variants: [
      {
        name: "archive",
        bindings: [bind("backgroundColor", "color.paper.dark")],
      },
      { name: "edge", bindings: [bind("backgroundColor", "color.paper.edge")] },
    ],
    children: ["text.annotation"],
  },
);
component(
  "section.folha",
  "Seção Folha",
  "section",
  [
    ...textBase,
    bind("backgroundColor", "color.surface.page"),
    bind("paddingBlock", "space.20"),
    bind("maxWidth", "size.content"),
    bind("gap", "space.10"),
    bind("borderColor", "color.border.default"),
  ],
  "Composição dos autos: margem estreita para número/nota, conteúdo largo à direita e linha vertical dentro do container.",
  {
    variants: [
      {
        name: "inverse",
        bindings: [
          bind("color", "color.text.inverse"),
          bind("backgroundColor", "color.surface.inverse"),
          bind("borderColor", "color.border.inverse"),
        ],
      },
      { name: "wide", bindings: [bind("paddingBlock", "space.28")] },
    ],
    children: ["text.annotation", "text.heading"],
    properties: [
      {
        name: "label",
        type: "text",
        options: [],
        defaultValue: "Termo de consulta",
        required: true,
      },
      {
        name: "fls",
        type: "text",
        options: [],
        defaultValue: "002",
        required: true,
      },
      {
        name: "tone",
        type: "enum",
        options: ["paper", "inverse"],
        defaultValue: "paper",
        required: false,
      },
    ],
    responsive:
      "Base: uma coluna, 20px de gutter. A partir de lg (1024px): margem de 13rem + conteúdo; gutter 32px a partir de sm (640px).",
  },
  "Folha.tsx",
);
component(
  "choice.situation",
  "Situação do credor",
  "choice",
  [
    ...textBase,
    bind("backgroundColor", "color.surface.page"),
    bind("minHeight", "size.control"),
    bind("paddingBlock", "space.4"),
    bind("borderColor", "color.border.default"),
    bind("borderWidth", "size.border"),
  ],
  "Régua de seleção única. Ao escolher uma situação, o guia relacionado é substituído.",
  {
    states: [
      {
        name: "selected",
        bindings: [bind("backgroundColor", "color.surface.highlight")],
      },
      {
        name: "focus",
        bindings: [
          bind("outlineColor", "color.text.default"),
          bind("outlineWidth", "size.border"),
        ],
      },
    ],
    accessibility:
      "Radiogroup com nome acessível e aria-checked. Implementar setas, Home/End e foco móvel; o original usa botões com role radio e precisa dessa revisão de teclado antes de virar código padrão.",
  },
  "Localizador.tsx",
);
component(
  "section.deadline",
  "Guia de prazo",
  "section",
  [
    ...textBase,
    bind("backgroundColor", "color.surface.sheet"),
    bind("padding", "space.8"),
    bind("boxShadow", "shadow.sheet"),
  ],
  "Objeto de resposta: título grifado, referência temporal, lista de ação e CTA. A prévia usa texto de teste, sem orientar sobre prazos jurídicos.",
  {
    children: [
      "text.grifo",
      "text.annotation",
      "button.primary",
      "button.secondary",
    ],
    accessibility:
      "Região aria-live polite; anunciar mudança da situação sem mover o foco. Conteúdo jurídico é referência editorial e exige revisão própria.",
  },
  "Localizador.tsx",
);
component(
  "archive.folder",
  "Pasta do arquivo",
  "surface",
  [
    bind("color", "color.text.default"),
    bind("backgroundColor", "color.folder.1"),
    bind("typography", "typography.annotation"),
    bind("minHeight", "size.folder"),
    bind("padding", "space.3"),
    bind("transitionDuration", "motion.duration.control"),
  ],
  "Pasta individual com lombada vertical. Seleção sincroniza a capa fixa do processo.",
  {
    variants: [
      { name: "second", bindings: [bind("backgroundColor", "color.folder.2")] },
      { name: "third", bindings: [bind("backgroundColor", "color.folder.3")] },
      { name: "fourth", bindings: [bind("backgroundColor", "color.folder.4")] },
    ],
    states: [
      {
        name: "selected",
        bindings: [bind("backgroundColor", "color.surface.highlight")],
      },
      {
        name: "focus",
        bindings: [
          bind("outlineColor", "color.text.default"),
          bind("outlineWidth", "size.border"),
        ],
      },
    ],
    responsive:
      "Prateleiras com rolagem horizontal no celular. Alturas originais: 13rem + passos de .55rem; seleção sobe 1rem, hover .5rem. Preservar nomes acessíveis sem depender do texto vertical.",
  },
  "Arquivo.tsx",
);
component(
  "archive.cover",
  "Capa do processo",
  "surface",
  [
    ...textBase,
    bind("backgroundColor", "color.surface.sheet"),
    bind("paddingInline", "space.5"),
    bind("paddingBlock", "space.4"),
  ],
  "Objeto da seleção no arquivo. Nome e categoria do processo ficam juntos, com link para a fonte.",
  {
    children: ["text.annotation", "button.secondary"],
    responsive:
      "A capa fica sticky abaixo da nav (4.5rem). Empilhar no celular; alinhar em linha a partir de sm.",
  },
  "Arquivo.tsx",
);
component(
  "navigation.main",
  "Navegação principal",
  "navigation",
  [
    ...textBase,
    bind("backgroundColor", "color.surface.page"),
    bind("minHeight", "size.nav"),
    bind("maxWidth", "size.content"),
    bind("paddingInline", "space.5"),
    bind("gap", "space.2"),
  ],
  "Navegação por âncoras. A marca NFCS é tipográfica; a interface não importa a marca do Brokk.",
  {
    children: ["button.primary"],
    properties: [
      {
        name: "label",
        type: "text",
        options: [],
        defaultValue: "NFCS · Meu prazo · O processo · Arquivo",
        required: true,
      },
      {
        name: "expanded",
        type: "boolean",
        options: [],
        defaultValue: false,
        required: false,
      },
    ],
    accessibility:
      "Nav rotulada; menu móvel com aria-expanded. Fechar ao escolher destino; focus-visible e scroll-margin-top de 5.5rem.",
    responsive:
      "Nav horizontal a partir de lg (1024px), menu compacto abaixo desse breakpoint.",
  },
);
component(
  "list.process",
  "Roteiro de atos",
  "list",
  [
    ...textBase,
    bind("paddingBlock", "space.6"),
    bind("gap", "space.14"),
    bind("borderColor", "color.border.default"),
  ],
  "Seis atos numerados com hierarquia de título, corpo e grifo; a interação acompanha a numeração das folhas.",
  { children: ["text.heading", "text.grifo", "text.annotation"] },
  "Caminho.tsx",
);
component(
  "media.document",
  "Mídia dos autos",
  "media",
  [
    bind("backgroundColor", "color.ink.hover"),
    bind("borderRadius", "size.radius"),
    bind("maxWidth", "size.content"),
  ],
  "Foto/vídeo de papel e cidade como material do processo. Assets ficam referenciados, sem copiar mídia remota para o Brokk.",
  {
    properties: [
      {
        name: "label",
        type: "text",
        options: [],
        defaultValue: "Mídia de referência dos autos",
        required: true,
      },
      {
        name: "playing",
        type: "boolean",
        options: [],
        defaultValue: false,
        required: false,
      },
    ],
    accessibility:
      "Poster e alt; vídeo decorativo muted/playsInline. Com movimento reduzido, manter imagem estática. Não baixar ou executar mídia para uma prévia de componente.",
  },
  "HeroMedia.tsx",
);
component(
  "motion.reveal",
  "Entrada de conteúdo",
  "section",
  [
    ...textBase,
    bind("transitionDuration", "motion.duration.reveal"),
    bind("transitionTimingFunction", "motion.easing.reveal"),
  ],
  "Envelope de movimento: subir 12px e aparecer. Outros tempos documentados: digitação 420ms e rubrica 1600ms.",
  {
    accessibility:
      "Com prefers-reduced-motion, conteúdo visível, sem deslocamento e sem atraso. Nunca esconder informação quando a animação não roda.",
    responsive:
      "Mesmo gesto nas larguras; limite de movimento independente do conteúdo.",
  },
  "Reveal.tsx",
);
function screen(
  key: string,
  title: string,
  components: string[],
  anchor: string,
  body: string,
) {
  const design: DesignSpec = {
    kind: "screen",
    key,
    components,
    source: { ...source("App.tsx"), url: `${url}${anchor}` },
    accessibility:
      "Hierarquia de títulos, nomes de região e navegação por teclado. Conteúdo do cliente revisado separadamente do sistema visual.",
    responsive:
      "Base móvel; sm 640px, md 768px e lg 1024px. Alvos de toque e conteúdo sem overflow horizontal, exceto prateleiras declaradas.",
  };
  items.push({
    title,
    body,
    acceptance:
      "Cada elemento listado resolve para um componente versionado, e cada estilo resolve para tokens tipados.",
    design,
  });
}
screen(
  "screen.hero",
  "Abertura",
  "navigation.main text.hero text.grifo button.primary button.secondary surface.sheet media.document".split(
    " ",
  ),
  "#topo",
  "Headline, promessa de organização, ações e folha de autos com mídia.",
);
screen(
  "screen.deadline",
  "Localizador de prazo",
  ["section.folha", "choice.situation", "section.deadline"],
  "#prazo",
  "Fluxo de situação → guia. Verificar estado selecionado, atualização de conteúdo e foco.",
);
screen(
  "screen.process",
  "Roteiro do processo",
  ["section.folha", "list.process", "motion.reveal"],
  "#caminho",
  "Numeração, seis atos e grifos; a estrutura é folha de autos.",
);
screen(
  "screen.archive",
  "Arquivo de processos",
  ["section.folha", "archive.folder", "archive.cover"],
  "#arquivo",
  "Estante com 44 processos na referência; seleção sincronizada com a capa. Os nomes não fazem parte dos tokens.",
);
screen(
  "screen.roles",
  "Atribuições",
  ["section.folha", "text.heading", "text.grifo", "motion.reveal"],
  "#atribuicoes",
  "Lista do que faz e do que não faz; hierarquia e limites da atuação.",
);
screen(
  "screen.contact",
  "Contato",
  ["section.folha", "button.primary", "text.annotation"],
  "#contato",
  "Ações externas, endereço e referência da equipe. Nenhuma mensagem é enviada pelo laboratório.",
);
export const nfcsManifest: DesignManifest = {
  schemaVersion: "brokk.design-system/1",
  name: "NFCS · Autos",
  sourceUrl: url,
  items,
};
