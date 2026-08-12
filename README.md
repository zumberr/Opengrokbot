<div align="center">

# OpenMausBot Windows 🐭

**Seu próprio time de agentes de IA, agora nativo no Windows.**

Esta é a versão adaptada para Windows do OpenMausBot original. Cada bot na barra lateral é um agente real — Claude ou Codex rodando localmente — com sua própria personalidade, modelo, computador na nuvem e aplicativos conectados.

![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![Electron](https://img.shields.io/badge/Electron-Windows-2B2E3A?logo=electron&logoColor=9FEAF9)
![Agents](https://img.shields.io/badge/agents-Claude%20·%20Codex-d97757)

<br>

<a href="https://github.com/acruz6421-bot/OpenMausBotWindows/releases/latest">
  <img src="https://img.shields.io/badge/%E2%AC%87%EF%B8%8F%20%20Download%20for%20Windows-.exe-0078d4?style=for-the-badge&labelColor=070707" alt="Download OpenMausBot for Windows" height="40">
</a>

<sub>Windows 10/11 · Suporte a Voz via PowerShell · [todas as releases](https://github.com/acruz6421-bot/OpenMausBotWindows/releases)</sub>

<br>
<br>

<img src="docs/screenshots/hero.png" alt="OpenMausBot — um app de chat onde cada conversa é um agente real" width="900">

</div>

---

## Por que usar?

O OpenMausBot trata a IA como um *aplicativo de mensagens*: uma lista de bots com os quais você conversa — cada um com sua própria memória, modelo e ferramentas — rodando diretamente no seu PC:

- **Traga seus próprios agentes.** Os bots rodam via CLI (`claude` ou `codex`) instalados no seu computador.
- **Privacidade Local.** Transcrições, chaves e eventos vivem na sua pasta `%APPDATA%`, não na nuvem.
- **Ditado por Voz Nativo.** Use o microfone para falar com seus bots através do sistema de reconhecimento de voz do Windows (PowerShell + .NET).
- **Provedores Customizados.** Suporte a qualquer API compatível com OpenAI, permitindo usar modelos locais (Ollama, LM Studio) ou outros serviços (Groq, Together) via URL personalizada.
- **Agentes com "Mãos".** Cada bot pode controlar um computador na nuvem ou o seu próprio PC Windows.

## Como usar no Windows

### 1. Instalação Rápida (Recomendado)
1. Vá para a página de [Releases](https://github.com/acruz6421-bot/OpenMausBotWindows/releases/latest).
2. Baixe o arquivo `OpenMausBot-Setup.exe`.
3. Execute o instalador e siga as instruções na tela.

### 2. Rodando do Código Fonte
Se você é desenvolvedor e quer rodar ou modificar o projeto:

```powershell
# Clonar o repositório
git clone https://github.com/acruz6421-bot/OpenMausBotWindows.git
cd OpenMausBotWindows

# Instalar dependências
npm install

# Rodar em modo desenvolvimento
npm run dev          # Inicia o servidor Vite
npx electron .       # Inicia a interface desktop
```

### 3. Gerando seu próprio instalador
```powershell
npm run package:win
```

---

## Diferenças da Versão Windows

Esta versão foi portada para garantir paridade total com o original de Mac:
- **Voz:** Substituímos o Swift/AVFoundation pelo `System.Speech.Recognition` do Windows via PowerShell.
- **Arquivos:** As configurações agora são salvas corretamente em `AppData\Roaming\OpenMausBot`.
- **Interface:** Barra de título adaptada para o estilo nativo do Windows.

## Requisitos
- **Windows 10 ou 11**.
- **Node.js 20+**.
- Pelo menos um CLI de agente instalado ([`claude`](https://claude.com/claude-code) ou [`codex`](https://github.com/openai/codex)).

---

## Status do Projeto
Esta versão Windows está totalmente funcional, incluindo ditado por voz, uso de computador e integração com marketplace de apps. 

Contribuições são bem-vindas!
