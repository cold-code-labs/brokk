# Chrome Web Store — Brokk Review

Last Updated: 2026-10-15

## Store Listing

Name: Brokk Review

Short description: Transforme calls de review em transcrição, decisões e propostas de alteração para confirmar no Brokk.

Detailed description: Faça sua reunião normalmente no Chrome e conecte a extensão ao projeto no Brokk. Capture o áudio da chamada e seu microfone com indicação visível, marque dúvidas, decisões e ajustes e inclua referências de arquivo e linha. Ao terminar, pare e sincronize: o Brokk organiza o resumo e apresenta propostas para a equipe confirmar antes de criar tarefas de desenvolvimento. A captura exige ação explícita e aviso aos participantes. Não grava vídeo nem lê páginas ou histórico.

Category: Developer Tools. Single purpose: transformar feedback de calls de review em propostas rastreáveis no Brokk. Language: pt-BR.

## Assets

Icons omitted for internal unpacked distribution. Store submission requires a 128×128 PNG and at least one 1280×800 or 640×400 screenshot. Screenshots should show connection, capture state and proposal confirmation without real customer information.

## Permissions Justification

| Permission | Reason |
| --- | --- |
| storage | Preserve the review connection and unsent observations across panel and worker restarts. |
| sidePanel | Keep review controls and notes visible beside the meeting. |
| tabCapture | Transcribe the selected call tab after the operator starts capture. |
| offscreen | Keep audio processing active when the panel closes. |
| activeTab | Permit capture of the tab explicitly selected by clicking the extension icon. |
| tabs | Validate and remember the selected meeting tab before capture. No browsing history is collected. |
| alarms | Retry queued observations and stop the bounded capture session. |
| https://brokk.a4.ia.br/* | Connect the extension to the organization's Brokk review. |
| https://brokk.coldcodelabs.com/* | Support the existing Brokk origin during the domain transition. |

## Privacy & Data Use

Audio from selected tab and microphone goes to AssemblyAI during explicit capture; transcript and manual notes, optional code references and timestamps go to Brokk. Brokk's configured AI gateway analyzes text. Identity and membership come from Brokk. Temporary connection and unsent observations persist locally until acknowledged. Text, versions and review audit persist on the organization server. No video, browsing history, page contents, advertising, sale of data or remote executable code. Audio is not stored by Brokk; provider retention is governed by provider agreements.

Privacy policy: https://brokk.a4.ia.br/extension/privacy.html

## Distribution and readiness

Internal unpacked ZIP: /downloads/brokk-review.zip. Extract, enable Developer mode in chrome://extensions and Load unpacked. Store publication has not been requested or performed. Before submission: create icons and screenshots, confirm support contact, complete data disclosures, verify live privacy URL and submit for Google's review. ZIP contains extension runtime assets only; no credentials, env files, node_modules, source-control metadata or listing documents.

## Version History

1.0.0 — 2026-10-15: first internal release with call-scoped connection, tab/mic capture, transcription, queued notes, optional code reference and human proposal confirmation.
