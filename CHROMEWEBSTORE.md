> Superseded on 2026-10-19 by A4 Live Coach, maintained in a4-ia/a4-app (CHROMEWEBSTORE.md). Reuse item jigmgceabpnpkonbgogedgmcohpiikpi; do not create a third item or modify Contorna. The metadata below is historical only.

# Chrome Web Store — Brokk Review

Last Updated: 2026-10-15

## Store Listing

Name: Brokk Review

Short description: Transforme calls de review em transcrição, decisões e propostas de alteração para confirmar no Brokk.

Detailed description:

Transforme calls de review em transcrição, decisões e propostas de alteração para confirmar no Brokk.

Use sua reunião habitual no Chrome e mantenha os controles de review ao lado da chamada. O Brokk Review captura o áudio da aba selecionada e do seu microfone somente depois de você iniciar a captura e avisar os participantes.

Marque dúvidas, decisões, pontos positivos e o que precisa mudar. Inclua referências de arquivo e linha quando necessário. As observações ficam em uma fila local até a sincronização com o projeto.

COMO USAR
1. Entre em brokk.a4.ia.br com uma conta autorizada e abra o projeto.
2. Em Calls de review, crie ou abra a review e copie a conexão da extensão.
3. Na aba da chamada, clique no ícone do Brokk Review, cole a conexão e conecte.
4. Avise os participantes e inicie a captura da chamada e do microfone.
5. Ao terminar, pare e sincronize. Abra o Brokk para gerar o resumo e confirmar as propostas antes de criar tarefas.

PRIVACIDADE
O áudio é enviado à AssemblyAI para transcrição durante a captura. Texto transcrito, observações, referências opcionais e horários são enviados ao Brokk; o gateway de IA configurado pela organização analisa os textos. Não há gravação de vídeo, leitura de páginas nem coleta de histórico de navegação. As permissões de aba servem para selecionar e validar a chamada escolhida.

É necessária uma conta Brokk com acesso a um projeto e permissão para operar reviews. A extensão não altera seu agendamento de reuniões. A captura exige consentimento dos participantes. Propostas de mudança são confirmadas pela equipe no Brokk.

SUPORTE
https://brokk.a4.ia.br/extension/support.html
vitor@coldcodelabs.com

Category: Developer Tools. Single purpose: transformar feedback de calls de review em propostas rastreáveis no Brokk. Language: pt-BR.

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
| --- | --- | --- | --- |
| Runtime icons | 16, 32, 48, 128 PNG | Ready | extension/icons/icon-{size}.png |
| Store icon | 128×128 PNG RGB | Ready | store-assets/icon-128.png |
| Screenshot | 1280×800 PNG RGB | Ready | store-assets/01-connect-review.png |

Screenshot shows the actual connection panel, rendered from packaged HTML/CSS in a presentation frame. It contains no customer data or simulated capture. Reproduce using store-assets/preview.html with a local static server. Store assets are excluded from ZIP.

## Permissions Justification

| Permission | Type | Reason |
| --- | --- | --- |
| storage | permissions | Preserve the review connection and unsent observations across panel and worker restarts. |
| sidePanel | permissions | Keep review controls and notes visible beside the meeting. |
| tabCapture | permissions | Transcribe the selected call tab after the operator starts capture. |
| offscreen | permissions | Keep audio processing active when the panel closes. |
| activeTab | permissions | Permit capture of the tab explicitly selected by clicking the extension icon. |
| tabs | permissions | Validate the selected meeting tab URL as HTTPS before capturing it, rejecting internal browser pages and Brokk itself. No browsing history or tab URLs are sent to Brokk. |
| alarms | permissions | Retry queued observations and stop the bounded capture session. |
| https://brokk.a4.ia.br/* | host_permissions | Connect the extension to the organization's Brokk review and send notes/transcripts to the selected project. |
| https://brokk.coldcodelabs.com/* | host_permissions | Support the existing Brokk origin during the domain transition, with the same scoped connection and review functions. |

## Privacy & Data Use

Collects user data: Yes. Audio from selected tab and microphone goes to AssemblyAI during explicit capture; transcript and manual notes, optional code references and timestamps go to Brokk. Brokk's configured AI gateway analyzes text. Temporary connection and unsent observations persist locally until acknowledged. Text, versions and review audit persist on the organization server. No remote executable code, analytics, sale or advertising. Brokk does not store audio; provider retention follows provider agreements.

| Data type | Collected | Off-device | Purpose / sharing |
| --- | --- | --- | --- |
| Personally identifiable information | Yes | Yes | Speaker names or other identifiers voluntarily included in speech/notes; scoped Brokk review and text analysis. |
| Authentication information | Yes | Yes | Temporary review connection token sent only to the selected Brokk origin; no passwords. |
| Personal communications | Yes | Yes | Call audio/transcript and review notes, to AssemblyAI/Brokk/configured text analysis for review. |
| Website content | Yes | Yes | Selected tab's call audio only; no DOM, screen, video or page text extraction. |
| User activity | Yes | Yes | Explicit review observations, timestamps and capture lifecycle sent to Brokk. No unrelated browser tracking. |
| Health, financial, location | No dedicated collection | No dedicated collection | Do not ask for these; arbitrary meeting content can contain sensitive data. |
| Web history | No | No | Selected tab URL is validated locally, never retained/transmitted as history. |

- [x] Data is not sold to third parties.
- [x] Data is not used for purposes unrelated to review functionality.
- [x] Data is not used for creditworthiness or lending.

Privacy policy: https://brokk.a4.ia.br/extension/privacy.html

## Distribution and developer info

Visibility: Public. Regions: all available regions. Existing publisher account: Contorna AI (vitor@coldcodelabs.com), separate Brokk Review item; no existing listing is modified.

Homepage: https://brokk.a4.ia.br
Support: https://brokk.a4.ia.br/extension/support.html
Contact: vitor@coldcodelabs.com

Item ID: jigmgceabpnpkonbgogedgmcohpiikpi
Dashboard: https://chrome.google.com/webstore/devconsole/2aeffd8c-067a-417e-a8ea-b9c0674847a5/jigmgceabpnpkonbgogedgmcohpiikpi/edit
Store URL (available only after approval/publication): https://chromewebstore.google.com/detail/jigmgceabpnpkonbgogedgmcohpiikpi

Package: /downloads/brokk-review.zip?v=1.0.2. Runtime assets only; no credentials, env files, node_modules, source-control metadata, tests or listing documents.

## Review Notes

Requires an authorized Brokk account with operator access to a review project. Test access instructions belong only in the dashboard's private test credentials, never in this file, screenshots or package. Reviews are organization-scoped. Ordinary meetings and scheduling remain outside the extension. Captures require explicit participant notification and microphone permission; capture duration is bounded to two hours and connection validity to four hours. File/line references are supplied by the operator, not automatically inferred from repository access.

## Version History

| Version | Date | Changes | Status |
| --- | --- | --- | --- |
| 1.0.2 | 2026-10-15 | Original Brokk face icons, store graphics, explicit support/privacy contact, clean package including icon assets. | Draft uploaded; listing in preparation |
| 1.0.0 | 2026-10-15 | Call-scoped connection, tab/mic capture, transcription, queued notes, optional code references and human proposal confirmation. | Internal release |

Keyboard shortcut: Ctrl+Shift+Y (Command+Shift+Y on macOS) opens the panel and selects the current tab for capture.

1.0.1 was uploaded as a draft package and superseded before submission by 1.0.2 with the complete support page and final panel icon sizing.
